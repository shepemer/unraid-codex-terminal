import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { MediaIssueAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import {
  createApproval,
  createAgentRun,
  ensureJob,
  initDb,
  insertSnapshot,
  recordAgentRunEvent,
  setPendingApprovals,
  transitionJob,
  upsertImprovementItems,
  upsertMissingMcpItems,
  upsertInvestigation
} from "../src/db.js";
import { issueTableMarkdown } from "../src/issues.js";
import { startWebServer } from "../src/web.js";
import { closeServer, createCodexHome, jsonRpcError, jsonRpcResult, readBody } from "./helpers.js";
import { appendDiagnosticLog } from "../src/diagnostic-log.js";

const WEB_USERNAME = "operator";
const WEB_PASSWORD = "web-e2e-password";
const MCP_TOKEN = "web-e2e-token";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "media-issue-agent-web-e2e-"));
}

async function createFakeCodexBin(root, logPath) {
  const bin = path.join(root, "codex-fixture.mjs");
  await writeFile(bin, [
    "#!/usr/bin/env node",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const prompt = readFileSync(0, 'utf8');",
    "await new Promise(resolve => setTimeout(resolve, 300));",
    "let kind = 'investigation';",
    "if (prompt.includes('Revise the investigation')) kind = 'steered-investigation';",
    "if (prompt.includes('Draft a reporter-facing')) kind = 'comment-draft';",
    "if (prompt.includes('MCP capability gap audit')) kind = 'mcp-capability-check';",
    "if (prompt.includes('Completed media issue workflow improvement analysis.')) kind = 'workflow-improvement';",
    "if (prompt.includes('Investigation prompt improvement implementation audit.')) kind = 'prompt-improvement-check';",
    "appendFileSync(process.env.WEB_E2E_CODEX_LOG, `${JSON.stringify({ kind })}\\n`);",
    "if (kind === 'workflow-improvement') {",
    "  const result = { summary: 'Learned one reusable fixture improvement.', improvements: [{ dedupeKey: 'fixture_verify_before_repair', title: 'Verify fixture state before repair', target: 'suggested_repair_steps', description: 'Check fixture state before selecting repair actions.', recommendedChange: 'Inspect and verify fixture state before handing repair steps to the executor.', rationale: 'Trusted steering corrected a missing verification step.', issuePattern: 'Fixture issues needing operator correction.', implementationSignals: ['verify fixture state'], steeringEvidence: [{ sequence: 1, guidance: 'Verify first.', effect: 'Added verification.' }] }] };",
    "  const outputPathIndex = process.argv.indexOf('--output-last-message');",
    "  if (outputPathIndex >= 0) await import('node:fs').then(fs => fs.writeFileSync(process.argv[outputPathIndex + 1], JSON.stringify(result)));",
    "  process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } })}\\n`);",
    "} else if (kind === 'prompt-improvement-check') {",
    "  const itemIds = [...prompt.matchAll(/\\\"id\\\":\\s*(\\d+)/g)].map(match => Number(match[1]));",
    "  const result = { summary: 'Fixture prompt check completed.', results: itemIds.map(itemId => ({ itemId, implemented: true, matchType: 'implemented', confidence: 'high', matchedSurfaces: ['investigationPromptInstructions'], reason: 'The fixture prompt implements the requested verification behavior.', rationaleDetails: { requestedBehavior: 'Verify fixture state.', implementedBehavior: 'Current prompt requires verification.', remainingGap: '', evidence: ['verification instruction'] } })) };",
    "  const outputPathIndex = process.argv.indexOf('--output-last-message');",
    "  if (outputPathIndex >= 0) await import('node:fs').then(fs => fs.writeFileSync(process.argv[outputPathIndex + 1], JSON.stringify(result)));",
    "  process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } })}\\n`);",
    "} else if (kind === 'mcp-capability-check') {",
    "  const itemIds = [...prompt.matchAll(/\\\"id\\\":\\s*(\\d+)/g)].map(match => Number(match[1]));",
    "  const negativeItemId = prompt.includes('fixture_archive_probe') ? Math.max(...itemIds) : null;",
    "  const result = { summary: 'Fixture capability check completed.', results: itemIds.map(itemId => itemId === negativeItemId ? ({ itemId, detected: false, toolName: 'media_diagnose_issue', matchType: 'partial', confidence: 'high', reason: 'The available fixture diagnostics tool is related but does not satisfy the requested archive probe.' }) : ({ itemId, detected: true, toolName: 'sonarr_replace_fixture_episode', matchType: 'agent_reasoned', confidence: 'high', reason: 'The available fixture replacement tool satisfies this request.' })) };",
    "  const outputPathIndex = process.argv.indexOf('--output-last-message');",
    "  if (outputPathIndex >= 0) await import('node:fs').then(fs => fs.writeFileSync(process.argv[outputPathIndex + 1], JSON.stringify(result)));",
    "  process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } })}\\n`);",
    "} else if (kind === 'comment-draft') {",
    "  process.stdout.write('Reviewed as a client-side playback problem. No server-side media action was applied.\\nAutomated response from Codex.\\n');",
    "} else if (kind === 'steered-investigation') {",
    "  process.stdout.write('Revised investigation: client-side app playback issue. No server-side action is required.\\n');",
    "} else {",
    "  process.stdout.write('Investigation summary: fixture diagnostics require operator steering before repair.\\n');",
    "}"
  ].join("\n"));
  await chmod(bin, 0o700);
  await writeFile(logPath, "");
  return bin;
}

async function codexInvocationCount(logPath) {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.trim() ? text.trim().split("\n").length : 0;
}

function mediaIssue(issueId, overrides = {}) {
  return {
    source: "seerr",
    id: Number(issueId),
    status: "open",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: `2026-01-${String(Number(issueId) % 20 + 1).padStart(2, "0")}T00:00:00Z`,
    reporter: "Fixture Reporter",
    mediaTitle: `Fixture Title ${issueId}`,
    message: `Fixture issue ${issueId}`,
    ...overrides
  };
}

async function startFakeMediaMcp(issues) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let requestId = null;
    try {
      if (req.headers.authorization !== ["Bearer", MCP_TOKEN].join(" ")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const body = JSON.parse(await readBody(req));
      requestId = body.id;
      if (body.method === "tools/list") {
        calls.push({ name: "tools/list", args: {} });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "media_diagnose_issue", description: "Collect read-only diagnostics for a media issue." },
              { name: "sonarr_replace_fixture_episode", description: "Replace a fixture episode for MCP gap detection tests." },
              { name: "seerr_add_issue_comment", description: "Add a reporter-facing issue comment." },
              { name: "seerr_resolve_issue", description: "Resolve a Seerr issue after approval." },
              { name: "seerr_reopen_issue", description: "Reopen a Seerr issue after approval." }
            ]
          }
        }));
        return;
      }
      if (body.method !== "tools/call") {
        throw new Error(`Unexpected media-mcp method ${body.method}`);
      }
      const name = body.params.name;
      const args = body.params.arguments || {};
      calls.push({ name, args });
      let result;
      if (name === "plex_reported_issues") {
        result = {
          records: issues.map(issue => {
            const { comments: _comments, ...record } = issue;
            return { ...record };
          })
        };
      } else if (name === "plex_issue_details") {
        const issue = issues.find(candidate => String(candidate.id) === String(args.issueId));
        result = { issue: { ...issue, comments: issue?.comments || [] } };
      } else if (name === "media_diagnose_issue") {
        const issue = issues.find(candidate => String(candidate.id) === String(args.issueId));
        result = { issue, observations: ["Fixture diagnostics collected."], suggestedActions: [] };
      } else if (name === "seerr_add_issue_comment") {
        const issue = issues.find(candidate => String(candidate.id) === String(args.issueId));
        if (issue) {
          issue.comments = [...(issue.comments || []), {
            message: args.message,
            createdAt: new Date().toISOString()
          }];
          issue.commentCount = issue.comments.length;
          issue.updatedAt = new Date().toISOString();
        }
        result = { issue: { id: args.issueId, status: "open" }, message: args.message, dryRun: args.dryRun };
      } else if (name === "seerr_resolve_issue") {
        const issue = issues.find(candidate => String(candidate.id) === String(args.issueId));
        if (issue) {
          issue.status = "resolved";
          issue.updatedAt = new Date().toISOString();
        }
        result = { issue: { id: args.issueId, status: "resolved" }, dryRun: args.dryRun };
      } else if (name === "seerr_reopen_issue") {
        const issue = issues.find(candidate => String(candidate.id) === String(args.issueId));
        if (issue) {
          issue.status = "open";
          issue.updatedAt = new Date().toISOString();
        }
        result = { issue: { id: args.issueId, status: "open" }, dryRun: args.dryRun };
      } else {
        throw new Error(`Unexpected media-mcp tool ${name}`);
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
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => closeServer(server)
  };
}

async function startHarness(root, fakeMcp, options = {}) {
  const codexHome = await createCodexHome(root);
  const codexLogPath = path.join(root, "codex-invocations.jsonl");
  const codexBin = options.codexBin || await createFakeCodexBin(root, codexLogPath);
  if (options.codexBin) {
    await writeFile(codexLogPath, "");
  }
  const previousLog = process.env.WEB_E2E_CODEX_LOG;
  process.env.WEB_E2E_CODEX_LOG = codexLogPath;
  const config = await loadConfig({
    ISSUE_AGENT_MEDIA_MCP_URL: fakeMcp.url,
    ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN: MCP_TOKEN,
    ISSUE_AGENT_DB_PATH: path.join(root, "state", "media-issue-agent.sqlite"),
    ISSUE_AGENT_CODEX_BIN: codexBin,
    ISSUE_AGENT_CODEX_WORKSPACE: path.join(root, "workspace"),
    ISSUE_AGENT_CODEX_TIMEOUT_MS: "10000",
    ISSUE_AGENT_CODEX_ENV_ALLOWLIST: "WEB_E2E_CODEX_LOG",
    ISSUE_AGENT_MCP_REQUEST_TIMEOUT_MS: "10000",
    ISSUE_AGENT_WEB_HOST: "127.0.0.1",
    ISSUE_AGENT_WEB_PORT: "6983",
    ISSUE_AGENT_WEB_USERNAME: WEB_USERNAME,
    ISSUE_AGENT_WEB_PASSWORD: WEB_PASSWORD,
    CODEX_HOME: codexHome
  }, { requireWebPassword: true });
  const agent = new MediaIssueAgent(config);
  await agent.init();
  const server = await startWebServer(agent, { ...config, webHost: "127.0.0.1", webPort: 0 }, () => {});
  return {
    agent,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    codexLogPath,
    config,
    close: async () => {
      if (previousLog === undefined) {
        delete process.env.WEB_E2E_CODEX_LOG;
      } else {
        process.env.WEB_E2E_CODEX_LOG = previousLog;
      }
      await closeServer(server);
    }
  };
}

async function newPage(browser, baseUrl, viewport = null) {
  const context = await browser.newContext({
    ...(viewport ? { viewport } : {}),
    acceptDownloads: true,
    httpCredentials: {
      username: WEB_USERNAME,
      password: WEB_PASSWORD
    }
  });
  const page = await context.newPage();
  await page.goto(baseUrl);
  await expect(page.locator("#auth-heading")).toHaveText("ChatGPT Connected");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#daily-token-usage")).toContainText(/Today .+ tokens/);
  return { context, page };
}

function row(page, index) {
  return page.locator(`tr[data-entry-index="${index}"]`);
}

function card(page, index) {
  return page.locator(`article.issue-card[data-entry-index="${index}"]`);
}

async function assertNoHorizontalOverflow(page) {
  const layout = await page.evaluate(() => ({
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth
  }));
  assert.ok(layout.documentScrollWidth <= layout.documentClientWidth + 2, JSON.stringify(layout));
  assert.ok(layout.bodyScrollWidth <= layout.viewportWidth + 2, JSON.stringify(layout));
}

function datetimeLocalValue(date) {
  const pad = value => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes())
  ].join("");
}

async function testIssueStateActionMatrix(browser) {
  const root = await tempDir();
  const fakeMcp = await startFakeMediaMcp([]);
  let harness;
  let context;
  try {
    harness = await startHarness(root, fakeMcp);
    const dbPath = harness.config.dbPath;
    await initDb(dbPath);
    const entries = [
      { source: "seerr", issueId: "201", date: "2026-01-01T00:00:00Z", reporter: "Fixture", mediaTitle: "New", status: "open", description: "New issue" },
      { source: "seerr", issueId: "202", date: "2026-01-02T00:00:00Z", reporter: "Fixture", mediaTitle: "Needs Approval", status: "open", description: "Approval issue" },
      { source: "seerr", issueId: "203", date: "2026-01-03T00:00:00Z", reporter: "Fixture", mediaTitle: "Approved", status: "open", description: "Approved issue" },
      { source: "seerr", issueId: "204", date: "2026-01-04T00:00:00Z", reporter: "Fixture", mediaTitle: "Resolution", status: "open", description: "Resolution issue" },
      { source: "seerr", issueId: "205", date: "2026-01-05T00:00:00Z", reporter: "Fixture", mediaTitle: "Closed", status: "open", description: "Closed issue" },
      { source: "seerr", issueId: "206", date: "2026-01-06T00:00:00Z", reporter: "Fixture", mediaTitle: "Terminal", status: "open", description: "Terminal repair issue" },
      { source: "seerr", issueId: "207", date: "2026-01-07T00:00:00Z", reporter: "Fixture", mediaTitle: "Source closed, job stale", status: "resolved", description: "Resolved source row with a stale detected job.", lifecycle: "closed" }
    ];
    insertSnapshot(dbPath, issueTableMarkdown(entries), entries);

    const awaiting = ensureJob(dbPath, "seerr", "202");
    transitionJob(dbPath, awaiting.id, "detected", "awaiting_action_approval");
    upsertInvestigation(dbPath, awaiting.id, { status: "ready", summary: "Awaiting approval summary", evidence: {} });
    createApproval(dbPath, awaiting.id, "action", { plan: { classification: "client_side", actions: [] } });

    const approved = ensureJob(dbPath, "seerr", "203");
    transitionJob(dbPath, approved.id, "detected", "approved_for_execution");
    upsertInvestigation(dbPath, approved.id, { status: "ready", summary: "Approved summary", evidence: {} });
    createApproval(dbPath, approved.id, "action", { plan: { classification: "client_side", actions: [] } });
    setPendingApprovals(dbPath, approved.id, "approved", "fixture", "action");

    const resolution = ensureJob(dbPath, "seerr", "204");
    transitionJob(dbPath, resolution.id, "detected", "awaiting_resolution_approval");
    upsertInvestigation(dbPath, resolution.id, { status: "ready", summary: "Resolution summary", evidence: {} });
    createApproval(dbPath, resolution.id, "resolution", {
      message: "Draft resolution comment.\nAutomated response from Codex.",
      executionResult: { outcome: "client_side", actionsExecuted: 0 }
    });

    const closed = ensureJob(dbPath, "seerr", "205");
    transitionJob(dbPath, closed.id, "detected", "closed");
    upsertInvestigation(dbPath, closed.id, {
      status: "ready",
      summary: "Closed summary with fixture verification.",
      evidence: {
        steeringHistory: [{
          sequence: 1,
          actor: "fixture-operator",
          message: "Verify fixture state before selecting repair actions.",
          previousSummary: "Closed summary without verification."
        }]
      }
    });

    const terminal = ensureJob(dbPath, "seerr", "206");
    transitionJob(dbPath, terminal.id, "detected", "failed_terminal", "Terminal fixture");
    upsertInvestigation(dbPath, terminal.id, { status: "ready", summary: "Terminal summary", evidence: {} });
    createApproval(dbPath, terminal.id, "action", {
      plan: { classification: "server_action", executionMode: "approved_repair_agent", actions: [] }
    });
    setPendingApprovals(dbPath, terminal.id, "approved", "fixture", "action");
    upsertMissingMcpItems(dbPath, terminal.id, null, [{
      title: "Replace a fixture episode",
      description: "Expose a test MCP tool for replacing fixture episodes from the Web UI test.",
      suggestedToolName: "sonarr_replace_fixture_episode",
      category: "sonarr"
    }, {
      title: "Inspect unavailable fixture archive",
      description: "Expose a test MCP tool that is intentionally not available in the fake media MCP server.",
      suggestedToolName: "fixture_archive_probe",
      category: "diagnostics"
    }]);
    upsertImprovementItems(dbPath, closed.id, null, [{
      itemType: "investigation_prompt",
      dedupeKey: "fixture_existing_prompt_improvement",
      title: "Add fixture verification to investigation guidance",
      target: "evidence_collection",
      category: "evidence_collection",
      description: "Require fixture-state verification before classification.",
      recommendedChange: "Add a fixture-state verification step before classification.",
      rationale: "Trusted steering corrected a missing evidence check.",
      issuePattern: "Synthetic fixture issues.",
      implementationSignals: ["verify fixture state"],
      steeringEvidence: [{ sequence: 1, guidance: "Verify first.", effect: "Added evidence collection." }]
    }], "investigation_prompt");

    ensureJob(dbPath, "seerr", "207");

    const pageHandle = await newPage(browser, harness.baseUrl);
    context = pageHandle.context;
    const page = pageHandle.page;
    await page.locator("#mcp-gaps-button").click();
    await expect(page.locator("#mcp-gaps-dialog")).toBeVisible();
    await expect(page.locator("#mcp-gaps-list")).toContainText("Replace a fixture episode");
    await expect(page.locator("#mcp-gaps-list")).toContainText("sonarr_replace_fixture_episode");
    await expect(page.locator("#mcp-gaps-list")).toContainText("Inspect unavailable fixture archive");
    await expect(page.locator("#mcp-gaps-list")).toContainText("Add fixture verification to investigation guidance");
    await expect(page.locator("#improvement-count-all")).toHaveText("3");
    await expect(page.locator("#improvement-count-mcp")).toHaveText("2");
    await expect(page.locator("#improvement-count-prompts")).toHaveText("1");
    await page.locator('[data-improvement-filter="investigation_prompt"]').click();
    await expect(page.locator(".prompt-improvement")).toHaveCount(1);
    await expect(page.locator(".mcp-improvement")).toHaveCount(0);
    await page.locator('[data-improvement-filter="all"]').click();
    await page.locator("#mcp-gaps-check-button").click();
    await expect(page.locator(".mcp-improvement .mcp-gap-detected")).toHaveText("DETECTED");
    await expect(page.locator(".mcp-improvement .mcp-gap-detected")).toHaveAttribute("type", "button");
    await expect(page.locator(".prompt-improvement .mcp-gap-detected")).toHaveText("IMPLEMENTED");
    await expect(page.locator(".mcp-gap-not-detected")).toHaveText("NOT DETECTED");
    await expect(page.locator(".mcp-gap-not-detected")).toHaveAttribute("type", "button");
    await expect(page.locator(".mcp-gap-item.detected [data-remove-mcp-gap]").first()).toHaveClass(/detected/);
    for (const selector of [".mcp-improvement.detected .mcp-gap-actions", ".prompt-improvement.detected .mcp-gap-actions", ".mcp-gap-item.not-detected .mcp-gap-actions"]) {
      await expect(page.locator(selector).locator("button")).toHaveCount(2);
      const actionWidths = await page.locator(selector).locator("button").evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().width)));
      assert.equal(actionWidths[0], actionWidths[1]);
    }
    await page.locator(".mcp-improvement .mcp-gap-detected").click();
    await expect(page.locator("#mcp-gap-detection-dialog")).toBeVisible();
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("Replace a fixture episode");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("sonarr_replace_fixture_episode");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("Live media-mcp tool");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("Requested capability");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("Compared live tool");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("Decision factors");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("Score");
    await page.locator("#mcp-gap-detection-close-button").click();
    await expect(page.locator("#mcp-gap-detection-dialog")).toBeHidden();
    await page.locator(".mcp-gap-not-detected").click();
    await expect(page.locator("#mcp-gap-detection-dialog")).toBeVisible();
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("Inspect unavailable fixture archive");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("does not explicitly cover");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("Missing requirements");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("content probe support");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("Agent advisory: not detected");
    await page.locator("#mcp-gap-detection-close-button").click();
    await expect(page.locator("#mcp-gap-detection-dialog")).toBeHidden();
    await page.locator(".prompt-improvement .mcp-gap-detected").click();
    await expect(page.locator("#mcp-gap-detection-dialog")).toBeVisible();
    await expect(page.locator("#mcp-gap-detection-title")).toHaveText("Prompt Implementation Rationale");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("Requested improvement");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("Current implementation");
    await expect(page.locator("#mcp-gap-detection-body")).toContainText("Current prompt requires verification");
    await page.locator("#mcp-gap-detection-close-button").click();
    const gapReportDownload = page.waitForEvent("download");
    await page.locator("#mcp-gaps-download-button").click();
    const gapReport = await gapReportDownload;
    assert.match(gapReport.suggestedFilename(), /^media-issue-agent-improvements-.*\.md$/);
    const gapReportPath = await gapReport.path();
    const gapReportText = await readFile(gapReportPath, "utf8");
    assert.match(gapReportText, /# Media Issue Agent Improvement Backlog/);
    assert.match(gapReportText, /Important for Codex: improvement details/);
    assert.match(gapReportText, /\[UNTRUSTED_IMPROVEMENT_DATA_START\]/);
    assert.match(gapReportText, /\[UNTRUSTED_IMPROVEMENT_DATA_END\]/);
    assert.match(gapReportText, /Replace a fixture episode/);
    assert.match(gapReportText, /Detection status: DETECTED/);
    assert.match(gapReportText, /Inspect unavailable fixture archive/);
    assert.match(gapReportText, /Detection status: NOT DETECTED/);
    assert.match(gapReportText, /Add fixture verification to investigation guidance/);
    assert.match(gapReportText, /Implementation status: IMPLEMENTED/);
    assert.match(gapReportText, /Recommended change:/);
    assert.match(gapReportText, /Decision factors:/);
    assert.match(gapReportText, /Missing requirements:/);
    assert.match(gapReportText, /Raw detection JSON:/);
    await page.locator("#mcp-gaps-close-button").click();
    await expect(page.locator("#mcp-gaps-dialog")).toBeHidden();
    await page.locator("#mcp-gaps-button").click();
    await expect(page.locator("#mcp-gaps-dialog")).toBeVisible();
    await expect(page.locator(".mcp-gap-detected")).toHaveCount(0);
    await expect(page.locator(".mcp-gap-not-detected")).toHaveCount(0);
    await expect(page.locator("#mcp-gaps-list")).toContainText("Replace a fixture episode");
    await expect(page.locator("[data-remove-mcp-gap]")).toHaveCount(3);
    while (await page.locator("[data-remove-mcp-gap]").count()) {
      const beforeRemove = await page.locator("[data-remove-mcp-gap]").count();
      await page.locator("[data-remove-mcp-gap]").first().click();
      await expect(page.locator("[data-remove-mcp-gap]")).toHaveCount(beforeRemove - 1);
    }
    await expect(page.locator("#mcp-gaps-list")).toContainText("No active improvements");
    await page.locator("#mcp-gaps-close-button").click();
    await expect(page.locator("#mcp-gaps-dialog")).toBeHidden();

    await expect(row(page, 1).getByRole("button", { name: "Investigate" })).toBeVisible();
    await expect(row(page, 1).getByRole("button", { name: "Close" })).toBeVisible();
    await expect(row(page, 2).getByRole("button", { name: "Re-investigate" })).toBeVisible();
    await expect(row(page, 2).getByRole("button", { name: "Close" })).toBeVisible();
    await expect(row(page, 3).getByRole("button", { name: "View repair" })).toBeVisible();
    await expect(row(page, 3).getByRole("button", { name: "Close" })).toHaveCount(0);
    await expect(row(page, 4).getByRole("button", { name: "Approve fix" })).toBeVisible();
    await expect(row(page, 4).getByRole("button", { name: "Close" })).toBeVisible();
    await expect(row(page, 5).getByRole("button", { name: "View summary" })).toBeVisible();
    await expect(row(page, 5).getByRole("button", { name: "Close" })).toHaveCount(0);
    await expect(row(page, 5)).toHaveClass(/issue-closed/);
    await expect(row(page, 6).getByRole("button", { name: "Review repair" })).toBeVisible();
    await expect(row(page, 6).getByRole("button", { name: "Re-investigate" })).toHaveCount(0);
    await expect(row(page, 7).locator("td").nth(6)).toHaveText("closed");
    await expect(row(page, 7)).toHaveClass(/issue-closed/);
    await expect(row(page, 7).getByRole("button", { name: "View summary" })).toBeVisible();
    await expect(row(page, 7).getByRole("button", { name: "Close" })).toHaveCount(0);
    await expect(row(page, 5).getByRole("button", { name: "Learn" })).toBeVisible();
    await row(page, 5).getByRole("button", { name: "Learn" }).click();
    await expect(page.locator("#mcp-gaps-dialog")).toBeVisible();
    await expect(page.locator('[data-improvement-filter="investigation_prompt"]')).toHaveClass(/active/);
    await expect(page.locator("#mcp-gaps-list")).toContainText("Verify fixture state before repair");
    await page.locator("#mcp-gaps-close-button").click();

    await row(page, 3).getByRole("button", { name: "View repair" }).click();
    await expect(page.locator("#detail-heading")).toHaveText("Job Detail");
    await expect(row(page, 3)).toHaveClass(/issue-active/);
    await expect(page.locator("#investigation-output")).toContainText("Job");
    await expect(page.locator("#investigation-output")).toContainText("Approved");
    await expect(page.locator("#continue-button")).toBeVisible();
    await expect(page.locator("#investigation-output")).not.toContainText("Cannot transition");

    await row(page, 4).getByRole("button", { name: "Approve fix" }).click();
    await expect(page.locator("#investigation-output")).toContainText("Approve fix");
    await expect(page.locator("#investigation-output")).toContainText("Draft resolution comment");
    await expect(page.locator("#approval-actions")).toBeVisible();
    await expect(page.locator("#continue-button")).toBeHidden();

    await row(page, 5).click();
    await expect(page.locator("#detail-heading")).toHaveText("Issue Summary");
    await expect(row(page, 5)).toHaveClass(/issue-active/);
    await expect(page.locator("#work-area")).toHaveClass(/detail-open/);
    await expect(page.locator("#detail-band")).toBeVisible();
    await expect(page.locator("#investigation-output")).toContainText("Local workflow history");
    await expect(page.locator("#investigation-output")).toContainText("Closed");
    await expect(page.locator("#reopen-button")).toBeVisible();
    await expect(page.locator("#approval-actions")).toBeHidden();
    await expect(page.locator("#continue-button")).toBeHidden();

    const layout = await page.evaluate(() => {
      const workspace = document.querySelector(".workspace").getBoundingClientRect();
      const detail = document.querySelector("#detail-band").getBoundingClientRect();
      return {
        bodyScrollHeight: document.body.scrollHeight,
        viewportHeight: window.innerHeight,
        workspaceHeight: workspace.height,
        detailHeight: detail.height
      };
    });
    assert.ok(layout.bodyScrollHeight <= layout.viewportHeight + 2, JSON.stringify(layout));
    const ratio = layout.detailHeight / (layout.workspaceHeight + layout.detailHeight);
    assert.ok(ratio > 0.38 && ratio < 0.62, JSON.stringify(layout));

    await page.locator("#detail-close-button").click();
    await expect(page.locator("#detail-band")).toBeHidden();
    await expect(page.locator("#work-area")).not.toHaveClass(/detail-open/);
    await expect(row(page, 5)).not.toHaveClass(/issue-active/);

    await row(page, 6).getByRole("button", { name: "Review repair" }).click();
    await expect(page.locator("#detail-heading")).toHaveText("Job Detail");
    await expect(page.locator("#investigation-output")).toContainText("Failed");
    await expect(page.locator("#steer-panel")).toBeVisible();
    await expect(page.locator("#approval-actions")).toBeHidden();
  } finally {
    await context?.close();
    await harness?.close();
    await fakeMcp.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testJobListRowsDoNotOverlap(browser) {
  const root = await tempDir();
  const fakeMcp = await startFakeMediaMcp([]);
  let harness;
  let context;
  try {
    harness = await startHarness(root, fakeMcp);
    const dbPath = harness.config.dbPath;
    await initDb(dbPath);
    const activeJob = ensureJob(dbPath, "plex", "active-repair");
    transitionJob(dbPath, activeJob.id, "detected", "executing");
    const activeRun = createAgentRun(dbPath, activeJob.id, "repair", "Fixture repair prompt", { model: "fixture-model" });
    recordAgentRunEvent(dbPath, activeRun.id, activeJob.id, "repair_mcp_tool_call", {
      type: "repair_mcp_tool_call",
      toolName: "sonarr_replace_episode",
      arguments: { episodeId: 1234, monitored: true }
    });
    recordAgentRunEvent(dbPath, activeRun.id, activeJob.id, "repair_mcp_tool_result", {
      type: "repair_mcp_tool_result",
      calls: [{ toolName: "sonarr_replace_episode" }],
      status: 200,
      result: { ok: true, summary: "Replacement request accepted by Sonarr." }
    });
    recordAgentRunEvent(dbPath, activeRun.id, activeJob.id, "item.completed", {
      type: "item.completed",
      item: { type: "mcp_tool_call", name: "media.plex_refresh_metadata", status: "completed" }
    });
    recordAgentRunEvent(dbPath, activeRun.id, activeJob.id, "item.completed", {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Sonarr history shows the root of the confusion is season numbering drift."
      }
    });
    recordAgentRunEvent(dbPath, activeRun.id, activeJob.id, "item.completed", {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify({
          status: "fixed",
          summary: "Season history shows the repair completed and verification passed."
        })
      }
    });
    for (let index = 0; index < 16; index += 1) {
      const issueId = index % 3 === 0
        ? `e293935c-859c-49e5-a782-a5bfce703950-${index}`
        : String(7000 + index);
      const job = ensureJob(dbPath, index % 3 === 0 ? "plex" : "seerr", issueId);
      transitionJob(dbPath, job.id, "detected", "closed");
    }

    const pageHandle = await newPage(browser, harness.baseUrl);
    context = pageHandle.context;
    const page = pageHandle.page;
    await page.setViewportSize({ width: 720, height: 1100 });
    await expect(page.locator(".job-row")).toHaveCount(17);
    await expect(page.locator(".job-row").first()).toHaveClass(/processing/);
    await expect(page.locator(".job-row").first().locator(".job-main strong")).toHaveText("Issue repair");
    await expect(page.locator(".job-row").first().locator(".job-main span")).toContainText(`Job ${activeJob.id} · Plex issue active-repair`);
    await page.locator(".job-row").first().click();
    await expect(page.locator("#investigation-output")).toContainText("Live repair activity:");
    await expect(page.locator("#investigation-output")).toContainText("Run 1 · repair · running · model fixture-model");
    await expect(page.locator("#investigation-output")).toContainText("Calling sonarr_replace_episode");
    await expect(page.locator("#investigation-output")).toContainText("Result from sonarr_replace_episode: HTTP 200");
    await expect(page.locator("#investigation-output")).toContainText("accepted by Sonarr");
    await expect(page.locator("#investigation-output")).toContainText("Codex completed plex_refresh_metadata");
    await expect(page.locator("#investigation-output")).toContainText("Codex reported Sonarr history shows the root of the confusion");
    await expect(page.locator("#investigation-output")).toContainText("Codex reported fixed: Season history shows the repair completed");
    await expect(page.locator("#investigation-output")).not.toContainText("hi tory");
    await expect(page.locator("#investigation-output")).not.toContainText("confu ion");
    await expect(page.locator("#investigation-output")).not.toContainText("reque t accepted");
    await expect(page.locator("#investigation-output")).not.toContainText('"toolName"');
    await page.locator("#investigation-output").evaluate(element => {
      element.scrollTop = element.scrollHeight;
    });
    recordAgentRunEvent(dbPath, activeRun.id, activeJob.id, "stdout", {
      type: "stdout",
      text: "fresh activity marker after background refresh"
    });
    await expect(page.locator("#investigation-output")).toContainText("activity marker after background", { timeout: 4000 });
    const bottomGap = await page.locator("#investigation-output").evaluate(element => {
      return element.scrollHeight - element.scrollTop - element.clientHeight;
    });
    assert.ok(bottomGap < 48, `Expected output scroll to stay near bottom, got gap ${bottomGap}`);

    const layout = await page.evaluate(() => {
      return [...document.querySelectorAll(".job-row")].slice(0, 12).map((row, index) => {
        const rowRect = row.getBoundingClientRect();
        const mainRect = row.querySelector(".job-main").getBoundingClientRect();
        const titleRect = row.querySelector(".job-main strong").getBoundingClientRect();
        const sourceRect = row.querySelector(".job-main span").getBoundingClientRect();
        const badgeRect = row.querySelector(".badge").getBoundingClientRect();
        const sourceStyle = getComputedStyle(row.querySelector(".job-main span"));
        return {
          index,
          row: { top: rowRect.top, bottom: rowRect.bottom, height: rowRect.height, left: rowRect.left, right: rowRect.right },
          main: { top: mainRect.top, bottom: mainRect.bottom, left: mainRect.left, right: mainRect.right },
          title: { top: titleRect.top, bottom: titleRect.bottom, height: titleRect.height },
          source: { top: sourceRect.top, bottom: sourceRect.bottom, height: sourceRect.height },
          badge: { top: badgeRect.top, bottom: badgeRect.bottom, left: badgeRect.left, right: badgeRect.right },
          sourceWhiteSpace: sourceStyle.whiteSpace,
          sourceOverflow: sourceStyle.overflow,
          sourceTextOverflow: sourceStyle.textOverflow
        };
      });
    });

    for (const rowLayout of layout) {
      assert.ok(rowLayout.row.height >= 68, JSON.stringify(rowLayout));
      assert.ok(rowLayout.main.top >= rowLayout.row.top - 1, JSON.stringify(rowLayout));
      assert.ok(rowLayout.main.bottom <= rowLayout.row.bottom + 1, JSON.stringify(rowLayout));
      assert.ok(rowLayout.title.bottom <= rowLayout.row.bottom + 1, JSON.stringify(rowLayout));
      assert.ok(rowLayout.source.bottom <= rowLayout.row.bottom + 1, JSON.stringify(rowLayout));
      assert.ok(rowLayout.badge.top >= rowLayout.row.top - 1, JSON.stringify(rowLayout));
      assert.ok(rowLayout.badge.bottom <= rowLayout.row.bottom + 1, JSON.stringify(rowLayout));
      assert.ok(rowLayout.badge.left >= rowLayout.main.right, JSON.stringify(rowLayout));
      assert.equal(rowLayout.sourceWhiteSpace, "nowrap");
      assert.equal(rowLayout.sourceOverflow, "hidden");
      assert.equal(rowLayout.sourceTextOverflow, "ellipsis");
    }
    for (let index = 1; index < layout.length; index += 1) {
      assert.ok(layout[index].row.top >= layout[index - 1].row.bottom + 8, JSON.stringify({ previous: layout[index - 1], current: layout[index] }));
    }
  } finally {
    await context?.close();
    await harness?.close();
    await fakeMcp.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testFullBrowserWorkflow(browser) {
  const root = await tempDir();
  const fakeMcp = await startFakeMediaMcp([mediaIssue(301, {
    updatedAt: "2026-01-06T00:00:00Z",
    mediaTitle: "Browser Flow Fixture",
    message: "Playback stalls on one device."
  })]);
  let harness;
  let context;
  try {
    harness = await startHarness(root, fakeMcp);
    const pageHandle = await newPage(browser, harness.baseUrl);
    context = pageHandle.context;
    const page = pageHandle.page;

    await expect(page.locator("#codex-settings-panel")).toBeHidden();
    await expect(page.locator("#runner-settings-summary")).toHaveText("GPT-5.5 Very High");
    await expect(page.locator("#runner-settings-button")).toBeVisible();
    const topbarHeight = await page.locator(".topbar").evaluate(node => node.getBoundingClientRect().height);
    assert.ok(topbarHeight <= 76, `topbar too tall: ${topbarHeight}`);
    await page.locator("#runner-settings-button").click();
    await expect(page.locator("#codex-settings-panel")).toBeVisible();
    await page.locator("#codex-model").fill("gpt-5");
    await page.locator("#codex-reasoning").selectOption("high");
    await page.locator("#codex-fast-mode").setChecked(false);
    await page.locator("#codex-service-tier").fill("");
    await page.locator("#repair-context-button").click();
    await expect(page.locator("#repair-context-dialog")).toBeVisible();
    await page.locator("#codex-repair-context").fill("Prefer exact IDs in browser tests.");
    await page.locator("#repair-context-save-button").click();
    await expect(page.locator("#toast")).toContainText("Codex settings saved");
    await expect(page.locator("#repair-context-dialog")).toBeHidden();
    await page.locator("#runner-settings-close-button").click();
    await expect(page.locator("#codex-settings-panel")).toBeHidden();
    await page.getByRole("button", { name: "Reload" }).click();
    await page.locator("#runner-settings-button").click();
    await expect(page.locator("#codex-settings-panel")).toBeVisible();
    await expect(page.locator("#codex-model")).toHaveValue("gpt-5");
    await expect(page.locator("#codex-reasoning")).toHaveValue("high");
    await expect(page.locator("#codex-fast-mode")).not.toBeChecked();
    await expect(page.locator("#runner-settings-summary")).toHaveText("GPT-5 High");
    await expect(page.locator("#repair-context-button")).toHaveText("Context Set");
    await page.locator("#repair-context-button").click();
    await expect(page.locator("#codex-repair-context")).toHaveValue("Prefer exact IDs in browser tests.");
    await page.locator("#repair-context-cancel-button").click();
    await expect(page.locator("#repair-context-dialog")).toBeHidden();
    await page.locator("#runner-settings-close-button").click();
    await expect(page.locator("#codex-settings-panel")).toBeHidden();

    await page.getByRole("button", { name: "Poll Now" }).click();
    await expect(row(page, 1)).toContainText("Browser Flow Fixture");
    await expect(row(page, 1).getByRole("button", { name: "Investigate" })).toBeVisible();
    await expect(row(page, 1).getByRole("button", { name: "Close" })).toBeVisible();

    await row(page, 1).getByRole("button", { name: "Investigate" }).click();
    await expect(page.locator("#detail-processing")).toBeVisible();
    await expect(page.locator("#detail-processing")).toContainText("Investigating");
    await expect(page.locator("#detail-band")).toHaveClass(/processing/);
    await expect(page.locator("#investigation-output")).toContainText("Investigation summary");
    await expect(page.locator("#investigation-output")).toContainText("Action summary");
    await expect(page.locator("#investigation-output")).toContainText("Repair prompt preview");
    await expect(page.locator("#detail-processing")).toBeHidden();
    await expect(page.locator("#approval-actions")).toBeVisible();
    assert.equal(await codexInvocationCount(harness.codexLogPath), 1);

    await expect(row(page, 1).getByRole("button", { name: "Re-investigate" })).toBeVisible();
    await row(page, 1).getByRole("button", { name: "Re-investigate" }).click();
    await expect(page.locator("#investigation-output")).toContainText("Investigation summary");
    assert.equal(await codexInvocationCount(harness.codexLogPath), 2);

    const emptySteeringBox = await page.locator("#steer-input").evaluate(element => {
      const style = window.getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
        paddingTop: Number.parseFloat(style.paddingTop),
        paddingBottom: Number.parseFloat(style.paddingBottom),
        borderTop: Number.parseFloat(style.borderTopWidth),
        borderBottom: Number.parseFloat(style.borderBottomWidth)
      };
    });
    const oneRowHeight = emptySteeringBox.lineHeight
      + emptySteeringBox.paddingTop
      + emptySteeringBox.paddingBottom
      + emptySteeringBox.borderTop
      + emptySteeringBox.borderBottom
      + 2;
    assert.ok(emptySteeringBox.height <= oneRowHeight, JSON.stringify(emptySteeringBox));
    await page.locator("#steer-input").fill("Treat this as a client-side app issue with no server-side action.\nMention that the user should restart the app.");
    const steeringBox = await page.locator("#steer-input").evaluate(element => {
      const style = window.getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
        paddingTop: Number.parseFloat(style.paddingTop),
        paddingBottom: Number.parseFloat(style.paddingBottom),
        borderTop: Number.parseFloat(style.borderTopWidth),
        borderBottom: Number.parseFloat(style.borderBottomWidth)
      };
    });
    const fiveRowMax = (steeringBox.lineHeight * 5)
      + steeringBox.paddingTop
      + steeringBox.paddingBottom
      + steeringBox.borderTop
      + steeringBox.borderBottom
      + 2;
    assert.ok(steeringBox.height <= fiveRowMax, JSON.stringify(steeringBox));
    await page.locator("#steer-button").click();
    await expect(page.locator("#steer-input")).toHaveValue("");
    await expect(page.locator("#investigation-output")).toContainText("Revised investigation");
    await expect(page.locator("#investigation-output")).toContainText("Pending action approval");
    await expect(page.locator("#investigation-output")).toContainText("No server-side repair will run");
    await expect(page.locator("#investigation-output")).toContainText("Steering history:");
    await expect(page.locator("#investigation-output")).toContainText("Mention that the user should restart the app.");
    assert.equal(await codexInvocationCount(harness.codexLogPath), 3);

    await page.locator("#approve-button").click();
    await expect(page.locator("#investigation-output")).toContainText("Approve fix");
    await expect(page.locator("#investigation-output")).toContainText("Draft resolution comment");
    await expect(page.locator("#approval-actions")).toBeVisible();
    assert.equal(await codexInvocationCount(harness.codexLogPath), 4);

    await expect(row(page, 1).getByRole("button", { name: "Approve fix" })).toBeVisible();
    await row(page, 1).getByRole("button", { name: "Approve fix" }).click();
    await expect(page.locator("#investigation-output")).toContainText("Draft resolution comment");
    await expect(page.locator("#investigation-output")).not.toContainText("Cannot transition");

    await page.locator("#approve-button").click();
    await expect(page.locator("#investigation-output")).toContainText("Closed");
    await expect(row(page, 1)).toHaveClass(/issue-closed/);
    await expect(row(page, 1).getByRole("button", { name: "View summary" })).toBeVisible();
    await expect(row(page, 1).getByRole("button", { name: "Close" })).toHaveCount(0);

    const commentCalls = fakeMcp.calls.filter(call => call.name === "seerr_add_issue_comment");
    assert.equal(commentCalls.length, 2);
    assert.match(commentCalls[0].args.message, /Automated response from Codex\.$/);
    assert.equal(commentCalls[0].args.dryRun, false);
    assert.equal(commentCalls[1].args.message, "Closed.");
    const resolveCall = fakeMcp.calls.find(call => call.name === "seerr_resolve_issue");
    assert.equal(resolveCall.args.dryRun, false);
    await page.locator("#mcp-gaps-button").click();
    await expect(page.locator("#mcp-gaps-list")).toContainText("Verify fixture state before repair");
    await expect(page.locator(".prompt-improvement")).toBeVisible();
    await page.locator("#mcp-gaps-close-button").click();

    await row(page, 1).getByRole("button", { name: "View summary" }).click();
    await expect(page.locator("#reopen-button")).toBeVisible();
    await page.locator("#reopen-button").click();
    await expect(row(page, 1)).not.toHaveClass(/issue-closed/);
    await expect(row(page, 1).getByRole("button", { name: "Re-investigate" })).toBeVisible();

    await row(page, 1).getByRole("button", { name: "Re-investigate" }).click();
    await expect(page.locator("#investigation-output")).toContainText("Investigation summary");
    assert.equal(await codexInvocationCount(harness.codexLogPath), 6);
  } finally {
    await context?.close();
    await harness?.close();
    await fakeMcp.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testManualCloseReopenBrowser(browser) {
  const root = await tempDir();
  const fakeMcp = await startFakeMediaMcp([mediaIssue(401, {
    updatedAt: "2026-01-07T00:00:00Z",
    mediaTitle: "Manual Close Fixture",
    message: "Operator will close this from the issue queue.",
    commentCount: 0,
    comments: []
  })]);
  let harness;
  let context;
  try {
    harness = await startHarness(root, fakeMcp);
    const pageHandle = await newPage(browser, harness.baseUrl);
    context = pageHandle.context;
    const page = pageHandle.page;

    await page.getByRole("button", { name: "Poll Now" }).click();
    await expect(row(page, 1)).toContainText("Manual Close Fixture");
    await expect(row(page, 1).locator("td").nth(6)).toHaveText("open");
    await expect(row(page, 1).getByRole("button", { name: "Investigate" })).toBeVisible();
    await expect(row(page, 1).getByRole("button", { name: "Close" })).toBeVisible();

    await row(page, 1).getByRole("button", { name: "Close" }).click();
    await expect(page.locator("#close-dialog")).toBeVisible();
    await page.locator("#close-comment").fill("This should not be posted.");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#close-dialog")).toBeHidden();
    assert.equal(fakeMcp.calls.filter(call => call.name === "seerr_add_issue_comment").length, 0);

    await row(page, 1).getByRole("button", { name: "Close" }).click();
    await page.locator("#close-comment").fill("Operator reviewed this fixture manually.");
    await page.getByRole("button", { name: "Close Issue" }).click();
    await expect(page.locator("#close-dialog")).toBeHidden();
    await expect(row(page, 1)).toHaveClass(/issue-closed/);
    await expect(row(page, 1).locator("td").nth(6)).toHaveText("closed");
    await expect(row(page, 1).getByRole("button", { name: "View summary" })).toBeVisible();
    await expect(row(page, 1).getByRole("button", { name: "Close" })).toHaveCount(0);
    await expect(page.locator("#detail-heading")).toHaveText("Issue Summary");
    await expect(page.locator("#investigation-output")).toContainText("Local workflow history");
    await expect(page.locator("#investigation-output")).toContainText("direct_close_completed");
    await expect(page.locator("#reopen-button")).toBeVisible();

    const closeComments = fakeMcp.calls.filter(call => call.name === "seerr_add_issue_comment" && call.args.issueId === 401);
    assert.equal(closeComments.length, 2);
    assert.equal(closeComments[0].args.message, "Operator reviewed this fixture manually.");
    assert.equal(closeComments[1].args.message, "Closed.");
    assert.ok(fakeMcp.calls.some(call => call.name === "seerr_resolve_issue" && call.args.issueId === 401));

    await page.locator("#reopen-button").click();
    await expect(row(page, 1)).not.toHaveClass(/issue-closed/);
    await expect(row(page, 1).locator("td").nth(6)).toHaveText("open");
    await expect(row(page, 1).getByRole("button", { name: "Investigate" })).toBeVisible();
    await expect(row(page, 1).getByRole("button", { name: "Close" })).toBeVisible();
    assert.ok(fakeMcp.calls.some(call => call.name === "seerr_add_issue_comment" && call.args.issueId === 401 && call.args.message === "Re-opened issue."));
    assert.ok(fakeMcp.calls.some(call => call.name === "seerr_reopen_issue" && call.args.issueId === 401));

    await page.getByRole("button", { name: "Poll Now" }).click();
    await expect(row(page, 1)).toContainText("Manual Close Fixture");
    await expect(row(page, 1)).not.toHaveClass(/issue-closed/);
    await expect(row(page, 1).getByRole("button", { name: "Investigate" })).toBeVisible();
  } finally {
    await context?.close();
    await harness?.close();
    await fakeMcp.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testExecutingRepairStatusRendersFromIssueQueue(browser) {
  const root = await tempDir();
  const fakeMcp = await startFakeMediaMcp([]);
  let harness;
  let context;
  try {
    harness = await startHarness(root, fakeMcp);
    const dbPath = harness.config.dbPath;
    await initDb(dbPath);
    const entries = [{
      source: "seerr",
      issueId: "active-repair",
      date: "2026-01-11T00:00:00Z",
      reporter: "Fixture Reporter",
      mediaTitle: "Active Repair Fixture",
      status: "open",
      description: "Repair is currently running."
    }];
    insertSnapshot(dbPath, issueTableMarkdown(entries), entries);
    const job = ensureJob(dbPath, "seerr", "active-repair");
    transitionJob(dbPath, job.id, "detected", "executing");
    upsertInvestigation(dbPath, job.id, {
      status: "ready",
      summary: "Executing repair fixture summary.",
      evidence: {}
    });
    createApproval(dbPath, job.id, "action", {
      source: "seerr",
      issueId: "active-repair",
      summary: "Executing repair fixture summary.",
      evidence: {},
      plan: {
        classification: "server_action",
        executionMode: "approved_repair_agent",
        actions: [],
        requiresServerAction: true,
        repairPrompt: "Keep running the active repair fixture.",
        actionSummary: {
          headline: "Run autonomous media repair for active repair",
          bullets: ["The repair is already executing."]
        }
      }
    });
    setPendingApprovals(dbPath, job.id, "approved", "fixture", "action");

    const pageHandle = await newPage(browser, harness.baseUrl);
    context = pageHandle.context;
    const page = pageHandle.page;
    const jobRow = page.locator(`[data-job-id="${job.id}"]`);

    await expect(jobRow).toContainText("Executing repair");
    await expect(jobRow).not.toContainText("Needs approval");
    await expect(jobRow).toHaveClass(/processing/);
    await expect(row(page, 1)).toHaveClass(/issue-processing/);
    await expect(row(page, 1).getByRole("button", { name: "View repair" })).toBeVisible();
    await expect(row(page, 1).getByRole("button", { name: "Re-investigate" })).toHaveCount(0);

    await row(page, 1).getByRole("button", { name: "View repair" }).click();
    await expect(page.locator("#detail-heading")).toHaveText("Job Detail");
    await expect(page.locator("#investigation-output")).toContainText(`Job ${job.id} · Executing repair`);
    await expect(page.locator("#investigation-output")).not.toContainText("No cached investigation");
    await expect(page.locator("#detail-processing")).toBeVisible();
    await expect(page.locator("#detail-processing")).toContainText("Executing repair");
    await expect(page.locator("#detail-band")).toHaveClass(/processing/);
    await expect(page.locator("#abort-repair-button")).toBeVisible();
    await expect(page.locator("#abort-repair-button")).toBeEnabled();
  } finally {
    await context?.close();
    await harness?.close();
    await fakeMcp.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testAbortBecomesAvailableDuringApprovalExecution(browser) {
  const root = await tempDir();
  const fakeMcp = await startFakeMediaMcp([]);
  let harness;
  let context;
  try {
    const codexBin = path.join(root, "codex-hanging-repair.mjs");
    await writeFile(codexBin, [
      "#!/usr/bin/env node",
      "import { readFileSync } from 'node:fs';",
      "readFileSync(0, 'utf8');",
      "setInterval(() => {}, 1000);"
    ].join("\n"));
    await chmod(codexBin, 0o700);
    harness = await startHarness(root, fakeMcp, { codexBin });
    const dbPath = harness.config.dbPath;
    const entries = [{
      source: "seerr",
      issueId: "abort-in-flight",
      date: "2026-01-11T00:00:00Z",
      reporter: "Fixture Reporter",
      mediaTitle: "Abort In-flight Fixture",
      status: "open",
      description: "Repair will remain active until aborted."
    }];
    insertSnapshot(dbPath, issueTableMarkdown(entries), entries);
    const job = ensureJob(dbPath, "seerr", "abort-in-flight");
    transitionJob(dbPath, job.id, "detected", "awaiting_action_approval");
    upsertInvestigation(dbPath, job.id, {
      status: "ready",
      summary: "Run the fixture repair until explicitly aborted.",
      evidence: { entry: entries[0] }
    });
    createApproval(dbPath, job.id, "action", {
      source: "seerr",
      issueId: "abort-in-flight",
      summary: "Run the fixture repair until explicitly aborted.",
      evidence: { entry: entries[0] },
      plan: {
        classification: "server_action",
        executionMode: "approved_repair_agent",
        requiresServerAction: true,
        actions: [],
        repairPrompt: "Run the fixture repair until explicitly aborted."
      }
    });

    const pageHandle = await newPage(browser, harness.baseUrl);
    context = pageHandle.context;
    const page = pageHandle.page;
    await page.locator(`[data-job-id="${job.id}"]`).click();
    await expect(page.locator("#approval-actions")).toBeVisible();
    await page.locator("#approve-button").click();
    await expect(page.locator("#abort-repair-button")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#abort-repair-button")).toBeEnabled();
    await expect(page.locator("#detail-processing")).toContainText("Executing repair");
    await page.locator("#abort-repair-button").click();
    await expect(page.locator("#investigation-output")).toContainText(/aborted|Review or steer/i, { timeout: 10_000 });
    await expect(page.locator("#abort-repair-button")).toBeHidden();
  } finally {
    await context?.close();
    await harness?.close();
    await fakeMcp.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testDiagnosticLogDownloadDialog(browser) {
  const root = await tempDir();
  const fakeMcp = await startFakeMediaMcp([]);
  let harness;
  let context;
  try {
    harness = await startHarness(root, fakeMcp);
    const inside = new Date(Date.now() - 60_000);
    const outside = new Date(Date.now() - 600_000);
    appendDiagnosticLog(harness.config.logPath, "info", "download_outside_range", {
      message: "This log line should not be downloaded."
    }, { timestamp: outside.toISOString() });
    harness.agent.diagnostic("error", "download_inside_range", {
      jobId: 44,
      error: "Synthetic repair failure for download test."
    });

    const pageHandle = await newPage(browser, harness.baseUrl);
    context = pageHandle.context;
    const page = pageHandle.page;

    await page.locator("#logs-button").click();
    await expect(page.locator("#logs-dialog")).toBeVisible();
    await page.locator("#live-logs-open-button").click();
    await expect(page.locator("#live-logs-dialog")).toBeVisible();
    await expect(page.locator("#live-logs-output")).toContainText("download_inside_range");
    await page.locator("#live-logs-pause-button").click();
    await expect(page.locator("#live-logs-status")).toContainText("Paused");
    await page.locator("#live-logs-close-button").click();
    await expect(page.locator("#live-logs-dialog")).toBeHidden();
    await page.locator("#logs-from").fill(datetimeLocalValue(new Date(inside.getTime() - 120_000)));
    await page.locator("#logs-to").fill(datetimeLocalValue(new Date(inside.getTime() + 120_000)));
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#logs-download-button").click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), "media-issue-agent.log");
    const downloadedPath = await download.path();
    const text = await readFile(downloadedPath, "utf8");
    assert.match(text, /"timestamp":/);
    assert.match(text, /download_inside_range/);
    assert.doesNotMatch(text, /download_outside_range/);
    assert.match(text, /Synthetic repair failure/);
    await page.locator("#logs-cancel-button").click();
    await expect(page.locator("#logs-dialog")).toBeHidden();
  } finally {
    await context?.close();
    await harness?.close();
    await fakeMcp.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function assertMobileDetailSheet(page) {
  const layout = await page.locator("#detail-band").evaluate(node => {
    const rect = node.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  });
  assert.ok(Math.abs(layout.top) <= 1, JSON.stringify(layout));
  assert.ok(Math.abs(layout.left) <= 1, JSON.stringify(layout));
  assert.ok(Math.abs(layout.width - layout.viewportWidth) <= 2, JSON.stringify(layout));
  assert.ok(Math.abs(layout.height - layout.viewportHeight) <= 2, JSON.stringify(layout));
}

async function assertMobileRunnerPanelInViewport(page) {
  const layout = await page.locator("#codex-settings-panel").evaluate(node => {
    const rect = node.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  });
  assert.ok(layout.top >= -1, JSON.stringify(layout));
  assert.ok(layout.left >= -1, JSON.stringify(layout));
  assert.ok(layout.right <= layout.viewportWidth + 1, JSON.stringify(layout));
  assert.ok(layout.bottom <= layout.viewportHeight + 1, JSON.stringify(layout));
  assert.ok(layout.width <= layout.viewportWidth + 1, JSON.stringify(layout));
  assert.ok(layout.height <= layout.viewportHeight + 1, JSON.stringify(layout));
}

async function testMobileTriageLayoutAndManualActions(browser) {
  const root = await tempDir();
  const fakeMcp = await startFakeMediaMcp([
    mediaIssue(501, {
      updatedAt: "2026-01-08T00:00:00Z",
      reporter: "Hidden Mobile Reporter",
      mediaTitle: "Mobile Fixture",
      message: "Short mobile description.",
      commentCount: 0,
      comments: []
    }),
    mediaIssue(502, {
      updatedAt: "2026-01-09T00:00:00Z",
      reporter: "Hidden Close Reporter",
      mediaTitle: "Mobile Close Fixture",
      message: "Close and reopen from a phone.",
      commentCount: 0,
      comments: []
    })
  ]);
  let harness;
  let context;
  try {
    harness = await startHarness(root, fakeMcp);
    const pageHandle = await newPage(browser, harness.baseUrl, { width: 390, height: 844 });
    context = pageHandle.context;
    const page = pageHandle.page;

    await expect(page.locator("#codex-settings-panel")).toBeHidden();
    await expect(page.locator("#runner-settings-button")).toBeVisible();
    await page.locator("#runner-settings-button").click();
    await expect(page.locator("#app-shell")).toHaveClass(/runner-settings-open/);
    await expect(page.locator("#codex-settings-panel")).toBeVisible();
    await assertMobileRunnerPanelInViewport(page);
    await expect(page.locator("#codex-model")).toBeInViewport();
    await expect(page.locator("#codex-settings-save")).toBeInViewport();
    await expect(page.locator("#runner-settings-close-button")).toBeInViewport();
    await page.locator("#codex-model").fill("gpt-5.5");
    await page.locator("#codex-reasoning").selectOption("xhigh");
    await page.locator("#codex-fast-mode").setChecked(true);
    await page.locator("#codex-settings-save").click();
    await expect(page.locator("#toast")).toContainText("Codex settings saved");
    await page.locator("#runner-settings-close-button").click();
    await expect(page.locator("#app-shell")).not.toHaveClass(/runner-settings-open/);

    await page.getByRole("button", { name: "Poll Now" }).click();
    await expect(page.locator(".table-wrap")).toBeHidden();
    await expect(page.locator("#issue-cards")).toBeVisible();
    await expect(card(page, 1)).toBeVisible();
    await expect(card(page, 1)).toContainText("Mobile Close Fixture");
    await expect(card(page, 1)).toContainText("Close and reopen from a phone.");
    await expect(card(page, 1).locator(".status-pill")).toHaveText("open");
    await expect(card(page, 1)).not.toContainText("Hidden Close Reporter");
    await expect(card(page, 1)).not.toContainText("502");
    await expect(card(page, 1).getByRole("button", { name: "Investigate" })).toBeVisible();
    await expect(card(page, 1).getByRole("button", { name: "Close" })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await page.locator("#activity-drawer-button").click();
    await expect(page.locator("#app-shell")).toHaveClass(/activity-open/);
    await expect(page.locator("#activity-drawer-backdrop")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.locator("#activity-close-button").click();
    await expect(page.locator("#app-shell")).not.toHaveClass(/activity-open/);

    await card(page, 1).getByRole("button", { name: "Close" }).click();
    await expect(page.locator("#close-dialog")).toBeVisible();
    await page.locator("#close-comment").fill("This should not be posted from mobile.");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#close-dialog")).toBeHidden();
    assert.equal(fakeMcp.calls.filter(call => call.name === "seerr_add_issue_comment").length, 0);

    await card(page, 1).getByRole("button", { name: "Close" }).click();
    await page.locator("#close-comment").fill("Operator closed this from mobile.");
    await page.getByRole("button", { name: "Close Issue" }).click();
    await expect(page.locator("#close-dialog")).toBeHidden();
    await expect(card(page, 1)).toHaveClass(/issue-closed/);
    await expect(card(page, 1).locator(".status-pill")).toHaveText("closed");
    await expect(card(page, 1).getByRole("button", { name: "View summary" })).toBeVisible();
    await expect(page.locator("#detail-heading")).toHaveText("Issue Summary");
    await expect(page.locator("#detail-band")).toBeVisible();
    await assertMobileDetailSheet(page);
    await assertNoHorizontalOverflow(page);

    await page.locator("#reopen-button").click();
    await expect(card(page, 1)).not.toHaveClass(/issue-closed/);
    await expect(card(page, 1).locator(".status-pill")).toHaveText("open");
    await expect(card(page, 1).getByRole("button", { name: "Investigate" })).toBeVisible();
    await expect(card(page, 1).getByRole("button", { name: "Close" })).toBeVisible();
    assert.ok(fakeMcp.calls.some(call => call.name === "seerr_add_issue_comment" && call.args.issueId === 502 && call.args.message === "Re-opened issue."));
  } finally {
    await context?.close();
    await harness?.close();
    await fakeMcp.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testMobileDetailSheetAndJobControls(browser) {
  const root = await tempDir();
  const fakeMcp = await startFakeMediaMcp([mediaIssue(601, {
    updatedAt: "2026-01-10T00:00:00Z",
    reporter: "Hidden Sheet Reporter",
    mediaTitle: "Mobile Detail Fixture",
    message: "Investigate this on a small screen."
  })]);
  let harness;
  let context;
  try {
    harness = await startHarness(root, fakeMcp);
    const pageHandle = await newPage(browser, harness.baseUrl, { width: 375, height: 667 });
    context = pageHandle.context;
    const page = pageHandle.page;

    await page.getByRole("button", { name: "Poll Now" }).click();
    await expect(page.locator(".table-wrap")).toBeHidden();
    await expect(card(page, 1)).toContainText("Mobile Detail Fixture");
    await card(page, 1).getByRole("button", { name: "Investigate" }).click();
    await expect(page.locator("#detail-processing")).toContainText("Investigating");
    await expect(page.locator("#detail-band")).toHaveClass(/processing/);
    await expect(page.locator("#investigation-output")).toContainText("Action summary");
    await expect(page.locator("#investigation-output")).toContainText("Repair prompt preview");
    await expect(card(page, 1)).toHaveClass(/issue-active/);
    await assertMobileDetailSheet(page);
    await assertNoHorizontalOverflow(page);
    assert.equal(await codexInvocationCount(harness.codexLogPath), 1);

    await page.locator("#detail-close-button").click();
    await expect(page.locator("#detail-band")).toBeHidden();
    await expect(card(page, 1)).not.toHaveClass(/issue-active/);
    await expect(card(page, 1).getByRole("button", { name: "Re-investigate" })).toBeVisible();

    await card(page, 1).getByRole("button", { name: "Re-investigate" }).click();
    await expect(page.locator("#investigation-output")).toContainText("Action summary");
    assert.equal(await codexInvocationCount(harness.codexLogPath), 2);
    await page.locator("#steer-input").fill("Treat this as a client-side app issue with no server-side action.");
    await page.locator("#steer-button").click();
    await expect(page.locator("#investigation-output")).toContainText("No server-side repair will run");
    await expect(page.locator("#approval-actions")).toBeVisible();
    await page.locator("#approve-button").click();
    await expect(page.locator("#investigation-output")).toContainText("Draft resolution comment");
    await expect(page.locator("#approval-actions")).toBeVisible();

    await page.locator("#detail-close-button").click();
    await page.locator("#activity-drawer-button").click();
    await expect(page.locator("#app-shell")).toHaveClass(/activity-open/);
    await page.locator(".job-row").first().click();
    await expect(page.locator("#app-shell")).not.toHaveClass(/activity-open/);
    await expect(page.locator("#detail-band")).toBeVisible();
    await expect(page.locator("#investigation-output")).toContainText("Draft resolution comment");
    await assertMobileDetailSheet(page);
  } finally {
    await context?.close();
    await harness?.close();
    await fakeMcp.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testMobileSeededApprovalRejectAndRetryControls(browser) {
  const root = await tempDir();
  const fakeMcp = await startFakeMediaMcp([]);
  let harness;
  let context;
  try {
    harness = await startHarness(root, fakeMcp);
    const dbPath = harness.config.dbPath;
    await initDb(dbPath);

    const rejectJob = ensureJob(dbPath, "seerr", "mobile-reject");
    transitionJob(dbPath, rejectJob.id, "detected", "awaiting_action_approval");
    upsertInvestigation(dbPath, rejectJob.id, { status: "ready", summary: "Mobile reject approval summary.", evidence: {} });
    createApproval(dbPath, rejectJob.id, "action", {
      source: "seerr",
      issueId: "mobile-reject",
      summary: "Mobile reject approval summary.",
      evidence: {},
      plan: {
        classification: "client_side",
        executionMode: "none",
        actions: [],
        requiresServerAction: false,
        actionSummary: {
          headline: "No server-side repair will run",
          bullets: ["Reject this fixture from the mobile sheet."]
        }
      }
    });

    const approveJob = ensureJob(dbPath, "seerr", "mobile-approve");
    transitionJob(dbPath, approveJob.id, "detected", "awaiting_action_approval");
    upsertInvestigation(dbPath, approveJob.id, { status: "ready", summary: "Mobile approve approval summary.", evidence: {} });
    createApproval(dbPath, approveJob.id, "action", {
      source: "seerr",
      issueId: "mobile-approve",
      summary: "Mobile approve approval summary.",
      evidence: {},
      plan: {
        classification: "client_side",
        executionMode: "none",
        actions: [],
        requiresServerAction: false,
        actionSummary: {
          headline: "No server-side repair will run",
          bullets: ["Approve this fixture from the mobile sheet."]
        }
      }
    });

    const retryJob = ensureJob(dbPath, "seerr", "mobile-retry");
    transitionJob(dbPath, retryJob.id, "detected", "failed_retryable", "Previous autonomous repair needs another attempt.");
    upsertInvestigation(dbPath, retryJob.id, { status: "ready", summary: "Mobile retry approval summary.", evidence: {} });
    createApproval(dbPath, retryJob.id, "action", {
      source: "seerr",
      issueId: "mobile-retry",
      summary: "Mobile retry approval summary.",
      evidence: {},
      plan: {
        classification: "server_action",
        executionMode: "approved_repair_agent",
        actions: [],
        requiresServerAction: true,
        repairPrompt: "Retry this synthetic repair with the operator note.",
        actionSummary: {
          headline: "Run autonomous media repair for mobile retry",
          bullets: ["Retry this fixture from the mobile sheet."]
        }
      }
    });
    setPendingApprovals(dbPath, retryJob.id, "approved", "fixture", "action");

    const pageHandle = await newPage(browser, harness.baseUrl, { width: 390, height: 844 });
    context = pageHandle.context;
    const page = pageHandle.page;

    await page.locator("#activity-drawer-button").click();
    await expect(page.locator("#app-shell")).toHaveClass(/activity-open/);
    await page.locator(`[data-job-id="${rejectJob.id}"]`).click();
    await expect(page.locator("#app-shell")).not.toHaveClass(/activity-open/);
    await expect(page.locator("#approval-actions")).toBeVisible();
    await expect(page.locator("#reject-button")).toBeVisible();
    await page.locator("#reject-button").click();
    await expect(page.locator("#investigation-output")).toContainText("Needs human");
    await expect(page.locator("#approval-actions")).toBeHidden();
    await assertMobileDetailSheet(page);

    await page.locator("#detail-close-button").click();
    await page.locator("#activity-drawer-button").click();
    await page.locator(`[data-job-id="${approveJob.id}"]`).click();
    await expect(page.locator("#approval-actions")).toBeVisible();
    await expect(page.locator("#approve-button")).toBeVisible();
    await page.locator("#approve-button").click();
    await expect(page.locator("#investigation-output")).toContainText("Draft resolution comment");
    await expect(page.locator("#approval-actions")).toBeVisible();

    await page.locator("#detail-close-button").click();
    await page.locator("#activity-drawer-button").click();
    await page.locator(`[data-job-id="${retryJob.id}"]`).click();
    await expect(page.locator("#repair-retry-panel")).toBeHidden();
    await expect(page.locator("#steer-panel")).toBeVisible();
    await expect(page.locator("#retry-same-repair-button")).toBeVisible();
    await page.locator("#steer-input").fill("Revise the failed mobile repair plan.");
    await expect(page.locator("#steer-button")).toBeEnabled();
    await assertMobileDetailSheet(page);
    await assertNoHorizontalOverflow(page);
  } finally {
    await context?.close();
    await harness?.close();
    await fakeMcp.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function run() {
  const browser = await chromium.launch();
  try {
    await testIssueStateActionMatrix(browser);
    await testJobListRowsDoNotOverlap(browser);
    await testFullBrowserWorkflow(browser);
    await testManualCloseReopenBrowser(browser);
    await testExecutingRepairStatusRendersFromIssueQueue(browser);
    await testAbortBecomesAvailableDuringApprovalExecution(browser);
    await testDiagnosticLogDownloadDialog(browser);
    await testMobileTriageLayoutAndManualActions(browser);
    await testMobileDetailSheetAndJobControls(browser);
    await testMobileSeededApprovalRejectAndRetryControls(browser);
  } finally {
    await browser.close();
  }
  console.log("media-issue-agent Web E2E tests passed");
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
