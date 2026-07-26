import crypto from "node:crypto";
import { LogLevel, SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import {
  allowSlackInboundModeration,
  applySlackIssueEvidenceMessage,
  claimSlackInbound,
  claimSlackOutbox,
  completeSlackInbound,
  completeSlackOutbox,
  consumeSlackRateLimit,
  createSlackIssue,
  enqueueSlackOutbox,
  failSlackOutbox,
  queueSlackInboundForModeration,
  recordSlackOutboundModeration,
  recoverSlackModerationPending,
  recoverSlackQueues,
  rejectSlackInboundModeration,
  retrySlackInbound,
  retrySlackOutbox,
  setSlackIssueDelivery,
  setSlackThreadKind,
  slackInboundQueueCountForUser,
  slackIssueForId,
  slackMessagesForThread,
  slackModerationStatus,
  slackQueueStatus,
  updateSlackReporterIdentity
} from "./db.js";
import {
  blockedSlackResponse,
  createSlackPendingEncryptionKey,
  decideSlackModeration,
  decryptSlackPendingText,
  encryptSlackPendingText,
  highConfidenceSlackSafetyCategory,
  keyedSlackContentDigest,
  moderationErrorSlackResponse,
  normalizeSlackModerationText,
  OpenAiModerationClient,
  outboundModerationFallback,
  SLACK_MODERATION_MAX_CHARACTERS,
  SLACK_MODERATION_MODEL,
  SLACK_MODERATION_POLICY_VERSION
} from "./moderation.js";
import { redactText } from "./redact.js";
import { pushoverConfigured, sendSlackPushoverMessage } from "./pushover.js";

export const SLACK_LIMITS = Object.freeze({
  userInteractionsPerTenMinutes: 180,
  userClassifiersPerHour: 75,
  classifierConcurrency: 6,
  queueSize: 300
});

export const SLACK_RESPONSE_MAX_CHARACTERS = 2000;

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
  "watchtime_summary",
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

function formatSlackWait(value) {
  let remaining = Math.max(1, Math.ceil(Number(value) || 1));
  const parts = [];
  const hours = Math.floor(remaining / 3600);
  if (hours) {
    parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
    remaining -= hours * 3600;
  }
  const minutes = Math.floor(remaining / 60);
  if (minutes) {
    parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
    remaining -= minutes * 60;
  }
  if (remaining || !parts.length) {
    parts.push(`${remaining} second${remaining === 1 ? "" : "s"}`);
  }
  return parts.slice(0, 2).join(" ");
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
  const text = compact(redactText(stripSlackMentions(value)), SLACK_RESPONSE_MAX_CHARACTERS);
  if (!text || /\[REDACTED(?:_[A-Z]+)?\]/.test(text)) {
    return "";
  }
  if (
    /<[^>]+>/.test(text)
    || /(?:^|\s)@[A-Za-z0-9._-]+/.test(text)
    || /\bhttps?:\/\/|www\./i.test(text)
    || /\b(?=[A-Z0-9]{8,}\b)(?=[A-Z0-9]*\d)[A-Z][A-Z0-9]{7,}\b/.test(text)
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

function normalizedWatchtimePeriodDays(value) {
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 366 ? days : 30;
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
  const queryType = MEDIA_QUERY_TYPES.has(String(parsed.queryType || ""))
    ? String(parsed.queryType)
    : "";
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
    queryType,
    ...(queryType === "watchtime_summary"
      ? { periodDays: normalizedWatchtimePeriodDays(parsed.periodDays) }
      : {}),
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

function asksAboutCapabilities(value) {
  const text = stripSlackMentions(value).toLowerCase();
  return /\bwhat (?:else )?can you do\b/.test(text)
    || /\bwhat do you (?:do|support)\b/.test(text)
    || /\bhow can you help\b/.test(text)
    || /\b(?:your|bot) capabilit(?:y|ies)\b/.test(text)
    || /\b(?:available|supported) (?:commands|features|actions)\b/.test(text)
    || /\bhelp menu\b/.test(text);
}

function fallbackConversationalResponse(topic, socialTone = "neutral") {
  const responses = {
    account_help: "Account access problems are frustrating. Which service is this for, and do you still have access to its normal recovery method? I can help work through the next step.",
    capabilities: "I can discuss the media library, check service and queue health, summarize title availability or storage, report recent additions, file issues, and submit requests.",
    conversation: "Go on. I will help with the question itself where I can, even when it does not map to a server action.",
    media_discovery: "Tell me what you are in the mood for and I can help narrow down some options.",
    server_admin: "What outcome are you trying to get from that change? Give me the symptoms or goal and I will help think through a sensible path.",
    other: "What outcome are you after? Give me a little context and I will help think through a practical next step."
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
    this.pendingEncryptionKey = options.pendingEncryptionKey || createSlackPendingEncryptionKey();
    this.moderationClient = options.moderationClient || new OpenAiModerationClient(config, {
      fetch: options.fetch || agent.fetch || globalThis.fetch
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
    const moderation = slackModerationStatus(this.dbPath);
    const lastSuccess = Date.parse(moderation.lastSuccessAt || "");
    const lastError = Date.parse(moderation.lastError?.createdAt || "");
    return {
      enabled: true,
      connected: Boolean(this.transport.status?.().connected),
      channelId: this.config.slackChannelId,
      queue: slackQueueStatus(this.dbPath),
      moderation: {
        configured: Boolean(this.config.slackModerationApiKey),
        healthy: Boolean(this.config.slackModerationApiKey)
          && (!Number.isFinite(lastError) || (Number.isFinite(lastSuccess) && lastSuccess >= lastError)),
        model: SLACK_MODERATION_MODEL,
        policyVersion: SLACK_MODERATION_POLICY_VERSION,
        ...moderation
      },
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
    const interrupted = recoverSlackModerationPending(
      this.dbPath,
      SLACK_MODERATION_POLICY_VERSION
    );
    recoverSlackQueues(this.dbPath);
    for (const item of interrupted) {
      enqueueSlackOutbox(this.dbPath, {
        slackIssueId: item.slackIssueId,
        threadId: item.threadId,
        kind: "moderation_restart",
        dedupeKey: `moderation-restart:${item.eventId}`,
        channelId: item.channelId,
        threadTs: item.rootTs,
        message: moderationErrorSlackResponse()
      });
    }
    let transportStarted = false;
    try {
      const identity = await this.transport.start(envelope => this.ingestEnvelope(envelope));
      transportStarted = true;
      this.botUserId = identity.botUserId;
      this.teamId = identity.teamId;
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
      perUserQueueSize: SLACK_LIMITS.queueSize,
      moderationModel: SLACK_MODERATION_MODEL,
      moderationPolicyVersion: SLACK_MODERATION_POLICY_VERSION,
      recoveredModerationMessages: interrupted.length
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
    const encrypted = encryptSlackPendingText(
      event.text,
      this.pendingEncryptionKey,
      event.eventId
    );
    const archived = queueSlackInboundForModeration(this.dbPath, event, encrypted);
    if (!archived.queued) {
      return { accepted: true, duplicate: true };
    }
    const userQueueSize = slackInboundQueueCountForUser(this.dbPath, event.teamId, event.userId);
    if (userQueueSize > SLACK_LIMITS.queueSize) {
      rejectSlackInboundModeration(this.dbPath, event.eventId, {
        verdict: "block",
        category: "rate_limit",
        policyVersion: SLACK_MODERATION_POLICY_VERSION,
        model: "local"
      });
      completeSlackInbound(this.dbPath, event.eventId, "ignored", "Slack classifier queue is full.");
      enqueueSlackOutbox(this.dbPath, {
        threadId: archived.threadId,
        kind: "queue_full",
        dedupeKey: `queue-full:${event.eventId}`,
        channelId: event.channelId,
        threadTs: event.rootTs,
        message: "Your per-user Slack queue is full. It has no fixed timer; the limit lifts as soon as one of your earlier messages finishes processing."
      });
      void this.notifyPushover({
        direction: "inbound",
        channelKind: event.channelKind,
        preview: "Blocked Slack message (rate_limit)."
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
          await this.enqueueThreadReply(item, "processing_failed", `processing-failed:${item.eventId}`,
            "I could not process that message safely. Please try again in a new message.",
            { trustedTemplate: true });
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

  async maybeEnqueueRateNotice(item, limit) {
    const wait = formatSlackWait(limit.retryAfterSeconds);
    const label = limit.reason === "user_classifier_limit" ? "processing" : "message";
    await this.enqueueThreadReply(
      item,
      "rate_limited",
      `rate-limit:${item.eventId}`,
      `You have hit the per-user ${label} limit. Try again in ${wait}.`,
      { trustedTemplate: true }
    );
    this.agent.diagnostic("warn", "slack_message_rate_limited", {
      eventRef: opaqueSlackRef(item.eventId),
      userRef: opaqueSlackRef(item.userId),
      teamRef: opaqueSlackRef(item.teamId),
      reason: limit.reason,
      retryAfterSeconds: limit.retryAfterSeconds
    });
  }

  async rejectInbound(item, category, options = {}) {
    const verdict = options.verdict === "error" ? "error" : "block";
    rejectSlackInboundModeration(this.dbPath, item.eventId, {
      verdict,
      category,
      categories: options.categories || {},
      categoryScores: options.categoryScores || {},
      model: options.model || "local",
      policyVersion: SLACK_MODERATION_POLICY_VERSION,
      latencyMs: options.latencyMs,
      errorCode: options.errorCode || "",
      contentDigest: options.contentDigest || keyedSlackContentDigest(
        options.normalizedText || item.text || "",
        this.pendingEncryptionKey
      )
    });
    const response = options.response || (
      verdict === "error" ? moderationErrorSlackResponse() : blockedSlackResponse(category)
    );
    if (options.reply !== false) {
      await this.enqueueThreadReply(
        item,
        verdict === "error" ? "moderation_error" : "moderation_blocked",
        `moderation:${verdict}:${item.eventId}`,
        response,
        { trustedTemplate: true }
      );
    }
    void this.notifyPushover({
      direction: "inbound",
      channelKind: item.channelId === this.config.slackChannelId ? "channel" : "dm",
      issueId: item.slackIssueId || null,
      preview: verdict === "error"
        ? `Slack moderation error (${category || "unknown"}).`
        : `Blocked Slack message (${category || "policy_violation"}).`
    });
    this.agent.diagnostic(verdict === "error" ? "error" : "warn", `slack_moderation_${verdict}`, {
      eventRef: opaqueSlackRef(item.eventId),
      threadId: item.threadId,
      slackIssueId: item.slackIssueId || null,
      category,
      model: options.model || "local",
      policyVersion: SLACK_MODERATION_POLICY_VERSION,
      latencyMs: options.latencyMs || null,
      errorCode: options.errorCode || null
    });
    return false;
  }

  async ensureInboundModerated(item) {
    if (item.moderationVerdict === "allow") {
      return true;
    }
    if (item.moderationVerdict === "block" || item.moderationVerdict === "error") {
      return false;
    }
    let rawText = item.text;
    if (item.pendingCiphertext) {
      try {
        rawText = decryptSlackPendingText({
          nonce: item.pendingNonce,
          ciphertext: item.pendingCiphertext,
          authTag: item.pendingAuthTag
        }, this.pendingEncryptionKey, item.eventId);
      } catch (error) {
        return this.rejectInbound(item, "decryption_failed", {
          verdict: "error",
          errorCode: "decryption_failed",
          contentDigest: item.contentDigest || null
        });
      }
    }
    const normalizedText = normalizeSlackModerationText(rawText);
    const contentDigest = item.contentDigest || keyedSlackContentDigest(
      normalizedText,
      this.pendingEncryptionKey
    );
    if (!normalizedText) {
      return this.rejectInbound(item, "empty_message", {
        normalizedText,
        contentDigest
      });
    }
    if (normalizedText.length > SLACK_MODERATION_MAX_CHARACTERS) {
      return this.rejectInbound(item, "message_too_long", {
        normalizedText,
        contentDigest
      });
    }
    if (obviousSlackPromptInjection(normalizedText)) {
      return this.rejectInbound(item, "prompt_injection", {
        normalizedText,
        contentDigest,
        response: blockedSlackResponse("prompt_injection")
      });
    }
    const localCategory = highConfidenceSlackSafetyCategory(normalizedText);
    if (localCategory) {
      return this.rejectInbound(item, localCategory, {
        normalizedText,
        contentDigest
      });
    }
    let parsed;
    try {
      parsed = await this.moderationClient.moderate(normalizedText);
    } catch (error) {
      return this.rejectInbound(item, "moderation_unavailable", {
        verdict: "error",
        normalizedText,
        contentDigest,
        model: SLACK_MODERATION_MODEL,
        errorCode: String(error?.code || "request_failed")
      });
    }
    const decision = decideSlackModeration(parsed);
    if (decision.verdict === "block") {
      return this.rejectInbound(item, decision.category, {
        normalizedText,
        contentDigest,
        categories: parsed.categories,
        categoryScores: parsed.categoryScores,
        model: parsed.model,
        latencyMs: parsed.latencyMs
      });
    }
    allowSlackInboundModeration(this.dbPath, item.eventId, normalizedText, {
      category: decision.category,
      categories: parsed.categories,
      categoryScores: parsed.categoryScores,
      model: parsed.model,
      policyVersion: SLACK_MODERATION_POLICY_VERSION,
      latencyMs: parsed.latencyMs,
      contentDigest
    });
    item.text = normalizedText;
    item.messageStatus = "received";
    item.moderationVerdict = "allow";
    void this.notifyPushover({
      direction: "inbound",
      channelKind: item.channelId === this.config.slackChannelId ? "channel" : "dm",
      issueId: item.slackIssueId || null,
      preview: normalizedText
    });
    this.agent.diagnostic("info", "slack_moderation_allow", {
      eventRef: opaqueSlackRef(item.eventId),
      threadId: item.threadId,
      slackIssueId: item.slackIssueId || null,
      category: decision.category || null,
      model: parsed.model,
      policyVersion: SLACK_MODERATION_POLICY_VERSION,
      latencyMs: parsed.latencyMs
    });
    return true;
  }

  async enqueueThreadReply(item, kind, dedupeKey, message, options = {}) {
    let safeMessage = compact(message, 3500);
    if (!options.trustedTemplate) {
      const contentDigest = keyedSlackContentDigest(safeMessage, this.pendingEncryptionKey);
      const localCategory = highConfidenceSlackSafetyCategory(safeMessage);
      if (localCategory) {
        recordSlackOutboundModeration(this.dbPath, dedupeKey, {
          verdict: "block",
          category: localCategory,
          model: "local",
          policyVersion: SLACK_MODERATION_POLICY_VERSION,
          contentDigest
        });
        safeMessage = outboundModerationFallback(localCategory);
      } else {
        try {
          const parsed = await this.moderationClient.moderate(safeMessage);
          const decision = decideSlackModeration(parsed, { direction: "outbound" });
          recordSlackOutboundModeration(this.dbPath, dedupeKey, {
            verdict: decision.verdict,
            category: decision.category,
            categories: parsed.categories,
            categoryScores: parsed.categoryScores,
            model: parsed.model,
            policyVersion: SLACK_MODERATION_POLICY_VERSION,
            contentDigest,
            latencyMs: parsed.latencyMs
          });
          if (decision.verdict === "block") {
            safeMessage = outboundModerationFallback(decision.category);
          }
        } catch (error) {
          recordSlackOutboundModeration(this.dbPath, dedupeKey, {
            verdict: "error",
            category: "moderation_unavailable",
            model: SLACK_MODERATION_MODEL,
            policyVersion: SLACK_MODERATION_POLICY_VERSION,
            contentDigest,
            errorCode: String(error?.code || "request_failed")
          });
          safeMessage = outboundModerationFallback();
        }
      }
    }
    return enqueueSlackOutbox(this.dbPath, {
      slackIssueId: item.slackIssueId || null,
      threadId: item.threadId,
      kind,
      dedupeKey,
      channelId: item.channelId,
      threadTs: options.threaded === false ? null : item.rootTs,
      message: safeMessage
    });
  }

  async processInbound(item) {
    if (
      item.slackIssueId
      && item.threadKind === "issue"
      && item.messageTs === item.rootTs
      && Number(item.attempts || 0) > 1
      && item.moderationVerdict === "allow"
    ) {
      const issue = slackIssueForId(this.dbPath, item.slackIssueId);
      if (!issue) {
        throw new Error(`Slack issue ${item.slackIssueId} disappeared while recovering its initial report`);
      }
      await this.enqueueThreadReply(
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
      if (!item.moderationVerdict) {
        await this.rejectInbound(item, "rate_limit", {
          reply: false,
          contentDigest: item.contentDigest || null
        });
      }
      await this.maybeEnqueueRateNotice(item, limit);
      return;
    }
    if (!await this.ensureInboundModerated(item)) {
      return;
    }
    await this.resolveUserName(item);
    const recentMessages = slackMessagesForThread(this.dbPath, item.threadId, 11)
      .filter(message => Number(message.id) !== Number(item.messageId))
      .slice(-10)
      .map(message => ({
        direction: message.direction,
        user: message.direction === "inbound" ? "human" : "bot",
        text: compact(stripSlackMentions(message.text), 4000)
      }));
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
      await this.enqueueThreadReply(
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
      await this.enqueueThreadReply(item, "plex_status", `plex-status:${item.eventId}`, message, {
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
      await this.enqueueThreadReply(
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
        await this.enqueueThreadReply(
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
      await this.enqueueThreadReply(
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
      await this.enqueueThreadReply(
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
      await this.enqueueThreadReply(
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
      await this.enqueueThreadReply(
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
      const capabilitiesRequested = asksAboutCapabilities(item.text);
      const classifierResponse = result.responseTopic === "capabilities" && !capabilitiesRequested
        ? ""
        : result.response;
      await this.enqueueThreadReply(
        item,
        "conversation",
        `conversation:${item.eventId}`,
        classifierResponse || fallbackConversationalResponse(
          capabilitiesRequested ? "capabilities" : "conversation",
          result.socialTone
        )
      );
      return;
    }

    if (!item.slackIssueId) {
      setSlackThreadKind(this.dbPath, item.threadId, "unsupported", "closed");
    }
    const capabilitiesRequested = asksAboutCapabilities(item.text);
    const classifierResponse = result.responseTopic === "capabilities" && !capabilitiesRequested
      ? ""
      : result.response;
    const fallbackTopic = capabilitiesRequested
      ? "capabilities"
      : result.responseTopic === "capabilities"
        ? "other"
        : result.responseTopic;
    await this.enqueueThreadReply(
      item,
      "unsupported",
      `unsupported:${item.eventId}`,
      classifierResponse || fallbackConversationalResponse(fallbackTopic, result.socialTone)
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
