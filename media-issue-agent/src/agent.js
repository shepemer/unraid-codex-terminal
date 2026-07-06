import { MediaMcpClient } from "./mcp-client.js";
import { issueQueue, issueTableMarkdown } from "./issues.js";
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
  setJobState,
  snapshotEntries,
  snapshotEntry,
  statusSummary,
  supersedePendingApprovals,
  transitionJob,
  upsertInvestigation
} from "./db.js";
import { commentDraftPrompt, investigationPrompt, runCodex, steeredInvestigationPrompt } from "./codex.js";
import { inspectCodexAuth, validateCodexHome } from "./config.js";
import { AUTOMATED_SUFFIX, CLOSED_MARKER, REOPENED_MARKER, countCharacters, validateDraftComment } from "./comments.js";
import { redactText, sanitizeValue } from "./redact.js";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function textSuggestsClientSide(...values) {
  const text = values.join(" ").toLowerCase();
  return /\b(client|device|app|browser|network|wifi|user-side|user side|client-side|client side)\b/.test(text)
    || /\bno server(?:-side| side)? action\b/.test(text)
    || /\bno automated (?:server )?(?:fix|action)\b/.test(text);
}

function fallbackDraftComment(source, executionResult = null) {
  const outcome = executionResult?.outcome || "";
  if (source === "plex") {
    if (outcome === "client_side") {
      return `Reviewed this report as client-side. ${AUTOMATED_SUFFIX}`;
    }
    return `Reviewed this report and completed follow-up. ${AUTOMATED_SUFFIX}`;
  }
  if (outcome === "client_side") {
    return `Reviewed this report as a client-side playback issue. No server-side media action was applied.\n${AUTOMATED_SUFFIX}`;
  }
  return `Reviewed this report and completed the approved follow-up for the media item.\n${AUTOMATED_SUFFIX}`;
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

function buildPlan(entry, evidence, summary, operatorMessage = "") {
  const clientSide = textSuggestsClientSide(summary, operatorMessage);
  const actions = [];
  return {
    source: entry.source,
    issueId: entry.issueId,
    summary,
    plan: {
      classification: clientSide ? "client_side" : "no_supported_server_action",
      actions,
      requiresServerAction: actions.length > 0,
      note: clientSide
        ? "Determination is client-side or no server-side action is required."
        : "No exact allowlisted server-side repair action is available for this issue yet."
    },
    evidence
  };
}

function closeActionsFor(source, issueId, message) {
  if (source === "plex") {
    return [
      { toolName: "plex_add_reported_issue_comment", args: { issueId: String(issueId), message, dryRun: false, verbose: false } },
      { toolName: "plex_add_reported_issue_comment", args: { issueId: String(issueId), message: "Closed.", dryRun: false, verbose: false } }
    ];
  }
  if (source === "seerr") {
    return [
      { toolName: "seerr_add_issue_comment", args: { issueId: Number(issueId), message, dryRun: false, verbose: false } },
      { toolName: "seerr_add_issue_comment", args: { issueId: Number(issueId), message: "Closed.", dryRun: false, verbose: false } },
      { toolName: "seerr_resolve_issue", args: { issueId: Number(issueId), dryRun: false, verbose: false } }
    ];
  }
  throw new Error(`Unsupported issue source ${source}`);
}

function directCloseActionsFor(source, issueId, comment = "") {
  const trimmed = String(comment || "").trim();
  if (source === "plex") {
    return [
      ...(trimmed ? [{ toolName: "plex_add_reported_issue_comment", args: { issueId: String(issueId), message: trimmed, dryRun: false, verbose: false } }] : []),
      { toolName: "plex_add_reported_issue_comment", args: { issueId: String(issueId), message: CLOSED_MARKER, dryRun: false, verbose: false } }
    ];
  }
  if (source === "seerr") {
    return [
      ...(trimmed ? [{ toolName: "seerr_add_issue_comment", args: { issueId: Number(issueId), message: trimmed, dryRun: false, verbose: false } }] : []),
      { toolName: "seerr_add_issue_comment", args: { issueId: Number(issueId), message: CLOSED_MARKER, dryRun: false, verbose: false } },
      { toolName: "seerr_resolve_issue", args: { issueId: Number(issueId), dryRun: false, verbose: false } }
    ];
  }
  throw new Error(`Unsupported issue source ${source}`);
}

function reopenActionsFor(source, issueId) {
  if (source === "plex") {
    return [
      { toolName: "plex_add_reported_issue_comment", args: { issueId: String(issueId), message: REOPENED_MARKER, dryRun: false, verbose: false } }
    ];
  }
  if (source === "seerr") {
    return [
      { toolName: "seerr_add_issue_comment", args: { issueId: Number(issueId), message: REOPENED_MARKER, dryRun: false, verbose: false } },
      { toolName: "seerr_reopen_issue", args: { issueId: Number(issueId), dryRun: false, verbose: false } }
    ];
  }
  throw new Error(`Unsupported issue source ${source}`);
}

function validateOperatorComment(source, comment) {
  const trimmed = String(comment || "").trim();
  if (source === "plex" && countCharacters(trimmed) > 300) {
    throw new Error(`Plex-native comments must be 300 characters or fewer; got ${countCharacters(trimmed)}.`);
  }
  return trimmed;
}

function commentsFromDetails(details) {
  const issue = details?.issue || details || {};
  return Array.isArray(issue.comments) ? issue.comments : [];
}

function entryIsClosed(entry) {
  const status = String(entry?.status || "").toLowerCase();
  return Boolean(entry?.raw?.isClosed)
    || entry?.jobState === "closed"
    || status === "closed"
    || status === "resolved"
    || status.includes("closed")
    || status.includes("resolved");
}

function supersedeAllPendingApprovals(dbPath, jobId) {
  supersedePendingApprovals(dbPath, jobId, "action");
  supersedePendingApprovals(dbPath, jobId, "resolution");
}

function commentSummary(comments) {
  if (!comments.length) {
    return "No comments are available from the issue source.";
  }
  return comments.slice(-8).map(comment => {
    const date = comment.createdAt || comment.updatedAt || comment.date || "unknown time";
    const message = String(comment.message || "").trim() || "(empty comment)";
    return `- ${date}: ${message}`;
  }).join("\n");
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
      status: "all",
      source: "all",
      take: 100,
      skip: 0,
      verbose: false
    });
    const records = Array.isArray(listed?.records) ? listed.records : [];
    const issues = await issueQueue(records, this.client);
    const markdown = issueTableMarkdown(issues);
    const snapshot = insertSnapshot(this.config.dbPath, markdown, issues);
    for (const issue of issues) {
      const job = ensureJob(this.config.dbPath, issue.source, issue.issueId);
      if (issue.isClosed && job.state !== "closed") {
        setJobState(this.config.dbPath, job.id, "closed");
      } else if (!issue.isClosed && job.state === "closed") {
        setJobState(this.config.dbPath, job.id, "detected");
      }
      recordAudit(this.config.dbPath, "issue_seen", sanitizeValue(issue), job.id);
    }
    return {
      snapshotId: snapshot.id,
      issueCount: issues.length,
      openIssueCount: issues.filter(issue => !issue.isClosed).length,
      closedIssueCount: issues.filter(issue => issue.isClosed).length,
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

  async issueSummary(snapshotId, index) {
    await this.init();
    const entry = snapshotEntry(this.config.dbPath, snapshotId, index);
    if (!entry) {
      throw new Error(`Snapshot ${snapshotId} index ${index} was not found`);
    }
    const details = await this.client.callTool("plex_issue_details", {
      source: entry.source,
      issueId: entry.issueId,
      verbose: false
    });
    const comments = commentsFromDetails(details);
    const jobDetail = entry.jobId ? readJobDetails(this.config.dbPath, entry.jobId) : null;
    const significantAudit = (jobDetail?.auditEvents || []).filter(event => event.eventType !== "issue_seen");
    const hasLocalHistory = Boolean(jobDetail?.investigation)
      || Boolean(jobDetail?.plannedActions?.length)
      || Boolean(jobDetail?.approvals?.length)
      || significantAudit.length > 0;
    const lines = [
      `${entry.source} issue ${entry.issueId}`,
      `Status: ${entry.status || "unknown"}`,
      `Media/title: ${entry.mediaTitle || "(unknown)"}`,
      `Reporter: ${entry.reporter || "(unknown)"}`
    ];
    if (hasLocalHistory) {
      lines.push("", "Local workflow history:");
      if (jobDetail?.job) {
        lines.push(`- Job ${jobDetail.job.id}: ${jobDetail.job.state}`);
      }
      if (jobDetail?.investigation?.summary) {
        lines.push("", "Investigation:", jobDetail.investigation.summary);
      }
      if (jobDetail?.plannedActions?.length) {
        lines.push("", "Actions:");
        for (const action of jobDetail.plannedActions.slice(0, 8)) {
          lines.push(`- ${action.toolName}: ${action.executedAt ? "executed" : "planned"}`);
        }
      }
      if (significantAudit.length) {
        lines.push("", "Recent activity:");
        for (const event of significantAudit.slice(0, 8)) {
          lines.push(`- ${event.createdAt} ${event.eventType}`);
        }
      }
    } else {
      lines.push("", "No local workflow history exists. Summary derived from issue comments:", commentSummary(comments));
    }
    return {
      snapshotId,
      index,
      issue: sanitizeValue(entry),
      closed: entryIsClosed(entry),
      summary: lines.join("\n")
    };
  }

  async runIssueActions(jobId, actions, auditPrefix, actor) {
    const results = [];
    for (const action of actions) {
      const planned = createPlannedAction(this.config.dbPath, jobId, action.toolName, action.args, auditPrefix);
      recordAudit(this.config.dbPath, `${auditPrefix}_action_started`, sanitizeValue({ actor, action: planned }), jobId);
      const result = await this.client.callTool(action.toolName, action.args);
      const sanitized = sanitizeValue(result);
      markPlannedActionExecuted(this.config.dbPath, planned.id, sanitized, false);
      results.push({ action: planned, result: sanitized });
    }
    return results;
  }

  async closeIssue(snapshotId, index, comment = "", actor = "operator") {
    await this.init();
    const entry = snapshotEntry(this.config.dbPath, snapshotId, index);
    if (!entry) {
      throw new Error(`Snapshot ${snapshotId} index ${index} was not found`);
    }
    if (entryIsClosed(entry)) {
      throw new Error(`Issue ${entry.source} ${entry.issueId} is already closed`);
    }
    const message = validateOperatorComment(entry.source, comment);
    const job = ensureJob(this.config.dbPath, entry.source, entry.issueId);
    supersedeAllPendingApprovals(this.config.dbPath, job.id);
    recordAudit(this.config.dbPath, "direct_close_requested", sanitizeValue({ actor, commentProvided: Boolean(message) }), job.id);
    try {
      const results = await this.runIssueActions(job.id, directCloseActionsFor(entry.source, entry.issueId, message), "direct_close", actor);
      setJobState(this.config.dbPath, job.id, "closed");
      recordAudit(this.config.dbPath, "direct_close_completed", sanitizeValue({ actor, results }), job.id);
      return {
        jobId: job.id,
        status: "closed",
        results
      };
    } catch (error) {
      const messageText = redactText(error.message);
      setJobState(this.config.dbPath, job.id, "failed_retryable", messageText);
      recordAudit(this.config.dbPath, "direct_close_failed", sanitizeValue({ actor, error: error.message }), job.id);
      throw error;
    }
  }

  async reopenIssue(snapshotId, index, actor = "operator") {
    await this.init();
    const entry = snapshotEntry(this.config.dbPath, snapshotId, index);
    if (!entry) {
      throw new Error(`Snapshot ${snapshotId} index ${index} was not found`);
    }
    if (!entryIsClosed(entry)) {
      throw new Error(`Issue ${entry.source} ${entry.issueId} is already open`);
    }
    const job = ensureJob(this.config.dbPath, entry.source, entry.issueId);
    supersedeAllPendingApprovals(this.config.dbPath, job.id);
    recordAudit(this.config.dbPath, "reopen_requested", sanitizeValue({ actor }), job.id);
    try {
      const results = await this.runIssueActions(job.id, reopenActionsFor(entry.source, entry.issueId), "reopen", actor);
      setJobState(this.config.dbPath, job.id, "detected");
      recordAudit(this.config.dbPath, "reopen_completed", sanitizeValue({ actor, results }), job.id);
      return {
        jobId: job.id,
        status: "open",
        results
      };
    } catch (error) {
      const messageText = redactText(error.message);
      setJobState(this.config.dbPath, job.id, "failed_retryable", messageText);
      recordAudit(this.config.dbPath, "reopen_failed", sanitizeValue({ actor, error: error.message }), job.id);
      throw error;
    }
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
    const approvalPayload = buildPlan(entry, evidence, summary);
    const approval = createApproval(this.config.dbPath, job.id, "action", approvalPayload);
    recordAudit(this.config.dbPath, "investigation_ready", sanitizeValue({ approval, summary }), job.id);
    return { jobId: job.id, approvalId: approval.id, summary, evidence, status: investigation.status, cached: false };
  }

  async steerInvestigation(jobId, message, actor = "operator") {
    await this.init();
    const job = jobForId(this.config.dbPath, jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found`);
    }
    const current = investigationForJob(this.config.dbPath, jobId);
    if (!current) {
      throw new Error(`Job ${jobId} has no investigation to steer`);
    }
    const operatorMessage = String(message || "").trim();
    if (!operatorMessage) {
      throw new Error("Steering message is required");
    }
    const allowedStates = new Set([
      "awaiting_action_approval",
      "failed_retryable",
      "blocked_needs_human"
    ]);
    if (!allowedStates.has(job.state)) {
      throw new Error(`Cannot transition job ${jobId} from ${job.state} to investigating`);
    }
    await validateCodexHome(this.config.codexHome);
    transitionJob(this.config.dbPath, jobId, [
      "awaiting_action_approval",
      "failed_retryable",
      "blocked_needs_human"
    ], "investigating");
    supersedePendingApprovals(this.config.dbPath, jobId, "action");
    recordAudit(this.config.dbPath, "operator_steered_investigation", sanitizeValue({ actor, message: operatorMessage }), jobId);
    const evidence = sanitizeValue({
      ...current.evidence,
      steering: {
        actor,
        message: operatorMessage,
        previousSummary: current.summary
      }
    });
    let summary;
    try {
      summary = await runCodex(this.config, steeredInvestigationPrompt(evidence, current.summary, operatorMessage));
    } catch (error) {
      const reason = redactText(error.message);
      summary = [
        current.summary,
        "",
        "Operator steering was recorded, but Codex could not revise the summary automatically.",
        `Reason: ${reason}`,
        `Steering note: ${operatorMessage}`
      ].join("\n");
      recordAudit(this.config.dbPath, "codex_steered_investigation_failed", sanitizeValue({ error: error.message }), jobId);
    }
    const investigation = upsertInvestigation(this.config.dbPath, jobId, {
      status: "ready",
      summary,
      evidence
    });
    transitionJob(this.config.dbPath, jobId, ["investigating"], "awaiting_action_approval");
    const approval = createApproval(this.config.dbPath, jobId, "action", buildPlan(job, evidence, summary, operatorMessage));
    recordAudit(this.config.dbPath, "steered_investigation_ready", sanitizeValue({ approval, summary }), jobId);
    return {
      jobId,
      approvalId: approval.id,
      approvalKind: "action",
      summary,
      evidence,
      status: investigation.status
    };
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
    if (pending.kind === "resolution") {
      return this.closeApprovedIssue(jobId, pending, actor, approvals);
    }
    throw new Error(`Unsupported approval kind ${pending.kind}`);
  }

  reject(jobId, actor = "operator") {
    const pending = pendingApprovalForJobAnyKind(this.config.dbPath, jobId);
    const approvals = setPendingApprovals(this.config.dbPath, jobId, "rejected", actor, pending?.kind || null);
    transitionJob(this.config.dbPath, jobId, ["awaiting_action_approval", "awaiting_comment_approval", "awaiting_resolution_approval"], "blocked_needs_human");
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
    return this.executeApprovedPlan(jobId, actor, context);
  }

  async executeApprovedPlan(jobId, actor, context = {}) {
    const details = this.jobDetails(jobId);
    const actionApproval = details.approvals.find(approval => approval.kind === "action" && approval.status === "approved");
    if (!actionApproval) {
      throw new Error(`Job ${jobId} has no approved action plan`);
    }
    transitionJob(this.config.dbPath, jobId, ["approved_for_execution"], "executing");
    recordAudit(this.config.dbPath, "execution_started", sanitizeValue({ actor, plan: actionApproval.payload.plan }), jobId);
    const actions = Array.isArray(actionApproval.payload?.plan?.actions) ? actionApproval.payload.plan.actions : [];
    const executionResult = {
      outcome: actionApproval.payload?.plan?.classification === "client_side" ? "client_side" : "no_supported_action",
      summary: actionApproval.payload?.plan?.classification === "client_side"
        ? "Determination was client-side or no server-side action was required. No server-side media action was executed."
        : "No exact allowlisted server-side repair action is available for this issue yet. No media action was executed.",
      actionsRequested: actions.length,
      actionsExecuted: 0,
      actions: []
    };
    if (actions.length) {
      executionResult.outcome = "unsupported_actions";
      executionResult.summary = "The approved plan contained actions, but none are on the media issue agent execution allowlist yet. No media action was executed.";
      executionResult.actions = actions.map(action => ({
        requested: action,
        status: "not_executed",
        reason: "unsupported action for media issue agent v1"
      }));
    }
    recordAudit(this.config.dbPath, "execution_completed", sanitizeValue(executionResult), jobId);
    transitionJob(this.config.dbPath, jobId, ["executing"], "drafting_comment");
    return this.draftResolutionApproval(jobId, actor, executionResult, context);
  }

  async draftResolutionApproval(jobId, actor, executionResult, context = {}) {
    await validateCodexHome(this.config.codexHome);
    const details = this.jobDetails(jobId);
    if (!details.investigation) {
      throw new Error(`Job ${jobId} has no investigation to draft from`);
    }
    const evidence = sanitizeValue({
      job: details.job,
      investigation: details.investigation,
      executionResult,
      approvedBy: actor
    });
    let draft;
    try {
      draft = await runCodex(this.config, commentDraftPrompt(evidence));
    } catch (error) {
      recordAudit(this.config.dbPath, "codex_comment_draft_failed", sanitizeValue({ error: error.message }), jobId);
      draft = fallbackDraftComment(details.job.source, executionResult);
    }
    const message = normalizeDraftComment(details.job.source, draft);
    const validation = validateDraftComment(details.job.source, message);
    if (!validation.valid) {
      transitionJob(this.config.dbPath, jobId, ["drafting_comment"], "failed_retryable", validation.errors.join("; "));
      throw new Error(`Draft comment failed validation: ${validation.errors.join("; ")}`);
    }
    const approval = createApproval(this.config.dbPath, jobId, "resolution", {
      source: details.job.source,
      issueId: details.job.issueId,
      message,
      characterCount: validation.characterCount,
      executionResult
    });
    transitionJob(this.config.dbPath, jobId, ["drafting_comment"], "awaiting_resolution_approval");
    recordAudit(this.config.dbPath, "resolution_draft_ready", sanitizeValue({ approval, characterCount: validation.characterCount, executionResult }), jobId);
    return {
      ...context,
      jobId,
      status: "awaiting_resolution_approval",
      approvalId: approval.id,
      approvalKind: "resolution",
      message,
      executionResult
    };
  }

  async closeApprovedIssue(jobId, approval, actor, approvals) {
    transitionJob(this.config.dbPath, jobId, ["awaiting_resolution_approval"], "closing_issue");
    const { source, issueId, message } = approval.payload;
    const actions = closeActionsFor(source, issueId, message);
    const results = [];
    try {
      for (const action of actions) {
        const planned = createPlannedAction(this.config.dbPath, jobId, action.toolName, action.args, "resolution");
        recordAudit(this.config.dbPath, "closing_action_started", sanitizeValue({ action: planned }), jobId);
        const result = await this.client.callTool(action.toolName, action.args);
        const sanitized = sanitizeValue(result);
        markPlannedActionExecuted(this.config.dbPath, planned.id, sanitized, false);
        results.push({ action: planned, result: sanitized });
      }
      transitionJob(this.config.dbPath, jobId, ["closing_issue"], "closed");
      recordAudit(this.config.dbPath, "issue_closed", sanitizeValue({ actor, results }), jobId);
      return {
        jobId,
        status: "closed",
        approvals,
        results
      };
    } catch (error) {
      const messageText = redactText(error.message);
      transitionJob(this.config.dbPath, jobId, ["closing_issue"], "failed_retryable", messageText);
      recordAudit(this.config.dbPath, "issue_close_failed", sanitizeValue({ actor, error: error.message, results }), jobId);
      throw error;
    }
  }

  async pollLoop(log = console.error) {
    await this.init();
    log("media-issue-agent: starting poll loop");
    for (;;) {
      try {
        const result = await this.pollOnce();
        log(`media-issue-agent: snapshot ${result.snapshotId} recorded with ${result.openIssueCount} open and ${result.closedIssueCount} closed issues`);
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
