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
  "posting_comment",
  "closing_issue",
  "closed",
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
`);
}

export function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  snapshot_id AS snapshotId,
  idx,
  source,
  issue_id AS issueId,
  date,
  reporter,
  media_title AS mediaTitle,
  status,
  description,
  raw_json AS rawJson
FROM issue_snapshot_entries
WHERE snapshot_id = ${snapshotId} AND idx = ${index}
LIMIT 1;
`, { json: true });
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { ...row, raw: JSON.parse(row.rawJson) };
}

export function snapshotEntries(dbPath, snapshotId) {
  return sqliteExec(dbPath, sql`
SELECT
  snapshot_id AS snapshotId,
  idx,
  source,
  issue_id AS issueId,
  date,
  reporter,
  media_title AS mediaTitle,
  status,
  description,
  raw_json AS rawJson
FROM issue_snapshot_entries
WHERE snapshot_id = ${snapshotId}
ORDER BY idx;
`, { json: true }).map(row => ({ ...row, raw: JSON.parse(row.rawJson) }));
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

export function setPendingApprovals(dbPath, jobId, status, actor = "operator") {
  if (!["approved", "rejected"].includes(status)) {
    throw new Error(`Unsupported approval status ${status}`);
  }
  sqliteExec(dbPath, sql`
UPDATE approvals
SET status = ${status},
    approved_by = ${actor},
    approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE job_id = ${jobId} AND status = 'pending';
`);
  return sqliteExec(dbPath, sql`
SELECT id, job_id AS jobId, kind, status, channel, token_hash AS tokenHash
FROM approvals
WHERE job_id = ${jobId}
ORDER BY id;
`, { json: true });
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
ORDER BY updated_at DESC, id DESC
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
