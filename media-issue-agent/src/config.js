import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultDiagnosticLogPath } from "./diagnostic-log.js";

export const CODEX_SETTING_DEFAULTS = Object.freeze({
  model: "gpt-5.5",
  reasoningEffort: "xhigh",
  fastMode: true,
  serviceTier: "fast",
  repairContext: ""
});

export const OPERATIONS_SETTING_DEFAULTS = Object.freeze({
  pollIntervalSeconds: 300,
  snapshotRetention: 200,
  serverOwnerReporterUsername: ""
});

export function normalizeReporterUsernames(value) {
  const raw = String(value || "");
  if (/[\r\n\0]/.test(raw)) {
    throw new Error("Trusted server-owner reporters must be a comma-separated single line.");
  }
  const seen = new Set();
  const reporters = [];
  for (const candidate of raw.split(",")) {
    const reporter = candidate.trim();
    if (!reporter) {
      continue;
    }
    const identity = reporter.toLowerCase();
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    reporters.push(reporter);
  }
  const normalized = reporters.join(", ");
  if (normalized.length > 200) {
    throw new Error("Trusted server-owner reporters must be at most 200 characters after normalization.");
  }
  return normalized;
}

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

function hasEnvValue(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key)
    && env[key] !== undefined
    && env[key] !== null
    && String(env[key]) !== "";
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

function hasChatGptTokenShape(authJson) {
  if (!authJson || typeof authJson !== "object" || Array.isArray(authJson)) {
    return false;
  }
  const authMode = String(authJson.auth_mode || authJson.authMode || "").trim().toLowerCase();
  if (authMode !== "chatgpt") {
    return false;
  }
  const tokens = authJson.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return false;
  }
  return [tokens.access_token, tokens.refresh_token, tokens.id_token]
    .some(value => typeof value === "string" && value.trim().length > 0);
}

export function assertNoOpenAiApiKeys(env = process.env) {
  if (env.OPENAI_API_KEY || env.CODEX_API_KEY) {
    throw new Error("media-issue-agent refuses generic OpenAI API key auth; use Codex ChatGPT auth in CODEX_HOME. Slack moderation uses only ISSUE_AGENT_OPENAI_MODERATION_API_KEY.");
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
  if (!hasChatGptTokenShape(authJson)) {
    return {
      ok: false,
      status: "missing_chatgpt_tokens",
      message: "CODEX_HOME/auth.json does not contain a valid ChatGPT Codex token cache; complete Codex ChatGPT login first."
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
    repairContext: env.ISSUE_AGENT_REPAIR_CONTEXT || CODEX_SETTING_DEFAULTS.repairContext,
    serverOwnerReporterUsername: normalizeReporterUsernames(
      env.ISSUE_AGENT_SERVER_OWNER_REPORTER_USERNAME || OPERATIONS_SETTING_DEFAULTS.serverOwnerReporterUsername
    ),
    pollIntervalSeconds: integer(env.ISSUE_AGENT_POLL_INTERVAL_SECONDS, OPERATIONS_SETTING_DEFAULTS.pollIntervalSeconds, 30),
    issueSnapshotRetention: integer(env.ISSUE_AGENT_SNAPSHOT_RETENTION, OPERATIONS_SETTING_DEFAULTS.snapshotRetention, 1),
    pushoverAppToken: env.ISSUE_AGENT_PUSHOVER_APP_TOKEN || "",
    pushoverUserKey: env.ISSUE_AGENT_PUSHOVER_USER_KEY || "",
    slackEnabled: truthy(env.ISSUE_AGENT_SLACK_ENABLED, false),
    slackAppToken: env.ISSUE_AGENT_SLACK_APP_TOKEN || "",
    slackBotToken: env.ISSUE_AGENT_SLACK_BOT_TOKEN || "",
    slackChannelId: String(env.ISSUE_AGENT_SLACK_CHANNEL_ID || "").trim(),
    slackModerationApiKey: env.ISSUE_AGENT_OPENAI_MODERATION_API_KEY || "",
    codexHome: env.CODEX_HOME || "",
    codexBin: env.ISSUE_AGENT_CODEX_BIN || "codex",
    codexWorkspace: env.ISSUE_AGENT_CODEX_WORKSPACE || "/tmp/media-issue-agent-workspace",
    codexTimeoutMs: integer(env.ISSUE_AGENT_CODEX_TIMEOUT_MS, 120000, 10000),
    codexRepairTimeoutMs: integer(env.ISSUE_AGENT_CODEX_REPAIR_TIMEOUT_MS, 14400000, 10000),
    recoverStaleRunSeconds: integer(env.ISSUE_AGENT_RECOVER_STALE_RUN_SECONDS, 120, 30),
    codexModel: env.ISSUE_AGENT_CODEX_MODEL || CODEX_SETTING_DEFAULTS.model,
    codexReasoningEffort: env.ISSUE_AGENT_CODEX_REASONING_EFFORT || CODEX_SETTING_DEFAULTS.reasoningEffort,
    codexFastMode: truthy(env.ISSUE_AGENT_CODEX_FAST_MODE, CODEX_SETTING_DEFAULTS.fastMode),
    codexServiceTier: env.ISSUE_AGENT_CODEX_SERVICE_TIER || (truthy(env.ISSUE_AGENT_CODEX_FAST_MODE, CODEX_SETTING_DEFAULTS.fastMode) ? CODEX_SETTING_DEFAULTS.serviceTier : ""),
    codexEnvAllowlist: list(env.ISSUE_AGENT_CODEX_ENV_ALLOWLIST),
    mcpRequestTimeoutMs: integer(env.ISSUE_AGENT_MCP_REQUEST_TIMEOUT_MS, 300000, 1000),
    webEnabled: truthy(env.ISSUE_AGENT_WEB_ENABLED, true),
    webHost: env.ISSUE_AGENT_WEB_HOST || "0.0.0.0",
    webPort: integer(env.ISSUE_AGENT_WEB_PORT, 6983, 1),
    webUsername: env.ISSUE_AGENT_WEB_USERNAME || "operator",
    webPassword: env.ISSUE_AGENT_WEB_PASSWORD || ""
  };

  const codexEnvironment = {};
  if (hasEnvValue(env, "ISSUE_AGENT_CODEX_MODEL")) codexEnvironment.model = config.codexModel;
  if (hasEnvValue(env, "ISSUE_AGENT_CODEX_REASONING_EFFORT")) codexEnvironment.reasoningEffort = config.codexReasoningEffort;
  if (hasEnvValue(env, "ISSUE_AGENT_CODEX_FAST_MODE")) codexEnvironment.fastMode = config.codexFastMode;
  if (hasEnvValue(env, "ISSUE_AGENT_CODEX_SERVICE_TIER") || hasEnvValue(env, "ISSUE_AGENT_CODEX_FAST_MODE")) {
    codexEnvironment.serviceTier = config.codexServiceTier;
  }
  if (hasEnvValue(env, "ISSUE_AGENT_REPAIR_CONTEXT")) codexEnvironment.repairContext = config.repairContext;

  const operationsEnvironment = {};
  if (hasEnvValue(env, "ISSUE_AGENT_POLL_INTERVAL_SECONDS")) operationsEnvironment.pollIntervalSeconds = config.pollIntervalSeconds;
  if (hasEnvValue(env, "ISSUE_AGENT_SNAPSHOT_RETENTION")) operationsEnvironment.snapshotRetention = config.issueSnapshotRetention;
  if (hasEnvValue(env, "ISSUE_AGENT_SERVER_OWNER_REPORTER_USERNAME")) {
    operationsEnvironment.serverOwnerReporterUsername = config.serverOwnerReporterUsername;
  }
  config.legacySettingsEnvironment = {
    codex: codexEnvironment,
    operations: operationsEnvironment
  };

  if (!config.mediaMcpBearerToken) {
    throw new Error("ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN is required.");
  }
  if (config.slackEnabled) {
    const missing = [
      ["ISSUE_AGENT_SLACK_APP_TOKEN", config.slackAppToken],
      ["ISSUE_AGENT_SLACK_BOT_TOKEN", config.slackBotToken],
      ["ISSUE_AGENT_SLACK_CHANNEL_ID", config.slackChannelId],
      ["ISSUE_AGENT_OPENAI_MODERATION_API_KEY", config.slackModerationApiKey]
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) {
      throw new Error(`Slack is enabled but required configuration is missing: ${missing.join(", ")}.`);
    }
    if (!config.slackAppToken.startsWith("xapp-")) {
      throw new Error("ISSUE_AGENT_SLACK_APP_TOKEN must be a Slack app-level token beginning with xapp-.");
    }
    if (!config.slackBotToken.startsWith("xoxb-")) {
      throw new Error("ISSUE_AGENT_SLACK_BOT_TOKEN must be a Slack bot OAuth token beginning with xoxb-.");
    }
  }

  if (options.requireCodexAuth !== false) {
    config.codexAuthPath = await validateCodexHome(config.codexHome);
  }
  if (options.requireWebPassword && config.webEnabled && !config.webPassword) {
    throw new Error("ISSUE_AGENT_WEB_PASSWORD is required when the media issue agent Web UI is enabled.");
  }
  return config;
}
