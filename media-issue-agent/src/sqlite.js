import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SQLITE_BUSY_PATTERNS = [
  /database is locked/i,
  /database is busy/i,
  /database table is locked/i,
  /SQLITE_BUSY/i,
  /SQLITE_LOCKED/i
];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusyErrorText(text) {
  return SQLITE_BUSY_PATTERNS.some(pattern => pattern.test(text || ""));
}

function sqlValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot store non-finite number in SQLite");
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function sql(values, ...substitutions) {
  return values.reduce((query, part, index) => {
    if (index === 0) {
      return part;
    }
    return `${query}${sqlValue(substitutions[index - 1])}${part}`;
  }, "");
}

export async function ensureDbDir(dbPath) {
  const dbDir = path.dirname(dbPath);
  try {
    await mkdir(dbDir, { recursive: true });
    await access(dbDir, constants.W_OK);
  } catch {
    throw new Error(`SQLite state directory is not writable: ${dbDir}. Ensure the host State Directory bind mount exists and is writable by container uid 1000/gid 1000.`);
  }
}

export function sqliteExec(dbPath, statement, options = {}) {
  const maxAttempts = Math.max(1, Number(options.attempts || 5));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 10000));
  const args = options.json ? ["-cmd", `.timeout ${timeoutMs}`, "-json", dbPath] : ["-cmd", `.timeout ${timeoutMs}`, dbPath];
  let lastFailure = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = spawnSync("sqlite3", args, {
      input: statement,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      if (!options.json) {
        return result.stdout;
      }
      const text = result.stdout.trim();
      return text ? JSON.parse(text) : [];
    }
    lastFailure = result.stderr.trim() || result.stdout.trim();
    if (!isBusyErrorText(lastFailure) || attempt === maxAttempts) {
      break;
    }
    sleepSync(Math.min(250 * attempt, 1000));
  }
  throw new Error(`sqlite3 failed: ${lastFailure}`);
}
