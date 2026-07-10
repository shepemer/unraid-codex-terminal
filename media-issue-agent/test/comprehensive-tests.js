import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { MediaIssueAgent } from "../src/agent.js";
import { main } from "../src/cli.js";
import { AUTOMATED_SUFFIX, CLOSED_MARKER, REOPENED_MARKER, countCharacters } from "../src/comments.js";
import { inspectCodexAuth, loadConfig } from "../src/config.js";
import {
  createApproval,
  createPlannedAction,
  ensureJob,
  initDb,
  insertSnapshot,
  jobDetails,
  markPlannedActionExecuted,
  pendingApprovalForJob,
  setPendingApprovals,
  transitionJob,
  upsertInvestigation
} from "../src/db.js";
import { issueTableMarkdown } from "../src/issues.js";
import { MediaMcpClient } from "../src/mcp-client.js";
import { createWebHandler } from "../src/web.js";
import { closeServer, jsonRpcError as rpcError, jsonRpcResult as rpcResult, readBody } from "./helpers.js";

async function tempDir(prefix = "media-issue-agent-comprehensive-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeAuthHome(authJson) {
  const dir = await tempDir("media-issue-agent-auth-");
  await writeFile(path.join(dir, "auth.json"), typeof authJson === "string" ? authJson : JSON.stringify(authJson));
  return dir;
}

async function writeFakeCodex(root, handlerSource) {
  const bin = path.join(root, "codex-fixture.mjs");
  await writeFile(bin, [
    "#!/usr/bin/env node",
    "import { readFileSync } from 'node:fs';",
    "const prompt = readFileSync(0, 'utf8');",
    handlerSource
  ].join("\n"));
  await chmod(bin, 0o700);
  return bin;
}

function rpcToolError(id, message) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [{ type: "text", text: message }]
    }
  };
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`, server);
  } finally {
    await closeServer(server);
  }
}

async function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const result = await fn();
    return { result, stdout: logs.join("\n"), stderr: errors.join("\n") };
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

async function testCodexAuthInspectionEdges() {
  const root = await tempDir();
  const missingHome = path.join(root, "missing-home");
  const missingAuth = path.join(root, "missing-auth");
  await mkdir(missingAuth);
  const emptyAuth = await writeAuthHome("");
  const invalidAuth = await writeAuthHome("{");
  const apiKeyAuth = await writeAuthHome({
    auth_mode: "chatgpt",
    tokens: {
      access_token: ["sk", "fixturetoken"].join("-")
    }
  });
  const chatGptAuth = await writeAuthHome({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: "fixture-access-token"
    }
  });

  try {
    assert.equal((await inspectCodexAuth("")).status, "missing_home");
    assert.equal((await inspectCodexAuth(missingHome)).status, "missing_auth");
    assert.equal((await inspectCodexAuth(missingAuth)).status, "missing_auth");
    assert.equal((await inspectCodexAuth(emptyAuth)).status, "empty_auth");
    assert.equal((await inspectCodexAuth(invalidAuth)).status, "invalid_auth");
    assert.equal((await inspectCodexAuth(apiKeyAuth)).status, "api_key_auth");

    const loaded = await loadConfig({
      ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture-token",
      ISSUE_AGENT_WEB_ENABLED: "false",
      ISSUE_AGENT_POLL_INTERVAL_SECONDS: "30",
      ISSUE_AGENT_SNAPSHOT_RETENTION: "3",
      CODEX_HOME: chatGptAuth
    });
    assert.equal(loaded.webEnabled, false);
    assert.equal(loaded.pollIntervalSeconds, 30);
    assert.equal(loaded.issueSnapshotRetention, 3);

    await assert.rejects(
      () => loadConfig({
        ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture-token",
        ISSUE_AGENT_POLL_INTERVAL_SECONDS: "29",
        CODEX_HOME: chatGptAuth
      }),
      /Expected integer >= 30/
    );
    await assert.rejects(
      () => loadConfig({
        ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture-token",
        CODEX_HOME: chatGptAuth,
        CODEX_API_KEY: ["sk", "fixture"].join("-")
      }),
      /refuses OpenAI API key/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(emptyAuth, { recursive: true, force: true });
    await rm(invalidAuth, { recursive: true, force: true });
    await rm(apiKeyAuth, { recursive: true, force: true });
    await rm(chatGptAuth, { recursive: true, force: true });
  }
}

async function testMediaMcpClientResponsesAndRedaction() {
  const requests = [];
  await withServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    requests.push({
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body
    });
    if (body.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            { name: "json_ok", description: "Fixture JSON tool." },
            { name: "sse_ok", description: "Fixture SSE tool." }
          ]
        }
      }));
      return;
    }
    const name = body.params.name;
    if (name === "json_ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rpcResult(body.id, { ok: true, via: "json" })));
      return;
    }
    if (name === "sse_ok") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify(rpcResult(body.id, { ok: true, via: "sse" }))}\n\n`);
      return;
    }
    if (name === "sse_multi") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        `event: progress\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}`,
        `event: message\ndata: ${JSON.stringify(rpcResult(body.id, { ok: true, via: "sse_multi" }))}`,
        ""
      ].join("\n\n"));
      return;
    }
    if (name === "sse_result_then_progress") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        `event: message\ndata: ${JSON.stringify(rpcResult(body.id, { ok: true, via: "result_then_progress" }))}`,
        `event: progress\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { done: true } })}`,
        ""
      ].join("\n\n"));
      return;
    }
    const privateError = `${["Bearer", "sil-secret-token"].join(" ")} https://service.example.invalid/private /mnt/user/private/file.mkv`;
    if (name === "http_error") {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(privateError);
      return;
    }
    if (name === "rpc_error") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rpcError(body.id, privateError)));
      return;
    }
    if (name === "tool_error") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rpcToolError(body.id, privateError)));
      return;
    }
    throw new Error(`Unexpected test tool ${name}`);
  }, async baseUrl => {
    const client = new MediaMcpClient({
      mediaMcpUrl: baseUrl,
      mediaMcpBearerToken: "fixture-token",
      mcpRequestTimeoutMs: 10000
    });
    assert.deepEqual(await client.callTool("json_ok", { one: 1 }), { ok: true, via: "json" });
    assert.deepEqual(await client.callTool("sse_ok"), { ok: true, via: "sse" });
    assert.deepEqual(await client.callTool("sse_multi"), { ok: true, via: "sse_multi" });
    assert.deepEqual(await client.callTool("sse_result_then_progress"), { ok: true, via: "result_then_progress" });
    assert.deepEqual((await client.listTools()).map(tool => tool.name), ["json_ok", "sse_ok"]);
    assert.equal(requests[0].authorization, ["Bearer", "fixture-token"].join(" "));
    assert.match(requests[0].accept, /text\/event-stream/);
    assert.equal(requests[0].body.id, 1);
    assert.equal(requests[1].body.id, 2);
    assert.deepEqual(requests[0].body.params.arguments, { one: 1 });

    for (const name of ["http_error", "rpc_error", "tool_error"]) {
      await assert.rejects(
        () => client.callTool(name),
        error => {
          assert.doesNotMatch(error.message, /sil-secret-token/);
          assert.doesNotMatch(error.message, /service\.example\.invalid/);
          assert.doesNotMatch(error.message, /\/mnt\/user/);
          return true;
        }
      );
    }
  });
}

async function testCliHelpAndUnknownCommand() {
  const help = await captureConsole(() => main(["help"], {}));
  assert.equal(help.result, 0);
  assert.match(help.stdout, /media-issue-agent serve/);

  await assert.rejects(
    () => main(["not-a-command"], {}),
    error => {
      assert.match(error.message, /Unknown command: not-a-command/);
      assert.doesNotMatch(error.message, /ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN/);
      assert.doesNotMatch(error.message, /CODEX_HOME/);
      return true;
    }
  );

  await assert.rejects(
    () => main(["approve", "1"], {
      ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture-token",
      ISSUE_AGENT_WEB_ENABLED: "false"
    }),
    /CODEX_HOME is required/
  );
}

async function testDbApprovalAndActionPersistence() {
  const dir = await tempDir();
  const dbPath = path.join(dir, "state.sqlite");
  try {
    await initDb(dbPath);
    const job = ensureJob(dbPath, "seerr", "fixture-1001");
    transitionJob(dbPath, job.id, "detected", "closed");
    assert.equal(ensureJob(dbPath, "seerr", "fixture-1001", "detected").state, "closed");

    const actionApproval = createApproval(dbPath, job.id, "action", { plan: "fixture" });
    const resolutionApproval = createApproval(dbPath, job.id, "resolution", { message: "fixture" });
    setPendingApprovals(dbPath, job.id, "approved", "fixture", "action");
    assert.equal(pendingApprovalForJob(dbPath, job.id, "action"), null);
    assert.equal(pendingApprovalForJob(dbPath, job.id, "resolution").id, resolutionApproval.id);

    const action = createPlannedAction(dbPath, job.id, "fixture_tool", { nested: true }, "fixture-risk");
    markPlannedActionExecuted(dbPath, action.id, { dry: true }, true);
    markPlannedActionExecuted(dbPath, action.id, { done: true }, false);
    const details = jobDetails(dbPath, job.id);
    assert.equal(details.approvals.find(approval => approval.id === actionApproval.id).status, "approved");
    assert.equal(details.plannedActions[0].dryRunResult.dry, true);
    assert.equal(details.plannedActions[0].result.done, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testAgentGuardRails() {
  const dir = await tempDir();
  const dbPath = path.join(dir, "state.sqlite");
  try {
    await initDb(dbPath);
    const agent = new MediaIssueAgent({
      dbPath,
      codexHome: "",
      dryRun: false
    }, {
      async callTool() {
        throw new Error("No media-mcp calls expected");
      }
    });
    const job = ensureJob(dbPath, "seerr", "fixture-2001");
    await assert.rejects(() => agent.approve(job.id, "fixture"), /no pending approval/);
    assert.throws(() => agent.reject(job.id, "fixture"), /no pending approval/);
    await assert.rejects(() => agent.continueJob(job.id, "fixture"), /cannot continue from detected/);
    await assert.rejects(() => agent.steerInvestigation(job.id, "client-side", "fixture"), /has no investigation to steer/);

    upsertInvestigation(dbPath, job.id, {
      status: "ready",
      summary: "Fixture summary",
      evidence: { issueId: "fixture-2001" }
    });
    await assert.rejects(() => agent.steerInvestigation(job.id, "", "fixture"), /Steering message is required/);
    await assert.rejects(() => agent.steerInvestigation(job.id, "client-side", "fixture"), /Cannot transition job/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testPlexResolutionFallbackAndClosure() {
  const root = await tempDir();
  const dbPath = path.join(root, "state.sqlite");
  const codexHome = await writeAuthHome({
    auth_mode: "chatgpt",
    tokens: { access_token: "fixture-access-token", refresh_token: "fixture-refresh-token" }
  });
  const calls = [];
  try {
    const codexBin = await writeFakeCodex(root, [
      "if (prompt.includes('Draft a reporter-facing')) {",
      "  process.stdout.write(`${'x'.repeat(320)}\\nAutomated response from Codex.\\n`);",
      "} else {",
      "  process.stdout.write('Investigation summary: client-side playback issue; no server-side action is needed.\\n');",
      "}"
    ].join("\n"));
    const client = {
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "plex_issue_details") {
          return { issue: { source: "plex", id: args.issueId, status: "open", message: "Fixture Plex issue", comments: [] } };
        }
        if (name === "media_diagnose_issue") {
          return { issue: { source: "plex", id: args.issueId }, suggestedActions: [] };
        }
        if (name === "plex_add_reported_issue_comment") {
          return { issue: { id: args.issueId, status: "open" }, message: args.message, dryRun: args.dryRun };
        }
        throw new Error(`Unexpected tool ${name}`);
      }
    };
    const agent = new MediaIssueAgent({
      dbPath,
      codexHome,
      codexBin,
      codexWorkspace: path.join(root, "workspace"),
      codexTimeoutMs: 10000,
      dryRun: false
    }, client);
    await agent.init();
    const entries = [{
      source: "plex",
      issueId: "plex-comprehensive-1",
      date: "2026-01-01T00:00:00Z",
      reporter: "Fixture Reporter",
      mediaTitle: "Fixture Plex Title",
      status: "open",
      description: "Fixture Plex issue"
    }];
    const snapshot = insertSnapshot(dbPath, issueTableMarkdown(entries), entries);
    const investigated = await agent.investigate(snapshot.id, 1, { force: true });
    const resolution = await agent.approve(investigated.jobId, "fixture");
    assert.equal(resolution.status, "awaiting_resolution_approval");
    assert.equal(resolution.executionResult.outcome, "client_side");
    assert.match(resolution.message, /Automated response from Codex\.$/);
    assert.ok(countCharacters(resolution.message) <= 300);
    assert.doesNotMatch(resolution.message, /^x{20}/);

    const closed = await agent.approve(investigated.jobId, "fixture");
    assert.equal(closed.status, "closed");
    assert.equal(jobDetails(dbPath, investigated.jobId).job.state, "closed");
    const commentCalls = calls.filter(call => call.name === "plex_add_reported_issue_comment");
    assert.equal(commentCalls.length, 2);
    assert.equal(commentCalls[0].args.dryRun, false);
    assert.match(commentCalls[0].args.message, new RegExp(`${AUTOMATED_SUFFIX.replaceAll(".", "\\.")}$`));
    assert.equal(commentCalls[1].args.message, "Closed.");
    assert.equal(calls.some(call => call.name === "seerr_resolve_issue"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function testDelegatingDraftRejectedBeforeFallback() {
  const root = await tempDir();
  const dbPath = path.join(root, "state.sqlite");
  const codexHome = await writeAuthHome({
    auth_mode: "chatgpt",
    tokens: { access_token: "fixture-access-token", refresh_token: "fixture-refresh-token" }
  });
  try {
    const codexBin = await writeFakeCodex(root, [
      "if (prompt.includes('Draft a reporter-facing')) {",
      "  process.stdout.write('Server owner should replace this manually before closing. ' + 'x'.repeat(260) + '\\nAutomated response from Codex.\\n');",
      "} else {",
      "  process.stdout.write('Investigation summary: client-side playback issue; no server-side action is needed.\\n');",
      "}"
    ].join("\n"));
    const client = {
      async callTool(name, args) {
        if (name === "plex_issue_details") {
          return { issue: { source: "plex", id: args.issueId, status: "open", message: "Fixture Plex issue", comments: [] } };
        }
        if (name === "media_diagnose_issue") {
          return { issue: { source: "plex", id: args.issueId }, suggestedActions: [] };
        }
        throw new Error(`Unexpected tool ${name}`);
      }
    };
    const agent = new MediaIssueAgent({
      dbPath,
      codexHome,
      codexBin,
      codexWorkspace: path.join(root, "workspace"),
      codexTimeoutMs: 10000,
      dryRun: false
    }, client);
    await agent.init();
    const entries = [{
      source: "plex",
      issueId: "plex-delegating-draft",
      date: "2026-01-01T00:00:00Z",
      reporter: "Fixture Reporter",
      mediaTitle: "Fixture Plex Title",
      status: "open",
      description: "Fixture Plex issue"
    }];
    const snapshot = insertSnapshot(dbPath, issueTableMarkdown(entries), entries);
    const investigated = await agent.investigate(snapshot.id, 1, { force: true });
    const returned = await agent.approve(investigated.jobId, "fixture");
    assert.equal(returned.status, "awaiting_action_approval");
    assert.match(returned.message, /Review or steer the investigation/);
    const details = jobDetails(dbPath, investigated.jobId);
    assert.equal(details.job.state, "awaiting_action_approval");
    assert.match(details.job.lastError, /Draft resolution delegated/);
    assert.equal(details.approvals.filter(approval => approval.kind === "action" && approval.status === "pending").length, 1);
    assert.equal(details.approvals.filter(approval => approval.kind === "resolution" && approval.status === "pending").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function testManualCloseReopenAndClosedCommentSummary() {
  const root = await tempDir();
  const dbPath = path.join(root, "state.sqlite");
  const calls = [];
  const issueState = {
    "5101": {
      status: "open",
      comments: []
    },
    "5102": {
      status: "closed",
      comments: [
        { message: "Reporter confirmed the replacement file works.", createdAt: "2026-01-01T00:00:00Z" },
        { message: CLOSED_MARKER, createdAt: "2026-01-01T00:01:00Z" }
      ]
    }
  };
  try {
    const client = {
      async callTool(name, args) {
        calls.push({ name, args });
        const issue = issueState[String(args.issueId)] || { status: "open", comments: [] };
        if (name === "plex_issue_details") {
          return { issue: { source: args.source, id: args.issueId, status: issue.status, comments: issue.comments } };
        }
        if (name === "seerr_add_issue_comment") {
          issue.comments.push({ message: args.message, createdAt: new Date().toISOString() });
          if (args.message === CLOSED_MARKER) {
            issue.status = "resolved";
          }
          if (args.message === REOPENED_MARKER) {
            issue.status = "open";
          }
          return { issue: { id: args.issueId, status: issue.status }, message: args.message, dryRun: args.dryRun };
        }
        if (name === "seerr_resolve_issue") {
          issue.status = "resolved";
          return { issue: { id: args.issueId, status: "resolved" }, dryRun: args.dryRun };
        }
        if (name === "seerr_reopen_issue") {
          issue.status = "open";
          return { issue: { id: args.issueId, status: "open" }, dryRun: args.dryRun };
        }
        throw new Error(`Unexpected tool ${name}`);
      }
    };
    const agent = new MediaIssueAgent({
      dbPath,
      codexHome: "",
      dryRun: false
    }, client);
    await agent.init();
    const entries = [
      {
        source: "seerr",
        issueId: "5101",
        date: "2026-01-01T00:00:00Z",
        reporter: "Fixture Reporter",
        mediaTitle: "Manual Close Fixture",
        status: "open",
        description: "Manual close path"
      },
      {
        source: "seerr",
        issueId: "5102",
        date: "2026-01-01T00:00:00Z",
        reporter: "Fixture Reporter",
        mediaTitle: "Already Closed Fixture",
        status: "closed",
        description: "Already closed path"
      }
    ];
    const snapshot = insertSnapshot(dbPath, issueTableMarkdown(entries), entries);

    const commentOnlySummary = await agent.issueSummary(snapshot.id, 2);
    assert.equal(commentOnlySummary.closed, true);
    assert.match(commentOnlySummary.summary, /Summary derived from issue comments/);
    assert.match(commentOnlySummary.summary, /Reporter confirmed/);
    assert.match(commentOnlySummary.summary, /Closed\./);

    const closed = await agent.closeIssue(snapshot.id, 1, "Operator manually closed this fixture.", "fixture");
    assert.equal(closed.status, "closed");
    assert.equal(jobDetails(dbPath, closed.jobId).job.state, "closed");
    assert.deepEqual(calls.filter(call => call.args.issueId === 5101).map(call => [call.name, call.args.message || ""]).slice(-3), [
      ["seerr_add_issue_comment", "Operator manually closed this fixture."],
      ["seerr_resolve_issue", ""],
      ["seerr_add_issue_comment", CLOSED_MARKER]
    ]);

    const localSummary = await agent.issueSummary(snapshot.id, 1);
    assert.equal(localSummary.closed, true);
    assert.match(localSummary.summary, /Local workflow history/);
    assert.match(localSummary.summary, /direct_close_completed/);

    const reopened = await agent.reopenIssue(snapshot.id, 1, "fixture");
    assert.equal(reopened.status, "open");
    assert.equal(jobDetails(dbPath, closed.jobId).job.state, "detected");
    assert.ok(calls.some(call => call.name === "seerr_add_issue_comment" && call.args.issueId === 5101 && call.args.message === REOPENED_MARKER));
    assert.ok(calls.some(call => call.name === "seerr_reopen_issue" && call.args.issueId === 5101));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testWebErrorRedactionAndRouteEdges() {
  const config = {
    webUsername: "operator",
    webPassword: "fixture-password",
    codexHome: "",
    codexWorkspace: "/tmp/fixture-workspace",
    codexBin: "codex"
  };
  const agent = {
    status: () => {
      throw new Error(`${["Bearer", "sil-secret-token"].join(" ")} https://service.example.invalid/private /mnt/user/private/file.mkv`);
    }
  };
  await withServer(createWebHandler(agent, config), async baseUrl => {
    const auth = `Basic ${Buffer.from("operator:fixture-password").toString("base64")}`;
    const denied = await fetch(`${baseUrl}/api/status`, {
      headers: { authorization: `Basic ${Buffer.from("operator:wrong").toString("base64")}` }
    });
    assert.equal(denied.status, 401);

    const missing = await fetch(`${baseUrl}/missing`, { headers: { authorization: auth } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "Not found");

    const failed = await fetch(`${baseUrl}/api/status`, { headers: { authorization: auth } });
    assert.equal(failed.status, 500);
    const body = await failed.json();
    assert.equal(body.ok, false);
    assert.doesNotMatch(body.error, /sil-secret-token/);
    assert.doesNotMatch(body.error, /service\.example\.invalid/);
    assert.doesNotMatch(body.error, /\/mnt\/user/);
  });
}

async function run() {
  await testCodexAuthInspectionEdges();
  await testMediaMcpClientResponsesAndRedaction();
  await testCliHelpAndUnknownCommand();
  await testDbApprovalAndActionPersistence();
  await testAgentGuardRails();
  await testPlexResolutionFallbackAndClosure();
  await testDelegatingDraftRejectedBeforeFallback();
  await testManualCloseReopenAndClosedCommentSummary();
  await testWebErrorRedactionAndRouteEdges();
  console.log("media-issue-agent comprehensive tests passed");
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
