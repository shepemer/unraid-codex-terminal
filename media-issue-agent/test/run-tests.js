import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import {
  createApproval,
  ensureJob,
  initDb,
  insertSnapshot,
  investigationForJob,
  pendingApprovalForJob,
  snapshotEntries,
  snapshotEntry,
  supersedePendingApprovals,
  transitionJob,
  upsertInvestigation
} from "../src/db.js";
import { filterOpenIssues, hasPlexClosedComment, issueTableMarkdown } from "../src/issues.js";
import { validateDraftComment, AUTOMATED_SUFFIX } from "../src/comments.js";
import { redactText, sanitizeValue } from "../src/redact.js";
import { createWebHandler } from "../src/web.js";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "media-issue-agent-test-"));
}

async function authHome(authJson = { chatgpt: { account: "fixture" } }) {
  const dir = await tempDir();
  await writeFile(path.join(dir, "auth.json"), JSON.stringify(authJson));
  return dir;
}

async function testPlexClosedFilter() {
  assert.equal(hasPlexClosedComment([{ message: " Closed. " }]), true);
  assert.equal(hasPlexClosedComment([{ message: "Closed but not marker" }]), false);
  const calls = [];
  const client = {
    async callTool(name, args) {
      calls.push({ name, args });
      return {
        issue: {
          source: "plex",
          id: args.issueId,
          status: "open",
          message: "Already handled",
          comments: [{ message: " closed. " }]
        }
      };
    }
  };
  const open = await filterOpenIssues([
    { source: "plex", id: "plex-fixture-1", status: "open", commentCount: 1, message: "Already handled" },
    { source: "seerr", id: 22, status: "open", message: "Needs attention", mediaTitle: "Fixture Movie" }
  ], client);
  assert.deepEqual(open.map(issue => issue.source), ["seerr"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "plex_issue_details");
}

async function testTableAndSnapshotMapping() {
  const dir = await tempDir();
  const dbPath = path.join(dir, "state.sqlite");
  await initDb(dbPath);
  const entries = [{
    source: "seerr",
    issueId: "42",
    date: "2026-01-01T00:00:00Z",
    reporter: "Fixture Reporter",
    mediaTitle: "Fixture | Title",
    status: "open",
    description: "Line one\nline two"
  }];
  const markdown = issueTableMarkdown(entries);
  assert.match(markdown, /Fixture \\| Title/);
  assert.match(markdown, /Line one line two/);
  const snapshot = insertSnapshot(dbPath, markdown, entries);
  const mapped = snapshotEntry(dbPath, snapshot.id, 1);
  assert.equal(mapped.source, "seerr");
  assert.equal(mapped.issueId, "42");
  await rm(dir, { recursive: true, force: true });
}

async function testInvestigationCacheAndStaleApprovalSuperseding() {
  const dir = await tempDir();
  const dbPath = path.join(dir, "state.sqlite");
  await initDb(dbPath);
  const entries = [{
    source: "plex",
    issueId: "plex-fixture-1001",
    date: "2026-01-01T00:00:00Z",
    reporter: "Fixture Reporter",
    mediaTitle: "Fixture Movie",
    status: "open",
    description: "Fixture playback issue"
  }];
  const snapshot = insertSnapshot(dbPath, issueTableMarkdown(entries), entries);
  const job = ensureJob(dbPath, "plex", "plex-fixture-1001");
  const approval = createApproval(dbPath, job.id, "action", { summary: "Previous summary" });
  const cached = upsertInvestigation(dbPath, job.id, {
    status: "ready",
    summary: "Cached investigation summary",
    evidence: { issueId: "plex-fixture-1001", source: "plex" }
  });
  assert.equal(cached.summary, "Cached investigation summary");
  assert.equal(investigationForJob(dbPath, job.id).evidence.issueId, "plex-fixture-1001");
  assert.equal(pendingApprovalForJob(dbPath, job.id).id, approval.id);

  const mapped = snapshotEntry(dbPath, snapshot.id, 1);
  assert.equal(mapped.jobId, job.id);
  assert.equal(mapped.jobState, "detected");
  assert.equal(mapped.investigationStatus, "ready");
  assert.equal(mapped.investigationSummary, "Cached investigation summary");
  assert.equal(snapshotEntries(dbPath, snapshot.id)[0].investigationSummary, "Cached investigation summary");

  supersedePendingApprovals(dbPath, job.id);
  assert.equal(pendingApprovalForJob(dbPath, job.id), null);
  await rm(dir, { recursive: true, force: true });
}

function testCommentValidation() {
  const ok = `Fixed the missing subtitle track and refreshed Plex.\n${AUTOMATED_SUFFIX}`;
  assert.equal(validateDraftComment("plex", ok).valid, true);
  const tooLong = `${"x".repeat(300)}${AUTOMATED_SUFFIX}`;
  const invalid = validateDraftComment("plex", tooLong);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join("\n"), /300 characters/);
  assert.equal(validateDraftComment("seerr", "Missing suffix").valid, false);
}

async function testAuthConfig() {
  const codexHome = await authHome();
  const chatGptCodexHome = await authHome({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "fixture-id-token",
      access_token: "fixture-access-token",
      refresh_token: "fixture-refresh-token",
      account_id: "fixture-account-id"
    },
    last_refresh: "2026-01-01T00:00:00.000000000Z"
  });
  const apiKeyCodexHome = await authHome({
    auth_mode: "apikey",
    OPENAI_API_KEY: "sk-fixturetoken"
  });
  await assert.rejects(
    () => loadConfig({
      ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture-token",
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "sk-fixture"
    }),
    /refuses OpenAI API key/
  );
  await assert.rejects(
    () => loadConfig({
      ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture-token"
    }),
    /CODEX_HOME is required/
  );
  const webStartupWithoutAuth = await loadConfig({
    ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture-token"
  }, { requireCodexAuth: false });
  assert.equal(webStartupWithoutAuth.mediaMcpBearerToken, "fixture-token");
  const loaded = await loadConfig({
    ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture-token",
    CODEX_HOME: codexHome
  });
  assert.equal(loaded.codexHome, codexHome);
  const chatGptLoaded = await loadConfig({
    ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture-token",
    CODEX_HOME: chatGptCodexHome
  });
  assert.equal(chatGptLoaded.codexHome, chatGptCodexHome);
  await assert.rejects(
    () => loadConfig({
      ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture-token",
      CODEX_HOME: apiKeyCodexHome
    }),
    /appears to contain API-key auth/
  );
  await assert.rejects(
    () => loadConfig({
      ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: "fixture-token",
      CODEX_HOME: codexHome
    }, { requireWebPassword: true }),
    /ISSUE_AGENT_WEB_PASSWORD is required/
  );
  await rm(codexHome, { recursive: true, force: true });
  await rm(chatGptCodexHome, { recursive: true, force: true });
  await rm(apiKeyCodexHome, { recursive: true, force: true });
}

async function testStateTransitions() {
  const dir = await tempDir();
  await mkdir(dir, { recursive: true });
  const dbPath = path.join(dir, "state.sqlite");
  await initDb(dbPath);
  const job = ensureJob(dbPath, "seerr", "fixture-issue");
  transitionJob(dbPath, job.id, ["detected"], "investigating");
  await assert.rejects(
    async () => transitionJob(dbPath, job.id, ["detected"], "closed"),
    /Cannot transition/
  );
  await rm(dir, { recursive: true, force: true });
}

async function testDbDirectoryWritablePreflight() {
  const dir = await tempDir();
  const lockedDir = path.join(dir, "locked");
  await mkdir(lockedDir, { recursive: true });
  await chmod(lockedDir, 0o500);
  try {
    await assert.rejects(
      async () => initDb(path.join(lockedDir, "state.sqlite")),
      /SQLite state directory is not writable/
    );
  } finally {
    await chmod(lockedDir, 0o700);
    await rm(dir, { recursive: true, force: true });
  }
}

function testRedaction() {
  const fakeOpenAiToken = "sk-" + "fixturetoken";
  const redacted = redactText(`Bearer abc123 https://internal.example.invalid/path /mnt/user/media/file.mkv ${fakeOpenAiToken}`);
  assert.doesNotMatch(redacted, /abc123/);
  assert.doesNotMatch(redacted, /internal\.example/);
  assert.doesNotMatch(redacted, /mnt\/user/);
  assert.doesNotMatch(redacted, new RegExp(fakeOpenAiToken));
  assert.deepEqual(sanitizeValue({ apiKey: "secret", nested: { password: "pw" } }), {
    apiKey: "[REDACTED]",
    nested: { password: "[REDACTED]" }
  });
}

async function testWebAuthAndApi() {
  const config = {
    webUsername: "operator",
    webPassword: "fixture-password"
  };
  let investigateRequest = null;
  const agent = {
    status: () => ({ dryRun: true, snapshots: { count: 1, latestId: 7 }, jobs: [], approvals: [] }),
    latestWithEntries: () => ({
      id: 7,
      generatedAt: "2026-01-01T00:00:00Z",
      entries: [{
        idx: 1,
        source: "seerr",
        issueId: "fixture",
        description: "<script>",
        jobId: 9,
        jobState: "awaiting_action_approval",
        investigationStatus: "ready",
        investigationSummary: "Cached fixture summary",
        investigationUpdatedAt: "2026-01-01T00:01:00Z"
      }]
    }),
    jobs: () => [],
    approvals: () => [],
    pollOnce: async () => ({ snapshotId: 8, issueCount: 1 }),
    investigate: async (snapshotId, index, options) => {
      investigateRequest = { snapshotId, index, options };
      return { jobId: 9, approvalId: 10, summary: "Fixture summary" };
    },
    approve: () => [{ id: 10, status: "approved" }],
    reject: () => [{ id: 10, status: "rejected" }]
  };
  const server = http.createServer(createWebHandler(agent, config));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const auth = `Basic ${Buffer.from("operator:fixture-password").toString("base64")}`;
  try {
    const denied = await fetch(`${baseUrl}/api/status`);
    assert.equal(denied.status, 401);
    const status = await fetch(`${baseUrl}/api/status`, { headers: { authorization: auth } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status.snapshots.latestId, 7);
    const page = await fetch(`${baseUrl}/`, { headers: { authorization: auth } });
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /Media Issue Agent/);
    assert.match(pageText, /<html lang="en" data-theme="dark">/);
    assert.match(pageText, /data-theme-choice="dark"/);
    assert.match(pageText, /id="auth-panel"/);
    const css = await fetch(`${baseUrl}/assets/app.css`, { headers: { authorization: auth } });
    assert.equal(css.status, 200);
    const cssText = await css.text();
    assert.match(cssText, /:root\[data-theme="dark"\]/);
    assert.match(cssText, /\.job-row \{\s+display: grid;/);
    assert.match(cssText, /justify-self: end;/);
    assert.match(cssText, /white-space: nowrap;/);
    const js = await fetch(`${baseUrl}/assets/app.js`, { headers: { authorization: auth } });
    assert.equal(js.status, 200);
    const jsText = await js.text();
    assert.match(jsText, /media-issue-agent-theme/);
    assert.match(jsText, /applyTheme\(document\.documentElement\.dataset\.theme \|\| "dark"\)/);
    assert.match(jsText, /class="job-main"/);
    assert.match(jsText, /\/api\/auth\/login/);
    assert.match(jsText, /Re-investigate/);
    assert.match(jsText, /function showEntry/);
    assert.match(jsText, /stateLabel\(job\.state\)/);
    assert.match(jsText, /force/);
    const authStatus = await fetch(`${baseUrl}/api/auth`, { headers: { authorization: auth } });
    assert.equal(authStatus.status, 200);
    const authBody = await authStatus.json();
    assert.equal(authBody.auth.ok, false);
    assert.equal(authBody.auth.status, "missing_home");
    const investigated = await fetch(`${baseUrl}/api/investigate`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: 7, index: 1, force: true })
    });
    assert.equal((await investigated.json()).result.jobId, 9);
    assert.deepEqual(investigateRequest, {
      snapshotId: 7,
      index: 1,
      options: { force: true }
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function run() {
  await testPlexClosedFilter();
  await testTableAndSnapshotMapping();
  testCommentValidation();
  await testInvestigationCacheAndStaleApprovalSuperseding();
  await testAuthConfig();
  await testStateTransitions();
  await testDbDirectoryWritablePreflight();
  testRedaction();
  await testWebAuthAndApi();
  console.log("media-issue-agent tests passed");
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
