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
  ensureJob,
  initDb,
  insertSnapshot,
  setPendingApprovals,
  transitionJob,
  upsertInvestigation
} from "../src/db.js";
import { issueTableMarkdown } from "../src/issues.js";
import { startWebServer } from "../src/web.js";
import { closeServer, createCodexHome, jsonRpcError, jsonRpcResult, readBody } from "./helpers.js";

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
    "appendFileSync(process.env.WEB_E2E_CODEX_LOG, `${JSON.stringify({ kind })}\\n`);",
    "if (kind === 'comment-draft') {",
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

async function startHarness(root, fakeMcp) {
  const codexHome = await createCodexHome(root);
  const codexLogPath = path.join(root, "codex-invocations.jsonl");
  const codexBin = await createFakeCodexBin(root, codexLogPath);
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

async function newPage(browser, baseUrl) {
  const context = await browser.newContext({
    httpCredentials: {
      username: WEB_USERNAME,
      password: WEB_PASSWORD
    }
  });
  const page = await context.newPage();
  await page.goto(baseUrl);
  await expect(page.locator("#auth-heading")).toHaveText("ChatGPT Connected");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  return { context, page };
}

function row(page, index) {
  return page.locator(`tr[data-entry-index="${index}"]`);
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
      { source: "seerr", issueId: "205", date: "2026-01-05T00:00:00Z", reporter: "Fixture", mediaTitle: "Closed", status: "open", description: "Closed issue" }
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
    upsertInvestigation(dbPath, closed.id, { status: "ready", summary: "Closed summary", evidence: {} });

    const pageHandle = await newPage(browser, harness.baseUrl);
    context = pageHandle.context;
    const page = pageHandle.page;
    await expect(row(page, 1).getByRole("button", { name: "Investigate" })).toBeVisible();
    await expect(row(page, 1).getByRole("button", { name: "Close" })).toBeVisible();
    await expect(row(page, 2).getByRole("button", { name: "Re-investigate" })).toBeVisible();
    await expect(row(page, 2).getByRole("button", { name: "Close" })).toBeVisible();
    await expect(row(page, 3).getByRole("button", { name: "Open job" })).toBeVisible();
    await expect(row(page, 3).getByRole("button", { name: "Close" })).toBeVisible();
    await expect(row(page, 4).getByRole("button", { name: "Open job" })).toBeVisible();
    await expect(row(page, 4).getByRole("button", { name: "Close" })).toBeVisible();
    await expect(row(page, 5).getByRole("button", { name: "View summary" })).toBeVisible();
    await expect(row(page, 5).getByRole("button", { name: "Close" })).toHaveCount(0);
    await expect(row(page, 5)).toHaveClass(/issue-closed/);

    await row(page, 3).getByRole("button", { name: "Open job" }).click();
    await expect(page.locator("#detail-heading")).toHaveText("Job Detail");
    await expect(row(page, 3)).toHaveClass(/issue-active/);
    await expect(page.locator("#investigation-output")).toContainText("Job");
    await expect(page.locator("#investigation-output")).toContainText("Approved");
    await expect(page.locator("#continue-button")).toBeVisible();
    await expect(page.locator("#investigation-output")).not.toContainText("Cannot transition");

    await row(page, 4).getByRole("button", { name: "Open job" }).click();
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
    await expect(page.locator(".job-row")).toHaveCount(16);

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

    await expect(page.locator("#codex-settings-panel")).toBeVisible();
    await page.locator("#codex-model").fill("gpt-5");
    await page.locator("#codex-reasoning").selectOption("high");
    await page.locator("#codex-fast-mode").setChecked(false);
    await page.locator("#codex-service-tier").fill("");
    await page.locator("#codex-repair-context").fill("Prefer exact IDs in browser tests.");
    await page.locator("#codex-settings-save").click();
    await expect(page.locator("#toast")).toContainText("Codex settings saved");
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(page.locator("#codex-model")).toHaveValue("gpt-5");
    await expect(page.locator("#codex-reasoning")).toHaveValue("high");
    await expect(page.locator("#codex-fast-mode")).not.toBeChecked();
    await expect(page.locator("#codex-repair-context")).toHaveValue("Prefer exact IDs in browser tests.");

    await page.getByRole("button", { name: "Poll Now" }).click();
    await expect(row(page, 1)).toContainText("Browser Flow Fixture");
    await expect(row(page, 1).getByRole("button", { name: "Investigate" })).toBeVisible();
    await expect(row(page, 1).getByRole("button", { name: "Close" })).toBeVisible();

    await row(page, 1).getByRole("button", { name: "Investigate" }).click();
    await expect(page.locator("#detail-processing")).toBeVisible();
    await expect(page.locator("#detail-processing")).toContainText("Investigating");
    await expect(page.locator("#detail-band")).toHaveClass(/processing/);
    await expect(page.locator("#investigation-output")).toContainText("Investigation summary");
    await expect(page.locator("#detail-processing")).toBeHidden();
    await expect(page.locator("#approval-actions")).toBeVisible();
    assert.equal(await codexInvocationCount(harness.codexLogPath), 1);

    await expect(row(page, 1).getByRole("button", { name: "Re-investigate" })).toBeVisible();
    await row(page, 1).getByRole("button", { name: "Re-investigate" }).click();
    await expect(page.locator("#investigation-output")).toContainText("Investigation summary");
    assert.equal(await codexInvocationCount(harness.codexLogPath), 2);

    await page.locator("#steer-input").fill("Treat this as a client-side app issue with no server-side action.");
    await page.locator("#steer-button").click();
    await expect(page.locator("#investigation-output")).toContainText("Revised investigation");
    await expect(page.locator("#investigation-output")).toContainText("Pending action approval");
    assert.equal(await codexInvocationCount(harness.codexLogPath), 3);

    await page.locator("#approve-button").click();
    await expect(page.locator("#investigation-output")).toContainText("Approve fix");
    await expect(page.locator("#investigation-output")).toContainText("Draft resolution comment");
    await expect(page.locator("#approval-actions")).toBeVisible();
    assert.equal(await codexInvocationCount(harness.codexLogPath), 4);

    await expect(row(page, 1).getByRole("button", { name: "Open job" })).toBeVisible();
    await row(page, 1).getByRole("button", { name: "Open job" }).click();
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

    await row(page, 1).getByRole("button", { name: "View summary" }).click();
    await expect(page.locator("#reopen-button")).toBeVisible();
    await page.locator("#reopen-button").click();
    await expect(row(page, 1)).not.toHaveClass(/issue-closed/);
    await expect(row(page, 1).getByRole("button", { name: "Re-investigate" })).toBeVisible();

    await row(page, 1).getByRole("button", { name: "Re-investigate" }).click();
    await expect(page.locator("#investigation-output")).toContainText("Investigation summary");
    assert.equal(await codexInvocationCount(harness.codexLogPath), 5);
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

async function run() {
  const browser = await chromium.launch();
  try {
    await testIssueStateActionMatrix(browser);
    await testJobListRowsDoNotOverlap(browser);
    await testFullBrowserWorkflow(browser);
    await testManualCloseReopenBrowser(browser);
  } finally {
    await browser.close();
  }
  console.log("media-issue-agent Web E2E tests passed");
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
