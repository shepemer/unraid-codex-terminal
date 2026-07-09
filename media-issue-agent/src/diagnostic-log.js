import { once } from "node:events";
import { appendFileSync, createReadStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { redactText, sanitizeValue } from "./redact.js";

export const DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_DIAGNOSTIC_LOG_ROTATED_FILES = 4;

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

function rotatedLogPath(logPath, index) {
  return `${logPath}.${index}`;
}

export function diagnosticLogFiles(logPath) {
  return [
    ...Array.from(
      { length: DEFAULT_DIAGNOSTIC_LOG_ROTATED_FILES },
      (_, index) => rotatedLogPath(logPath, DEFAULT_DIAGNOSTIC_LOG_ROTATED_FILES - index)
    ),
    logPath
  ].filter(file => existsSync(file));
}

export function rotateDiagnosticLogIfNeeded(logPath, incomingBytes = 0, options = {}) {
  const maxBytes = Number(options.maxBytes || DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES);
  const rotatedFiles = Number(options.rotatedFiles || DEFAULT_DIAGNOSTIC_LOG_ROTATED_FILES);
  if (!logPath || maxBytes <= 0 || rotatedFiles <= 0 || !existsSync(logPath)) {
    return false;
  }
  const currentSize = statSync(logPath).size;
  if (currentSize + Number(incomingBytes || 0) <= maxBytes) {
    return false;
  }
  const oldest = rotatedLogPath(logPath, rotatedFiles);
  if (existsSync(oldest)) {
    unlinkSync(oldest);
  }
  for (let index = rotatedFiles - 1; index >= 1; index -= 1) {
    const from = rotatedLogPath(logPath, index);
    if (existsSync(from)) {
      renameSync(from, rotatedLogPath(logPath, index + 1));
    }
  }
  renameSync(logPath, rotatedLogPath(logPath, 1));
  return true;
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
  const line = `${JSON.stringify(record)}\n`;
  rotateDiagnosticLogIfNeeded(logPath, Buffer.byteLength(line), options);
  appendFileSync(logPath, line, "utf8");
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
  for (const file of diagnosticLogFiles(logPath)) {
    try {
      await access(file);
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const input = createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (shouldIncludeLine(line, from, to)) {
        await writeChunk(writable, `${line}\n`);
      }
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

export async function readDiagnosticLogRecords(logPath, range = {}, options = {}) {
  const text = await readDiagnosticLog(logPath, range);
  const records = text
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const limit = Math.max(1, Math.min(Number(options.limit || 500), 5000));
  return records.slice(-limit);
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
