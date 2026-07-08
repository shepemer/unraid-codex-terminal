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
  recoverInterruptedAgentRuns,
  setPendingApprovals,
  setJobState,
  setSetting,
  snapshotEntries,
  snapshotEntry,
  statusSummary,
  supersedePendingApprovals,
  touchAgentRun,
  transitionJob,
  upsertMissingMcpItems,
  listMissingMcpItems,
  dismissMissingMcpItem,
  upsertInvestigation
} from "./db.js";
import { commentDraftPrompt, investigationPrompt, repairExecutionPrompt, runCodex, runCodexMcpCapabilityCheck, runCodexRepair, steeredInvestigationPrompt } from "./codex.js";
import { inspectCodexAuth, validateCodexHome } from "./config.js";
import { AUTOMATED_SUFFIX, CLOSED_MARKER, REOPENED_MARKER, countCharacters, validateDraftComment } from "./comments.js";
import { redactText, sanitizeValue } from "./redact.js";
import { createDiagnosticLogger } from "./diagnostic-log.js";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isInterruptedPollError(error) {
  const text = `${error?.name || ""} ${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("terminated")
    || text.includes("aborted")
    || text.includes("abort_err")
    || text.includes("econnreset")
    || text.includes("socket hang up");
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

function compactLine(value, maxLength = 180) {
  const text = String(value || "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function cleanActionStep(value) {
  const text = compactLine(String(value || "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s*(?:then|and then)\s+/i, "")
    .replace(/[.;]\s*$/g, ""));
  if (!text) {
    return "";
  }
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function splitInlineActionText(value) {
  return String(value || "")
    .split(/\s*(?:;|\band then\b|\bthen\b)\s*/i)
    .map(cleanActionStep)
    .filter(Boolean);
}

function steeringHistoryFromEvidence(evidence = {}) {
  const history = Array.isArray(evidence?.steeringHistory)
    ? evidence.steeringHistory
    : [];
  const entries = history
    .filter(entry => entry && typeof entry === "object" && String(entry.message || "").trim())
    .map((entry, index) => ({
      sequence: Number(entry.sequence) || index + 1,
      createdAt: entry.createdAt || null,
      actor: entry.actor || "operator",
      message: String(entry.message || "").trim(),
      previousSummary: entry.previousSummary || ""
    }));
  if (!entries.length && evidence?.steering?.message) {
    entries.push({
      sequence: Number(evidence.steering.sequence) || 1,
      createdAt: evidence.steering.createdAt || null,
      actor: evidence.steering.actor || "operator",
      message: String(evidence.steering.message || "").trim(),
      previousSummary: evidence.steering.previousSummary || ""
    });
  }
  return entries;
}

function appendSteeringToEvidence(evidence, { actor, message, previousSummary }) {
  const history = steeringHistoryFromEvidence(evidence);
  const entry = {
    sequence: history.length + 1,
    createdAt: new Date().toISOString(),
    actor: actor || "operator",
    message,
    previousSummary: previousSummary || ""
  };
  return sanitizeValue({
    ...(evidence || {}),
    steering: entry,
    steeringHistory: [...history, entry]
  });
}

function latestSteeringMessage(evidence = {}) {
  const history = steeringHistoryFromEvidence(evidence);
  return history.at(-1)?.message || "";
}

function truncateForPrompt(value, maxLength = 4000) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength).trim()}...[truncated ${text.length - maxLength} chars]`;
}

function compactForRepairPrompt(value, key = "", depth = 0) {
  const normalizedKey = String(key || "");
  if (/^(rawJson|raw|sourceUri|promptSafety)$/i.test(normalizedKey)) {
    return undefined;
  }
  if (/^(thumb|art|theme|grandparentThumb|grandparentArt|grandparentTheme|parentThumb|Image|UltraBlurColors)$/i.test(normalizedKey)) {
    return undefined;
  }
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === "string") {
    const maxLength = /^(summary|description|message|comment|comments|note|notes|text|error|lastError)$/i.test(normalizedKey) ? 5000 : 1200;
    return truncateForPrompt(value, maxLength);
  }
  if (typeof value !== "object") {
    return value;
  }
  if (depth >= 6) {
    return "[omitted nested detail]";
  }
  if (Array.isArray(value)) {
    const maxItems = /^(records|history|agentRunEvents|events)$/i.test(normalizedKey) ? 6 : 12;
    const items = value.slice(0, maxItems)
      .map(item => compactForRepairPrompt(item, normalizedKey, depth + 1))
      .filter(item => item !== undefined);
    if (value.length > maxItems) {
      items.push({ omittedItemCount: value.length - maxItems });
    }
    return items;
  }
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const compacted = compactForRepairPrompt(childValue, childKey, depth + 1);
    if (compacted !== undefined) {
      output[childKey] = compacted;
    }
  }
  return output;
}

function buildRepairPromptPreview(summary, operatorMessage = "") {
  const lines = [
    "Autonomous approved media repair execution.",
    "Use the configured MCP server named media to inspect, repair, and verify the issue directly.",
    "Choose the media tools that fit the evidence and current tool briefing.",
    "Do not delegate media-side work back to the server owner/operator.",
    "Do not post reporter comments or close the issue before final approval.",
    "",
    "Investigation summary:",
    truncateForPrompt(summary, 7000)
  ];
  if (String(operatorMessage || "").trim()) {
    lines.push("", "Latest trusted steering note:", truncateForPrompt(operatorMessage, 1200));
  }
  return lines.join("\n");
}

function extractInvestigationActionSteps(summary) {
  const lines = String(summary || "").split(/\r?\n/);
  const steps = [];
  let collecting = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (collecting && steps.length) {
        break;
      }
      continue;
    }
    const inlineMatch = trimmed.match(/^(?:#+\s*)?(?:\*\*)?(?:exact\s+safe\s+next\s+actions?|safe\s+next\s+actions?|next\s+actions?|recommended\s+actions?|repair\s+plan)(?:\*\*)?\s*:\s*(.+)$/i);
    if (inlineMatch) {
      steps.push(...splitInlineActionText(inlineMatch[1]));
      collecting = true;
      continue;
    }
    const headerMatch = /^(?:#+\s*)?(?:\*\*)?(?:exact\s+safe\s+next\s+actions?|safe\s+next\s+actions?|next\s+actions?|recommended\s+actions?|repair\s+plan)(?:\*\*)?\s*:?\s*$/i.test(trimmed);
    if (headerMatch) {
      collecting = true;
      continue;
    }
    if (!collecting) {
      continue;
    }
    if (/^(?:#+\s+|\*\*[^*]+\*\*\s*$)/.test(trimmed) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(trimmed)) {
      break;
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(trimmed)) {
      const step = cleanActionStep(trimmed);
      if (step) {
        steps.push(step);
      }
      continue;
    }
    if (!steps.length) {
      steps.push(...splitInlineActionText(trimmed));
    } else {
      break;
    }
  }
  return [...new Set(steps)].slice(0, 5);
}

function buildActionSummary(entry, summary, plan) {
  const source = entry?.source || plan?.source || "media";
  const issueId = entry?.issueId || plan?.issueId || "unknown";
  if (plan?.classification === "client_side" || plan?.executionMode === "none") {
    return {
      mode: "client_side",
      headline: "No server-side repair will run",
      bullets: [
        "Approve to skip media mutations and move directly to final resolution comment review.",
        "The issue will be treated as client-side or as not requiring a server-side media change.",
        "The reporter-facing resolution still requires your final approval before posting or closing."
      ],
      expectedSteps: extractInvestigationActionSteps(summary)
    };
  }
  return {
    mode: "server_action",
    headline: `Run autonomous media repair for ${source} issue ${issueId}`,
    bullets: [
      "Approve to start the autonomous Codex repair runner inside the issue-agent container.",
      "It will use media-mcp to inspect the issue and media, choose appropriate repair tools, make the media-side changes it can, and verify the result.",
      "It will not post reporter comments or close the issue until you approve the final resolution."
    ],
    expectedSteps: extractInvestigationActionSteps(summary)
  };
}

function addActionSummaries(details) {
  const approvals = (details.approvals || []).map(approval => {
    const plan = approval.payload?.plan;
    if (!plan) {
      return approval;
    }
    const actionSummary = plan.actionSummary || buildActionSummary({
      source: approval.payload?.source || details.job?.source,
      issueId: approval.payload?.issueId || details.job?.issueId
    }, approval.payload?.summary || details.investigation?.summary || "", plan);
    return {
      ...approval,
      payload: {
        ...approval.payload,
        plan: {
          ...plan,
          actionSummary
        }
      }
    };
  });
  const pendingActionSummary = approvals.find(approval => approval.kind === "action" && approval.status === "pending")
    ?.payload?.plan?.actionSummary || null;
  return {
    ...details,
    approvals,
    pendingActionSummary
  };
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
  const repairPrompt = serverSide ? buildRepairPromptPreview(summary, operatorMessage) : undefined;
  const plan = {
    classification: serverSide ? "server_action" : "client_side",
    executionMode: serverSide ? "approved_repair_agent" : "none",
    actions: [],
    requiresServerAction: serverSide,
    repairPrompt,
    note: serverSide
      ? "Approval will run the autonomous Codex repair runner using the current investigation, compacted evidence, and live media-mcp tool briefing."
      : "Determination is client-side or no server-side action is required."
  };
  plan.actionSummary = buildActionSummary(effectiveEntry, summary, plan);
  return {
    source: effectiveEntry.source,
    issueId: effectiveEntry.issueId,
    summary,
    plan,
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

function parseMissingMcpItems(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("final repair result field missingMcpItems must be an array when provided");
  }
  return value.map(item => {
    if (typeof item === "string") {
      const text = String(sanitizeValue(item)).trim();
      return text ? { title: text, description: text } : null;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const title = String(item.title || item.capability || item.suggestedToolName || "").trim();
    const description = String(item.description || item.reason || title || "").trim();
    if (!title && !description) {
      return null;
    }
    return sanitizeValue({
      title: title || description.slice(0, 120),
      description: description || title,
      suggestedToolName: String(item.suggestedToolName || item.toolName || "").trim(),
      category: String(item.category || item.type || "").trim(),
      reason: String(item.reason || "").trim()
    });
  }).filter(Boolean);
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
          : [],
        missingMcpItems: parseMissingMcpItems(parsed.missingMcpItems)
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
    missingMcpItems: repairResult.missingMcpItems || [],
    agentRunId: agentRun?.id || null,
    modelConfig: agentRun?.config || null
  };
}

function transitionSuccessfulRepairToDrafting(dbPath, jobId, agentRun, repairResult) {
  const current = jobForId(dbPath, jobId);
  if (!current) {
    throw new Error(`Job ${jobId} was not found after repair completed`);
  }
  if (current.state === "executing") {
    transitionJob(dbPath, jobId, ["executing"], "drafting_comment");
    return { recovered: false, previousState: current.state };
  }
  if (current.state === "failed_retryable") {
    setJobState(dbPath, jobId, "drafting_comment", null);
    recordAudit(dbPath, "repair_success_recovered_from_retryable_state", sanitizeValue({
      runId: agentRun?.id || null,
      repairStatus: repairResult?.status || null,
      previousState: current.state,
      previousError: current.lastError || null
    }), jobId);
    return { recovered: true, previousState: current.state };
  }
  const message = `Repair runner completed successfully for job ${jobId}, but job state is ${current.state}; expected executing before drafting the resolution comment.`;
  recordAudit(dbPath, "repair_success_state_conflict", sanitizeValue({
    runId: agentRun?.id || null,
    repairStatus: repairResult?.status || null,
    currentState: current.state,
    currentError: current.lastError || null
  }), jobId);
  throw new Error(message);
}

function repairWorkspaceFor(config, jobId) {
  const root = config.repairWorkspaceRoot || path.join(path.dirname(config.dbPath || "/state/media-issue-agent.sqlite"), "repair-workspaces");
  return path.join(root, `job-${jobId}`);
}

function compactToolSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return null;
  }
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const compactProperties = Object.entries(properties).slice(0, 30).map(([name, property]) => ({
    name,
    type: Array.isArray(property?.type) ? property.type.join("|") : property?.type || property?.anyOf?.map(item => item.type).filter(Boolean).join("|") || "unknown",
    description: property?.description ? truncateForPrompt(property.description, 240) : undefined,
    enum: Array.isArray(property?.enum) ? property.enum.slice(0, 12) : undefined
  }));
  return {
    required: Array.isArray(schema.required) ? schema.required.slice(0, 30) : [],
    properties: compactProperties,
    omittedPropertyCount: Math.max(0, Object.keys(properties).length - compactProperties.length)
  };
}

function toolBriefingFromTools(tools = []) {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: truncateForPrompt(tool.description || "", 700),
      inputSchema: compactToolSchema(tool.inputSchema || tool.input_schema || null)
    })).filter(tool => tool.name)
  };
}

function compactRepairEventPayload(event) {
  const payload = event.payload || {};
  if (event.eventType === "repair_mcp_tool_call") {
    return {
      toolName: payload.toolName,
      arguments: compactForRepairPrompt(payload.arguments || {}, "arguments")
    };
  }
  if (event.eventType === "repair_mcp_tool_result") {
    return {
      calls: payload.calls,
      status: payload.status,
      resultSummary: payload.resultSummary || compactForRepairPrompt(payload.result, "result", 4)
    };
  }
  if (payload.item?.type === "mcp_tool_call") {
    return {
      type: payload.item.type,
      toolName: payload.item.name || payload.item.tool,
      status: payload.item.status,
      arguments: payload.item.arguments ? compactForRepairPrompt(payload.item.arguments, "arguments") : undefined,
      resultSummary: payload.item.resultSummary || (payload.item.result ? compactForRepairPrompt(payload.item.result, "result", 4) : undefined),
      error: payload.item.error ? truncateForPrompt(payload.item.error, 1000) : undefined
    };
  }
  if (payload.text || payload.error) {
    return {
      text: payload.text ? truncateForPrompt(payload.text, 1000) : undefined,
      error: payload.error ? truncateForPrompt(payload.error, 1000) : undefined
    };
  }
  return compactForRepairPrompt(payload, "eventPayload", 4);
}

function compactAgentRunEventForStorage(event) {
  const compacted = compactForRepairPrompt(event, "agentRunEvent", 0);
  if (event?.type === "repair_mcp_tool_call") {
    return {
      type: event.type,
      toolName: event.toolName,
      arguments: compactForRepairPrompt(event.arguments || {}, "arguments")
    };
  }
  if (event?.type === "repair_mcp_tool_result") {
    return {
      type: event.type,
      calls: event.calls,
      status: event.status,
      resultSummary: compactForRepairPrompt(event.result, "result", 4)
    };
  }
  if (event?.item?.type === "mcp_tool_call") {
    return {
      type: event.type,
      item: {
        type: event.item.type,
        id: event.item.id,
        server: event.item.server,
        tool: event.item.tool || event.item.name,
        name: event.item.name || event.item.tool,
        status: event.item.status,
        arguments: compactForRepairPrompt(event.item.arguments || {}, "arguments"),
        resultSummary: event.item.result ? compactForRepairPrompt(event.item.result, "result", 4) : undefined,
        error: event.item.error ? truncateForPrompt(event.item.error, 1000) : undefined
      }
    };
  }
  if (event?.type === "stdout" || event?.type === "stderr") {
    return {
      type: event.type,
      text: truncateForPrompt(event.text || "", 2000)
    };
  }
  if (event?.type === "item.completed" && event?.item?.type === "agent_message") {
    return {
      type: event.type,
      item: {
        type: event.item.type,
        text: truncateForPrompt(event.item.text || "", 3000)
      }
    };
  }
  return compacted;
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
      payload: compactRepairEventPayload(event),
      createdAt: event.createdAt
    }))
  };
}

function parseJsonObjectFromModel(output, label) {
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
        throw new Error(`${label} must be a JSON object`);
      }
      return parsed;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${label} did not return valid JSON: ${lastError?.message || "unknown parse error"}`);
}

function normalizeMcpToolNameForLookup(value) {
  const name = String(value || "").trim().toLowerCase();
  return name.startsWith("media.") ? name.slice("media.".length) : name;
}

const MCP_CAPABILITY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "can",
  "for",
  "from",
  "if",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "one",
  "that",
  "the",
  "their",
  "this",
  "to",
  "tool",
  "with"
]);

function normalizeMcpCapabilityText(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./-]+/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mcpCapabilityTokens(value) {
  return normalizeMcpCapabilityText(value)
    .split(" ")
    .filter(token => token.length >= 3 && !MCP_CAPABILITY_STOP_WORDS.has(token));
}

function mcpCapabilityItemText(item) {
  return normalizeMcpCapabilityText([
    item?.title,
    item?.description,
    item?.suggestedToolName,
    item?.category
  ].filter(Boolean).join(" "));
}

function mcpCapabilityToolText(tool) {
  return normalizeMcpCapabilityText([
    tool?.name,
    tool?.title,
    tool?.description,
    tool?.inputSchema ? JSON.stringify(tool.inputSchema) : ""
  ].filter(Boolean).join(" "));
}

function mcpCapabilityRequestDetails(item) {
  return {
    title: item?.title || null,
    description: item?.description || null,
    suggestedToolName: item?.suggestedToolName || null,
    category: item?.category || null
  };
}

function mcpCapabilityToolDetails(tool) {
  if (!tool) {
    return null;
  }
  const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {};
  const properties = schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : [];
  return {
    name: tool.name || null,
    title: tool.title || tool.name || null,
    description: tool.description || null,
    inputFields: properties.slice(0, 40)
  };
}

function hasMcpStem(text, stems) {
  return stems.some(stem => text.includes(stem));
}

function removeNegatedMcpCapabilityTerms(text) {
  return String(text || "")
    .replace(/\bno\s+(?:replace|replacement|search|import|queue|grab|download|delete|remove|removal|scan|refresh|blocklist|blacklist)\b/g, " ")
    .replace(/\bwithout\s+(?:replace|replacement|search|import|queue|grab|download|delete|remove|removal|scan|refresh|blocklist|blacklist)(?:ing)?\b/g, " ")
    .replace(/\b(?:do\s+not|dont|don't)\s+(?:replace|search|import|queue|grab|download|delete|remove|scan|refresh|blocklist|blacklist)\b/g, " ")
    .replace(/\b(?:non|not)\s+(?:replacing|searching|importing|queueing|queuing|grabbing|downloading|deleting|removing|scanning|refreshing|blocklisting|blacklisting)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mcpToolRequirementFailures(item, tool) {
  const requestText = removeNegatedMcpCapabilityTerms(mcpCapabilityItemText(item));
  const titleText = normalizeMcpCapabilityText(item?.title);
  const categoryText = normalizeMcpCapabilityText(item?.category);
  const toolText = mcpCapabilityToolText(tool);
  const failures = [];
  const requireIf = (condition, label, stems) => {
    if (condition && !hasMcpStem(toolText, stems)) {
      failures.push(label);
    }
  };

  for (const service of ["sonarr", "radarr", "plex", "bazarr", "seerr"]) {
    requireIf(categoryText === service || titleText.includes(service), `${service} capability`, [service]);
  }
  requireIf(hasMcpStem(requestText, ["delete", "delet", "remove", "removal"]), "delete/remove operation", ["delete", "delet", "remove", "removal"]);
  requireIf(hasMcpStem(requestText, ["stat"]), "stat or inspection operation", ["stat", "metadata", "probe", "inspect"]);
  requireIf(hasMcpStem(requestText, ["blocklist", "blacklist"]), "blocklist/blacklist support", ["blocklist", "blacklist"]);
  requireIf(hasMcpStem(requestText, ["interactive"]), "interactive search support", ["interactive"]);
  requireIf(hasMcpStem(requestText, ["season"]), "season-level support", ["season"]);
  requireIf(hasMcpStem(requestText, ["show"]), "show/series-level support", ["show", "series", "parent"]);
  requireIf(hasMcpStem(requestText, ["scan"]), "library scan support", ["scan"]);
  requireIf(hasMcpStem(requestText, ["refresh"]), "metadata refresh support", ["refresh"]);
  requireIf(hasMcpStem(requestText, ["search"]), "search support", ["search", "grab", "import"]);
  requireIf(hasMcpStem(requestText, ["import"]), "import support", ["import", "queue", "grab"]);
  requireIf(hasMcpStem(requestText, ["queue"]), "queue support", ["queue"]);
  requireIf(hasMcpStem(requestText, ["replace", "replacement"]), "replacement support", ["replace", "replacement", "search", "import", "grab", "download"]);
  requireIf(hasMcpStem(requestText, ["path"]), "path/rating-key targeting", ["path", "rating key", "ratingkey", "part file", "partfile"]);
  requireIf(
    hasMcpStem(requestText, ["path"]) && hasMcpStem(requestText, ["map", "mapping", "root", "roots"]),
    "path-map/root resolution",
    ["media mcp path maps", "media mcp media roots", "path maps", "media roots", "plex media part", "rating key", "ratingkey", "part file", "partfile"]
  );
  requireIf(hasMcpStem(requestText, ["probe", "ffprobe", "frame", "hash", "content"]), "content probe support", ["probe", "ffprobe", "frame", "hash", "metadata"]);
  requireIf(hasMcpStem(requestText, ["subtitle", "subtitles"]), "subtitle support", ["subtitle", "subtitles", "bazarr"]);
  return failures;
}

function scoreMcpCapabilityTool(item, tool) {
  return mcpCapabilityScoreDetails(item, tool).score;
}

function mcpCapabilityScoreDetails(item, tool) {
  const suggested = normalizeMcpToolNameForLookup(item?.suggestedToolName);
  const toolName = normalizeMcpToolNameForLookup(tool?.name);
  const toolText = mcpCapabilityToolText(tool);
  if (suggested && toolName === suggested) {
    return {
      score: 1000,
      threshold: 35,
      exactSuggestedToolMatch: true,
      suggestedNameInToolText: true,
      categoryMatched: Boolean(item?.category),
      requestTokens: [],
      matchedTokens: [],
      candidateTool: mcpCapabilityToolDetails(tool)
    };
  }
  const requestTokens = new Set(mcpCapabilityTokens([
    item?.title,
    item?.description,
    item?.suggestedToolName,
    item?.category
  ].filter(Boolean).join(" ")));
  const matchedTokens = [...requestTokens].filter(token => toolText.includes(token));
  let score = 0;
  const suggestedNameInToolText = suggested && toolText.includes(normalizeMcpCapabilityText(suggested));
  if (suggested && toolText.includes(normalizeMcpCapabilityText(suggested))) {
    score += 150;
  }
  score += matchedTokens.length * 8;
  const category = normalizeMcpCapabilityText(item?.category);
  const categoryMatched = Boolean(category && toolText.includes(category));
  if (category && toolText.includes(category)) {
    score += 20;
  }
  return {
    score,
    threshold: 35,
    exactSuggestedToolMatch: false,
    suggestedNameInToolText: Boolean(suggestedNameInToolText),
    categoryMatched,
    requestTokens: [...requestTokens].slice(0, 40),
    matchedTokens: matchedTokens.slice(0, 40),
    candidateTool: mcpCapabilityToolDetails(tool)
  };
}

function chooseMcpCapabilityTool(item, tools) {
  let best = null;
  let bestDetails = null;
  let bestScore = 0;
  for (const tool of tools) {
    const details = mcpCapabilityScoreDetails(item, tool);
    const score = details.score;
    if (score > bestScore || (score === bestScore && best && String(tool.name).localeCompare(String(best.name)) < 0)) {
      best = tool;
      bestDetails = details;
      bestScore = score;
    }
  }
  return bestScore >= 35 ? { tool: best, score: bestScore, details: bestDetails } : { tool: null, score: bestScore, details: bestDetails };
}

function deterministicMcpCapabilityDecision(item, tools) {
  const { tool, score, details } = chooseMcpCapabilityTool(item, tools);
  const baseDetails = {
    request: mcpCapabilityRequestDetails(item),
    candidate: details?.candidateTool || null,
    score,
    threshold: details?.threshold || 35,
    exactSuggestedToolMatch: Boolean(details?.exactSuggestedToolMatch),
    suggestedNameInToolText: Boolean(details?.suggestedNameInToolText),
    categoryMatched: Boolean(details?.categoryMatched),
    requestTokens: details?.requestTokens || [],
    matchedTokens: details?.matchedTokens || [],
    missingRequirements: []
  };
  if (!tool) {
    return {
      detected: false,
      toolName: null,
      toolTitle: null,
      matchType: "not_detected",
      confidence: "high",
      reason: "No live media-mcp tool matched this requested capability strongly enough for deterministic detection.",
      rationaleDetails: {
        ...baseDetails,
        decisionFactors: [
          `Best candidate score ${score} was below the detection threshold ${baseDetails.threshold}.`,
          "The checker requires a live tool to match the request intent, not just a similar name."
        ]
      }
    };
  }

  const failures = mcpToolRequirementFailures(item, tool);
  if (failures.length) {
    return {
      detected: false,
      toolName: tool.name,
      toolTitle: tool.title || tool.name,
      matchType: "partial",
      confidence: "high",
      reason: `Live media-mcp tool ${tool.name} is related, but it does not explicitly cover: ${failures.join(", ")}.`,
      rationaleDetails: {
        ...baseDetails,
        missingRequirements: failures,
        decisionFactors: [
          `The closest live tool was ${tool.name} with score ${score}.`,
          "The tool was treated as related but insufficient because required capability terms were missing from its metadata.",
          `Missing requirements: ${failures.join(", ")}.`
        ]
      }
    };
  }

  const suggested = normalizeMcpToolNameForLookup(item?.suggestedToolName);
  const toolName = normalizeMcpToolNameForLookup(tool.name);
  return {
    detected: true,
    toolName: tool.name,
    toolTitle: tool.title || tool.name,
    matchType: suggested && suggested === toolName ? "exact_live_tool" : "deterministic_metadata_match",
    confidence: score >= 1000 ? "high" : "medium",
    reason: `Live media-mcp tool ${tool.name} has name, description, and schema coverage for the requested capability.`,
    rationaleDetails: {
      ...baseDetails,
      decisionFactors: [
        suggested && suggested === toolName
          ? `The suggested tool name exactly matched live tool ${tool.name}.`
          : `Live tool ${tool.name} matched enough request tokens and metadata to satisfy the deterministic policy.`,
        details?.categoryMatched ? "The requested category matched the live tool metadata." : null,
        details?.matchedTokens?.length ? `Matched request tokens: ${details.matchedTokens.join(", ")}.` : null
      ].filter(Boolean)
    }
  };
}

function parseMcpCapabilityCheckResult(output, items, tools) {
  const parsed = parseJsonObjectFromModel(output, "MCP capability check agent");
  const rawResults = Array.isArray(parsed.results) ? parsed.results : [];
  const toolsByName = new Map(tools.map(tool => [normalizeMcpToolNameForLookup(tool.name), tool]).filter(([name]) => name));
  const agentResultsByItemId = new Map();
  for (const raw of rawResults) {
    const itemId = Number(raw?.itemId);
    if (!Number.isInteger(itemId)) {
      continue;
    }
    const requestedToolName = String(raw?.toolName || "").trim();
    const requestedLookupName = normalizeMcpToolNameForLookup(requestedToolName);
    const availableTool = requestedLookupName ? toolsByName.get(requestedLookupName) : null;
    agentResultsByItemId.set(itemId, {
      detected: raw?.detected === true && Boolean(availableTool),
      toolName: availableTool?.name || requestedToolName || null,
      matchType: String(raw?.matchType || "").trim() || null,
      confidence: String(raw?.confidence || "").trim() || null,
      reason: String(raw?.reason || "").trim() || null
    });
  }
  const results = items.map(item => {
    const decision = deterministicMcpCapabilityDecision(item, tools);
    return {
      itemId: item.id,
      title: item.title,
      suggestedToolName: item.suggestedToolName || null,
      category: item.category || null,
      ...decision,
      agentDecision: agentResultsByItemId.get(Number(item.id)) || null
    };
  });
  const detectedCount = results.filter(result => result.detected).length;
  return {
    summary: `Checked ${items.length} requested MCP capabilities against ${tools.length} live media-mcp tools; ${detectedCount} detected by deterministic metadata policy.`,
    agentSummary: String(parsed.summary || "").trim(),
    results
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
    this.initPromise = null;
    this.diagnosticLogger = createDiagnosticLogger(config);
  }

  diagnostic(level, event, payload = {}) {
    return this.diagnosticLogger.log(level, event, payload);
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await initDb(this.config.dbPath);
        const recovered = recoverInterruptedAgentRuns(this.config.dbPath, {
          staleSeconds: this.config.recoverStaleRunSeconds
        });
        if (recovered) {
          this.diagnostic("warn", "interrupted_repair_runs_recovered", { count: recovered });
          recordAudit(this.config.dbPath, "interrupted_repair_runs_recovered", sanitizeValue({ count: recovered }));
        }
        if (!this.config.suppressInitLog) {
          this.diagnostic("info", "agent_initialized", {
            dbPath: this.config.dbPath,
            logPath: this.config.logPath,
            recoverStaleRunSeconds: this.config.recoverStaleRunSeconds
          });
        }
      })();
    }
    await this.initPromise;
  }

  async pollOnce() {
    await this.init();
    this.diagnostic("debug", "poll_started", {});
    const listed = await this.client.callTool("plex_reported_issues", {
      status: "all",
      source: "all",
      take: 100,
      skip: 0,
      verbose: false
    });
    const records = Array.isArray(listed?.records) ? listed.records : [];
    const detailFailures = [];
    const issues = await issueQueue(records, this.client, {
      onDetailError: failure => detailFailures.push(failure)
    });
    if (detailFailures.length) {
      this.diagnostic("warn", "poll_issue_detail_failures", {
        count: detailFailures.length,
        failures: detailFailures.slice(0, 20)
      });
    }
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
    this.diagnostic("info", "poll_completed", {
      snapshotId: snapshot.id,
      issueCount: issues.length,
      openIssueCount: issues.filter(issue => !issue.isClosed).length,
      closedIssueCount: issues.filter(issue => issue.isClosed).length,
      detailFailureCount: detailFailures.length
    });
    return {
      snapshotId: snapshot.id,
      issueCount: issues.length,
      openIssueCount: issues.filter(issue => !issue.isClosed).length,
      closedIssueCount: issues.filter(issue => issue.isClosed).length,
      detailFailureCount: detailFailures.length,
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

  missingMcpItems() {
    return listMissingMcpItems(this.config.dbPath);
  }

  async checkMissingMcpCapabilities(actor = "operator") {
    await this.init();
    const items = this.missingMcpItems();
    const startedAt = Date.now();
    this.diagnostic("info", "missing_mcp_capability_check_started", {
      actor,
      itemCount: items.length,
      mode: "codex_agent"
    });
    let tools;
    try {
      tools = typeof this.client.listTools === "function" ? await this.client.listTools() : [];
    } catch (error) {
      this.diagnostic("error", "missing_mcp_capability_check_failed", {
        actor,
        error: error.message
      });
      throw error;
    }
    let output;
    let parsed;
    const settings = this.codexSettings().effective;
    try {
      output = await runCodexMcpCapabilityCheck(this.config, items, tools, settings, {
        onEvent: event => this.diagnostic("debug", "missing_mcp_capability_agent_event", { event })
      });
      parsed = parseMcpCapabilityCheckResult(output.finalMessage, items, tools);
    } catch (error) {
      this.diagnostic("error", "missing_mcp_capability_check_failed", {
        actor,
        mode: "codex_agent",
        error: error.message
      });
      throw error;
    }
    const results = parsed.results;
    const detected = results.filter(result => result.detected);
    this.diagnostic("info", "missing_mcp_capability_check_completed", {
      actor,
      mode: "codex_agent",
      itemCount: items.length,
      toolCount: tools.length,
      detectedCount: detected.length,
      durationMs: Date.now() - startedAt,
      model: output.settings?.model,
      reasoningEffort: output.settings?.reasoningEffort,
      fastMode: output.settings?.fastMode,
      summary: parsed.summary,
      agentSummary: parsed.agentSummary,
      decisionPolicy: "deterministic_metadata_policy",
      detected: detected.map(result => ({
        itemId: result.itemId,
        toolName: result.toolName,
        matchType: result.matchType
      }))
    });
    return {
      checkedAt: new Date().toISOString(),
      toolCount: tools.length,
      items,
      results,
      detectedItemIds: detected.map(result => result.itemId),
      summary: parsed.summary,
      agentSummary: parsed.agentSummary,
      decisionPolicy: "deterministic_metadata_policy",
      mode: "codex_agent"
    };
  }

  removeMissingMcpItem(itemId, actor = "operator") {
    const item = dismissMissingMcpItem(this.config.dbPath, itemId);
    if (!item) {
      throw new Error(`Missing MCP item ${itemId} was not found`);
    }
    this.diagnostic("info", "missing_mcp_item_removed", {
      actor,
      itemId: item.id,
      jobId: item.jobId,
      title: item.title
    });
    if (item.jobId) {
      recordAudit(this.config.dbPath, "missing_mcp_item_removed", sanitizeValue({
        actor,
        itemId: item.id,
        title: item.title,
        suggestedToolName: item.suggestedToolName || null
      }), item.jobId);
    }
    return item;
  }

  jobDetails(jobId) {
    const details = readJobDetails(this.config.dbPath, jobId);
    if (!details) {
      throw new Error(`Job ${jobId} was not found`);
    }
    return addActionSummaries(details);
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
    this.diagnostic("info", "investigation_requested", {
      jobId: job.id,
      snapshotId,
      index,
      source: entry.source,
      issueId: entry.issueId,
      force: Boolean(options.force)
    });
    const cached = investigationForJob(this.config.dbPath, job.id);
    if (cached && !options.force) {
      const approval = pendingApprovalForJob(this.config.dbPath, job.id);
      this.diagnostic("info", "investigation_cache_hit", {
        jobId: job.id,
        approvalId: approval?.id || null,
        status: cached.status
      });
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
      this.diagnostic("info", "codex_investigation_started", { jobId: job.id });
      summary = await runCodex(this.config, investigationPrompt(evidence));
      this.diagnostic("info", "codex_investigation_completed", {
        jobId: job.id,
        summaryLength: summary.length
      });
    } catch (error) {
      const message = redactText(error.message);
      this.diagnostic("error", "codex_investigation_failed", {
        jobId: job.id,
        error: error.message
      });
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
    this.diagnostic("info", "investigation_ready", {
      jobId: job.id,
      approvalId: approval.id,
      classification: approvalPayload?.plan?.classification,
      executionMode: approvalPayload?.plan?.executionMode,
      summaryLength: summary.length
    });
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
      "failed_terminal",
      "blocked_needs_human"
    ]);
    if (!allowedStates.has(job.state)) {
      throw new Error(`Cannot transition job ${jobId} from ${job.state} to investigating`);
    }
    await validateCodexHome(this.config.codexHome);
    transitionJob(this.config.dbPath, jobId, [
      "awaiting_action_approval",
      "failed_retryable",
      "failed_terminal",
      "blocked_needs_human"
    ], "investigating");
    supersedePendingApprovals(this.config.dbPath, jobId, "action");
    this.diagnostic("info", "operator_steered_investigation", {
      jobId,
      actor,
      messageLength: operatorMessage.length
    });
    recordAudit(this.config.dbPath, "operator_steered_investigation", sanitizeValue({ actor, message: operatorMessage }), jobId);
    const evidence = appendSteeringToEvidence(current.evidence, {
      actor,
      message: operatorMessage,
      previousSummary: current.summary
    });
    let summary;
    try {
      this.diagnostic("info", "codex_steered_investigation_started", { jobId });
      summary = await runCodex(this.config, steeredInvestigationPrompt(evidence, current.summary, operatorMessage));
      this.diagnostic("info", "codex_steered_investigation_completed", {
        jobId,
        summaryLength: summary.length
      });
    } catch (error) {
      const reason = redactText(error.message);
      this.diagnostic("error", "codex_steered_investigation_failed", {
        jobId,
        error: error.message
      });
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
    this.diagnostic("info", "steered_investigation_ready", {
      jobId,
      approvalId: approval.id,
      classification: approval.payload?.plan?.classification,
      executionMode: approval.payload?.plan?.executionMode,
      summaryLength: summary.length
    });
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
      this.diagnostic("info", "action_approval_accepted", {
        jobId,
        approvalId: pending.id,
        actor
      });
      recordAudit(this.config.dbPath, "approval_accepted", sanitizeValue({ approvalId: pending.id, kind: pending.kind, actor }), jobId);
      transitionJob(this.config.dbPath, jobId, ["awaiting_action_approval"], "approved_for_execution");
      return this.continueJob(jobId, actor, { approvals });
    }
    if (pending.kind === "resolution") {
      this.diagnostic("info", "resolution_approval_accepted", {
        jobId,
        approvalId: pending.id,
        actor
      });
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
    this.diagnostic("warn", "approval_rejected", {
      jobId,
      approvalId: pending.id,
      kind: pending.kind,
      actor
    });
    recordAudit(this.config.dbPath, "approval_rejected", sanitizeValue({ approvals, actor }), jobId);
    return approvals;
  }

  async retryRepair(jobId, note, actor = "operator") {
    await this.init();
    const job = jobForId(this.config.dbPath, jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found`);
    }
    if (pendingApprovalForJob(this.config.dbPath, jobId, "resolution")) {
      throw new Error(`Job ${jobId} has a pending resolution approval; approve it to retry closure actions.`);
    }
    const actionApproval = this.jobDetails(jobId).approvals.find(approval => approval.kind === "action" && approval.status === "approved");
    const retryNote = redactText(String(note || "").trim());
    if (!retryNote) {
      const pendingAction = pendingApprovalForJob(this.config.dbPath, jobId, "action");
      if (pendingAction?.payload?.plan?.executionMode === "approved_repair_agent") {
        this.diagnostic("info", "repair_retry_same_investigation_started", {
          jobId,
          actor,
          approvalId: pendingAction.id
        });
        recordAudit(this.config.dbPath, "repair_retry_same_investigation_started", sanitizeValue({ actor, approvalId: pendingAction.id }), jobId);
        return this.approve(jobId, actor);
      }
      if (actionApproval?.payload?.plan?.executionMode === "approved_repair_agent" && ["failed_retryable", "failed_terminal"].includes(job.state)) {
        this.diagnostic("info", "repair_retry_same_investigation_started", {
          jobId,
          actor,
          approvalId: actionApproval.id
        });
        recordAudit(this.config.dbPath, "repair_retry_same_investigation_started", sanitizeValue({ actor, approvalId: actionApproval.id }), jobId);
        return this.executeApprovedPlan(jobId, actor);
      }
      throw new Error(`Job ${jobId} has no autonomous repair prompt to retry`);
    }
    if (!actionApproval || actionApproval.payload?.plan?.executionMode !== "approved_repair_agent") {
      throw new Error(`Job ${jobId} has no approved autonomous repair prompt to revise`);
    }
    this.diagnostic("info", "repair_retry_converted_to_investigation_steering", {
      jobId,
      actor,
      noteLength: retryNote.length
    });
    recordAudit(this.config.dbPath, "repair_retry_converted_to_investigation_steering", sanitizeValue({ actor, note: retryNote }), jobId);
    return this.steerInvestigation(jobId, retryNote, actor);
  }

  returnRepairToInvestigationReview(jobId, actor, message, context = {}) {
    const details = this.jobDetails(jobId);
    if (!details?.investigation) {
      setJobState(this.config.dbPath, jobId, "failed_retryable", message);
      throw new Error(`${message}; no cached investigation is available to revise.`);
    }
    const failureContext = sanitizeValue({
      actor,
      message,
      agentRunId: context.agentRunId || null,
      repairResult: context.repairResult || null,
      returnedAt: new Date().toISOString()
    });
    const evidence = sanitizeValue({
      ...(details.investigation.evidence || {}),
      previousRepairFailure: failureContext
    });
    const investigation = upsertInvestigation(this.config.dbPath, jobId, {
      status: "ready",
      summary: details.investigation.summary,
      evidence
    });
    supersedePendingApprovals(this.config.dbPath, jobId, "action");
    const approval = createApproval(this.config.dbPath, jobId, "action", buildPlan(details.job, evidence, investigation.summary));
    setJobState(this.config.dbPath, jobId, "awaiting_action_approval", message);
    this.diagnostic("warn", "repair_returned_to_investigation_review", {
      jobId,
      actor,
      approvalId: approval.id,
      agentRunId: context.agentRunId || null,
      message
    });
    recordAudit(this.config.dbPath, "repair_returned_to_investigation_review", sanitizeValue({
      actor,
      approvalId: approval.id,
      agentRunId: context.agentRunId || null,
      message
    }), jobId);
    return {
      jobId,
      status: "awaiting_action_approval",
      approvalId: approval.id,
      approvalKind: "action",
      message: "Repair did not complete. Review or steer the investigation, then approve the revised repair plan.",
      summary: investigation.summary
    };
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
      this.diagnostic("warn", "repair_tool_list_failed", {
        jobId,
        actor,
        error: error.message
      });
      recordAudit(this.config.dbPath, "repair_tool_list_failed", sanitizeValue({ actor, error: error.message }), jobId);
    }
    const payload = actionApproval.payload || {};
    const plan = payload.plan || {};
    const approvedPlan = {
      source: payload.source || details.job.source,
      issueId: payload.issueId || details.job.issueId,
      classification: plan.classification || "server_action",
      summary: payload.summary || details.investigation?.summary || "",
      operatorMessage: latestSteeringMessage(payload.evidence),
      instructions: [
        "Use media-mcp directly through the configured Codex MCP server named media.",
        "Investigate, repair, and verify the approved issue as far as the available media tools allow.",
        "Choose the media tools that fit the evidence and current tool briefing.",
        "Do not delegate media-side work back to the server owner/operator.",
        "Do not post reporter comments or close the issue; media-issue-agent will request final human approval for that."
      ]
    };
    const compactEvidence = compactForRepairPrompt({
      job: details.job,
      investigation: {
        status: details.investigation?.status,
        summary: details.investigation?.summary,
        error: details.investigation?.error,
        updatedAt: details.investigation?.updatedAt,
        evidence: details.investigation?.evidence
      },
      approvedBy: actor,
      retryRequested: Boolean(retryNote)
    });
    const prompt = repairExecutionPrompt(compactEvidence, approvedPlan, {
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
    this.diagnostic("info", "repair_prompt_prepared", {
      jobId,
      actor,
      promptLength: prompt.length,
      compactedEvidenceLength: JSON.stringify(compactEvidence).length,
      toolCount: toolBriefing?.tools?.length || 0,
      retry: Boolean(retryNote)
    });
    return { prompt, workspace, settings, toolBriefing };
  }

  async executeApprovedPlan(jobId, actor, context = {}) {
    const details = this.jobDetails(jobId);
    const actionApproval = details.approvals.find(approval => approval.kind === "action" && approval.status === "approved");
    if (!actionApproval) {
      throw new Error(`Job ${jobId} has no approved action plan`);
    }
    transitionJob(this.config.dbPath, jobId, ["approved_for_execution", "failed_retryable", "failed_terminal"], "executing");
    this.diagnostic("info", "execution_started", {
      jobId,
      actor,
      approvalId: actionApproval.id,
      classification: actionApproval.payload?.plan?.classification,
      executionMode: actionApproval.payload?.plan?.executionMode
    });
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
        verification: { status: "not_applicable", details: "No server-side repair was required." },
        missingMcpItems: []
      };
      this.diagnostic("info", "execution_completed_client_side", {
        jobId,
        actor,
        executionResult
      });
      recordAudit(this.config.dbPath, "execution_completed", sanitizeValue(executionResult), jobId);
      transitionJob(this.config.dbPath, jobId, ["executing"], "drafting_comment");
      return this.draftResolutionApproval(jobId, actor, executionResult, context);
    }
    const { prompt: repairPrompt, workspace, settings, toolBriefing } = await this.buildExecutionRepairPrompt(jobId, actor, actionApproval, context);
    const agentRun = createAgentRun(this.config.dbPath, jobId, "repair", repairPrompt, settings);
    this.diagnostic("info", "repair_agent_started", {
      jobId,
      actor,
      runId: agentRun.id,
      settings,
      workspace,
      toolCount: toolBriefing?.tools?.length || 0,
      retry: Boolean(context.repairRetryNote)
    });
    recordAudit(this.config.dbPath, "repair_agent_started", sanitizeValue({ actor, runId: agentRun.id, settings, workspace, toolCount: toolBriefing?.tools?.length || 0, retry: Boolean(context.repairRetryNote) }), jobId);
    let completedRun = null;
    let repairResult = null;
    const heartbeatMs = Math.max(5000, Math.min(30000, Math.floor((this.config.recoverStaleRunSeconds || 120) * 1000 / 3)));
    const heartbeatTimer = setInterval(() => {
      try {
        touchAgentRun(this.config.dbPath, agentRun.id);
      } catch {
        // Best-effort heartbeat; the repair run itself remains authoritative.
      }
    }, heartbeatMs);
    heartbeatTimer.unref?.();
    try {
      const output = await runCodexRepair(this.config, repairPrompt, settings, {
        codexWorkspace: workspace,
        onEvent: event => {
          const eventType = event?.type || "event";
          recordAgentRunEvent(this.config.dbPath, agentRun.id, jobId, eventType, sanitizeValue(compactAgentRunEventForStorage(event)));
          this.diagnostic("debug", "repair_agent_event", {
            jobId,
            runId: agentRun.id,
            eventType,
            event
          });
        }
      });
      recordAgentRunEvent(this.config.dbPath, agentRun.id, jobId, "codex_exit", sanitizeValue({
        args: output.args,
        settings: output.settings,
        stderr: output.stderr
      }));
      this.diagnostic("info", "repair_agent_codex_exit", {
        jobId,
        runId: agentRun.id,
        settings: output.settings,
        stderrLength: String(output.stderr || "").length
      });
      repairResult = parseRepairResult(output.finalMessage);
      const savedMissingMcpItems = upsertMissingMcpItems(this.config.dbPath, jobId, agentRun.id, repairResult.missingMcpItems || []);
      if (savedMissingMcpItems.length) {
        this.diagnostic("info", "missing_mcp_items_recorded", {
          jobId,
          runId: agentRun.id,
          count: savedMissingMcpItems.length,
          items: savedMissingMcpItems.map(item => ({
            id: item.id,
            title: item.title,
            suggestedToolName: item.suggestedToolName || null
          }))
        });
        recordAudit(this.config.dbPath, "missing_mcp_items_recorded", sanitizeValue({
          runId: agentRun.id,
          items: savedMissingMcpItems.map(item => ({
            id: item.id,
            title: item.title,
            description: item.description,
            suggestedToolName: item.suggestedToolName || null,
            category: item.category || null
          }))
        }), jobId);
      }
      if (textDelegatesOwnerWork(repairResult.summary, repairResult.draftComment, repairResult.actionsTaken.join("\n"))) {
        throw new Error("Repair runner delegated media-side work back to the server owner/operator instead of attempting it.");
      }
      completedRun = completeAgentRun(this.config.dbPath, agentRun.id, repairResult.status, repairResult, null);
      this.diagnostic("info", "repair_agent_final_result", {
        jobId,
        runId: agentRun.id,
        status: repairResult.status,
        summary: repairResult.summary,
        verification: repairResult.verification,
        actionCount: repairResult.actionsTaken.length,
        missingMcpItemCount: repairResult.missingMcpItems.length,
        closeRecommended: repairResult.closeRecommended
      });
      if (repairResult.status === "needs_operator_decision") {
        const message = repairResult.summary || "Repair runner needs an operator decision before continuing.";
        this.diagnostic("warn", "repair_agent_needs_operator_decision", {
          jobId,
          runId: agentRun.id,
          message,
          proposedChoices: repairResult.proposedChoices
        });
        recordAudit(this.config.dbPath, "repair_agent_needs_operator_decision", sanitizeValue({ actor, runId: agentRun.id, repairResult }), jobId);
        return this.returnRepairToInvestigationReview(jobId, actor, redactText(message), {
          agentRunId: agentRun.id,
          repairResult
        });
      }
      if (repairResult.status === "failed_retryable" || repairResult.status === "failed_terminal") {
        const message = repairResult.summary || `Repair runner returned ${repairResult.status}`;
        this.diagnostic("error", "repair_agent_failed_status", {
          jobId,
          runId: agentRun.id,
          status: repairResult.status,
          message,
          verification: repairResult.verification,
          missingMcpItemCount: repairResult.missingMcpItems.length
        });
        recordAudit(this.config.dbPath, "repair_agent_failed", sanitizeValue({ actor, runId: agentRun.id, repairResult }), jobId);
        return this.returnRepairToInvestigationReview(jobId, actor, redactText(message), {
          agentRunId: agentRun.id,
          repairResult
        });
      }
    } catch (error) {
      const message = redactText(error.message);
      if (!completedRun) {
        completeAgentRun(this.config.dbPath, agentRun.id, "failed_retryable", null, message);
      }
      recordAgentRunEvent(this.config.dbPath, agentRun.id, jobId, "repair_failed", sanitizeValue({ error: error.message }));
      this.diagnostic("error", "repair_agent_error", {
        jobId,
        runId: agentRun.id,
        error: error.message
      });
      recordAudit(this.config.dbPath, "execution_failed", sanitizeValue({ actor, runId: agentRun.id, error: error.message }), jobId);
      const current = jobForId(this.config.dbPath, jobId);
      if (current?.state !== "awaiting_action_approval") {
        return this.returnRepairToInvestigationReview(jobId, actor, message, {
          agentRunId: agentRun.id,
          repairResult
        });
      }
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
    }
    const executionResult = executionResultFromRepairResult(repairResult, completedRun || agentRun);
    this.diagnostic("info", "execution_completed", {
      jobId,
      runId: agentRun.id,
      outcome: executionResult.outcome,
      actionsRequested: executionResult.actionsRequested,
      actionsExecuted: executionResult.actionsExecuted,
      verification: executionResult.verification
    });
    recordAudit(this.config.dbPath, "execution_completed", sanitizeValue(executionResult), jobId);
    transitionSuccessfulRepairToDrafting(this.config.dbPath, jobId, completedRun || agentRun, repairResult);
    return this.draftResolutionApproval(jobId, actor, executionResult, context);
  }

  async draftResolutionApproval(jobId, actor, executionResult, context = {}) {
    await validateCodexHome(this.config.codexHome);
    const details = this.jobDetails(jobId);
    if (!details.investigation) {
      throw new Error(`Job ${jobId} has no investigation to draft from`);
    }
    this.diagnostic("info", "resolution_draft_started", {
      jobId,
      actor,
      outcome: executionResult?.outcome
    });
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
        this.diagnostic("error", "codex_comment_draft_failed", {
          jobId,
          error: error.message
        });
        recordAudit(this.config.dbPath, "codex_comment_draft_failed", sanitizeValue({ error: error.message }), jobId);
        draft = fallbackDraftComment(details.job.source, executionResult);
      }
    }
    if (textDelegatesOwnerWork(draft)) {
      const note = "Draft resolution delegated media-side work back to the server owner/operator.";
      this.diagnostic("error", "resolution_draft_rejected", {
        jobId,
        actor,
        reason: note
      });
      recordAudit(this.config.dbPath, "resolution_draft_rejected", sanitizeValue({ actor, message: draft }), jobId);
      return this.returnRepairToInvestigationReview(jobId, actor, note, {
        agentRunId: executionResult?.agentRunId || null,
        repairResult: executionResult
      });
    }
    const message = normalizeDraftComment(details.job.source, draft, executionResult);
    if (textDelegatesOwnerWork(message)) {
      const note = "Draft resolution delegated media-side work back to the server owner/operator.";
      this.diagnostic("error", "resolution_draft_rejected", {
        jobId,
        actor,
        reason: note
      });
      recordAudit(this.config.dbPath, "resolution_draft_rejected", sanitizeValue({ actor, message }), jobId);
      return this.returnRepairToInvestigationReview(jobId, actor, note, {
        agentRunId: executionResult?.agentRunId || null,
        repairResult: executionResult
      });
    }
    const validation = validateDraftComment(details.job.source, message);
    if (!validation.valid) {
      const note = validation.errors.join("; ");
      this.diagnostic("error", "resolution_draft_validation_failed", {
        jobId,
        actor,
        errors: validation.errors
      });
      recordAudit(this.config.dbPath, "resolution_draft_validation_failed", sanitizeValue({ actor, errors: validation.errors }), jobId);
      return this.returnRepairToInvestigationReview(jobId, actor, note, {
        agentRunId: executionResult?.agentRunId || null,
        repairResult: executionResult
      });
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
    this.diagnostic("info", "resolution_draft_ready", {
      jobId,
      approvalId: approval.id,
      actor,
      characterCount: validation.characterCount,
      closeIssue: approval.payload.closeIssue
    });
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
    this.diagnostic("info", "issue_close_started", {
      jobId,
      actor,
      approvalId: approval.id,
      source,
      issueId,
      closeIssue,
      actionCount: actions.length
    });
    try {
      const executedActions = this.jobDetails(jobId).plannedActions.filter(action => action.riskLevel === "resolution" && action.executedAt);
      for (const action of actions) {
        const alreadyExecuted = executedActions.find(executed => executed.toolName === action.toolName && JSON.stringify(executed.args) === JSON.stringify(action.args));
        if (alreadyExecuted) {
          results.push({ action: alreadyExecuted, result: alreadyExecuted.result, skipped: true });
          continue;
        }
        const planned = createPlannedAction(this.config.dbPath, jobId, action.toolName, action.args, "resolution");
        this.diagnostic("debug", "closing_action_started", {
          jobId,
          toolName: action.toolName
        });
        recordAudit(this.config.dbPath, "closing_action_started", sanitizeValue({ action: planned }), jobId);
        const result = await this.client.callTool(action.toolName, action.args);
        const sanitized = sanitizeValue(result);
        markPlannedActionExecuted(this.config.dbPath, planned.id, sanitized, false);
        results.push({ action: planned, result: sanitized });
      }
      if (closeIssue) {
        transitionJob(this.config.dbPath, jobId, ["closing_issue"], "closed");
        this.diagnostic("info", "issue_closed", {
          jobId,
          actor,
          actionCount: results.length
        });
        recordAudit(this.config.dbPath, "issue_closed", sanitizeValue({ actor, results }), jobId);
      } else {
        const note = "Repair result did not recommend closing the issue; posted the approved update and left the job for human follow-up.";
        transitionJob(this.config.dbPath, jobId, ["closing_issue"], "blocked_needs_human", note);
        this.diagnostic("warn", "resolution_comment_posted_without_closure", {
          jobId,
          actor,
          actionCount: results.length,
          note
        });
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
      this.diagnostic("error", "issue_close_failed", {
        jobId,
        actor,
        error: error.message,
        completedActionCount: results.length
      });
      recordAudit(this.config.dbPath, "issue_close_failed", sanitizeValue({ actor, error: error.message, results }), jobId);
      throw error;
    }
  }

  async pollLoop(log = console.error) {
    await this.init();
    this.diagnostic("info", "poll_loop_started", { pollIntervalSeconds: this.config.pollIntervalSeconds });
    log(`${new Date().toISOString()} media-issue-agent: starting poll loop`);
    for (;;) {
      try {
        const result = await this.pollOnce();
        log(`${new Date().toISOString()} media-issue-agent: snapshot ${result.snapshotId} recorded with ${result.openIssueCount} open and ${result.closedIssueCount} closed issues`);
      } catch (error) {
        if (isInterruptedPollError(error)) {
          this.diagnostic("warn", "poll_interrupted", {
            error: error.message,
            name: error.name,
            code: error.code,
            pollIntervalSeconds: this.config.pollIntervalSeconds
          });
          log(`${new Date().toISOString()} media-issue-agent: poll interrupted; retrying next interval: ${redactText(error.message)}`);
        } else {
          this.diagnostic("error", "poll_failed", { error: error.message });
          log(`${new Date().toISOString()} media-issue-agent: poll failed: ${redactText(error.message)}`);
        }
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
