import { MediaMcpClient } from "./mcp-client.js";
import { filterOpenIssues, issueTableMarkdown } from "./issues.js";
import {
  createApproval,
  createPlannedAction,
  ensureJob,
  initDb,
  insertSnapshot,
  investigationForJob,
  jobDetails as readJobDetails,
  jobForId,
  latestSnapshot,
  listApprovals,
  listJobs,
  markPlannedActionExecuted,
  pendingApprovalForJob,
  pendingApprovalForJobAnyKind,
  recordAudit,
  setPendingApprovals,
  snapshotEntries,
  snapshotEntry,
  statusSummary,
  supersedePendingApprovals,
  transitionJob,
  upsertInvestigation
} from "./db.js";
import { commentDraftPrompt, investigationPrompt, runCodex } from "./codex.js";
import { inspectCodexAuth, validateCodexHome } from "./config.js";
import { AUTOMATED_SUFFIX, validateDraftComment } from "./comments.js";
import { redactText, sanitizeValue } from "./redact.js";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fallbackDraftComment(source) {
  if (source === "plex") {
    return `Reviewed this report and prepared a follow-up. ${AUTOMATED_SUFFIX}`;
  }
  return `Reviewed this report and prepared a follow-up for the media item.\n${AUTOMATED_SUFFIX}`;
}

function normalizeDraftComment(source, draft) {
  let message = String(draft || "").trim();
  message = message.replace(/^```(?:text|markdown)?\s*/i, "").replace(/```$/i, "").trim();
  if (!message.endsWith(AUTOMATED_SUFFIX)) {
    message = `${message.replace(/\s+$/g, "")}\n${AUTOMATED_SUFFIX}`;
  }
  if (!validateDraftComment(source, message).valid) {
    message = fallbackDraftComment(source);
  }
  return message;
}

function commentToolFor(source, issueId, message, dryRun) {
  if (source === "plex") {
    return {
      toolName: "plex_add_reported_issue_comment",
      args: { issueId: String(issueId), message, dryRun, verbose: false },
      liveTerminalState: "blocked_needs_human",
      liveMessage: "Plex native issue was commented; add the Plex Closed. marker manually if the report is fully resolved."
    };
  }
  if (source === "seerr") {
    return {
      toolName: "seerr_comment_and_resolve_issue",
      args: { issueId: Number(issueId), message, dryRun, verbose: false },
      liveTerminalState: "closed",
      liveMessage: null
    };
  }
  throw new Error(`Unsupported issue source ${source}`);
}

export class MediaIssueAgent {
  constructor(config, client = new MediaMcpClient(config)) {
    this.config = config;
    this.client = client;
  }

  async init() {
    await initDb(this.config.dbPath);
  }

  async pollOnce() {
    await this.init();
    const listed = await this.client.callTool("plex_reported_issues", {
      status: "open",
      source: "all",
      take: 100,
      skip: 0,
      verbose: false
    });
    const records = Array.isArray(listed?.records) ? listed.records : [];
    const openIssues = await filterOpenIssues(records, this.client);
    const markdown = issueTableMarkdown(openIssues);
    const snapshot = insertSnapshot(this.config.dbPath, markdown, openIssues);
    for (const issue of openIssues) {
      const job = ensureJob(this.config.dbPath, issue.source, issue.issueId);
      recordAudit(this.config.dbPath, "issue_seen", sanitizeValue(issue), job.id);
    }
    return {
      snapshotId: snapshot.id,
      issueCount: openIssues.length,
      markdown
    };
  }

  latest() {
    return latestSnapshot(this.config.dbPath);
  }

  latestWithEntries() {
    const snapshot = this.latest();
    if (!snapshot) {
      return null;
    }
    return {
      ...snapshot,
      entries: snapshotEntries(this.config.dbPath, snapshot.id)
    };
  }

  jobs(limit) {
    return listJobs(this.config.dbPath, limit);
  }

  approvals(limit) {
    return listApprovals(this.config.dbPath, limit);
  }

  jobDetails(jobId) {
    const details = readJobDetails(this.config.dbPath, jobId);
    if (!details) {
      throw new Error(`Job ${jobId} was not found`);
    }
    return details;
  }

  status() {
    return {
      ...statusSummary(this.config.dbPath),
      dryRun: this.config.dryRun,
      webEnabled: this.config.webEnabled
    };
  }

  async codexAuthStatus() {
    return inspectCodexAuth(this.config.codexHome);
  }

  async investigate(snapshotId, index, options = {}) {
    await this.init();
    await validateCodexHome(this.config.codexHome);
    const entry = snapshotEntry(this.config.dbPath, snapshotId, index);
    if (!entry) {
      throw new Error(`Snapshot ${snapshotId} index ${index} was not found`);
    }
    const job = ensureJob(this.config.dbPath, entry.source, entry.issueId, "queued_for_investigation");
    const cached = investigationForJob(this.config.dbPath, job.id);
    if (cached && !options.force) {
      const approval = pendingApprovalForJob(this.config.dbPath, job.id);
      return {
        jobId: job.id,
        approvalId: approval?.id || null,
        summary: cached.summary,
        evidence: cached.evidence,
        status: cached.status,
        cached: true
      };
    }
    transitionJob(this.config.dbPath, job.id, [
      "detected",
      "queued_for_investigation",
      "awaiting_action_approval",
      "blocked_needs_human",
      "failed_retryable"
    ], "investigating");
    if (options.force) {
      supersedePendingApprovals(this.config.dbPath, job.id);
    }
    const [details, diagnosis] = await Promise.all([
      this.client.callTool("plex_issue_details", {
        source: entry.source,
        issueId: entry.issueId,
        verbose: false
      }),
      this.client.callTool("media_diagnose_issue", {
        source: entry.source,
        issueId: entry.issueId,
        verbose: false
      })
    ]);
    const evidence = sanitizeValue({ entry, details, diagnosis });
    let summary;
    try {
      summary = await runCodex(this.config, investigationPrompt(evidence));
    } catch (error) {
      const message = redactText(error.message);
      summary = [
        "Codex investigation summary could not be generated automatically.",
        `Reason: ${message}`,
        `Read-only media diagnostics were collected for ${entry.source} issue ${entry.issueId}.`,
        "Re-run the investigation after fixing the Codex error."
      ].join("\n");
      const investigation = upsertInvestigation(this.config.dbPath, job.id, {
        status: "failed",
        summary,
        evidence,
        error: message
      });
      transitionJob(this.config.dbPath, job.id, ["investigating"], "failed_retryable", message);
      recordAudit(this.config.dbPath, "codex_investigation_failed", sanitizeValue({ error: error.message }), job.id);
      return { jobId: job.id, approvalId: null, summary, evidence, status: investigation.status, cached: false, error: message };
    }
    supersedePendingApprovals(this.config.dbPath, job.id);
    const investigation = upsertInvestigation(this.config.dbPath, job.id, {
      status: "ready",
      summary,
      evidence
    });
    transitionJob(this.config.dbPath, job.id, ["investigating"], "awaiting_action_approval");
    const approval = createApproval(this.config.dbPath, job.id, "action", {
      source: entry.source,
      issueId: entry.issueId,
      summary
    });
    recordAudit(this.config.dbPath, "investigation_ready", sanitizeValue({ approval, summary }), job.id);
    return { jobId: job.id, approvalId: approval.id, summary, evidence, status: investigation.status, cached: false };
  }

  async approve(jobId, actor = "operator") {
    const pending = pendingApprovalForJobAnyKind(this.config.dbPath, jobId);
    if (!pending) {
      throw new Error(`Job ${jobId} has no pending approval`);
    }
    const approvals = setPendingApprovals(this.config.dbPath, jobId, "approved", actor, pending.kind);
    recordAudit(this.config.dbPath, "approval_accepted", sanitizeValue({ approvalId: pending.id, kind: pending.kind, actor }), jobId);
    if (pending.kind === "action") {
      transitionJob(this.config.dbPath, jobId, ["awaiting_action_approval"], "approved_for_execution");
      return this.continueJob(jobId, actor, { approvals });
    }
    if (pending.kind === "comment") {
      return this.postApprovedComment(jobId, pending, actor, approvals);
    }
    throw new Error(`Unsupported approval kind ${pending.kind}`);
  }

  reject(jobId, actor = "operator") {
    const pending = pendingApprovalForJobAnyKind(this.config.dbPath, jobId);
    const approvals = setPendingApprovals(this.config.dbPath, jobId, "rejected", actor, pending?.kind || null);
    transitionJob(this.config.dbPath, jobId, ["awaiting_action_approval", "awaiting_comment_approval"], "blocked_needs_human");
    recordAudit(this.config.dbPath, "approval_rejected", sanitizeValue({ approvals, actor }), jobId);
    return approvals;
  }

  async continueJob(jobId, actor = "operator", context = {}) {
    const job = jobForId(this.config.dbPath, jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found`);
    }
    if (job.state !== "approved_for_execution") {
      throw new Error(`Job ${jobId} cannot continue from ${job.state}`);
    }
    return this.draftCommentApproval(jobId, actor, context);
  }

  async draftCommentApproval(jobId, actor, context = {}) {
    await validateCodexHome(this.config.codexHome);
    const details = this.jobDetails(jobId);
    if (!details.investigation) {
      throw new Error(`Job ${jobId} has no investigation to draft from`);
    }
    transitionJob(this.config.dbPath, jobId, ["approved_for_execution"], "drafting_comment");
    const evidence = sanitizeValue({
      job: details.job,
      investigation: details.investigation,
      approvedBy: actor
    });
    let draft;
    try {
      draft = await runCodex(this.config, commentDraftPrompt(evidence));
    } catch (error) {
      recordAudit(this.config.dbPath, "codex_comment_draft_failed", sanitizeValue({ error: error.message }), jobId);
      draft = fallbackDraftComment(details.job.source);
    }
    const message = normalizeDraftComment(details.job.source, draft);
    const validation = validateDraftComment(details.job.source, message);
    if (!validation.valid) {
      transitionJob(this.config.dbPath, jobId, ["drafting_comment"], "failed_retryable", validation.errors.join("; "));
      throw new Error(`Draft comment failed validation: ${validation.errors.join("; ")}`);
    }
    const approval = createApproval(this.config.dbPath, jobId, "comment", {
      source: details.job.source,
      issueId: details.job.issueId,
      message,
      characterCount: validation.characterCount
    });
    transitionJob(this.config.dbPath, jobId, ["drafting_comment"], "awaiting_comment_approval");
    recordAudit(this.config.dbPath, "comment_draft_ready", sanitizeValue({ approval, characterCount: validation.characterCount }), jobId);
    return {
      ...context,
      jobId,
      status: "awaiting_comment_approval",
      approvalId: approval.id,
      approvalKind: "comment",
      message
    };
  }

  async postApprovedComment(jobId, approval, actor, approvals) {
    transitionJob(this.config.dbPath, jobId, ["awaiting_comment_approval"], "posting_comment");
    const { source, issueId, message } = approval.payload;
    const action = commentToolFor(source, issueId, message, this.config.dryRun);
    const planned = createPlannedAction(this.config.dbPath, jobId, action.toolName, action.args, "comment");
    try {
      const result = await this.client.callTool(action.toolName, action.args);
      markPlannedActionExecuted(this.config.dbPath, planned.id, sanitizeValue(result), this.config.dryRun);
      if (this.config.dryRun) {
        transitionJob(this.config.dbPath, jobId, ["posting_comment"], "dry_run_complete");
      } else {
        transitionJob(this.config.dbPath, jobId, ["posting_comment"], action.liveTerminalState, action.liveMessage);
      }
      recordAudit(this.config.dbPath, "comment_posted", sanitizeValue({ actor, dryRun: this.config.dryRun, action: planned, result }), jobId);
      return {
        jobId,
        status: this.config.dryRun ? "dry_run_complete" : action.liveTerminalState,
        approvals,
        dryRun: this.config.dryRun,
        result
      };
    } catch (error) {
      const messageText = redactText(error.message);
      transitionJob(this.config.dbPath, jobId, ["posting_comment"], "failed_retryable", messageText);
      recordAudit(this.config.dbPath, "comment_post_failed", sanitizeValue({ actor, error: error.message, action: planned }), jobId);
      throw error;
    }
  }

  async pollLoop(log = console.error) {
    await this.init();
    log("media-issue-agent: starting poll loop");
    for (;;) {
      try {
        const result = await this.pollOnce();
        log(`media-issue-agent: snapshot ${result.snapshotId} recorded with ${result.issueCount} open issues`);
      } catch (error) {
        log(`media-issue-agent: poll failed: ${error.message}`);
      }
      await sleep(this.config.pollIntervalSeconds * 1000);
    }
  }

  async serve(log = console.error) {
    await this.init();
    if (this.config.webEnabled) {
      const { startWebServer } = await import("./web.js");
      await startWebServer(this, this.config, log);
    }
    await this.pollLoop(log);
  }
}
