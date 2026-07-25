import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { ensureDbDir, sql, sqliteExec, sqliteTransaction } from "./sqlite.js";

export const JOB_STATES = new Set([
  "detected",
  "queued_for_investigation",
  "investigating",
  "awaiting_action_approval",
  "approved_for_execution",
  "executing",
  "drafting_comment",
  "awaiting_resolution_approval",
  "closing_issue",
  "reopening_issue",
  "closed",
  "blocked_needs_human",
  "failed_retryable",
  "failed_terminal"
]);

function processStartTicks(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return null;
  }
  try {
    const stat = readFileSync(`/proc/${numericPid}/stat`, "utf8");
    const afterCommand = stat.slice(stat.lastIndexOf(")") + 1).trim();
    const fieldsFromState = afterCommand.split(/\s+/);
    return fieldsFromState[19] || null;
  } catch {
    return null;
  }
}

const CURRENT_OWNER_PID = process.pid;
const CURRENT_OWNER_STARTED_AT = processStartTicks(process.pid);

export async function initDb(dbPath) {
  await ensureDbDir(dbPath);
  sqliteExec(dbPath, `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 10000;
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
  owner_pid INTEGER,
  owner_started_at TEXT,
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
  item_type TEXT NOT NULL DEFAULT 'mcp_capability',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  suggested_tool_name TEXT,
  category TEXT,
  source_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dismissed_at TEXT
);

CREATE TABLE IF NOT EXISTS issue_log_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS token_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  agent_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS slack_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_ts TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'pending',
  state TEXT NOT NULL DEFAULT 'active',
  reporter_user_id TEXT,
  reporter_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(team_id, channel_id, root_ts)
);

CREATE TABLE IF NOT EXISTS slack_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL UNIQUE REFERENCES slack_threads(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',
  media_title TEXT NOT NULL,
  description TEXT NOT NULL,
  intent_confidence REAL NOT NULL DEFAULT 0,
  evidence_version INTEGER NOT NULL DEFAULT 1,
  investigated_evidence_version INTEGER NOT NULL DEFAULT 0,
  delivery_status TEXT NOT NULL DEFAULT 'available',
  delivery_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS slack_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER REFERENCES slack_threads(id) ON DELETE SET NULL,
  slack_issue_id INTEGER REFERENCES slack_issues(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,
  event_id TEXT,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_ts TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT,
  text TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'received',
  evidence_applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(team_id, channel_id, message_ts, direction)
);

CREATE TABLE IF NOT EXISTS slack_event_receipts (
  event_id TEXT PRIMARY KEY,
  message_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  message_id INTEGER NOT NULL REFERENCES slack_messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  error TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS slack_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slack_issue_id INTEGER REFERENCES slack_issues(id) ON DELETE SET NULL,
  thread_id INTEGER REFERENCES slack_threads(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  thread_ts TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_ts TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS slack_rate_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_issue_log_events_issue
ON issue_log_events(source, issue_id, timestamp, id);

CREATE INDEX IF NOT EXISTS idx_issue_log_events_job
ON issue_log_events(job_id, timestamp, id);

CREATE INDEX IF NOT EXISTS idx_token_usage_events_created
ON token_usage_events(created_at, source);

CREATE INDEX IF NOT EXISTS idx_jobs_state_updated
ON jobs(state, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_approvals_job_status_kind
ON approvals(job_id, status, kind, id DESC);

CREATE INDEX IF NOT EXISTS idx_planned_actions_job
ON planned_actions(job_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_verification_checks_job
ON verification_checks(job_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_job
ON audit_events(job_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_job
ON agent_runs(job_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_job
ON agent_run_events(job_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_missing_mcp_items_job
ON missing_mcp_items(job_id, dismissed_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_slack_event_receipts_queue
ON slack_event_receipts(status, available_at, received_at);

CREATE INDEX IF NOT EXISTS idx_slack_outbox_queue
ON slack_outbox(status, available_at, created_at);

CREATE INDEX IF NOT EXISTS idx_slack_messages_thread
ON slack_messages(thread_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_slack_rate_events_window
ON slack_rate_events(team_id, user_id, kind, created_at);

CREATE INDEX IF NOT EXISTS idx_slack_rate_events_created
ON slack_rate_events(created_at);
`);
  ensureColumn(dbPath, "agent_runs", "heartbeat_at", "TEXT");
  ensureColumn(dbPath, "agent_runs", "owner_pid", "INTEGER");
  ensureColumn(dbPath, "agent_runs", "owner_started_at", "TEXT");
  ensureColumn(dbPath, "missing_mcp_items", "item_type", "TEXT NOT NULL DEFAULT 'mcp_capability'");
  ensureColumn(dbPath, "slack_messages", "evidence_applied_at", "TEXT");
  sqliteExec(dbPath, `
UPDATE agent_runs
SET heartbeat_at = COALESCE(heartbeat_at, started_at)
WHERE heartbeat_at IS NULL;

UPDATE missing_mcp_items
SET item_type = 'mcp_capability'
WHERE item_type IS NULL OR item_type = '';

CREATE INDEX IF NOT EXISTS idx_missing_mcp_items_type
ON missing_mcp_items(item_type, dismissed_at, updated_at DESC);

UPDATE jobs SET state = 'executing' WHERE state = 'waiting_for_plex_verification';
UPDATE jobs SET state = 'awaiting_resolution_approval' WHERE state = 'awaiting_comment_approval';
UPDATE jobs SET state = 'closing_issue' WHERE state = 'posting_comment';
UPDATE jobs SET state = 'blocked_needs_human' WHERE state = 'dry_run_complete';

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
  const id = sqliteTransaction(dbPath, database => {
    const [{ id: snapshotId }] = database.prepare(sql`
INSERT INTO issue_snapshots (markdown, source_hash)
VALUES (${markdown}, ${sourceHash})
RETURNING id;
`).all();
    for (const [index, entry] of entries.entries()) {
      database.exec(sql`
INSERT INTO issue_snapshot_entries (
  snapshot_id, idx, source, issue_id, date, reporter, media_title, status, description, raw_json
) VALUES (
  ${snapshotId},
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
`);
    }
    return snapshotId;
  });
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
  const allowed = [...new Set(Array.isArray(fromStates) ? fromStates : [fromStates])];
  if (!allowed.length) {
    throw new Error(`Job ${jobId} transition to ${toState} has no allowed source states`);
  }
  const allowedSql = allowed.map(state => sql`${state}`).join(", ");
  const updateSql = sql`
UPDATE jobs
SET state = ${toState},
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_error = ${lastError}
WHERE id = ${jobId}
  AND state IN (` + allowedSql + `)
RETURNING id, state;
`;
  const updated = sqliteExec(dbPath, updateSql, { json: true })[0];
  if (updated) {
    return updated;
  }
  const current = sqliteExec(dbPath, sql`
SELECT id, state FROM jobs WHERE id = ${jobId} LIMIT 1;
`, { json: true })[0];
  if (!current) {
    throw new Error(`Job ${jobId} was not found`);
  }
  throw new Error(`Cannot transition job ${jobId} from ${current.state} to ${toState}`);
}

const LIFECYCLE_RECONCILIATION_BUSY_STATES = new Set([
  "investigating",
  "approved_for_execution",
  "executing",
  "drafting_comment",
  "closing_issue",
  "reopening_issue"
]);

export function reconcileJobLifecycle(dbPath, jobId, closed) {
  const current = jobForId(dbPath, jobId);
  if (!current) {
    throw new Error(`Job ${jobId} was not found`);
  }
  if (LIFECYCLE_RECONCILIATION_BUSY_STATES.has(current.state)) {
    return { job: current, changed: false, skippedBusy: true };
  }
  const targetState = closed ? "closed" : current.state === "closed" ? "detected" : current.state;
  if (targetState === current.state) {
    return { job: current, changed: false, skippedBusy: false };
  }
  try {
    const updated = transitionJob(dbPath, jobId, [current.state], targetState);
    return { job: { ...current, ...updated }, changed: true, skippedBusy: false };
  } catch (error) {
    const latest = jobForId(dbPath, jobId);
    if (latest && latest.state !== current.state) {
      return { job: latest, changed: false, skippedBusy: LIFECYCLE_RECONCILIATION_BUSY_STATES.has(latest.state) };
    }
    throw error;
  }
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

export function transitionJobAndCreateApproval(dbPath, jobId, fromStates, toState, kind, payload, channel = "cli", lastError = null) {
  if (!JOB_STATES.has(toState)) {
    throw new Error(`Unknown job state ${toState}`);
  }
  const allowed = [...new Set(Array.isArray(fromStates) ? fromStates : [fromStates])];
  if (!allowed.length) {
    throw new Error(`Job ${jobId} transition to ${toState} has no allowed source states`);
  }
  const payloadJson = JSON.stringify(payload);
  const tokenHash = stableHash({ jobId, kind, payload });
  const allowedSql = allowed.map(state => sql`${state}`).join(", ");
  return sqliteTransaction(dbPath, database => {
    const updatedJob = database.prepare(sql`
UPDATE jobs
SET state = ${toState},
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_error = ${lastError}
WHERE id = ${jobId}
  AND state IN (` + allowedSql + `)
RETURNING id, state;
`).all()[0];
    if (!updatedJob) {
      const current = database.prepare(sql`SELECT state FROM jobs WHERE id = ${jobId} LIMIT 1;`).all()[0];
      if (!current) {
        throw new Error(`Job ${jobId} was not found`);
      }
      throw new Error(`Cannot transition job ${jobId} from ${current.state} to ${toState}`);
    }
    const approvalRow = database.prepare(sql`
INSERT INTO approvals (job_id, kind, status, channel, token_hash, payload_json)
VALUES (${jobId}, ${kind}, 'pending', ${channel}, ${tokenHash}, ${payloadJson})
RETURNING id, job_id AS jobId, kind, status, channel, token_hash AS tokenHash, payload_json AS payloadJson;
`).all()[0];
    const { payloadJson: _payloadJson, ...approval } = approvalRow;
    return {
      job: updatedJob,
      approval: { ...approval, payload: JSON.parse(approvalRow.payloadJson) }
    };
  });
}

export function transitionJobAndResolveApproval(dbPath, jobId, approvalId, fromStates, toState, status, actor = "operator", lastError = null) {
  if (!JOB_STATES.has(toState)) {
    throw new Error(`Unknown job state ${toState}`);
  }
  if (!["approved", "rejected"].includes(status)) {
    throw new Error(`Unsupported approval status ${status}`);
  }
  const allowed = [...new Set(Array.isArray(fromStates) ? fromStates : [fromStates])];
  if (!allowed.length) {
    throw new Error(`Job ${jobId} transition to ${toState} has no allowed source states`);
  }
  const allowedSql = allowed.map(state => sql`${state}`).join(", ");
  return sqliteTransaction(dbPath, database => {
    const updatedJob = database.prepare(sql`
UPDATE jobs
SET state = ${toState},
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_error = ${lastError}
WHERE id = ${jobId}
  AND state IN (` + allowedSql + `)
RETURNING id, state;
`).all()[0];
    if (!updatedJob) {
      const current = database.prepare(sql`SELECT state FROM jobs WHERE id = ${jobId} LIMIT 1;`).all()[0];
      if (!current) {
        throw new Error(`Job ${jobId} was not found`);
      }
      throw new Error(`Cannot transition job ${jobId} from ${current.state} to ${toState}`);
    }
    const resolved = database.prepare(sql`
UPDATE approvals
SET status = ${status},
    approved_by = ${actor},
    approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${approvalId} AND job_id = ${jobId} AND status = 'pending'
RETURNING id;
`).all()[0];
    if (!resolved) {
      throw new Error(`Approval ${approvalId} is no longer pending for job ${jobId}`);
    }
    const approvals = database.prepare(sql`
SELECT id, job_id AS jobId, kind, status, channel, token_hash AS tokenHash
FROM approvals
WHERE job_id = ${jobId}
ORDER BY id;
`).all();
    return { job: updatedJob, approvals };
  });
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

export function latestApprovalForJob(dbPath, jobId, kind, status) {
  const row = sqliteExec(dbPath, sql`
SELECT id, job_id AS jobId, kind, status, channel, token_hash AS tokenHash, payload_json AS payloadJson
FROM approvals
WHERE job_id = ${jobId} AND kind = ${kind} AND status = ${status}
ORDER BY id DESC
LIMIT 1;
`, { json: true })[0];
  if (!row) {
    return null;
  }
  const { payloadJson, ...approval } = row;
  return { ...approval, payload: JSON.parse(payloadJson) };
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
INSERT INTO agent_runs (job_id, kind, status, prompt, config_json, heartbeat_at, owner_pid, owner_started_at)
VALUES (${jobId}, ${kind}, 'running', ${prompt}, ${JSON.stringify(config || {})}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${CURRENT_OWNER_PID}, ${CURRENT_OWNER_STARTED_AT})
RETURNING id;
`, { json: true });
  return { id, jobId, kind, status: "running", prompt, config: config || {}, ownerPid: CURRENT_OWNER_PID, ownerStartedAt: CURRENT_OWNER_STARTED_AT };
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
  prompt,
  config_json AS configJson,
  final_result_json AS finalResultJson,
  error,
  owner_pid AS ownerPid,
  owner_started_at AS ownerStartedAt,
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

function processExists(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processMatchesOwner(pid, ownerStartedAt) {
  if (!processExists(pid)) {
    return false;
  }
  if (!ownerStartedAt) {
    return true;
  }
  return processStartTicks(pid) === String(ownerStartedAt);
}

export function recoverInterruptedAgentRuns(dbPath, options = {}) {
  const staleSeconds = Math.max(1, Number(options.staleSeconds || 120));
  const ignoreLiveOwnerPids = options.ignoreLiveOwnerPids !== false;
  const message = options.message || "Media issue agent restarted while repair was running. Retry the repair from the job detail pane.";
  const runs = sqliteExec(dbPath, sql`
SELECT id, job_id AS jobId, owner_pid AS ownerPid, owner_started_at AS ownerStartedAt, started_at AS startedAt, heartbeat_at AS heartbeatAt
FROM agent_runs
WHERE status = 'running'
  AND julianday(COALESCE(heartbeat_at, started_at)) <= julianday('now') - (${staleSeconds} / 86400.0);
`, { json: true });
  const recoverable = runs.filter(run => !ignoreLiveOwnerPids || !processMatchesOwner(run.ownerPid, run.ownerStartedAt));
  for (const run of recoverable) {
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
  AND state IN ('approved_for_execution', 'executing', 'drafting_comment');
`);
  }
  return recoverable.length;
}

export function recordAgentRunEvent(dbPath, runId, jobId, eventType, payload) {
  sqliteTransaction(dbPath, database => database.exec(sql`
INSERT INTO agent_run_events (run_id, job_id, event_type, payload_json)
VALUES (${runId}, ${jobId}, ${eventType}, ${JSON.stringify(payload || {})});
UPDATE agent_runs
SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${runId} AND status = 'running';
`));
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function extractTokenUsageFromCodexEvent(event) {
  const usage = event?.usage || event?.response?.usage || event?.item?.usage || null;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const inputTokens = tokenCount(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens);
  const cachedInputTokens = tokenCount(usage.cached_input_tokens ?? usage.cachedInputTokens);
  const outputTokens = tokenCount(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens);
  const reasoningOutputTokens = tokenCount(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens);
  const totalTokens = tokenCount(usage.total_tokens ?? usage.totalTokens) || inputTokens + outputTokens;
  if (!inputTokens && !cachedInputTokens && !outputTokens && !reasoningOutputTokens && !totalTokens) {
    return null;
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    raw: usage
  };
}

export function recordTokenUsageEvent(dbPath, { jobId = null, agentRunId = null, source = "codex", model = "", usage }) {
  if (!usage) {
    return null;
  }
  const inputTokens = tokenCount(usage.inputTokens);
  const cachedInputTokens = tokenCount(usage.cachedInputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const reasoningOutputTokens = tokenCount(usage.reasoningOutputTokens);
  const row = {
    jobId: Number.isInteger(Number(jobId)) && Number(jobId) > 0 ? Number(jobId) : null,
    agentRunId: Number.isInteger(Number(agentRunId)) && Number(agentRunId) > 0 ? Number(agentRunId) : null,
    source: String(source || "codex"),
    model: String(model || ""),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: tokenCount(usage.totalTokens) || inputTokens + outputTokens,
    raw: usage.raw || {}
  };
  sqliteExec(dbPath, sql`
INSERT INTO token_usage_events (
  job_id, agent_run_id, source, model, input_tokens, cached_input_tokens,
  output_tokens, reasoning_output_tokens, total_tokens, usage_json
) VALUES (
  ${row.jobId},
  ${row.agentRunId},
  ${row.source},
  ${row.model},
  ${row.inputTokens},
  ${row.cachedInputTokens},
  ${row.outputTokens},
  ${row.reasoningOutputTokens},
  ${row.totalTokens},
  ${JSON.stringify(row.raw)}
);
`);
  return row;
}

export const IMPROVEMENT_ITEM_TYPES = new Set(["mcp_capability", "investigation_prompt"]);

function normalizeImprovementItemType(value, fallback = "mcp_capability") {
  const itemType = String(value || fallback).trim().toLowerCase();
  if (!IMPROVEMENT_ITEM_TYPES.has(itemType)) {
    throw new Error(`Unsupported improvement item type ${itemType}`);
  }
  return itemType;
}

function normalizeImprovementDbItem(item, fallbackType = "mcp_capability") {
  const itemType = normalizeImprovementItemType(item?.itemType || item?.type, fallbackType);
  const title = String(item?.title || item?.capability || item?.suggestedToolName || "").trim();
  const description = String(item?.description || item?.recommendedChange || item?.reason || title || "").trim();
  if (!title && !description) {
    return null;
  }
  const normalized = {
    itemType,
    title: title || description.slice(0, 120),
    description: description || title,
    suggestedToolName: String(item?.suggestedToolName || item?.toolName || "").trim(),
    category: String(item?.category || item?.type || "").trim(),
    source: item || {}
  };
  if (itemType === "mcp_capability") {
    normalized.fingerprint = stableHash({
      title: normalized.title.toLowerCase(),
      description: normalized.description.toLowerCase(),
      suggestedToolName: normalized.suggestedToolName.toLowerCase(),
      category: normalized.category.toLowerCase()
    });
  } else {
    const dedupeKey = String(item?.dedupeKey || "").trim().toLowerCase();
    normalized.fingerprint = stableHash({
      itemType,
      dedupeKey: dedupeKey || null,
      target: String(item?.target || normalized.category || "investigation_prompt").trim().toLowerCase(),
      title: dedupeKey ? null : normalized.title.toLowerCase(),
      recommendedChange: dedupeKey ? null : String(item?.recommendedChange || normalized.description).trim().toLowerCase()
    });
  }
  return normalized;
}

export function upsertImprovementItems(dbPath, jobId, agentRunId, items = [], fallbackType = "mcp_capability") {
  const saved = [];
  for (const rawItem of items || []) {
    const item = normalizeImprovementDbItem(rawItem, fallbackType);
    if (!item) {
      continue;
    }
    const [row] = sqliteExec(dbPath, sql`
INSERT INTO missing_mcp_items (
  job_id, agent_run_id, fingerprint, item_type, title, description, suggested_tool_name, category, source_json
) VALUES (
  ${jobId || null},
  ${agentRunId || null},
  ${item.fingerprint},
  ${item.itemType},
  ${item.title},
  ${item.description},
  ${item.suggestedToolName || null},
  ${item.category || null},
  ${JSON.stringify(item.source)}
)
ON CONFLICT(fingerprint) DO UPDATE SET
  job_id = excluded.job_id,
  agent_run_id = excluded.agent_run_id,
  item_type = excluded.item_type,
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
  item_type AS itemType,
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

export function upsertMissingMcpItems(dbPath, jobId, agentRunId, items = []) {
  return upsertImprovementItems(dbPath, jobId, agentRunId, items, "mcp_capability");
}

function mapImprovementItem(row) {
  return {
    ...row,
    itemType: row.itemType || "mcp_capability",
    source: parseJson(row.sourceJson, {})
  };
}

export function listImprovementItems(dbPath, options = {}) {
  const includeDismissed = Boolean(options.includeDismissed);
  const itemType = options.itemType ? normalizeImprovementItemType(options.itemType) : null;
  const rows = sqliteExec(dbPath, sql`
SELECT
  missing_mcp_items.id,
  missing_mcp_items.job_id AS jobId,
  missing_mcp_items.agent_run_id AS agentRunId,
  missing_mcp_items.fingerprint,
  missing_mcp_items.item_type AS itemType,
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
WHERE (${includeDismissed ? 1 : 0} = 1 OR missing_mcp_items.dismissed_at IS NULL)
  AND (${itemType} IS NULL OR missing_mcp_items.item_type = ${itemType})
ORDER BY missing_mcp_items.updated_at DESC, missing_mcp_items.id DESC;
`, { json: true });
  return rows.map(mapImprovementItem);
}

export function listMissingMcpItems(dbPath, options = {}) {
  return listImprovementItems(dbPath, { ...options, itemType: "mcp_capability" });
}

export function improvementItemsForJob(dbPath, jobId, options = {}) {
  const itemType = options.itemType ? normalizeImprovementItemType(options.itemType) : null;
  const rows = sqliteExec(dbPath, sql`
SELECT
  id,
  job_id AS jobId,
  agent_run_id AS agentRunId,
  fingerprint,
  item_type AS itemType,
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
  AND (${itemType} IS NULL OR item_type = ${itemType})
ORDER BY updated_at DESC, id DESC;
`, { json: true });
  return rows.map(mapImprovementItem);
}

export function missingMcpItemsForJob(dbPath, jobId) {
  return improvementItemsForJob(dbPath, jobId, { itemType: "mcp_capability" });
}

export function dismissImprovementItem(dbPath, itemId) {
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
  item_type AS itemType,
  title,
  description,
  suggested_tool_name AS suggestedToolName,
  category,
  source_json AS sourceJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  dismissed_at AS dismissedAt;
`, { json: true });
  return row ? mapImprovementItem(row) : null;
}

export function dismissMissingMcpItem(dbPath, itemId) {
  const existing = sqliteExec(
    dbPath,
    "SELECT item_type AS itemType FROM missing_mcp_items WHERE id = " + Number(itemId) + " LIMIT 1;",
    { json: true }
  )[0] || null;
  if (existing && existing.itemType !== "mcp_capability") {
    throw new Error("Improvement item " + itemId + " is not an MCP capability gap");
  }
  return dismissImprovementItem(dbPath, itemId);
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
ORDER BY id DESC
LIMIT 100;
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
ORDER BY id DESC
LIMIT 200;
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
ORDER BY id DESC
LIMIT 100;
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
  owner_pid AS ownerPid,
  owner_started_at AS ownerStartedAt,
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
  const improvementItems = improvementItemsForJob(dbPath, jobId);
  const missingMcpItems = improvementItems.filter(item => item.itemType === "mcp_capability");
  return { job, investigation, approvals, plannedActions, verificationChecks, auditEvents, agentRuns, agentRunEvents, missingMcpItems, improvementItems };
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

export function recordAudit(dbPath, eventType, payload, jobId = null) {
  sqliteExec(dbPath, sql`
INSERT INTO audit_events (job_id, event_type, redacted_payload_json)
VALUES (${jobId}, ${eventType}, ${JSON.stringify(payload)});
`);
}

export function latestAuditEvent(dbPath, jobId, eventTypes = []) {
  const types = [...new Set((Array.isArray(eventTypes) ? eventTypes : [eventTypes]).filter(Boolean))];
  if (!types.length) {
    return null;
  }
  const typeSql = types.map(type => sql`${type}`).join(", ");
  const querySql = sql`
SELECT
  id,
  job_id AS jobId,
  event_type AS eventType,
  redacted_payload_json AS redactedPayloadJson,
  created_at AS createdAt
FROM audit_events
WHERE job_id = ${jobId}
  AND event_type IN (` + typeSql + `)
ORDER BY id DESC
LIMIT 1;
`;
  const row = sqliteExec(dbPath, querySql, { json: true })[0];
  return row ? { ...row, redactedPayload: parseJson(row.redactedPayloadJson, {}) } : null;
}

export function recordIssueLogEvent(dbPath, { jobId = null, source, issueId, record }) {
  if (!source || issueId === undefined || issueId === null || !record) {
    return;
  }
  sqliteExec(dbPath, sql`
INSERT INTO issue_log_events (job_id, source, issue_id, timestamp, level, event, record_json)
VALUES (
  ${jobId},
  ${String(source)},
  ${String(issueId)},
  ${record.timestamp || new Date().toISOString()},
  ${record.level || "info"},
  ${record.event || "event"},
  ${JSON.stringify(record)}
);
`);
}

export function issueLogRecordPage(dbPath, source, issueId, options = {}) {
  const afterId = Math.max(0, Number(options.afterId || 0));
  const limit = Math.max(1, Math.min(Number(options.limit || 1000), 5000));
  return sqliteExec(dbPath, sql`
SELECT id, record_json AS recordJson
FROM issue_log_events
WHERE source = ${String(source)}
  AND issue_id = ${String(issueId)}
  AND id > ${afterId}
ORDER BY id ASC
LIMIT ${limit};
  `, { json: true }).map(row => ({
    id: row.id,
    record: parseJson(row.recordJson, null)
  }));
}

export function issueLogRecords(dbPath, source, issueId) {
  const records = [];
  let afterId = 0;
  for (;;) {
    const page = issueLogRecordPage(dbPath, source, issueId, { afterId, limit: 1000 });
    if (!page.length) {
      break;
    }
    records.push(...page.map(row => row.record).filter(Boolean));
    afterId = page.at(-1).id;
    if (page.length < 1000) {
      break;
    }
  }
  return records;
}

function slackIssueFromRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    threadId: Number(row.threadId),
    teamId: row.teamId,
    channelId: row.channelId,
    rootTs: row.rootTs,
    reporterUserId: row.reporterUserId || "",
    reporterName: row.reporterName || "",
    status: row.status,
    mediaTitle: row.mediaTitle,
    description: row.description,
    intentConfidence: Number(row.intentConfidence || 0),
    evidenceVersion: Number(row.evidenceVersion || 1),
    investigatedEvidenceVersion: Number(row.investigatedEvidenceVersion || 0),
    deliveryStatus: row.deliveryStatus,
    deliveryError: row.deliveryError || "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt || null
  };
}

const SLACK_ISSUE_SELECT = `
SELECT
  slack_issues.id,
  slack_issues.thread_id AS threadId,
  slack_threads.team_id AS teamId,
  slack_threads.channel_id AS channelId,
  slack_threads.root_ts AS rootTs,
  slack_threads.reporter_user_id AS reporterUserId,
  slack_threads.reporter_name AS reporterName,
  slack_issues.status,
  slack_issues.media_title AS mediaTitle,
  slack_issues.description,
  slack_issues.intent_confidence AS intentConfidence,
  slack_issues.evidence_version AS evidenceVersion,
  slack_issues.investigated_evidence_version AS investigatedEvidenceVersion,
  slack_issues.delivery_status AS deliveryStatus,
  slack_issues.delivery_error AS deliveryError,
  slack_issues.created_at AS createdAt,
  slack_issues.updated_at AS updatedAt,
  slack_issues.closed_at AS closedAt
FROM slack_issues
JOIN slack_threads ON slack_threads.id = slack_issues.thread_id
`;

export function archiveSlackInbound(dbPath, event) {
  return sqliteTransaction(dbPath, database => {
    database.prepare(sql`
INSERT INTO slack_threads (
  team_id, channel_id, root_ts, reporter_user_id, reporter_name
) VALUES (
  ${event.teamId},
  ${event.channelId},
  ${event.rootTs},
  ${event.userId || ""},
  ${event.userName || ""}
)
ON CONFLICT(team_id, channel_id, root_ts) DO UPDATE SET
  reporter_name = CASE
    WHEN excluded.reporter_name <> '' THEN excluded.reporter_name
    ELSE slack_threads.reporter_name
  END,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
`).run();
    const thread = database.prepare(sql`
SELECT id FROM slack_threads
WHERE team_id = ${event.teamId}
  AND channel_id = ${event.channelId}
  AND root_ts = ${event.rootTs}
LIMIT 1;
`).get();
    const existingIssue = database.prepare(sql`
SELECT id FROM slack_issues WHERE thread_id = ${thread.id} LIMIT 1;
`).get();
    database.prepare(sql`
INSERT OR IGNORE INTO slack_messages (
  thread_id, slack_issue_id, direction, event_id, team_id, channel_id, root_ts, message_ts,
  user_id, user_name, text, delivery_status
) VALUES (
  ${thread.id},
  ${existingIssue?.id || null},
  'inbound',
  ${event.eventId},
  ${event.teamId},
  ${event.channelId},
  ${event.rootTs},
  ${event.messageTs},
  ${event.userId || ""},
  ${event.userName || ""},
  ${event.text},
  'received'
);
`).run();
    const message = database.prepare(sql`
SELECT id FROM slack_messages
WHERE team_id = ${event.teamId}
  AND channel_id = ${event.channelId}
  AND message_ts = ${event.messageTs}
  AND direction = 'inbound'
LIMIT 1;
`).get();
    const inserted = database.prepare(sql`
INSERT OR IGNORE INTO slack_event_receipts (
  event_id, message_key, event_type, message_id
) VALUES (
  ${event.eventId},
  ${event.messageKey},
  ${event.eventType},
  ${message.id}
);
`).run();
    database.prepare(`
DELETE FROM slack_event_receipts
WHERE processed_at IS NOT NULL
  AND processed_at < datetime('now', '-30 days');
`).run();
    database.prepare(`
DELETE FROM slack_outbox
WHERE status IN ('sent', 'failed')
  AND updated_at < datetime('now', '-30 days');
`).run();
    return {
      queued: inserted.changes > 0,
      duplicate: inserted.changes === 0,
      threadId: Number(thread.id),
      messageId: Number(message.id)
    };
  });
}

export function recoverSlackQueues(dbPath) {
  sqliteExec(dbPath, `
UPDATE slack_event_receipts
SET status = 'pending',
    available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    error = CASE
      WHEN error IS NULL OR error = '' THEN 'Recovered after media issue agent restart.'
      ELSE error
    END
WHERE status = 'processing';

UPDATE slack_outbox
SET status = 'pending',
    available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    error = CASE
      WHEN error IS NULL OR error = '' THEN 'Recovered after media issue agent restart.'
      ELSE error
    END
WHERE status = 'sending';
`);
}

export function claimSlackInbound(dbPath) {
  return sqliteTransaction(dbPath, database => {
    const receipt = database.prepare(`
SELECT event_id AS eventId
FROM slack_event_receipts
WHERE status = 'pending'
  AND available_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
ORDER BY received_at, event_id
LIMIT 1;
`).get();
    if (!receipt) {
      return null;
    }
    database.prepare(sql`
UPDATE slack_event_receipts
SET status = 'processing',
    attempts = attempts + 1,
    error = NULL
WHERE event_id = ${receipt.eventId}
  AND status = 'pending';
`).run();
    return database.prepare(sql`
SELECT
  slack_event_receipts.event_id AS eventId,
  slack_event_receipts.event_type AS eventType,
  slack_event_receipts.attempts,
  slack_messages.id AS messageId,
  slack_messages.thread_id AS threadId,
  slack_messages.team_id AS teamId,
  slack_messages.channel_id AS channelId,
  slack_messages.root_ts AS rootTs,
  slack_messages.message_ts AS messageTs,
  slack_messages.user_id AS userId,
  slack_messages.user_name AS userName,
  slack_messages.text,
  slack_threads.kind AS threadKind,
  slack_threads.state AS threadState,
  slack_issues.id AS slackIssueId,
  slack_issues.status AS issueStatus,
  slack_issues.evidence_version AS evidenceVersion
FROM slack_event_receipts
JOIN slack_messages ON slack_messages.id = slack_event_receipts.message_id
JOIN slack_threads ON slack_threads.id = slack_messages.thread_id
LEFT JOIN slack_issues ON slack_issues.thread_id = slack_threads.id
WHERE slack_event_receipts.event_id = ${receipt.eventId}
LIMIT 1;
`).get();
  });
}

export function completeSlackInbound(dbPath, eventId, status = "completed", error = null) {
  sqliteExec(dbPath, sql`
UPDATE slack_event_receipts
SET status = ${status},
    error = ${error},
    processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE event_id = ${eventId};
`);
}

export function retrySlackInbound(dbPath, eventId, error, delaySeconds = 5) {
  const availableAt = new Date(Date.now() + Math.max(1, Number(delaySeconds || 1)) * 1000).toISOString();
  sqliteExec(dbPath, sql`
UPDATE slack_event_receipts
SET status = 'pending',
    error = ${error},
    available_at = ${availableAt}
WHERE event_id = ${eventId};
`);
}

export function slackThreadForMessage(dbPath, teamId, channelId, rootTs) {
  return sqliteExec(dbPath, sql`
SELECT
  slack_threads.id,
  slack_threads.team_id AS teamId,
  slack_threads.channel_id AS channelId,
  slack_threads.root_ts AS rootTs,
  slack_threads.kind,
  slack_threads.state,
  slack_threads.reporter_user_id AS reporterUserId,
  slack_threads.reporter_name AS reporterName,
  slack_issues.id AS slackIssueId
FROM slack_threads
LEFT JOIN slack_issues ON slack_issues.thread_id = slack_threads.id
WHERE slack_threads.team_id = ${teamId}
  AND slack_threads.channel_id = ${channelId}
  AND slack_threads.root_ts = ${rootTs}
LIMIT 1;
`, { json: true })[0] || null;
}

export function createSlackIssue(dbPath, threadId, values) {
  const issueId = sqliteTransaction(dbPath, database => {
    database.prepare(sql`
INSERT INTO slack_issues (
  thread_id, media_title, description, intent_confidence
) VALUES (
  ${threadId},
  ${values.mediaTitle},
  ${values.description},
  ${Number(values.confidence || 0)}
)
ON CONFLICT(thread_id) DO UPDATE SET
  media_title = excluded.media_title,
  description = excluded.description,
  intent_confidence = excluded.intent_confidence,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
`).run();
    const issue = database.prepare(sql`
SELECT id FROM slack_issues WHERE thread_id = ${threadId} LIMIT 1;
`).get();
    database.prepare(sql`
UPDATE slack_threads
SET kind = 'issue',
    state = 'active',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${threadId};
`).run();
    database.prepare(sql`
UPDATE slack_messages
SET slack_issue_id = ${issue.id}
WHERE thread_id = ${threadId};
`).run();
    return Number(issue.id);
  });
  return slackIssueForId(dbPath, issueId);
}

export function setSlackThreadKind(dbPath, threadId, kind, state = "active") {
  sqliteExec(dbPath, sql`
UPDATE slack_threads
SET kind = ${kind},
    state = ${state},
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${threadId};
`);
}

export function updateSlackReporterIdentity(dbPath, threadId, userId, userName) {
  const name = String(userName || "").trim();
  if (!name) {
    return;
  }
  sqliteExec(dbPath, sql`
UPDATE slack_threads
SET reporter_name = ${name},
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${threadId}
  AND reporter_user_id = ${userId};
UPDATE slack_messages
SET user_name = ${name}
WHERE thread_id = ${threadId}
  AND user_id = ${userId}
  AND (user_name IS NULL OR user_name = '');
`);
}

export function slackIssueForId(dbPath, issueId) {
  const row = sqliteExec(dbPath, `${SLACK_ISSUE_SELECT}
WHERE slack_issues.id = ${Number(issueId)}
LIMIT 1;`, { json: true })[0];
  return slackIssueFromRow(row);
}

export function slackMessagesForThread(dbPath, threadId, limit = 200) {
  const capped = Math.max(1, Math.min(Number(limit || 200), 1000));
  return sqliteExec(dbPath, sql`
SELECT
  id,
  direction,
  event_id AS eventId,
  team_id AS teamId,
  channel_id AS channelId,
  root_ts AS rootTs,
  message_ts AS messageTs,
  user_id AS userId,
  user_name AS userName,
  text,
  delivery_status AS deliveryStatus,
  created_at AS createdAt
FROM slack_messages
WHERE thread_id = ${threadId}
ORDER BY created_at DESC, id DESC
LIMIT ${capped};
`, { json: true }).reverse();
}

export function slackIssueDetails(dbPath, issueId) {
  const issue = slackIssueForId(dbPath, issueId);
  if (!issue) {
    return null;
  }
  const messages = slackMessagesForThread(dbPath, issue.threadId);
  return {
    issue: {
      source: "slack",
      id: String(issue.id),
      status: issue.status,
      lifecycle: issue.status,
      isClosed: issue.status === "closed",
      mediaTitle: issue.mediaTitle,
      description: issue.description,
      reporter: issue.reporterName || issue.reporterUserId,
      reporterUserId: issue.reporterUserId,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      evidenceVersion: issue.evidenceVersion,
      investigatedEvidenceVersion: issue.investigatedEvidenceVersion,
      deliveryStatus: issue.deliveryStatus,
      deliveryError: issue.deliveryError,
      comments: messages.map(message => ({
        id: message.id,
        direction: message.direction,
        message: message.text,
        userId: message.userId,
        userName: message.userName,
        createdAt: message.createdAt,
        messageTs: message.messageTs
      }))
    },
    conversation: messages
  };
}

export function listSlackIssueRecords(dbPath) {
  const rows = sqliteExec(dbPath, `${SLACK_ISSUE_SELECT}
ORDER BY slack_issues.updated_at DESC, slack_issues.id DESC;`, { json: true });
  return rows.map(row => {
    const issue = slackIssueFromRow(row);
    return {
      source: "slack",
      id: String(issue.id),
      issueId: String(issue.id),
      status: issue.status,
      lifecycle: issue.status,
      isClosed: issue.status === "closed",
      mediaTitle: issue.mediaTitle,
      description: issue.description,
      reporter: issue.reporterName || issue.reporterUserId,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      evidenceVersion: issue.evidenceVersion,
      investigatedEvidenceVersion: issue.investigatedEvidenceVersion,
      deliveryStatus: issue.deliveryStatus,
      deliveryError: issue.deliveryError
    };
  });
}

export function applySlackIssueEvidenceMessage(dbPath, issueId, messageId) {
  const applied = sqliteTransaction(dbPath, database => {
    const message = database.prepare(sql`
SELECT evidence_applied_at AS evidenceAppliedAt
FROM slack_messages
WHERE id = ${messageId}
  AND slack_issue_id = ${issueId}
  AND direction = 'inbound'
LIMIT 1;
`).get();
    if (!message) {
      throw new Error(`Slack message ${messageId} is not attached to issue ${issueId}`);
    }
    if (message.evidenceAppliedAt) {
      return false;
    }
    database.prepare(sql`
UPDATE slack_messages
SET evidence_applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${messageId}
  AND evidence_applied_at IS NULL;
`).run();
    database.prepare(sql`
UPDATE slack_issues
SET evidence_version = evidence_version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${issueId};
`).run();
    return true;
  });
  return {
    applied,
    issue: slackIssueForId(dbPath, issueId)
  };
}

export function markSlackIssueInvestigated(dbPath, issueId, evidenceVersion) {
  sqliteExec(dbPath, sql`
UPDATE slack_issues
SET investigated_evidence_version = MAX(investigated_evidence_version, ${Number(evidenceVersion || 0)}),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${issueId};
`);
  return slackIssueForId(dbPath, issueId);
}

export function setSlackIssueStatus(dbPath, issueId, status) {
  if (!["open", "closed"].includes(status)) {
    throw new Error(`Unsupported Slack issue status ${status}`);
  }
  sqliteExec(dbPath, sql`
UPDATE slack_issues
SET status = ${status},
    closed_at = CASE WHEN ${status} = 'closed' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${issueId};
`);
  return slackIssueForId(dbPath, issueId);
}

export function setSlackIssueDelivery(dbPath, issueId, status, error = null) {
  sqliteExec(dbPath, sql`
UPDATE slack_issues
SET delivery_status = ${status},
    delivery_error = ${error},
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${issueId};
`);
  return slackIssueForId(dbPath, issueId);
}

export function enqueueSlackOutbox(dbPath, values) {
  sqliteExec(dbPath, sql`
INSERT INTO slack_outbox (
  slack_issue_id, thread_id, kind, dedupe_key, channel_id, thread_ts, message
) VALUES (
  ${values.slackIssueId || null},
  ${values.threadId || null},
  ${values.kind},
  ${values.dedupeKey},
  ${values.channelId},
  ${values.threadTs || null},
  ${values.message}
)
ON CONFLICT(dedupe_key) DO NOTHING;
`);
  return sqliteExec(dbPath, sql`
SELECT
  id,
  slack_issue_id AS slackIssueId,
  thread_id AS threadId,
  kind,
  dedupe_key AS dedupeKey,
  channel_id AS channelId,
  thread_ts AS threadTs,
  message,
  status,
  attempts,
  available_at AS availableAt,
  sent_ts AS sentTs,
  error,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM slack_outbox
WHERE dedupe_key = ${values.dedupeKey}
LIMIT 1;
`, { json: true })[0];
}

export function claimSlackOutbox(dbPath) {
  return sqliteTransaction(dbPath, database => {
    const item = database.prepare(`
SELECT id
FROM slack_outbox
WHERE status = 'pending'
  AND available_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
ORDER BY created_at, id
LIMIT 1;
`).get();
    if (!item) {
      return null;
    }
    database.prepare(sql`
UPDATE slack_outbox
SET status = 'sending',
    attempts = attempts + 1,
    error = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${item.id}
  AND status = 'pending';
`).run();
    return database.prepare(sql`
SELECT
  slack_outbox.id,
  slack_outbox.slack_issue_id AS slackIssueId,
  slack_outbox.thread_id AS threadId,
  slack_outbox.kind,
  slack_outbox.dedupe_key AS dedupeKey,
  slack_outbox.channel_id AS channelId,
  slack_outbox.thread_ts AS threadTs,
  slack_outbox.message,
  slack_outbox.status,
  slack_outbox.attempts,
  slack_threads.team_id AS teamId,
  slack_threads.root_ts AS rootTs
FROM slack_outbox
LEFT JOIN slack_threads ON slack_threads.id = slack_outbox.thread_id
WHERE slack_outbox.id = ${item.id}
LIMIT 1;
`).get();
  });
}

export function completeSlackOutbox(dbPath, outboxId, result) {
  return sqliteTransaction(dbPath, database => {
    const item = database.prepare(sql`
SELECT
  slack_outbox.*,
  slack_threads.team_id AS team_id,
  slack_threads.root_ts AS root_ts
FROM slack_outbox
LEFT JOIN slack_threads ON slack_threads.id = slack_outbox.thread_id
WHERE slack_outbox.id = ${outboxId}
LIMIT 1;
`).get();
    if (!item) {
      return null;
    }
    const sentTs = String(result?.ts || "");
    database.prepare(sql`
UPDATE slack_outbox
SET status = 'sent',
    sent_ts = ${sentTs},
    error = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${outboxId};
`).run();
    if (sentTs) {
      database.prepare(sql`
INSERT OR IGNORE INTO slack_messages (
  thread_id, slack_issue_id, direction, team_id, channel_id, root_ts,
  message_ts, user_id, user_name, text, delivery_status
) VALUES (
  ${item.thread_id},
  ${item.slack_issue_id},
  'outbound',
  ${item.team_id || ""},
  ${item.channel_id},
  ${item.thread_ts || sentTs},
  ${sentTs},
  '',
  'media-issue-agent',
  ${item.message},
  'sent'
);
`).run();
    }
    return { id: Number(item.id), sentTs };
  });
}

export function retrySlackOutbox(dbPath, outboxId, error, delaySeconds) {
  const availableAt = new Date(Date.now() + Math.max(1, Number(delaySeconds || 1)) * 1000).toISOString();
  sqliteExec(dbPath, sql`
UPDATE slack_outbox
SET status = 'pending',
    error = ${error},
    available_at = ${availableAt},
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${outboxId};
`);
}

export function failSlackOutbox(dbPath, outboxId, error) {
  sqliteExec(dbPath, sql`
UPDATE slack_outbox
SET status = 'failed',
    error = ${error},
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ${outboxId};
`);
}

export function slackRateCounts(dbPath, teamId, userId, now = Date.now()) {
  const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const rows = sqliteExec(dbPath, sql`
SELECT
  SUM(CASE WHEN kind = 'interaction' AND user_id = ${userId} AND created_at >= ${tenMinutesAgo} THEN 1 ELSE 0 END) AS userInteractions,
  SUM(CASE WHEN kind = 'interaction' AND created_at >= ${tenMinutesAgo} THEN 1 ELSE 0 END) AS workspaceInteractions,
  SUM(CASE WHEN kind = 'classifier' AND user_id = ${userId} AND created_at >= ${oneHourAgo} THEN 1 ELSE 0 END) AS userClassifiers,
  SUM(CASE WHEN kind = 'classifier' AND created_at >= ${oneHourAgo} THEN 1 ELSE 0 END) AS workspaceClassifiers,
  MAX(CASE WHEN kind = 'rate_notice' AND user_id = ${userId} THEN created_at ELSE NULL END) AS lastRateNoticeAt
FROM slack_rate_events
WHERE team_id = ${teamId}
  AND created_at >= ${oneHourAgo};
`, { json: true })[0] || {};
  return {
    userInteractions: Number(rows.userInteractions || 0),
    workspaceInteractions: Number(rows.workspaceInteractions || 0),
    userClassifiers: Number(rows.userClassifiers || 0),
    workspaceClassifiers: Number(rows.workspaceClassifiers || 0),
    lastRateNoticeAt: rows.lastRateNoticeAt || null
  };
}

export function slackInboundQueueCountForUser(dbPath, teamId, userId) {
  const row = sqliteExec(dbPath, sql`
SELECT COUNT(*) AS count
FROM slack_event_receipts
JOIN slack_messages ON slack_messages.id = slack_event_receipts.message_id
WHERE slack_event_receipts.status IN ('pending', 'processing')
  AND slack_messages.team_id = ${teamId}
  AND slack_messages.user_id = ${userId};
`, { json: true })[0] || {};
  return Number(row.count || 0);
}

export function consumeSlackRateLimit(dbPath, teamId, userId, limits, now = Date.now(), options = {}) {
  const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  return sqliteTransaction(dbPath, database => {
    database.prepare(`
DELETE FROM slack_rate_events
WHERE created_at < datetime('now', '-2 days');
`).run();
    const rows = database.prepare(sql`
SELECT
  SUM(CASE WHEN kind = 'interaction' AND user_id = ${userId} AND created_at >= ${tenMinutesAgo} THEN 1 ELSE 0 END) AS userInteractions,
  SUM(CASE WHEN kind = 'interaction' AND created_at >= ${tenMinutesAgo} THEN 1 ELSE 0 END) AS workspaceInteractions,
  SUM(CASE WHEN kind = 'classifier' AND user_id = ${userId} AND created_at >= ${oneHourAgo} THEN 1 ELSE 0 END) AS userClassifiers,
  SUM(CASE WHEN kind = 'classifier' AND created_at >= ${oneHourAgo} THEN 1 ELSE 0 END) AS workspaceClassifiers,
  MAX(CASE WHEN kind = 'rate_notice' AND user_id = ${userId} THEN created_at ELSE NULL END) AS lastRateNoticeAt
FROM slack_rate_events
WHERE team_id = ${teamId}
  AND created_at >= ${oneHourAgo};
`).get() || {};
    const counts = {
      userInteractions: Number(rows.userInteractions || 0),
      workspaceInteractions: Number(rows.workspaceInteractions || 0),
      userClassifiers: Number(rows.userClassifiers || 0),
      workspaceClassifiers: Number(rows.workspaceClassifiers || 0),
      lastRateNoticeAt: rows.lastRateNoticeAt || null
    };
    if (options.countInteraction !== false) {
      if (counts.userInteractions >= Number(limits.userInteractionsPerTenMinutes)) {
        return { allowed: false, reason: "user_interaction_limit", counts };
      }
      database.prepare(sql`
INSERT INTO slack_rate_events (team_id, user_id, kind)
VALUES (${teamId}, ${userId}, 'interaction');
`).run();
    }
    if (counts.userClassifiers >= Number(limits.userClassifiersPerHour)) {
      return { allowed: false, reason: "user_classifier_limit", counts };
    }
    database.prepare(sql`
INSERT INTO slack_rate_events (team_id, user_id, kind)
VALUES (${teamId}, ${userId}, 'classifier');
`).run();
    return { allowed: true, reason: null, counts };
  });
}

export function recordSlackRateEvent(dbPath, teamId, userId, kind) {
  sqliteExec(dbPath, sql`
INSERT INTO slack_rate_events (team_id, user_id, kind)
VALUES (${teamId}, ${userId}, ${kind});
DELETE FROM slack_rate_events
WHERE created_at < datetime('now', '-2 days');
`);
}

export function slackQueueStatus(dbPath) {
  const inbound = sqliteExec(dbPath, `
SELECT
  SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
FROM slack_event_receipts;
`, { json: true })[0] || {};
  const outbound = sqliteExec(dbPath, `
SELECT
  SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
FROM slack_outbox;
`, { json: true })[0] || {};
  return {
    inbound: {
      pending: Number(inbound.pending || 0),
      processing: Number(inbound.processing || 0),
      failed: Number(inbound.failed || 0)
    },
    outbound: {
      pending: Number(outbound.pending || 0),
      sending: Number(outbound.sending || 0),
      failed: Number(outbound.failed || 0)
    }
  };
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
  const tokenUsage = sqliteExec(dbPath, `
SELECT
  date('now', 'localtime') AS day,
  COALESCE(SUM(total_tokens), 0) AS totalTokens,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningOutputTokens,
  COUNT(*) AS eventCount
FROM token_usage_events
WHERE date(created_at, 'localtime') = date('now', 'localtime');
`, { json: true })[0] || {
    day: null,
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    eventCount: 0
  };
  return { snapshots, jobs, approvals, tokenUsage };
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
    WHEN state IN ('approved_for_execution', 'executing', 'drafting_comment', 'closing_issue', 'reopening_issue') THEN 0
    WHEN state IN ('detected', 'queued_for_investigation', 'investigating', 'awaiting_action_approval', 'awaiting_resolution_approval', 'failed_retryable', 'blocked_needs_human') THEN 1
    WHEN state IN ('failed_terminal') THEN 2
    WHEN state IN ('closed') THEN 3
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
