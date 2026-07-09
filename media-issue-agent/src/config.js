import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultDiagnosticLogPath } from "./diagnostic-log.js";

function truthy(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function integer(value, defaultValue, min) {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`Expected integer >= ${min}, got ${value}`);
  }
  return parsed;
}

function list(value) {
  return String(value || "")
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);
}

function containsApiKey(value) {
  if (typeof value === "string") {
    return /\bsk-[A-Za-z0-9_-]{8,}/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(item => containsApiKey(item));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, nested]) => {
      const normalizedKey = key.toLowerCase();
      if ((normalizedKey === "openai_api_key" || normalizedKey === "codex_api_key") && typeof nested === "string" && nested.trim()) {
        return true;
      }
      return containsApiKey(nested);
    });
  }
  return false;
}

export function assertNoOpenAiApiKeys(env = process.env) {
  if (env.OPENAI_API_KEY || env.CODEX_API_KEY) {
    throw new Error("media-issue-agent refuses OpenAI API key auth; use Codex ChatGPT auth in CODEX_HOME instead.");
  }
}

export async function inspectCodexAuth(codexHome) {
  if (!codexHome) {
    return {
      ok: false,
      status: "missing_home",
      message: "CODEX_HOME is required and must point to a Codex ChatGPT-authenticated config directory."
    };
  }
  const authPath = path.join(codexHome, "auth.json");
  try {
    await access(authPath);
  } catch {
    return {
      ok: false,
      status: "missing_auth",
      message: "CODEX_HOME/auth.json is missing; run Codex login with ChatGPT auth first."
    };
  }
  const text = await readFile(authPath, "utf8");
  if (!text.trim()) {
    return {
      ok: false,
      status: "empty_auth",
      message: "CODEX_HOME/auth.json is empty; run Codex login with ChatGPT auth first."
    };
  }
  let authJson;
  try {
    authJson = JSON.parse(text);
  } catch {
    return {
      ok: false,
      status: "invalid_auth",
      message: "CODEX_HOME/auth.json is not valid JSON; run Codex login with ChatGPT auth first."
    };
  }
  if (containsApiKey(authJson)) {
    return {
      ok: false,
      status: "api_key_auth",
      message: "CODEX_HOME/auth.json appears to contain API-key auth; use ChatGPT Codex auth instead."
    };
  }
  return {
    ok: true,
    status: "chatgpt_auth",
    message: "Codex ChatGPT auth is configured.",
    authPath
  };
}

export async function validateCodexHome(codexHome) {
  const auth = await inspectCodexAuth(codexHome);
  if (!auth.ok) {
    throw new Error(auth.message);
  }
  return auth.authPath;
}

export async function loadConfig(env = process.env, options = {}) {
  assertNoOpenAiApiKeys(env);
  const config = {
    mediaMcpUrl: env.ISSUE_AGENT_MEDIA_MCP_URL || "http://media-mcp:6971/mcp",
    mediaMcpBearerToken: env.ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN || "",
    dbPath: env.ISSUE_AGENT_DB_PATH || "/state/media-issue-agent.sqlite",
    logPath: env.ISSUE_AGENT_LOG_PATH || defaultDiagnosticLogPath(env.ISSUE_AGENT_DB_PATH || "/state/media-issue-agent.sqlite"),
    repairWorkspaceRoot: env.ISSUE_AGENT_REPAIR_WORKSPACE_ROOT || path.join(path.dirname(env.ISSUE_AGENT_DB_PATH || "/state/media-issue-agent.sqlite"), "repair-workspaces"),
    repairContext: env.ISSUE_AGENT_REPAIR_CONTEXT || "",
    pollIntervalSeconds: integer(env.ISSUE_AGENT_POLL_INTERVAL_SECONDS, 300, 30),
    issueSnapshotRetention: integer(env.ISSUE_AGENT_SNAPSHOT_RETENTION, 200, 1),
    approvalBackend: env.ISSUE_AGENT_APPROVAL_BACKEND || "cli",
    discordBotToken: env.ISSUE_AGENT_DISCORD_BOT_TOKEN || "",
    discordChannelId: env.ISSUE_AGENT_DISCORD_CHANNEL_ID || "",
    pushoverAppToken: env.ISSUE_AGENT_PUSHOVER_APP_TOKEN || "",
    pushoverUserKey: env.ISSUE_AGENT_PUSHOVER_USER_KEY || "",
    codexHome: env.CODEX_HOME || "",
    codexBin: env.ISSUE_AGENT_CODEX_BIN || "codex",
    codexWorkspace: env.ISSUE_AGENT_CODEX_WORKSPACE || "/tmp/media-issue-agent-workspace",
    codexTimeoutMs: integer(env.ISSUE_AGENT_CODEX_TIMEOUT_MS, 120000, 10000),
    codexRepairTimeoutMs: integer(env.ISSUE_AGENT_CODEX_REPAIR_TIMEOUT_MS, 900000, 10000),
    recoverStaleRunSeconds: integer(env.ISSUE_AGENT_RECOVER_STALE_RUN_SECONDS, 120, 30),
    codexModel: env.ISSUE_AGENT_CODEX_MODEL || "gpt-5.5",
    codexReasoningEffort: env.ISSUE_AGENT_CODEX_REASONING_EFFORT || "xhigh",
    codexFastMode: truthy(env.ISSUE_AGENT_CODEX_FAST_MODE, true),
    codexServiceTier: env.ISSUE_AGENT_CODEX_SERVICE_TIER || (truthy(env.ISSUE_AGENT_CODEX_FAST_MODE, true) ? "fast" : ""),
    codexEnvAllowlist: list(env.ISSUE_AGENT_CODEX_ENV_ALLOWLIST),
    mcpRequestTimeoutMs: integer(env.ISSUE_AGENT_MCP_REQUEST_TIMEOUT_MS, 30000, 1000),
    webEnabled: truthy(env.ISSUE_AGENT_WEB_ENABLED, true),
    webHost: env.ISSUE_AGENT_WEB_HOST || "0.0.0.0",
    webPort: integer(env.ISSUE_AGENT_WEB_PORT, 6983, 1),
    webUsername: env.ISSUE_AGENT_WEB_USERNAME || "operator",
    webPassword: env.ISSUE_AGENT_WEB_PASSWORD || ""
  };

  if (!config.mediaMcpBearerToken) {
    throw new Error("ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN is required.");
  }

  if (options.requireCodexAuth !== false) {
    config.codexAuthPath = await validateCodexHome(config.codexHome);
  }
  if (options.requireWebPassword && config.webEnabled && !config.webPassword) {
    throw new Error("ISSUE_AGENT_WEB_PASSWORD is required when the media issue agent Web UI is enabled.");
  }
  return config;
}
