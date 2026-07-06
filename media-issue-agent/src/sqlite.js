import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

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
  await mkdir(path.dirname(dbPath), { recursive: true });
}

export function sqliteExec(dbPath, statement, options = {}) {
  const args = options.json ? ["-json", dbPath] : [dbPath];
  const result = spawnSync("sqlite3", args, {
    input: statement,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  if (!options.json) {
    return result.stdout;
  }
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : [];
}
