import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { MediaIssueAgent } from "../src/agent.js";
import { main } from "../src/cli.js";
import { runCodex, runCodexRepair } from "../src/codex.js";
import { inspectCodexAuth } from "../src/config.js";
import {
  createAgentRun,
  createApproval,
  ensureJob,
  initDb,
  insertSnapshot,
  issueLogRecordPage,
  issueLogRecords,
  jobDetails,
  pendingApprovalForJob,
  recordAudit,
  recordIssueLogEvent,
  setPendingApprovals,
  transitionJob,
  transitionJobAndCreateApproval,
  transitionJobAndResolveApproval,
  upsertInvestigation
} from "../src/db.js";
import { appendDiagnosticLog, createDiagnosticLogger } from "../src/diagnostic-log.js";
import { issueTableMarkdown } from "../src/issues.js";
import { redactText } from "../src/redact.js";
import { createWebHandler } from "../src/web.js";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "media-issue-agent-review-"));
}

async function createAuthHome(root) {
  const codexHome = path.join(root, "codex-home");
  await import("node:fs/promises").then(fs => fs.mkdir(codexHome, { recursive: true }));
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: "fixture-access-token",
      refresh_token: "fixture-refresh-token"
    }
  }));
  return codexHome;
}

function configFor(root, codexHome, codexBin = path.join(root, "unused-codex")) {
  return {
    dbPath: path.join(root, "state.sqlite"),
    logPath: path.join(root, "media-issue-agent.log"),
    codexHome,
    codexBin,
    codexWorkspace: path.join(root, "codex-workspace"),
    repairWorkspaceRoot: path.join(root, "repair-workspaces"),
    mediaMcpUrl: "http://media-mcp.invalid/mcp",
    mediaMcpBearerToken: "fixture-mcp-token",
    codexTimeoutMs: 500,
    codexRepairTimeoutMs: 2_000,
    codexTerminationGraceMs: 75,
    recoverStaleRunSeconds: 120,
    issueSnapshotRetention: 500,
    codexModel: "gpt-5.5",
    codexReasoningEffort: "xhigh",
    codexFastMode: true,
    codexServiceTier: "fast",
    codexEnvAllowlist: [],
    dryRun: false
  };
}

function fixtureEntry(issueId, overrides = {}) {
  return {
    source: "plex",
    issueId,
    date: "2026-01-01T00:00:00.000Z",
    reporter: "Fixture Reporter",
    mediaTitle: "Fixture Media",
    status: "open",
    description: "Fixture issue description.",
    raw: { source: "plex", id: issueId, status: "open", comments: [] },
    ...overrides
  };
}

async function writeExecutable(file, source) {
  await writeFile(file, source);
  await chmod(file, 0o700);
  return file;
}

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = server.address();
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testInvestigationFailuresRemainRetryableWithoutApprovals() {
  const root = await tempDir();
  try {
    const codexHome = await createAuthHome(root);
    const config = configFor(root, codexHome);
    const agent = new MediaIssueAgent(config, {
      async callTool(name) {
        if (name === "plex_issue_details") {
          throw new Error("fixture evidence service unavailable");
        }
        if (name === "media_diagnose_issue") {
          return { observations: [] };
        }
        throw new Error(`Unexpected tool ${name}`);
      }
    });
    await agent.init();
    const entries = [fixtureEntry("evidence-failure")];
    const snapshot = insertSnapshot(config.dbPath, issueTableMarkdown(entries), entries);
    const result = await agent.investigate(snapshot.id, 1, { force: true });
    const details = jobDetails(config.dbPath, result.jobId);
    assert.equal(result.approvalId, null);
    assert.equal(result.status, "failed");
    assert.equal(details.job.state, "failed_retryable");
    assert.equal(details.investigation.status, "failed");
    assert.equal(pendingApprovalForJob(config.dbPath, result.jobId, "action"), null);

    const failingCodex = await writeExecutable(path.join(root, "codex-failure.mjs"), [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stderr.write('fixture Codex failure');",
      "process.exitCode = 2;"
    ].join("\n"));
    const steeringAgent = new MediaIssueAgent({ ...config, codexBin: failingCodex }, {
      async callTool() {
        throw new Error("No media call expected while steering cached evidence");
      }
    });
    const steeringJob = ensureJob(config.dbPath, "plex", "steering-failure");
    transitionJob(config.dbPath, steeringJob.id, "detected", "awaiting_action_approval");
    upsertInvestigation(config.dbPath, steeringJob.id, {
      status: "ready",
      summary: "Original investigation.",
      evidence: { entry: fixtureEntry("steering-failure") }
    });
    createApproval(config.dbPath, steeringJob.id, "action", { plan: { executionMode: "approved_repair_agent" } });
    const steered = await steeringAgent.steerInvestigation(steeringJob.id, "Retry after checking the fixture source.", "fixture");
    const steeredDetails = jobDetails(config.dbPath, steeringJob.id);
    assert.equal(steered.approvalId, null);
    assert.equal(steeredDetails.job.state, "failed_retryable");
    assert.equal(pendingApprovalForJob(config.dbPath, steeringJob.id, "action"), null);
    assert.equal(steeredDetails.investigation.evidence.steeringHistory.at(-1).message, "Retry after checking the fixture source.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testApprovalStateChangesAreTransactional() {
  const root = await tempDir();
  try {
    const dbPath = path.join(root, "state.sqlite");
    await initDb(dbPath);
    const job = ensureJob(dbPath, "plex", "atomic-approval");
    transitionJob(dbPath, job.id, "detected", "awaiting_action_approval");
    const approval = createApproval(dbPath, job.id, "action", { plan: { fixture: true } });
    setPendingApprovals(dbPath, job.id, "approved", "competing-actor", "action");
    assert.throws(
      () => transitionJobAndResolveApproval(
        dbPath,
        job.id,
        approval.id,
        "awaiting_action_approval",
        "approved_for_execution",
        "approved",
        "fixture"
      ),
      /no longer pending/
    );
    assert.equal(jobDetails(dbPath, job.id).job.state, "awaiting_action_approval");

    assert.throws(
      () => transitionJobAndCreateApproval(
        dbPath,
        job.id,
        "detected",
        "awaiting_action_approval",
        "action",
        { plan: { shouldNotExist: true } }
      ),
      /Cannot transition/
    );
    assert.equal(jobDetails(dbPath, job.id).approvals.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testConcurrentPollsSharePaginationAndPreserveActiveState() {
  const root = await tempDir();
  try {
    const codexHome = await createAuthHome(root);
    const config = configFor(root, codexHome);
    const records = Array.from({ length: 205 }, (_, index) => ({
      source: "seerr",
      id: index + 1,
      status: index === 0 ? "resolved" : "open",
      comments: [],
      createdAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      reporter: "Fixture Reporter",
      mediaTitle: `Fixture ${index + 1}`,
      message: `Fixture issue ${index + 1}`
    }));
    const pageCalls = [];
    const agent = new MediaIssueAgent(config, {
      async callTool(name, args) {
        assert.equal(name, "plex_reported_issues");
        pageCalls.push(args.skip);
        await new Promise(resolve => setTimeout(resolve, 5));
        return { records: records.slice(args.skip, args.skip + args.take) };
      }
    });
    await agent.init();
    const activeJob = ensureJob(config.dbPath, "seerr", "1");
    transitionJob(config.dbPath, activeJob.id, "detected", "executing");
    const [first, second] = await Promise.all([agent.pollOnce(), agent.pollOnce()]);
    assert.equal(first.snapshotId, second.snapshotId);
    assert.equal(first.issueCount, 205);
    assert.deepEqual(pageCalls, [0, 100, 200]);
    assert.equal(agent.latestWithEntries().entries.length, 205);
    assert.equal(jobDetails(config.dbPath, activeJob.id).job.state, "executing");

    let stalledCalls = 0;
    const stalledAgent = new MediaIssueAgent({ ...config, dbPath: path.join(root, "stalled.sqlite") }, {
      async callTool(name) {
        assert.equal(name, "plex_reported_issues");
        stalledCalls += 1;
        return { records: records.slice(0, 100) };
      }
    });
    await assert.rejects(() => stalledAgent.listReportedIssues(), /pagination did not advance/);
    assert.equal(stalledCalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testSeerrLifecycleMarkersFollowSuccessfulStateChanges() {
  const root = await tempDir();
  try {
    const codexHome = await createAuthHome(root);
    const config = configFor(root, codexHome);
    await initDb(config.dbPath);
    const entries = [
      fixtureEntry("501", {
        source: "seerr",
        status: "open",
        raw: { source: "seerr", id: 501, status: "open", comments: [] }
      }),
      fixtureEntry("502", {
        source: "seerr",
        status: "closed",
        raw: { source: "seerr", id: 502, status: "resolved", comments: [] }
      })
    ];
    const snapshot = insertSnapshot(config.dbPath, issueTableMarkdown(entries), entries);
    const calls = [];
    const agent = new MediaIssueAgent(config, {
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "seerr_resolve_issue" || name === "seerr_reopen_issue") {
          throw new Error(`${name} fixture failure`);
        }
        return { ok: true };
      }
    });
    await assert.rejects(() => agent.closeIssue(snapshot.id, 1, "Closing note.", "fixture"), /fixture failure/);
    assert.equal(calls.some(call => call.name === "seerr_add_issue_comment" && call.args.message === "Closed."), false);
    const closeJob = ensureJob(config.dbPath, "seerr", "501");
    assert.equal(jobDetails(config.dbPath, closeJob.id).job.state, "failed_retryable");

    const reopenJob = ensureJob(config.dbPath, "seerr", "502");
    transitionJob(config.dbPath, reopenJob.id, "detected", "closed");
    await assert.rejects(() => agent.reopenIssue(snapshot.id, 2, "fixture"), /fixture failure/);
    assert.equal(calls.some(call => call.name === "seerr_add_issue_comment" && call.args.message === "Re-opened issue."), false);
    assert.equal(jobDetails(config.dbPath, reopenJob.id).job.state, "failed_retryable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testDraftFailureCanResumeWithoutRepeatingRepair() {
  const root = await tempDir();
  try {
    const codexHome = await createAuthHome(root);
    const codexBin = await writeExecutable(path.join(root, "codex-draft.mjs"), [
      "#!/usr/bin/env node",
      "import { readFileSync } from 'node:fs';",
      "readFileSync(0, 'utf8');",
      "process.stdout.write('Repair completed for the fixture. Automated response from Codex.\\n');"
    ].join("\n"));
    const config = configFor(root, codexHome, codexBin);
    class FlakyDraftAgent extends MediaIssueAgent {
      constructor(...args) {
        super(...args);
        this.draftAttempts = 0;
      }

      async draftResolutionApproval(...args) {
        this.draftAttempts += 1;
        if (this.draftAttempts === 1) {
          throw new Error("fixture comment drafting failure");
        }
        return super.draftResolutionApproval(...args);
      }
    }
    const agent = new FlakyDraftAgent(config, {
      async callTool() {
        throw new Error("No media action expected for a client-side fixture");
      }
    });
    await agent.init();
    const job = ensureJob(config.dbPath, "plex", "draft-retry");
    transitionJob(config.dbPath, job.id, "detected", "awaiting_action_approval");
    upsertInvestigation(config.dbPath, job.id, {
      status: "ready",
      summary: "The fixture requires no server-side action.",
      evidence: { entry: fixtureEntry("draft-retry") }
    });
    createApproval(config.dbPath, job.id, "action", {
      source: "plex",
      issueId: "draft-retry",
      summary: "The fixture requires no server-side action.",
      evidence: {},
      plan: {
        classification: "client_side",
        executionMode: "none",
        requiresServerAction: false,
        actions: []
      }
    });
    await assert.rejects(() => agent.approve(job.id, "fixture"), /fixture comment drafting failure/);
    assert.equal(jobDetails(config.dbPath, job.id).job.state, "failed_retryable");
    const resumed = await agent.continueJob(job.id, "fixture");
    assert.equal(resumed.status, "awaiting_resolution_approval");
    assert.equal(agent.draftAttempts, 2);
    assert.equal(jobDetails(config.dbPath, job.id).job.lastError, null);
    assert.ok(pendingApprovalForJob(config.dbPath, job.id, "resolution"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testCodexTimeoutKillsIgnoringProcessTree() {
  if (process.platform === "win32") {
    return;
  }
  const root = await tempDir();
  try {
    const codexHome = await createAuthHome(root);
    const descendantPidPath = path.join(root, "descendant.pid");
    const codexBin = await writeExecutable(path.join(root, "codex-hang.mjs"), [
      "#!/usr/bin/env node",
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);")}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
      "process.on('SIGTERM', () => {});",
      "process.stdin.resume();",
      "setInterval(() => {}, 1000);"
    ].join("\n"));
    const config = { ...configFor(root, codexHome, codexBin), codexTimeoutMs: 500, codexTerminationGraceMs: 75 };
    const startedAt = Date.now();
    await assert.rejects(() => runCodex(config, "fixture timeout prompt"), /timed out after 500ms/);
    assert.ok(Date.now() - startedAt < 3_000);
    const descendantPid = Number(await readFile(descendantPidPath, "utf8"));
    const alive = () => {
      try {
        process.kill(descendantPid, 0);
        return true;
      } catch (error) {
        return error?.code !== "ESRCH";
      }
    };
    const deadline = Date.now() + 2_000;
    while (alive() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(alive(), false, "Codex timeout must kill descendants in the spawned process group");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testRepairTelemetryFailureDoesNotFailExecution() {
  const root = await tempDir();
  try {
    const codexHome = await createAuthHome(root);
    const codexBin = await writeExecutable(path.join(root, "codex-telemetry.mjs"), [
      "#!/usr/bin/env node",
      "import { readFileSync } from 'node:fs';",
      "readFileSync(0, 'utf8');",
      "const result = { status: 'fixed', summary: 'Fixture repaired.', actionsTaken: ['Fixture action completed.'], verification: { status: 'passed', details: 'Fixture verified.' }, draftComment: 'Fixture repaired. Automated response from Codex.', closeRecommended: true, proposedChoices: [], missingMcpItems: [] };",
      "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } }) + '\\n');"
    ].join("\n"));
    const config = configFor(root, codexHome, codexBin);
    let eventErrors = 0;
    const output = await runCodexRepair(config, "fixture repair prompt", {}, {
      onEvent() {
        throw new Error("fixture telemetry database error");
      },
      onEventError(error) {
        assert.match(error.message, /telemetry database error/);
        eventErrors += 1;
      }
    });
    assert.match(output.finalMessage, /Fixture repaired/);
    assert.ok(eventErrors > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testRepairAbortCancelsInFlightMcpRequest() {
  const root = await tempDir();
  let upstreamServer;
  try {
    let upstreamSeen = false;
    upstreamServer = http.createServer((_req, _res) => {
      upstreamSeen = true;
    });
    await new Promise(resolve => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}/mcp`;
    const codexHome = await createAuthHome(root);
    const codexBin = await writeExecutable(path.join(root, "codex-mcp-hang.mjs"), [
      "#!/usr/bin/env node",
      "import { readFileSync } from 'node:fs';",
      "readFileSync(0, 'utf8');",
      "const configArg = process.argv.find(arg => arg.startsWith('mcp_servers.media.url='));",
      "const proxyUrl = JSON.parse(configArg.slice(configArg.indexOf('=') + 1));",
      "await fetch(proxyUrl, { method: 'POST', headers: { authorization: `Bearer ${process.env.ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture_hanging_tool', arguments: {} } }) });"
    ].join("\n"));
    const config = {
      ...configFor(root, codexHome, codexBin),
      mediaMcpUrl: upstreamUrl,
      mcpRequestTimeoutMs: 60_000,
      codexRepairTimeoutMs: 60_000
    };
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort("fixture operator abort"), 300);
    const startedAt = Date.now();
    await assert.rejects(
      () => runCodexRepair(config, "fixture hanging MCP repair", {}, { abortSignal: controller.signal }),
      /fixture operator abort/
    );
    clearTimeout(abortTimer);
    assert.equal(upstreamSeen, true);
    assert.ok(Date.now() - startedAt < 3_000, "Aborting a repair must not wait for the MCP request timeout");
  } finally {
    if (upstreamServer) {
      const closing = new Promise(resolve => upstreamServer.close(resolve));
      upstreamServer.closeAllConnections?.();
      await closing;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function testPublicDetailsAndTextRedaction() {
  const root = await tempDir();
  try {
    const codexHome = await createAuthHome(root);
    const config = configFor(root, codexHome);
    const agent = new MediaIssueAgent(config, { async callTool() { return {}; } });
    await agent.init();
    const job = ensureJob(config.dbPath, "plex", "public-detail");
    upsertInvestigation(config.dbPath, job.id, {
      status: "ready",
      summary: "Safe summary.",
      evidence: {
        privateDiagnostic: "opaque evidence",
        steeringHistory: [{ actor: "fixture", message: "safe steering", previousSummary: "private prior summary" }]
      }
    });
    createApproval(config.dbPath, job.id, "action", { evidence: { private: "approval evidence" }, plan: {} });
    createAgentRun(config.dbPath, job.id, "repair", "private full repair prompt", { model: "fixture" });
    recordAudit(config.dbPath, "private_audit", { raw: "private payload" }, job.id);
    const detail = agent.publicJobDetails(job.id);
    assert.equal(Object.hasOwn(detail.agentRuns[0], "prompt"), false);
    assert.equal(Object.hasOwn(detail.agentRuns[0], "configJson"), false);
    assert.equal(Object.hasOwn(detail.approvals[0].payload, "evidence"), false);
    assert.equal(Object.hasOwn(detail.approvals[0], "payloadJson"), false);
    assert.equal(Object.hasOwn(detail.approvals[0], "tokenHash"), false);
    assert.equal(detail.investigation.evidence.privateDiagnostic, undefined);
    assert.equal(Object.hasOwn(detail.investigation, "evidenceJson"), false);
    assert.equal(detail.investigation.evidence.steeringHistory[0].message, "safe steering");
    assert.equal(Object.hasOwn(detail.investigation.evidence.steeringHistory[0], "previousSummary"), false);
    assert.equal(Object.hasOwn(detail.auditEvents[0], "redactedPayload"), false);

    const jwt = "eyJmaXh0dXJlMTIz.NDU2Nzg5MGFiY2Rl.Zml4dHVyZXNpZ25hdHVyZQ";
    const redacted = redactText([
      '{"access_token":"opaque-access-value","X-Plex-Token":"opaque-plex-value"}',
      "Authorization: Basic opaque-basic-value",
      `JWT ${jwt}`,
      "Internal host 192.168.42.17",
      "Temporary path /tmp/private-fixture/output.json"
    ].join("\n"));
    for (const secret of ["opaque-access-value", "opaque-plex-value", "opaque-basic-value", jwt, "192.168.42.17", "/tmp/private-fixture"]) {
      assert.doesNotMatch(redacted, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testWebMutationProtection() {
  let pollCalls = 0;
  const config = { webUsername: "operator", webPassword: "fixture-password" };
  const agent = {
    diagnostic() {},
    async pollOnce() {
      pollCalls += 1;
      return { snapshotId: 1 };
    }
  };
  await withServer(createWebHandler(agent, config), async baseUrl => {
    const authorization = `Basic ${Buffer.from("operator:fixture-password").toString("base64")}`;
    const unsupported = await fetch(`${baseUrl}/api/poll`, {
      method: "POST",
      headers: { authorization },
      body: "{}"
    });
    assert.equal(unsupported.status, 415);
    const crossOrigin = await fetch(`${baseUrl}/api/poll`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", origin: "https://attacker.invalid" },
      body: "{}"
    });
    assert.equal(crossOrigin.status, 403);
    const sameOrigin = await fetch(`${baseUrl}/api/poll`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", origin: baseUrl },
      body: "{}"
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(pollCalls, 1);
  });
}

async function testAuthShapeAndFreshStatus() {
  const root = await tempDir();
  try {
    const emptyHome = path.join(root, "empty-auth");
    await import("node:fs/promises").then(fs => fs.mkdir(emptyHome));
    await writeFile(path.join(emptyHome, "auth.json"), "{}");
    assert.equal((await inspectCodexAuth(emptyHome)).status, "missing_chatgpt_tokens");

    const dbPath = path.join(root, "fresh-status.sqlite");
    const output = [];
    const originalLog = console.log;
    console.log = value => output.push(String(value));
    try {
      assert.equal(await main(["status"], {
        ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture-token",
        ISSUE_AGENT_DB_PATH: dbPath,
        ISSUE_AGENT_WEB_ENABLED: "false"
      }), 0);
    } finally {
      console.log = originalLog;
    }
    await access(dbPath);
    assert.equal(JSON.parse(output.at(-1)).snapshots.count, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testDurableIssueLogPaginationAndLiveCursor() {
  const root = await tempDir();
  try {
    const dbPath = path.join(root, "state.sqlite");
    await initDb(dbPath);
    for (let index = 1; index <= 2_105; index += 1) {
      recordIssueLogEvent(dbPath, {
        source: "plex",
        issueId: "long-lived-issue",
        record: {
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
          level: "info",
          event: `issue_event_${index}`,
          payload: { source: "plex", issueId: "long-lived-issue", index }
        }
      });
    }
    const first = issueLogRecordPage(dbPath, "plex", "long-lived-issue", { limit: 1_000 });
    const second = issueLogRecordPage(dbPath, "plex", "long-lived-issue", { afterId: first.at(-1).id, limit: 1_000 });
    const third = issueLogRecordPage(dbPath, "plex", "long-lived-issue", { afterId: second.at(-1).id, limit: 1_000 });
    assert.deepEqual([first.length, second.length, third.length], [1_000, 1_000, 105]);
    assert.equal(issueLogRecords(dbPath, "plex", "long-lived-issue").length, 2_105);

    const historicalLogPath = path.join(root, "historical-live.log");
    appendDiagnosticLog(historicalLogPath, "info", "before_restart", { fixture: true });
    const historicalLogger = createDiagnosticLogger({ logPath: historicalLogPath, liveLogHistoryLimit: 100 });
    await historicalLogger.loadHistory();
    assert.equal(historicalLogger.recent().records[0].event, "before_restart");

    const logger = createDiagnosticLogger({ logPath: path.join(root, "live.log"), liveLogHistoryLimit: 100 });
    for (let index = 1; index <= 105; index += 1) {
      logger.log("info", `live_${index}`, { index });
    }
    const reset = logger.recent({ afterCursor: 1, limit: 100 });
    assert.equal(reset.reset, true);
    assert.equal(reset.records[0].event, "live_6");
    const incremental = logger.recent({ afterCursor: 103, limit: 100 });
    assert.equal(incremental.reset, false);
    assert.deepEqual(incremental.records.map(record => record.event), ["live_104", "live_105"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function run() {
  await testInvestigationFailuresRemainRetryableWithoutApprovals();
  await testApprovalStateChangesAreTransactional();
  await testConcurrentPollsSharePaginationAndPreserveActiveState();
  await testSeerrLifecycleMarkersFollowSuccessfulStateChanges();
  await testDraftFailureCanResumeWithoutRepeatingRepair();
  await testCodexTimeoutKillsIgnoringProcessTree();
  await testRepairTelemetryFailureDoesNotFailExecution();
  await testRepairAbortCancelsInFlightMcpRequest();
  await testPublicDetailsAndTextRedaction();
  await testWebMutationProtection();
  await testAuthShapeAndFreshStatus();
  await testDurableIssueLogPaginationAndLiveCursor();
  console.log("media-issue-agent review regression tests passed");
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
