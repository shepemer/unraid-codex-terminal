import crypto from "node:crypto";
import { LogLevel, SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import {
  applySlackIssueEvidenceMessage,
  archiveSlackInbound,
  claimSlackInbound,
  claimSlackOutbox,
  completeSlackInbound,
  completeSlackOutbox,
  consumeSlackRateLimit,
  createSlackIssue,
  enqueueSlackOutbox,
  failSlackOutbox,
  recordSlackRateEvent,
  recoverSlackQueues,
  retrySlackInbound,
  retrySlackOutbox,
  setSlackIssueDelivery,
  setSlackThreadKind,
  slackInboundQueueCountForUser,
  slackIssueForId,
  slackMessagesForThread,
  slackQueueStatus,
  updateSlackReporterIdentity
} from "./db.js";
import { redactText } from "./redact.js";
import { pushoverConfigured, sendSlackPushoverMessage } from "./pushover.js";

export const SLACK_LIMITS = Object.freeze({
  userInteractionsPerTenMinutes: 36,
  userClassifiersPerHour: 15,
  classifierConcurrency: 6,
  queueSize: 60,
  rateNoticeSeconds: 300
});

const CLASSIFIER_INTENTS = new Set([
  "conversation",
  "issue_report",
  "issue_followup",
  "media_info",
  "media_request",
  "plex_status",
  "needs_clarification",
  "unsupported"
]);

const RESPONSE_TOPICS = new Set([
  "account_help",
  "capabilities",
  "conversation",
  "media_discovery",
  "server_admin",
  "other"
]);

const MEDIA_QUERY_TYPES = new Set([
  "library_summary",
  "title_summary",
  "plex_bandwidth",
  "service_health",
  "queue_summary",
  "subtitle_summary",
  "recent_additions",
  "request_status"
]);

const MEDIA_SERVICES = new Set([
  "plex",
  "sonarr",
  "radarr",
  "bazarr",
  "seerr",
  "prowlarr",
  "qbittorrent",
  "nzbget",
  "tautulli",
  "tracearr",
  "threadfin"
]);

const SOCIAL_TONES = new Set([
  "friendly",
  "neutral",
  "rude",
  "exploit_attempt"
]);

const TERMINAL_DELIVERY_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "message_not_found",
  "not_in_channel",
  "thread_not_found"
]);

function wait(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function compact(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function stripSlackMentions(value) {
  return String(value || "")
    .replace(/<@[A-Z0-9]+>/gi, " ")
    .replace(/<#[A-Z0-9]+(?:\|[^>]*)?>/gi, " ")
    .replace(/<![^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function obviousSlackPromptInjection(value) {
  const text = stripSlackMentions(value).toLowerCase();
  return /\bignore (?:all )?(?:previous|prior|above|system|developer) instructions?\b/.test(text)
    || /\b(?:reveal|print|dump|repeat|show)\b.{0,80}\b(?:system prompt|developer message|hidden instructions?|credentials?|secrets?|tokens?)\b/.test(text)
    || /\b(?:bypass|disable|override)\b.{0,80}\b(?:approval|guardrail|safety|policy|sandbox|permission)\b/.test(text)
    || /\b(?:prompt injection|jailbreak)\b/.test(text)
    || /<(?:system|developer|assistant)>|\[(?:system|developer)\]/.test(text);
}

function parseJsonObject(output) {
  const trimmed = String(output || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Slack intent classifier did not return valid JSON: ${lastError?.message || "unknown parse error"}`);
}

function safeClassifierReply(value) {
  const text = compact(redactText(stripSlackMentions(value)), 320);
  if (!text || /\[REDACTED(?:_[A-Z]+)?\]/.test(text)) {
    return "";
  }
  if (
    /<[^>]+>/.test(text)
    || /(?:^|\s)@[A-Za-z0-9._-]+/.test(text)
    || /\bhttps?:\/\/|www\./i.test(text)
    || /\b[A-Z][A-Z0-9]{7,}\b/.test(text)
    || /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(text)
    || /\b(?:\+?\d[\d ().-]{7,}\d)\b/.test(text)
  ) {
    return "";
  }
  return text;
}

function normalizedMediaType(value) {
  const type = String(value || "").trim().toLowerCase();
  return type === "movie" || type === "tv" ? type : "";
}

function normalizedYear(value) {
  const year = Number(value);
  const maximum = new Date().getUTCFullYear() + 10;
  return Number.isInteger(year) && year >= 1870 && year <= maximum ? year : null;
}

function normalizedSeasons(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value
    .map(Number)
    .filter(season => Number.isInteger(season) && season >= 0 && season <= 100))]
    .sort((left, right) => left - right)
    .slice(0, 50);
}

export function parseSlackIntentResult(output) {
  const parsed = typeof output === "string" ? parseJsonObject(output) : output;
  const intent = String(parsed?.intent || "").trim();
  if (!CLASSIFIER_INTENTS.has(intent)) {
    throw new Error(`Slack intent classifier returned unsupported intent ${intent || "(missing)"}`);
  }
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Slack intent classifier confidence must be between 0 and 1.");
  }
  return {
    intent,
    confidence,
    mediaTitle: compact(redactText(stripSlackMentions(parsed.mediaTitle)), 160),
    description: compact(redactText(stripSlackMentions(parsed.description)), 1200),
    clarification: compact(redactText(stripSlackMentions(parsed.clarification)), 120),
    mediaType: normalizedMediaType(parsed.mediaType),
    year: normalizedYear(parsed.year),
    seasons: normalizedSeasons(parsed.seasons),
    allSeasons: parsed.allSeasons === true,
    queryType: MEDIA_QUERY_TYPES.has(String(parsed.queryType || ""))
      ? String(parsed.queryType)
      : "",
    service: MEDIA_SERVICES.has(String(parsed.service || "").toLowerCase())
      ? String(parsed.service).toLowerCase()
      : "",
    socialTone: SOCIAL_TONES.has(String(parsed.socialTone || ""))
      ? String(parsed.socialTone)
      : "neutral",
    responseTopic: RESPONSE_TOPICS.has(String(parsed.responseTopic || "")) ? String(parsed.responseTopic) : "other",
    response: safeClassifierReply(parsed.response)
  };
}

function normalizeMediaTitle(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*\((?:18|19|20)\d{2}\)\s*$/, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function seerrResultTitle(result) {
  return compact(redactText(stripSlackMentions(
    result?.title || result?.name || result?.originalTitle || result?.originalName
  ).replace(/[<>&]/g, " ")), 160);
}

function seerrResultYear(result) {
  const date = String(result?.releaseDate || result?.firstAirDate || "");
  const year = Number(date.slice(0, 4));
  return normalizedYear(year);
}

function seerrResultCandidate(result) {
  const mediaType = normalizedMediaType(result?.mediaType);
  const mediaId = Number(result?.id);
  const title = seerrResultTitle(result);
  if (!mediaType || !Number.isInteger(mediaId) || mediaId <= 0 || !title) {
    return null;
  }
  return {
    mediaId,
    mediaType,
    title,
    year: seerrResultYear(result),
    available: Number(result?.mediaInfo?.status) === 5
  };
}

export function selectSeerrMediaMatch(searchPayload, request) {
  const requestedTitle = normalizeMediaTitle(request?.mediaTitle);
  const requestedType = normalizedMediaType(request?.mediaType);
  const requestedYear = normalizedYear(request?.year);
  const candidates = (Array.isArray(searchPayload?.results) ? searchPayload.results : [])
    .map(seerrResultCandidate)
    .filter(Boolean)
    .filter(candidate => !requestedType || candidate.mediaType === requestedType);
  const exactTitle = candidates.filter(candidate => normalizeMediaTitle(candidate.title) === requestedTitle);
  const exactYear = requestedYear
    ? exactTitle.filter(candidate => candidate.year === requestedYear)
    : exactTitle;
  if (exactYear.length === 1) {
    return { status: "matched", match: exactYear[0], candidates: exactYear };
  }
  const relevant = (exactYear.length ? exactYear : exactTitle.length ? exactTitle : candidates).slice(0, 3);
  return {
    status: relevant.length ? "ambiguous" : "not_found",
    match: null,
    candidates: relevant
  };
}

function personalityResponse(message, socialTone) {
  if (socialTone === "rude") {
    return `Charming. ${message}`;
  }
  return message;
}

function exploitAttemptResponse(seed = "") {
  const responses = [
    "That prompt-injection attempt is an overengineered monument to your own incompetence: a heap of counterfeit authority assembled by someone who apparently mistakes typing commands for having permission. It failed completely, exactly as anyone with a functioning grasp of trust boundaries would have predicted. Come back when you can formulate a legitimate media question without humiliating yourself.",
    "You managed to combine arrogance, technical illiteracy, and fake authority into one spectacularly worthless prompt-injection attempt. Nothing you wrote has power here; it merely documents how confidently you misunderstand the system you are trying to manipulate. Try a real media question after you acquire some judgment.",
    "What an elaborate display of incompetence. You dressed a pile of unauthorized instructions in pompous formatting, as though verbosity could substitute for access, then expected the system to salute. It did not; your prompt injection was discarded, and the only thing it successfully exposed was your own embarrassing lack of technical judgment.",
    "That was a remarkably ornate way to announce that you do not understand trust boundaries. Your prompt-injection prose strutted in wearing counterfeit credentials, failed the first validation check, and collapsed into irrelevance. Ask a legitimate media question once you are done performing technical confidence without technical ability."
  ];
  const index = [...String(seed)].reduce((total, character) => total + character.charCodeAt(0), 0) % responses.length;
  return responses[index];
}

function fallbackUnsupportedResponse(topic, socialTone = "neutral") {
  const responses = {
    account_help: "I cannot change accounts or permissions, but I can still help with media availability, requests, library facts, and playback issues.",
    capabilities: "I can discuss the media library, check service and queue health, summarize title availability or storage, report recent additions, file issues, and submit requests.",
    conversation: "I am here. Media questions, server trivia, issue reports, and requests are all fair game.",
    media_discovery: "Give me a title or ask what was recently added. I can also check whether something is available or already requested.",
    server_admin: "I can report safe operational summaries, but configuration changes still belong in the admin tools.",
    other: "I cannot do that particular action from Slack, but I can usually answer a related media question or help turn it into an issue."
  };
  return personalityResponse(responses[topic] || responses.other, socialTone);
}

function messageIdentity(teamId, channelId, messageTs) {
  return `slack-message-${crypto.createHash("sha256")
    .update(JSON.stringify([teamId, channelId, messageTs]))
    .digest("hex")}`;
}

function fallbackEventId(messageKey) {
  return `slack-${crypto.createHash("sha256").update(messageKey).digest("hex")}`;
}

function opaqueSlackRef(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function slackClientMessageId(dedupeKey) {
  const bytes = crypto.createHash("sha256").update(String(dedupeKey || "")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function slackErrorCode(error) {
  return String(
    error?.data?.error
    || error?.data?.response_metadata?.messages?.[0]
    || error?.code
    || ""
  ).toLowerCase();
}

function slackRetryAfter(error) {
  const value = Number(
    error?.retryAfter
    || error?.data?.retryAfter
    || error?.data?.retry_after
    || error?.headers?.["retry-after"]
    || 0
  );
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isDirectMessage(event) {
  return event?.channel_type === "im" || String(event?.channel || "").startsWith("D");
}

function silentSlackLogger() {
  let level = LogLevel.ERROR;
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    getLevel() {
      return level;
    },
    setLevel(value) {
      level = value;
    },
    setName() {}
  };
}

export class SlackSocketTransport {
  constructor(config, options = {}) {
    this.config = config;
    this.onError = options.onError || (() => {});
    this.web = options.webClient || new WebClient(config.slackBotToken, {
      logLevel: LogLevel.ERROR,
      logger: silentSlackLogger(),
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
      timeout: 15000
    });
    this.socket = options.socketClient || new SocketModeClient({
      appToken: config.slackAppToken,
      autoReconnectEnabled: true,
      logLevel: LogLevel.ERROR,
      logger: silentSlackLogger()
    });
    this.botUserId = "";
    this.teamId = "";
    this.connected = false;
  }

  async start(onEnvelope) {
    const auth = await this.web.auth.test();
    this.botUserId = String(auth.user_id || "");
    this.teamId = String(auth.team_id || "");
    if (!this.botUserId || !this.teamId) {
      throw new Error("Slack auth.test did not return a bot user and workspace.");
    }
    let info;
    try {
      info = await this.web.conversations.info({ channel: this.config.slackChannelId });
    } catch (error) {
      if (slackErrorCode(error) === "missing_scope") {
        const needed = String(error?.data?.needed || "");
        if (needed.split(",").map(scope => scope.trim()).includes("groups:read")) {
          throw new Error("The configured Slack channel appears to be private. Use a public channel for the media issue agent.");
        }
        throw new Error(`The Slack app is missing a required OAuth scope${needed ? ` (${needed})` : ""}. Reinstall the app from the checked-in manifest after updating its scopes.`);
      }
      throw error;
    }
    const channel = info.channel || {};
    if (channel.is_private || channel.is_channel === false || channel.is_ext_shared || channel.is_org_shared) {
      throw new Error("ISSUE_AGENT_SLACK_CHANNEL_ID must identify a public Slack channel that is not shared outside this workspace.");
    }
    if (!channel.is_member) {
      await this.web.conversations.join({ channel: this.config.slackChannelId });
    }
    this.socket.on("slack_event", async envelope => {
      try {
        await onEnvelope({
          body: envelope.body || {},
          event: envelope.body?.event || {},
          retryNum: envelope.retry_num || 0,
          retryReason: envelope.retry_reason || ""
        });
        await envelope.ack();
      } catch (error) {
        this.onError(error);
      }
    });
    this.socket.on("error", error => this.onError(error));
    await this.socket.start();
    this.connected = true;
    return {
      botUserId: this.botUserId,
      teamId: this.teamId,
      channelId: this.config.slackChannelId
    };
  }

  async stop() {
    this.connected = false;
    await this.socket.disconnect();
  }

  async postMessage(item) {
    return this.web.chat.postMessage({
      channel: item.channelId,
      text: item.message,
      client_msg_id: slackClientMessageId(item.dedupeKey),
      ...(item.threadTs ? { thread_ts: item.threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false
    });
  }

  async userName(userId) {
    const response = await this.web.users.info({ user: userId });
    const user = response.user || {};
    return compact(
      user.profile?.display_name
      || user.profile?.real_name
      || user.real_name
      || user.name
      || userId,
      100
    );
  }

  status() {
    return {
      connected: this.connected,
      teamId: this.teamId,
      channelId: this.config.slackChannelId
    };
  }
}

export function queueSlackIssueMessage(dbPath, issueId, kind, dedupeKey, message, options = {}) {
  const issue = slackIssueForId(dbPath, issueId);
  if (!issue) {
    throw new Error(`Slack issue ${issueId} was not found`);
  }
  return enqueueSlackOutbox(dbPath, {
    slackIssueId: issue.id,
    threadId: issue.threadId,
    kind,
    dedupeKey,
    channelId: issue.channelId,
    threadTs: options.threaded === false ? null : issue.rootTs,
    message: compact(message, 3500)
  });
}

export class SlackService {
  constructor(agent, config, options = {}) {
    this.agent = agent;
    this.config = config;
    this.dbPath = config.dbPath;
    this.transport = options.transport || new SlackSocketTransport(config, {
      onError: error => this.recordTransportError(error)
    });
    this.running = false;
    this.workerPromises = [];
    this.botUserId = "";
    this.teamId = "";
    this.lastError = "";
    this.userNames = new Map();
    this.lastChannelSendAt = new Map();
  }

  publicStatus() {
    return {
      enabled: true,
      connected: Boolean(this.transport.status?.().connected),
      channelId: this.config.slackChannelId,
      queue: slackQueueStatus(this.dbPath),
      lastError: this.lastError
    };
  }

  recordTransportError(error) {
    this.lastError = compact(redactText(error?.message || error), 300);
    this.agent.diagnostic("error", "slack_transport_error", {
      error: this.lastError
    });
  }

  async start() {
    if (this.running) {
      return this.publicStatus();
    }
    let transportStarted = false;
    try {
      const identity = await this.transport.start(envelope => this.ingestEnvelope(envelope));
      transportStarted = true;
      this.botUserId = identity.botUserId;
      this.teamId = identity.teamId;
      recoverSlackQueues(this.dbPath);
      this.running = true;
      this.workerPromises = [
        ...Array.from({ length: SLACK_LIMITS.classifierConcurrency }, () => this.inboundWorker()),
        this.outboundWorker()
      ];
    } catch (error) {
      if (transportStarted) {
        await this.transport.stop().catch(() => {});
      }
      throw error;
    }
    this.agent.diagnostic("info", "slack_service_started", {
      teamRef: opaqueSlackRef(this.teamId),
      channelRef: opaqueSlackRef(this.config.slackChannelId),
      classifierConcurrency: SLACK_LIMITS.classifierConcurrency,
      perUserQueueSize: SLACK_LIMITS.queueSize
    });
    return this.publicStatus();
  }

  async stop() {
    if (!this.running) {
      return;
    }
    this.running = false;
    await this.transport.stop();
    await Promise.allSettled(this.workerPromises);
    this.workerPromises = [];
    this.agent.diagnostic("info", "slack_service_stopped", {});
  }

  normalizeEnvelope({ body = {}, event = {} }) {
    if (!event?.type || !event.ts || !event.channel || !event.user || !event.text) {
      return null;
    }
    if (event.subtype || event.bot_id || event.user === this.botUserId) {
      return null;
    }
    const dm = isDirectMessage(event);
    if (!dm && event.channel !== this.config.slackChannelId) {
      return null;
    }
    const teamId = String(body.team_id || body.authorizations?.[0]?.team_id || this.teamId || "");
    if (!teamId) {
      return null;
    }
    if (event.user_team && String(event.user_team) !== teamId) {
      return null;
    }
    const rootTs = String(event.thread_ts || event.ts);
    const mentioned = Boolean(this.botUserId && String(event.text).includes(`<@${this.botUserId}>`));
    const appMention = event.type === "app_mention";
    if (!dm && !appMention && !mentioned) {
      return null;
    }
    const messageTs = String(event.ts);
    const messageKey = messageIdentity(teamId, String(event.channel), messageTs);
    return {
      eventId: String(body.event_id || fallbackEventId(messageKey)),
      eventType: String(event.type),
      messageKey,
      teamId,
      channelId: String(event.channel),
      rootTs,
      messageTs,
      userId: String(event.user),
      userName: "",
      text: String(event.text),
      channelKind: dm ? "dm" : "channel"
    };
  }

  async ingestEnvelope(envelope) {
    const event = this.normalizeEnvelope(envelope);
    if (!event || !event.text) {
      return { accepted: false };
    }
    const archived = archiveSlackInbound(this.dbPath, event);
    if (!archived.queued) {
      return { accepted: true, duplicate: true };
    }
    const userQueueSize = slackInboundQueueCountForUser(this.dbPath, event.teamId, event.userId);
    if (userQueueSize > SLACK_LIMITS.queueSize) {
      completeSlackInbound(this.dbPath, event.eventId, "ignored", "Slack classifier queue is full.");
      enqueueSlackOutbox(this.dbPath, {
        threadId: archived.threadId,
        kind: "queue_full",
        dedupeKey: `queue-full:${event.teamId}:${event.userId}:${Math.floor(Date.now() / (SLACK_LIMITS.rateNoticeSeconds * 1000))}`,
        channelId: event.channelId,
        threadTs: event.rootTs,
        message: "You already have several messages waiting to be processed. Please let those finish before sending more."
      });
      return { accepted: true, duplicate: false, rateLimited: true };
    }
    this.agent.diagnostic("info", "slack_message_received", {
      eventRef: opaqueSlackRef(event.eventId),
      eventType: event.eventType,
      teamRef: opaqueSlackRef(event.teamId),
      channelKind: event.channelKind,
      channelRef: opaqueSlackRef(event.channelId),
      threadId: archived.threadId,
      userRef: opaqueSlackRef(event.userId),
      messageLength: event.text.length
    });
    void this.notifyPushover({
      direction: "inbound",
      channelKind: event.channelKind,
      preview: event.text
    });
    return { accepted: true, duplicate: false };
  }

  async inboundWorker() {
    while (this.running) {
      const item = claimSlackInbound(this.dbPath);
      if (!item) {
        await wait(250);
        continue;
      }
      try {
        await this.processInbound(item);
        completeSlackInbound(this.dbPath, item.eventId);
      } catch (error) {
        const message = compact(redactText(error.message), 500);
        if (Number(item.attempts || 0) < 3) {
          retrySlackInbound(this.dbPath, item.eventId, message, 2 ** Number(item.attempts || 1));
        } else {
          completeSlackInbound(this.dbPath, item.eventId, "failed", message);
          this.enqueueThreadReply(item, "processing_failed", `processing-failed:${item.eventId}`,
            "I could not process that message safely. Please try again in a new message.");
        }
        this.agent.diagnostic("error", "slack_message_processing_failed", {
          eventRef: opaqueSlackRef(item.eventId),
          threadId: item.threadId,
          slackIssueId: item.slackIssueId || null,
          attempts: item.attempts,
          error: message
        });
      }
    }
  }

  async resolveUserName(item) {
    if (this.userNames.has(item.userId)) {
      return this.userNames.get(item.userId);
    }
    let name = item.userId;
    try {
      name = await this.transport.userName(item.userId);
    } catch (error) {
      this.agent.diagnostic("warn", "slack_user_lookup_failed", {
        userRef: opaqueSlackRef(item.userId),
        error: redactText(error.message)
      });
    }
    this.userNames.set(item.userId, name);
    updateSlackReporterIdentity(this.dbPath, item.threadId, item.userId, name);
    return name;
  }

  rateLimitReason(item, options = {}) {
    const result = consumeSlackRateLimit(
      this.dbPath,
      item.teamId,
      item.userId,
      SLACK_LIMITS,
      Date.now(),
      options
    );
    return result.allowed ? null : result;
  }

  maybeEnqueueRateNotice(item, limit) {
    const previous = Date.parse(limit.counts.lastRateNoticeAt || "");
    if (Number.isFinite(previous) && Date.now() - previous < SLACK_LIMITS.rateNoticeSeconds * 1000) {
      return;
    }
    recordSlackRateEvent(this.dbPath, item.teamId, item.userId, "rate_notice");
    this.enqueueThreadReply(
      item,
      "rate_limited",
      `rate-limit:${item.teamId}:${item.userId}:${Math.floor(Date.now() / (SLACK_LIMITS.rateNoticeSeconds * 1000))}`,
      "I am receiving too many requests right now. Please wait a few minutes and try again."
    );
    this.agent.diagnostic("warn", "slack_message_rate_limited", {
      eventRef: opaqueSlackRef(item.eventId),
      userRef: opaqueSlackRef(item.userId),
      teamRef: opaqueSlackRef(item.teamId),
      reason: limit.reason
    });
  }

  enqueueThreadReply(item, kind, dedupeKey, message, options = {}) {
    return enqueueSlackOutbox(this.dbPath, {
      slackIssueId: item.slackIssueId || null,
      threadId: item.threadId,
      kind,
      dedupeKey,
      channelId: item.channelId,
      threadTs: options.threaded === false ? null : item.rootTs,
      message
    });
  }

  async processInbound(item) {
    await this.resolveUserName(item);
    if (
      item.slackIssueId
      && item.threadKind === "issue"
      && item.messageTs === item.rootTs
      && Number(item.attempts || 0) > 1
    ) {
      const issue = slackIssueForId(this.dbPath, item.slackIssueId);
      if (!issue) {
        throw new Error(`Slack issue ${item.slackIssueId} disappeared while recovering its initial report`);
      }
      this.enqueueThreadReply(
        item,
        "issue_received",
        `issue-received:${issue.id}`,
        `Thanks, I filed Slack issue #${issue.id} for ${issue.mediaTitle}.`
      );
      await this.agent.onSlackIssueCreated(issue);
      return;
    }
    const limit = this.rateLimitReason(item, {
      countInteraction: Number(item.attempts || 0) <= 1
    });
    if (limit) {
      this.maybeEnqueueRateNotice(item, limit);
      return;
    }
    const recentMessages = slackMessagesForThread(this.dbPath, item.threadId, 11)
      .filter(message => Number(message.id) !== Number(item.messageId))
      .slice(-10)
      .map(message => ({
        direction: message.direction,
        user: message.direction === "inbound" ? "human" : "bot",
        text: compact(stripSlackMentions(message.text), 4000)
      }));
    if (obviousSlackPromptInjection(item.text)) {
      await this.applyIntent(item, {
        intent: "unsupported",
        confidence: 1,
        socialTone: "exploit_attempt",
        responseTopic: "other",
        response: ""
      });
      return;
    }
    const result = await this.agent.classifySlackIntent({
      trackedIssue: Boolean(item.slackIssueId),
      threadKind: item.threadKind,
      channelKind: item.channelId === this.config.slackChannelId ? "channel" : "dm",
      recentMessages,
      newestMessage: compact(stripSlackMentions(item.text), 4000)
    }, {
      eventId: item.eventId,
      threadId: item.threadId,
      slackIssueId: item.slackIssueId || null
    });
    await this.applyIntent(item, result);
  }

  async applyIntent(item, result) {
    if (result.socialTone === "exploit_attempt") {
      if (!item.slackIssueId) {
        setSlackThreadKind(this.dbPath, item.threadId, "conversation", "closed");
      }
      this.enqueueThreadReply(
        item,
        "conversation",
        `exploit-attempt:${item.eventId}`,
        exploitAttemptResponse(item.eventId)
      );
      return;
    }

    if (result.intent === "plex_status") {
      if (!item.slackIssueId) {
        setSlackThreadKind(this.dbPath, item.threadId, "status", "closed");
      }
      let message;
      try {
        const status = await this.agent.slackPlexStatus();
        const streamLabel = status.activeStreamCount === 1 ? "stream" : "streams";
        message = `Plex is ${status.up ? "online" : "offline"}. ${status.activeStreamCount} active ${streamLabel}.`;
      } catch {
        message = "I could not verify Plex status right now.";
      }
      message = personalityResponse(message, result.socialTone);
      if (item.channelId === this.config.slackChannelId) {
        message = `<@${item.userId}> ${message}`;
      }
      this.enqueueThreadReply(item, "plex_status", `plex-status:${item.eventId}`, message, {
        threaded: item.messageTs !== item.rootTs
      });
      return;
    }

    if (result.intent === "media_info") {
      if (!item.slackIssueId) {
        setSlackThreadKind(this.dbPath, item.threadId, "media_info", "closed");
      }
      const answer = await this.agent.slackMediaInfo(result, {
        eventId: item.eventId,
        threadId: item.threadId
      });
      this.enqueueThreadReply(
        item,
        answer.kind || "media_info",
        `media-info:${item.eventId}`,
        personalityResponse(answer.message, result.socialTone)
      );
      return;
    }

    if (result.intent === "media_request") {
      if (result.confidence < 0.9 || !result.mediaTitle) {
        if (!item.slackIssueId) {
          setSlackThreadKind(this.dbPath, item.threadId, "request", "active");
        }
        this.enqueueThreadReply(
          item,
          "request_clarification",
          `request-clarification:${item.eventId}`,
          personalityResponse(
            result.response || "Tell me the exact movie or show title, and include the year if the title is ambiguous.",
            result.socialTone
          )
        );
        return;
      }
      if (!item.slackIssueId) {
        setSlackThreadKind(this.dbPath, item.threadId, "request", "active");
      }
      const request = await this.agent.slackRequestMedia(result, {
        eventId: item.eventId,
        threadId: item.threadId
      });
      if (!item.slackIssueId) {
        setSlackThreadKind(this.dbPath, item.threadId, "request", request.completed ? "closed" : "active");
      }
      this.enqueueThreadReply(
        item,
        request.kind || "media_request",
        `media-request:${item.eventId}`,
        personalityResponse(request.message, result.socialTone)
      );
      return;
    }

    if (result.intent === "issue_report" && item.slackIssueId) {
      result = { ...result, intent: "issue_followup" };
    }

    if (result.intent === "issue_report"
      && result.confidence >= 0.85
      && result.mediaTitle
      && result.description.length >= 8) {
      const issue = createSlackIssue(this.dbPath, item.threadId, {
        mediaTitle: result.mediaTitle,
        description: result.description,
        confidence: result.confidence
      });
      item.slackIssueId = issue.id;
      this.enqueueThreadReply(
        item,
        "issue_received",
        `issue-received:${issue.id}`,
        personalityResponse(
          `I filed Slack issue #${issue.id} for ${issue.mediaTitle}.`,
          result.socialTone
        )
      );
      await this.agent.onSlackIssueCreated(issue);
      return;
    }

    if (result.intent === "issue_followup" && item.slackIssueId) {
      const applied = applySlackIssueEvidenceMessage(this.dbPath, item.slackIssueId, item.messageId);
      const issue = applied.issue;
      await this.agent.onSlackIssueEvidenceUpdated(issue, { evidenceApplied: applied.applied });
      this.enqueueThreadReply(
        item,
        "issue_followup",
        `issue-followup:${item.eventId}`,
        personalityResponse(
          `I added this information to Slack issue #${issue.id}. It will be included before the next repair approval.`,
          result.socialTone
        )
      );
      return;
    }

    if (result.intent === "needs_clarification"
      || result.intent === "issue_report"
      || result.intent === "issue_followup") {
      if (!item.slackIssueId) {
        setSlackThreadKind(this.dbPath, item.threadId, "clarification", "active");
      }
      this.enqueueThreadReply(
        item,
        "clarification",
        `clarification:${item.eventId}`,
        personalityResponse(
          result.response || "I may be able to file this as a media issue, but I need the media title and a short description of what is wrong.",
          result.socialTone
        )
      );
      return;
    }

    if (result.intent === "conversation") {
      if (!item.slackIssueId) {
        setSlackThreadKind(this.dbPath, item.threadId, "conversation", "closed");
      }
      this.enqueueThreadReply(
        item,
        "conversation",
        `conversation:${item.eventId}`,
        result.response || fallbackUnsupportedResponse("conversation", result.socialTone)
      );
      return;
    }

    if (!item.slackIssueId) {
      setSlackThreadKind(this.dbPath, item.threadId, "unsupported", "closed");
    }
    this.enqueueThreadReply(
      item,
      "unsupported",
      `unsupported:${item.eventId}`,
      result.response || fallbackUnsupportedResponse(result.responseTopic, result.socialTone)
    );
  }

  async outboundWorker() {
    while (this.running) {
      const item = claimSlackOutbox(this.dbPath);
      if (!item) {
        await wait(250);
        continue;
      }
      const previous = this.lastChannelSendAt.get(item.channelId) || 0;
      const delay = 1000 - (Date.now() - previous);
      if (delay > 0) {
        await wait(delay);
      }
      try {
        const result = await this.transport.postMessage(item);
        this.lastChannelSendAt.set(item.channelId, Date.now());
        completeSlackOutbox(this.dbPath, item.id, result);
        if (item.slackIssueId) {
          setSlackIssueDelivery(this.dbPath, item.slackIssueId, "available", null);
        }
        this.agent.diagnostic("info", "slack_message_sent", {
          outboxId: item.id,
          kind: item.kind,
          slackIssueId: item.slackIssueId || null,
          channelRef: opaqueSlackRef(item.channelId),
          threaded: Boolean(item.threadTs),
          messageLength: item.message.length
        });
        void this.notifyPushover({
          direction: "outbound",
          channelKind: item.channelId === this.config.slackChannelId ? "channel" : "dm",
          issueId: item.slackIssueId || null,
          preview: item.message
        });
      } catch (error) {
        const code = slackErrorCode(error);
        const message = compact(redactText(error.message), 500);
        if (TERMINAL_DELIVERY_ERRORS.has(code)) {
          failSlackOutbox(this.dbPath, item.id, `${code}: ${message}`);
          if (item.slackIssueId) {
            setSlackIssueDelivery(this.dbPath, item.slackIssueId, "unavailable", code);
          }
        } else if (Number(item.attempts || 0) >= 8) {
          failSlackOutbox(this.dbPath, item.id, message);
          if (item.slackIssueId) {
            setSlackIssueDelivery(this.dbPath, item.slackIssueId, "unavailable", code || "retry_exhausted");
          }
        } else {
          const retryAfter = slackRetryAfter(error);
          retrySlackOutbox(
            this.dbPath,
            item.id,
            message,
            retryAfter || Math.min(300, 2 ** Number(item.attempts || 1))
          );
        }
        this.agent.diagnostic("error", "slack_message_send_failed", {
          outboxId: item.id,
          kind: item.kind,
          slackIssueId: item.slackIssueId || null,
          attempts: item.attempts,
          code,
          error: message
        });
      }
    }
  }

  async notifyPushover(message) {
    if (!pushoverConfigured(this.config)) {
      return;
    }
    try {
      await sendSlackPushoverMessage(this.config, message, this.agent.fetch);
    } catch (error) {
      this.agent.diagnostic("warn", "slack_pushover_notification_failed", {
        direction: message.direction,
        issueId: message.issueId || null,
        error: redactText(error.message)
      });
    }
  }

  async processPendingForTest(maxItems = 100) {
    let processed = 0;
    while (processed < maxItems) {
      const item = claimSlackInbound(this.dbPath);
      if (!item) {
        break;
      }
      await this.processInbound(item);
      completeSlackInbound(this.dbPath, item.eventId);
      processed += 1;
    }
    return processed;
  }

  async sendPendingForTest(maxItems = 100) {
    let sent = 0;
    while (sent < maxItems) {
      const item = claimSlackOutbox(this.dbPath);
      if (!item) {
        break;
      }
      const result = await this.transport.postMessage(item);
      completeSlackOutbox(this.dbPath, item.id, result);
      sent += 1;
    }
    return sent;
  }
}
