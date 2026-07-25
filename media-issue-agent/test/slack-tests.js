import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MediaIssueAgent } from "../src/agent.js";
import { validateDraftComment } from "../src/comments.js";
import { loadConfig } from "../src/config.js";
import {
  applySlackIssueEvidenceMessage,
  archiveSlackInbound,
  claimSlackInbound,
  consumeSlackRateLimit,
  createSlackIssue,
  initDb,
  insertSnapshot,
  listSlackIssueRecords,
  recordSlackRateEvent,
  recoverSlackQueues,
  slackIssueDetails,
  slackIssueForId,
  slackQueueStatus,
  slackRateCounts
} from "../src/db.js";
import {
  parseSlackIntentResult,
  selectSeerrMediaMatch,
  SLACK_LIMITS,
  SlackService,
  SlackSocketTransport
} from "../src/slack.js";
import { redactText } from "../src/redact.js";
import { slackMessagePushoverPayload } from "../src/pushover.js";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "media-issue-agent-slack-test-"));
}

function baseConfig(root, overrides = {}) {
  return {
    dbPath: path.join(root, "state.sqlite"),
    logPath: path.join(root, "agent.log"),
    repairWorkspaceRoot: path.join(root, "repair-workspaces"),
    webEnabled: false,
    recoverStaleRunSeconds: 120,
    issueSnapshotRetention: 20,
    slackEnabled: true,
    slackAppToken: "xapp-fixture",
    slackBotToken: "xoxb-fixture",
    slackChannelId: "C-ISSUES",
    pushoverAppToken: "",
    pushoverUserKey: "",
    codexModel: "gpt-fixture",
    codexReasoningEffort: "xhigh",
    codexFastMode: true,
    codexServiceTier: "fast",
    ...overrides
  };
}

function envelope({
  eventId,
  channel = "C-ISSUES",
  ts,
  threadTs,
  text,
  type = "app_mention",
  user = "U-REPORTER",
  channelType
}) {
  return {
    body: {
      event_id: eventId,
      team_id: "T-FIXTURE",
      event: {
        type,
        channel,
        channel_type: channelType,
        ts,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        user,
        user_team: "T-FIXTURE",
        text
      }
    },
    event: {
      type,
      channel,
      channel_type: channelType,
      ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      user,
      user_team: "T-FIXTURE",
      text
    }
  };
}

class FakeSlackTransport {
  constructor() {
    this.posts = [];
    this.connected = true;
  }

  status() {
    return { connected: this.connected };
  }

  async userName() {
    return "Fixture Reporter";
  }

  async postMessage(item) {
    this.posts.push({ ...item });
    return { ts: `sent-${this.posts.length}` };
  }

  async stop() {
    this.connected = false;
  }
}

async function testConfigAndClassifierContract() {
  await assert.rejects(
    loadConfig({
      ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture",
      ISSUE_AGENT_SLACK_ENABLED: "true"
    }, { requireCodexAuth: false }),
    /ISSUE_AGENT_SLACK_APP_TOKEN.*ISSUE_AGENT_SLACK_BOT_TOKEN.*ISSUE_AGENT_SLACK_CHANNEL_ID/
  );
  await assert.rejects(
    loadConfig({
      ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture",
      ISSUE_AGENT_SLACK_ENABLED: "true",
      ISSUE_AGENT_SLACK_APP_TOKEN: "wrong-app-token",
      ISSUE_AGENT_SLACK_BOT_TOKEN: "xoxb-fixture",
      ISSUE_AGENT_SLACK_CHANNEL_ID: "C-FIXTURE"
    }, { requireCodexAuth: false }),
    /must be a Slack app-level token/
  );
  const parsed = parseSlackIntentResult(JSON.stringify({
    intent: "issue_report",
    confidence: 0.94,
    mediaTitle: "<@U123> Fixture Movie",
    description: "Playback fails after ten minutes.",
    clarification: ""
  }));
  assert.deepEqual(parsed, {
    intent: "issue_report",
    confidence: 0.94,
    mediaTitle: "Fixture Movie",
    description: "Playback fails after ten minutes.",
    clarification: "",
    mediaType: "",
    year: null,
    seasons: [],
    allSeasons: false,
    responseTopic: "other",
    response: ""
  });
  assert.deepEqual(parseSlackIntentResult({
    intent: "media_request",
    confidence: 0.97,
    mediaTitle: "Fixture Show",
    description: "",
    clarification: "",
    mediaType: "tv",
    year: 2024,
    seasons: [3, 1, 3, -1],
    allSeasons: false,
    responseTopic: "media_discovery",
    response: "I can submit that show request."
  }), {
    intent: "media_request",
    confidence: 0.97,
    mediaTitle: "Fixture Show",
    description: "",
    clarification: "",
    mediaType: "tv",
    year: 2024,
    seasons: [1, 3],
    allSeasons: false,
    responseTopic: "media_discovery",
    response: "I can submit that show request."
  });
  assert.equal(parseSlackIntentResult({
    intent: "unsupported",
    confidence: 0.99,
    responseTopic: "account_help",
    response: "Contact fixture@example.test at http://192.0.2.1/private"
  }).response, "");
  assert.equal(parseSlackIntentResult({
    intent: "unsupported",
    confidence: 0.99,
    responseTopic: "conversation",
    response: "Ask <#C12345678|private-channel> for help."
  }).response, "Ask for help.");
  assert.equal(parseSlackIntentResult({
    intent: "issue_report",
    confidence: 0.99,
    mediaTitle: "<#C12345678|private-channel> Fixture Movie",
    description: "Playback fails after ten minutes."
  }).mediaTitle, "Fixture Movie");
  assert.equal(validateDraftComment("slack", "The repair is complete.").valid, true);
  assert.equal(validateDraftComment("plex", "The repair is complete.").valid, false);
  assert.equal(redactText("xoxb-1234567890-secretfixture"), "[REDACTED_SLACK_TOKEN]");
  assert.equal(redactText("xapp-1-1234567890-secretfixture"), "[REDACTED_SLACK_TOKEN]");
  const notification = slackMessagePushoverPayload({
    pushoverAppToken: "app-fixture",
    pushoverUserKey: "user-fixture"
  }, {
    direction: "inbound",
    channelKind: "dm",
    preview: "token=xoxb-1234567890-secretfixture"
  });
  assert.equal(notification.title, "Received Slack DM");
  assert.doesNotMatch(notification.message, /xoxb|secretfixture/);
}

async function testSocketTransportStartupAndAck() {
  const calls = [];
  const posts = [];
  const socket = new EventEmitter();
  socket.start = async () => {};
  socket.disconnect = async () => {};
  const web = {
    auth: {
      test: async () => ({ user_id: "B-BOT", team_id: "T-FIXTURE" })
    },
    conversations: {
      info: async () => ({ channel: { is_channel: true, is_private: false, is_member: false } }),
      join: async args => calls.push(["join", args])
    },
    chat: {
      postMessage: async args => {
        posts.push(args);
        return { ts: String(posts.length) };
      }
    },
    users: { info: async () => ({ user: { name: "fixture" } }) }
  };
  const transport = new SlackSocketTransport({
    slackAppToken: "xapp-fixture",
    slackBotToken: "xoxb-fixture",
    slackChannelId: "C-ISSUES"
  }, {
    socketClient: socket,
    webClient: web
  });
  const received = [];
  await transport.start(async value => {
    received.push(value);
  });
  let acknowledged = false;
  socket.emit("slack_event", {
    body: { event: { type: "app_mention" } },
    ack: async () => {
      acknowledged = true;
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, true);
  assert.equal(received.length, 1);
  assert.deepEqual(calls, [["join", { channel: "C-ISSUES" }]]);
  await transport.postMessage({
    channelId: "C-ISSUES",
    threadTs: "1.000",
    message: "Fixture reply",
    dedupeKey: "fixture-outbox-item"
  });
  await transport.postMessage({
    channelId: "C-ISSUES",
    threadTs: "1.000",
    message: "Fixture reply",
    dedupeKey: "fixture-outbox-item"
  });
  assert.match(posts[0].client_msg_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(posts[0].client_msg_id, posts[1].client_msg_id);
  await transport.stop();

  const missingScopeTransport = new SlackSocketTransport({
    slackAppToken: "xapp-fixture",
    slackBotToken: "xoxb-fixture",
    slackChannelId: "C-ISSUES"
  }, {
    socketClient: socket,
    webClient: {
      ...web,
      conversations: {
        info: async () => {
          const error = new Error("missing_scope");
          error.data = { error: "missing_scope", needed: "groups:read" };
          throw error;
        }
      }
    }
  });
  await assert.rejects(
    missingScopeTransport.start(async () => {}),
    /configured Slack channel appears to be private/
  );
}

async function testSlackMessageWorkflow() {
  const root = await tempDir();
  try {
    const config = baseConfig(root);
    await initDb(config.dbPath);
    const transport = new FakeSlackTransport();
    const callbacks = [];
    const classifiedContexts = [];
    const fakeAgent = {
      fetch: globalThis.fetch,
      diagnostic() {},
      async classifySlackIntent(context) {
        classifiedContexts.push(context);
        if (/request Fixture Show/i.test(context.newestMessage)) {
          return {
            intent: "media_request",
            confidence: 0.99,
            mediaTitle: "Fixture Show",
            description: "",
            clarification: "",
            mediaType: "tv",
            year: 2024,
            seasons: [1],
            allSeasons: false,
            responseTopic: "other",
            response: ""
          };
        }
        if (/reset my password/i.test(context.newestMessage)) {
          return {
            intent: "unsupported",
            confidence: 0.99,
            mediaTitle: "",
            description: "",
            clarification: "",
            responseTopic: "account_help",
            response: "I cannot reset an account password, but I can help with a Plex status check, media report, or media request."
          };
        }
        if (/server up/i.test(context.newestMessage)) {
          return {
            intent: "plex_status",
            confidence: 0.99,
            mediaTitle: "",
            description: "",
            clarification: ""
          };
        }
        if (context.trackedIssue) {
          return {
            intent: "issue_followup",
            confidence: 0.98,
            mediaTitle: "",
            description: "",
            clarification: ""
          };
        }
        return {
          intent: "issue_report",
          confidence: 0.96,
          mediaTitle: "Fixture Movie",
          description: "Playback fails after ten minutes.",
          clarification: ""
        };
      },
      async slackPlexStatus() {
        return { up: true, activeStreamCount: 3 };
      },
      async slackRequestMedia(result) {
        return {
          completed: true,
          kind: "media_request_submitted",
          message: `I submitted a Seerr request for ${result.mediaTitle}.`
        };
      },
      async onSlackIssueCreated(issue) {
        callbacks.push(["created", issue.id]);
      },
      async onSlackIssueEvidenceUpdated(issue) {
        callbacks.push(["updated", issue.id, issue.evidenceVersion]);
      }
    };
    const service = new SlackService(fakeAgent, config, { transport });
    service.botUserId = "B-BOT";
    service.teamId = "T-FIXTURE";

    assert.deepEqual(await service.ingestEnvelope(envelope({
      eventId: "EV-IGNORED",
      channel: "C-OTHER",
      ts: "1.000",
      text: "<@B-BOT> Ignore this"
    })), { accepted: false });
    const externalWorkspace = envelope({
      eventId: "EV-EXTERNAL",
      ts: "1.100",
      text: "<@B-BOT> Ignore this external workspace message"
    });
    externalWorkspace.body.event.user_team = "T-EXTERNAL";
    externalWorkspace.event.user_team = "T-EXTERNAL";
    assert.deepEqual(await service.ingestEnvelope(externalWorkspace), { accepted: false });
    assert.deepEqual(await service.ingestEnvelope(envelope({
      eventId: "EV-ISSUE",
      ts: "2.000",
      text: "<@B-BOT> exact archive phrase: movie stops after ten minutes"
    })), { accepted: true, duplicate: false });
    assert.deepEqual(await service.ingestEnvelope(envelope({
      eventId: "EV-ISSUE",
      ts: "2.000",
      text: "<@B-BOT> exact archive phrase: movie stops after ten minutes"
    })), { accepted: true, duplicate: true });
    assert.equal(await service.processPendingForTest(), 1);
    assert.equal(classifiedContexts[0].recentMessages.length, 0);

    const records = listSlackIssueRecords(config.dbPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].source, "slack");
    assert.doesNotMatch(JSON.stringify(records), /exact archive phrase/);
    assert.doesNotMatch(JSON.stringify(records), /C-ISSUES|T-FIXTURE|2\.000/);
    const details = slackIssueDetails(config.dbPath, records[0].issueId);
    assert.match(details.conversation[0].text, /exact archive phrase/);
    assert.deepEqual(callbacks, [["created", 1]]);

    assert.deepEqual(await service.ingestEnvelope(envelope({
      eventId: "EV-FOLLOWUP-UNMENTIONED",
      type: "message",
      ts: "2.050",
      threadTs: "2.000",
      text: "This should be ignored because the bot was not mentioned."
    })), { accepted: false });
    assert.deepEqual(await service.ingestEnvelope(envelope({
      eventId: "EV-FOLLOWUP",
      type: "message",
      ts: "2.100",
      threadTs: "2.000",
      text: "<@B-BOT> It also fails on a second player."
    })), { accepted: true, duplicate: false });
    assert.equal(await service.processPendingForTest(), 1);
    assert.equal(classifiedContexts[1].recentMessages.length, 1);
    assert.doesNotMatch(classifiedContexts[1].recentMessages[0].text, /second player/);
    assert.deepEqual(callbacks[1], ["updated", 1, 2]);
    assert.equal(slackIssueForId(config.dbPath, 1).evidenceVersion, 2);
    const followupMessage = slackIssueDetails(config.dbPath, 1).conversation.find(message => message.messageTs === "2.100");
    const repeatedEvidence = applySlackIssueEvidenceMessage(config.dbPath, 1, followupMessage.id);
    assert.equal(repeatedEvidence.applied, false);
    assert.equal(repeatedEvidence.issue.evidenceVersion, 2);
    assert.match(slackIssueDetails(config.dbPath, 1).conversation
      .find(message => message.messageTs === "2.100").text, /It also fails on a second player/);

    assert.deepEqual(await service.ingestEnvelope(envelope({
      eventId: "EV-STATUS-THREAD",
      type: "message",
      ts: "2.200",
      threadTs: "2.000",
      text: "<@B-BOT> Is the Plex server up?"
    })), { accepted: true, duplicate: false });
    assert.equal(await service.processPendingForTest(), 1);

    assert.deepEqual(await service.ingestEnvelope(envelope({
      eventId: "EV-STATUS",
      ts: "3.000",
      text: "<@B-BOT> Is the Plex server up?"
    })), { accepted: true, duplicate: false });
    assert.equal(await service.processPendingForTest(), 1);
    await service.sendPendingForTest();

    const received = transport.posts.find(post => post.kind === "issue_received");
    const followup = transport.posts.find(post => post.kind === "issue_followup");
    const status = transport.posts.find(post => post.dedupeKey === "plex-status:EV-STATUS");
    const threadedStatus = transport.posts.find(post => post.dedupeKey === "plex-status:EV-STATUS-THREAD");
    assert.equal(received.threadTs, "2.000");
    assert.equal(followup.threadTs, "2.000");
    assert.equal(threadedStatus.threadTs, "2.000");
    assert.equal(status.threadTs, null);
    assert.match(status.message, /^<@U-REPORTER> Plex is online\. 3 active streams\.$/);

    fakeAgent.slackPlexStatus = async () => ({ up: false, activeStreamCount: 0 });
    await service.ingestEnvelope(envelope({
      eventId: "EV-STATUS-OFFLINE",
      ts: "3.050",
      text: "<@B-BOT> Is the Plex server up?"
    }));
    assert.equal(await service.processPendingForTest(), 1);
    await service.sendPendingForTest();
    const offline = transport.posts.find(post => post.dedupeKey === "plex-status:EV-STATUS-OFFLINE");
    assert.match(offline.message, /Plex is offline/i);

    fakeAgent.slackPlexStatus = async () => {
      throw new Error("fixture media-mcp outage");
    };
    await service.ingestEnvelope(envelope({
      eventId: "EV-STATUS-UNAVAILABLE",
      ts: "3.100",
      text: "<@B-BOT> Is the Plex server up?"
    }));
    assert.equal(await service.processPendingForTest(), 1);
    await service.sendPendingForTest();
    const unavailable = transport.posts.find(post => post.dedupeKey === "plex-status:EV-STATUS-UNAVAILABLE");
    assert.match(unavailable.message, /could not verify Plex status/i);
    assert.doesNotMatch(unavailable.message, /offline/i);

    await service.ingestEnvelope(envelope({
      eventId: "EV-REQUEST",
      ts: "3.200",
      text: "<@B-BOT> Please request Fixture Show season 1."
    }));
    await service.ingestEnvelope(envelope({
      eventId: "EV-UNSUPPORTED",
      ts: "3.300",
      text: "<@B-BOT> Can you reset my password?"
    }));
    assert.equal(await service.processPendingForTest(), 2);
    await service.sendPendingForTest();
    const request = transport.posts.find(post => post.dedupeKey === "media-request:EV-REQUEST");
    const unsupported = transport.posts.find(post => post.dedupeKey === "unsupported:EV-UNSUPPORTED");
    assert.equal(request.threadTs, "3.200");
    assert.match(request.message, /submitted a Seerr request for Fixture Show/);
    assert.equal(unsupported.threadTs, "3.300");
    assert.match(unsupported.message, /cannot reset an account password/);

    assert.deepEqual(slackQueueStatus(config.dbPath).inbound, {
      pending: 0,
      processing: 0,
      failed: 0
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testMediaRequestSelectionAndSubmission() {
  const search = {
    results: [
      {
        id: 101,
        mediaType: "movie",
        title: "Fixture Feature",
        releaseDate: "2025-02-10",
        mediaInfo: { status: 2 }
      },
      {
        id: 202,
        mediaType: "tv",
        name: "Fixture Feature",
        firstAirDate: "2024-03-11",
        mediaInfo: { status: 2 }
      }
    ]
  };
  assert.equal(selectSeerrMediaMatch(search, {
    mediaTitle: "Fixture Feature",
    mediaType: "",
    year: null
  }).status, "ambiguous");
  assert.equal(selectSeerrMediaMatch(search, {
    mediaTitle: "Fixture Feature",
    mediaType: "tv",
    year: 2024
  }).match.mediaId, 202);

  const root = await tempDir();
  try {
    const calls = [];
    const agent = new MediaIssueAgent(baseConfig(root), {
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "seerr_search_media") {
          return search;
        }
        if (name === "seerr_request_media") {
          return { id: 303, status: 1 };
        }
        throw new Error(`Unexpected tool ${name}`);
      }
    });
    const ambiguous = await agent.slackRequestMedia({
      mediaTitle: "Fixture Feature",
      mediaType: "",
      year: null,
      seasons: []
    });
    assert.equal(ambiguous.completed, false);
    assert.equal(calls.filter(call => call.name === "seerr_request_media").length, 0);

    const missingSeasonScope = await agent.slackRequestMedia({
      mediaTitle: "Fixture Feature",
      mediaType: "tv",
      year: 2024,
      seasons: [],
      allSeasons: false
    });
    assert.equal(missingSeasonScope.completed, false);
    assert.equal(missingSeasonScope.kind, "request_clarification");
    assert.match(missingSeasonScope.message, /which season|all seasons/i);
    assert.equal(calls.filter(call => call.name === "seerr_request_media").length, 0);

    const requested = await agent.slackRequestMedia({
      mediaTitle: "Fixture Feature",
      mediaType: "tv",
      year: 2024,
      seasons: [],
      allSeasons: true
    });
    assert.equal(requested.completed, true);
    assert.match(requested.message, /all available seasons/);
    assert.deepEqual(calls.at(-1), {
      name: "seerr_request_media",
      args: { mediaId: 202, mediaType: "tv", seasons: "all" }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testIssueCreationRetryIsIdempotent() {
  const root = await tempDir();
  try {
    const config = baseConfig(root);
    await initDb(config.dbPath);
    const transport = new FakeSlackTransport();
    let classifierCalls = 0;
    let creationCalls = 0;
    const service = new SlackService({
      fetch: globalThis.fetch,
      diagnostic() {},
      async classifySlackIntent() {
        classifierCalls += 1;
        return {
          intent: "issue_report",
          confidence: 0.99,
          mediaTitle: "Fixture Retry",
          description: "Playback stops during the fixture.",
          clarification: ""
        };
      },
      async onSlackIssueCreated() {
        creationCalls += 1;
        if (creationCalls === 1) {
          throw new Error("fixture callback failure");
        }
      },
      async onSlackIssueEvidenceUpdated() {
        throw new Error("Initial report must not be reapplied as follow-up evidence.");
      }
    }, config, { transport });
    service.botUserId = "B-BOT";
    service.teamId = "T-FIXTURE";
    await service.ingestEnvelope(envelope({
      eventId: "EV-RETRY",
      ts: "4.000",
      text: "<@B-BOT> Fixture Retry stops during playback."
    }));
    const first = claimSlackInbound(config.dbPath);
    await assert.rejects(service.processInbound(first), /fixture callback failure/);
    const retry = {
      ...first,
      attempts: 2,
      slackIssueId: 1,
      threadKind: "issue"
    };
    await service.processInbound(retry);
    assert.equal(classifierCalls, 1);
    assert.equal(creationCalls, 2);
    assert.equal(slackIssueForId(config.dbPath, 1).evidenceVersion, 1);
    assert.equal(slackQueueStatus(config.dbPath).outbound.pending, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testSlackQueueRecoveryOnlyRunsAtSlackStartup() {
  const root = await tempDir();
  try {
    const dbPath = path.join(root, "state.sqlite");
    await initDb(dbPath);
    archiveSlackInbound(dbPath, {
      eventId: "EV-RECOVERY",
      eventType: "app_mention",
      messageKey: "slack-message-recovery-fixture",
      teamId: "T-FIXTURE",
      channelId: "C-ISSUES",
      rootTs: "5.000",
      messageTs: "5.000",
      userId: "U-REPORTER",
      userName: "",
      text: "Fixture recovery message",
      channelKind: "channel"
    });
    assert.ok(claimSlackInbound(dbPath));
    assert.equal(slackQueueStatus(dbPath).inbound.processing, 1);
    await initDb(dbPath);
    assert.equal(slackQueueStatus(dbPath).inbound.processing, 1);
    recoverSlackQueues(dbPath);
    assert.equal(slackQueueStatus(dbPath).inbound.processing, 0);
    assert.equal(slackQueueStatus(dbPath).inbound.pending, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testRateAccounting() {
  const root = await tempDir();
  try {
    const dbPath = path.join(root, "state.sqlite");
    await initDb(dbPath);
    for (let index = 0; index < SLACK_LIMITS.userInteractionsPerTenMinutes; index += 1) {
      recordSlackRateEvent(dbPath, "T-RATE", "U-RATE", "interaction");
    }
    for (let index = 0; index < SLACK_LIMITS.userClassifiersPerHour; index += 1) {
      recordSlackRateEvent(dbPath, "T-RATE", "U-RATE", "classifier");
    }
    const counts = slackRateCounts(dbPath, "T-RATE", "U-RATE");
    assert.equal(counts.userInteractions, 36);
    assert.equal(counts.workspaceInteractions, 36);
    assert.equal(counts.userClassifiers, 15);
    assert.equal(counts.workspaceClassifiers, 15);
    const blocked = consumeSlackRateLimit(dbPath, "T-RATE", "U-RATE", SLACK_LIMITS);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "user_interaction_limit");
    const otherUser = consumeSlackRateLimit(dbPath, "T-RATE", "U-OTHER", SLACK_LIMITS);
    assert.equal(otherUser.allowed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testSlackLifecycleActionsStayLocal() {
  const root = await tempDir();
  try {
    const config = baseConfig(root);
    await initDb(config.dbPath);
    const archived = archiveSlackInbound(config.dbPath, {
      eventId: "EV-LIFECYCLE",
      eventType: "app_mention",
      messageKey: "slack-message-lifecycle-fixture",
      teamId: "T-FIXTURE",
      channelId: "C-ISSUES",
      rootTs: "10.000",
      messageTs: "10.000",
      userId: "U-REPORTER",
      userName: "Fixture Reporter",
      text: "Fixture issue",
      channelKind: "channel"
    });
    const issue = createSlackIssue(config.dbPath, archived.threadId, {
      mediaTitle: "Fixture Movie",
      description: "Fixture issue description",
      confidence: 0.99
    });
    const externalCalls = [];
    const agent = new MediaIssueAgent(config, {
      async callTool(name, args) {
        externalCalls.push({ name, args });
        return {};
      }
    });
    await agent.init();
    let snapshot = insertSnapshot(config.dbPath, "", listSlackIssueRecords(config.dbPath));
    const closed = await agent.closeIssue(snapshot.id, 1, "I reviewed this issue.");
    assert.equal(closed.status, "closed");
    assert.equal(slackIssueForId(config.dbPath, issue.id).status, "closed");

    snapshot = insertSnapshot(config.dbPath, "", listSlackIssueRecords(config.dbPath));
    const reopened = await agent.reopenIssue(snapshot.id, 1);
    assert.equal(reopened.status, "open");
    assert.equal(slackIssueForId(config.dbPath, issue.id).status, "open");
    assert.deepEqual(
      externalCalls.filter(call => call.name !== "plex_reported_issues"),
      []
    );
    assert.equal(slackQueueStatus(config.dbPath).outbound.pending, 3);

    snapshot = insertSnapshot(config.dbPath, "", listSlackIssueRecords(config.dbPath));
    const runIssueActions = agent.runIssueActions.bind(agent);
    agent.runIssueActions = async (...args) => {
      const results = await runIssueActions(...args);
      const followup = archiveSlackInbound(config.dbPath, {
        eventId: "EV-LIFECYCLE-RACE",
        eventType: "message",
        messageKey: "slack-message-lifecycle-race-fixture",
        teamId: "T-FIXTURE",
        channelId: "C-ISSUES",
        rootTs: "10.000",
        messageTs: "10.100",
        userId: "U-REPORTER",
        userName: "Fixture Reporter",
        text: "The problem is still happening with a second file.",
        channelKind: "channel"
      });
      const applied = applySlackIssueEvidenceMessage(config.dbPath, issue.id, followup.messageId);
      await agent.onSlackIssueEvidenceUpdated(applied.issue);
      return results;
    };
    const racedClose = await agent.closeIssue(snapshot.id, 1);
    assert.equal(racedClose.reopenedForNewEvidence, true);
    assert.equal(racedClose.status, "open");
    assert.equal(slackIssueForId(config.dbPath, issue.id).status, "open");
    assert.equal(agent.jobDetails(racedClose.jobId).job.state, "detected");
    assert.equal(slackQueueStatus(config.dbPath).outbound.pending, 5);

    await assert.rejects(
      () => agent.executeIssueAction(
        racedClose.jobId,
        { id: 999 },
        { toolName: "slack_unsupported_action", args: { issueId: issue.id, message: "Must not be queued." } }
      ),
      /Unsupported Slack lifecycle action/
    );
    assert.equal(slackQueueStatus(config.dbPath).outbound.pending, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await testConfigAndClassifierContract();
await testSocketTransportStartupAndAck();
await testSlackMessageWorkflow();
await testMediaRequestSelectionAndSubmission();
await testIssueCreationRetryIsIdempotent();
await testSlackQueueRecoveryOnlyRunsAtSlackStartup();
await testRateAccounting();
await testSlackLifecycleActionsStayLocal();
console.log("media-issue-agent Slack tests passed");
