import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaIssueAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { startWebServer } from "../src/web.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const agentRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(agentRoot, "..");

const FIXTURE_TOKEN = "sil-fixture-token";
const WEB_USERNAME = "operator";
const WEB_PASSWORD = "sil-fixture-password";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "media-issue-agent-sil-"));
}

async function closeServer(server) {
  if (!server) {
    return;
  }
  await new Promise(resolve => server.close(resolve));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

function jsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{
        type: "text",
        text: JSON.stringify(result)
      }]
    }
  };
}

function jsonRpcError(id, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message
    }
  };
}

function fixtureIssues() {
  return new Map([
    ["plex-sil-closed", {
      source: "plex",
      id: "plex-sil-closed",
      status: "open",
      commentCount: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-06T00:00:00Z",
      reporter: { displayName: "Fixture Reporter A" },
      mediaTitle: "SIL Closed Fixture",
      message: "Already handled by prior automation.",
      comments: [{ message: "Closed." }]
    }],
    ["1001", {
      source: "seerr",
      id: 1001,
      status: "open",
      commentCount: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-05T00:00:00Z",
      reporter: "Fixture Reporter B",
      mediaTitle: "SIL Fixture Episode",
      message: "Playback stalls on one device."
    }],
    ["plex-sil-open", {
      source: "plex",
      id: "plex-sil-open",
      status: "open",
      commentCount: 0,
      comments: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-04T00:00:00Z",
      reporter: { username: "fixture-reporter-c" },
      mediaTitle: "SIL Subtitle Fixture",
      mediaType: "movie",
      plexRatingKey: "109444",
      year: 2026,
      message: "subtitle-repair-fixture: Please add Korean subtitles."
    }],
    ["1002", {
      source: "seerr",
      id: 1002,
      status: "open",
      commentCount: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-03T00:00:00Z",
      reporter: "Fixture Reporter D",
      mediaTitle: "SIL Closure Failure Fixture",
      message: "Needs resolution, but closing will fail in SIL."
    }],
    ["1003", {
      source: "seerr",
      id: 1003,
      status: "open",
      commentCount: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      reporter: "Fixture Reporter E",
      mediaTitle: "SIL Codex Failure Fixture",
      message: "codex-failure-fixture"
    }],
    ["1004", {
      source: "seerr",
      id: 1004,
      status: "open",
      commentCount: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      reporter: "Fixture Reporter F",
      mediaTitle: "SIL Direct Close Fixture",
      message: "Operator will close and re-open this fixture."
    }]
  ]);
}

async function startFakeMediaMcp() {
  const issues = fixtureIssues();
  const calls = [];
  const failCloseIssueIds = new Set();
  const server = http.createServer(async (req, res) => {
    let requestId = null;
    try {
      if (req.method !== "POST") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      if (req.headers.authorization !== `Bearer ${FIXTURE_TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        return;
      }
      const body = JSON.parse(await readBody(req));
      requestId = body.id;
      const toolName = body?.params?.name;
      const args = body?.params?.arguments || {};
      calls.push({ name: toolName, args });
      let result;
      if (toolName === "plex_reported_issues") {
        result = {
          records: [...issues.values()].map(issue => {
            const { comments: _comments, ...record } = issue;
            return record;
          })
        };
      } else if (toolName === "plex_issue_details") {
        const issue = issues.get(String(args.issueId));
        result = {
          issue: {
            ...issue,
            source: args.source || issue?.source,
            comments: issue?.comments || []
          }
        };
      } else if (toolName === "media_diagnose_issue") {
        const issue = issues.get(String(args.issueId));
        result = {
          issue,
          observations: [
            "Fixture diagnostics collected.",
            issue?.message || "Fixture issue has no message."
          ],
          suggestedActions: []
        };
      } else if (toolName === "seerr_add_issue_comment") {
        if (failCloseIssueIds.has(Number(args.issueId))) {
          const secretLike = ["Bearer", "sil-secret-token"].join(" ");
          throw new Error(`Simulated closure failure at https://service.example.invalid/private using ${secretLike} and /mnt/user/sil/private.mkv`);
        }
        const issue = issues.get(String(args.issueId));
        if (issue) {
          issue.comments = [...(issue.comments || []), {
            message: args.message,
            createdAt: new Date().toISOString()
          }];
          issue.commentCount = issue.comments.length;
          issue.updatedAt = new Date().toISOString();
        }
        result = {
          issue: { id: args.issueId, status: "open" },
          message: args.message,
          dryRun: args.dryRun
        };
      } else if (toolName === "seerr_resolve_issue") {
        const issue = issues.get(String(args.issueId));
        if (issue) {
          issue.status = "resolved";
          issue.updatedAt = new Date().toISOString();
        }
        result = {
          issue: { id: args.issueId, status: "resolved" },
          dryRun: args.dryRun
        };
      } else if (toolName === "seerr_reopen_issue") {
        const issue = issues.get(String(args.issueId));
        if (issue) {
          issue.status = "open";
          issue.updatedAt = new Date().toISOString();
        }
        result = {
          issue: { id: args.issueId, status: "open" },
          dryRun: args.dryRun
        };
      } else if (toolName === "plex_add_reported_issue_comment") {
        const issue = issues.get(String(args.issueId));
        if (issue) {
          issue.comments = [...(issue.comments || []), {
            message: args.message,
            createdAt: new Date().toISOString()
          }];
          issue.commentCount = issue.comments.length;
          issue.updatedAt = new Date().toISOString();
        }
        result = {
          issue: { id: args.issueId, status: "open" },
          message: args.message,
          dryRun: args.dryRun
        };
      } else if (toolName === "bazarr_download_movie_subtitles_for_plex") {
        assert.equal(args.plexRatingKey, "109444");
        assert.equal(args.language, "ko");
        assert.equal(args.dryRun, false);
        result = {
          dryRun: false,
          language: "ko",
          plexRatingKey: "109444",
          radarrMovie: { id: 44, title: "SIL Subtitle Fixture" }
        };
      } else if (toolName === "plex_refresh_metadata") {
        assert.equal(args.ratingKey, "109444");
        assert.equal(args.dryRun, false);
        result = {
          dryRun: false,
          ratingKey: "109444",
          refreshed: true
        };
      } else if (toolName === "plex_verify_subtitle_track") {
        assert.equal(args.ratingKey, "109444");
        assert.equal(args.language, "ko");
        result = {
          ratingKey: "109444",
          language: "ko",
          found: true,
          subtitleCount: 1,
          matches: [{ languageCode: "ko", language: "Korean" }]
        };
      } else {
        throw new Error(`Unexpected SIL media-mcp tool ${toolName}`);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonRpcResult(body.id, result)));
    } catch (error) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonRpcError(requestId, error.message)));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    failCloseIssueIds,
    close: () => closeServer(server)
  };
}

async function createCodexHome(root) {
  const codexHome = path.join(root, "codex-home");
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "sil-id-token",
      access_token: "sil-access-token",
      refresh_token: "sil-refresh-token",
      account_id: "sil-account"
    },
    last_refresh: "2026-01-01T00:00:00.000000000Z"
  }, null, 2));
  return codexHome;
}

async function createFakeCodexBin(root, logPath) {
  const bin = path.join(root, "codex-fixture.mjs");
  await writeFile(bin, [
    "#!/usr/bin/env node",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const prompt = readFileSync(0, 'utf8');",
    "let kind = 'investigation';",
    "if (prompt.includes('Revise the investigation')) kind = 'steered-investigation';",
    "if (prompt.includes('Draft a reporter-facing')) kind = 'comment-draft';",
    "if (prompt.includes('Approved media repair execution')) kind = 'repair-execution';",
    "appendFileSync(process.env.SIL_CODEX_LOG, `${JSON.stringify({ kind, args: process.argv.slice(2) })}\\n`);",
    "if (prompt.includes('codex-failure-fixture')) {",
    "  console.error('simulated Codex failure for SIL fixture');",
    "  process.exit(42);",
    "}",
    "if (kind === 'comment-draft') {",
    "  if (prompt.includes('server_action_completed')) {",
    "    process.stdout.write('Downloaded the requested Korean subtitles and refreshed Plex. Automated response from Codex.\\n');",
    "  } else {",
    "    process.stdout.write('Reviewed as a client-side playback problem. No server-side media action was applied.\\nAutomated response from Codex.\\n');",
    "  }",
    "} else if (kind === 'repair-execution') {",
    "  process.stdout.write(JSON.stringify({ summary: 'Download Korean subtitles and refresh Plex.', actions: [{ toolName: 'bazarr_download_movie_subtitles_for_plex', riskLevel: 'repair', args: { plexRatingKey: '109444', language: 'ko' } }, { toolName: 'plex_refresh_metadata', riskLevel: 'verification', args: { ratingKey: '109444' } }] }));",
    "} else if (kind === 'steered-investigation') {",
    "  process.stdout.write('Revised investigation: this appears to be a client-side playback problem. No server-side action is required.\\nNext action: explain that no media repair was applied.\\n');",
    "} else if (prompt.includes('subtitle-repair-fixture')) {",
    "  process.stdout.write('Investigation summary: this is a Korean subtitle request for a movie. Server-side action is required.\\nExact safe next actions: download Korean subtitles with Bazarr for Plex item 109444, then refresh Plex metadata.\\nUser-side: restart playback after the server action completes.\\n');",
    "} else {",
    "  process.stdout.write('Investigation summary: fixture diagnostics show no exact allowlisted server repair yet.\\nLikely cause: playback metadata mismatch in fixture evidence.\\nNext action: request approval for the proposed no-op follow-up.\\n');",
    "}"
  ].join("\n"));
  await chmod(bin, 0o700);
  await writeFile(logPath, "");
  return bin;
}

async function codexInvocations(logPath) {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : [];
}

function basicAuth() {
  return `Basic ${Buffer.from(`${WEB_USERNAME}:${WEB_PASSWORD}`).toString("base64")}`;
}

async function api(baseUrl, route, options = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      authorization: basicAuth(),
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  assert.equal(response.status, expectedStatus, `${route} returned ${response.status}: ${text}`);
  return body;
}

function cleanEnv(overrides) {
  const env = { ...process.env, ...overrides };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

async function runCli(args, envOverrides, expectedCode = 0) {
  const cliPath = path.join(agentRoot, "src", "cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: cleanEnv(envOverrides),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", code => {
      try {
        assert.equal(code, expectedCode, `CLI ${args.join(" ")} exited ${code}: ${stderr || stdout}`);
        resolve({ stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function pendingApproval(details, kind) {
  return details.approvals.find(approval => approval.kind === kind && approval.status === "pending");
}

function approvalById(details, id) {
  return details.approvals.find(approval => approval.id === id);
}

async function assertPolling(baseUrl, fakeMcp) {
  const polled = await api(baseUrl, "/api/poll", { method: "POST", body: "{}" });
  assert.equal(polled.result.issueCount, 6);
  assert.equal(polled.result.openIssueCount, 5);
  assert.equal(polled.result.closedIssueCount, 1);
  assert.match(polled.result.markdown, /SIL Fixture Episode/);
  assert.match(polled.result.markdown, /SIL Closed Fixture/);
  assert.equal(fakeMcp.calls.filter(call => call.name === "plex_issue_details" && call.args.issueId === "plex-sil-closed").length, 1);

  const latest = await api(baseUrl, "/api/snapshot/latest");
  assert.equal(latest.snapshot.id, polled.result.snapshotId);
  assert.deepEqual(latest.snapshot.entries.map(entry => entry.issueId), ["1001", "plex-sil-open", "1002", "1003", "1004", "plex-sil-closed"]);
  assert.equal(latest.snapshot.entries[0].idx, 1);
  assert.equal(latest.snapshot.entries.at(-1).status, "closed");
  return polled.result.snapshotId;
}

async function assertCliAccess(env, snapshotId) {
  const listed = await runCli(["list"], env);
  assert.match(listed.stdout, /SIL Fixture Episode/);
  assert.match(listed.stdout, /SIL Codex Failure Fixture/);
  const status = await runCli(["status"], env);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.snapshots.latestId, snapshotId);
  assert.ok(parsed.jobs.some(job => job.state === "detected"));
}

async function assertInvestigationSteeringAndClosure(baseUrl, logPath, fakeMcp, snapshotId) {
  const before = await codexInvocations(logPath);
  const investigated = await api(baseUrl, "/api/investigate", {
    method: "POST",
    body: JSON.stringify({ snapshotId, index: 1 })
  });
  assert.equal(investigated.result.cached, false);
  assert.equal((await codexInvocations(logPath)).length, before.length + 1);

  const cached = await api(baseUrl, "/api/investigate", {
    method: "POST",
    body: JSON.stringify({ snapshotId, index: 1 })
  });
  assert.equal(cached.result.cached, true);
  assert.equal((await codexInvocations(logPath)).length, before.length + 1);

  let details = (await api(baseUrl, `/api/jobs/${investigated.result.jobId}`)).detail;
  const firstApproval = pendingApproval(details, "action");
  assert.ok(firstApproval);

  await api(baseUrl, "/api/investigate", {
    method: "POST",
    body: JSON.stringify({ snapshotId, index: 1, force: true })
  });
  assert.equal((await codexInvocations(logPath)).length, before.length + 2);
  details = (await api(baseUrl, `/api/jobs/${investigated.result.jobId}`)).detail;
  assert.equal(approvalById(details, firstApproval.id).status, "superseded");
  const forcedApproval = pendingApproval(details, "action");
  assert.ok(forcedApproval);
  assert.notEqual(forcedApproval.id, firstApproval.id);

  await api(baseUrl, `/api/jobs/${investigated.result.jobId}/steer`, {
    method: "POST",
    body: JSON.stringify({ message: "Treat this as a client-side app issue with no server-side action." })
  });
  assert.equal((await codexInvocations(logPath)).length, before.length + 3);
  details = (await api(baseUrl, `/api/jobs/${investigated.result.jobId}`)).detail;
  assert.equal(approvalById(details, forcedApproval.id).status, "superseded");
  const steeredApproval = pendingApproval(details, "action");
  assert.equal(steeredApproval.payload.plan.classification, "client_side");

  const resolution = await api(baseUrl, `/api/jobs/${investigated.result.jobId}/approve`, {
    method: "POST",
    body: "{}"
  });
  assert.equal(resolution.result.status, "awaiting_resolution_approval");
  assert.equal(resolution.result.executionResult.actionsExecuted, 0);
  assert.match(resolution.result.message, /Automated response from Codex\.$/);
  assert.equal((await codexInvocations(logPath)).length, before.length + 4);

  details = (await api(baseUrl, `/api/jobs/${investigated.result.jobId}`)).detail;
  assert.equal(details.job.state, "awaiting_resolution_approval");
  assert.equal(pendingApproval(details, "resolution").payload.executionResult.outcome, "client_side");

  const closed = await api(baseUrl, `/api/jobs/${investigated.result.jobId}/approve`, {
    method: "POST",
    body: "{}"
  });
  assert.equal(closed.result.status, "closed");
  details = (await api(baseUrl, `/api/jobs/${investigated.result.jobId}`)).detail;
  assert.equal(details.job.state, "closed");
  assert.ok(details.auditEvents.some(event => event.eventType === "issue_closed"));
  assert.deepEqual(details.plannedActions.map(action => action.toolName).sort(), [
    "seerr_add_issue_comment",
    "seerr_add_issue_comment",
    "seerr_resolve_issue"
  ].sort());

  const closeComments = fakeMcp.calls.filter(call => call.name === "seerr_add_issue_comment" && call.args.issueId === 1001);
  assert.equal(closeComments.length, 2);
  assert.match(closeComments[0].args.message, /Automated response from Codex\.$/);
  assert.equal(closeComments[0].args.dryRun, false);
  assert.equal(closeComments[1].args.message, "Closed.");
  const resolveCall = fakeMcp.calls.find(call => call.name === "seerr_resolve_issue" && call.args.issueId === 1001);
  assert.equal(resolveCall.args.dryRun, false);
}

async function assertServerActionExecution(baseUrl, logPath, fakeMcp, snapshotId) {
  const before = await codexInvocations(logPath);
  const investigated = await api(baseUrl, "/api/investigate", {
    method: "POST",
    body: JSON.stringify({ snapshotId, index: 2, force: true })
  });
  assert.equal(investigated.result.cached, false);
  assert.equal((await codexInvocations(logPath)).length, before.length + 1);

  let details = (await api(baseUrl, `/api/jobs/${investigated.result.jobId}`)).detail;
  const actionApproval = pendingApproval(details, "action");
  assert.equal(actionApproval.payload.plan.classification, "server_action");
  assert.equal(actionApproval.payload.plan.executionMode, "approved_repair_agent");
  assert.equal(actionApproval.payload.plan.actions.length, 0);
  assert.deepEqual(actionApproval.payload.plan.candidateActions.map(action => action.toolName), [
    "bazarr_download_movie_subtitles_for_plex",
    "plex_refresh_metadata"
  ]);

  const resolution = await api(baseUrl, `/api/jobs/${investigated.result.jobId}/approve`, {
    method: "POST",
    body: "{}"
  });
  assert.equal(resolution.result.status, "awaiting_resolution_approval");
  assert.equal(resolution.result.executionResult.outcome, "server_action_completed");
  assert.equal(resolution.result.executionResult.actionsRequested, 2);
  assert.equal(resolution.result.executionResult.actionsExecuted, 2);
  assert.match(resolution.result.executionResult.repairAgentSummary, /Download Korean subtitles/);
  assert.equal(resolution.result.executionResult.verification.status, "passed");
  assert.equal(resolution.result.executionResult.verification.checks[0].status, "passed");
  assert.match(resolution.result.message, /Automated response from Codex\.$/);
  assert.equal((await codexInvocations(logPath)).length, before.length + 3);

  details = (await api(baseUrl, `/api/jobs/${investigated.result.jobId}`)).detail;
  assert.equal(details.job.state, "awaiting_resolution_approval");
  assert.equal(pendingApproval(details, "resolution").payload.executionResult.outcome, "server_action_completed");
  assert.deepEqual(details.plannedActions.map(action => action.toolName).sort(), [
    "bazarr_download_movie_subtitles_for_plex",
    "plex_refresh_metadata"
  ].sort());

  const downloadCall = fakeMcp.calls.find(call => call.name === "bazarr_download_movie_subtitles_for_plex");
  assert.equal(downloadCall.args.plexRatingKey, "109444");
  assert.equal(downloadCall.args.language, "ko");
  assert.equal(downloadCall.args.dryRun, false);
  const refreshCall = fakeMcp.calls.find(call => call.name === "plex_refresh_metadata");
  assert.equal(refreshCall.args.ratingKey, "109444");
  assert.equal(refreshCall.args.dryRun, false);
  const verifyCall = fakeMcp.calls.find(call => call.name === "plex_verify_subtitle_track");
  assert.equal(verifyCall.args.ratingKey, "109444");
  assert.equal(verifyCall.args.language, "ko");
}

async function assertRejectPath(baseUrl, snapshotId) {
  const investigated = await api(baseUrl, "/api/investigate", {
    method: "POST",
    body: JSON.stringify({ snapshotId, index: 5 })
  });
  const rejected = await api(baseUrl, `/api/jobs/${investigated.result.jobId}/reject`, {
    method: "POST",
    body: "{}"
  });
  assert.ok(rejected.result.some(approval => approval.status === "rejected"));
  const details = (await api(baseUrl, `/api/jobs/${investigated.result.jobId}`)).detail;
  assert.equal(details.job.state, "blocked_needs_human");
}

async function assertClosureFailurePath(baseUrl, fakeMcp, snapshotId) {
  const investigated = await api(baseUrl, "/api/investigate", {
    method: "POST",
    body: JSON.stringify({ snapshotId, index: 3 })
  });
  await api(baseUrl, `/api/jobs/${investigated.result.jobId}/approve`, {
    method: "POST",
    body: "{}"
  });
  fakeMcp.failCloseIssueIds.add(1002);
  const failed = await api(baseUrl, `/api/jobs/${investigated.result.jobId}/approve`, {
    method: "POST",
    body: "{}"
  }, 500);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /media-mcp seerr_add_issue_comment failed/);
  assert.doesNotMatch(failed.error, /service\.example\.invalid/);
  assert.doesNotMatch(failed.error, /sil-secret-token/);
  assert.doesNotMatch(failed.error, /\/mnt\/user/);
  const details = (await api(baseUrl, `/api/jobs/${investigated.result.jobId}`)).detail;
  assert.equal(details.job.state, "failed_retryable");
  assert.doesNotMatch(details.job.lastError, /service\.example\.invalid/);
  assert.doesNotMatch(details.job.lastError, /sil-secret-token/);
  assert.doesNotMatch(details.job.lastError, /\/mnt\/user/);
}

async function assertCodexFailurePath(baseUrl, snapshotId) {
  const investigated = await api(baseUrl, "/api/investigate", {
    method: "POST",
    body: JSON.stringify({ snapshotId, index: 4 })
  });
  assert.equal(investigated.result.status, "failed");
  assert.equal(investigated.result.approvalId, null);
  const details = (await api(baseUrl, `/api/jobs/${investigated.result.jobId}`)).detail;
  assert.equal(details.job.state, "failed_retryable");
  assert.equal(details.approvals.filter(approval => approval.status === "pending").length, 0);
  assert.equal(details.investigation.status, "failed");
  assert.match(details.investigation.summary, /could not be generated automatically/);
}

async function assertDirectCloseReopenPath(baseUrl, fakeMcp, snapshotId) {
  const closed = await api(baseUrl, `/api/issues/${snapshotId}/5/close`, {
    method: "POST",
    body: JSON.stringify({ comment: "Operator reviewed and closed this fixture." })
  });
  assert.equal(closed.result.status, "closed");
  const jobId = closed.result.jobId;
  let details = (await api(baseUrl, `/api/jobs/${jobId}`)).detail;
  assert.equal(details.job.state, "closed");
  assert.deepEqual(details.plannedActions.map(action => action.toolName).sort(), [
    "seerr_add_issue_comment",
    "seerr_add_issue_comment",
    "seerr_resolve_issue"
  ].sort());

  const summary = await api(baseUrl, `/api/issues/${snapshotId}/5/summary`);
  assert.equal(summary.closed, true);
  assert.match(summary.summary, /Local workflow history/);
  assert.match(summary.summary, /direct_close_completed/);

  const directComments = fakeMcp.calls.filter(call => call.name === "seerr_add_issue_comment" && call.args.issueId === 1004);
  assert.equal(directComments[0].args.message, "Operator reviewed and closed this fixture.");
  assert.equal(directComments[1].args.message, "Closed.");
  assert.ok(fakeMcp.calls.some(call => call.name === "seerr_resolve_issue" && call.args.issueId === 1004));

  const reopened = await api(baseUrl, `/api/issues/${snapshotId}/5/reopen`, {
    method: "POST",
    body: "{}"
  });
  assert.equal(reopened.result.status, "open");
  details = (await api(baseUrl, `/api/jobs/${jobId}`)).detail;
  assert.equal(details.job.state, "detected");
  const reopenedComment = fakeMcp.calls.find(call => call.name === "seerr_add_issue_comment" && call.args.issueId === 1004 && call.args.message === "Re-opened issue.");
  assert.ok(reopenedComment);
  assert.ok(fakeMcp.calls.some(call => call.name === "seerr_reopen_issue" && call.args.issueId === 1004));

  const repolled = await api(baseUrl, "/api/poll", { method: "POST", body: "{}" });
  assert.equal(repolled.result.openIssueCount, 4);
  assert.equal(repolled.result.closedIssueCount, 2);
  const latest = await api(baseUrl, "/api/snapshot/latest");
  const reopenedEntry = latest.snapshot.entries.find(entry => entry.issueId === "1004");
  assert.equal(reopenedEntry.status, "open");
  assert.equal(reopenedEntry.jobState, "detected");
}

async function run() {
  const root = await tempDir();
  const oldCodexLog = process.env.SIL_CODEX_LOG;
  let fakeMcp;
  let webServer;
  try {
    fakeMcp = await startFakeMediaMcp();
    const dbPath = path.join(root, "state", "media-issue-agent.sqlite");
    const codexHome = await createCodexHome(root);
    const codexLogPath = path.join(root, "codex-invocations.jsonl");
    const codexBin = await createFakeCodexBin(root, codexLogPath);
    process.env.SIL_CODEX_LOG = codexLogPath;
    const env = {
      ISSUE_AGENT_MEDIA_MCP_URL: fakeMcp.url,
      ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: FIXTURE_TOKEN,
      ISSUE_AGENT_DB_PATH: dbPath,
      ISSUE_AGENT_CODEX_BIN: codexBin,
      ISSUE_AGENT_CODEX_WORKSPACE: path.join(root, "codex-workspace"),
      ISSUE_AGENT_CODEX_TIMEOUT_MS: "10000",
      ISSUE_AGENT_MCP_REQUEST_TIMEOUT_MS: "10000",
      ISSUE_AGENT_POLL_INTERVAL_SECONDS: "30",
      ISSUE_AGENT_WEB_HOST: "127.0.0.1",
      ISSUE_AGENT_WEB_PORT: "6983",
      ISSUE_AGENT_WEB_USERNAME: WEB_USERNAME,
      ISSUE_AGENT_WEB_PASSWORD: WEB_PASSWORD,
      CODEX_HOME: codexHome,
      SIL_CODEX_LOG: codexLogPath
    };
    const config = await loadConfig(env, { requireWebPassword: true });
    const agent = new MediaIssueAgent(config);
    await agent.init();
    webServer = await startWebServer(agent, { ...config, webHost: "127.0.0.1", webPort: 0 }, () => {});
    const { port } = webServer.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const snapshotId = await assertPolling(baseUrl, fakeMcp);
    await assertCliAccess(env, snapshotId);
    await assertInvestigationSteeringAndClosure(baseUrl, codexLogPath, fakeMcp, snapshotId);
    await assertServerActionExecution(baseUrl, codexLogPath, fakeMcp, snapshotId);
    await assertRejectPath(baseUrl, snapshotId);
    await assertClosureFailurePath(baseUrl, fakeMcp, snapshotId);
    await assertCodexFailurePath(baseUrl, snapshotId);
    await assertDirectCloseReopenPath(baseUrl, fakeMcp, snapshotId);
  } finally {
    if (oldCodexLog === undefined) {
      delete process.env.SIL_CODEX_LOG;
    } else {
      process.env.SIL_CODEX_LOG = oldCodexLog;
    }
    await closeServer(webServer);
    await fakeMcp?.close();
    await rm(root, { recursive: true, force: true });
  }
  console.log("media-issue-agent SIL tests passed");
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
