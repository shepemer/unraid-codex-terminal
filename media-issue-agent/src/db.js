import crypto from "node:crypto";
import { ensureDbDir, sql, sqliteExec } from "./sqlite.js";

export const JOB_STATES = new Set([
  "detected",
  "queued_for_investigation",
  "investigating",
  "awaiting_action_approval",
  "approved_for_execution",
  "executing",
  "waiting_for_plex_verification",
  "drafting_comment",
  "awaiting_comment_approval",
  "awaiting_resolution_approval",
  "posting_comment",
  "closing_issue",
  "closed",
  "dry_run_complete",
  "blocked_needs_human",
  "failed_retryable",
  "failed_terminal"
]);

export async function initDb(dbPath) {
  await ensureDbDir(dbPath);
  sqliteExec(dbPath, `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS issue_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  markdown TEXT NOT NULL,
  source_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_snapshot_entries (
  snapshot_id INTEGER NOT NULL REFERENCES issue_snapshots(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  source TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  date TEXT,
  reporter TEXT,
  media_title TEXT,
  status TEXT,
  description TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, idx)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  locked_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE (source, issue_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  channel TEXT,
  message_id TEXT,
  token_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS planned_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  dry_run_result_json TEXT,
  approved_at TEXT,
  executed_at TEXT,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS verification_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  check_type TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  event_type TEXT NOT NULL,
  redacted_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS investigations (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  config_json TEXT NOT NULL,
  final_result_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS missing_mcp_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  agent_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  suggested_tool_name TEXT,
  category TEXT,
  source_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dismissed_at TEXT
);
`);
  ensureColumn(dbPath, "agent_runs", "heartbeat_at", "TEXT");
  sqliteExec(dbPath, `
UPDATE agent_runs
SET heartbeat_at = COALESCE(heartbeat_at, started_at)
WHERE heartbeat_at IS NULL;
`);
}

function ensureColumn(dbPath, tableName, columnName, definition) {
  const columns = sqliteExec(dbPath, `PRAGMA table_info(${tableName});`, { json: true });
  if (columns.some(column => column.name === columnName)) {
    return;
  }
  sqliteExec(dbPath, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
}

export function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function getSetting(dbPath, key, fallback = null) {
  const rows = sqliteExec(dbPath, sql`
SELECT value_json AS valueJson
FROM settings
WHERE key = ${key}
LIMIT 1;
`, { json: true });
  return rows[0] ? parseJson(rows[0].valueJson, fallback) : fallback;
}

export function setSetting(dbPath, key, value) {
  sqliteExec(dbPath, sql`
INSERT INTO settings (key, value_json)
VALUES (${key}, ${JSON.stringify(value)})
ON CONFLICT(key) DO UPDATE SET
  value_json = excluded.value_json,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
`);
  return getSetting(dbPath, key);
}

export function insertSnapshot(dbPath, markdown, entries) {
  const sourceHash = stableHash(entries.map(entry => ({
    source: entry.source,
    issueId: String(entry.issueId),
    status: entry.status,
    updatedAt: entry.updatedAt,
    createdAt: entry.createdAt
  })));
  const [{ id }] = sqliteExec(dbPath, sql`
INSERT INTO issue_snapshots (markdown, source_hash)
VALUES (${markdown}, ${sourceHash})
RETURNING id;
`, { json: true });

  const rows = entries.map((entry, index) => sql`
INSERT INTO issue_snapshot_entries (
  snapshot_id, idx, source, issue_id, date, reporter, media_title, status, description, raw_json
) VALUES (
  ${id},
  ${index + 1},
  ${entry.source},
  ${String(entry.issueId)},
  ${entry.date || ""},
  ${entry.reporter || ""},
  ${entry.mediaTitle || ""},
  ${entry.status || ""},
  ${entry.description || ""},
  ${JSON.stringify(entry.raw || entry)}
);
`).join("\n");
  sqliteExec(dbPath, `BEGIN;\n${rows}\nCOMMIT;`);
  return { id, sourceHash };
}

export function pruneSnapshots(dbPath, keep = 200) {
  const capped = Math.max(1, Number(keep || 200));
  sqliteExec(dbPath, sql`
DELETE FROM issue_snapshot_entries
WHERE snapshot_id NOT IN (
  SELECT id FROM issue_snapshots ORDER BY id DESC LIMIT ${capped}
);
DELETE FROM issue_snapshots
WHERE id NOT IN (
  SELECT id FROM issue_snapshots ORDER BY id DESC LIMIT ${capped}
);
  `);
}

export function latestSnapshot(dbPath) {
  const rows = sqliteExec(dbPath, `
SELECT id, generated_at AS generatedAt, markdown, source_hash AS sourceHash
FROM issue_snapshots
ORDER BY id DESC
LIMIT 1;
`, { json: true });
  return rows[0] || null;
}

export function snapshotEntry(dbPath, snapshotId, index) {
  const rows = sqliteExec(dbPath, sql`
SELECT
  issue_snapshot_entries.snapshot_id AS snapshotId,
  issue_snapshot_entries.idx,
  issue_snapshot_entries.source,
  issue_snapshot_entries.issue_id AS issueId,
  issue_snapshot_entries.date,
  issue_snapshot_entries.reporter,
  issue_snapshot_entries.media_title AS mediaTitle,
  issue_snapshot_entries.status,
  issue_snapshot_entries.description,
  issue_snapshot_entries.raw_json AS rawJson,
  jobs.id AS jobId,
  jobs.state AS jobState,
  investigations.status AS investigationStatus,
  investigations.summary AS investigationSummary,
  investigations.error AS investigationError,
  investigations.updated_at AS investigationUpdatedAt,
  EXISTS (
    SELECT 1
    FROM approvals
    WHERE approvals.job_id = jobs.id
      AND approvals.kind = 'action'
      AND approvals.status = 'approved'
      AND approvals.payload_json LIKE '%"executionMode":"approved_repair_agent"%'
  ) AS hasApprovedRepair
FROM issue_snapshot_entries
LEFT JOIN jobs
  ON jobs.source = issue_snapshot_entries.source
 AND jobs.issue_id = issue_snapshot_entries.issue_id
LEFT JOIN investigations
  ON investigations.job_id = jobs.id
WHERE issue_snapshot_entries.snapshot_id = ${snapshotId} AND issue_snapshot_entries.idx = ${index}
LIMIT 1;
`, { json: true });
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { ...row, hasApprovedRepair: Boolean(row.hasApprovedRepair), raw: JSON.parse(row.rawJson) };
}

export function snapshotEntries(dbPath, snapshotId) {
  return sqliteExec(dbPath, sql`
SELECT
  issue_snapshot_entries.snapshot_id AS snapshotId,
  issue_snapshot_entries.idx,
  issue_snapshot_entries.source,
  issue_snapshot_entries.issue_id AS issueId,
  issue_snapshot_entries.date,
  issue_snapshot_entries.reporter,
  issue_snapshot_entries.media_title AS mediaTitle,
  issue_snapshot_entries.status,
  issue_snapshot_entries.description,
  issue_snapshot_entries.raw_json AS rawJson,
  jobs.id AS jobId,
  jobs.state AS jobState,
  investigations.status AS investigationStatus,
  investigations.summary AS investigationSummary,
  investigations.error AS investigationError,
  investigations.updated_at AS investigationUpdatedAt,
  EXISTS (
    SELECT 1
    FROM approvals
    WHERE approvals.job_id = jobs.id
      AND approvals.kind = 'action'
      AND approvals.status = 'approved'
      AND approvals.payload_json LIKE '%"executionMode":"approved_repair_agent"%'
  ) AS hasApprovedRepair
FROM issue_snapshot_entries
LEFT JOIN jobs
  ON jobs.source = issue_snapshot_entries.source
 AND jobs.issue_id = issue_snapshot_entries.issue_id
LEFT JOIN investigations
  ON investigations.job_id = jobs.id
WHERE issue_snapshot_entries.snapshot_id = ${snapshotId}
ORDER BY issue_snapshot_entries.idx;
`, { json: true }).map(row => ({ ...row, hasApprovedRepair: Boolean(row.hasApprovedRepair), raw: JSON.parse(row.rawJson) }));
}

export function ensureJob(dbPath, source, issueId, state = "detected") {
  if (!JOB_STATES.has(state)) {
    throw new Error(`Unknown job state ${state}`);
  }
  sqliteExec(dbPath, sql`
INSERT OR IGNORE INTO jobs (source, issue_id, state)
VALUES (${source}, ${String(issueId)}, ${state});
UPDATE jobs
SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source = ${source} AND issue_id = ${String(issueId)};
`);
  return sqliteExec(dbPath, sql`
SELECT id, source, issue_id AS issueId, state, attempts, last_error AS lastError
FROM jobs
WHERE source = ${source} AND issue_id = ${String(issueId)}
LIMIT 1;
`, { json: true })[0];
}

export function transitionJob(dbPath, jobId, fromStates, toState, lastError = null) {
  if (!JOB_STATES.has(toState)) {
    throw new Error(`Unknown job state ${toState}`);
  }
  const allowed = new Set(Array.isArray(fromStates) ? fromStates : [fromStates]);
  const current = sqliteExec(dbPath, sql`
SELECT id, state FROM jobs WHERE id = ${jobId} LIMIT 1;
`, { json: true })[0];
  if (!current) {
    throw new Error(`Job ${jobId} was not found`);
  }
  if (!allowed.has(current.state)) {
    throw new Error(`Cannot transition job ${jobId} from ${current.state} to ${toState}`);
  }
  sqliteExec(dbPath, sql`
UPDATE jobs
SET state = ${toState},
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_error = ${lastError}
WHERE id = ${jobId};
`);
  return { ...current, state: toState };
}

export function setJobState(dbPath, jobId, state, lastError = null) {
  if (!JOB_STATES.has(state)) {
    throw new Error(`Unknown job state ${state}`);
  }
  const current = sqliteExec(dbPath, sql`
SELECT id, state FROM jobs WHERE id = ${jobId} LIMIT 1;
`, { json: true })[0];
  if (!current) {
    throw new Error(`Job ${jobId} was not found`);
  }
  sqliteExec(dbPath, sql`
UPDATE jobs
SET state = ${state},
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_error = ${lastError}
WHERE id = ${jobId};
`);
  return { ...current, state };
}

export function createApproval(dbPath, jobId, kind, payload, channel = "cli") {
  const payloadJson = JSON.stringify(payload);
  const tokenHash = stableHash({ jobId, kind, payload });
  const [{ id }] = sqliteExec(dbPath, sql`
INSERT INTO approvals (job_id, kind, status, channel, token_hash, payload_json)
VALUES (${jobId}, ${kind}, 'pending', ${channel}, ${tokenHash}, ${payloadJson})
RETURNING id;
`, { json: true });
  return { id, jobId, kind, status: "pending", tokenHash, payload };
}

export function pendingApprovalForJob(dbPath, jobId, kind = "action") {
  const rows = sqliteExec(dbPath, sql`
SELECT id, job_id AS jobId, kind, status, channel, token_hash AS tokenHash, payload_json AS payloadJson
FROM approvals
WHERE job_id = ${jobId} AND kind = ${kind} AND status = 'pending'
ORDER BY id DESC
LIMIT 1;
`, { json: true });
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { ...row, payload: JSON.parse(row.payloadJson) };
}

export function pendingApprovalForJobAnyKind(dbPath, jobId) {
  const rows = sqliteExec(dbPath, sql`
SELECT id, job_id AS jobId, kind, status, channel, token_hash AS tokenHash, payload_json AS payloadJson
FROM approvals
WHERE job_id = ${jobId} AND status = 'pending'
ORDER BY id DESC
LIMIT 1;
`, { json: true });
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { ...row, payload: JSON.parse(row.payloadJson) };
}

export function supersedePendingApprovals(dbPath, jobId, kind = "action") {
  sqliteExec(dbPath, sql`
UPDATE approvals
SET status = 'superseded'
WHERE job_id = ${jobId} AND kind = ${kind} AND status = 'pending';
`);
}

export function upsertInvestigation(dbPath, jobId, { status, summary, evidence, error = null }) {
  sqliteExec(dbPath, sql`
INSERT INTO investigations (job_id, status, summary, evidence_json, error)
VALUES (${jobId}, ${status}, ${summary}, ${JSON.stringify(evidence || {})}, ${error})
ON CONFLICT(job_id) DO UPDATE SET
  status = excluded.status,
  summary = excluded.summary,
  evidence_json = excluded.evidence_json,
  error = excluded.error,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
`);
  return investigationForJob(dbPath, jobId);
}

export function investigationForJob(dbPath, jobId) {
  const rows = sqliteExec(dbPath, sql`
SELECT
  job_id AS jobId,
  status,
  summary,
  evidence_json AS evidenceJson,
  error,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM investigations
WHERE job_id = ${jobId}
LIMIT 1;
`, { json: true });
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { ...row, evidence: JSON.parse(row.evidenceJson) };
}

export function createAgentRun(dbPath, jobId, kind, prompt, config) {
  const [{ id }] = sqliteExec(dbPath, sql`
INSERT INTO agent_runs (job_id, kind, status, prompt, config_json, heartbeat_at)
VALUES (${jobId}, ${kind}, 'running', ${prompt}, ${JSON.stringify(config || {})}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
RETURNING id;
`, { json: true });
  return { id, jobId, kind, status: "running", prompt, config: config || {} };
}

export function touchAgentRun(dbPath, runId) {
  sqliteExec(dbPath, sql`
UPDATE agent_runs
SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${runId} AND status = 'running';
`);
}

export function completeAgentRun(dbPath, runId, status, finalResult = null, error = null) {
  sqliteExec(dbPath, sql`
UPDATE agent_runs
SET status = ${status},
    final_result_json = ${finalResult === null || finalResult === undefined ? null : JSON.stringify(finalResult)},
    error = ${error},
    heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${runId};
`);
  return sqliteExec(dbPath, sql`
SELECT
	  id,
	  job_id AS jobId,
	  kind,
	  status,
	  config_json AS configJson,
	  final_result_json AS finalResultJson,
	  error,
  started_at AS startedAt,
  heartbeat_at AS heartbeatAt,
  completed_at AS completedAt
FROM agent_runs
WHERE id = ${runId}
LIMIT 1;
`, { json: true }).map(row => ({
    ...row,
    config: parseJson(row.configJson, {}),
    finalResult: parseJson(row.finalResultJson, null)
  }))[0] || null;
}

export function recoverInterruptedAgentRuns(dbPath, options = {}) {
  const staleSeconds = Math.max(1, Number(options.staleSeconds || 120));
  const message = options.message || "Media issue agent restarted while repair was running. Retry the repair from the job detail pane.";
  const runs = sqliteExec(dbPath, sql`
SELECT id, job_id AS jobId, started_at AS startedAt, heartbeat_at AS heartbeatAt
FROM agent_runs
WHERE status = 'running'
  AND julianday(COALESCE(heartbeat_at, started_at)) <= julianday('now') - (${staleSeconds} / 86400.0);
`, { json: true });
  for (const run of runs) {
    completeAgentRun(dbPath, run.id, "failed_retryable", null, message);
    recordAgentRunEvent(dbPath, run.id, run.jobId, "repair_recovered_after_restart", {
      error: message,
      staleSeconds,
      lastHeartbeatAt: run.heartbeatAt || run.startedAt
    });
    recordAudit(dbPath, "interrupted_repair_run_recovered", {
      runId: run.id,
      error: message,
      staleSeconds,
      lastHeartbeatAt: run.heartbeatAt || run.startedAt
    }, run.jobId);
    sqliteExec(dbPath, sql`
UPDATE jobs
SET state = 'failed_retryable',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_error = ${message}
WHERE id = ${run.jobId}
  AND state IN ('approved_for_execution', 'executing', 'waiting_for_plex_verification', 'drafting_comment');
`);
  }
  return runs.length;
}

export function recordAgentRunEvent(dbPath, runId, jobId, eventType, payload) {
  sqliteExec(dbPath, sql`
INSERT INTO agent_run_events (run_id, job_id, event_type, payload_json)
VALUES (${runId}, ${jobId}, ${eventType}, ${JSON.stringify(payload || {})});
`);
  touchAgentRun(dbPath, runId);
}

function normalizeMissingMcpDbItem(item) {
  const title = String(item?.title || item?.capability || item?.suggestedToolName || "").trim();
  const description = String(item?.description || item?.reason || title || "").trim();
  if (!title && !description) {
    return null;
  }
  const normalized = {
    title: title || description.slice(0, 120),
    description: description || title,
    suggestedToolName: String(item?.suggestedToolName || item?.toolName || "").trim(),
    category: String(item?.category || item?.type || "").trim(),
    source: item || {}
  };
  normalized.fingerprint = stableHash({
    title: normalized.title.toLowerCase(),
    description: normalized.description.toLowerCase(),
    suggestedToolName: normalized.suggestedToolName.toLowerCase(),
    category: normalized.category.toLowerCase()
  });
  return normalized;
}

export function upsertMissingMcpItems(dbPath, jobId, agentRunId, items = []) {
  const saved = [];
  for (const rawItem of items || []) {
    const item = normalizeMissingMcpDbItem(rawItem);
    if (!item) {
      continue;
    }
    const [row] = sqliteExec(dbPath, sql`
INSERT INTO missing_mcp_items (
  job_id, agent_run_id, fingerprint, title, description, suggested_tool_name, category, source_json
) VALUES (
  ${jobId || null},
  ${agentRunId || null},
  ${item.fingerprint},
  ${item.title},
  ${item.description},
  ${item.suggestedToolName || null},
  ${item.category || null},
  ${JSON.stringify(item.source)}
)
ON CONFLICT(fingerprint) DO UPDATE SET
  job_id = excluded.job_id,
  agent_run_id = excluded.agent_run_id,
  title = excluded.title,
  description = excluded.description,
  suggested_tool_name = excluded.suggested_tool_name,
  category = excluded.category,
  source_json = excluded.source_json,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  dismissed_at = NULL
RETURNING
  id,
  job_id AS jobId,
  agent_run_id AS agentRunId,
  fingerprint,
  title,
  description,
  suggested_tool_name AS suggestedToolName,
  category,
  source_json AS sourceJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  dismissed_at AS dismissedAt;
`, { json: true });
    if (row) {
      saved.push({ ...row, source: parseJson(row.sourceJson, {}) });
    }
  }
  return saved;
}

function mapMissingMcpItem(row) {
  return {
    ...row,
    source: parseJson(row.sourceJson, {})
  };
}

export function listMissingMcpItems(dbPath, options = {}) {
  const includeDismissed = Boolean(options.includeDismissed);
  const rows = sqliteExec(dbPath, `
SELECT
  missing_mcp_items.id,
  missing_mcp_items.job_id AS jobId,
  missing_mcp_items.agent_run_id AS agentRunId,
  missing_mcp_items.fingerprint,
  missing_mcp_items.title,
  missing_mcp_items.description,
  missing_mcp_items.suggested_tool_name AS suggestedToolName,
  missing_mcp_items.category,
  missing_mcp_items.source_json AS sourceJson,
  missing_mcp_items.created_at AS createdAt,
  missing_mcp_items.updated_at AS updatedAt,
  missing_mcp_items.dismissed_at AS dismissedAt,
  jobs.source AS jobSource,
  jobs.issue_id AS jobIssueId,
  jobs.state AS jobState
FROM missing_mcp_items
LEFT JOIN jobs ON jobs.id = missing_mcp_items.job_id
WHERE ${includeDismissed ? "1 = 1" : "missing_mcp_items.dismissed_at IS NULL"}
ORDER BY missing_mcp_items.updated_at DESC, missing_mcp_items.id DESC;
`, { json: true });
  return rows.map(mapMissingMcpItem);
}

export function missingMcpItemsForJob(dbPath, jobId) {
  const rows = sqliteExec(dbPath, sql`
SELECT
  id,
  job_id AS jobId,
  agent_run_id AS agentRunId,
  fingerprint,
  title,
  description,
  suggested_tool_name AS suggestedToolName,
  category,
  source_json AS sourceJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  dismissed_at AS dismissedAt
FROM missing_mcp_items
WHERE job_id = ${jobId}
  AND dismissed_at IS NULL
ORDER BY updated_at DESC, id DESC;
`, { json: true });
  return rows.map(mapMissingMcpItem);
}

export function dismissMissingMcpItem(dbPath, itemId) {
  const [row] = sqliteExec(dbPath, sql`
UPDATE missing_mcp_items
SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${itemId}
RETURNING
  id,
  job_id AS jobId,
  agent_run_id AS agentRunId,
  fingerprint,
  title,
  description,
  suggested_tool_name AS suggestedToolName,
  category,
  source_json AS sourceJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  dismissed_at AS dismissedAt;
`, { json: true });
  return row ? mapMissingMcpItem(row) : null;
}

export function setPendingApprovals(dbPath, jobId, status, actor = "operator", kind = null) {
  if (!["approved", "rejected"].includes(status)) {
    throw new Error(`Unsupported approval status ${status}`);
  }
  const update = kind ? sql`
UPDATE approvals
SET status = ${status},
    approved_by = ${actor},
    approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE job_id = ${jobId} AND kind = ${kind} AND status = 'pending';
` : sql`
UPDATE approvals
SET status = ${status},
    approved_by = ${actor},
    approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE job_id = ${jobId} AND status = 'pending';
`;
  sqliteExec(dbPath, update);
  return sqliteExec(dbPath, sql`
SELECT id, job_id AS jobId, kind, status, channel, token_hash AS tokenHash
FROM approvals
WHERE job_id = ${jobId}
ORDER BY id;
`, { json: true });
}

export function jobForId(dbPath, jobId) {
  return sqliteExec(dbPath, sql`
SELECT
  id,
  source,
  issue_id AS issueId,
  state,
  created_at AS createdAt,
  updated_at AS updatedAt,
  attempts,
  last_error AS lastError
FROM jobs
WHERE id = ${jobId}
LIMIT 1;
`, { json: true })[0] || null;
}

export function jobDetails(dbPath, jobId) {
  const job = jobForId(dbPath, jobId);
  if (!job) {
    return null;
  }
  const investigation = investigationForJob(dbPath, jobId);
  const approvals = sqliteExec(dbPath, sql`
SELECT
  id,
  job_id AS jobId,
  kind,
  status,
  channel,
  approved_by AS approvedBy,
  approved_at AS approvedAt,
  created_at AS createdAt,
  payload_json AS payloadJson
FROM approvals
WHERE job_id = ${jobId}
ORDER BY id DESC;
`, { json: true }).map(row => ({ ...row, payload: JSON.parse(row.payloadJson) }));
  const plannedActions = sqliteExec(dbPath, sql`
SELECT
  id,
  job_id AS jobId,
  tool_name AS toolName,
  args_json AS argsJson,
  risk_level AS riskLevel,
  dry_run_result_json AS dryRunResultJson,
  approved_at AS approvedAt,
  executed_at AS executedAt,
  result_json AS resultJson
FROM planned_actions
WHERE job_id = ${jobId}
ORDER BY id DESC;
`, { json: true }).map(row => ({
    ...row,
    args: JSON.parse(row.argsJson),
    dryRunResult: row.dryRunResultJson ? JSON.parse(row.dryRunResultJson) : null,
    result: row.resultJson ? JSON.parse(row.resultJson) : null
  }));
  const verificationChecks = sqliteExec(dbPath, sql`
SELECT
  id,
  job_id AS jobId,
  check_type AS checkType,
  criteria_json AS criteriaJson,
  status,
  started_at AS startedAt,
  completed_at AS completedAt
FROM verification_checks
WHERE job_id = ${jobId}
ORDER BY id DESC;
`, { json: true }).map(row => ({ ...row, criteria: JSON.parse(row.criteriaJson) }));
  const auditEvents = sqliteExec(dbPath, sql`
SELECT
  id,
  event_type AS eventType,
  redacted_payload_json AS redactedPayloadJson,
  created_at AS createdAt
FROM audit_events
WHERE job_id = ${jobId}
ORDER BY id DESC
LIMIT 25;
`, { json: true }).map(row => ({ ...row, redactedPayload: JSON.parse(row.redactedPayloadJson) }));
  const agentRuns = sqliteExec(dbPath, sql`
SELECT
  id,
  job_id AS jobId,
  kind,
  status,
  prompt,
  config_json AS configJson,
  final_result_json AS finalResultJson,
  error,
  started_at AS startedAt,
  heartbeat_at AS heartbeatAt,
  completed_at AS completedAt
FROM agent_runs
WHERE job_id = ${jobId}
ORDER BY id DESC
LIMIT 10;
`, { json: true }).map(row => ({
    ...row,
    config: parseJson(row.configJson, {}),
    finalResult: parseJson(row.finalResultJson, null)
  }));
  const agentRunEvents = sqliteExec(dbPath, sql`
SELECT
  id,
  run_id AS runId,
  job_id AS jobId,
  event_type AS eventType,
  payload_json AS payloadJson,
  created_at AS createdAt
FROM agent_run_events
WHERE job_id = ${jobId}
ORDER BY id DESC
LIMIT 50;
`, { json: true }).map(row => ({ ...row, payload: parseJson(row.payloadJson, {}) }));
  const missingMcpItems = missingMcpItemsForJob(dbPath, jobId);
  return { job, investigation, approvals, plannedActions, verificationChecks, auditEvents, agentRuns, agentRunEvents, missingMcpItems };
}

export function createPlannedAction(dbPath, jobId, toolName, args, riskLevel = "comment") {
  const [{ id }] = sqliteExec(dbPath, sql`
INSERT INTO planned_actions (job_id, tool_name, args_json, risk_level)
VALUES (${jobId}, ${toolName}, ${JSON.stringify(args)}, ${riskLevel})
RETURNING id;
`, { json: true });
  return { id, jobId, toolName, args, riskLevel };
}

export function markPlannedActionExecuted(dbPath, actionId, result, dryRun = false) {
  if (dryRun) {
    sqliteExec(dbPath, sql`
UPDATE planned_actions
SET dry_run_result_json = ${JSON.stringify(result)}
WHERE id = ${actionId};
`);
  } else {
    sqliteExec(dbPath, sql`
UPDATE planned_actions
SET executed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    result_json = ${JSON.stringify(result)}
WHERE id = ${actionId};
`);
  }
}

export function createVerificationCheck(dbPath, jobId, checkType, criteria, status = "running") {
  const [{ id }] = sqliteExec(dbPath, sql`
INSERT INTO verification_checks (job_id, check_type, criteria_json, status, started_at)
VALUES (${jobId}, ${checkType}, ${JSON.stringify(criteria || {})}, ${status}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
RETURNING id;
`, { json: true });
  return { id, jobId, checkType, criteria, status };
}

export function completeVerificationCheck(dbPath, checkId, status) {
  sqliteExec(dbPath, sql`
UPDATE verification_checks
SET status = ${status},
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${checkId};
`);
}

export function recordAudit(dbPath, eventType, payload, jobId = null) {
  sqliteExec(dbPath, sql`
INSERT INTO audit_events (job_id, event_type, redacted_payload_json)
VALUES (${jobId}, ${eventType}, ${JSON.stringify(payload)});
`);
}

export function statusSummary(dbPath) {
  const jobs = sqliteExec(dbPath, `
SELECT state, COUNT(*) AS count
FROM jobs
GROUP BY state
ORDER BY state;
`, { json: true });
  const snapshots = sqliteExec(dbPath, `
SELECT COUNT(*) AS count, MAX(id) AS latestId
FROM issue_snapshots;
`, { json: true })[0] || { count: 0, latestId: null };
  const approvals = sqliteExec(dbPath, `
SELECT status, COUNT(*) AS count
FROM approvals
GROUP BY status
ORDER BY status;
`, { json: true });
  return { snapshots, jobs, approvals };
}

export function listJobs(dbPath, limit = 50) {
  const capped = Math.max(1, Math.min(Number(limit || 50), 250));
  return sqliteExec(dbPath, sql`
SELECT
  id,
  source,
  issue_id AS issueId,
  state,
  created_at AS createdAt,
  updated_at AS updatedAt,
  attempts,
  last_error AS lastError
FROM jobs
ORDER BY
  CASE
    WHEN state IN ('approved_for_execution', 'executing', 'waiting_for_plex_verification', 'drafting_comment', 'closing_issue') THEN 0
    WHEN state IN ('detected', 'queued_for_investigation', 'investigating', 'awaiting_action_approval', 'awaiting_comment_approval', 'awaiting_resolution_approval', 'posting_comment', 'failed_retryable', 'blocked_needs_human') THEN 1
    WHEN state IN ('failed_terminal') THEN 2
    WHEN state IN ('closed', 'dry_run_complete') THEN 3
    ELSE 2
  END,
  updated_at DESC,
  id DESC
LIMIT ${capped};
`, { json: true });
}

export function listApprovals(dbPath, limit = 50) {
  const capped = Math.max(1, Math.min(Number(limit || 50), 250));
  return sqliteExec(dbPath, sql`
SELECT
  id,
  job_id AS jobId,
  kind,
  status,
  channel,
  approved_by AS approvedBy,
  approved_at AS approvedAt,
  created_at AS createdAt
FROM approvals
ORDER BY id DESC
LIMIT ${capped};
`, { json: true });
}
