import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const SQLITE_BUSY_PATTERNS = [
  /database is locked/i,
  /database is busy/i,
  /database table is locked/i,
  /SQLITE_BUSY/i,
  /SQLITE_LOCKED/i
];

const MAX_OPEN_DATABASES = 32;
const databases = new Map();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusyErrorText(text) {
  return SQLITE_BUSY_PATTERNS.some(pattern => pattern.test(text || ""));
}

function databaseKey(dbPath) {
  return dbPath === ":memory:" ? dbPath : path.resolve(dbPath);
}

function closeOldestDatabase() {
  if (databases.size < MAX_OPEN_DATABASES) {
    return;
  }
  const [oldestKey, oldest] = databases.entries().next().value || [];
  if (!oldestKey || !oldest) {
    return;
  }
  databases.delete(oldestKey);
  oldest.close();
}

function databaseFor(dbPath, timeoutMs) {
  const key = databaseKey(dbPath);
  const existing = databases.get(key);
  if (existing) {
    databases.delete(key);
    databases.set(key, existing);
    existing.exec(`PRAGMA busy_timeout = ${Math.max(1000, Number(timeoutMs || 10000))};`);
    return existing;
  }
  closeOldestDatabase();
  const database = new DatabaseSync(key);
  database.exec(`
PRAGMA busy_timeout = ${Math.max(1000, Number(timeoutMs || 10000))};
PRAGMA foreign_keys = ON;
  `);
  databases.set(key, database);
  return database;
}

function closeDatabases() {
  for (const database of databases.values()) {
    try {
      database.close();
    } catch {
      // Process shutdown should not be blocked by an already-closed database.
    }
  }
  databases.clear();
}

process.once("exit", closeDatabases);

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
  let lastFailure = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const database = databaseFor(dbPath, timeoutMs);
      if (!options.json) {
        database.exec(statement);
        return "";
      }
      return database.prepare(statement).all().map(row => ({ ...row }));
    } catch (error) {
      lastFailure = error?.message || String(error);
      if (!isBusyErrorText(lastFailure) || attempt === maxAttempts) {
        break;
      }
      sleepSync(Math.min(250 * attempt, 1000));
    }
  }
  throw new Error(`SQLite failed: ${lastFailure}`);
}

export function sqliteTransaction(dbPath, callback, options = {}) {
  const maxAttempts = Math.max(1, Number(options.attempts || 5));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 10000));
  let lastFailure = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const database = databaseFor(dbPath, timeoutMs);
    let transactionStarted = false;
    try {
      database.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;
      const result = callback(database);
      if (result && typeof result.then === "function") {
        throw new Error("SQLite transactions must use a synchronous callback");
      }
      database.exec("COMMIT;");
      return result;
    } catch (error) {
      lastFailure = error;
      if (transactionStarted) {
        try {
          database.exec("ROLLBACK;");
        } catch {
          // Preserve the original transaction failure.
        }
      }
      const message = error?.message || String(error);
      if (!isBusyErrorText(message) || attempt === maxAttempts) {
        throw error;
      }
      sleepSync(Math.min(250 * attempt, 1000));
    }
  }
  throw lastFailure || new Error("SQLite transaction failed");
}
