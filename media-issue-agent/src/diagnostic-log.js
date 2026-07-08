import { once } from "node:events";
import { appendFileSync, createReadStream, mkdirSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { redactText, sanitizeValue } from "./redact.js";

const ensuredDirs = new Set();
const reportedLogFailures = new Set();

export function defaultDiagnosticLogPath(dbPath = "/state/media-issue-agent.sqlite") {
  return path.join(path.dirname(dbPath || "/state/media-issue-agent.sqlite"), "media-issue-agent.log");
}

function ensureLogDir(logPath) {
  const dir = path.dirname(logPath);
  if (ensuredDirs.has(dir)) {
    return;
  }
  mkdirSync(dir, { recursive: true });
  ensuredDirs.add(dir);
}

function parseTimestamp(value, name) {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  return new Date(ms);
}

export function normalizeDiagnosticLogRange(range = {}) {
  const from = parseTimestamp(range.from, "from");
  const to = parseTimestamp(range.to, "to");
  if (from && to && from.getTime() > to.getTime()) {
    throw new Error("from must be before to");
  }
  return { from, to };
}

export function appendDiagnosticLog(logPath, level, event, payload = {}, options = {}) {
  if (!logPath) {
    return null;
  }
  const record = {
    timestamp: options.timestamp || new Date().toISOString(),
    level: String(level || "info"),
    event: String(event || "event"),
    payload: sanitizeValue(payload)
  };
  ensureLogDir(logPath);
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function lineTimestamp(line) {
  try {
    const parsed = JSON.parse(line);
    return parseTimestamp(parsed?.timestamp, "timestamp");
  } catch {
    return null;
  }
}

function shouldIncludeLine(line, from, to) {
  if (!line.trim()) {
    return false;
  }
  if (!from && !to) {
    return true;
  }
  const timestamp = lineTimestamp(line);
  if (!timestamp) {
    return false;
  }
  if (from && timestamp.getTime() < from.getTime()) {
    return false;
  }
  if (to && timestamp.getTime() > to.getTime()) {
    return false;
  }
  return true;
}

async function writeChunk(writable, chunk) {
  if (!writable.write(chunk)) {
    await once(writable, "drain");
  }
}

export async function streamDiagnosticLog(logPath, range = {}, writable) {
  if (!logPath) {
    return;
  }
  const { from, to } = normalizeDiagnosticLogRange(range);
  try {
    await access(logPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const input = createReadStream(logPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (shouldIncludeLine(line, from, to)) {
      await writeChunk(writable, `${line}\n`);
    }
  }
}

export async function readDiagnosticLog(logPath, range = {}) {
  let text = "";
  await streamDiagnosticLog(logPath, range, {
    write(chunk) {
      text += chunk;
      return true;
    }
  });
  return text;
}

function reportLogFailure(logPath, error) {
  if (reportedLogFailures.has(logPath)) {
    return;
  }
  reportedLogFailures.add(logPath);
  const message = error?.message ? `: ${redactText(error.message)}` : "";
  console.error(`${new Date().toISOString()} media-issue-agent: diagnostic log write failed for ${redactText(logPath)}${message}`);
}

export function createDiagnosticLogger(config = {}) {
  const logPath = config.logPath || defaultDiagnosticLogPath(config.dbPath);
  return {
    logPath,
    log(level, event, payload = {}) {
      try {
        return appendDiagnosticLog(logPath, level, event, payload);
      } catch (error) {
        reportLogFailure(logPath, error);
        return null;
      }
    }
  };
}
