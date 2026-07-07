import { MediaMcpClient } from "./mcp-client.js";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { issueLifecycleFromComments, issueQueue, issueTableMarkdown } from "./issues.js";
import {
  completeAgentRun,
  createApproval,
  createAgentRun,
  createPlannedAction,
  ensureJob,
  getSetting,
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
  pruneSnapshots,
  recordAgentRunEvent,
  recordAudit,
  setPendingApprovals,
  setJobState,
  setSetting,
  snapshotEntries,
  snapshotEntry,
  statusSummary,
  supersedePendingApprovals,
  transitionJob,
  upsertInvestigation
} from "./db.js";
import { commentDraftPrompt, investigationPrompt, repairExecutionPrompt, runCodex, runCodexRepair, steeredInvestigationPrompt } from "./codex.js";
import { inspectCodexAuth, validateCodexHome } from "./config.js";
import { AUTOMATED_SUFFIX, CLOSED_MARKER, REOPENED_MARKER, countCharacters, validateDraftComment } from "./comments.js";
import { redactText, sanitizeValue } from "./redact.js";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function textSuggestsClientSide(...values) {
  const text = values.join(" ").toLowerCase();
  return /\bno server(?:-side| side)? (?:action|fix|change|work|repair)(?: is)? (?:required|needed|available)\b/.test(text)
    || /\bno automated (?:server )?(?:fix|action|repair)\b/.test(text)
    || /\b(?:determination|conclusion|classification)\s+(?:is|:)\s+(?:client-side|client side)\b/.test(text)
    || /\b(?:client-side|client side|user-side|user side)\b.{0,120}\b(?:only|no server|without server|not a server)\b/.test(text);
}

function textSuggestsServerSide(...values) {
  const text = values.join(" ").toLowerCase()
    .replace(/\bno server(?:-side| side)? (?:action|fix|change|work|repair)(?: is)? (?:required|needed|available)\b/g, "")
    .replace(/\bno server(?:-side| side)? (?:action|fix|change|work|repair)\b/g, "")
    .replace(/\bno automated (?:server )?(?:fix|action|repair)\b/g, "");
  const squashed = text.replace(/[^a-z0-9]+/g, "");
  return /\b(?:server-side|server side|server)\b.{0,140}\b(?:action|fix|repair|required|needed|provision|download|refresh|analy[sz]e)\b/.test(text)
    || /\b(?:action|fix|repair|required|needed|provision|download|refresh|analy[sz]e)\b.{0,140}\b(?:server-side|server side|server)\b/.test(text)
    || squashed.includes("requiresserveractiontrue")
    || /\bclassification\b.{0,60}\bserver[_ -]?side\b/.test(text)
    || /\b(?:bazarr|managed subtitle|subtitle workflow)\b/.test(text);
}

function buildRepairPrompt(entry, evidence, summary, operatorMessage = "") {
  const effectiveEntry = evidence?.entry || entry || {};
  const approvedPlan = {
    source: effectiveEntry.source,
    issueId: effectiveEntry.issueId,
    summary,
    operatorMessage,
    instructions: [
      "Use media-mcp directly through the configured Codex MCP server named media.",
      "Investigate, repair, and verify the approved issue as far as the available media tools allow.",
      "Choose the media tools that fit the evidence instead of relying on a predefined repair action list.",
      "Do not delegate media-side work back to the server owner/operator.",
      "Do not post reporter comments or close the issue; media-issue-agent will request final human approval for that."
    ]
  };
  return repairExecutionPrompt({
    entry: effectiveEntry,
    evidence,
    investigationSummary: summary,
    operatorMessage
  }, approvedPlan);
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

function normalizeDraftComment(source, draft, executionResult = null) {
  let message = String(draft || "").trim();
  message = message.replace(/^```(?:text|markdown)?\s*/i, "").replace(/```$/i, "").trim();
  if (!message.endsWith(AUTOMATED_SUFFIX)) {
    message = `${message.replace(/\s+$/g, "")}\n${AUTOMATED_SUFFIX}`;
  }
  if (!validateDraftComment(source, message).valid) {
    message = fallbackDraftComment(source, executionResult);
  }
  return message;
}

function buildPlan(entry, evidence, summary, operatorMessage = "") {
  const effectiveEntry = evidence?.entry || entry || {};
  const clientSideText = textSuggestsClientSide(summary, operatorMessage);
  const serverSide = textSuggestsServerSide(summary, operatorMessage) || !clientSideText;
  const clientSide = !serverSide && clientSideText;
  const repairPrompt = serverSide ? buildRepairPrompt(effectiveEntry, evidence, summary, operatorMessage) : undefined;
  return {
    source: effectiveEntry.source,
    issueId: effectiveEntry.issueId,
    summary,
    plan: {
      classification: serverSide ? "server_action" : "client_side",
      executionMode: serverSide ? "approved_repair_agent" : "none",
      actions: [],
      requiresServerAction: serverSide,
      repairPrompt,
      note: serverSide
        ? "Approval will run the autonomous Codex repair runner with this exact prompt."
        : "Determination is client-side or no server-side action is required."
    },
    evidence
  };
}

const REPAIR_RESULT_STATUSES = new Set([
  "fixed",
  "not_reproducible",
  "client_side",
  "partially_fixed",
  "needs_operator_decision",
  "failed_retryable",
  "failed_terminal"
]);

const REPAIR_VERIFICATION_STATUSES = new Set(["passed", "failed", "not_applicable"]);

function requiredString(value, field) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`final repair result field ${field} must be a non-empty string`);
  }
  return text;
}

function parseActionsTaken(value) {
  if (!Array.isArray(value)) {
    throw new Error("final repair result field actionsTaken must be an array");
  }
  return value.map(action => String(action).trim()).filter(Boolean);
}

function parseVerification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("final repair result field verification must be an object");
  }
  const status = String(value.status || "").trim();
  if (!REPAIR_VERIFICATION_STATUSES.has(status)) {
    throw new Error(`invalid repair verification status ${status || "(missing)"}`);
  }
  const details = String(value.details ?? "").trim();
  if (!details) {
    throw new Error("final repair result field verification.details must be a non-empty string");
  }
  return { ...value, status, details };
}

function validateRepairResult(result) {
  if (typeof result.closeRecommended !== "boolean") {
    throw new Error("final repair result field closeRecommended must be a boolean");
  }
  if (result.status === "fixed") {
    if (!result.actionsTaken.length) {
      throw new Error("fixed repair result must include at least one actionTaken entry");
    }
    if (result.verification.status !== "passed") {
      throw new Error("fixed repair result must include passed verification");
    }
  }
  if (result.status === "partially_fixed" && !result.actionsTaken.length) {
    throw new Error("partially_fixed repair result must include at least one actionTaken entry");
  }
  if (result.status === "needs_operator_decision" && !result.proposedChoices.length) {
    throw new Error("needs_operator_decision repair result must include proposedChoices");
  }
  if (result.closeRecommended && result.verification.status === "failed") {
    throw new Error("repair result cannot recommend closure when verification failed");
  }
  if (!["failed_retryable", "failed_terminal", "needs_operator_decision"].includes(result.status) && !result.draftComment) {
    throw new Error("successful repair result must include a draftComment");
  }
}

function parseRepairResult(output) {
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
  let lastError;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("final repair result must be a JSON object");
      }
      const status = String(parsed.status || "").trim();
      if (!REPAIR_RESULT_STATUSES.has(status)) {
        throw new Error(`invalid repair status ${status || "(missing)"}`);
      }
      const result = {
        status,
        summary: requiredString(parsed.summary, "summary"),
        actionsTaken: parseActionsTaken(parsed.actionsTaken),
        verification: parseVerification(parsed.verification),
        draftComment: String(parsed.draftComment || "").trim(),
        closeRecommended: parsed.closeRecommended,
        proposedChoices: Array.isArray(parsed.proposedChoices)
          ? parsed.proposedChoices.map(choice => String(choice).trim()).filter(Boolean)
          : []
      };
      validateRepairResult(result);
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Repair runner did not return valid final JSON: ${lastError?.message || "unknown parse error"}`);
}

function textDelegatesOwnerWork(...values) {
  const text = values.filter(Boolean).join("\n").toLowerCase();
  return /\b(?:server owner|owner|operator|admin)\b.{0,120}\b(?:should|must|needs? to|has to|will need to|please)\b.{0,140}\b(?:replace|blacklist|reacquire|download|refresh|analy[sz]e|scan|repair|fix|run|delete|import|queue|upgrade|configure)\b/.test(text)
    || /\b(?:replace|blacklist|reacquire|download|refresh|analy[sz]e|scan|repair|fix|run|delete|import|queue|upgrade|configure)\b.{0,120}\b(?:manually|yourself|by the server owner|by an operator)\b/.test(text)
    || /\bno repair action was run yet\b/.test(text)
    || /\bstill need(?:s)? server-side\b/.test(text);
}

function executionResultFromRepairResult(repairResult, agentRun) {
  const actionsTaken = repairResult.actionsTaken || [];
  return {
    outcome: repairResult.status,
    summary: repairResult.summary,
    actionsRequested: actionsTaken.length,
    actionsExecuted: actionsTaken.length,
    actions: actionsTaken.map((summary, index) => ({
      status: "completed_by_codex",
      index: index + 1,
      summary
    })),
    verification: repairResult.verification,
    draftComment: repairResult.draftComment,
    closeRecommended: repairResult.closeRecommended,
    proposedChoices: repairResult.proposedChoices || [],
    agentRunId: agentRun?.id || null,
    modelConfig: agentRun?.config || null
  };
}

function repairWorkspaceFor(config, jobId) {
  const root = config.repairWorkspaceRoot || path.join(path.dirname(config.dbPath || "/state/media-issue-agent.sqlite"), "repair-workspaces");
  return path.join(root, `job-${jobId}`);
}

function toolBriefingFromTools(tools = []) {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema || tool.input_schema || null
    })).filter(tool => tool.name)
  };
}

function compactRepairHistory(details) {
  return {
    job: {
      id: details.job.id,
      state: details.job.state,
      lastError: details.job.lastError || ""
    },
    runs: (details.agentRuns || []).slice(0, 5).map(run => ({
      id: run.id,
      status: run.status,
      error: run.error || "",
      finalResult: run.finalResult || null,
      startedAt: run.startedAt,
      completedAt: run.completedAt
    })),
    recentEvents: (details.agentRunEvents || []).slice(0, 25).map(event => ({
      runId: event.runId,
      eventType: event.eventType,
      payload: event.payload,
      createdAt: event.createdAt
    }))
  };
}

const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function normalizeCodexSettings(values = {}, defaults = {}) {
  const model = String(values.model ?? defaults.model ?? "gpt-5.5").trim();
  if (!model || model.length > 120) {
    throw new Error("Codex model must be a non-empty string.");
  }
  const reasoningEffort = String(values.reasoningEffort ?? defaults.reasoningEffort ?? "xhigh").trim();
  if (!REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`Unsupported Codex reasoning effort ${reasoningEffort}`);
  }
  const fastMode = Boolean(values.fastMode ?? defaults.fastMode ?? true);
  const serviceTier = String(values.serviceTier ?? defaults.serviceTier ?? (fastMode ? "fast" : "")).trim();
  if (serviceTier.length > 80) {
    throw new Error("Codex service tier is too long.");
  }
  const repairContext = String(values.repairContext ?? defaults.repairContext ?? "").trim();
  if (repairContext.length > 4000) {
    throw new Error("Repair context is too long.");
  }
  return { model, reasoningEffort, fastMode, serviceTier, repairContext };
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

function commentActionsFor(source, issueId, message) {
  if (source === "plex") {
    return [
      { toolName: "plex_add_reported_issue_comment", args: { issueId: String(issueId), message, dryRun: false, verbose: false } }
    ];
  }
  if (source === "seerr") {
    return [
      { toolName: "seerr_add_issue_comment", args: { issueId: Number(issueId), message, dryRun: false, verbose: false } }
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

function sourceClosedState(entry) {
  const raw = entry?.raw || {};
  const directLifecycle = String(entry?.lifecycle || raw.lifecycle || "").toLowerCase();
  if (directLifecycle === "closed") {
    return true;
  }
  if (directLifecycle === "open") {
    return false;
  }
  const comments = Array.isArray(raw.comments) ? raw.comments : Array.isArray(entry?.comments) ? entry.comments : null;
  if (comments?.length) {
    return issueLifecycleFromComments(comments, entry?.status || raw.status || raw.rawStatus || "").closed;
  }
  if (raw.isClosed === true || entry?.isClosed === true) {
    return true;
  }
  const status = String(entry?.status || raw.status || raw.rawStatus || "").toLowerCase();
  if (status === "closed" || status === "resolved" || status.includes("closed") || status.includes("resolved")) {
    return true;
  }
  return null;
}

function entryIsClosed(entry) {
  const sourceState = sourceClosedState(entry);
  if (sourceState !== null) {
    return sourceState;
  }
  return entry?.jobState === "closed";
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
    pruneSnapshots(this.config.dbPath, this.config.issueSnapshotRetention);
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
      webEnabled: this.config.webEnabled
    };
  }

  codexSettings() {
    const defaults = {
      model: this.config.codexModel || "gpt-5.5",
      reasoningEffort: this.config.codexReasoningEffort || "xhigh",
      fastMode: this.config.codexFastMode !== false,
      serviceTier: this.config.codexServiceTier || (this.config.codexFastMode === false ? "" : "fast"),
      repairContext: this.config.repairContext || ""
    };
    const saved = getSetting(this.config.dbPath, "codex", null);
    return {
      defaults,
      effective: normalizeCodexSettings(saved || {}, defaults),
      saved: saved || null
    };
  }

  updateCodexSettings(values) {
    const current = this.codexSettings();
    const saved = normalizeCodexSettings({ ...current.effective, ...(values || {}) }, current.defaults);
    setSetting(this.config.dbPath, "codex", saved);
    return this.codexSettings();
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
    const operatorMessage = redactText(String(message || "").trim());
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
    if (pending.kind === "action") {
      const approvals = setPendingApprovals(this.config.dbPath, jobId, "approved", actor, pending.kind);
      recordAudit(this.config.dbPath, "approval_accepted", sanitizeValue({ approvalId: pending.id, kind: pending.kind, actor }), jobId);
      transitionJob(this.config.dbPath, jobId, ["awaiting_action_approval"], "approved_for_execution");
      return this.continueJob(jobId, actor, { approvals });
    }
    if (pending.kind === "resolution") {
      recordAudit(this.config.dbPath, "resolution_approval_attempted", sanitizeValue({ approvalId: pending.id, kind: pending.kind, actor }), jobId);
      return this.closeApprovedIssue(jobId, pending, actor);
    }
    throw new Error(`Unsupported approval kind ${pending.kind}`);
  }

  reject(jobId, actor = "operator") {
    const pending = pendingApprovalForJobAnyKind(this.config.dbPath, jobId);
    if (!pending) {
      throw new Error(`Job ${jobId} has no pending approval`);
    }
    const approvals = setPendingApprovals(this.config.dbPath, jobId, "rejected", actor, pending?.kind || null);
    transitionJob(this.config.dbPath, jobId, ["awaiting_action_approval", "awaiting_comment_approval", "awaiting_resolution_approval"], "blocked_needs_human");
    recordAudit(this.config.dbPath, "approval_rejected", sanitizeValue({ approvals, actor }), jobId);
    return approvals;
  }

  async retryRepair(jobId, note, actor = "operator") {
    const job = jobForId(this.config.dbPath, jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found`);
    }
    if (job.state !== "failed_retryable") {
      throw new Error(`Job ${jobId} cannot retry repair from ${job.state}`);
    }
    if (pendingApprovalForJob(this.config.dbPath, jobId, "resolution")) {
      throw new Error(`Job ${jobId} has a pending resolution approval; approve it to retry closure actions.`);
    }
    const actionApproval = this.jobDetails(jobId).approvals.find(approval => approval.kind === "action" && approval.status === "approved");
    if (!actionApproval || actionApproval.payload?.plan?.executionMode !== "approved_repair_agent") {
      throw new Error(`Job ${jobId} has no approved autonomous repair prompt to retry`);
    }
    const retryNote = redactText(String(note || "").trim());
    if (!retryNote) {
      throw new Error("Repair retry note is required");
    }
    recordAudit(this.config.dbPath, "repair_retry_requested", sanitizeValue({ actor, note: retryNote }), jobId);
    return this.executeApprovedPlan(jobId, actor, { repairRetryNote: retryNote });
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

  async buildExecutionRepairPrompt(jobId, actor, actionApproval, context = {}) {
    const details = this.jobDetails(jobId);
    const settings = this.codexSettings().effective;
    const workspace = repairWorkspaceFor(this.config, jobId);
    await mkdir(workspace, { recursive: true });
    const retryNote = redactText(String(context.repairRetryNote || "").trim());
    if (retryNote) {
      await appendFile(path.join(workspace, "operator-retry-notes.jsonl"), `${JSON.stringify({
        createdAt: new Date().toISOString(),
        actor,
        note: retryNote,
        previousJobError: details.job.lastError || ""
      })}\n`);
    }
    let toolBriefing;
    try {
      const tools = typeof this.client.listTools === "function" ? await this.client.listTools() : [];
      toolBriefing = toolBriefingFromTools(tools);
    } catch (error) {
      const message = redactText(error.message);
      toolBriefing = { tools: [], error: message };
      recordAudit(this.config.dbPath, "repair_tool_list_failed", sanitizeValue({ actor, error: error.message }), jobId);
    }
    const payload = actionApproval.payload || {};
    const plan = payload.plan || {};
    const approvedPlan = {
      source: payload.source || details.job.source,
      issueId: payload.issueId || details.job.issueId,
      classification: plan.classification || "server_action",
      summary: payload.summary || details.investigation?.summary || "",
      operatorMessage: payload.evidence?.steering?.message || "",
      instructions: [
        "Use media-mcp directly through the configured Codex MCP server named media.",
        "Investigate, repair, and verify the approved issue as far as the available media tools allow.",
        "Choose the media tools that fit the evidence and current tool briefing.",
        "Do not delegate media-side work back to the server owner/operator.",
        "Do not post reporter comments or close the issue; media-issue-agent will request final human approval for that."
      ]
    };
    const prompt = repairExecutionPrompt({
      job: details.job,
      investigation: details.investigation,
      approvedBy: actor,
      originalEvidence: payload.evidence,
      retryRequested: Boolean(retryNote)
    }, approvedPlan, {
      runtimeContext: settings.repairContext,
      scratchWorkspace: workspace,
      toolBriefing,
      previousRepairHistory: compactRepairHistory(details),
      retry: retryNote ? {
        operatorNote: retryNote,
        previousJobError: details.job.lastError || "",
        guidance: "Use this trusted note to retry the already approved repair. Do not require a new investigation unless evidence is missing."
      } : null
    });
    return { prompt, workspace, settings, toolBriefing };
  }

  async executeApprovedPlan(jobId, actor, context = {}) {
    const details = this.jobDetails(jobId);
    const actionApproval = details.approvals.find(approval => approval.kind === "action" && approval.status === "approved");
    if (!actionApproval) {
      throw new Error(`Job ${jobId} has no approved action plan`);
    }
    transitionJob(this.config.dbPath, jobId, ["approved_for_execution", "failed_retryable"], "executing");
    recordAudit(this.config.dbPath, "execution_started", sanitizeValue({ actor, plan: actionApproval.payload.plan }), jobId);
    const plan = actionApproval.payload?.plan || {};
    const classification = plan.classification;
    if (classification === "client_side" || plan.executionMode === "none") {
      const executionResult = {
        outcome: "client_side",
        summary: "Determination was client-side or no server-side action was required. No server-side media action was executed.",
        actionsRequested: 0,
        actionsExecuted: 0,
        actions: [],
        verification: { status: "not_applicable", details: "No server-side repair was required." }
      };
      recordAudit(this.config.dbPath, "execution_completed", sanitizeValue(executionResult), jobId);
      transitionJob(this.config.dbPath, jobId, ["executing"], "drafting_comment");
      return this.draftResolutionApproval(jobId, actor, executionResult, context);
    }
    const { prompt: repairPrompt, workspace, settings, toolBriefing } = await this.buildExecutionRepairPrompt(jobId, actor, actionApproval, context);
    const agentRun = createAgentRun(this.config.dbPath, jobId, "repair", repairPrompt, settings);
    recordAudit(this.config.dbPath, "repair_agent_started", sanitizeValue({ actor, runId: agentRun.id, settings, workspace, toolCount: toolBriefing?.tools?.length || 0, retry: Boolean(context.repairRetryNote) }), jobId);
    let completedRun = null;
    try {
      const output = await runCodexRepair(this.config, repairPrompt, settings, {
        codexWorkspace: workspace,
        onEvent: event => recordAgentRunEvent(this.config.dbPath, agentRun.id, jobId, event?.type || "event", sanitizeValue(event))
      });
      recordAgentRunEvent(this.config.dbPath, agentRun.id, jobId, "codex_exit", sanitizeValue({
        args: output.args,
        settings: output.settings,
        stderr: output.stderr
      }));
      const repairResult = parseRepairResult(output.finalMessage);
      if (textDelegatesOwnerWork(repairResult.summary, repairResult.draftComment, repairResult.actionsTaken.join("\n"))) {
        throw new Error("Repair runner delegated media-side work back to the server owner/operator instead of attempting it.");
      }
      completedRun = completeAgentRun(this.config.dbPath, agentRun.id, repairResult.status, repairResult, null);
      if (repairResult.status === "needs_operator_decision") {
        const message = repairResult.summary || "Repair runner needs an operator decision before continuing.";
        recordAudit(this.config.dbPath, "repair_agent_needs_operator_decision", sanitizeValue({ actor, runId: agentRun.id, repairResult }), jobId);
        setJobState(this.config.dbPath, jobId, "failed_retryable", redactText(message));
        throw new Error(message);
      }
      if (repairResult.status === "failed_retryable" || repairResult.status === "failed_terminal") {
        const message = repairResult.summary || `Repair runner returned ${repairResult.status}`;
        recordAudit(this.config.dbPath, "repair_agent_failed", sanitizeValue({ actor, runId: agentRun.id, repairResult }), jobId);
        setJobState(this.config.dbPath, jobId, repairResult.status, redactText(message));
        throw new Error(message);
      }
      const executionResult = executionResultFromRepairResult(repairResult, completedRun || agentRun);
      recordAudit(this.config.dbPath, "execution_completed", sanitizeValue(executionResult), jobId);
      transitionJob(this.config.dbPath, jobId, ["executing"], "drafting_comment");
      return this.draftResolutionApproval(jobId, actor, executionResult, context);
    } catch (error) {
      const message = redactText(error.message);
      if (!completedRun) {
        completeAgentRun(this.config.dbPath, agentRun.id, "failed_retryable", null, message);
      }
      recordAgentRunEvent(this.config.dbPath, agentRun.id, jobId, "repair_failed", sanitizeValue({ error: error.message }));
      recordAudit(this.config.dbPath, "execution_failed", sanitizeValue({ actor, runId: agentRun.id, error: error.message }), jobId);
      const current = jobForId(this.config.dbPath, jobId);
      if (current?.state !== "failed_retryable" && current?.state !== "failed_terminal") {
        setJobState(this.config.dbPath, jobId, "failed_retryable", message);
      }
      throw error;
    }
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
    let draft = executionResult?.draftComment;
    if (!draft) {
      try {
        draft = await runCodex(this.config, commentDraftPrompt(evidence));
      } catch (error) {
        recordAudit(this.config.dbPath, "codex_comment_draft_failed", sanitizeValue({ error: error.message }), jobId);
        draft = fallbackDraftComment(details.job.source, executionResult);
      }
    }
    if (textDelegatesOwnerWork(draft)) {
      const note = "Draft resolution delegated media-side work back to the server owner/operator.";
      transitionJob(this.config.dbPath, jobId, ["drafting_comment"], "failed_retryable", note);
      recordAudit(this.config.dbPath, "resolution_draft_rejected", sanitizeValue({ actor, message: draft }), jobId);
      throw new Error(note);
    }
    const message = normalizeDraftComment(details.job.source, draft, executionResult);
    if (textDelegatesOwnerWork(message)) {
      const note = "Draft resolution delegated media-side work back to the server owner/operator.";
      transitionJob(this.config.dbPath, jobId, ["drafting_comment"], "failed_retryable", note);
      recordAudit(this.config.dbPath, "resolution_draft_rejected", sanitizeValue({ actor, message }), jobId);
      throw new Error(note);
    }
    const validation = validateDraftComment(details.job.source, message);
    if (!validation.valid) {
      transitionJob(this.config.dbPath, jobId, ["drafting_comment"], "failed_retryable", validation.errors.join("; "));
      throw new Error(`Draft comment failed validation: ${validation.errors.join("; ")}`);
    }
    const approval = createApproval(this.config.dbPath, jobId, "resolution", {
      source: details.job.source,
      issueId: details.job.issueId,
      message,
      closeIssue: executionResult?.closeRecommended !== false,
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

  async closeApprovedIssue(jobId, approval, actor) {
    transitionJob(this.config.dbPath, jobId, ["awaiting_resolution_approval", "failed_retryable"], "closing_issue");
    const { source, issueId, message, closeIssue = true } = approval.payload;
    const actions = closeIssue ? closeActionsFor(source, issueId, message) : commentActionsFor(source, issueId, message);
    const results = [];
    try {
      const executedActions = this.jobDetails(jobId).plannedActions.filter(action => action.riskLevel === "resolution" && action.executedAt);
      for (const action of actions) {
        const alreadyExecuted = executedActions.find(executed => executed.toolName === action.toolName && JSON.stringify(executed.args) === JSON.stringify(action.args));
        if (alreadyExecuted) {
          results.push({ action: alreadyExecuted, result: alreadyExecuted.result, skipped: true });
          continue;
        }
        const planned = createPlannedAction(this.config.dbPath, jobId, action.toolName, action.args, "resolution");
        recordAudit(this.config.dbPath, "closing_action_started", sanitizeValue({ action: planned }), jobId);
        const result = await this.client.callTool(action.toolName, action.args);
        const sanitized = sanitizeValue(result);
        markPlannedActionExecuted(this.config.dbPath, planned.id, sanitized, false);
        results.push({ action: planned, result: sanitized });
      }
      if (closeIssue) {
        transitionJob(this.config.dbPath, jobId, ["closing_issue"], "closed");
        recordAudit(this.config.dbPath, "issue_closed", sanitizeValue({ actor, results }), jobId);
      } else {
        const note = "Repair result did not recommend closing the issue; posted the approved update and left the job for human follow-up.";
        transitionJob(this.config.dbPath, jobId, ["closing_issue"], "blocked_needs_human", note);
        recordAudit(this.config.dbPath, "resolution_comment_posted_without_closure", sanitizeValue({ actor, results }), jobId);
      }
      const approvals = setPendingApprovals(this.config.dbPath, jobId, "approved", actor, "resolution");
      recordAudit(this.config.dbPath, "approval_accepted", sanitizeValue({ approvalId: approval.id, kind: "resolution", actor }), jobId);
      return {
        jobId,
        status: closeIssue ? "closed" : "blocked_needs_human",
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
