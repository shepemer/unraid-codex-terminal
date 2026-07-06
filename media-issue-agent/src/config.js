import { access, readFile } from "node:fs/promises";
import path from "node:path";

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

export function assertNoOpenAiApiKeys(env = process.env) {
  if (env.OPENAI_API_KEY || env.CODEX_API_KEY) {
    throw new Error("media-issue-agent refuses OpenAI API key auth; use Codex ChatGPT auth in CODEX_HOME instead.");
  }
}

export async function validateCodexHome(codexHome) {
  if (!codexHome) {
    throw new Error("CODEX_HOME is required and must point to a Codex ChatGPT-authenticated config directory.");
  }
  const authPath = path.join(codexHome, "auth.json");
  await access(authPath);
  const text = await readFile(authPath, "utf8");
  if (!text.trim()) {
    throw new Error("CODEX_HOME/auth.json is empty; run Codex login with ChatGPT auth first.");
  }
  if (/OPENAI_API_KEY|CODEX_API_KEY|\bsk-[A-Za-z0-9_-]{8,}/.test(text)) {
    throw new Error("CODEX_HOME/auth.json appears to contain API-key auth; use ChatGPT Codex auth instead.");
  }
  return authPath;
}

export async function loadConfig(env = process.env, options = {}) {
  assertNoOpenAiApiKeys(env);
  const config = {
    mediaMcpUrl: env.ISSUE_AGENT_MEDIA_MCP_URL || "http://media-mcp:6971/mcp",
    mediaMcpBearerToken: env.ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN || "",
    dbPath: env.ISSUE_AGENT_DB_PATH || "/state/media-issue-agent.sqlite",
    pollIntervalSeconds: integer(env.ISSUE_AGENT_POLL_INTERVAL_SECONDS, 300, 30),
    dryRun: truthy(env.ISSUE_AGENT_DRY_RUN, true),
    approvalBackend: env.ISSUE_AGENT_APPROVAL_BACKEND || "cli",
    discordBotToken: env.ISSUE_AGENT_DISCORD_BOT_TOKEN || "",
    discordChannelId: env.ISSUE_AGENT_DISCORD_CHANNEL_ID || "",
    codexHome: env.CODEX_HOME || "",
    codexBin: env.ISSUE_AGENT_CODEX_BIN || "codex",
    codexWorkspace: env.ISSUE_AGENT_CODEX_WORKSPACE || "/tmp/media-issue-agent-workspace",
    codexTimeoutMs: integer(env.ISSUE_AGENT_CODEX_TIMEOUT_MS, 120000, 10000),
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
