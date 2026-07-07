import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readdir, rm, stat, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import * as z from "zod/v4";

const env = process.env;
const port = Number(env.MEDIA_MCP_PORT || 6971);
const host = env.MEDIA_MCP_HOST || "0.0.0.0";
const bearerToken = env.MEDIA_MCP_BEARER_TOKEN || "";
const requestTimeoutMs = Number(env.MEDIA_MCP_REQUEST_TIMEOUT_MS || 30000);
const allowedHosts = allowedHostnames(env.MEDIA_MCP_ALLOWED_HOSTS, "media-mcp", host);
const mediaPathMaps = parsePathMaps(env.MEDIA_MCP_PATH_MAPS || env.CODEX_MEDIA_PATH_MAPS || "/downloads=/mnt/unraid/downloads");

if (!bearerToken) {
  console.error("media-mcp: MEDIA_MCP_BEARER_TOKEN is required");
  process.exit(1);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("media-mcp: MEDIA_MCP_PORT must be a valid TCP port");
  process.exit(1);
}

if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000) {
  console.error("media-mcp: MEDIA_MCP_REQUEST_TIMEOUT_MS must be at least 1000");
  process.exit(1);
}

const configuredServices = {
  sonarr: serviceConfig("SONARR", "apiKey"),
  radarr: serviceConfig("RADARR", "apiKey"),
  plex: plexConfig(),
  bazarr: serviceConfig("BAZARR", "apiKey"),
  prowlarr: serviceConfig("PROWLARR", "apiKey"),
  qbittorrent: basicServiceConfig("QBITTORRENT"),
  nzbget: basicServiceConfig("NZBGET"),
  seerr: seerrConfig(),
  tautulli: serviceConfig("TAUTULLI", "apiKey"),
  tracearr: serviceConfig("TRACEARR", "apiKey"),
  threadfin: threadfinConfig()
};

const arrWantedDefaultPageSize = 25;
const arrWantedMaxPageSize = 250;
const arrWantedMaxLimit = 5000;
const arrWantedInternalPageSize = 250;
const arrExactSearchDefaultBatchSize = 100;
const arrExactSearchMaxBatchSize = 250;

const arrWantedPaginationSchema = {
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional()
};

const sonarrWantedMissingIdsSchema = {
  monitoredOnly: z.boolean().default(true),
  airedOnly: z.boolean().default(true),
  includeSpecials: z.boolean().default(false)
};

const radarrWantedMissingIdsSchema = {
  monitoredOnly: z.boolean().default(true),
  availableOnly: z.boolean().default(true)
};

const sonarrSearchMissingExactSchema = {
  batchSize: z.number().int().min(1).default(arrExactSearchDefaultBatchSize),
  monitoredOnly: z.boolean().default(true),
  airedOnly: z.boolean().default(true),
  includeSpecials: z.boolean().default(false),
  dryRun: z.boolean().default(true)
};

const radarrSearchMissingExactSchema = {
  batchSize: z.number().int().min(1).default(arrExactSearchDefaultBatchSize),
  monitoredOnly: z.boolean().default(true),
  availableOnly: z.boolean().default(true),
  dryRun: z.boolean().default(true)
};

if (!Object.values(configuredServices).some(Boolean)) {
  console.error("media-mcp: configure at least one supported media service");
  process.exit(1);
}

function serviceConfig(prefix, authMode) {
  const url = env[`${prefix}_URL`];
  const apiKey = env[`${prefix}_API_KEY`];
  if (!url && !apiKey) {
    return null;
  }
  if (!url || !apiKey) {
    console.error(`media-mcp: ${prefix}_URL and ${prefix}_API_KEY must be set together`);
    process.exit(1);
  }
  return { url: normalizeBaseUrl(url), apiKey, authMode };
}

function basicServiceConfig(prefix) {
  const url = env[`${prefix}_URL`];
  const username = env[`${prefix}_USERNAME`];
  const password = env[`${prefix}_PASSWORD`];
  if (!url && !username && !password) {
    return null;
  }
  if (!url || !username || !password) {
    console.error(`media-mcp: ${prefix}_URL, ${prefix}_USERNAME, and ${prefix}_PASSWORD must be set together`);
    process.exit(1);
  }
  return { url: normalizeBaseUrl(url), username, password };
}

function seerrConfig() {
  const url = env.SEERR_URL || env.OVERSEERR_URL || env.JELLYSEERR_URL;
  const apiKey = env.SEERR_API_KEY || env.OVERSEERR_API_KEY || env.JELLYSEERR_API_KEY;
  if (!url && !apiKey) {
    return null;
  }
  if (!url || !apiKey) {
    console.error("media-mcp: SEERR_URL and SEERR_API_KEY must be set together");
    process.exit(1);
  }
  return { url: normalizeBaseUrl(url), apiKey };
}

function plexConfig() {
  const url = env.PLEX_URL;
  const token = env.PLEX_TOKEN;
  if (!url && !token) {
    return null;
  }
  if (!url || !token) {
    console.error("media-mcp: PLEX_URL and PLEX_TOKEN must be set together");
    process.exit(1);
  }
  return {
    url: normalizeBaseUrl(url),
    token,
    communityUrl: normalizeBaseUrl(env.PLEX_COMMUNITY_URL || "https://community.plex.tv")
  };
}

function threadfinConfig() {
  const url = env.THREADFIN_URL;
  const username = env.THREADFIN_USERNAME;
  const password = env.THREADFIN_PASSWORD;
  const token = env.THREADFIN_TOKEN;
  if (!url && !username && !password && !token) {
    return null;
  }
  if (!url) {
    console.error("media-mcp: THREADFIN_URL is required when Threadfin credentials are set");
    process.exit(1);
  }
  if ((username && !password) || (!username && password)) {
    console.error("media-mcp: THREADFIN_USERNAME and THREADFIN_PASSWORD must be set together");
    process.exit(1);
  }
  return {
    url: normalizeBaseUrl(url),
    username,
    password,
    token,
    apiToken: token || "",
    webToken: token || ""
  };
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function allowedHostnames(value, serviceName, bindHost) {
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", serviceName]);
  if (bindHost && !["0.0.0.0", "::"].includes(bindHost)) {
    hosts.add(bindHost);
  }
  for (const hostName of (value || "").split(",")) {
    const trimmed = hostName.trim();
    if (trimmed) {
      hosts.add(trimmed);
    }
  }
  return [...hosts];
}

function requireService(name) {
  const service = configuredServices[name];
  if (!service) {
    throw new Error(`${name} is not configured`);
  }
  return service;
}

function jsonText(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function limitList(value, limit) {
  const max = Math.max(1, Math.min(Number(limit || 50), 250));
  if (Array.isArray(value)) {
    return { total: value.length, returned: Math.min(value.length, max), records: value.slice(0, max) };
  }
  if (value && Array.isArray(value.records)) {
    return { ...value, totalRecords: value.records.length, records: value.records.slice(0, max) };
  }
  return value;
}

function limitPlexContainer(value, limit) {
  const max = Math.max(1, Math.min(Number(limit || 50), 250));
  const container = value?.MediaContainer;
  if (!container) {
    return value;
  }
  for (const key of ["Metadata", "Directory", "Hub"]) {
    if (Array.isArray(container[key])) {
      return {
        ...value,
        MediaContainer: {
          ...container,
          totalRecords: container[key].length,
          returnedRecords: Math.min(container[key].length, max),
          [key]: container[key].slice(0, max)
        }
      };
    }
  }
  return value;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function plexApi(path = "", options = {}) {
  const service = requireService("plex");
  const cleanPath = path.replace(/^\/+/, "");
  const url = new URL(cleanPath ? `${service.url}/${cleanPath}` : `${service.url}/`);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const headers = {
    "X-Plex-Token": service.token,
    "X-Plex-Client-Identifier": "unraid-codex-media-mcp",
    "X-Plex-Product": "Unraid Codex Terminal Media MCP",
    "X-Plex-Version": "0.1.0",
    "X-Plex-Device": "MCP",
    "X-Plex-Device-Name": "media-mcp",
    Accept: "application/json"
  };
  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return fetchJson(url, { method: options.method || "GET", headers, body });
}

async function plexCommunityGraphql(query, variables = {}, operationName) {
  const service = requireService("plex");
  const url = new URL(`${service.communityUrl}/api`);
  const body = await fetchJson(url, {
    method: "POST",
    headers: {
      "X-Plex-Token": service.token,
      "X-Plex-Client-Identifier": "unraid-codex-media-mcp",
      "X-Plex-Product": "Unraid Codex Terminal Media MCP",
      "X-Plex-Version": "0.1.0",
      "X-Plex-Device": "MCP",
      "X-Plex-Device-Name": "media-mcp",
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(compactObject({ query, variables, operationName }))
  });
  if (Array.isArray(body?.errors) && body.errors.length) {
    const message = body.errors.map(error => error.message).filter(Boolean).join("; ") || "unknown GraphQL error";
    throw new Error(`Plex community GraphQL ${operationName || "request"} failed: ${message}`);
  }
  return body?.data ?? body;
}

async function bazarrApi(path, options = {}) {
  const service = requireService("bazarr");
  const url = new URL(`${service.url}/api/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const headers = {
    "X-API-KEY": service.apiKey,
    Accept: "application/json"
  };
  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return fetchJson(url, { method: options.method || "GET", headers, body });
}

async function arrApi(serviceName, apiVersion, path, options = {}) {
  const service = requireService(serviceName);
  const url = new URL(`${service.url}/api/${apiVersion}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const headers = {
    "X-Api-Key": service.apiKey,
    Accept: "application/json"
  };
  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return fetchJson(url, { method: options.method || "GET", headers, body });
}

async function seerrApi(path, options = {}) {
  const service = requireService("seerr");
  const url = new URL(`${service.url}/api/v1/${path.replace(/^\/+/, "")}`);
  const queryParts = Object.entries(options.query || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  if (queryParts.length) {
    url.search = queryParts.join("&");
  }
  const headers = {
    "X-Api-Key": service.apiKey,
    Accept: "application/json"
  };
  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return fetchJson(url, { method: options.method || "GET", headers, body });
}

async function tautulliApi(cmd, options = {}) {
  const service = requireService("tautulli");
  const url = new URL(`${service.url}/api/v2`);
  url.searchParams.set("apikey", service.apiKey);
  url.searchParams.set("cmd", cmd);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const body = await fetchJson(url, { method: "GET", headers: { Accept: "application/json" } });
  if (body?.response?.result === "error") {
    throw new Error(`Tautulli ${cmd} failed: ${body.response.message || "unknown error"}`);
  }
  return body?.response?.data ?? body;
}

async function tracearrApi(path, options = {}) {
  const service = requireService("tracearr");
  const cleanPath = path.replace(/^\/+/, "");
  const url = new URL(`${service.url}/api/v1/public/${cleanPath}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return fetchJson(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${service.apiKey}`,
      Accept: "application/json"
    }
  });
}

function threadfinEndpoint(path) {
  const service = requireService("threadfin");
  const cleanPath = path.replace(/^\/+/, "");
  return new URL(`${service.url}/${cleanPath}`);
}

async function threadfinPostJson(path, payload) {
  const url = threadfinEndpoint(path);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(`Threadfin ${path} failed: ${response.status} ${response.statusText}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function threadfinApiLogin() {
  const service = requireService("threadfin");
  if (!service.username || !service.password) {
    throw new Error("Threadfin API authentication requires THREADFIN_TOKEN or THREADFIN_USERNAME and THREADFIN_PASSWORD");
  }
  const body = await threadfinPostJson("api/", {
    cmd: "login",
    username: service.username,
    password: service.password
  });
  if (body?.status === false) {
    throw new Error(`Threadfin API login failed: ${body.err || body.error || "unknown error"}`);
  }
  if (!body?.token) {
    throw new Error("Threadfin API login did not return a token");
  }
  service.apiToken = body.token;
  return body.token;
}

async function threadfinApi(cmd, payload = {}, options = {}) {
  const service = requireService("threadfin");
  const requestBody = compactObject({
    ...payload,
    cmd,
    token: service.apiToken || service.token || undefined
  });
  let body = await threadfinPostJson("api/", requestBody);
  const authFailed = body?.status === false && /auth|login|token|incorrect/i.test(String(body.err || body.error || ""));
  if (authFailed && options.retryAuth !== false && service.username && service.password) {
    requestBody.token = await threadfinApiLogin();
    body = await threadfinPostJson("api/", requestBody);
  }
  if (body?.status === false) {
    throw new Error(`Threadfin API ${cmd} failed: ${body.err || body.error || "unknown error"}`);
  }
  if (body?.token) {
    service.apiToken = body.token;
  }
  return body;
}

async function threadfinWebLogin() {
  const service = requireService("threadfin");
  if (!service.username || !service.password) {
    throw new Error("Threadfin web authentication requires THREADFIN_TOKEN or THREADFIN_USERNAME and THREADFIN_PASSWORD");
  }
  const form = new URLSearchParams({
    username: service.username,
    password: service.password
  });
  const response = await fetch(threadfinEndpoint("web/"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const cookie = response.headers.get("set-cookie") || "";
  const token = cookie.match(/(?:^|;\s*)Token=([^;]+)/i)?.[1] || cookie.match(/Token=([^;]+)/i)?.[1];
  if (!token) {
    throw new Error(`Threadfin web login did not return a Token cookie (${response.status} ${response.statusText})`);
  }
  service.webToken = decodeURIComponent(token);
  return service.webToken;
}

function threadfinWebsocketUrl(token) {
  const service = requireService("threadfin");
  const url = new URL(service.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/data/`;
  url.search = "";
  url.searchParams.set("Token", token || "-");
  return url.toString();
}

function threadfinWebsocketOnce(cmd, payload = {}, token = "-") {
  if (typeof WebSocket !== "function") {
    throw new Error("Node.js WebSocket client support is required for Threadfin websocket commands");
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(threadfinWebsocketUrl(token));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        ws.close();
      } catch {
        // Ignore close errors after timeout.
      }
      reject(new Error(`Threadfin websocket ${cmd} timed out after ${requestTimeoutMs}ms`));
    }, requestTimeoutMs);

    function finish(error, body) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Ignore close errors after response.
      }
      if (error) {
        reject(error);
      } else {
        resolve(body);
      }
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ ...payload, cmd }));
    };
    ws.onerror = () => finish(new Error(`Threadfin websocket ${cmd} failed`));
    ws.onclose = () => {
      if (!settled) {
        finish(new Error(`Threadfin websocket ${cmd} closed before a response was received`));
      }
    };
    ws.onmessage = event => {
      try {
        finish(null, JSON.parse(event.data));
      } catch (error) {
        finish(error);
      }
    };
  });
}

async function threadfinWs(cmd, payload = {}, options = {}) {
  const service = requireService("threadfin");
  let token = service.webToken || service.token || "-";
  let body = await threadfinWebsocketOnce(cmd, payload, token);
  const authFailed = body?.status === false && /auth|login|token|incorrect|authorization/i.test(String(body.err || body.error || ""));
  if (authFailed && options.retryAuth !== false && service.username && service.password) {
    token = await threadfinWebLogin();
    body = await threadfinWebsocketOnce(cmd, payload, token);
  }
  if (body?.status === false) {
    throw new Error(`Threadfin websocket ${cmd} failed: ${body.err || body.error || "unknown error"}`);
  }
  if (body?.token) {
    service.webToken = body.token;
  }
  return body;
}

async function qbitRequest(path, options = {}) {
  const service = requireService("qbittorrent");
  const loginBody = new URLSearchParams({
    username: service.username,
    password: service.password
  });
  const loginResponse = await fetch(`${service.url}/api/v2/auth/login`, {
    method: "POST",
    body: loginBody,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const loginText = await loginResponse.text();
  const loginOk = loginResponse.ok && (loginResponse.status === 204 || loginText.includes("Ok."));
  if (!loginOk) {
    throw new Error(`qBittorrent login failed: ${loginResponse.status} ${loginResponse.statusText}`);
  }
  const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) {
    throw new Error("qBittorrent login did not return a session cookie");
  }

  const headers = { Cookie: cookie, Accept: "application/json" };
  let body;
  if (options.form) {
    body = new URLSearchParams(options.form);
  }
  const response = await fetch(`${service.url}/api/v2/${path.replace(/^\/+/, "")}`, {
    method: options.method || "GET",
    headers,
    body,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  if (!text) {
    return { ok: true };
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function nzbgetRpc(method, params = []) {
  const service = requireService("nzbget");
  const credentials = Buffer.from(`${service.username}:${service.password}`).toString("base64");
  const response = await fetch(`${service.url}/jsonrpc`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id: 1
    }),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const body = await response.json().catch(async () => ({ error: await response.text() }));
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(body)}`);
  }
  if (body.error) {
    throw new Error(`NZBGet ${method} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

function uniquePositiveIds(ids) {
  return [...new Set(ids.map(id => Number(id)))];
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function decodeHtmlEntities(value) {
  if (typeof value !== "string") {
    return value;
  }
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function decodedField(value) {
  const display = decodeHtmlEntities(value);
  return compactObject({
    value: display,
    raw: typeof value === "string" && value !== display ? value : undefined
  });
}

function cleanPath(value) {
  const decoded = decodeHtmlEntities(value || "");
  return decoded.replace(/\\/g, "/").replace(/\/+$/, "");
}

function parsePathMaps(value) {
  return String(value || "")
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        return null;
      }
      const source = cleanPath(entry.slice(0, separator));
      const target = cleanPath(entry.slice(separator + 1));
      if (!source || !target) {
        return null;
      }
      return { source, target };
    })
    .filter(Boolean)
    .sort((a, b) => b.source.length - a.source.length);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function mediaPathCandidates(pathValue) {
  const clean = cleanPath(pathValue);
  if (!clean) {
    return [];
  }
  const candidates = [clean];
  for (const map of mediaPathMaps) {
    if (!pathInside(map.source, clean)) {
      continue;
    }
    const suffix = clean === map.source ? "" : clean.slice(map.source.length + 1);
    candidates.push(suffix ? `${map.target}/${suffix}` : map.target);
  }
  return uniqueValues(candidates);
}

function pathInside(parent, candidate) {
  const cleanParent = cleanPath(parent);
  const cleanCandidate = cleanPath(candidate);
  if (!cleanParent || !cleanCandidate) {
    return false;
  }
  return cleanCandidate === cleanParent || cleanCandidate.startsWith(`${cleanParent}/`);
}

function likelyLibraryPath(serviceName, pathValue) {
  const clean = cleanPath(pathValue).toLowerCase();
  if (serviceName === "sonarr") {
    return clean === "/tv" || clean.startsWith("/tv/");
  }
  if (serviceName === "radarr") {
    return clean === "/movies" || clean.startsWith("/movies/");
  }
  return false;
}

function pathDisplay(value) {
  const decoded = decodedField(value);
  return compactObject({
    path: decoded.value,
    pathRaw: decoded.raw,
    pathDisplay: decoded.value
  });
}

async function serviceResult(name, fn) {
  if (!configuredServices[name]) {
    return { configured: false };
  }
  try {
    return { configured: true, ...(await fn()) };
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

function firstString(...values) {
  return values.find(value => typeof value === "string" && value.trim()) || undefined;
}

function firstPresent(...values) {
  return values.find(value => value !== undefined && value !== null && value !== "") ?? undefined;
}

function issueTypeName(value) {
  const labels = {
    1: "video",
    2: "audio",
    3: "subtitles",
    4: "other",
    video: "video",
    audio: "audio",
    subtitles: "subtitles",
    other: "other"
  };
  return labels[value] || value;
}

function mediaStatusName(value) {
  const labels = {
    1: "unknown",
    2: "pending",
    3: "processing",
    4: "partially_available",
    5: "available",
    6: "deleted"
  };
  return labels[value] || value;
}

function seerrIssueStatus(issue) {
  if (typeof issue.status === "string") {
    return issue.status;
  }
  if (typeof issue.status === "number") {
    return issue.status === 2 ? "resolved" : "open";
  }
  if (issue.resolvedAt || issue.isResolved === true || issue.closedAt) {
    return "resolved";
  }
  return "open";
}

function summarizeUser(user, verbose = false) {
  if (!user) {
    return undefined;
  }
  return compactObject({
    id: user.id,
    displayName: firstString(user.displayName, user.title, user.username, user.plexUsername, user.name, verbose ? user.email : undefined),
    username: firstString(user.username, user.plexUsername),
    email: verbose ? user.email : undefined
  });
}

function mediaTitle(media) {
  return firstString(media?.title, media?.name, media?.mediaInfo?.title, media?.movie?.title, media?.tv?.title);
}

function mediaType(media) {
  return firstString(media?.mediaType, media?.type, media?.mediaInfo?.mediaType, media?.metadata?.type)
    || (media?.tvdbId ? "tv" : undefined)
    || (media?.tmdbId ? "movie" : undefined);
}

function plexRatingKey(media) {
  return firstPresent(media?.ratingKey, media?.plexRatingKey, media?.plexId, media?.externalServiceId);
}

function summarizeIssueComment(comment, verbose = false) {
  if (!comment) {
    return undefined;
  }
  return compactObject({
    id: comment.id,
    message: comment.message,
    reporter: summarizeUser(comment.user ?? comment.createdBy, verbose),
    createdAt: comment.createdAt ?? comment.date,
    updatedAt: comment.updatedAt,
    rawStatus: verbose ? comment.status : undefined,
    raw: verbose ? comment : undefined
  });
}

function summarizeSeerrIssue(issue, verbose = false) {
  const comments = Array.isArray(issue.comments) ? issue.comments.map(comment => summarizeIssueComment(comment, verbose)) : [];
  const media = issue.media ?? issue.mediaInfo ?? {};
  return compactObject({
    source: "seerr",
    id: issue.id,
    type: issueTypeName(issue.issueType ?? issue.type),
    category: issueTypeName(issue.issueType ?? issue.type),
    status: seerrIssueStatus(issue),
    subject: firstString(issue.subject, issue.message, comments[0]?.message),
    message: firstString(issue.message, comments[0]?.message),
    reporter: summarizeUser(issue.createdBy ?? issue.user ?? issue.reportedBy, verbose),
    modifiedBy: summarizeUser(issue.modifiedBy, verbose),
    mediaTitle: mediaTitle(media),
    mediaType: mediaType(media),
    plexRatingKey: plexRatingKey(media),
    media: verbose
      ? compactObject({
        id: media.id,
        tmdbId: media.tmdbId,
        tvdbId: media.tvdbId,
        status: mediaStatusName(media.status),
        mediaType: mediaType(media),
        title: mediaTitle(media)
      })
      : undefined,
    comments,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    resolvedAt: issue.resolvedAt,
    rawStatus: verbose ? issue.status : undefined,
    raw: verbose ? issue : undefined
  });
}

function summarizePlexUser(user, verbose = false) {
  if (!user) {
    return undefined;
  }
  return compactObject({
    id: user.id,
    displayName: firstString(user.displayName, user.username),
    username: user.username,
    avatar: verbose ? user.avatar : undefined,
    isMuted: verbose ? user.isMuted : undefined,
    isBlocked: verbose ? user.isBlocked : undefined,
    isHidden: verbose ? user.isHidden : undefined
  });
}

function parsePlexSourceUri(value) {
  if (!value || typeof value !== "string") {
    return {};
  }
  try {
    const url = new URL(value);
    const protocol = url.protocol.toLowerCase();
    if (protocol === "server:" || protocol === "provider:") {
      const rawParts = decodeURIComponent(url.pathname || "")
        .replace(/^\/+|\/+$/g, "")
        .split("/")
        .filter(Boolean);
      const providerIdentifier = protocol === "server:" ? rawParts.shift() : url.host;
      const key = rawParts.length ? `/${rawParts.join("/")}` : undefined;
      const ratingKey = key?.match(/\/library\/metadata\/([^/?#]+)/)?.[1] || rawParts.at(-1);
      return compactObject({
        sourceUri: value,
        isServer: protocol === "server:",
        serverIdentifier: protocol === "server:" ? url.host : undefined,
        providerIdentifier,
        key,
        ratingKey
      });
    }
    if (protocol === "http:" || protocol === "https:") {
      const hash = url.hash.replace(/^#!/, "").replace(/^#/, "");
      const [hashPath, hashQuery = ""] = hash.split("?");
      const params = new URLSearchParams(hashQuery);
      const key = params.get("key") || params.get("metadataKey") || undefined;
      const serverIdentifier = hashPath.match(/\/server\/([^/?#]+)/)?.[1];
      const providerIdentifier = hashPath.match(/\/provider\/([^/?#]+)/)?.[1];
      return compactObject({
        sourceUri: value,
        isServer: Boolean(serverIdentifier),
        serverIdentifier,
        providerIdentifier,
        key,
        ratingKey: key?.match(/\/library\/metadata\/([^/?#]+)/)?.[1]
      });
    }
  } catch {
    const ratingKey = value.match(/\/library\/metadata\/([^/?#]+)/)?.[1];
    return compactObject({ sourceUri: value, ratingKey });
  }
  return compactObject({
    sourceUri: value,
    ratingKey: value.match(/\/library\/metadata\/([^/?#]+)/)?.[1]
  });
}

function plexMetadataItem(body) {
  const records = body?.MediaContainer?.Metadata;
  return Array.isArray(records) ? records[0] : undefined;
}

function plexMetadataDisplayTitle(item) {
  if (!item) {
    return undefined;
  }
  if (item.type === "episode" && item.grandparentTitle && item.title) {
    return `${item.grandparentTitle} - ${item.title}`;
  }
  if (item.type === "season" && item.parentTitle && item.title) {
    return `${item.parentTitle} - ${item.title}`;
  }
  return firstString(item.title, item.grandparentTitle, item.parentTitle);
}

function plexMediaTypeName(type) {
  if (["show", "season", "episode"].includes(type)) {
    return "tv";
  }
  if (type === "movie") {
    return "movie";
  }
  return type;
}

function summarizePlexMetadata(body) {
  const item = plexMetadataItem(body);
  if (!item) {
    return undefined;
  }
  return compactObject({
    ratingKey: item.ratingKey,
    key: item.key,
    guid: item.guid,
    type: item.type,
    mediaType: plexMediaTypeName(item.type),
    title: plexMetadataDisplayTitle(item),
    itemTitle: item.title,
    parentTitle: item.parentTitle,
    grandparentTitle: item.grandparentTitle,
    parentRatingKey: item.parentRatingKey,
    grandparentRatingKey: item.grandparentRatingKey,
    librarySectionID: item.librarySectionID,
    librarySectionTitle: item.librarySectionTitle,
    year: item.year,
    index: item.index,
    parentIndex: item.parentIndex,
    originallyAvailableAt: item.originallyAvailableAt
  });
}

async function plexMetadataForRatingKey(ratingKey) {
  if (!ratingKey || !configuredServices.plex) {
    return { configured: Boolean(configuredServices.plex) };
  }
  try {
    const body = await plexApi(`library/metadata/${encodeURIComponent(String(ratingKey))}`);
    return { configured: true, body, summary: summarizePlexMetadata(body) };
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

function plexMetadataGuidValues(metadataResult) {
  const item = plexMetadataItem(metadataResult?.body);
  return [
    metadataResult?.summary?.guid,
    item?.guid,
    ...(Array.isArray(item?.Guid) ? item.Guid.map(guid => guid.id) : []),
    ...(Array.isArray(item?.Guides) ? item.Guides.map(guid => guid.id) : [])
  ].filter(value => typeof value === "string" && value.trim());
}

function plexMetadataTmdbId(metadataResult) {
  for (const value of plexMetadataGuidValues(metadataResult)) {
    const match = value.match(/(?:tmdb|themoviedb)[^\d]*(\d+)/i);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

function plexMetadataStreams(body) {
  const item = plexMetadataItem(body);
  if (!item) {
    return [];
  }
  return (Array.isArray(item.Media) ? item.Media : []).flatMap(media => {
    return (Array.isArray(media.Part) ? media.Part : []).flatMap(part => {
      return (Array.isArray(part.Stream) ? part.Stream : []).map(stream => ({
        media,
        part,
        stream
      }));
    });
  });
}

function normalizeSubtitleLanguage(value) {
  const text = String(value || "").trim().toLowerCase();
  const aliases = {
    ko: "ko",
    kor: "ko",
    korean: "ko",
    en: "en",
    eng: "en",
    english: "en",
    es: "es",
    spa: "es",
    spanish: "es",
    fr: "fr",
    fre: "fr",
    fra: "fr",
    french: "fr",
    de: "de",
    ger: "de",
    deu: "de",
    german: "de",
    ja: "ja",
    jpn: "ja",
    japanese: "ja",
    zh: "zh",
    chi: "zh",
    zho: "zh",
    chinese: "zh"
  };
  return aliases[text] || text;
}

function summarizePlexSubtitleStream(stream) {
  return compactObject({
    id: stream.id,
    streamType: stream.streamType,
    language: stream.language,
    languageCode: stream.languageCode,
    title: stream.title,
    codec: stream.codec,
    format: stream.format,
    key: stream.key,
    forced: stream.forced,
    hearingImpaired: stream.hearingImpaired,
    selected: stream.selected
  });
}

function plexSubtitleStreamMatchesLanguage(stream, language) {
  const expected = normalizeSubtitleLanguage(language);
  const candidates = [
    stream.languageCode,
    stream.language,
    stream.title
  ].map(normalizeSubtitleLanguage).filter(Boolean);
  return candidates.includes(expected);
}

async function verifyPlexSubtitleTrack(input) {
  const ratingKey = String(input.ratingKey || input.plexRatingKey || "").trim();
  if (!ratingKey) {
    throw new Error("ratingKey is required");
  }
  const language = String(input.language || "").trim();
  if (!language) {
    throw new Error("language is required");
  }
  const body = await plexApi(`library/metadata/${encodeURIComponent(ratingKey)}`);
  const summary = summarizePlexMetadata(body);
  const subtitleStreams = plexMetadataStreams(body)
    .map(({ stream }) => stream)
    .filter(stream => Number(stream.streamType) === 3 || String(stream.streamType).toLowerCase() === "subtitle")
    .map(summarizePlexSubtitleStream);
  const matches = subtitleStreams.filter(stream => plexSubtitleStreamMatchesLanguage(stream, language));
  return {
    ratingKey,
    language: normalizeSubtitleLanguage(language),
    found: matches.length > 0,
    metadata: summary,
    subtitleCount: subtitleStreams.length,
    matches,
    subtitles: subtitleStreams
  };
}

function normalizeMediaMatchTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function summarizeRadarrMovieForRepair(movie) {
  if (!movie) {
    return undefined;
  }
  return compactObject({
    id: movie.id,
    title: movie.title,
    year: movie.year,
    tmdbId: movie.tmdbId,
    monitored: movie.monitored,
    hasFile: Boolean(movie.hasFile || movie.movieFile)
  });
}

async function resolveRadarrMovieForPlex(input) {
  const plexRatingKey = String(input.plexRatingKey || "").trim();
  if (!plexRatingKey) {
    throw new Error("plexRatingKey is required");
  }
  if (!configuredServices.radarr) {
    throw new Error("radarr is not configured");
  }
  const metadata = await plexMetadataForRatingKey(plexRatingKey);
  if (metadata.configured === false) {
    throw new Error("plex is not configured");
  }
  if (metadata.error) {
    throw new Error(`Plex metadata lookup failed for rating key ${plexRatingKey}: ${metadata.error}`);
  }
  const summary = metadata.summary || {};
  if (!summary.ratingKey) {
    throw new Error(`Plex metadata lookup did not return an exact item for rating key ${plexRatingKey}`);
  }
  const targetTitle = firstString(input.title, summary.title, summary.itemTitle);
  const targetYear = Number(firstPresent(input.year, summary.year)) || undefined;
  const tmdbId = plexMetadataTmdbId(metadata);
  const moviesBody = await arrApi("radarr", "v3", "movie");
  const movies = Array.isArray(moviesBody) ? moviesBody : Array.isArray(moviesBody?.records) ? moviesBody.records : [];
  let movie = tmdbId ? movies.find(record => Number(record.tmdbId) === Number(tmdbId)) : undefined;
  if (!movie && targetTitle) {
    const normalizedTarget = normalizeMediaMatchTitle(targetTitle);
    const titleMatches = movies.filter(record => {
      const normalizedMovie = normalizeMediaMatchTitle(record.title);
      const yearMatches = !targetYear || !record.year || Number(record.year) === Number(targetYear);
      return yearMatches && normalizedMovie && (
        normalizedMovie === normalizedTarget
        || normalizedMovie.includes(normalizedTarget)
        || normalizedTarget.includes(normalizedMovie)
      );
    });
    if (titleMatches.length === 1) {
      movie = titleMatches[0];
    }
  }
  if (!movie?.id) {
    throw new Error(`Could not resolve Plex rating key ${plexRatingKey} to one exact Radarr movie`);
  }
  return {
    plexRatingKey,
    plexMetadata: compactObject({
      ratingKey: summary.ratingKey,
      title: summary.title,
      mediaType: summary.mediaType,
      year: summary.year,
      tmdbId
    }),
    radarrMovie: summarizeRadarrMovieForRepair(movie)
  };
}

function bazarrMovieSubtitleQuery(radarrId, language, forced = false, hi = false) {
  return {
    radarrid: Number(radarrId),
    language,
    forced: Boolean(forced),
    hi: Boolean(hi)
  };
}

async function downloadBazarrMovieSubtitlesForPlex(input) {
  const language = String(input.language || "").trim();
  if (!language) {
    throw new Error("language is required");
  }
  const resolved = await resolveRadarrMovieForPlex(input);
  const query = bazarrMovieSubtitleQuery(resolved.radarrMovie.id, language, input.forced, input.hi);
  const endpoint = { method: "PATCH", path: "/api/movies/subtitles", query };
  if (input.dryRun) {
    return {
      dryRun: true,
      ...resolved,
      language,
      endpoint,
      note: "Set dryRun to false to ask Bazarr to download the exact movie subtitle."
    };
  }
  const result = await bazarrApi("movies/subtitles", { method: "PATCH", query });
  return {
    dryRun: false,
    ...resolved,
    language,
    endpoint,
    result
  };
}

async function plexMetadataMaintenance(ratingKey, operation, dryRun) {
  const key = String(ratingKey || "").trim();
  if (!key) {
    throw new Error("ratingKey is required");
  }
  const endpoint = { method: "PUT", path: `/library/metadata/${key}/${operation}` };
  if (dryRun) {
    return {
      dryRun: true,
      ratingKey: key,
      endpoint,
      note: `Set dryRun to false to run Plex metadata ${operation}.`
    };
  }
  return {
    dryRun: false,
    ratingKey: key,
    endpoint,
    result: await plexApi(`library/metadata/${encodeURIComponent(key)}/${operation}`, { method: "PUT" })
  };
}

function issueMediaTitle(issue) {
  return firstString(
    issue?.mediaTitle,
    issue?.metadata?.title,
    mediaTitle(issue?.media ?? issue?.mediaInfo),
    issue?.subject
  );
}

function issueMediaType(issue) {
  return firstString(issue?.mediaType, issue?.metadata?.mediaType, mediaType(issue?.media ?? issue?.mediaInfo));
}

function issuePlexRatingKey(issue) {
  return firstPresent(
    issue?.plexRatingKey,
    issue?.ratingKey,
    issue?.metadata?.ratingKey,
    plexRatingKey(issue?.media ?? issue?.mediaInfo)
  );
}

function summarizePlexReport(report, options = {}) {
  const verbose = Boolean(options.verbose);
  const comments = Array.isArray(options.comments) ? options.comments.map(comment => summarizeIssueComment(comment, verbose)) : [];
  const sourceInfo = options.sourceInfo || parsePlexSourceUri(report.url);
  const metadata = options.metadata;
  const metadataSummary = metadata?.summary;
  const status = "open";
  const updatedAt = comments.reduce((latest, comment) => {
    const candidate = comment.updatedAt || comment.createdAt;
    return candidate && (!latest || candidate > latest) ? candidate : latest;
  }, report.date);
  return compactObject({
    source: "plex",
    id: String(report.id),
    type: "other",
    category: "other",
    status,
    subject: firstString(metadataSummary?.title, report.message, comments[0]?.message),
    message: report.message,
    reporter: summarizePlexUser(report.user, verbose),
    mediaTitle: metadataSummary?.title,
    mediaType: metadataSummary?.mediaType,
    plexRatingKey: firstPresent(sourceInfo.ratingKey, metadataSummary?.ratingKey),
    plexGuid: metadataSummary?.guid,
    sourceUri: sourceInfo.sourceUri ?? report.url,
    media: verbose ? metadataSummary : undefined,
    comments,
    commentCount: report.commentCount,
    createdAt: report.date,
    updatedAt,
    rawStatus: verbose ? status : undefined,
    raw: verbose ? compactObject({ report, comments: options.comments, sourceInfo, metadata: metadata?.body }) : undefined,
    warnings: metadata?.error ? [`Plex metadata lookup failed: ${metadata.error}`] : undefined
  });
}

function seerrIssueMatchesMediaType(issue, desired) {
  if (!desired || desired === "all") {
    return true;
  }
  return mediaType(issue.media ?? issue.mediaInfo) === desired;
}

function normalizedIssueMatchesMediaType(issue, desired) {
  if (!desired || desired === "all") {
    return true;
  }
  return issueMediaType(issue) === desired;
}

function summarizeQueueRecord(record) {
  const title = decodedField(record.title);
  const outputPath = decodedField(record.outputPath);
  return compactObject({
    id: record.id,
    title: title.value,
    titleRaw: title.raw,
    seriesId: record.seriesId ?? record.series?.id,
    seriesTitle: record.series?.title,
    movieId: record.movieId ?? record.movie?.id,
    movieTitle: record.movie?.title,
    episodeId: record.episodeId,
    seasonNumber: record.seasonNumber,
    status: record.status,
    trackedDownloadStatus: record.trackedDownloadStatus,
    trackedDownloadState: record.trackedDownloadState,
    errorMessage: record.errorMessage,
    downloadId: record.downloadId,
    protocol: record.protocol,
    downloadClient: record.downloadClient,
    indexer: record.indexer,
    outputPath: outputPath.value,
    outputPathRaw: outputPath.raw,
    outputPathDisplay: outputPath.value,
    size: record.size,
    sizeLeft: record.sizeLeft ?? record.sizeleft,
    timeLeft: record.timeLeft ?? record.timeleft,
    estimatedCompletionTime: record.estimatedCompletionTime,
    statusMessages: Array.isArray(record.statusMessages)
      ? record.statusMessages.map(message => compactObject({
        title: decodeHtmlEntities(message.title),
        titleRaw: message.title !== decodeHtmlEntities(message.title) ? message.title : undefined,
        messages: Array.isArray(message.messages) ? message.messages.map(decodeHtmlEntities) : message.messages
      }))
      : undefined
  });
}

function summarizeQueueList(value, limit) {
  const max = Math.max(1, Math.min(Number(limit || 50), 250));
  if (Array.isArray(value)) {
    return { total: value.length, returned: Math.min(value.length, max), records: value.slice(0, max).map(summarizeQueueRecord) };
  }
  if (value && Array.isArray(value.records)) {
    return {
      ...value,
      totalRecords: value.totalRecords ?? value.records.length,
      records: value.records.slice(0, max).map(summarizeQueueRecord)
    };
  }
  return value;
}

function summarizeImportCandidate(candidate, options = {}) {
  const rejections = Array.isArray(candidate.rejections)
    ? candidate.rejections.map(rejection => compactObject({
      reason: rejection.reason,
      type: rejection.type
    }))
    : [];
  const episodeIds = Array.isArray(candidate.episodeIds)
    ? candidate.episodeIds
    : candidate.episodes?.map(episode => episode.id).filter(Boolean);
  const hasTarget = Boolean(candidate.series?.id && episodeIds?.length) || Boolean(candidate.movie?.id ?? candidate.movieId);
  const warnings = [];
  if (!candidate.path) {
    warnings.push("candidate is missing an exact file path");
  }
  if (!hasTarget) {
    warnings.push("candidate is missing an exact target media match");
  }
  for (const rejection of rejections) {
    if (rejection.reason) {
      warnings.push(rejection.reason);
    }
  }
  if (options.expectedFolder && candidate.path && !pathInside(options.expectedFolder, candidate.path)) {
    warnings.push(`candidate path is outside expected queue folder ${decodeHtmlEntities(options.expectedFolder)}`);
  }
  const pathInfo = pathDisplay(candidate.path);
  const relativePath = decodedField(candidate.relativePath);
  const folderName = decodedField(candidate.folderName);
  return compactObject({
    id: candidate.id,
    ...pathInfo,
    relativePath: relativePath.value,
    relativePathRaw: relativePath.raw,
    folderName: folderName.value,
    folderNameRaw: folderName.raw,
    name: candidate.name,
    size: candidate.size,
    seriesId: candidate.series?.id,
    seriesTitle: candidate.series?.title,
    tvdbId: candidate.series?.tvdbId,
    movieId: candidate.movie?.id ?? candidate.movieId,
    movieTitle: candidate.movie?.title,
    tmdbId: candidate.movie?.tmdbId ?? candidate.tmdbId,
    seasonNumber: candidate.seasonNumber,
    episodes: Array.isArray(candidate.episodes)
      ? candidate.episodes.map(episode => compactObject({
        id: episode.id,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        absoluteEpisodeNumber: episode.absoluteEpisodeNumber,
        title: episode.title,
        airDate: episode.airDate,
        airDateUtc: episode.airDateUtc
      }))
      : undefined,
    episodeIds,
    episodeFileId: candidate.episodeFileId,
    releaseGroup: candidate.releaseGroup,
    quality: candidate.quality,
    languages: candidate.languages,
    downloadId: candidate.downloadId,
    customFormats: candidate.customFormats,
    customFormatScore: candidate.customFormatScore,
    indexerFlags: candidate.indexerFlags,
    releaseType: candidate.releaseType,
    safeToImport: Boolean(candidate.path && hasTarget && rejections.length === 0 && (!options.expectedFolder || pathInside(options.expectedFolder, candidate.path))),
    warnings,
    rejections
  });
}

function summarizeNzbgetHistory(record) {
  return compactObject({
    id: record.ID ?? record.Id ?? record.id ?? record.NZBID,
    nzbId: record.NZBID,
    name: record.Name ?? record.NZBName ?? record.name,
    kind: record.Kind,
    status: record.Status,
    category: record.Category,
    totalSizeMb: record.FileSizeMB,
    downloadedSizeMb: record.DownloadedSizeMB,
    downloadTimeSec: record.DownloadTimeSec,
    postTotalTimeSec: record.PostTotalTimeSec
  });
}

function nzbgetRecordId(record) {
  return Number(record?.NZBID ?? record?.ID ?? record?.Id ?? record?.id);
}

function nzbgetRecordNameCandidates(record) {
  return [record?.Name, record?.NZBName, record?.NZBNicename, record?.NZBFilename]
    .filter(value => typeof value === "string" && value.trim())
    .flatMap(value => {
      const base = value.split(/[\\/]/).pop();
      const noNzb = base?.replace(/\.nzb$/i, "");
      return [value, base, noNzb].filter(Boolean);
    });
}

function nzbgetRecordParameter(record, name) {
  const wanted = name.toLowerCase();
  const arrays = [
    record?.Parameters,
    record?.PPParameters,
    record?.PostParameters,
    record?.Params
  ].filter(Array.isArray);
  for (const entries of arrays) {
    for (const entry of entries) {
      const entryName = String(entry.Name ?? entry.name ?? entry.Key ?? entry.key ?? "").toLowerCase();
      if (entryName === wanted) {
        return entry.Value ?? entry.value ?? entry.Val ?? entry.val;
      }
    }
  }
  return record?.[name] ?? record?.[name.toLowerCase()];
}

function nzbgetRecordDownloadId(record) {
  return nzbgetRecordParameter(record, "drone");
}

function nzbgetRecordDeleted(record) {
  return record?.Deleted === true || /^deleted/i.test(String(record?.DeleteStatus || record?.Status || ""));
}

function nzbgetRetryPostprocessCall(nzbId) {
  return {
    method: "editqueue",
    params: ["HistoryProcess", 0, [nzbId]],
    display: `editqueue("HistoryProcess", 0, [${nzbId}])`
  };
}

async function nzbgetHistoryRecords() {
  const records = await nzbgetRpc("history");
  return Array.isArray(records) ? records : [];
}

function matchNzbgetHistoryRecord(records, input) {
  const selectors = [
    input.nzbId !== undefined ? "nzbId" : undefined,
    input.downloadId ? "downloadId" : undefined,
    input.name ? "name" : undefined
  ].filter(Boolean);
  if (!selectors.length) {
    throw new Error("provide nzbId, downloadId, or exact name");
  }

  let matches = records;
  if (input.nzbId !== undefined) {
    matches = matches.filter(record => nzbgetRecordId(record) === input.nzbId);
  }
  if (input.downloadId) {
    matches = matches.filter(record => nzbgetRecordDownloadId(record) === input.downloadId);
  }
  if (input.name) {
    matches = matches.filter(record => nzbgetRecordNameCandidates(record).includes(input.name));
  }

  if (!matches.length) {
    throw new Error(`no NZBGet history item matched ${selectors.join(", ")}`);
  }
  if (matches.length > 1) {
    return {
      ambiguous: true,
      selectors,
      matches: matches.map(summarizeNzbgetHistory)
    };
  }
  return { record: matches[0], selectors };
}

async function findNzbgetHistoryRecord(input) {
  const matched = matchNzbgetHistoryRecord(await nzbgetHistoryRecords(), input);
  if (matched.ambiguous) {
    throw new Error(`ambiguous NZBGet history match for ${matched.selectors.join(", ")}: ${matched.matches.map(record => record.nzbId).join(", ")}`);
  }
  return matched.record;
}

async function nzbgetHistoryDetail(input) {
  const record = await findNzbgetHistoryRecord(input);
  const nzbId = nzbgetRecordId(record);
  const log = input.includeLog
    ? await nzbgetRpc("loadlog", [nzbId, 0, input.logLimit]).catch(error => ({ error: error.message }))
    : undefined;
  const sanitizedRecord = redactSensitiveObject(record);
  return compactObject({
    record: log ? { ...sanitizedRecord, Log: log } : sanitizedRecord,
    log
  });
}

function summarizeNzbgetFile(record) {
  const filename = decodedField(record.Filename ?? record.Name ?? record.NZBName);
  const destDir = decodedField(record.DestDir);
  return compactObject({
    id: record.ID ?? record.Id ?? record.id,
    nzbId: record.NZBID,
    filename: filename.value,
    filenameRaw: filename.raw,
    destDir: destDir.value,
    destDirRaw: destDir.raw,
    path: destDir.value && filename.value ? `${destDir.value.replace(/\/+$/, "")}/${filename.value}` : undefined,
    fileSizeMb: record.FileSizeMB,
    progress: record.Progress,
    paused: record.Paused,
    category: record.Category,
    activeDownloads: record.ActiveDownloads
  });
}

function archiveKind(filename) {
  const lower = String(filename || "").toLowerCase();
  if (/\.part0*1\.rar$/.test(lower) || (/\.rar$/.test(lower) && !/\.part\d+\.rar$/.test(lower)) || /\.7z(\.001)?$/.test(lower) || /\.zip$/.test(lower)) {
    return "root";
  }
  if (/\.(r\d{2,3}|7z\.\d{3}|z\d{2}|part\d+\.rar)$/.test(lower)) {
    return "part";
  }
  if (/\.(rar|r\d{2,3}|7z|7z\.\d{3}|zip|z\d{2}|001)$/.test(lower)) {
    return "archive";
  }
  return null;
}

function archiveRootKey(filename) {
  return String(filename || "")
    .replace(/\.part\d+\.rar$/i, "")
    .replace(/\.(rar|r\d{2,3}|7z|7z\.\d{3}|zip|z\d{2}|001)$/i, "");
}

function archiveSummary(files) {
  const archiveFiles = files
    .map(file => ({ ...file, archiveKind: archiveKind(file.filename), archiveRoot: archiveRootKey(file.filename) }))
    .filter(file => file.archiveKind);
  const roots = archiveFiles.filter(file => file.archiveKind === "root");
  return {
    hasArchives: archiveFiles.length > 0,
    archiveCount: archiveFiles.length,
    rootCount: roots.length,
    roots,
    files: archiveFiles
  };
}

async function pathInfo(pathValue) {
  try {
    const details = await stat(pathValue);
    return {
      path: pathValue,
      exists: true,
      directory: details.isDirectory(),
      readable: await access(pathValue, fsConstants.R_OK).then(() => true, () => false)
    };
  } catch (error) {
    return {
      path: pathValue,
      exists: false,
      directory: false,
      readable: false,
      error: error.message
    };
  }
}

async function resolveReadableDirectory(pathValue) {
  const candidates = mediaPathCandidates(pathValue);
  const checked = [];
  for (const candidate of candidates) {
    const info = await pathInfo(candidate);
    checked.push(info);
    if (info.directory && info.readable) {
      return { path: candidate, candidates, checked };
    }
  }
  return { path: null, candidates, checked };
}

async function findExecutable(names) {
  const pathDirs = String(env.PATH || "").split(":").filter(Boolean);
  for (const name of names) {
    const candidates = name.includes("/") ? [name] : pathDirs.map(dir => nodePath.join(dir, name));
    for (const candidate of candidates) {
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return null;
}

async function archiveToolAvailability() {
  const [unrar, sevenZip] = await Promise.all([
    findExecutable(["unrar"]),
    findExecutable(["7z", "7zz"])
  ]);
  return {
    unrar: { available: Boolean(unrar), path: unrar || undefined },
    sevenZip: { available: Boolean(sevenZip), path: sevenZip || undefined }
  };
}

function firstOutputLine(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
}

async function commandVersion(pathValue) {
  if (!pathValue) {
    return undefined;
  }
  const result = await runCommandResult(pathValue, [], undefined);
  return compactObject({
    command: pathValue,
    code: result.code,
    version: firstOutputLine(result),
    error: result.error
  });
}

async function writeAccessProbe(dir) {
  const probePath = nodePath.join(dir, `.codex-archive-write-test-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probePath, "ok\n", { flag: "wx" });
    await rm(probePath, { force: true });
    return { writable: true, path: probePath };
  } catch (error) {
    await rm(probePath, { force: true }).catch(() => {});
    return { writable: false, path: probePath, error: error.message };
  }
}

async function archiveEnvironmentCheck(input = {}) {
  const downloadsPath = input.downloadsPath || "/mnt/unraid/downloads";
  const [tools, pathResolution] = await Promise.all([
    archiveToolAvailability(),
    resolveReadableDirectory(downloadsPath)
  ]);
  const versions = {
    unrar: await commandVersion(tools.unrar.path),
    sevenZip: await commandVersion(tools.sevenZip.path)
  };
  const writeCheck = input.writeTest === false || !pathResolution.path
    ? { skipped: true, reason: pathResolution.path ? "writeTest is false" : "downloads path is not visible" }
    : await writeAccessProbe(pathResolution.path);
  const blockers = [];
  if (!tools.unrar.available) {
    blockers.push({ type: "missing_tool", tool: "unrar", message: "unrar is not available on PATH." });
  }
  if (!tools.sevenZip.available) {
    blockers.push({ type: "missing_tool", tool: "7z_or_7zz", message: "Neither 7z nor 7zz is available on PATH." });
  }
  if (!pathResolution.path) {
    blockers.push({ type: "path_not_visible", path: downloadsPath, candidates: pathResolution.candidates });
  } else if (writeCheck.writable === false) {
    blockers.push({ type: "path_read_only", path: pathResolution.path, message: writeCheck.error });
  }
  return {
    tools,
    versions,
    downloadsPath,
    mediaPathMaps,
    pathCandidates: pathResolution.candidates,
    visiblePath: pathResolution.path || undefined,
    checkedPaths: pathResolution.checked,
    writeCheck,
    blockers
  };
}

async function discoverFilesystemArchiveRoots(dir, depth = 0) {
  if (depth > 3) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const roots = [];
  for (const entry of entries) {
    const fullPath = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      roots.push(...await discoverFilesystemArchiveRoots(fullPath, depth + 1));
      continue;
    }
    const kind = archiveKind(entry.name);
    if (kind === "root") {
      roots.push({
        filename: entry.name,
        path: fullPath,
        archiveKind: kind,
        archiveRoot: archiveRootKey(entry.name),
        source: "filesystem"
      });
    }
  }
  return roots.sort((a, b) => a.path.localeCompare(b.path));
}

function rootArchivePathFromListfile(file, localDestDir, originalDestDir) {
  const candidates = mediaPathCandidates(file.path);
  return candidates.find(candidate => pathInside(localDestDir, candidate))
    || candidates.find(candidate => pathInside(originalDestDir, candidate));
}

function archiveExtractionStep(archivePath, cwd, tools) {
  const lower = archivePath.toLowerCase();
  const useUnrar = /\.rar$/.test(lower);
  const requiredTool = useUnrar ? "unrar" : "7z_or_7zz";
  const command = useUnrar ? tools?.unrar?.path : tools?.sevenZip?.path;
  return compactObject({
    command: command || (useUnrar ? "unrar" : "7z"),
    args: useUnrar ? ["x", "-o-", archivePath] : ["x", "-aos", archivePath],
    cwd,
    archivePath,
    requiredTool,
    missingTool: tools && !command ? requiredTool : undefined
  });
}

async function nzbgetDownloadFiles(input) {
  let record = null;
  let nzbId = input.nzbId;
  if (nzbId) {
    record = (await nzbgetHistoryRecords()).find(entry => nzbgetRecordId(entry) === nzbId) || null;
  } else {
    record = await findNzbgetHistoryRecord(input);
    nzbId = nzbgetRecordId(record);
  }
  const files = await nzbgetRpc("listfiles", [0, 0, nzbId]).catch(error => ({ error: error.message }));
  const records = Array.isArray(files) ? files.map(summarizeNzbgetFile) : [];
  return {
    record: record ? summarizeNzbgetHistory(record) : { nzbId },
    total: records.length,
    records,
    archiveSummary: archiveSummary(records),
    error: Array.isArray(files) ? undefined : files.error
  };
}

async function retryNzbgetPostprocess(input) {
  const record = await findNzbgetHistoryRecord(input);
  const nzbId = nzbgetRecordId(record);
  const apiCall = nzbgetRetryPostprocessCall(nzbId);
  if (nzbgetRecordDeleted(record) && !input.force) {
    throw new Error(`NZBGet history item ${nzbId} is deleted; pass force: true to retry post-processing anyway`);
  }
  if (input.dryRun) {
    return {
      dryRun: true,
      matchedRecord: redactSensitiveObject(record),
      apiCall
    };
  }
  const result = await nzbgetRpc("editqueue", apiCall.params);
  return {
    dryRun: false,
    matchedRecord: summarizeNzbgetHistory(record),
    apiCall,
    result
  };
}

async function downloadClientArchiveDiagnosis(input) {
  const queueRecord = await arrQueueRecord(input.service, input.queueId);
  const selectors = queueRecord.downloadId
    ? { downloadId: queueRecord.downloadId }
    : { name: decodeHtmlEntities(queueRecord.title) };
  const detail = await nzbgetHistoryDetail({ ...selectors, includeLog: true, logLimit: input.logLimit }).catch(error => ({ error: error.message }));
  const record = detail.record;
  const files = record ? await nzbgetDownloadFiles({ nzbId: nzbgetRecordId(record) }).catch(error => ({ error: error.message })) : undefined;
  const archives = files?.archiveSummary;
  const unpackStatus = record?.UnpackStatus;
  const blockers = [];
  if (!record) {
    blockers.push({ type: "no_nzbget_history_match", message: detail.error || "No NZBGet history record matched the queue item downloadId/name." });
  }
  if (archives?.hasArchives && ["NONE", "FAILURE"].includes(String(unpackStatus))) {
    blockers.push({
      type: "archives_still_present",
      message: "NZBGet reports unpack did not complete and archive files are still present; retry post-processing first, then manual/multi-set extraction may be needed if archives remain.",
      unpackStatus
    });
  }
  if (archives && !archives.hasArchives && ["NONE", "FAILURE"].includes(String(unpackStatus))) {
    blockers.push({
      type: "no_archive_files_exposed",
      message: "NZBGet did not expose archive files through listfiles; inspect the completed folder from the Arr/NZBGet container path if Sonarr/Radarr still reports archive files."
    });
  }
  return {
    service: input.service,
    queueRecord: summarizeQueueRecord(queueRecord),
    nzbget: detail,
    files,
    archiveDiagnosis: compactObject({
      hasArchives: archives?.hasArchives,
      archiveCount: archives?.archiveCount,
      rootCount: archives?.rootCount,
      unpackStatus,
      parStatus: record?.ParStatus,
      moveStatus: record?.MoveStatus,
      status: record?.Status
    }),
    blockers
  };
}

async function runCommandResult(command, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", error => {
      resolve({ code: null, stdout: redactText(stdout), stderr: redactText(stderr), error: error.message });
    });
    child.on("close", code => {
      resolve({ code, stdout: redactText(stdout), stderr: redactText(stderr) });
    });
  });
}

function mediaFileName(filename) {
  return /\.(mkv|mp4|m4v|avi|mov|ts)$/i.test(filename);
}

async function listMediaFiles(dir, depth = 0) {
  if (depth > 3) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMediaFiles(fullPath, depth + 1));
    } else if (mediaFileName(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function extractNzbgetArchives(input) {
  const fileResult = await nzbgetDownloadFiles(input);
  const record = fileResult.record;
  const detail = await findNzbgetHistoryRecord(input);
  if (nzbgetRecordDeleted(detail) && !input.force) {
    throw new Error(`NZBGet history item ${nzbgetRecordId(detail)} is deleted; pass force: true to extract anyway`);
  }
  const destDir = decodeHtmlEntities(detail.DestDir);
  if (!destDir) {
    throw new Error("matched NZBGet history item does not expose DestDir");
  }
  const listfileRoots = fileResult.archiveSummary.roots || [];
  const outside = listfileRoots.filter(file => !pathInside(destDir, file.path));
  if (outside.length) {
    return {
      dryRun: input.dryRun,
      record,
      destDir,
      extractedMediaFiles: [],
      blockers: [{
        type: "archive_outside_destdir",
        message: "Refusing extraction because one or more archive roots are outside the NZBGet DestDir.",
        archives: outside.map(file => file.path)
      }]
    };
  }

  const pathResolution = await resolveReadableDirectory(destDir);
  const localDestDir = pathResolution.path || destDir;
  let archiveSource = "nzbget_listfiles";
  let discoveredArchiveRoots = [];
  let roots = uniqueValues(listfileRoots
    .map(file => rootArchivePathFromListfile(file, localDestDir, destDir))
    .filter(Boolean));

  if (!roots.length && pathResolution.path) {
    archiveSource = "filesystem";
    discoveredArchiveRoots = await discoverFilesystemArchiveRoots(pathResolution.path);
    roots = discoveredArchiveRoots.map(file => file.path);
  }

  if (!roots.length) {
    const blockers = [];
    if (!pathResolution.path) {
      blockers.push({
        type: "path_not_visible",
        path: destDir,
        candidates: pathResolution.candidates,
        message: "NZBGet DestDir is not readable inside media-mcp, so filesystem archive discovery cannot run."
      });
    }
    blockers.push({
      type: "no_archive_roots",
      message: listfileRoots.length
        ? "NZBGet exposed archive roots, but none resolved inside DestDir after path mapping."
        : "NZBGet did not expose root archive files and filesystem discovery found none."
    });
    return {
      dryRun: input.dryRun,
      record,
      destDir,
      localDestDir,
      pathCandidates: pathResolution.candidates,
      checkedPaths: pathResolution.checked,
      archiveSource,
      discoveredArchiveRoots,
      extractedMediaFiles: [],
      blockers
    };
  }

  const tools = input.dryRun ? null : await archiveToolAvailability();
  const plan = roots.map(archivePath => archiveExtractionStep(archivePath, localDestDir, tools));

  if (input.dryRun) {
    return {
      dryRun: true,
      record,
      destDir,
      localDestDir,
      pathCandidates: pathResolution.candidates,
      checkedPaths: pathResolution.checked,
      archiveSource,
      archiveRoots: roots,
      discoveredArchiveRoots,
      plan,
      note: "Set dryRun to false to extract archive roots inside the matched history item's DestDir."
    };
  }

  const blockers = [];
  if (!pathResolution.path) {
    blockers.push({
      type: "path_not_visible",
      path: destDir,
      candidates: pathResolution.candidates,
      message: "NZBGet DestDir is not readable inside media-mcp."
    });
  }
  for (const step of plan) {
    if (step.missingTool) {
      blockers.push({
        type: "missing_tool",
        tool: step.missingTool,
        archivePath: step.archivePath,
        message: `${step.missingTool} is required for this archive root and is not available on PATH.`
      });
    }
  }
  for (const archivePath of roots) {
    try {
      await access(archivePath, fsConstants.R_OK);
    } catch (error) {
      blockers.push({
        type: "archive_not_readable",
        archivePath,
        message: error.message
      });
    }
  }
  const writeCheck = pathResolution.path ? await writeAccessProbe(localDestDir) : { skipped: true, reason: "path is not visible" };
  if (writeCheck.writable === false) {
    blockers.push({
      type: "path_read_only",
      path: localDestDir,
      message: writeCheck.error
    });
  }
  if (blockers.length) {
    return {
      dryRun: false,
      record,
      destDir,
      localDestDir,
      pathCandidates: pathResolution.candidates,
      checkedPaths: pathResolution.checked,
      archiveSource,
      archiveRoots: roots,
      discoveredArchiveRoots,
      tools,
      writeCheck,
      plan,
      extractedMediaFiles: [],
      blockers
    };
  }

  const results = [];
  for (const step of plan) {
    const result = await runCommandResult(step.command, step.args, step.cwd);
    results.push({ ...step, ...result });
    if (result.code !== 0) {
      blockers.push({
        type: "extraction_failed",
        archivePath: step.archivePath,
        command: step.command,
        code: result.code,
        message: result.stderr || result.stdout || result.error || "archive extraction failed"
      });
    }
  }

  if (blockers.length) {
    return {
      dryRun: false,
      record,
      destDir,
      localDestDir,
      pathCandidates: pathResolution.candidates,
      checkedPaths: pathResolution.checked,
      archiveSource,
      archiveRoots: roots,
      discoveredArchiveRoots,
      tools,
      writeCheck,
      results,
      extractedMediaFiles: [],
      blockers
    };
  }

  const extractedMediaFiles = await listMediaFiles(localDestDir);
  let scanCommand;
  if (input.triggerScanService) {
    const commandName = input.triggerScanService === "sonarr" ? "DownloadedEpisodesScan" : "DownloadedMoviesScan";
    const queued = await queueArrCommand(input.triggerScanService, arrCommand(commandName, {
      path: destDir,
      downloadClientId: nzbgetRecordDownloadId(detail),
      importMode: input.importMode
    }));
    scanCommand = { commandId: queued?.id, command: queued };
  }
  return {
    dryRun: false,
    record,
    destDir,
    localDestDir,
    pathCandidates: pathResolution.candidates,
    checkedPaths: pathResolution.checked,
    archiveSource,
    archiveRoots: roots,
    discoveredArchiveRoots,
    tools,
    writeCheck,
    results,
    extractedMediaFiles,
    scanCommand
  };
}

async function arrQueueDetails(serviceName) {
  const records = await arrApi(serviceName, "v3", "queue/details");
  return Array.isArray(records) ? records : [];
}

async function arrQueueRecord(serviceName, queueId) {
  const records = await arrQueueDetails(serviceName);
  const queueRecord = records.find(record => record.id === queueId);
  if (!queueRecord) {
    throw new Error(`${serviceName} queue item ${queueId} was not found`);
  }
  return queueRecord;
}

function recordsById(records, ids) {
  const wanted = new Set(ids);
  return records.filter(record => wanted.has(record.id));
}

async function removeArrQueueItems(serviceName, ids, options) {
  const uniqueIds = uniquePositiveIds(ids);
  const beforeRecords = await arrQueueDetails(serviceName);
  const matchedBefore = recordsById(beforeRecords, uniqueIds);
  const missingBefore = uniqueIds.filter(id => !matchedBefore.some(record => record.id === id));
  const query = {
    removeFromClient: options.removeFromClient,
    blocklist: options.blocklist
  };

  if (options.dryRun) {
    return {
      dryRun: true,
      service: serviceName,
      requestedIds: uniqueIds,
      removeFromClient: options.removeFromClient,
      blocklist: options.blocklist,
      matchedBefore: matchedBefore.map(summarizeQueueRecord),
      missingBefore
    };
  }

  const deleteResults = [];
  for (const id of uniqueIds) {
    try {
      await arrApi(serviceName, "v3", `queue/${id}`, { method: "DELETE", query });
      deleteResults.push({ id, ok: true });
    } catch (error) {
      deleteResults.push({ id, ok: false, error: error.message });
    }
  }

  const afterRecords = await arrQueueDetails(serviceName);
  const remainingAfter = recordsById(afterRecords, uniqueIds);
  return {
    dryRun: false,
    service: serviceName,
    requestedIds: uniqueIds,
    removeFromClient: options.removeFromClient,
    blocklist: options.blocklist,
    matchedBefore: matchedBefore.map(summarizeQueueRecord),
    missingBefore,
    deleteResults,
    remainingAfter: remainingAfter.map(summarizeQueueRecord)
  };
}

function manualImportTargetFields(serviceName, queueRecord, input) {
  return compactObject({
    seriesId: serviceName === "sonarr" ? input.seriesId || queueRecord?.seriesId || queueRecord?.series?.id : undefined,
    movieId: serviceName === "radarr" ? input.movieId || queueRecord?.movieId || queueRecord?.movie?.id : undefined
  });
}

function rejectedManualImportCandidate(serviceName, candidate, expectedFolder) {
  const summary = summarizeImportCandidate(candidate, { expectedFolder });
  return compactObject({
    type: "candidate_outside_queue_path",
    message: `Manual import API returned a candidate outside the expected queue folder ${decodeHtmlEntities(expectedFolder)}`,
    likelyLibraryPath: likelyLibraryPath(serviceName, candidate.path),
    expectedFolder: decodeHtmlEntities(expectedFolder),
    candidate: {
      id: summary.id,
      path: summary.path,
      pathRaw: summary.pathRaw,
      seriesId: summary.seriesId,
      episodeIds: summary.episodeIds,
      movieId: summary.movieId,
      quality: summary.quality,
      languages: summary.languages,
      releaseGroup: summary.releaseGroup,
      releaseType: summary.releaseType,
      warnings: summary.warnings,
      rejections: summary.rejections
    }
  });
}

function classifyManualImportCandidates(serviceName, records, expectedFolder) {
  if (!expectedFolder) {
    return { accepted: records, blockers: [] };
  }
  const accepted = [];
  const blockers = [];
  for (const candidate of records) {
    if (candidate.path && !pathInside(expectedFolder, candidate.path)) {
      blockers.push(rejectedManualImportCandidate(serviceName, candidate, expectedFolder));
    } else {
      accepted.push(candidate);
    }
  }
  return { accepted, blockers };
}

async function arrManualImportCandidates(serviceName, input) {
  let folder = input.path;
  let downloadId = input.downloadId;
  let queueRecord = null;

  if (input.queueId) {
    queueRecord = await arrQueueRecord(serviceName, input.queueId);
    folder = folder || queueRecord.outputPath;
    downloadId = downloadId || queueRecord.downloadId;
  }

  if (!folder) {
    throw new Error("path is required when queueId does not provide an outputPath");
  }

  folder = decodeHtmlEntities(folder);
  const targetFields = manualImportTargetFields(serviceName, queueRecord, input);
  const candidates = await arrApi(serviceName, "v3", "manualimport", {
    query: {
      folder,
      downloadId,
      ...targetFields,
      filterExistingFiles: input.filterExistingFiles
    }
  });
  const records = Array.isArray(candidates) ? candidates : [];
  const classified = classifyManualImportCandidates(serviceName, records, folder);
  const limited = limitList(classified.accepted.map(candidate => summarizeImportCandidate(candidate, { expectedFolder: folder })), input.limit);
  return {
    queueRecord: queueRecord ? summarizeQueueRecord(queueRecord) : undefined,
    query: compactObject({
      folder,
      downloadId,
      ...targetFields,
      filterExistingFiles: input.filterExistingFiles
    }),
    apiBug: classified.blockers.length
      ? {
        message: "Manual import API returned one or more candidates outside the requested queue/download folder; they were excluded from valid records.",
        rejectedCount: classified.blockers.length
      }
      : undefined,
    blockers: classified.blockers.slice(0, input.limit),
    ...limited
  };
}

async function sonarrManualImportCandidates(input) {
  return arrManualImportCandidates("sonarr", input);
}

async function radarrManualImportCandidates(input) {
  return arrManualImportCandidates("radarr", input);
}

function manualImportFile(input) {
  return compactObject({
    id: input.id,
    path: input.path,
    seriesId: input.seriesId,
    movieId: input.movieId,
    seasonNumber: input.seasonNumber,
    episodeIds: input.episodeIds,
    quality: input.quality,
    languages: input.languages,
    releaseGroup: input.releaseGroup,
    downloadId: input.downloadId,
    customFormats: input.customFormats,
    customFormatScore: input.customFormatScore,
    indexerFlags: input.indexerFlags,
    releaseType: input.releaseType
  });
}

function manualImportWarnings(serviceName, files) {
  const warnings = [];
  for (const [index, file] of files.entries()) {
    const label = file.path || `file ${index + 1}`;
    if (!file.quality) {
      warnings.push(`${label}: quality was not provided; use candidate output when possible`);
    }
    if (!file.languages?.length) {
      warnings.push(`${label}: languages were not provided; use candidate output when possible`);
    }
    if (serviceName === "sonarr" && !file.episodeIds?.length) {
      warnings.push(`${label}: episodeIds are required for an exact Sonarr import target`);
    }
    if (serviceName === "radarr" && !file.movieId) {
      warnings.push(`${label}: movieId is required for an exact Radarr import target`);
    }
  }
  return warnings;
}

function manualImportCommand(files, importMode) {
  return {
    name: "ManualImport",
    importMode,
    files: files.map(manualImportFile)
  };
}

function unsafeImportCandidateBlocker(candidate) {
  return compactObject({
    type: "candidate_not_safe_to_import",
    path: candidate.path,
    pathRaw: candidate.pathRaw,
    seriesId: candidate.seriesId,
    episodeIds: candidate.episodeIds,
    movieId: candidate.movieId,
    warnings: candidate.warnings,
    rejections: candidate.rejections
  });
}

async function importArrQueueItem(serviceName, queueId, importMode, dryRun) {
  const discovery = await arrManualImportCandidates(serviceName, {
    queueId,
    filterExistingFiles: true,
    limit: 250
  });
  const records = Array.isArray(discovery.records) ? discovery.records : [];
  const safeRecords = records.filter(record => record.safeToImport);
  const blockers = [
    ...(discovery.blockers || []),
    ...records.filter(record => !record.safeToImport).map(unsafeImportCandidateBlocker)
  ];

  if (!safeRecords.length) {
    return {
      dryRun,
      service: serviceName,
      queueId,
      queueRecord: discovery.queueRecord,
      query: discovery.query,
      imported: [],
      blockers: blockers.length ? blockers : [{ type: "no_safe_candidates", message: "No safe manual import candidates were returned for this queue item." }],
      candidates: discovery
    };
  }

  const command = manualImportCommand(safeRecords, importMode);
  const warnings = manualImportWarnings(serviceName, safeRecords);
  if (dryRun) {
    return {
      dryRun: true,
      service: serviceName,
      queueId,
      queueRecord: discovery.queueRecord,
      imported: safeRecords,
      blockers,
      warnings,
      command,
      note: `Set dryRun to false to queue this ${serviceName} ManualImport command.`
    };
  }

  const queued = await queueArrCommand(serviceName, command);
  return {
    dryRun: false,
    service: serviceName,
    queueId,
    queueRecord: discovery.queueRecord,
    imported: safeRecords,
    blockers,
    warnings,
    commandId: queued?.id,
    command: queued
  };
}

function filesystemRecords(body, keys) {
  if (Array.isArray(body)) {
    return body;
  }
  for (const key of keys) {
    if (Array.isArray(body?.[key])) {
      return body[key];
    }
  }
  return [];
}

function summarizeFilesystemEntry(entry, fallbackType) {
  const entryPath = entry.path ?? entry.fullPath ?? entry.location;
  const name = decodedField(entry.name ?? entry.label);
  return compactObject({
    type: entry.type ?? fallbackType,
    name: name.value,
    nameRaw: name.raw,
    ...pathDisplay(entryPath),
    size: entry.size,
    lastModified: entry.lastModified ?? entry.lastWriteTimeUtc ?? entry.modified,
    exists: entry.exists
  });
}

function summarizeFilesystemListing(body, folder, limit) {
  const arrayBody = Array.isArray(body);
  const files = arrayBody ? [] : filesystemRecords(body, ["files", "Files", "fileEntries", "FileEntries"]);
  const directories = arrayBody ? [] : filesystemRecords(body, ["directories", "Directories", "folderEntries", "FolderEntries"]);
  const entries = arrayBody ? body : filesystemRecords(body, ["entries", "Entries", "children", "Children"]);
  const entryFiles = entries.filter(entry => String(entry.type || "").toLowerCase() === "file" || entry.isFile === true);
  const entryDirectories = entries.filter(entry => String(entry.type || "").toLowerCase() === "folder" || entry.isDirectory === true || entry.isFolder === true);
  const max = Math.max(1, Math.min(Number(limit || 50), 250));
  const fileRecords = [...files, ...entryFiles].slice(0, max).map(entry => summarizeFilesystemEntry(entry, "file"));
  const directoryRecords = [...directories, ...entryDirectories].slice(0, max).map(entry => summarizeFilesystemEntry(entry, "directory"));
  return {
    path: decodeHtmlEntities(body?.path ?? folder),
    pathRaw: body?.path && body.path !== decodeHtmlEntities(body.path) ? body.path : undefined,
    fileCount: fileRecords.length,
    directoryCount: directoryRecords.length,
    files: fileRecords,
    directories: directoryRecords
  };
}

async function arrQueueItemFiles(serviceName, queueId, limit) {
  const queueRecord = await arrQueueRecord(serviceName, queueId);
  const folder = decodeHtmlEntities(queueRecord.outputPath);
  if (!folder) {
    throw new Error(`${serviceName} queue item ${queueId} does not have an outputPath`);
  }

  const filesystem = await arrApi(serviceName, "v3", "filesystem", {
    query: {
      path: folder,
      includeFiles: true,
      allowFoldersWithoutTrailingSlashes: true
    }
  }).then(body => summarizeFilesystemListing(body, folder, limit)).catch(error => ({
    error: error.message,
    note: "The Arr filesystem API did not return a file listing for this path."
  }));

  const candidates = await arrManualImportCandidates(serviceName, {
    queueId,
    filterExistingFiles: true,
    limit
  }).catch(error => ({ error: error.message }));

  return {
    service: serviceName,
    queueRecord: summarizeQueueRecord(queueRecord),
    outputPath: folder,
    outputPathRaw: queueRecord.outputPath !== folder ? queueRecord.outputPath : undefined,
    filesystem,
    manualImportCandidates: candidates
  };
}

async function removeNzbgetHistory(ids, options) {
  const uniqueIds = uniquePositiveIds(ids);
  const history = await nzbgetRpc("history");
  const records = Array.isArray(history) ? history : [];
  const matchedBefore = records.filter(record => uniqueIds.includes(record.NZBID));
  const missingBefore = uniqueIds.filter(id => !matchedBefore.some(record => record.NZBID === id));
  const command = options.deleteFiles ? "HistoryFinalDelete" : "HistoryDelete";

  if (options.dryRun) {
    return {
      dryRun: true,
      clientType: "nzbget",
      command,
      requestedIds: uniqueIds,
      deleteFiles: options.deleteFiles,
      matchedBefore: matchedBefore.map(summarizeNzbgetHistory),
      missingBefore
    };
  }

  const result = await nzbgetRpc("editqueue", [command, "", uniqueIds]);
  const afterHistory = await nzbgetRpc("history");
  const afterRecords = Array.isArray(afterHistory) ? afterHistory : [];
  const remainingAfter = afterRecords.filter(record => uniqueIds.includes(record.NZBID));
  return {
    dryRun: false,
    clientType: "nzbget",
    command,
    requestedIds: uniqueIds,
    deleteFiles: options.deleteFiles,
    result,
    matchedBefore: matchedBefore.map(summarizeNzbgetHistory),
    missingBefore,
    remainingAfter: remainingAfter.map(summarizeNzbgetHistory)
  };
}

function seerrIssueRecords(body) {
  return Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : [];
}

const plexReportsQuery = `
  query getReportedIssues($first: PaginationInt!, $after: String) {
    reports(after: $after, first: $first) {
      nodes {
        __typename
        id
        message
        user {
          id
          avatar
          username
          displayName
          isMuted
          isBlocked
        }
        url
        date
        commentCount
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const plexReportByIdQuery = `
  query reportById($id: ID!) {
    reportByID(id: $id) {
      __typename
      commentCount
      date
      id
      user {
        id
        avatar
        username
        displayName
        isMuted
        isBlocked
      }
      message
      url
    }
  }
`;

const plexReportCommentsQuery = `
  query reportComments($id: ID!, $first: PaginationInt, $after: String, $last: PaginationInt, $before: String) {
    reportComments(first: $first, after: $after, id: $id, last: $last, before: $before) {
      nodes {
        __typename
        date
        id
        message
        status
        user {
          id
          avatar
          username
          displayName
          isBlocked
          isMuted
          isHidden
        }
      }
      pageInfo {
        endCursor
        hasNextPage
        hasPreviousPage
        startCursor
      }
    }
  }
`;

const plexCreateReportCommentMutation = `
  mutation createReportComment($input: CreateReportCommentInput!) {
    createReportComment(input: $input) {
      __typename
      date
      id
      message
      status
      user {
        id
        avatar
        username
        displayName
        isHidden
        isMuted
        isBlocked
      }
    }
  }
`;

async function listSeerrIssues(input) {
  const status = input.status || "open";
  const body = await seerrApi("issue", {
    query: {
      take: input.take,
      skip: input.skip,
      sort: input.sort || "added",
      filter: status === "all" ? "all" : status
    }
  });
  const records = seerrIssueRecords(body)
    .filter(issue => seerrIssueMatchesMediaType(issue, input.mediaType))
    .map(issue => summarizeSeerrIssue(issue, input.verbose));
  return compactObject({
    source: "seerr",
    status,
    mediaType: input.mediaType || "all",
    pageInfo: body?.pageInfo,
    total: body?.pageInfo?.results ?? records.length,
    returned: records.length,
    records
  });
}

async function getSeerrIssue(issueId, verbose = false) {
  return summarizeSeerrIssue(await seerrApi(`issue/${issueId}`), verbose);
}

const seerrIssueMessageFields = new Set(["message", "body", "description"]);

// Overseerr/Jellyseerr edit issue descriptions by updating the initial issue comment.
const seerrIssueUnsupportedFieldReasons = {
  subject: "Seerr-family issue records do not expose a separate subject/title update field.",
  issueType: "Issue type/category is only accepted on create; Overseerr/Jellyseerr do not expose an issue metadata update route.",
  type: "Issue type/category is only accepted on create; Overseerr/Jellyseerr do not expose an issue metadata update route.",
  category: "Issue type/category is only accepted on create; Overseerr/Jellyseerr do not expose an issue metadata update route.",
  status: "Use seerr_resolve_issue or seerr_reopen_issue; Seerr exposes status transitions as dedicated routes.",
  mediaId: "Associated media is only accepted on create; Seerr does not expose a safe issue media update route.",
  media: "Associated media is only accepted on create; Seerr does not expose a safe issue media update route.",
  mediaInfo: "Associated media is only accepted on create; Seerr does not expose a safe issue media update route.",
  tmdbId: "Associated media identifiers belong to the media record and are not issue-editable through the Seerr issue API.",
  tvdbId: "Associated media identifiers belong to the media record and are not issue-editable through the Seerr issue API.",
  plexRatingKey: "Plex identifiers belong to the media record and are not issue-editable through the Seerr issue API.",
  ratingKey: "Plex identifiers belong to the media record and are not issue-editable through the Seerr issue API.",
  guid: "Media GUIDs belong to the media record and are not issue-editable through the Seerr issue API.",
  problemSeason: "Problem season is only accepted on create; Seerr does not expose an issue metadata update route.",
  problemEpisode: "Problem episode is only accepted on create; Seerr does not expose an issue metadata update route."
};

function normalizeSeerrIssuePatch(input) {
  const patch = { ...(input.patch || {}) };
  for (const field of seerrIssueMessageFields) {
    if (input[field] !== undefined) {
      patch[field] = input[field];
    }
  }

  const providedEntries = Object.entries(patch).filter(([, value]) => value !== undefined);
  const contentEntries = providedEntries.filter(([field]) => seerrIssueMessageFields.has(field));
  const blockers = [];
  const unsupportedFields = providedEntries
    .filter(([field]) => !seerrIssueMessageFields.has(field))
    .map(([field, value]) => ({
      field,
      proposedValue: value,
      reason: seerrIssueUnsupportedFieldReasons[field] || "Seerr-family servers do not expose this field through a safe issue update API."
    }));

  const invalidContentFields = contentEntries.filter(([, value]) => typeof value !== "string" || !value.trim());
  for (const [field] of invalidContentFields) {
    blockers.push({ field, reason: "Issue message/body/description must be a non-empty string." });
  }

  const contentValues = contentEntries
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([field, value]) => ({ field, value }));
  const distinctContentValues = new Set(contentValues.map(({ value }) => value));
  if (distinctContentValues.size > 1) {
    blockers.push({
      field: "message",
      reason: "message, body, and description are aliases for the same Seerr first-comment field; provide only one value or matching values."
    });
  }

  if (!providedEntries.length) {
    blockers.push({ field: "patch", reason: "Provide at least one issue field to update." });
  }

  const message = distinctContentValues.size === 1 ? contentValues[0]?.value : undefined;
  return { patch, message, unsupportedFields, blockers, contentFields: contentValues.map(({ field }) => field) };
}

function seerrInitialIssueComment(issue) {
  if (!Array.isArray(issue?.comments) || !issue.comments.length) {
    return undefined;
  }
  return [...issue.comments]
    .filter(comment => comment?.id !== undefined && comment?.id !== null)
    .sort((a, b) => {
      const aTime = Date.parse(a.createdAt ?? a.date ?? "") || 0;
      const bTime = Date.parse(b.createdAt ?? b.date ?? "") || 0;
      if (aTime !== bTime) {
        return aTime - bTime;
      }
      return Number(a.id) - Number(b.id);
    })[0];
}

function seerrIssueCurrentEditableFields(rawIssue, normalizedIssue, initialComment) {
  const media = rawIssue.media ?? rawIssue.mediaInfo ?? {};
  return compactObject({
    message: initialComment?.message ?? normalizedIssue.message,
    body: initialComment?.message ?? normalizedIssue.message,
    description: initialComment?.message ?? normalizedIssue.message,
    subject: normalizedIssue.subject,
    status: normalizedIssue.status,
    issueType: rawIssue.issueType ?? rawIssue.type,
    type: normalizedIssue.type,
    category: normalizedIssue.category,
    mediaId: media.id ?? rawIssue.mediaId,
    tmdbId: media.tmdbId,
    tvdbId: media.tvdbId,
    plexRatingKey: plexRatingKey(media),
    problemSeason: rawIssue.problemSeason,
    problemEpisode: rawIssue.problemEpisode
  });
}

function seerrIssueProposedFields(patchInfo) {
  const proposed = {};
  if (patchInfo.message !== undefined) {
    proposed.message = patchInfo.message;
    for (const field of patchInfo.contentFields) {
      proposed[field] = patchInfo.message;
    }
  }
  for (const unsupported of patchInfo.unsupportedFields) {
    proposed[unsupported.field] = unsupported.proposedValue;
  }
  return proposed;
}

async function updateSeerrIssue(input) {
  const issueId = seerrIssueId(input.issueId);
  const rawIssue = await seerrApi(`issue/${issueId}`);
  const issue = summarizeSeerrIssue(rawIssue, input.verbose);
  const initialComment = seerrInitialIssueComment(rawIssue);
  const patchInfo = normalizeSeerrIssuePatch(input);
  const blockers = [...patchInfo.blockers];
  if (patchInfo.unsupportedFields.length) {
    blockers.push({
      field: "patch",
      reason: "Unsupported fields are present. No partial issue update will be applied."
    });
  }
  if (patchInfo.message !== undefined && !initialComment) {
    blockers.push({
      field: "message",
      reason: "The issue has no editable initial comment to represent its description."
    });
  }

  const endpoint = initialComment
    ? {
      method: "PUT",
      path: "/api/v1/issueComment/{commentId}",
      resolvedPath: `/api/v1/issueComment/${initialComment.id}`,
      action: "update first issue comment message"
    }
    : undefined;
  const base = {
    dryRun: input.dryRun !== false,
    supported: blockers.length === 0,
    applied: false,
    issueId,
    endpoint,
    current: seerrIssueCurrentEditableFields(rawIssue, issue, initialComment),
    proposed: seerrIssueProposedFields(patchInfo),
    unsupportedFields: patchInfo.unsupportedFields.length ? patchInfo.unsupportedFields : undefined,
    blockers: blockers.length ? blockers : undefined,
    issue
  };

  if (base.dryRun || blockers.length) {
    return base;
  }

  const comment = await seerrApi(`issueComment/${initialComment.id}`, {
    method: "PUT",
    body: { message: patchInfo.message }
  });
  return {
    ...base,
    dryRun: false,
    applied: true,
    updatedComment: summarizeIssueComment(comment, input.verbose),
    issue: await getSeerrIssue(issueId, input.verbose)
  };
}

async function listPlexReportNodes(input) {
  const take = Math.max(1, Math.min(Number(input.take || 50), 100));
  const skip = Math.max(0, Number(input.skip || 0));
  const needed = take + skip;
  const nodes = [];
  let after;
  let pageInfo = {};
  while (nodes.length < needed) {
    const first = Math.min(100, needed - nodes.length);
    const data = await plexCommunityGraphql(plexReportsQuery, { first, after }, "getReportedIssues");
    const reports = data?.reports;
    const pageNodes = Array.isArray(reports?.nodes) ? reports.nodes : [];
    pageInfo = reports?.pageInfo || {};
    nodes.push(...pageNodes);
    if (!pageInfo.hasNextPage || !pageInfo.endCursor || pageNodes.length === 0) {
      break;
    }
    after = pageInfo.endCursor;
  }
  return {
    nodes: nodes.slice(skip, skip + take),
    fetched: nodes.length,
    pageInfo
  };
}

async function summarizePlexReports(reports, input, commentsById = new Map()) {
  const records = await Promise.all(reports.map(async report => {
    const sourceInfo = parsePlexSourceUri(report.url);
    const metadata = await plexMetadataForRatingKey(sourceInfo.ratingKey);
    return summarizePlexReport(report, {
      verbose: input.verbose,
      comments: commentsById.get(String(report.id)) || [],
      sourceInfo,
      metadata
    });
  }));
  return records.filter(issue => normalizedIssueMatchesMediaType(issue, input.mediaType));
}

async function listPlexIssues(input) {
  const status = input.status || "open";
  if (status === "resolved") {
    return {
      source: "plex",
      status,
      mediaType: input.mediaType || "all",
      total: 0,
      returned: 0,
      records: [],
      note: "Plex native reports do not expose resolved/closed state through the discovered Plex Web community API"
    };
  }
  const page = await listPlexReportNodes(input);
  const records = await summarizePlexReports(page.nodes, input);
  return compactObject({
    source: "plex",
    status,
    mediaType: input.mediaType || "all",
    pageInfo: page.pageInfo,
    total: page.fetched,
    returned: records.length,
    records
  });
}

async function getPlexReportComments(issueId, limit = 250) {
  const comments = [];
  let after;
  let pageInfo = {};
  while (comments.length < limit) {
    const first = Math.min(100, limit - comments.length);
    const data = await plexCommunityGraphql(plexReportCommentsQuery, { id: String(issueId), first, after }, "reportComments");
    const page = data?.reportComments;
    const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
    pageInfo = page?.pageInfo || {};
    comments.push(...nodes);
    if (!pageInfo.hasNextPage || !pageInfo.endCursor || nodes.length === 0) {
      break;
    }
    after = pageInfo.endCursor;
  }
  return { comments, pageInfo };
}

async function getPlexIssue(issueId, verbose = false) {
  const data = await plexCommunityGraphql(plexReportByIdQuery, { id: String(issueId) }, "reportById");
  const report = data?.reportByID;
  if (!report) {
    throw new Error(`Plex native reported issue ${issueId} was not found`);
  }
  const { comments } = await getPlexReportComments(issueId);
  const sourceInfo = parsePlexSourceUri(report.url);
  const metadata = await plexMetadataForRatingKey(sourceInfo.ratingKey);
  return summarizePlexReport(report, { verbose, comments, sourceInfo, metadata });
}

function seerrIssueId(issueId) {
  const numberId = Number(issueId);
  if (!Number.isInteger(numberId) || numberId <= 0) {
    throw new Error(`Seerr issue ID must be a positive integer, got ${issueId}`);
  }
  return numberId;
}

function issueSortDate(issue) {
  return issue.updatedAt || issue.createdAt || "";
}

async function plexReportedIssues(input) {
  if (input.source && !["all", "seerr", "plex"].includes(input.source)) {
    throw new Error(`issue source ${input.source} is not supported`);
  }
  const requestedSource = input.source || "all";
  const selectedSources = requestedSource === "all" ? ["seerr", "plex"] : [requestedSource];
  const sources = [];
  const notes = [];
  const sourceResults = [];
  const records = [];
  const combinedInput = requestedSource === "all"
    ? { ...input, take: (input.take || 50) + (input.skip || 0), skip: 0 }
    : input;

  for (const source of selectedSources) {
    if (!configuredServices[source]) {
      notes.push(`${source} issue source is not configured`);
      continue;
    }
    const result = source === "seerr" ? await listSeerrIssues(combinedInput) : await listPlexIssues(combinedInput);
    sources.push(source);
    sourceResults.push(compactObject({
      source,
      total: result.total,
      returned: result.returned,
      note: result.note
    }));
    records.push(...(result.records || []));
    if (requestedSource !== "all") {
      return {
        sources,
        ...result,
        notes: notes.length ? notes : undefined
      };
    }
  }

  const sorted = records.sort((left, right) => issueSortDate(right).localeCompare(issueSortDate(left)));
  const skip = input.skip || 0;
  const take = input.take || 50;
  return compactObject({
    sources,
    status: input.status || "open",
    mediaType: input.mediaType || "all",
    total: sorted.length,
    returned: Math.min(take, Math.max(0, sorted.length - skip)),
    sourceResults,
    records: sorted.slice(skip, skip + take),
    notes: notes.length ? notes : undefined
  });
}

function tautulliTableRows(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data?.data)) {
    return data.data;
  }
  if (Array.isArray(data?.rows)) {
    return data.rows;
  }
  return [];
}

function summarizeTautulliActivity(data, limit = 25) {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : tautulliTableRows(data);
  const records = sessions.slice(0, limit).map(session => compactObject({
    sessionKey: session.session_key ?? session.sessionKey,
    sessionId: session.session_id ?? session.sessionId,
    user: firstString(session.friendly_name, session.username, session.user),
    title: firstString(session.full_title, session.title, session.grandparent_title),
    mediaType: session.media_type,
    state: session.state,
    player: session.player,
    product: session.product,
    streamType: session.stream_type,
    transcodeDecision: session.transcode_decision,
    videoDecision: session.video_decision,
    audioDecision: session.audio_decision,
    progressPercent: session.progress_percent,
    bandwidth: session.bandwidth,
    location: session.location
  }));
  return {
    streamCount: Number(data?.stream_count ?? data?.streamCount ?? records.length),
    transcodeCount: Number(data?.transcode_stream_count ?? data?.transcodeCount ?? records.filter(record => record.transcodeDecision && record.transcodeDecision !== "direct play").length),
    returned: records.length,
    records
  };
}

function summarizeTautulliHistory(data, limit = 25) {
  const rows = tautulliTableRows(data);
  const records = rows.slice(0, limit).map(row => compactObject({
    rowId: row.id ?? row.row_id,
    user: firstString(row.friendly_name, row.username, row.user),
    title: firstString(row.full_title, row.title, row.grandparent_title),
    mediaType: row.media_type,
    watchedAt: row.date,
    started: row.started,
    stopped: row.stopped,
    duration: row.duration,
    pausedCounter: row.paused_counter,
    platform: row.platform,
    player: row.player,
    transcodeDecision: row.transcode_decision,
    location: row.location
  }));
  return {
    total: data?.recordsTotal ?? data?.total ?? rows.length,
    returned: records.length,
    records
  };
}

function tracearrRecords(body) {
  return Array.isArray(body?.data) ? body.data : [];
}

function tracearrPage(body, mapper, limit = 25, predicate = () => true) {
  const records = tracearrRecords(body)
    .filter(predicate)
    .slice(0, limit)
    .map(mapper);
  return {
    meta: body?.meta,
    total: body?.meta?.total ?? tracearrRecords(body).length,
    returned: records.length,
    records
  };
}

function tracearrTitleMatches(title) {
  const lowered = title?.toLowerCase();
  if (!lowered) {
    return () => true;
  }
  return record => [record.mediaTitle, record.showTitle, record.grandparentTitle, record.title]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(lowered));
}

function summarizeTracearrStream(record) {
  return compactObject({
    id: record.id,
    serverId: record.serverId,
    serverName: record.serverName,
    username: record.username,
    mediaTitle: record.mediaTitle,
    showTitle: record.showTitle,
    mediaType: record.mediaType,
    state: record.state,
    progressMs: record.progressMs,
    durationMs: record.durationMs,
    startedAt: record.startedAt,
    watched: record.watched,
    isTranscode: record.isTranscode,
    videoDecision: record.videoDecision,
    audioDecision: record.audioDecision,
    resolution: record.resolution,
    sourceVideoCodecDisplay: record.sourceVideoCodecDisplay,
    sourceAudioCodecDisplay: record.sourceAudioCodecDisplay,
    streamVideoCodecDisplay: record.streamVideoCodecDisplay,
    streamAudioCodecDisplay: record.streamAudioCodecDisplay,
    platform: record.platform,
    product: record.product,
    player: record.player,
    device: record.device,
    transcodeInfo: record.transcodeInfo,
    subtitleInfo: record.subtitleInfo
  });
}

function summarizeTracearrStreams(body, limit = 25, title) {
  return compactObject({
    summary: body?.summary,
    ...tracearrPage(body, summarizeTracearrStream, limit, tracearrTitleMatches(title))
  });
}

function summarizeTracearrHistoryRecord(record) {
  return compactObject({
    id: record.id,
    serverId: record.serverId,
    serverName: record.serverName,
    state: record.state,
    mediaTitle: record.mediaTitle,
    showTitle: record.showTitle,
    mediaType: record.mediaType,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    watched: record.watched,
    durationMs: record.durationMs,
    progressMs: record.progressMs,
    totalDurationMs: record.totalDurationMs,
    segmentCount: record.segmentCount,
    user: summarizeUser(record.user, false),
    platform: record.platform,
    product: record.product,
    player: record.player,
    device: record.device,
    isTranscode: record.isTranscode,
    videoDecision: record.videoDecision,
    audioDecision: record.audioDecision,
    resolution: record.resolution,
    sourceVideoCodecDisplay: record.sourceVideoCodecDisplay,
    sourceAudioCodecDisplay: record.sourceAudioCodecDisplay,
    streamVideoCodecDisplay: record.streamVideoCodecDisplay,
    streamAudioCodecDisplay: record.streamAudioCodecDisplay,
    transcodeInfo: record.transcodeInfo,
    subtitleInfo: record.subtitleInfo
  });
}

function summarizeTracearrHistory(body, limit = 25, title) {
  return tracearrPage(body, summarizeTracearrHistoryRecord, limit, tracearrTitleMatches(title));
}

function summarizeTracearrUser(record) {
  return compactObject({
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    role: record.role,
    trustScore: record.trustScore,
    totalViolations: record.totalViolations,
    serverId: record.serverId,
    serverName: record.serverName,
    lastActivityAt: record.lastActivityAt,
    sessionCount: record.sessionCount,
    createdAt: record.createdAt
  });
}

function summarizeTracearrUsers(body, limit = 25) {
  return tracearrPage(body, summarizeTracearrUser, limit);
}

function summarizeTracearrViolation(record) {
  return compactObject({
    id: record.id,
    serverId: record.serverId,
    serverName: record.serverName,
    severity: record.severity,
    acknowledged: record.acknowledged,
    createdAt: record.createdAt,
    rule: record.rule,
    user: summarizeUser(record.user, false),
    data: record.data
  });
}

function summarizeTracearrViolations(body, limit = 25) {
  return tracearrPage(body, summarizeTracearrViolation, limit);
}

async function tracearrOverview() {
  const [health, stats, today, streams] = await Promise.all([
    tracearrApi("health"),
    tracearrApi("stats"),
    tracearrApi("stats/today", { query: { timezone: "UTC" } }),
    tracearrApi("streams", { query: { summary: true } })
  ]);
  return {
    health,
    stats,
    today,
    activeStreams: streams?.summary ?? streams,
    recentViolationCount: stats?.recentViolations
  };
}

async function tracearrDiagnostics(limit = 25) {
  const [health, stats, today, activity, streams, users, violations, history] = await Promise.all([
    tracearrApi("health"),
    tracearrApi("stats"),
    tracearrApi("stats/today", { query: { timezone: "UTC" } }),
    tracearrApi("activity", { query: { period: "month", timezone: "UTC" } }),
    tracearrApi("streams", { query: { summary: false } }),
    tracearrApi("users", { query: { page: 1, pageSize: limit } }),
    tracearrApi("violations", { query: { page: 1, pageSize: limit } }),
    tracearrApi("history", { query: { page: 1, pageSize: limit, timezone: "UTC" } })
  ]);
  return {
    health,
    stats,
    today,
    activity,
    streams: summarizeTracearrStreams(streams, limit),
    users: summarizeTracearrUsers(users, limit),
    violations: summarizeTracearrViolations(violations, limit),
    history: summarizeTracearrHistory(history, limit)
  };
}

async function tracearrIssueContext(issue) {
  if (!configuredServices.tracearr) {
    return { configured: false };
  }
  const title = issueMediaTitle(issue);
  try {
    const [streams, violations, history] = await Promise.all([
      tracearrApi("streams", { query: { summary: false } }),
      tracearrApi("violations", { query: { page: 1, pageSize: 10 } }),
      tracearrApi("history", { query: { page: 1, pageSize: 25, timezone: "UTC" } })
    ]);
    return {
      configured: true,
      title,
      activeStreams: summarizeTracearrStreams(streams, 10, title),
      recentViolations: summarizeTracearrViolations(violations, 10),
      recentHistory: summarizeTracearrHistory(history, 10, title)
    };
  } catch (error) {
    const authFailure = /401|403|unauthorized|forbidden/i.test(error.message);
    return {
      configured: true,
      error: error.message,
      warning: authFailure
        ? "Tracearr authentication failed; continuing without Tracearr diagnostics"
        : "Tracearr context unavailable; continuing without Tracearr diagnostics"
    };
  }
}

async function tautulliIssueContext(issue) {
  if (!configuredServices.tautulli) {
    return { configured: false };
  }
  const title = issueMediaTitle(issue);
  try {
    const [activity, history] = await Promise.all([
      tautulliApi("get_activity"),
      tautulliApi("get_history", { query: compactObject({ length: 10, search: title }) })
    ]);
    return {
      configured: true,
      activity: summarizeTautulliActivity(activity, 10),
      history: summarizeTautulliHistory(history, 10)
    };
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

function summarizePlexSession(record) {
  return compactObject({
    sessionKey: record.sessionKey,
    ratingKey: record.ratingKey,
    parentRatingKey: record.parentRatingKey,
    grandparentRatingKey: record.grandparentRatingKey,
    title: firstString(record.grandparentTitle, record.title),
    itemTitle: record.title,
    type: record.type,
    user: summarizeUser(record.User),
    player: record.Player ? compactObject({
      title: record.Player.title,
      product: record.Player.product,
      platform: record.Player.platform,
      state: record.Player.state,
      local: record.Player.local
    }) : undefined,
    transcode: record.TranscodeSession ? compactObject({
      key: record.TranscodeSession.key,
      throttled: record.TranscodeSession.throttled,
      complete: record.TranscodeSession.complete,
      videoDecision: record.TranscodeSession.videoDecision,
      audioDecision: record.TranscodeSession.audioDecision,
      subtitleDecision: record.TranscodeSession.subtitleDecision,
      error: record.TranscodeSession.error
    }) : undefined
  });
}

function plexSessionMatchesIssue(record, issue) {
  const ratingKey = String(issuePlexRatingKey(issue) || "");
  if (ratingKey && [record.ratingKey, record.parentRatingKey, record.grandparentRatingKey].map(String).includes(ratingKey)) {
    return true;
  }
  const title = issueMediaTitle(issue);
  if (!title) {
    return false;
  }
  const sessionTitle = [record.title, record.grandparentTitle, record.parentTitle].filter(Boolean).join(" ").toLowerCase();
  if (!sessionTitle) {
    return false;
  }
  return sessionTitle.includes(title.toLowerCase()) || title.toLowerCase().includes(sessionTitle);
}

async function plexIssueContext(issue) {
  if (!configuredServices.plex) {
    return { configured: false };
  }
  const ratingKey = issuePlexRatingKey(issue);
  try {
    const [metadata, sessions] = await Promise.all([
      plexMetadataForRatingKey(ratingKey),
      plexApi("status/sessions")
    ]);
    const sessionRecords = plexSessionRecords(sessions);
    return compactObject({
      configured: true,
      ratingKey,
      metadata: metadata.summary,
      metadataError: metadata.error,
      activeSessions: sessionRecords.filter(record => plexSessionMatchesIssue(record, issue)).map(summarizePlexSession),
      activeSessionCount: sessionRecords.length
    });
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

async function plexIssueDetails(input) {
  if (input.source === "seerr") {
    const rawIssue = await seerrApi(`issue/${seerrIssueId(input.issueId)}`);
    const issue = summarizeSeerrIssue(rawIssue, input.verbose);
    return {
      issue,
      plex: await plexIssueContext(issue),
      tautulli: await tautulliIssueContext(issue),
      tracearr: await tracearrIssueContext(issue)
    };
  }
  if (input.source === "plex") {
    const issue = await getPlexIssue(input.issueId, input.verbose);
    return {
      issue,
      plex: await plexIssueContext(issue),
      tautulli: await tautulliIssueContext(issue),
      tracearr: await tracearrIssueContext(issue)
    };
  }
  throw new Error(`issue source ${input.source} is not supported`);
}

function arrQueueProblem(record) {
  const statusMessages = Array.isArray(record.statusMessages)
    ? record.statusMessages.flatMap(message => [message.title, ...(message.messages || [])]).join(" ")
    : "";
  const text = [
    record.status,
    record.trackedDownloadStatus,
    record.trackedDownloadState,
    record.errorMessage,
    statusMessages
  ].filter(Boolean).join(" ").toLowerCase();
  return /warning|error|fail|blocked|import|stalled|unavailable/.test(text);
}

async function arrQueueOverview(serviceName) {
  const records = await arrQueueDetails(serviceName);
  const problemRecords = records.filter(arrQueueProblem);
  return {
    queueCount: records.length,
    blockedOrImportFailedCount: problemRecords.length,
    records: problemRecords.slice(0, 10).map(summarizeQueueRecord)
  };
}

function nzbgetHistoryProblem(record) {
  const status = String(record.Status || record.status || "").toLowerCase();
  return status && !/success|completed/.test(status);
}

async function nzbgetOverview() {
  const [groups, history] = await Promise.all([
    nzbgetRpc("listgroups"),
    nzbgetRpc("history")
  ]);
  const queue = Array.isArray(groups) ? groups : [];
  const records = Array.isArray(history) ? history : [];
  const failed = records.filter(nzbgetHistoryProblem);
  return {
    activeQueueCount: queue.length,
    failedHistoryCount: failed.length,
    failedHistory: failed.slice(0, 10).map(summarizeNzbgetHistory)
  };
}

async function qbittorrentOverview() {
  const torrents = await qbitRequest("torrents/info");
  const records = Array.isArray(torrents) ? torrents : [];
  const problemRecords = records.filter(torrent => /error|missing|stalled/.test(String(torrent.state || "").toLowerCase()));
  return {
    torrentCount: records.length,
    erroredOrStalledCount: problemRecords.length,
    records: problemRecords.slice(0, 10).map(torrent => compactObject({
      hash: torrent.hash,
      name: torrent.name,
      state: torrent.state,
      progress: torrent.progress,
      category: torrent.category
    }))
  };
}

function plexSessionRecords(body) {
  const metadata = body?.MediaContainer?.Metadata;
  return Array.isArray(metadata) ? metadata : [];
}

function plexTranscodeErrorSummary(records) {
  const transcodeSessions = records.map(record => record.TranscodeSession).filter(Boolean);
  const errorRecords = transcodeSessions.filter(session => Object.entries(session)
    .some(([key, value]) => key.toLowerCase().includes("error") && value));
  if (!errorRecords.length) {
    return {
      status: "unavailable",
      note: "Plex session metadata did not expose active transcode error fields"
    };
  }
  return { count: errorRecords.length };
}

async function plexOverview() {
  const sessions = await plexApi("status/sessions");
  const records = plexSessionRecords(sessions);
  return {
    activeStreamCount: records.length,
    activeTranscodeCount: records.filter(record => record.TranscodeSession).length,
    transcodeErrors: plexTranscodeErrorSummary(records)
  };
}

async function seerrOverview() {
  const [issueCounts, pendingRequests] = await Promise.all([
    seerrApi("issue/count"),
    seerrApi("request", { query: { take: 1, skip: 0, filter: "pending" } })
  ]);
  return {
    openIssueCount: issueCounts.open ?? issueCounts.openIssues ?? 0,
    resolvedIssueCount: issueCounts.closed ?? issueCounts.resolved ?? 0,
    pendingRequestCount: pendingRequests?.pageInfo?.results ?? pendingRequests?.results?.length ?? 0
  };
}

async function tautulliOverview() {
  const [activity, history] = await Promise.all([
    tautulliApi("get_activity"),
    tautulliApi("get_history", { query: { length: 10 } })
  ]);
  return {
    activity: summarizeTautulliActivity(activity, 10),
    history: summarizeTautulliHistory(history, 10)
  };
}

async function mediaAdminOverview() {
  const [
    sonarr,
    radarr,
    nzbget,
    qbittorrent,
    plex,
    seerr,
    tautulli,
    tracearr,
    threadfin
  ] = await Promise.all([
    serviceResult("sonarr", () => arrQueueOverview("sonarr")),
    serviceResult("radarr", () => arrQueueOverview("radarr")),
    serviceResult("nzbget", nzbgetOverview),
    serviceResult("qbittorrent", qbittorrentOverview),
    serviceResult("plex", plexOverview),
    serviceResult("seerr", seerrOverview),
    serviceResult("tautulli", tautulliOverview),
    serviceResult("tracearr", tracearrOverview),
    serviceResult("threadfin", threadfinOverview)
  ]);
  return {
    generatedAt: new Date().toISOString(),
    sonarr,
    radarr,
    nzbget,
    qbittorrent,
    plex,
    seerr,
    tautulli,
    tracearr,
    threadfin
  };
}

function redactText(value) {
  if (typeof value !== "string") {
    return value;
  }
  return value
    .replace(/([?&](?:api[_-]?key|apikey|token|password|passkey)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(api[_-]?key|apikey|token|password|passkey)=\S+/gi, "$1=[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(X-Api-Key|X-Plex-Token):\s*\S+/gi, "$1: [redacted]");
}

function redactSensitiveObject(value) {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveObject);
  }
  if (!value || typeof value !== "object") {
    return redactText(value);
  }
  const sensitiveField = [value.name, value.label, value.type]
    .filter(entry => typeof entry === "string")
    .some(entry => /api|token|password|passkey|cookie|authorization/i.test(entry));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (sensitiveField && /^value$/i.test(key)) {
      return [key, "[redacted]"];
    }
    if (/api|token|password|passkey|cookie|authorization|downloadurl|magneturl|file\.source|m3u-url|xepg-url|^url$/i.test(key)) {
      return [key, "[redacted]"];
    }
    return [key, redactSensitiveObject(entry)];
  }));
}

function threadfinOutput(value, includeSensitive = false) {
  return includeSensitive ? value : redactThreadfinObject(value);
}

function redactThreadfinObject(value) {
  if (Array.isArray(value)) {
    return value.map(redactThreadfinObject);
  }
  if (!value || typeof value !== "object") {
    return redactText(value);
  }
  const sensitiveField = [value.name, value.label, value.type]
    .filter(entry => typeof entry === "string")
    .some(entry => /token|password|passkey|cookie|authorization|secret/i.test(entry));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (sensitiveField && /^value$/i.test(key)) {
      return [key, "[redacted]"];
    }
    if (/token|password|passkey|cookie|authorization|secret|downloadurl|magneturl|filesource|file\.source|m3u-url|xepg-url|(?:url|uri)$/i.test(key) || /^(?:url|uri)(?:[._-]|$)/i.test(key)) {
      return [key, "[redacted]"];
    }
    return [key, redactThreadfinObject(entry)];
  }));
}

function threadfinFiles(settings, type) {
  return settings?.files?.[type] && typeof settings.files[type] === "object" ? settings.files[type] : {};
}

function summarizeThreadfinSource(id, type, source, includeSensitive = false) {
  return threadfinOutput(compactObject({
    id,
    type,
    name: source?.name,
    description: source?.description,
    fileSource: source?.["file.source"],
    buffer: source?.buffer,
    tuner: source?.tuner,
    providerId: source?.["id.provider"],
    httpProxyIp: source?.["http_proxy.ip"],
    httpProxyPort: source?.["http_proxy.port"],
    httpHeadersOrigin: source?.["http_headers.origin"],
    httpHeadersReferer: source?.["http_headers.referer"],
    raw: source
  }), includeSensitive);
}

function summarizeThreadfinChannel(id, channel, includeSensitive = false) {
  return threadfinOutput(compactObject({
    id,
    active: channel?.["x-active"],
    channelId: channel?.["x-channelID"],
    name: channel?.["x-name"] ?? channel?.name,
    description: channel?.["x-description"],
    groupTitle: channel?.["x-group-title"] ?? channel?.["group-title"],
    category: channel?.["x-category"],
    xmltvFile: channel?.["x-xmltv-file"],
    mapping: channel?.["x-mapping"],
    backupChannel1: channel?.["x-backup-channel-1"],
    backupChannel2: channel?.["x-backup-channel-2"],
    backupChannel3: channel?.["x-backup-channel-3"],
    hidden: channel?.["x-hide-channel"],
    tvgId: channel?.["tvg-id"],
    tvgName: channel?.["tvg-name"],
    tvgLogo: channel?.["tvg-logo"],
    url: channel?.url,
    playlistId: channel?.["_file.m3u.id"],
    playlistName: channel?.["_file.m3u.name"],
    raw: channel
  }), includeSensitive);
}

function threadfinRecordMatches(record, term) {
  if (!term) {
    return true;
  }
  return JSON.stringify(record).toLowerCase().includes(term.toLowerCase());
}

function requireThreadfinConfirm(input, action) {
  if (!input.confirm) {
    throw new Error(`confirm=true is required when dryRun=false for ${action}`);
  }
}

function summarizeThreadfinFilter(id, filter, includeSensitive = false) {
  return threadfinOutput(compactObject({
    id,
    name: filter?.name,
    description: filter?.description,
    type: filter?.type,
    filter: filter?.filter,
    include: filter?.include,
    exclude: filter?.exclude,
    startingNumber: filter?.startingNumber,
    category: filter?.["x-category"],
    active: filter?.active,
    caseSensitive: filter?.caseSensitive,
    liveEvent: filter?.liveEvent,
    raw: filter
  }), includeSensitive);
}

function threadfinMappingStats(mapping) {
  const groups = new Map();
  let active = 0;
  let hidden = 0;
  let mapped = 0;
  for (const channel of Object.values(mapping || {})) {
    if (channel?.["x-active"] === true) {
      active += 1;
    }
    if (channel?.["x-hide-channel"] === true) {
      hidden += 1;
    }
    if (channel?.["x-mapping"] && channel["x-mapping"] !== "-") {
      mapped += 1;
    }
    const group = channel?.["x-group-title"] || channel?.["group-title"] || "";
    groups.set(group, (groups.get(group) || 0) + 1);
  }
  const total = Object.keys(mapping || {}).length;
  return {
    total,
    active,
    inactive: Math.max(0, total - active),
    hidden,
    mapped,
    unmapped: Math.max(0, total - mapped),
    groups: [...groups.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([groupTitle, count]) => ({ groupTitle, count }))
  };
}

function threadfinConfigSummary(body) {
  const settings = body.settings || {};
  const m3uFiles = threadfinFiles(settings, "m3u");
  const xmltvFiles = threadfinFiles(settings, "xmltv");
  const filters = settings.filter || {};
  const mapping = body.xepg?.epgMapping || {};
  return {
    settings: compactObject({
      api: settings.api,
      authenticationWeb: settings["authentication.web"],
      authenticationApi: settings["authentication.api"],
      authenticationM3U: settings["authentication.m3u"],
      authenticationXML: settings["authentication.xml"],
      epgSource: settings.epgSource,
      tuner: settings.tuner,
      buffer: settings.buffer
    }),
    tunerCount: settings.tuner,
    playlists: Object.entries(m3uFiles).map(([id, source]) => summarizeThreadfinSource(id, "m3u", source, true)),
    xmltvFiles: Object.entries(xmltvFiles).map(([id, source]) => summarizeThreadfinSource(id, "xmltv", source, true)),
    filters: Object.entries(filters).map(([id, filter]) => summarizeThreadfinFilter(id, filter, true)),
    mappings: threadfinMappingStats(mapping)
  };
}

function threadfinConfigSource(settings, type, id) {
  const files = threadfinFiles(settings, type);
  if (id) {
    const source = files[id];
    if (!source) {
      throw new Error(`Threadfin ${type} source ${id} was not found`);
    }
    return { id, source };
  }
  const entries = Object.entries(files);
  if (entries.length !== 1) {
    throw new Error(`Threadfin ${type} source id is required when ${entries.length} ${type} sources are configured`);
  }
  const [onlyId, source] = entries[0];
  return { id: onlyId, source };
}

function firstThreadfinValue(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      const value = object?.[key];
      if (value !== undefined && value !== null && value !== "") {
        return String(value);
      }
    }
  }
  return undefined;
}

function threadfinSourceHeaders(source, settings) {
  return compactObject({
    "User-Agent": firstThreadfinValue([source, settings], [
      "http_headers.user-agent",
      "http_headers.user_agent",
      "http_headers.userAgent",
      "user-agent",
      "user_agent",
      "userAgent"
    ]),
    Origin: firstThreadfinValue([source, settings], ["http_headers.origin", "origin"]),
    Referer: firstThreadfinValue([source, settings], ["http_headers.referer", "referer", "referrer"])
  });
}

function threadfinSourceUrl(source) {
  const raw = source?.["file.source"];
  if (!raw) {
    throw new Error("Threadfin source does not have a file.source value");
  }
  try {
    return new URL(raw);
  } catch {
    throw new Error("Threadfin source file.source is not a valid URL");
  }
}

async function threadfinFetchSourceText(source, settings, type) {
  const response = await fetch(threadfinSourceUrl(source), {
    method: "GET",
    headers: threadfinSourceHeaders(source, settings),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Threadfin ${type} source fetch failed: ${response.status} ${response.statusText}: ${redactText(text).slice(0, 500)}`);
  }
  return text;
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower === "amp") return "&";
      if (lower === "lt") return "<";
      if (lower === "gt") return ">";
      if (lower === "quot") return "\"";
      if (lower === "apos") return "'";
      if (lower.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      }
      if (lower.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
      }
      return match;
    })
    .trim();
}

function splitExtinf(line) {
  const body = line.replace(/^#EXTINF:\s*/i, "");
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "\"") {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      return [body.slice(0, index), body.slice(index + 1).trim()];
    }
  }
  return [body, ""];
}

function parseM3uAttributes(value) {
  const attributes = {};
  const pattern = /([A-Za-z0-9_.:-]+)=("([^"]*)"|'([^']*)'|([^\s,]+))/g;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    attributes[match[1]] = match[3] ?? match[4] ?? match[5] ?? "";
  }
  return attributes;
}

function threadfinUrlTail(value) {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || url.hostname;
  } catch {
    const withoutQuery = String(value).split(/[?#]/)[0];
    const parts = withoutQuery.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || withoutQuery.slice(-80);
  }
}

function parseThreadfinM3u(text) {
  const records = [];
  let pending;
  for (const [index, rawLine] of String(text || "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^#EXTINF:/i.test(line)) {
      const [metadata, name] = splitExtinf(line);
      pending = {
        index: records.length,
        lineNumber: index + 1,
        attributes: parseM3uAttributes(metadata),
        name
      };
      continue;
    }
    if (pending && !line.startsWith("#")) {
      records.push({
        ...pending,
        url: line,
        urlTail: threadfinUrlTail(line)
      });
      pending = undefined;
    }
  }
  return records;
}

function sanitizeM3uRecord(record) {
  const attributes = record.attributes || {};
  return compactObject({
    index: record.index,
    name: record.name,
    groupTitle: attributes["group-title"],
    tvgId: attributes["tvg-id"],
    tvgName: attributes["tvg-name"],
    tvgChno: attributes["tvg-chno"],
    channelId: attributes["channel-id"] || attributes["channel-number"] || attributes["tvg-chno"],
    urlTail: record.urlTail
  });
}

function threadfinTerms(value) {
  if (Array.isArray(value)) {
    return value.flatMap(threadfinTerms);
  }
  if (value === undefined || value === null) {
    return [];
  }
  return String(value)
    .split(/[,\n]/)
    .map(term => term.trim())
    .filter(Boolean);
}

function threadfinM3uHaystack(record) {
  const attributes = record.attributes || {};
  return [
    record.name,
    attributes["group-title"],
    attributes["tvg-id"],
    attributes["tvg-name"],
    attributes["channel-id"],
    attributes["channel-number"],
    attributes["tvg-chno"],
    record.urlTail
  ].filter(Boolean).join(" ").toLowerCase();
}

function threadfinMappingHaystack(channel, key) {
  return [
    key,
    channel?.["x-channelID"],
    channel?.["x-name"],
    channel?.name,
    channel?.["x-group-title"],
    channel?.["group-title"],
    channel?.["x-category"],
    channel?.["x-mapping"],
    channel?.["x-xmltv-file"],
    channel?.["tvg-id"],
    channel?.["tvg-name"],
    threadfinUrlTail(channel?.url)
  ].filter(Boolean).join(" ").toLowerCase();
}

function threadfinMatchesAny(haystack, terms) {
  return terms.length === 0 || terms.some(term => haystack.includes(term.toLowerCase()));
}

function threadfinMatchesAll(haystack, terms) {
  return terms.length === 0 || terms.every(term => haystack.includes(term.toLowerCase()));
}

function summarizeThreadfinM3uGroups(records, options = {}) {
  const searchTerms = threadfinTerms(options.search);
  const groups = new Map();
  for (const record of records) {
    if (!threadfinMatchesAll(threadfinM3uHaystack(record), searchTerms)) {
      continue;
    }
    const groupTitle = record.attributes?.["group-title"] || "";
    if (!groups.has(groupTitle)) {
      groups.set(groupTitle, []);
    }
    groups.get(groupTitle).push(record);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([groupTitle, groupRecords]) => compactObject({
      groupTitle,
      count: groupRecords.length,
      channels: options.includeChannels
        ? groupRecords.slice(0, options.channelsPerGroup || 10).map(sanitizeM3uRecord)
        : undefined
    }));
}

async function threadfinReadM3uPlaylist(input = {}) {
  const body = await threadfinWs("getServerConfig");
  const settings = body.settings || {};
  const playlistId = input.playlistId || input.playlist_id;
  const { id, source } = threadfinConfigSource(settings, "m3u", playlistId);
  const text = await threadfinFetchSourceText(source, settings, "m3u");
  return {
    body,
    settings,
    id,
    source,
    records: parseThreadfinM3u(text)
  };
}

async function threadfinTryM3uGroupSummary(settings, source) {
  try {
    const text = await threadfinFetchSourceText(source, settings, "m3u");
    const records = parseThreadfinM3u(text);
    return {
      totalChannels: records.length,
      totalGroups: new Set(records.map(record => record.attributes?.["group-title"] || "")).size,
      groups: summarizeThreadfinM3uGroups(records).slice(0, 100)
    };
  } catch (error) {
    return { error: redactText(error.message) };
  }
}

async function threadfinListSourceGroups(input = {}) {
  const { id, source, records } = await threadfinReadM3uPlaylist(input);
  const groups = summarizeThreadfinM3uGroups(records, {
    includeChannels: input.includeChannels,
    channelsPerGroup: input.channelsPerGroup,
    search: input.search
  });
  return {
    playlistId: id,
    playlist: summarizeThreadfinSource(id, "m3u", source, false),
    totalChannels: records.length,
    totalGroups: groups.length,
    groups: groups.slice(0, input.limit || 100)
  };
}

async function threadfinFindSourceChannels(input = {}) {
  const { id, source, records } = await threadfinReadM3uPlaylist(input);
  const group = input.groupTitle || input.group_title || input.group;
  const includeTerms = threadfinTerms(input.includeTokens || input.include_tokens);
  const searchTerms = threadfinTerms(input.search);
  const filtered = records.filter(record => {
    const recordGroup = record.attributes?.["group-title"] || "";
    if (group && normalizedLookupName(recordGroup) !== normalizedLookupName(group)) {
      return false;
    }
    const haystack = threadfinM3uHaystack(record);
    return threadfinMatchesAny(haystack, includeTerms) && threadfinMatchesAll(haystack, searchTerms);
  });
  const limit = input.limit || 100;
  return {
    playlistId: id,
    playlist: summarizeThreadfinSource(id, "m3u", source, false),
    total: filtered.length,
    returned: Math.min(filtered.length, limit),
    records: filtered.slice(0, limit).map(record => compactObject({
      ...sanitizeM3uRecord(record),
      matchedTerms: [...includeTerms, ...searchTerms].filter(term => threadfinM3uHaystack(record).includes(term.toLowerCase()))
    }))
  };
}

async function threadfinSaveGroupFilter(input) {
  const id = String(input.id ?? input.filterId ?? input.filter_id ?? -1);
  const currentConfig = await threadfinWs("getServerConfig");
  const current = currentConfig.settings?.filter?.[id];
  const data = compactObject({
    ...(input.patch || {}),
    name: input.name,
    description: input.description,
    type: "group-title",
    filter: input.groupTitle || input.group_title || input.filter,
    include: input.include,
    exclude: input.exclude,
    startingNumber: input.startingNumber === undefined ? undefined : String(input.startingNumber),
    "x-category": input["x-category"] || input.xCategory || input.x_category,
    liveEvent: input.liveEvent,
    caseSensitive: input.caseSensitive,
    active: input.active
  });
  const proposed = mergeObjectPatch(current || {}, data);
  const payload = { filter: { [id]: data } };
  if (input.dryRun) {
    return threadfinOutput({
      dryRun: true,
      command: "saveFilter",
      payload,
      before: current ? summarizeThreadfinFilter(id, current, true) : undefined,
      after: summarizeThreadfinFilter(id, proposed, true),
      diff: compactDiff(current || {}, proposed),
      note: "Set dryRun=false and confirm=true to save this Threadfin group-title filter."
    }, input.includeSensitive);
  }
  requireThreadfinConfirm(input, "Threadfin group filter changes");
  const response = await threadfinWs("saveFilter", payload);
  const saved = response.settings?.filter?.[id] || proposed;
  return threadfinOutput({
    dryRun: false,
    command: "saveFilter",
    before: current ? summarizeThreadfinFilter(id, current, true) : undefined,
    after: summarizeThreadfinFilter(id, saved, true),
    diff: compactDiff(current || {}, saved),
    response
  }, input.includeSensitive);
}

function threadfinM3uUpdatePayload(id, source) {
  const update = {};
  for (const key of [
    "name",
    "description",
    "file.source",
    "buffer",
    "tuner",
    "http_proxy.ip",
    "http_proxy.port",
    "http_headers.origin",
    "http_headers.referer"
  ]) {
    if (source?.[key] !== undefined) {
      update[key] = source[key];
    }
  }
  return { files: { m3u: { [id]: update } } };
}

async function threadfinUpdateM3u(input = {}) {
  const body = await threadfinWs("getServerConfig");
  const settings = body.settings || {};
  const playlistId = input.playlistId || input.playlist_id;
  const { id, source } = threadfinConfigSource(settings, "m3u", playlistId);
  const payload = threadfinM3uUpdatePayload(id, source);
  const sourceGroups = await threadfinTryM3uGroupSummary(settings, source);
  const mappingCountBefore = Object.keys(body.xepg?.epgMapping || {}).length;
  if (input.dryRun) {
    return threadfinOutput({
      dryRun: true,
      command: "updateFileM3U",
      playlistId: id,
      playlist: summarizeThreadfinSource(id, "m3u", source, true),
      payload,
      mappingCountBefore,
      sourceGroups,
      note: "Set dryRun=false and confirm=true to run this Threadfin M3U update."
    }, input.includeSensitive);
  }
  requireThreadfinConfirm(input, "Threadfin M3U updates");
  const response = await threadfinWs("updateFileM3U", payload);
  const afterConfig = response?.xepg ? response : await threadfinWs("getServerConfig");
  return threadfinOutput({
    dryRun: false,
    command: "updateFileM3U",
    playlistId: id,
    playlist: summarizeThreadfinSource(id, "m3u", source, true),
    mappingCountBefore,
    mappingCountAfter: Object.keys(afterConfig.xepg?.epgMapping || {}).length,
    sourceGroups,
    response
  }, input.includeSensitive);
}

function normalizeThreadfinMappingUpdates(input) {
  return compactObject({
    ...(input.updates || input.fields || {}),
    "x-active": input["x-active"],
    "x-category": input["x-category"] || input.xCategory || input.x_category,
    "x-channelID": input["x-channelID"] || input.xChannelID || input.x_channel_id,
    "x-name": input["x-name"] || input.xName || input.x_name,
    "x-group-title": input["x-group-title"] || input.xGroupTitle || input.x_group_title,
    "x-mapping": input["x-mapping"] || input.xMapping || input.x_mapping,
    "x-xmltv-file": input["x-xmltv-file"] || input.xXmltvFile || input.x_xmltv_file,
    "x-hide-channel": input["x-hide-channel"]
  });
}

function selectThreadfinMappings(mapping, input = {}) {
  const mappingKeys = new Set([...(input.mappingKeys || []), ...(input.mapping_keys || [])].map(String));
  const channelNumbers = new Set([...(input.channelNumbers || []), ...(input.channel_numbers || [])].map(String));
  const groupTitle = input.groupTitle || input.group_title;
  const playlistId = input.playlistId || input.playlist_id;
  const xmltvFile = input.xmltvFile || input.xmltv_file;
  const searchTerms = threadfinTerms(input.searchTokens || input.search_tokens || input.search);
  if (!mappingKeys.size && !channelNumbers.size && !groupTitle && !searchTerms.length) {
    throw new Error("At least one Threadfin mapping selector is required");
  }
  const selected = [];
  for (const [key, channel] of Object.entries(mapping || {})) {
    if (playlistId && channel?.["_file.m3u.id"] !== playlistId) {
      continue;
    }
    if (xmltvFile && channel?.["x-xmltv-file"] !== xmltvFile) {
      continue;
    }
    const selectorMatched =
      mappingKeys.has(key) ||
      channelNumbers.has(String(channel?.["x-channelID"] || "")) ||
      (groupTitle && normalizedLookupName(channel?.["x-group-title"] || channel?.["group-title"]) === normalizedLookupName(groupTitle)) ||
      (searchTerms.length > 0 && threadfinMatchesAny(threadfinMappingHaystack(channel, key), searchTerms));
    if (selectorMatched) {
      selected.push(key);
    }
  }
  return selected.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function threadfinSetMappingFields(input = {}) {
  const body = await threadfinWs("getServerConfig");
  const currentMapping = body.xepg?.epgMapping || {};
  const selectedKeys = selectThreadfinMappings(currentMapping, input);
  if (!selectedKeys.length) {
    return {
      dryRun: input.dryRun,
      command: "saveEpgMapping",
      selectedMappingKeys: [],
      changes: [],
      note: "No Threadfin mappings matched the supplied selectors."
    };
  }
  const updates = normalizeThreadfinMappingUpdates(input);
  const proposedMapping = mergeObjectPatch(currentMapping, {});
  const channelNumberStart = input.channelNumberStart ?? input.channel_number_start;
  const numericChannelNumberStart = channelNumberStart === undefined ? undefined : Number(channelNumberStart);
  if (channelNumberStart !== undefined && !Number.isFinite(numericChannelNumberStart)) {
    throw new Error("Threadfin channelNumberStart must be a number when provided");
  }
  const changes = selectedKeys.map((key, index) => {
    const current = currentMapping[key];
    const patch = { ...updates };
    if (channelNumberStart !== undefined) {
      patch["x-channelID"] = String(numericChannelNumberStart + index);
    }
    const proposed = mergeObjectPatch(current, patch);
    proposedMapping[key] = proposed;
    return {
      id: key,
      current: summarizeThreadfinChannel(key, current, input.includeSensitive),
      proposed: summarizeThreadfinChannel(key, proposed, input.includeSensitive),
      diff: compactDiff(current, proposed)
    };
  });
  if (input.dryRun) {
    return {
      dryRun: true,
      command: "saveEpgMapping",
      selectedMappingKeys: selectedKeys,
      changes,
      note: "Set dryRun=false and confirm=true to save these Threadfin mapping changes."
    };
  }
  requireThreadfinConfirm(input, "Threadfin mapping changes");
  return threadfinOutput({
    dryRun: false,
    command: "saveEpgMapping",
    selectedMappingKeys: selectedKeys,
    changes,
    response: await threadfinWs("saveEpgMapping", { epgMapping: proposedMapping })
  }, input.includeSensitive);
}

function parseThreadfinXmltvChannels(text) {
  const channels = [];
  const pattern = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi;
  let match;
  while ((match = pattern.exec(String(text || ""))) !== null) {
    const attrs = parseM3uAttributes(match[1]);
    const displayNames = [...match[2].matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/gi)]
      .map(nameMatch => decodeXmlText(nameMatch[1]))
      .filter(Boolean);
    channels.push({
      id: attrs.id,
      displayNames
    });
  }
  return channels;
}

async function threadfinFindXmltvChannels(input = {}) {
  const body = await threadfinWs("getServerConfig");
  const settings = body.settings || {};
  const xmltvId = input.xmltvId || input.xmltv_id;
  const { id, source } = threadfinConfigSource(settings, "xmltv", xmltvId);
  const terms = threadfinTerms(input.searchTokens || input.search_tokens || input.search);
  const records = parseThreadfinXmltvChannels(await threadfinFetchSourceText(source, settings, "xmltv"))
    .map(channel => {
      const values = [channel.id, ...channel.displayNames].filter(Boolean);
      const normalizedValues = values.map(normalizedLookupName);
      const exactTerms = terms.filter(term => normalizedValues.includes(normalizedLookupName(term)));
      const haystack = values.join(" ").toLowerCase();
      const candidateTerms = terms.filter(term => haystack.includes(term.toLowerCase()));
      const matchType = exactTerms.length ? "exact" : candidateTerms.length || terms.length === 0 ? "candidate" : undefined;
      return compactObject({
        id: channel.id,
        displayNames: channel.displayNames,
        matchType,
        exactTerms,
        matchedTerms: [...new Set([...exactTerms, ...candidateTerms])]
      });
    })
    .filter(record => record.matchType);
  const limit = input.limit || 100;
  return {
    xmltvId: id,
    source: summarizeThreadfinSource(id, "xmltv", source, false),
    total: records.length,
    returned: Math.min(records.length, limit),
    records: records.slice(0, limit)
  };
}

async function threadfinFetchPublicText(path) {
  const response = await fetch(threadfinEndpoint(path), { signal: AbortSignal.timeout(requestTimeoutMs) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Threadfin ${path} failed: ${response.status} ${response.statusText}: ${redactText(text).slice(0, 500)}`);
  }
  return {
    contentType: response.headers.get("content-type"),
    text
  };
}

async function threadfinFetchFirstPublicText(paths) {
  const errors = [];
  for (const path of paths) {
    try {
      return { path, ...(await threadfinFetchPublicText(path)) };
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(errors.join("; "));
}

function threadfinPublicLineupRecord(record) {
  return compactObject({
    guideNumber: record?.GuideNumber ?? record?.guideNumber ?? record?.number,
    guideName: record?.GuideName ?? record?.guideName ?? record?.name,
    urlTail: threadfinUrlTail(record?.URL || record?.Url || record?.url)
  });
}

function threadfinVerifyMatches({ lineup, m3uRecords, expectedNames, expectedNumbers, expectedTokens }) {
  const expectations = [
    ...threadfinTerms(expectedNames).map(value => ({ type: "name", value })),
    ...threadfinTerms(expectedNumbers).map(value => ({ type: "number", value })),
    ...threadfinTerms(expectedTokens).map(value => ({ type: "token", value }))
  ];
  return expectations.map(expectation => {
    const lower = expectation.value.toLowerCase();
    const lineupMatches = lineup
      .map(threadfinPublicLineupRecord)
      .filter(record => [record.guideNumber, record.guideName, record.urlTail].filter(Boolean).join(" ").toLowerCase().includes(lower));
    const m3uMatches = m3uRecords
      .filter(record => threadfinM3uHaystack(record).includes(lower))
      .map(sanitizeM3uRecord);
    return {
      ...expectation,
      matched: lineupMatches.length > 0 || m3uMatches.length > 0,
      lineupMatches,
      m3uMatches
    };
  });
}

async function threadfinVerifyOutput(input = {}) {
  const [lineupFetch, m3uFetch, discoverFetch] = await Promise.all([
    threadfinFetchFirstPublicText(["lineup.json"]),
    threadfinFetchFirstPublicText(["m3u/", "m3u/threadfin.m3u"]),
    threadfinFetchFirstPublicText(["discover.json"])
  ]);
  let lineup = [];
  let discover = {};
  try {
    lineup = JSON.parse(lineupFetch.text);
  } catch {
    lineup = [];
  }
  try {
    discover = JSON.parse(discoverFetch.text);
  } catch {
    discover = {};
  }
  const m3uRecords = parseThreadfinM3u(m3uFetch.text);
  const expectedNames = input.expectedChannelNames || input.expected_channel_names;
  const expectedNumbers = input.expectedChannelNumbers || input.expected_channel_numbers;
  const expectedTokens = input.expectedTokens || input.expected_tokens;
  return threadfinOutput({
    endpoints: {
      lineup: lineupFetch.path,
      m3u: m3uFetch.path,
      discover: discoverFetch.path
    },
    tunerCount: discover.TunerCount ?? discover.tunerCount,
    lineupCount: Array.isArray(lineup) ? lineup.length : 0,
    m3uCount: m3uRecords.length,
    discover: compactObject({
      friendlyName: discover.FriendlyName,
      modelNumber: discover.ModelNumber,
      firmwareName: discover.FirmwareName,
      tunerCount: discover.TunerCount ?? discover.tunerCount,
      deviceId: discover.DeviceID
    }),
    matches: threadfinVerifyMatches({
      lineup: Array.isArray(lineup) ? lineup : [],
      m3uRecords,
      expectedNames,
      expectedNumbers,
      expectedTokens
    })
  }, input.includeSensitive);
}

function redactThreadfinM3uContent(text) {
  return String(text || "").split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const tail = threadfinUrlTail(trimmed);
      return tail ? `[redacted] ${tail}` : "[redacted]";
    }
    return redactText(line);
  }).join("\n");
}

async function threadfinConfigSnapshot(includeSensitive = false) {
  const body = await threadfinWs("getServerConfig");
  return threadfinOutput({
    summary: threadfinConfigSummary(body),
    ...body
  }, includeSensitive);
}

async function threadfinStatus(includeSensitive = false) {
  let apiStatus;
  try {
    apiStatus = await threadfinApi("status");
  } catch (error) {
    apiStatus = { error: error.message };
  }
  const config = await threadfinWs("getServerConfig");
  return threadfinOutput({
    api: apiStatus,
    clientInfo: config.clientInfo,
    status: config.status,
    configurationWizard: config.configurationWizard,
    notifications: config.notification,
    settings: {
      api: config.settings?.api,
      authenticationWeb: config.settings?.["authentication.web"],
      authenticationApi: config.settings?.["authentication.api"],
      authenticationM3U: config.settings?.["authentication.m3u"],
      authenticationXML: config.settings?.["authentication.xml"],
      epgSource: config.settings?.epgSource,
      tuner: config.settings?.tuner,
      buffer: config.settings?.buffer
    }
  }, includeSensitive);
}

async function threadfinOverview() {
  const body = await threadfinWs("getServerConfig");
  return {
    version: body.clientInfo?.version,
    streams: body.clientInfo?.streams,
    xepg: body.clientInfo?.xepg,
    activeClients: body.clientInfo?.activeClients,
    totalClients: body.clientInfo?.totalClients,
    activePlaylist: body.clientInfo?.activePlaylist,
    totalPlaylist: body.clientInfo?.totalPlaylist,
    errors: body.clientInfo?.errors,
    warnings: body.clientInfo?.warnings
  };
}

async function threadfinListSources(input = {}) {
  const type = input.type || "all";
  const body = await threadfinWs("getServerConfig");
  const settings = body.settings || {};
  const types = type === "all" ? ["m3u", "hdhr", "xmltv"] : [type];
  const records = [];
  for (const fileType of types) {
    for (const [id, source] of Object.entries(threadfinFiles(settings, fileType))) {
      const record = summarizeThreadfinSource(id, fileType, source, input.includeSensitive);
      if (threadfinRecordMatches(record, input.term)) {
        records.push(record);
      }
    }
  }
  return {
    total: records.length,
    returned: Math.min(records.length, input.limit || 100),
    records: records.slice(0, input.limit || 100)
  };
}

async function threadfinListChannels(input = {}) {
  const body = await threadfinWs("getServerConfig");
  const channels = body.xepg?.epgMapping || {};
  const includeInactive = input.includeInactive ?? true;
  const records = [];
  for (const [id, channel] of Object.entries(channels)) {
    if (!includeInactive && channel?.["x-active"] !== true) {
      continue;
    }
    if (input.playlistId && channel?.["_file.m3u.id"] !== input.playlistId) {
      continue;
    }
    if (input.xmltvFile && channel?.["x-xmltv-file"] !== input.xmltvFile) {
      continue;
    }
    const record = summarizeThreadfinChannel(id, channel, input.includeSensitive);
    if (threadfinRecordMatches(record, input.term)) {
      records.push(record);
    }
  }
  return {
    total: records.length,
    returned: Math.min(records.length, input.limit || 100),
    records: records.slice(0, input.limit || 100)
  };
}

async function threadfinGetChannel(id, includeSensitive = false) {
  const body = await threadfinWs("getServerConfig");
  const channel = body.xepg?.epgMapping?.[id];
  if (!channel) {
    throw new Error(`Threadfin channel ${id} was not found`);
  }
  return summarizeThreadfinChannel(id, channel, includeSensitive);
}

async function threadfinListXmltvChannels(input = {}) {
  const body = await threadfinWs("getServerConfig");
  const xmltvMap = body.xepg?.xmltvMap || {};
  const records = [];
  for (const [file, channels] of Object.entries(xmltvMap)) {
    if (input.file && file !== input.file) {
      continue;
    }
    for (const [id, channel] of Object.entries(channels || {})) {
      const record = compactObject({
        file,
        id,
        displayName: Array.isArray(channel?.["display-name"]) ? channel["display-name"].join(" / ") : channel?.["display-name"],
        icon: channel?.icon,
        raw: input.includeRaw ? channel : undefined
      });
      if (threadfinRecordMatches(record, input.term)) {
        records.push(threadfinOutput(record, input.includeSensitive));
      }
    }
  }
  return {
    total: records.length,
    returned: Math.min(records.length, input.limit || 100),
    records: records.slice(0, input.limit || 100)
  };
}

function threadfinSourcePatch(input) {
  const data = { ...(input.patch || {}) };
  if (input.name !== undefined) {
    data.name = input.name;
  }
  if (input.description !== undefined) {
    data.description = input.description;
  }
  if (input.fileSource !== undefined) {
    data["file.source"] = input.fileSource;
  }
  if (input.buffer !== undefined) {
    data.buffer = input.buffer;
  }
  if (input.tuner !== undefined) {
    data.tuner = input.tuner;
  }
  if (input.httpProxyIp !== undefined) {
    data["http_proxy.ip"] = input.httpProxyIp;
  }
  if (input.httpProxyPort !== undefined) {
    data["http_proxy.port"] = input.httpProxyPort;
  }
  if (input.httpHeadersOrigin !== undefined) {
    data["http_headers.origin"] = input.httpHeadersOrigin;
  }
  if (input.httpHeadersReferer !== undefined) {
    data["http_headers.referer"] = input.httpHeadersReferer;
  }
  if (input.delete) {
    data.delete = true;
  }
  return data;
}

function threadfinFileCommand(type, action) {
  const suffix = type === "m3u" ? "M3U" : type === "xmltv" ? "XMLTV" : "HDHR";
  return `${action}${suffix}`;
}

async function threadfinSaveSource(input) {
  const id = input.id || "-";
  const type = input.type;
  const data = threadfinSourcePatch(input);
  const payload = { files: { [type]: { [id]: data } } };
  const command = threadfinFileCommand(type, "saveFiles");
  if (input.dryRun) {
    const current = id === "-" ? undefined : (await threadfinWs("getServerConfig")).settings?.files?.[type]?.[id];
    return threadfinOutput({
      dryRun: true,
      command,
      payload,
      current,
      proposed: mergeObjectPatch(current || {}, data),
      diff: compactDiff(current || {}, mergeObjectPatch(current || {}, data)),
      note: "Set dryRun to false to send this Threadfin source change."
    }, input.includeSensitive);
  }
  requireThreadfinConfirm(input, "Threadfin source changes");
  return threadfinOutput({
    dryRun: false,
    command,
    response: await threadfinWs(command, payload)
  }, input.includeSensitive);
}

async function threadfinRefreshSource(input) {
  const type = input.type;
  if (input.id) {
    const command = threadfinFileCommand(type, "updateFile");
    const payload = { files: { [type]: { [input.id]: {} } } };
    if (input.dryRun) {
      return { dryRun: true, command, payload };
    }
    requireThreadfinConfirm(input, "Threadfin source refreshes");
    return threadfinOutput({ dryRun: false, command, response: await threadfinWs(command, payload) }, input.includeSensitive);
  }
  const command = `update.${type}`;
  if (input.dryRun) {
    return { dryRun: true, apiCommand: command };
  }
  requireThreadfinConfirm(input, "Threadfin source refreshes");
  return threadfinOutput({ dryRun: false, apiCommand: command, response: await threadfinApi(command) }, input.includeSensitive);
}

async function threadfinUpdateSettings(input) {
  const current = (await threadfinWs("getServerConfig")).settings || {};
  const proposed = mergeObjectPatch(current, input.patch || {});
  const diff = compactDiff(current, proposed);
  if (input.dryRun) {
    return threadfinOutput({
      dryRun: true,
      command: "saveSettings",
      currentObject: current,
      proposedObject: proposed,
      diff,
      note: "Set dryRun to false to send this Threadfin settings patch."
    }, input.includeSensitive);
  }
  requireThreadfinConfirm(input, "Threadfin settings changes");
  return threadfinOutput({
    dryRun: false,
    command: "saveSettings",
    diff,
    response: await threadfinWs("saveSettings", { settings: input.patch || {} })
  }, input.includeSensitive);
}

async function threadfinSaveFilter(input) {
  const id = String(input.id ?? -1);
  const data = { ...(input.patch || {}) };
  for (const key of ["name", "description", "type", "filter", "include", "exclude", "startingNumber", "x-category"]) {
    if (input[key] !== undefined) {
      data[key] = input[key];
    }
  }
  for (const key of ["active", "caseSensitive", "liveEvent"]) {
    if (input[key] !== undefined) {
      data[key] = input[key];
    }
  }
  if (input.delete) {
    data.delete = true;
  }
  const payload = { filter: { [id]: data } };
  if (input.dryRun) {
    const current = (await threadfinWs("getServerConfig")).settings?.filter?.[id];
    return threadfinOutput({
      dryRun: true,
      command: "saveFilter",
      payload,
      current,
      proposed: mergeObjectPatch(current || {}, data),
      diff: compactDiff(current || {}, mergeObjectPatch(current || {}, data))
    }, input.includeSensitive);
  }
  requireThreadfinConfirm(input, "Threadfin filter changes");
  return threadfinOutput({ dryRun: false, command: "saveFilter", response: await threadfinWs("saveFilter", payload) }, input.includeSensitive);
}

async function threadfinUpdateChannels(input) {
  const body = await threadfinWs("getServerConfig");
  const currentMapping = body.xepg?.epgMapping || {};
  const proposedMapping = mergeObjectPatch(currentMapping, {});
  const changes = [];
  for (const change of input.channels) {
    const current = currentMapping[change.id];
    if (!current) {
      throw new Error(`Threadfin channel ${change.id} was not found`);
    }
    const proposed = mergeObjectPatch(current, change.patch || {});
    proposedMapping[change.id] = proposed;
    changes.push({
      id: change.id,
      current: summarizeThreadfinChannel(change.id, current, input.includeSensitive),
      proposed: summarizeThreadfinChannel(change.id, proposed, input.includeSensitive),
      diff: compactDiff(current, proposed)
    });
  }
  if (input.dryRun) {
    return {
      dryRun: true,
      command: "saveEpgMapping",
      changes,
      note: "Set dryRun to false to save the updated Threadfin channel mapping."
    };
  }
  requireThreadfinConfirm(input, "Threadfin channel mapping changes");
  return threadfinOutput({
    dryRun: false,
    command: "saveEpgMapping",
    changes,
    response: await threadfinWs("saveEpgMapping", { epgMapping: proposedMapping })
  }, input.includeSensitive);
}

async function threadfinSaveUser(input) {
  const data = { ...(input.userData || {}) };
  for (const key of ["username", "password", "confirm"]) {
    if (input[key] !== undefined) {
      data[key] = input[key];
    }
  }
  for (const key of ["authentication.web", "authentication.pms", "authentication.m3u", "authentication.xml", "authentication.api"]) {
    if (input[key] !== undefined) {
      data[key] = input[key];
    }
  }
  if (input.delete) {
    data.delete = true;
  }
  const newUser = !input.id || input.id === "-";
  const command = newUser ? "saveNewUser" : "saveUserData";
  const payload = newUser ? { userData: data } : { userData: { [input.id]: data } };
  if (input.dryRun) {
    const current = newUser ? undefined : (await threadfinWs("getServerConfig")).users?.[input.id];
    return threadfinOutput({ dryRun: true, command, payload, current }, input.includeSensitive);
  }
  requireThreadfinConfirm(input, "Threadfin user changes");
  return threadfinOutput({ dryRun: false, command, response: await threadfinWs(command, payload) }, input.includeSensitive);
}

async function threadfinLogs(input = {}) {
  const body = await threadfinWs("updateLog");
  const records = Array.isArray(body.log?.log) ? body.log.log.map(redactText) : [];
  return {
    errors: body.log?.errors,
    warnings: body.log?.warnings,
    clientInfo: body.clientInfo,
    total: records.length,
    returned: Math.min(records.length, input.limit || 200),
    records: records.slice(-(input.limit || 200))
  };
}

async function threadfinBackupConfig(input = {}) {
  if (input.dryRun) {
    return { dryRun: true, command: "ThreadfinBackup" };
  }
  return threadfinOutput({ dryRun: false, command: "ThreadfinBackup", response: await threadfinWs("ThreadfinBackup") }, input.includeSensitive);
}

async function threadfinRestoreConfig(input) {
  if (input.dryRun) {
    return { dryRun: true, command: "ThreadfinRestore", base64Bytes: Buffer.byteLength(input.base64 || "", "utf8") };
  }
  requireThreadfinConfirm(input, "Threadfin restore");
  return threadfinOutput({
    dryRun: false,
    command: "ThreadfinRestore",
    response: await threadfinWs("ThreadfinRestore", { base64: input.base64 })
  }, input.includeSensitive);
}

async function threadfinSetPpv(input) {
  const path = input.enabled ? "ppv/enable" : "ppv/disable";
  if (input.dryRun) {
    return { dryRun: true, endpoint: path, enabled: input.enabled };
  }
  requireThreadfinConfirm(input, "Threadfin PPV changes");
  const response = await fetch(threadfinEndpoint(path), {
    method: "POST",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Threadfin ${path} failed: ${response.status} ${response.statusText}: ${text}`);
  }
  return { dryRun: false, endpoint: path, enabled: input.enabled, ok: true };
}

async function threadfinExportOutput(input = {}) {
  if ((input.kind || "urls") === "urls") {
    return threadfinStatus(input.includeSensitive);
  }
  const paths = {
    m3u: "m3u/threadfin.m3u",
    xmltv: "xmltv/threadfin.xml",
    lineup: "lineup.json",
    discover: "discover.json"
  };
  const path = paths[input.kind];
  const url = threadfinEndpoint(path);
  const service = requireService("threadfin");
  if ((input.kind === "m3u" || input.kind === "xmltv") && service.username && service.password) {
    url.searchParams.set("username", service.username);
    url.searchParams.set("password", service.password);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Threadfin export ${input.kind} failed: ${response.status} ${response.statusText}: ${text}`);
  }
  const maxChars = Math.max(1, Math.min(input.maxChars || 10000, 100000));
  let parsed;
  if (input.kind === "lineup" || input.kind === "discover") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  return threadfinOutput({
    kind: input.kind,
    contentType: response.headers.get("content-type"),
    length: text.length,
    truncated: text.length > maxChars,
    json: parsed,
    content: input.includeContent ? (input.kind === "m3u" ? redactThreadfinM3uContent(text) : redactText(text)).slice(0, maxChars) : undefined
  }, input.includeSensitive);
}

async function threadfinRawWebsocketCommand(input) {
  const payload = input.payload || {};
  if (input.dryRun) {
    return threadfinOutput({ dryRun: true, command: input.cmd, payload }, input.includeSensitive);
  }
  if (!input.confirmUnsafe) {
    throw new Error("confirmUnsafe=true is required when dryRun=false for raw Threadfin websocket commands");
  }
  return threadfinOutput({
    dryRun: false,
    command: input.cmd,
    response: await threadfinWs(input.cmd, payload)
  }, input.includeSensitive);
}

async function threadfinRawApiCommand(input) {
  const payload = input.payload || {};
  if (input.dryRun) {
    return threadfinOutput({ dryRun: true, command: input.cmd, payload }, input.includeSensitive);
  }
  if (!input.confirmUnsafe) {
    throw new Error("confirmUnsafe=true is required when dryRun=false for raw Threadfin API commands");
  }
  return threadfinOutput({
    dryRun: false,
    command: input.cmd,
    response: await threadfinApi(input.cmd, payload)
  }, input.includeSensitive);
}

function summarizeArrLogRecord(record) {
  return compactObject({
    id: record.id,
    time: record.time,
    level: record.level,
    logger: record.logger,
    exception: redactText(record.exception),
    message: redactText(record.message)
  });
}

function summarizeArrHistoryRecord(record) {
  return compactObject({
    id: record.id,
    eventType: record.eventType,
    sourceTitle: record.sourceTitle,
    seriesId: record.seriesId ?? record.series?.id,
    seriesTitle: record.series?.title,
    movieId: record.movieId ?? record.movie?.id,
    movieTitle: record.movie?.title,
    quality: record.quality,
    languages: record.languages,
    downloadId: record.downloadId,
    data: record.data ? Object.fromEntries(Object.entries(record.data)
      .filter(([key]) => !/api|token|password|url/i.test(key))
      .map(([key, value]) => [key, redactText(value)])) : undefined,
    date: record.date
  });
}

function summarizeArrBlocklistRecord(record) {
  return compactObject({
    id: record.id,
    sourceTitle: record.sourceTitle,
    seriesId: record.seriesId ?? record.series?.id,
    seriesTitle: record.series?.title,
    movieId: record.movieId ?? record.movie?.id,
    movieTitle: record.movie?.title,
    quality: record.quality,
    languages: record.languages,
    protocol: record.protocol,
    indexer: record.indexer,
    message: redactText(record.message),
    date: record.date
  });
}

function summarizeArrWantedRecord(record) {
  const looksLikeEpisode = record.episodeId !== undefined || record.seasonNumber !== undefined || record.episodeNumber !== undefined;
  return compactObject({
    id: record.id,
    title: record.title,
    seriesId: record.seriesId ?? record.series?.id,
    seriesTitle: record.series?.title,
    movieId: record.movieId ?? record.movie?.id ?? (looksLikeEpisode ? undefined : record.id),
    movieTitle: record.movie?.title,
    episodeId: looksLikeEpisode ? record.episodeId ?? record.id : undefined,
    seasonNumber: record.seasonNumber,
    episodeNumber: record.episodeNumber,
    airDateUtc: record.airDateUtc,
    quality: record.quality,
    monitored: record.monitored
  });
}

function summarizeSonarrWantedMissingRecord(record) {
  const episodeId = Number(record.episodeId ?? record.id);
  return compactObject({
    episodeId: Number.isInteger(episodeId) && episodeId > 0 ? episodeId : undefined,
    seriesId: record.seriesId ?? record.series?.id,
    seriesTitle: record.series?.title,
    seasonNumber: record.seasonNumber,
    episodeNumber: record.episodeNumber,
    title: record.title,
    airDateUtc: record.airDateUtc,
    monitored: record.monitored,
    seriesMonitored: record.series?.monitored
  });
}

function summarizeRadarrWantedMissingRecord(record) {
  const movieId = Number(record.movieId ?? record.id);
  return compactObject({
    movieId: Number.isInteger(movieId) && movieId > 0 ? movieId : undefined,
    title: record.title ?? record.movie?.title,
    movieTitle: record.movie?.title,
    year: record.year ?? record.movie?.year,
    tmdbId: record.tmdbId ?? record.movie?.tmdbId,
    monitored: record.monitored ?? record.movie?.monitored,
    isAvailable: record.isAvailable ?? record.movie?.isAvailable,
    inCinemas: record.inCinemas ?? record.movie?.inCinemas,
    digitalRelease: record.digitalRelease ?? record.movie?.digitalRelease,
    physicalRelease: record.physicalRelease ?? record.movie?.physicalRelease
  });
}

function summarizeArrCommandRecord(record) {
  const body = record?.body || {};
  return compactObject({
    id: record?.id,
    name: record?.name ?? body.name,
    status: record?.status,
    stateChangeTime: record?.stateChangeTime,
    queued: record?.queued,
    started: record?.started,
    ended: record?.ended,
    duration: record?.duration,
    trigger: record?.trigger,
    message: record?.message,
    exception: record?.exception,
    episodeIdCount: Array.isArray(body.episodeIds) ? body.episodeIds.length : undefined,
    movieIdCount: Array.isArray(body.movieIds) ? body.movieIds.length : undefined,
    seriesId: body.seriesId,
    movieId: body.movieId,
    seasonNumber: body.seasonNumber
  });
}

function arrRecordsPage(body, mapper, limit) {
  const records = Array.isArray(body?.records) ? body.records : Array.isArray(body) ? body : [];
  return {
    page: body?.page,
    pageSize: body?.pageSize,
    totalRecords: body?.totalRecords ?? records.length,
    returned: Math.min(records.length, limit),
    records: records.slice(0, limit).map(mapper)
  };
}

function normalizeArrWantedPagination(input = {}) {
  const pagination = typeof input === "number" ? { limit: input } : { ...input };
  if (pagination.page !== undefined && pagination.offset !== undefined) {
    throw new Error("Use either page/pageSize or offset/limit for wanted pagination, not both page and offset.");
  }
  const limit = Number(pagination.limit ?? pagination.pageSize ?? arrWantedDefaultPageSize);
  const pageSize = Number(pagination.pageSize ?? Math.min(limit, arrWantedMaxPageSize));
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer.");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("pageSize must be a positive integer.");
  }
  if (limit > arrWantedMaxLimit) {
    throw new Error(`limit is capped at ${arrWantedMaxLimit}; use page/pageSize or offset/limit windows for larger traversals.`);
  }
  if (pageSize > arrWantedMaxPageSize) {
    throw new Error(`pageSize is capped at ${arrWantedMaxPageSize}; use page/pageSize or offset/limit windows for larger traversals.`);
  }
  const offset = Number(pagination.offset ?? ((pagination.page ?? 1) - 1) * pageSize);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative integer.");
  }
  const page = Math.floor(offset / pageSize) + 1;
  return { page, pageSize, limit, offset };
}

function recordsFromArrPage(body) {
  return Array.isArray(body?.records) ? body.records : Array.isArray(body) ? body : [];
}

async function arrPagedRecordWindow(serviceName, path, pagination) {
  const records = [];
  let totalRecords;
  let page = Math.floor(pagination.offset / pagination.pageSize) + 1;
  let skip = pagination.offset % pagination.pageSize;
  let pagesFetched = 0;
  while (records.length < pagination.limit && pagesFetched < 1000) {
    const body = await arrApi(serviceName, "v3", path, {
      query: { page, pageSize: pagination.pageSize }
    });
    const pageRecords = recordsFromArrPage(body);
    totalRecords = body?.totalRecords ?? totalRecords ?? pageRecords.length;
    const usable = skip ? pageRecords.slice(skip) : pageRecords;
    records.push(...usable.slice(0, pagination.limit - records.length));
    pagesFetched += 1;
    if (!pageRecords.length || pageRecords.length < pagination.pageSize) {
      break;
    }
    if (Number.isInteger(totalRecords) && page * pagination.pageSize >= totalRecords) {
      break;
    }
    page += 1;
    skip = 0;
  }
  return {
    totalRecords: totalRecords ?? records.length,
    pagesFetched,
    records
  };
}

async function arrWanted(serviceName, kind, input = {}) {
  const pagination = normalizeArrWantedPagination(input);
  const page = await arrPagedRecordWindow(serviceName, `wanted/${kind}`, pagination);
  return {
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalRecords: page.totalRecords,
    returned: page.records.length,
    records: page.records.map(summarizeArrWantedRecord)
  };
}

async function arrAllWantedRecords(serviceName, kind) {
  const records = [];
  let totalRecords;
  let page = 1;
  let pagesFetched = 0;
  while (page <= 1000) {
    const body = await arrApi(serviceName, "v3", `wanted/${kind}`, {
      query: { page, pageSize: arrWantedInternalPageSize }
    });
    const pageRecords = recordsFromArrPage(body);
    totalRecords = body?.totalRecords ?? totalRecords ?? pageRecords.length;
    records.push(...pageRecords);
    pagesFetched += 1;
    if (!pageRecords.length || pageRecords.length < arrWantedInternalPageSize) {
      break;
    }
    if (Number.isInteger(totalRecords) && page * arrWantedInternalPageSize >= totalRecords) {
      break;
    }
    page += 1;
  }
  return {
    pageSize: arrWantedInternalPageSize,
    totalRecords: totalRecords ?? records.length,
    pagesFetched,
    records
  };
}

function addSkippedReason(skipped, reason) {
  skipped.total += 1;
  skipped.reasons[reason] = (skipped.reasons[reason] || 0) + 1;
}

function sonarrWantedMissingSkipReason(record, options, nowMs) {
  const episodeId = Number(record.episodeId ?? record.id);
  if (!Number.isInteger(episodeId) || episodeId < 1) {
    return "missingEpisodeId";
  }
  if (options.monitoredOnly && (record.monitored === false || record.series?.monitored === false)) {
    return "unmonitored";
  }
  if (!options.includeSpecials && Number(record.seasonNumber) === 0) {
    return "special";
  }
  if (options.airedOnly) {
    const airDateMs = Date.parse(record.airDateUtc || "");
    if (!Number.isFinite(airDateMs) || airDateMs > nowMs) {
      return "unaired";
    }
  }
  return null;
}

function radarrWantedMissingSkipReason(record, options) {
  const movieId = Number(record.movieId ?? record.id);
  if (!Number.isInteger(movieId) || movieId < 1) {
    return "missingMovieId";
  }
  if (options.monitoredOnly && (record.monitored === false || record.movie?.monitored === false)) {
    return "unmonitored";
  }
  if (options.availableOnly && (record.isAvailable ?? record.movie?.isAvailable) !== true) {
    return "unavailable";
  }
  return null;
}

async function sonarrWantedMissingIds(input = {}) {
  const options = {
    monitoredOnly: input.monitoredOnly ?? true,
    airedOnly: input.airedOnly ?? true,
    includeSpecials: input.includeSpecials ?? false
  };
  const raw = await arrAllWantedRecords("sonarr", "missing");
  const skipped = { total: 0, reasons: {} };
  const seen = new Set();
  const records = [];
  const nowMs = Date.now();
  for (const record of raw.records) {
    const reason = sonarrWantedMissingSkipReason(record, options, nowMs);
    if (reason) {
      addSkippedReason(skipped, reason);
      continue;
    }
    const episodeId = Number(record.episodeId ?? record.id);
    if (seen.has(episodeId)) {
      addSkippedReason(skipped, "duplicateEpisodeId");
      continue;
    }
    seen.add(episodeId);
    records.push(summarizeSonarrWantedMissingRecord(record));
  }
  return {
    service: "sonarr",
    filters: {
      monitoredOnly: options.monitoredOnly,
      airedOnly: options.airedOnly,
      includeSpecials: options.includeSpecials
    },
    pageSize: raw.pageSize,
    pagesFetched: raw.pagesFetched,
    totalRecords: raw.totalRecords,
    scanned: raw.records.length,
    returned: records.length,
    skipped,
    episodeIds: records.map(record => record.episodeId),
    records
  };
}

async function radarrWantedMissingIds(input = {}) {
  const options = {
    monitoredOnly: input.monitoredOnly ?? true,
    availableOnly: input.availableOnly ?? true
  };
  const raw = await arrAllWantedRecords("radarr", "missing");
  const skipped = { total: 0, reasons: {} };
  const seen = new Set();
  const records = [];
  for (const record of raw.records) {
    const reason = radarrWantedMissingSkipReason(record, options);
    if (reason) {
      addSkippedReason(skipped, reason);
      continue;
    }
    const movieId = Number(record.movieId ?? record.id);
    if (seen.has(movieId)) {
      addSkippedReason(skipped, "duplicateMovieId");
      continue;
    }
    seen.add(movieId);
    records.push(summarizeRadarrWantedMissingRecord(record));
  }
  return {
    service: "radarr",
    filters: {
      monitoredOnly: options.monitoredOnly,
      availableOnly: options.availableOnly
    },
    pageSize: raw.pageSize,
    pagesFetched: raw.pagesFetched,
    totalRecords: raw.totalRecords,
    scanned: raw.records.length,
    returned: records.length,
    skipped,
    movieIds: records.map(record => record.movieId),
    records
  };
}

function chunkList(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function exactSearchPlan(commandName, idField, ids, batchSize) {
  return chunkList(ids, batchSize).map((batch, index) => ({
    batch: index + 1,
    count: batch.length,
    command: arrCommand(commandName, { [idField]: batch })
  }));
}

async function arrSearchMissingExact(serviceName, input = {}) {
  const options = {
    ...input,
    batchSize: input.batchSize ?? arrExactSearchDefaultBatchSize,
    dryRun: input.dryRun ?? true
  };
  if (options.batchSize > arrExactSearchMaxBatchSize) {
    throw new Error(`batchSize is capped at ${arrExactSearchMaxBatchSize} for safe exact searches.`);
  }
  const isSonarr = serviceName === "sonarr";
  const commandName = isSonarr ? "EpisodeSearch" : "MoviesSearch";
  const idField = isSonarr ? "episodeIds" : "movieIds";
  const idResult = isSonarr ? await sonarrWantedMissingIds(options) : await radarrWantedMissingIds(options);
  const ids = idResult[idField];
  const plannedCommands = exactSearchPlan(commandName, idField, ids, options.batchSize);
  if (options.dryRun) {
    return {
      dryRun: true,
      service: serviceName,
      filters: idResult.filters,
      batchSize: options.batchSize,
      batchCount: plannedCommands.length,
      totalIds: ids.length,
      skipped: idResult.skipped,
      [idField]: ids,
      plannedCommands: plannedCommands.map(plan => ({ batch: plan.batch, count: plan.count, ...plan.command })),
      note: `Set dryRun to false to queue ${commandName} commands for exact ${idField}.`
    };
  }
  const queued = [];
  for (const plan of plannedCommands) {
    queued.push(await queueArrCommand(serviceName, plan.command));
  }
  const commandIds = queued.map(command => command?.id).filter(id => Number.isInteger(id));
  return {
    dryRun: false,
    service: serviceName,
    filters: idResult.filters,
    batchSize: options.batchSize,
    batchCount: plannedCommands.length,
    totalIds: ids.length,
    skipped: idResult.skipped,
    queuedCommandIds: commandIds,
    commands: Object.fromEntries(queued
      .filter(command => Number.isInteger(command?.id))
      .map(command => [String(command.id), summarizeArrCommandRecord(command)]))
  };
}

async function arrRecentHistory(serviceName, limit) {
  const body = await arrApi(serviceName, "v3", "history", {
    query: { page: 1, pageSize: limit, sortKey: "date", sortDirection: "descending" }
  });
  return arrRecordsPage(body, summarizeArrHistoryRecord, limit);
}

async function arrBlocklist(serviceName, limit) {
  const body = await arrApi(serviceName, "v3", "blocklist", {
    query: { page: 1, pageSize: limit, sortKey: "date", sortDirection: "descending" }
  });
  return arrRecordsPage(body, summarizeArrBlocklistRecord, limit);
}

async function arrCommandStatus(serviceName, input = {}) {
  const options = typeof input === "number" ? { commandId: input } : input;
  if (options.commandId && options.commandIds?.length) {
    throw new Error("Use either commandId or commandIds, not both.");
  }
  if (options.commandIds?.length) {
    const statuses = await Promise.all(options.commandIds.map(commandId => arrApi(serviceName, "v3", `command/${commandId}`)));
    return {
      service: serviceName,
      total: statuses.length,
      commands: Object.fromEntries(statuses.map((status, index) => [
        String(options.commandIds[index]),
        summarizeArrCommandRecord(status)
      ]))
    };
  }
  const body = await arrApi(serviceName, "v3", options.commandId ? `command/${options.commandId}` : "command");
  if (Array.isArray(body)) {
    return {
      service: serviceName,
      total: body.length,
      records: body.map(summarizeArrCommandRecord)
    };
  }
  return options.commandId ? summarizeArrCommandRecord(body) : body;
}

async function queueArrCommand(serviceName, command) {
  return arrApi(serviceName, "v3", "command", { method: "POST", body: command });
}

async function cancelArrCommand(serviceName, commandId, dryRun) {
  if (dryRun) {
    return { dryRun: true, service: serviceName, wouldCancelCommandId: commandId };
  }
  const response = await arrApi(serviceName, "v3", `command/${commandId}`, { method: "DELETE" });
  return { dryRun: false, service: serviceName, cancelledCommandId: commandId, response };
}

function arrCommand(name, fields = {}) {
  return compactObject({ name, ...fields });
}

async function arrCommandAction(serviceName, command, dryRun) {
  if (dryRun) {
    return {
      dryRun: true,
      service: serviceName,
      command,
      note: `Set dryRun to false to queue this ${serviceName} command.`
    };
  }
  const queued = await queueArrCommand(serviceName, command);
  return {
    dryRun: false,
    service: serviceName,
    commandId: queued?.id,
    command: queued
  };
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedLookupName(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function mergeObjectPatch(target, patch) {
  const result = cloneJson(target) || {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeObjectPatch(result[key], value);
    } else {
      result[key] = cloneJson(value);
    }
  }
  return result;
}

function omitKeys(value, keys) {
  return Object.fromEntries(Object.entries(value || {}).filter(([key]) => !keys.has(key)));
}

function diffValue(value) {
  if (value === undefined) {
    return "[missing]";
  }
  return redactSensitiveObject(value);
}

function pushCompactDiff(before, after, pathValue = "$", changes = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return changes;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      pushCompactDiff(before[key], after[key], `${pathValue}.${key}`, changes);
    }
    return changes;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const max = Math.max(before.length, after.length);
    for (let index = 0; index < max; index += 1) {
      pushCompactDiff(before[index], after[index], `${pathValue}[${index}]`, changes);
    }
    return changes;
  }
  changes.push({ path: pathValue, before: diffValue(before), after: diffValue(after) });
  return changes;
}

function compactDiff(before, after) {
  return pushCompactDiff(before, after).slice(0, 250);
}

function arrEndpoint(method, apiPath) {
  return {
    method,
    apiVersion: "v3",
    path: `/api/v3/${apiPath.replace(/^\/+/, "")}`
  };
}

function exactNameMatches(value, name) {
  return normalizedLookupName(value) === normalizedLookupName(name);
}

function resolveRecordByIdOrName(records, input, label, nameGetter = record => record.name) {
  if (input.id !== undefined) {
    const matched = records.find(record => record.id === input.id);
    if (!matched) {
      throw new Error(`${label} id ${input.id} was not found`);
    }
    if (input.name && !exactNameMatches(nameGetter(matched), input.name)) {
      throw new Error(`${label} id ${input.id} does not match exact name ${input.name}`);
    }
    return matched;
  }
  if (input.name) {
    const matches = records.filter(record => exactNameMatches(nameGetter(record), input.name));
    if (!matches.length) {
      throw new Error(`${label} named ${input.name} was not found`);
    }
    if (matches.length > 1) {
      throw new Error(`ambiguous ${label} name ${input.name}: matched ids ${matches.map(record => record.id).join(", ")}`);
    }
    return matches[0];
  }
  return null;
}

function arrQualityProfileItems(profile) {
  const roots = Array.isArray(profile?.items)
    ? profile.items
    : Array.isArray(profile?.qualities)
      ? profile.qualities
      : [];
  const entries = [];
  function visit(item, pathValue, groupNames = []) {
    if (!item || typeof item !== "object") {
      return;
    }
    const itemName = item.name ?? item.quality?.name;
    const entry = {
      item,
      path: pathValue,
      type: Array.isArray(item.items) ? "group" : "quality",
      id: Number.isInteger(item.id) ? item.id : undefined,
      qualityId: Number.isInteger(item.quality?.id) ? item.quality.id : undefined,
      name: itemName,
      groupNames
    };
    entries.push(entry);
    if (Array.isArray(item.items)) {
      const nextGroups = itemName ? [...groupNames, itemName] : groupNames;
      item.items.forEach((child, index) => visit(child, `${pathValue}.items[${index}]`, nextGroups));
    }
  }
  roots.forEach((item, index) => visit(item, `items[${index}]`));
  return entries;
}

function qualityProfileItemId(entry) {
  return entry.id ?? entry.qualityId;
}

function formatItemId(item) {
  const raw = item?.format ?? item?.formatId ?? item?.customFormatId ?? item?.customFormat?.id ?? item?.id;
  return Number.isInteger(raw) ? raw : Number(raw) || undefined;
}

function formatItemName(item) {
  return item?.name ?? item?.customFormat?.name;
}

function qualityDefinitionQualityId(record) {
  const raw = record?.quality?.id ?? record?.qualityId;
  return Number.isInteger(raw) ? raw : Number(raw) || undefined;
}

function qualityDefinitionName(record) {
  return record?.quality?.name ?? record?.title ?? record?.name;
}

function resolveQualityDefinition(records, input, label) {
  if (input.qualityId !== undefined) {
    const matches = records.filter(record => qualityDefinitionQualityId(record) === input.qualityId || record.id === input.qualityId);
    if (!matches.length) {
      throw new Error(`${label} quality id ${input.qualityId} was not found`);
    }
    if (matches.length > 1) {
      throw new Error(`ambiguous ${label} quality id ${input.qualityId}: matched definition ids ${matches.map(record => record.id).join(", ")}`);
    }
    if (input.qualityName && !exactNameMatches(qualityDefinitionName(matches[0]), input.qualityName)) {
      throw new Error(`${label} quality id ${input.qualityId} does not match exact name ${input.qualityName}`);
    }
    return matches[0];
  }
  if (input.qualityName) {
    const matches = records.filter(record => exactNameMatches(qualityDefinitionName(record), input.qualityName));
    if (!matches.length) {
      throw new Error(`${label} quality named ${input.qualityName} was not found`);
    }
    if (matches.length > 1) {
      throw new Error(`ambiguous ${label} quality name ${input.qualityName}: matched definition ids ${matches.map(record => record.id).join(", ")}`);
    }
    return matches[0];
  }
  return null;
}

function summarizeQualityProfile(profile) {
  const entries = arrQualityProfileItems(profile);
  const qualityItems = entries.filter(entry => entry.type === "quality");
  const groups = entries.filter(entry => entry.type === "group");
  return compactObject({
    id: profile.id,
    name: profile.name,
    upgradeAllowed: profile.upgradeAllowed,
    cutoff: profile.cutoff,
    minFormatScore: profile.minFormatScore,
    cutoffFormatScore: profile.cutoffFormatScore,
    minUpgradeFormatScore: profile.minUpgradeFormatScore,
    qualityItemCount: qualityItems.length,
    allowedQualityItemCount: qualityItems.filter(entry => entry.item.allowed === true).length,
    blockedQualityItemCount: qualityItems.filter(entry => entry.item.allowed === false).length,
    groups: groups.map(entry => compactObject({
      id: entry.id,
      name: entry.name,
      allowed: entry.item.allowed,
      itemCount: Array.isArray(entry.item.items) ? entry.item.items.length : undefined
    })),
    qualities: qualityItems.map(entry => compactObject({
      id: entry.id,
      qualityId: entry.qualityId,
      name: entry.name,
      allowed: entry.item.allowed,
      groups: entry.groupNames.length ? entry.groupNames : undefined
    })),
    customFormatScores: Array.isArray(profile.formatItems)
      ? profile.formatItems.map(item => compactObject({
        formatId: formatItemId(item),
        name: formatItemName(item),
        score: item.score
      }))
      : undefined
  });
}

function summarizeCustomFormat(format) {
  return compactObject({
    id: format.id,
    name: format.name,
    includeCustomFormatWhenRenaming: format.includeCustomFormatWhenRenaming,
    specificationCount: Array.isArray(format.specifications) ? format.specifications.length : undefined,
    specifications: Array.isArray(format.specifications)
      ? format.specifications.map(specification => compactObject({
        name: specification.name,
        implementation: specification.implementation,
        implementationName: specification.implementationName,
        negate: specification.negate,
        required: specification.required
      }))
      : undefined
  });
}

function summarizeQualityDefinition(record) {
  return compactObject({
    id: record.id,
    qualityId: qualityDefinitionQualityId(record),
    qualityName: qualityDefinitionName(record),
    title: record.title,
    minSize: record.minSize,
    maxSize: record.maxSize,
    preferredSize: record.preferredSize
  });
}

async function servarrRecords(serviceName, pathValue) {
  const records = await arrApi(serviceName, "v3", pathValue);
  return Array.isArray(records) ? records : [];
}

async function arrQualityProfiles(serviceName, input = {}) {
  const records = await servarrRecords(serviceName, "qualityprofile");
  const selected = resolveRecordByIdOrName(records, input, `${serviceName} quality profile`);
  const returnedRecords = selected ? [selected] : records;
  return {
    service: serviceName,
    total: records.length,
    returned: returnedRecords.length,
    records: input.includeRaw
      ? redactSensitiveObject(returnedRecords)
      : returnedRecords.map(summarizeQualityProfile)
  };
}

async function arrCustomFormats(serviceName, input = {}) {
  const records = await servarrRecords(serviceName, "customformat");
  const selected = resolveRecordByIdOrName(records, input, `${serviceName} custom format`);
  const returnedRecords = selected ? [selected] : records;
  return {
    service: serviceName,
    total: records.length,
    returned: returnedRecords.length,
    records: input.includeRaw
      ? redactSensitiveObject(returnedRecords)
      : returnedRecords.map(summarizeCustomFormat)
  };
}

async function arrQualityDefinitions(serviceName, input = {}) {
  const records = await servarrRecords(serviceName, "qualitydefinition");
  const selected = resolveQualityDefinition(records, input, `${serviceName} quality definition`);
  const returnedRecords = selected ? [selected] : records;
  return {
    service: serviceName,
    total: records.length,
    returned: returnedRecords.length,
    records: input.includeRaw
      ? redactSensitiveObject(returnedRecords)
      : returnedRecords.map(summarizeQualityDefinition)
  };
}

function parseQualityAllowedOps(patch) {
  const values = [
    patch.qualityAllowed,
    patch.qualityItemAllowed,
    patch.allowedQualities,
    patch.allowedQualityItems
  ].filter(value => value !== undefined);
  const ops = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      ops.push(...value);
    } else if (isPlainObject(value)) {
      for (const [selector, allowed] of Object.entries(value)) {
        ops.push({ selector, allowed });
      }
    } else {
      ops.push({ invalid: value });
    }
  }
  return ops;
}

function parseCustomFormatScoreOps(patch) {
  const values = [
    patch.customFormatScores,
    patch.formatScores,
    patch.customFormatScoreChanges,
    patch.formatItemScores
  ].filter(value => value !== undefined);
  const ops = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      ops.push(...value);
    } else if (isPlainObject(value)) {
      for (const [selector, score] of Object.entries(value)) {
        ops.push({ selector, score });
      }
    } else {
      ops.push({ invalid: value });
    }
  }
  return ops;
}

function numericSelector(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value);
  }
  return undefined;
}

function qualityAllowedMatches(profile, op) {
  const entries = arrQualityProfileItems(profile);
  const id = op.qualityId ?? op.id ?? numericSelector(op.selector);
  const groupName = op.groupName;
  const name = op.qualityName ?? op.name ?? (id === undefined ? op.selector : undefined);

  if (groupName) {
    return entries.filter(entry => entry.type === "group" && exactNameMatches(entry.name, groupName));
  }
  if (id !== undefined) {
    return entries.filter(entry => entry.id === id || entry.qualityId === id);
  }
  if (name) {
    return entries.filter(entry => exactNameMatches(entry.name, name));
  }
  return [];
}

function applyQualityAllowedOperation(profile, op, errors) {
  if (!isPlainObject(op)) {
    errors.push("quality allowed operation must be an object");
    return;
  }
  if (typeof op.allowed !== "boolean") {
    errors.push(`quality allowed operation ${JSON.stringify(op)} must include boolean allowed`);
    return;
  }
  const matches = qualityAllowedMatches(profile, op);
  if (!matches.length) {
    errors.push(`quality allowed operation ${JSON.stringify(op)} did not match any profile item`);
    return;
  }
  if (matches.length > 1) {
    errors.push(`quality allowed operation ${JSON.stringify(op)} matched multiple items: ${matches.map(match => match.name || match.id || match.qualityId).join(", ")}`);
    return;
  }
  matches[0].item.allowed = op.allowed;
  if (matches[0].type === "group" && op.includeItems === true && Array.isArray(matches[0].item.items)) {
    for (const child of matches[0].item.items) {
      child.allowed = op.allowed;
    }
  }
}

function resolveQualityCutoff(profile, cutoff, errors) {
  if (typeof cutoff === "number" && Number.isInteger(cutoff)) {
    return cutoff;
  }
  const op = isPlainObject(cutoff) ? cutoff : { selector: cutoff };
  const matches = qualityAllowedMatches(profile, op);
  if (!matches.length) {
    errors.push(`cutoff ${JSON.stringify(cutoff)} did not match any profile item`);
    return profile.cutoff;
  }
  if (matches.length > 1) {
    errors.push(`cutoff ${JSON.stringify(cutoff)} matched multiple items: ${matches.map(match => match.name || match.id || match.qualityId).join(", ")}`);
    return profile.cutoff;
  }
  const id = qualityProfileItemId(matches[0]);
  if (!Number.isInteger(id)) {
    errors.push(`cutoff ${JSON.stringify(cutoff)} matched an item without a numeric id`);
    return profile.cutoff;
  }
  return id;
}

function customFormatMatches(records, op) {
  const id = op.formatId ?? op.customFormatId ?? op.id ?? op.format ?? numericSelector(op.selector);
  const name = op.formatName ?? op.customFormatName ?? op.name ?? (id === undefined ? op.selector : undefined);
  if (id !== undefined) {
    return records.filter(record => record.id === id || formatItemId(record) === id);
  }
  if (name) {
    return records.filter(record => exactNameMatches(record.name ?? formatItemName(record), name));
  }
  return [];
}

function applyCustomFormatScoreOperation(profile, op, customFormats, errors) {
  if (!isPlainObject(op)) {
    errors.push("custom format score operation must be an object");
    return;
  }
  const score = op.score;
  if (!Number.isInteger(score)) {
    errors.push(`custom format score operation ${JSON.stringify(op)} must include integer score`);
    return;
  }
  if (!Array.isArray(profile.formatItems)) {
    profile.formatItems = [];
  }

  const existingMatches = customFormatMatches(profile.formatItems, op);
  if (existingMatches.length > 1) {
    errors.push(`custom format score operation ${JSON.stringify(op)} matched multiple profile format items`);
    return;
  }
  if (existingMatches.length === 1) {
    existingMatches[0].score = score;
    return;
  }

  const formatMatches = customFormatMatches(customFormats, op);
  if (!formatMatches.length) {
    errors.push(`custom format score operation ${JSON.stringify(op)} did not match an existing profile format item or custom format`);
    return;
  }
  if (formatMatches.length > 1) {
    errors.push(`custom format score operation ${JSON.stringify(op)} matched multiple custom formats: ${formatMatches.map(format => format.id).join(", ")}`);
    return;
  }
  profile.formatItems.push(compactObject({
    format: formatMatches[0].id,
    name: formatMatches[0].name,
    score
  }));
}

function validateQualityProfile(profile, original) {
  const errors = [];
  if (!isPlainObject(profile)) {
    return ["quality profile must be an object"];
  }
  if (!Number.isInteger(profile.id) || profile.id <= 0) {
    errors.push("quality profile id must be a positive integer");
  }
  if (original && profile.id !== original.id) {
    errors.push("quality profile id cannot be changed");
  }
  if (typeof profile.name !== "string" || !profile.name.trim()) {
    errors.push("quality profile name is required");
  }
  if (profile.upgradeAllowed !== undefined && typeof profile.upgradeAllowed !== "boolean") {
    errors.push("upgradeAllowed must be boolean when provided");
  }
  for (const key of ["cutoff", "minFormatScore", "cutoffFormatScore", "minUpgradeFormatScore"]) {
    if (profile[key] !== undefined && !Number.isInteger(profile[key])) {
      errors.push(`${key} must be an integer when provided`);
    }
  }
  const items = Array.isArray(profile.items)
    ? profile.items
    : Array.isArray(profile.qualities)
      ? profile.qualities
      : null;
  if (!items) {
    errors.push("quality profile must include an items array");
  } else {
    const entries = arrQualityProfileItems(profile);
    if (!entries.length) {
      errors.push("quality profile items array cannot be empty");
    }
    for (const entry of entries) {
      if (entry.item.allowed !== undefined && typeof entry.item.allowed !== "boolean") {
        errors.push(`${entry.path}.allowed must be boolean`);
      }
      if (entry.type === "quality" && !Number.isInteger(entry.qualityId)) {
        errors.push(`${entry.path} must include quality.id`);
      }
    }
  }
  if (profile.formatItems !== undefined) {
    if (!Array.isArray(profile.formatItems)) {
      errors.push("formatItems must be an array when provided");
    } else {
      for (const [index, item] of profile.formatItems.entries()) {
        if (!Number.isInteger(formatItemId(item))) {
          errors.push(`formatItems[${index}] must include a numeric format id`);
        }
        if (!Number.isInteger(item.score)) {
          errors.push(`formatItems[${index}].score must be an integer`);
        }
      }
    }
  }
  return errors;
}

function applyQualityProfilePatch(current, patch, customFormats) {
  const specialKeys = new Set([
    "qualityAllowed",
    "qualityItemAllowed",
    "allowedQualities",
    "allowedQualityItems",
    "customFormatScores",
    "formatScores",
    "customFormatScoreChanges",
    "formatItemScores",
    "cutoff"
  ]);
  const errors = [];
  let proposed = mergeObjectPatch(current, omitKeys(patch, specialKeys));
  if (Object.hasOwn(patch, "cutoff")) {
    proposed.cutoff = resolveQualityCutoff(proposed, patch.cutoff, errors);
  }
  for (const op of parseQualityAllowedOps(patch)) {
    applyQualityAllowedOperation(proposed, op, errors);
  }
  for (const op of parseCustomFormatScoreOps(patch)) {
    applyCustomFormatScoreOperation(proposed, op, customFormats, errors);
  }
  return { proposed, patchErrors: errors };
}

async function updateQualityProfile(serviceName, input) {
  const records = await servarrRecords(serviceName, "qualityprofile");
  const current = resolveRecordByIdOrName(records, input, `${serviceName} quality profile`);
  const scoreOps = parseCustomFormatScoreOps(input.patch);
  const customFormats = scoreOps.length ? await servarrRecords(serviceName, "customformat").catch(() => []) : [];
  const { proposed, patchErrors } = applyQualityProfilePatch(current, input.patch, customFormats);
  const validationErrors = [...patchErrors, ...validateQualityProfile(proposed, current)];
  const diff = compactDiff(current, proposed);
  const endpoint = arrEndpoint("PUT", `qualityprofile/${current.id}`);
  const response = {
    dryRun: input.dryRun,
    service: serviceName,
    endpoint,
    currentObject: redactSensitiveObject(current),
    proposedObject: redactSensitiveObject(proposed),
    diff,
    validationErrors
  };
  if (validationErrors.length) {
    return { ...response, applied: false, note: "Validation errors prevented the profile update." };
  }
  if (input.dryRun) {
    return { ...response, applied: false, note: `Set dryRun to false to PUT this full ${serviceName} quality profile.` };
  }
  if (!diff.length) {
    return { ...response, applied: false, note: "No changes detected; no API call was made." };
  }
  return {
    ...response,
    applied: true,
    result: redactSensitiveObject(await arrApi(serviceName, "v3", `qualityprofile/${current.id}`, { method: "PUT", body: proposed }))
  };
}

function validateCustomFormat(format, original) {
  const errors = [];
  if (!isPlainObject(format)) {
    return ["custom format must be an object"];
  }
  if (original && format.id !== original.id) {
    errors.push("custom format id cannot be changed");
  }
  if (format.id !== undefined && (!Number.isInteger(format.id) || format.id <= 0)) {
    errors.push("custom format id must be a positive integer when provided");
  }
  if (typeof format.name !== "string" || !format.name.trim()) {
    errors.push("custom format name is required");
  }
  if (format.specifications !== undefined) {
    if (!Array.isArray(format.specifications)) {
      errors.push("specifications must be an array when provided");
    } else {
      for (const [index, specification] of format.specifications.entries()) {
        if (!isPlainObject(specification)) {
          errors.push(`specifications[${index}] must be an object`);
        }
      }
    }
  }
  return errors;
}

function regexFieldsForSpecification(specification) {
  const kind = [
    specification?.implementation,
    specification?.implementationName,
    specification?.name
  ].filter(Boolean).join(" ").toLowerCase();
  if (!/title|regex|release/.test(kind)) {
    return [];
  }
  return (Array.isArray(specification.fields) ? specification.fields : [])
    .filter(field => typeof field?.value === "string" && field.value.trim())
    .map(field => ({
      specification: specification.name,
      implementation: specification.implementation,
      field: field.name,
      pattern: field.value,
      negate: specification.negate === true,
      required: specification.required === true
    }));
}

function compileRegexPattern(pattern) {
  let source = String(pattern);
  let flags = "i";
  source = source.replace(/^\(\?i\)/i, "");
  return new RegExp(source, flags);
}

function customFormatTitleTests(format, titles = []) {
  if (!titles.length) {
    return undefined;
  }
  const regexSpecs = (Array.isArray(format.specifications) ? format.specifications : [])
    .flatMap(regexFieldsForSpecification);
  return {
    regexSpecificationCount: regexSpecs.length,
    records: titles.map(title => {
      const specifications = regexSpecs.map(spec => {
        try {
          const regex = compileRegexPattern(spec.pattern);
          const regexMatched = regex.test(title);
          return {
            ...spec,
            regexMatched,
            effectiveMatch: spec.negate ? !regexMatched : regexMatched
          };
        } catch (error) {
          return {
            ...spec,
            regexMatched: false,
            effectiveMatch: false,
            error: error.message
          };
        }
      });
      const required = specifications.filter(spec => spec.required);
      const optional = specifications.filter(spec => !spec.required);
      return {
        title,
        matches: specifications.length > 0
          && required.every(spec => spec.effectiveMatch)
          && (optional.length ? optional.some(spec => spec.effectiveMatch) : true),
        specifications
      };
    })
  };
}

async function updateCustomFormat(serviceName, input) {
  const records = await servarrRecords(serviceName, "customformat");
  const selector = compactObject({
    id: input.id ?? input.definition?.id ?? input.patch?.id,
    name: input.name ?? input.definition?.name ?? input.patch?.name
  });
  let current = null;
  if (selector.id !== undefined || selector.name) {
    try {
      current = resolveRecordByIdOrName(records, selector, `${serviceName} custom format`);
    } catch (error) {
      if (!input.definition || !/was not found/.test(error.message)) {
        throw error;
      }
    }
  }
  const creating = !current;
  if (creating && !input.definition) {
    throw new Error(`custom format was not found; provide definition to create it`);
  }
  const base = current ? mergeObjectPatch(current, input.definition || {}) : cloneJson(input.definition);
  const proposed = mergeObjectPatch(base, input.patch || {});
  const validationErrors = validateCustomFormat(proposed, current);
  const apiPath = current ? `customformat/${current.id}` : "customformat";
  const endpoint = arrEndpoint(current ? "PUT" : "POST", apiPath);
  const diff = compactDiff(current || {}, proposed);
  const response = {
    dryRun: input.dryRun,
    service: serviceName,
    action: current ? "update" : "create",
    endpoint,
    currentObject: current ? redactSensitiveObject(current) : null,
    proposedObject: redactSensitiveObject(proposed),
    apiPayload: redactSensitiveObject(proposed),
    diff,
    validationErrors,
    titleTests: customFormatTitleTests(proposed, input.testTitles)
  };
  if (validationErrors.length) {
    return { ...response, applied: false, note: "Validation errors prevented the custom format update." };
  }
  if (input.dryRun) {
    return { ...response, applied: false, note: `Set dryRun to false to ${current ? "PUT" : "POST"} this ${serviceName} custom format.` };
  }
  if (current && !diff.length) {
    return { ...response, applied: false, note: "No changes detected; no API call was made." };
  }
  return {
    ...response,
    applied: true,
    result: redactSensitiveObject(await arrApi(serviceName, "v3", apiPath, { method: current ? "PUT" : "POST", body: proposed }))
  };
}

function validateQualityDefinition(definition, original) {
  const errors = [];
  if (!isPlainObject(definition)) {
    return ["quality definition must be an object"];
  }
  if (!Number.isInteger(definition.id) || definition.id <= 0) {
    errors.push("quality definition id must be a positive integer");
  }
  if (original && definition.id !== original.id) {
    errors.push("quality definition id cannot be changed");
  }
  for (const key of ["minSize", "maxSize", "preferredSize"]) {
    if (definition[key] !== undefined && (typeof definition[key] !== "number" || definition[key] < 0)) {
      errors.push(`${key} must be a non-negative number when provided`);
    }
  }
  if (typeof definition.minSize === "number" && typeof definition.maxSize === "number" && definition.minSize > definition.maxSize) {
    errors.push("minSize cannot be greater than maxSize");
  }
  if (typeof definition.preferredSize === "number") {
    if (typeof definition.minSize === "number" && definition.preferredSize < definition.minSize) {
      errors.push("preferredSize cannot be less than minSize");
    }
    if (typeof definition.maxSize === "number" && definition.preferredSize > definition.maxSize) {
      errors.push("preferredSize cannot be greater than maxSize");
    }
  }
  return errors;
}

async function updateQualityDefinition(serviceName, input) {
  const records = await servarrRecords(serviceName, "qualitydefinition");
  const current = resolveQualityDefinition(records, input, `${serviceName} quality definition`);
  const proposed = mergeObjectPatch(current, input.patch);
  const validationErrors = validateQualityDefinition(proposed, current);
  const endpointId = current.id ?? qualityDefinitionQualityId(current);
  const endpoint = arrEndpoint("PUT", `qualitydefinition/${endpointId}`);
  const diff = compactDiff(current, proposed);
  const response = {
    dryRun: input.dryRun,
    service: serviceName,
    endpoint,
    currentObject: redactSensitiveObject(current),
    proposedObject: redactSensitiveObject(proposed),
    diff,
    validationErrors
  };
  if (validationErrors.length) {
    return { ...response, applied: false, note: "Validation errors prevented the quality definition update." };
  }
  if (input.dryRun) {
    return { ...response, applied: false, note: `Set dryRun to false to PUT this full ${serviceName} quality definition.` };
  }
  if (!diff.length) {
    return { ...response, applied: false, note: "No changes detected; no API call was made." };
  }
  return {
    ...response,
    applied: true,
    result: redactSensitiveObject(await arrApi(serviceName, "v3", `qualitydefinition/${endpointId}`, { method: "PUT", body: proposed }))
  };
}

function summarizeArrReleaseCandidate(record) {
  const rejections = Array.isArray(record.rejections)
    ? record.rejections.map(rejection => typeof rejection === "string" ? rejection : compactObject({
      reason: rejection.reason,
      type: rejection.type
    }))
    : Array.isArray(record.rejectionReasons)
      ? record.rejectionReasons
      : [];
  return compactObject({
    guid: record.guid,
    indexerId: record.indexerId,
    indexer: record.indexer,
    title: record.title,
    sortTitle: record.sortTitle,
    protocol: record.protocol,
    size: record.size,
    age: record.age,
    ageHours: record.ageHours,
    seeders: record.seeders,
    leechers: record.leechers,
    quality: record.quality,
    languages: record.languages,
    customFormats: record.customFormats,
    customFormatScore: record.customFormatScore,
    indexerFlags: record.indexerFlags,
    releaseWeight: record.releaseWeight,
    downloadAllowed: record.downloadAllowed,
    rejected: record.rejected,
    rejections,
    grab: compactObject({
      guid: record.guid,
      indexerId: record.indexerId,
      title: record.title,
      indexer: record.indexer
    })
  });
}

async function arrInteractiveSearch(serviceName, query, limit) {
  const body = await arrApi(serviceName, "v3", "release", { query });
  const records = Array.isArray(body) ? body : [];
  return {
    service: serviceName,
    query,
    total: records.length,
    returned: Math.min(records.length, limit),
    records: records.slice(0, limit).map(summarizeArrReleaseCandidate),
    note: "Use the exact guid and indexerId from a candidate with the matching grab object when calling the grab tool. Full release objects are accepted when needed, but raw download URLs are not returned here."
  };
}

function buildArrReleasePayload(input) {
  const release = input.release && typeof input.release === "object" ? input.release : {};
  const payload = compactObject({
    ...release,
    guid: input.guid ?? release.guid,
    indexerId: input.indexerId ?? release.indexerId,
    title: input.title ?? release.title,
    indexer: input.indexer ?? release.indexer
  });
  if (!payload.guid || !payload.indexerId) {
    throw new Error("grab release requires an exact guid and indexerId, or a release object containing both");
  }
  return payload;
}

async function grabArrRelease(serviceName, input) {
  const payload = buildArrReleasePayload(input);
  if (input.dryRun) {
    return {
      dryRun: true,
      service: serviceName,
      release: summarizeArrReleaseCandidate(payload),
      note: `Set dryRun to false to ask ${serviceName} to grab this exact release.`
    };
  }
  const result = await arrApi(serviceName, "v3", "release", { method: "POST", body: payload });
  return {
    dryRun: false,
    service: serviceName,
    release: summarizeArrReleaseCandidate(payload),
    result: redactSensitiveObject(result)
  };
}

async function arrRecentLogs(serviceName, limit) {
  const body = await arrApi(serviceName, "v3", "log", {
    query: { page: 1, pageSize: limit, sortKey: "time", sortDirection: "descending" }
  });
  return arrRecordsPage(body, summarizeArrLogRecord, limit);
}

function queueProblemTags(record) {
  const tags = [];
  const text = [
    record.status,
    record.trackedDownloadStatus,
    record.trackedDownloadState,
    record.errorMessage
  ].filter(Boolean).join(" ").toLowerCase();
  if (/import/.test(text)) tags.push("import");
  if (/warning/.test(text)) tags.push("warning");
  if (/error|fail/.test(text)) tags.push("failed");
  if (/stalled|blocked|unavailable/.test(text)) tags.push("blocked");
  if (!tags.length) tags.push("unknown");
  return tags;
}

function importActionFromCandidate(serviceName, candidate, importMode = "move") {
  if (!candidate?.safeToImport || !candidate.path) {
    return null;
  }
  if (serviceName === "sonarr" && candidate.seriesId && candidate.episodeIds?.length) {
    return {
      type: "manual_import",
      importMode,
      file: compactObject({
        path: candidate.path,
        seriesId: candidate.seriesId,
        seasonNumber: candidate.seasonNumber,
        episodeIds: candidate.episodeIds,
        quality: candidate.quality,
        languages: candidate.languages,
        releaseGroup: candidate.releaseGroup,
        downloadId: candidate.downloadId,
        customFormats: candidate.customFormats,
        customFormatScore: candidate.customFormatScore,
        indexerFlags: candidate.indexerFlags,
        releaseType: candidate.releaseType
      })
    };
  }
  if (serviceName === "radarr" && candidate.movieId) {
    return {
      type: "manual_import",
      importMode,
      file: compactObject({
        path: candidate.path,
        movieId: candidate.movieId,
        quality: candidate.quality,
        languages: candidate.languages,
        releaseGroup: candidate.releaseGroup,
        downloadId: candidate.downloadId,
        customFormats: candidate.customFormats,
        customFormatScore: candidate.customFormatScore,
        indexerFlags: candidate.indexerFlags,
        releaseType: candidate.releaseType
      })
    };
  }
  return null;
}

function queueRepairActions(serviceName, queueRecord, candidates) {
  const actions = [
    {
      type: "remove_queue_item",
      removeFromClient: true,
      blocklist: false,
      reason: "Remove the exact queue item and optionally remove it from the download client."
    },
    {
      type: "remove_queue_item",
      removeFromClient: true,
      blocklist: true,
      reason: "Remove and blocklist the exact queue item when the release should not be retried."
    }
  ];
  const safeCandidates = (candidates?.records || []).filter(candidate => candidate.safeToImport);
  if (safeCandidates.length === 1) {
    const action = importActionFromCandidate(serviceName, safeCandidates[0]);
    if (action) {
      actions.unshift({ ...action, reason: "Exactly one safe manual import candidate was found." });
    }
  }
  const downloadId = queueRecord.downloadId;
  if (queueRecord.downloadClient?.toLowerCase().includes("qbittorrent") && downloadId) {
    actions.push({
      type: "qbittorrent_recheck",
      hashes: [downloadId],
      reason: "Ask qBittorrent to recheck the exact torrent hash from the queue record."
    });
    actions.push({
      type: "qbittorrent_reannounce",
      hashes: [downloadId],
      reason: "Ask qBittorrent to reannounce the exact torrent hash from the queue record."
    });
  }
  return actions;
}

async function diagnoseQueueItem(serviceName, queueId) {
  const records = await arrQueueDetails(serviceName);
  const queueRecord = records.find(record => record.id === queueId);
  if (!queueRecord) {
    throw new Error(`${serviceName} queue item ${queueId} was not found`);
  }
  const candidates = await arrManualImportCandidates(serviceName, { queueId, filterExistingFiles: true, limit: 25 }).catch(error => ({
    error: error.message,
    records: []
  }));
  return {
    service: serviceName,
    queueItem: summarizeQueueRecord(queueRecord),
    problemTags: queueProblemTags(queueRecord),
    manualImportCandidates: candidates,
    repairActions: queueRepairActions(serviceName, queueRecord, candidates)
  };
}

function validateRepairAction(action) {
  if (!action || typeof action !== "object" || typeof action.type !== "string") {
    throw new Error("each repair action must include a type");
  }
}

function comparableAction(value) {
  if (Array.isArray(value)) {
    return value.map(comparableAction);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "reason")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, comparableAction(entry)]));
  }
  return value;
}

function actionMatchesPlan(action, plannedActions) {
  const candidate = JSON.stringify(comparableAction(action));
  return plannedActions.some(planned => JSON.stringify(comparableAction(planned)) === candidate);
}

function exactSeerrFollowUpAction(action) {
  if (action.type === "seerr_add_comment") {
    return Number.isInteger(action.issueId) && action.issueId > 0 && typeof action.message === "string" && Boolean(action.message.trim());
  }
  if (action.type === "seerr_resolve_issue") {
    return Number.isInteger(action.issueId) && action.issueId > 0;
  }
  return false;
}

function uniqueExactHashes(hashes) {
  const uniqueHashes = [...new Set(hashes.map(hash => String(hash).trim()).filter(Boolean))];
  if (!uniqueHashes.length) {
    throw new Error("at least one exact torrent hash is required");
  }
  if (uniqueHashes.some(hash => hash.toLowerCase() === "all")) {
    throw new Error("the qBittorrent all selector is not allowed; provide exact torrent hashes");
  }
  return uniqueHashes;
}

async function qbitTorrentHashAction(kind, hashes, dryRun) {
  const uniqueHashes = uniqueExactHashes(hashes);
  if (dryRun) {
    return { dryRun: true, action: kind, hashes: uniqueHashes };
  }
  await qbitRequest(`torrents/${kind}`, {
    method: "POST",
    form: { hashes: uniqueHashes.join("|") }
  });
  return { dryRun: false, action: kind, hashes: uniqueHashes, ok: true };
}

async function applyQueueRepairPlan(serviceName, queueId, actions, dryRun) {
  const diagnosis = await diagnoseQueueItem(serviceName, queueId);
  for (const action of actions) {
    validateRepairAction(action);
    if (!actionMatchesPlan(action, diagnosis.repairActions) && !exactSeerrFollowUpAction(action)) {
      throw new Error(`repair action ${action.type} must exactly match a current repair plan action or an exact Seerr follow-up action`);
    }
  }
  if (dryRun) {
    return {
      dryRun: true,
      service: serviceName,
      queueId,
      diagnosis,
      wouldExecute: actions
    };
  }
  const results = [];
  for (const action of actions) {
    switch (action.type) {
      case "remove_queue_item":
        results.push(await removeArrQueueItems(serviceName, [queueId], {
          removeFromClient: action.removeFromClient ?? true,
          blocklist: action.blocklist ?? false,
          dryRun: false
        }));
        break;
      case "manual_import": {
        if (!action.file?.path) {
          throw new Error("manual_import action requires file.path");
        }
        const command = manualImportCommand([action.file], action.importMode || "move");
        results.push({
          type: action.type,
          service: serviceName,
          command: await arrApi(serviceName, "v3", "command", { method: "POST", body: command })
        });
        break;
      }
      case "qbittorrent_recheck":
        results.push(await qbitTorrentHashAction("recheck", action.hashes || [], false));
        break;
      case "qbittorrent_reannounce":
        results.push(await qbitTorrentHashAction("reannounce", action.hashes || [], false));
        break;
      case "seerr_add_comment":
        if (!action.issueId || !action.message) {
          throw new Error("seerr_add_comment action requires issueId and message");
        }
        results.push({
          type: action.type,
          issue: summarizeSeerrIssue(await seerrApi(`issue/${action.issueId}/comment`, { method: "POST", body: { message: action.message } }))
        });
        break;
      case "seerr_resolve_issue":
        if (!action.issueId) {
          throw new Error("seerr_resolve_issue action requires issueId");
        }
        results.push({
          type: action.type,
          issue: summarizeSeerrIssue(await seerrApi(`issue/${action.issueId}/resolved`, { method: "POST" }))
        });
        break;
      default:
        throw new Error(`unsupported repair action type: ${action.type}`);
    }
  }
  return {
    dryRun: false,
    service: serviceName,
    queueId,
    results
  };
}

function summarizeSeerrRequest(request, verbose = false) {
  const media = request.media ?? request.mediaInfo ?? {};
  return compactObject({
    id: request.id,
    status: request.status,
    mediaType: request.type ?? mediaType(media),
    mediaTitle: mediaTitle(media) ?? request.title,
    media: verbose
      ? compactObject({
        id: media.id,
        tmdbId: media.tmdbId,
        tvdbId: media.tvdbId,
        status: mediaStatusName(media.status),
        ratingKey: plexRatingKey(media)
      })
      : undefined,
    requestedBy: summarizeUser(request.requestedBy ?? request.createdBy ?? request.user, verbose),
    seasons: request.seasons,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt
  });
}

async function getSeerrRequest(requestId, verbose = false) {
  return summarizeSeerrRequest(await seerrApi(`request/${requestId}`), verbose);
}

async function requestTriage(requestId, verbose = false) {
  const request = await seerrApi(`request/${requestId}`);
  const mediaKind = request.type ?? mediaType(request.media ?? request.mediaInfo);
  const targetService = mediaKind === "tv" ? "sonarr" : mediaKind === "movie" ? "radarr" : undefined;
  return {
    request: summarizeSeerrRequest(request, verbose),
    targetService,
    targetServiceStatus: targetService
      ? await serviceResult(targetService, async () => ({
        health: await arrApi(targetService, "v3", "health"),
        queue: await arrQueueOverview(targetService)
      }))
      : { configured: false, note: "Request media type did not map to Sonarr or Radarr" },
    suggestedActions: [
      { type: "approve_request", requestId, action: "approve" },
      { type: "decline_request", requestId, action: "decline" }
    ]
  };
}

async function updateSeerrRequestStatus(requestId, action, dryRun, verbose = false) {
  if (dryRun) {
    return {
      dryRun: true,
      wouldUpdateRequest: { requestId, action },
      request: await getSeerrRequest(requestId, verbose)
    };
  }
  if (action === "delete") {
    await seerrApi(`request/${requestId}`, { method: "DELETE" });
    return { dryRun: false, deletedRequestId: requestId, deleted: true };
  }
  return {
    dryRun: false,
    request: summarizeSeerrRequest(await seerrApi(`request/${requestId}/${action}`, { method: "POST" }), verbose)
  };
}

async function commentAndResolveIssue(issueId, message, dryRun, verbose = false) {
  const id = seerrIssueId(issueId);
  if (dryRun) {
    return {
      dryRun: true,
      wouldAddComment: { issueId: id, message },
      wouldSetStatus: "resolved",
      issue: await getSeerrIssue(id, verbose)
    };
  }
  const commented = await seerrApi(`issue/${id}/comment`, { method: "POST", body: { message } });
  const resolved = await seerrApi(`issue/${id}/resolved`, { method: "POST" });
  return {
    dryRun: false,
    commentedIssue: summarizeSeerrIssue(commented, verbose),
    resolvedIssue: summarizeSeerrIssue(resolved, verbose)
  };
}

async function addPlexIssueComment(issueId, message, dryRun, verbose = false) {
  const id = String(issueId);
  if (dryRun) {
    return {
      dryRun: true,
      wouldAddComment: { issueId: id, message },
      issue: await getPlexIssue(id, verbose)
    };
  }
  const data = await plexCommunityGraphql(
    plexCreateReportCommentMutation,
    { input: { report: id, message } },
    "createReportComment"
  );
  return {
    dryRun: false,
    comment: summarizeIssueComment(data?.createReportComment, verbose),
    issue: await getPlexIssue(id, verbose)
  };
}

async function diagnoseIssue(source, issueId, verbose = false) {
  if (source === "seerr") {
    const id = seerrIssueId(issueId);
    const details = await plexIssueDetails({ source, issueId: id, verbose });
    return {
      ...details,
      suggestedActions: [
        { type: "seerr_add_comment", issueId: id, message: "Investigated and found a likely fix. Confirm before applying." },
        { type: "seerr_resolve_issue", issueId: id }
      ]
    };
  }
  if (source === "plex") {
    const id = String(issueId);
    const details = await plexIssueDetails({ source, issueId: id, verbose });
    return {
      ...details,
      suggestedActions: [
        { type: "plex_add_reported_issue_comment", issueId: id, message: "Investigated and found a likely cause. Confirm before applying." }
      ],
      limitations: [
        "Plex native reported issues do not expose resolved/closed/reopened state transitions in the discovered Plex Web community API."
      ]
    };
  }
  throw new Error(`issue source ${source} is not supported`);
}

async function prowlarrIndexerHealth(limit) {
  const [indexers, health, history] = await Promise.all([
    arrApi("prowlarr", "v1", "indexer"),
    arrApi("prowlarr", "v1", "health"),
    arrApi("prowlarr", "v1", "history", { query: { page: 1, pageSize: limit, sortKey: "date", sortDirection: "descending" } }).catch(error => ({ error: error.message }))
  ]);
  return {
    indexers: limitList(indexers, limit),
    health,
    history: history.error ? history : arrRecordsPage(history, record => compactObject({
      id: record.id,
      eventType: record.eventType,
      indexerId: record.indexerId,
      indexer: record.indexer,
      successful: record.successful,
      date: record.date
    }), limit)
  };
}

async function bazarrSubtitleOverview(limit) {
  const [wantedMovies, wantedEpisodes, movieHistory, episodeHistory, providers] = await Promise.all([
    bazarrApi("movies/wanted", { query: { start: 0, length: limit } }),
    bazarrApi("episodes/wanted", { query: { start: 0, length: limit } }),
    bazarrApi("movies/history", { query: { start: 0, length: limit } }),
    bazarrApi("episodes/history", { query: { start: 0, length: limit } }),
    bazarrApi("providers")
  ]);
  return {
    wantedMovies: limitList(wantedMovies, limit),
    wantedEpisodes: limitList(wantedEpisodes, limit),
    movieHistory: limitList(movieHistory, limit),
    episodeHistory: limitList(episodeHistory, limit),
    providers
  };
}

async function diagnosticsBundle(scope, limit) {
  const bundle = { scope, generatedAt: new Date().toISOString() };
  if (scope === "overview" || scope === "all") {
    bundle.overview = await mediaAdminOverview();
    bundle.tracearr = await serviceResult("tracearr", () => tracearrDiagnostics(limit));
    bundle.threadfin = await serviceResult("threadfin", threadfinOverview);
  }
  if (scope === "queues" || scope === "all") {
    bundle.queues = {
      sonarr: await serviceResult("sonarr", () => arrQueueOverview("sonarr")),
      radarr: await serviceResult("radarr", () => arrQueueOverview("radarr")),
      nzbget: await serviceResult("nzbget", nzbgetOverview),
      qbittorrent: await serviceResult("qbittorrent", qbittorrentOverview)
    };
  }
  if (scope === "requests" || scope === "all") {
    bundle.requests = await serviceResult("seerr", async () => {
      const body = await seerrApi("request", { query: { take: limit, skip: 0 } });
      const records = (Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : [])
        .slice(0, limit)
        .map(request => summarizeSeerrRequest(request, false));
      return {
        pageInfo: body?.pageInfo,
        total: body?.pageInfo?.results ?? records.length,
        returned: records.length,
        records
      };
    });
  }
  if (scope === "issues" || scope === "all") {
    if (configuredServices.seerr || configuredServices.plex) {
      try {
        bundle.issues = { configured: true, ...(await plexReportedIssues({ status: "open", source: "all", mediaType: "all", take: limit, skip: 0, verbose: false })) };
      } catch (error) {
        bundle.issues = { configured: true, error: error.message };
      }
    } else {
      bundle.issues = { configured: false };
    }
  }
  if (scope === "subtitles" || scope === "all") {
    bundle.subtitles = await serviceResult("bazarr", () => bazarrSubtitleOverview(limit));
  }
  if (scope === "indexers" || scope === "all") {
    bundle.indexers = await serviceResult("prowlarr", () => prowlarrIndexerHealth(limit));
  }
  return bundle;
}

async function serviceStatus(name) {
  try {
    switch (name) {
      case "sonarr":
        return { configured: true, status: await arrApi("sonarr", "v3", "system/status"), health: await arrApi("sonarr", "v3", "health") };
      case "radarr":
        return { configured: true, status: await arrApi("radarr", "v3", "system/status"), health: await arrApi("radarr", "v3", "health") };
      case "plex":
        return { configured: true, status: await plexApi(), sessions: await plexApi("status/sessions") };
      case "bazarr":
        return { configured: true, status: await bazarrApi("system/status") };
      case "prowlarr":
        return { configured: true, status: await arrApi("prowlarr", "v1", "system/status"), health: await arrApi("prowlarr", "v1", "health") };
      case "qbittorrent":
        return { configured: true, version: await qbitRequest("app/version"), transfer: await qbitRequest("transfer/info") };
      case "nzbget":
        return { configured: true, status: await nzbgetRpc("status") };
      case "seerr":
        return { configured: true, status: await seerrApi("status") };
      case "tautulli":
        return { configured: true, status: await tautulliApi("server_status") };
      case "tracearr":
        return { configured: true, health: await tracearrApi("health") };
      case "threadfin":
        return { configured: true, status: await threadfinStatus(false) };
      default:
        return { configured: false };
    }
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

function registerServarrConfigTools(server, serviceName, displayName) {
  server.registerTool(`${serviceName}_quality_profiles`, {
    title: `${displayName} Quality Profiles`,
    description: `List or get ${displayName} quality profiles by id or exact name. Set includeRaw for the full Servarr profile object, including nested qualities, cutoff, upgradeAllowed, formatItems, and format score thresholds.`,
    inputSchema: {
      id: z.number().int().positive().optional(),
      name: z.string().min(1).optional(),
      includeRaw: z.boolean().default(false)
    }
  }, async (input) => jsonText(await arrQualityProfiles(serviceName, input)));

  server.registerTool(`${serviceName}_update_quality_profile`, {
    title: `${displayName} Update Quality Profile`,
    description: `Patch a ${displayName} quality profile by id or exact name. Dry-run is enabled by default and returns current object, proposed object, compact diff, validation errors, and the PUT endpoint. Use qualityAllowed or allowedQualities for quality/group allowed changes, and customFormatScores or formatScores for custom format scoring by id or exact name.`,
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      id: z.number().int().positive().optional(),
      name: z.string().min(1).optional(),
      patch: z.object({}).catchall(z.any()),
      dryRun: z.boolean().default(true)
    }
  }, async (input) => jsonText(await updateQualityProfile(serviceName, input)));

  server.registerTool(`${serviceName}_custom_formats`, {
    title: `${displayName} Custom Formats`,
    description: `List or get ${displayName} custom formats by id or exact name. Set includeRaw for the full Servarr custom format object.`,
    inputSchema: {
      id: z.number().int().positive().optional(),
      name: z.string().min(1).optional(),
      includeRaw: z.boolean().default(false)
    }
  }, async (input) => jsonText(await arrCustomFormats(serviceName, input)));

  server.registerTool(`${serviceName}_update_custom_format`, {
    title: `${displayName} Update Custom Format`,
    description: `Create or update a ${displayName} custom format. Dry-run is enabled by default and returns current object, proposed object, compact diff, API payload, validation errors, and regex title test results when testTitles is provided.`,
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      id: z.number().int().positive().optional(),
      name: z.string().min(1).optional(),
      definition: z.object({}).catchall(z.any()).optional(),
      patch: z.object({}).catchall(z.any()).optional(),
      testTitles: z.array(z.string().min(1)).optional(),
      dryRun: z.boolean().default(true)
    }
  }, async (input) => jsonText(await updateCustomFormat(serviceName, input)));

  server.registerTool(`${serviceName}_quality_definitions`, {
    title: `${displayName} Quality Definitions`,
    description: `List or get ${displayName} quality definitions by qualityId or exact qualityName. Set includeRaw for the full Servarr quality definition object.`,
    inputSchema: {
      qualityId: z.number().int().positive().optional(),
      qualityName: z.string().min(1).optional(),
      includeRaw: z.boolean().default(false)
    }
  }, async (input) => jsonText(await arrQualityDefinitions(serviceName, input)));

  server.registerTool(`${serviceName}_update_quality_definition`, {
    title: `${displayName} Update Quality Definition`,
    description: `Patch ${displayName} quality size settings by qualityId or exact qualityName. Dry-run is enabled by default and returns current object, proposed object, compact diff, validation errors, and the PUT endpoint.`,
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      qualityId: z.number().int().positive().optional(),
      qualityName: z.string().min(1).optional(),
      patch: z.object({}).catchall(z.any()),
      dryRun: z.boolean().default(true)
    }
  }, async (input) => jsonText(await updateQualityDefinition(serviceName, input)));
}

function registerThreadfinTools(server) {
  const sourceTypeSchema = z.enum(["m3u", "hdhr", "xmltv"]);
  const sourceTypeAllSchema = z.enum(["all", "m3u", "hdhr", "xmltv"]).default("all");
  const includeSensitiveSchema = z.boolean().default(false);
  const confirmSchema = z.boolean().default(false);
  const stringTermsSchema = z.union([z.string(), z.array(z.string())]).optional();
  const stringOrNumberArraySchema = z.array(z.union([z.string(), z.number()])).optional();
  const mappingFieldsSchema = z.object({
    "x-active": z.boolean().optional(),
    "x-category": z.string().optional(),
    "x-channelID": z.union([z.string(), z.number()]).optional(),
    "x-name": z.string().optional(),
    "x-group-title": z.string().optional(),
    "x-mapping": z.string().optional(),
    "x-xmltv-file": z.string().optional(),
    "x-hide-channel": z.boolean().optional()
  }).catchall(z.any());

  server.registerTool("threadfin_status", {
    title: "Threadfin Status",
    description: "Get Threadfin status, client counts, exported URLs, and API availability.",
    inputSchema: {
      includeSensitive: includeSensitiveSchema
    }
  }, async ({ includeSensitive }) => jsonText(await threadfinStatus(includeSensitive)));

  server.registerTool("threadfin_get_config", {
    title: "Threadfin Get Config",
    description: "Get Threadfin's websocket configuration snapshot with a structured summary. Sensitive fields are redacted by default.",
    inputSchema: {
      includeSensitive: includeSensitiveSchema
    }
  }, async ({ includeSensitive }) => jsonText(await threadfinConfigSnapshot(includeSensitive)));

  server.registerTool("threadfin_list_sources", {
    title: "Threadfin List Sources",
    description: "List Threadfin M3U, HDHomeRun, and XMLTV source definitions.",
    inputSchema: {
      type: sourceTypeAllSchema,
      term: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(100),
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinListSources(input)));

  server.registerTool("threadfin_list_source_groups", {
    title: "Threadfin List Source Groups",
    description: "Fetch and parse a configured Threadfin M3U source, returning group-title counts and optional sanitized channel summaries.",
    inputSchema: {
      playlistId: z.string().min(1).optional(),
      playlist_id: z.string().min(1).optional(),
      search: z.string().min(1).optional(),
      includeChannels: z.boolean().default(false),
      channelsPerGroup: z.number().int().min(1).max(100).default(10),
      limit: z.number().int().min(1).max(500).default(100)
    }
  }, async (input) => jsonText(await threadfinListSourceGroups(input)));

  server.registerTool("threadfin_find_source_channels", {
    title: "Threadfin Find Source Channels",
    description: "Fetch and parse a configured Threadfin M3U source, then return sanitized channel records matching group, search terms, or include tokens.",
    inputSchema: {
      playlistId: z.string().min(1).optional(),
      playlist_id: z.string().min(1).optional(),
      group: z.string().min(1).optional(),
      groupTitle: z.string().min(1).optional(),
      group_title: z.string().min(1).optional(),
      includeTokens: stringTermsSchema,
      include_tokens: stringTermsSchema,
      search: stringTermsSchema,
      limit: z.number().int().min(1).max(1000).default(100)
    }
  }, async (input) => jsonText(await threadfinFindSourceChannels(input)));

  server.registerTool("threadfin_save_source", {
    title: "Threadfin Save Source",
    description: "Create, update, or delete one Threadfin M3U, HDHomeRun, or XMLTV source. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: sourceTypeSchema,
      id: z.string().min(1).optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      fileSource: z.string().optional(),
      buffer: z.enum(["-", "ffmpeg", "vlc"]).optional(),
      tuner: z.number().int().min(1).max(100).optional(),
      httpProxyIp: z.string().optional(),
      httpProxyPort: z.string().optional(),
      httpHeadersOrigin: z.string().optional(),
      httpHeadersReferer: z.string().optional(),
      patch: z.object({}).catchall(z.any()).optional(),
      delete: z.boolean().default(false),
      dryRun: z.boolean().default(true),
      confirm: confirmSchema,
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinSaveSource(input)));

  server.registerTool("threadfin_refresh_source", {
    title: "Threadfin Refresh Source",
    description: "Refresh one exact Threadfin source by ID through the websocket UI path, or refresh all sources of a type through the Threadfin API. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: sourceTypeSchema,
      id: z.string().min(1).optional(),
      dryRun: z.boolean().default(true),
      confirm: confirmSchema,
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinRefreshSource(input)));

  server.registerTool("threadfin_update_m3u", {
    title: "Threadfin Update M3U",
    description: "Run Threadfin's updateFileM3U websocket command using the existing playlist configuration fields. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      playlistId: z.string().min(1).optional(),
      playlist_id: z.string().min(1).optional(),
      dryRun: z.boolean().default(true),
      confirm: confirmSchema,
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinUpdateM3u(input)));

  server.registerTool("threadfin_update_settings", {
    title: "Threadfin Update Settings",
    description: "Patch Threadfin settings using the same websocket command as the web UI. Dry-run returns current/proposed objects and compact diff.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      patch: z.object({}).catchall(z.any()),
      dryRun: z.boolean().default(true),
      confirm: confirmSchema,
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinUpdateSettings(input)));

  server.registerTool("threadfin_save_filter", {
    title: "Threadfin Save Filter",
    description: "Create, update, or delete one Threadfin filter. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      id: z.union([z.string().min(1), z.number().int()]).optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      type: z.enum(["custom-filter", "group-title"]).optional(),
      filter: z.string().optional(),
      include: z.string().optional(),
      exclude: z.string().optional(),
      startingNumber: z.string().optional(),
      "x-category": z.string().optional(),
      active: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      liveEvent: z.boolean().optional(),
      patch: z.object({}).catchall(z.any()).optional(),
      delete: z.boolean().default(false),
      dryRun: z.boolean().default(true),
      confirm: confirmSchema,
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinSaveFilter(input)));

  server.registerTool("threadfin_save_group_filter", {
    title: "Threadfin Save Group Filter",
    description: "Create or update a Threadfin group-title filter with a before/after summary. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      id: z.union([z.string().min(1), z.number().int()]).optional(),
      filterId: z.union([z.string().min(1), z.number().int()]).optional(),
      filter_id: z.union([z.string().min(1), z.number().int()]).optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      groupTitle: z.string().optional(),
      group_title: z.string().optional(),
      filter: z.string().optional(),
      include: z.string().optional(),
      exclude: z.string().optional(),
      startingNumber: z.union([z.string(), z.number()]).optional(),
      "x-category": z.string().optional(),
      xCategory: z.string().optional(),
      x_category: z.string().optional(),
      active: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      liveEvent: z.boolean().optional(),
      patch: z.object({}).catchall(z.any()).optional(),
      dryRun: z.boolean().default(true),
      confirm: confirmSchema,
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinSaveGroupFilter(input)));

  server.registerTool("threadfin_list_channels", {
    title: "Threadfin List Channels",
    description: "List Threadfin channel mappings from XEPG.",
    inputSchema: {
      term: z.string().min(1).optional(),
      playlistId: z.string().min(1).optional(),
      xmltvFile: z.string().min(1).optional(),
      includeInactive: z.boolean().default(true),
      limit: z.number().int().min(1).max(1000).default(100),
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinListChannels(input)));

  server.registerTool("threadfin_get_channel", {
    title: "Threadfin Get Channel",
    description: "Get one exact Threadfin channel mapping by ID.",
    inputSchema: {
      id: z.string().min(1),
      includeSensitive: includeSensitiveSchema
    }
  }, async ({ id, includeSensitive }) => jsonText(await threadfinGetChannel(id, includeSensitive)));

  server.registerTool("threadfin_update_channels", {
    title: "Threadfin Update Channels",
    description: "Patch one or more exact Threadfin channel mappings and save XEPG mapping. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      channels: z.array(z.object({
        id: z.string().min(1),
        patch: z.object({}).catchall(z.any())
      })).min(1),
      dryRun: z.boolean().default(true),
      confirm: confirmSchema,
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinUpdateChannels(input)));

  server.registerTool("threadfin_set_mapping_fields", {
    title: "Threadfin Set Mapping Fields",
    description: "Select Threadfin XEPG mappings by key, channel number, group, playlist, XMLTV file, or search tokens, then patch supported fields. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      mappingKeys: z.array(z.string().min(1)).optional(),
      mapping_keys: z.array(z.string().min(1)).optional(),
      channelNumbers: stringOrNumberArraySchema,
      channel_numbers: stringOrNumberArraySchema,
      playlistId: z.string().min(1).optional(),
      playlist_id: z.string().min(1).optional(),
      xmltvFile: z.string().min(1).optional(),
      xmltv_file: z.string().min(1).optional(),
      groupTitle: z.string().min(1).optional(),
      group_title: z.string().min(1).optional(),
      searchTokens: stringTermsSchema,
      search_tokens: stringTermsSchema,
      search: stringTermsSchema,
      updates: mappingFieldsSchema.optional(),
      fields: mappingFieldsSchema.optional(),
      "x-active": z.boolean().optional(),
      "x-category": z.string().optional(),
      xCategory: z.string().optional(),
      x_category: z.string().optional(),
      "x-channelID": z.union([z.string(), z.number()]).optional(),
      xChannelID: z.union([z.string(), z.number()]).optional(),
      x_channel_id: z.union([z.string(), z.number()]).optional(),
      "x-name": z.string().optional(),
      xName: z.string().optional(),
      x_name: z.string().optional(),
      "x-group-title": z.string().optional(),
      xGroupTitle: z.string().optional(),
      x_group_title: z.string().optional(),
      "x-mapping": z.string().optional(),
      xMapping: z.string().optional(),
      x_mapping: z.string().optional(),
      "x-xmltv-file": z.string().optional(),
      xXmltvFile: z.string().optional(),
      x_xmltv_file: z.string().optional(),
      "x-hide-channel": z.boolean().optional(),
      channelNumberStart: z.union([z.string(), z.number()]).optional(),
      channel_number_start: z.union([z.string(), z.number()]).optional(),
      dryRun: z.boolean().default(true),
      confirm: confirmSchema,
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinSetMappingFields(input)));

  server.registerTool("threadfin_list_xmltv_channels", {
    title: "Threadfin List XMLTV Channels",
    description: "List XMLTV guide channels visible to Threadfin mapping.",
    inputSchema: {
      file: z.string().min(1).optional(),
      term: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      includeRaw: z.boolean().default(false),
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinListXmltvChannels(input)));

  server.registerTool("threadfin_find_xmltv_channels", {
    title: "Threadfin Find XMLTV Channels",
    description: "Fetch and parse a configured Threadfin XMLTV source, returning exact and candidate guide channel matches.",
    inputSchema: {
      xmltvId: z.string().min(1).optional(),
      xmltv_id: z.string().min(1).optional(),
      searchTokens: stringTermsSchema,
      search_tokens: stringTermsSchema,
      search: stringTermsSchema,
      limit: z.number().int().min(1).max(1000).default(100)
    }
  }, async (input) => jsonText(await threadfinFindXmltvChannels(input)));

  server.registerTool("threadfin_save_user", {
    title: "Threadfin Save User",
    description: "Create, update, or delete a Threadfin user and permission flags. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      id: z.string().min(1).optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      confirm: z.string().optional(),
      "authentication.web": z.boolean().optional(),
      "authentication.pms": z.boolean().optional(),
      "authentication.m3u": z.boolean().optional(),
      "authentication.xml": z.boolean().optional(),
      "authentication.api": z.boolean().optional(),
      userData: z.object({}).catchall(z.any()).optional(),
      delete: z.boolean().default(false),
      dryRun: z.boolean().default(true),
      confirm: confirmSchema,
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinSaveUser(input)));

  server.registerTool("threadfin_logs", {
    title: "Threadfin Logs",
    description: "Return Threadfin in-memory web UI logs with secret-like values redacted.",
    inputSchema: {
      limit: z.number().int().min(1).max(1000).default(200)
    }
  }, async (input) => jsonText(await threadfinLogs(input)));

  server.registerTool("threadfin_reset_logs", {
    title: "Threadfin Reset Logs",
    description: "Reset Threadfin in-memory web UI logs. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      dryRun: z.boolean().default(true),
      confirm: confirmSchema
    }
  }, async ({ dryRun, confirm }) => {
    if (dryRun) {
      return jsonText({ dryRun: true, command: "resetLogs" });
    }
    requireThreadfinConfirm({ confirm }, "Threadfin log reset");
    return jsonText({ dryRun: false, command: "resetLogs", response: await threadfinWs("resetLogs") });
  });

  server.registerTool("threadfin_backup_config", {
    title: "Threadfin Backup Config",
    description: "Ask Threadfin to create a configuration backup and return the generated download link. Dry-run is enabled by default.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      dryRun: z.boolean().default(true),
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinBackupConfig(input)));

  server.registerTool("threadfin_restore_config", {
    title: "Threadfin Restore Config",
    description: "Restore a Threadfin backup from a base64 payload through the Threadfin web UI command. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      base64: z.string().min(1),
      dryRun: z.boolean().default(true),
      confirm: confirmSchema,
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinRestoreConfig(input)));

  server.registerTool("threadfin_set_ppv", {
    title: "Threadfin Set PPV",
    description: "Enable or disable Threadfin PPV mapped channels. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      enabled: z.boolean(),
      dryRun: z.boolean().default(true),
      confirm: confirmSchema
    }
  }, async (input) => jsonText(await threadfinSetPpv(input)));

  server.registerTool("threadfin_export_output", {
    title: "Threadfin Export Output",
    description: "Return Threadfin output URLs or optionally sample exported M3U, XMLTV, lineup, or discovery content.",
    inputSchema: {
      kind: z.enum(["urls", "m3u", "xmltv", "lineup", "discover"]).default("urls"),
      includeContent: z.boolean().default(false),
      maxChars: z.number().int().min(1).max(100000).default(10000),
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinExportOutput(input)));

  server.registerTool("threadfin_verify_output", {
    title: "Threadfin Verify Output",
    description: "Check Threadfin public lineup, M3U, and HDHomeRun discovery outputs and return counts plus sanitized expected-channel matches.",
    inputSchema: {
      expectedChannelNames: stringTermsSchema,
      expected_channel_names: stringTermsSchema,
      expectedChannelNumbers: stringTermsSchema,
      expected_channel_numbers: stringTermsSchema,
      expectedTokens: stringTermsSchema,
      expected_tokens: stringTermsSchema,
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinVerifyOutput(input)));

  server.registerTool("threadfin_raw_websocket_command", {
    title: "Threadfin Raw Websocket Command",
    description: "Expert escape hatch for Threadfin websocket UI commands. Execution requires dryRun=false and confirmUnsafe=true.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      cmd: z.string().min(1),
      payload: z.object({}).catchall(z.any()).optional(),
      dryRun: z.boolean().default(true),
      confirmUnsafe: z.boolean().default(false),
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinRawWebsocketCommand(input)));

  server.registerTool("threadfin_raw_api_command", {
    title: "Threadfin Raw API Command",
    description: "Expert escape hatch for Threadfin /api/ commands. Execution requires dryRun=false and confirmUnsafe=true.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      cmd: z.string().min(1),
      payload: z.object({}).catchall(z.any()).optional(),
      dryRun: z.boolean().default(true),
      confirmUnsafe: z.boolean().default(false),
      includeSensitive: includeSensitiveSchema
    }
  }, async (input) => jsonText(await threadfinRawApiCommand(input)));
}

function createServer() {
  const server = new McpServer({
    name: "unraid-codex-media-mcp",
    version: "0.1.0"
  });

  server.registerTool("media_services_status", {
    title: "Media Services Status",
    description: "Check configured Sonarr, Radarr, Plex, Bazarr, Prowlarr, qBittorrent, NZBGet, Seerr-family, Tautulli, Tracearr, and Threadfin services."
  }, async () => {
    const entries = await Promise.all(Object.entries(configuredServices).map(async ([name, config]) => {
      if (!config) {
        return [name, { configured: false }];
      }
      return [name, await serviceStatus(name)];
    }));
    return jsonText(Object.fromEntries(entries));
  });

  server.registerTool("media_archive_environment_check", {
    title: "Media Archive Environment Check",
    description: "Verify archive extraction binaries and optional downloads write access inside media-mcp.",
    inputSchema: {
      downloadsPath: z.string().min(1).default("/mnt/unraid/downloads"),
      writeTest: z.boolean().default(true)
    }
  }, async (input) => jsonText(await archiveEnvironmentCheck(input)));

  server.registerTool("media_admin_overview", {
    title: "Media Admin Overview",
    description: "Return compact actionable counts for queues, download clients, Plex streams, and Seerr issues/requests."
  }, async () => jsonText(await mediaAdminOverview()));

  server.registerTool("media_diagnostics_bundle", {
    title: "Media Diagnostics Bundle",
    description: "Collect a concise diagnosis bundle across queues, requests, issues, subtitles, and indexers.",
    inputSchema: {
      scope: z.enum(["overview", "queues", "requests", "issues", "subtitles", "indexers", "all"]).default("overview"),
      limit: z.number().int().min(1).max(100).default(25)
    }
  }, async ({ scope, limit }) => jsonText(await diagnosticsBundle(scope, limit)));

  server.registerTool("media_diagnose_queue_item", {
    title: "Media Diagnose Queue Item",
    description: "Diagnose one exact Sonarr or Radarr queue item and return safe candidate repair actions.",
    inputSchema: {
      service: z.enum(["sonarr", "radarr"]),
      queueId: z.number().int().positive()
    }
  }, async ({ service, queueId }) => jsonText(await diagnoseQueueItem(service, queueId)));

  server.registerTool("media_queue_repair_plan", {
    title: "Media Queue Repair Plan",
    description: "Return exact possible repair actions for one Sonarr or Radarr queue item.",
    inputSchema: {
      service: z.enum(["sonarr", "radarr"]),
      queueId: z.number().int().positive()
    }
  }, async ({ service, queueId }) => jsonText(await diagnoseQueueItem(service, queueId)));

  server.registerTool("media_apply_queue_repair_plan", {
    title: "Media Apply Queue Repair Plan",
    description: "Execute exact repair actions from media_queue_repair_plan. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      service: z.enum(["sonarr", "radarr"]),
      queueId: z.number().int().positive(),
      actions: z.array(z.object({
        type: z.string().min(1)
      }).passthrough()).min(1),
      dryRun: z.boolean().default(true)
    }
  }, async ({ service, queueId, actions, dryRun }) => jsonText(await applyQueueRepairPlan(service, queueId, actions, dryRun)));

  server.registerTool("media_diagnose_issue", {
    title: "Media Diagnose Issue",
    description: "Diagnose one normalized Seerr-family or Plex-native user-reported issue with optional Plex, Tautulli, and Tracearr context.",
    inputSchema: {
      source: z.enum(["seerr", "plex"]).default("seerr"),
      issueId: z.union([z.number().int().positive(), z.string().min(1)]),
      verbose: z.boolean().default(false)
    }
  }, async ({ source, issueId, verbose }) => jsonText(await diagnoseIssue(source, issueId, verbose)));

  server.registerTool("media_request_triage", {
    title: "Media Request Triage",
    description: "Summarize one Seerr-family request and the matching Sonarr or Radarr operational context.",
    inputSchema: {
      requestId: z.number().int().positive(),
      verbose: z.boolean().default(false)
    }
  }, async ({ requestId, verbose }) => jsonText(await requestTriage(requestId, verbose)));

  registerThreadfinTools(server);

  server.registerTool("plex_status", {
    title: "Plex Status",
    description: "Get Plex server status and active session summary."
  }, async () => jsonText({
    status: await plexApi(),
    sessions: await plexApi("status/sessions")
  }));

  server.registerTool("plex_list_libraries", {
    title: "Plex List Libraries",
    description: "List Plex library sections."
  }, async () => jsonText(await plexApi("library/sections")));

  server.registerTool("plex_list_library_items", {
    title: "Plex List Library Items",
    description: "List items in a Plex library section.",
    inputSchema: {
      sectionKey: z.string().min(1),
      type: z.string().optional(),
      limit: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ sectionKey, type, limit }) => {
    const body = await plexApi(`library/sections/${encodeURIComponent(sectionKey)}/all`, { query: { type } });
    return jsonText(limitPlexContainer(body, limit));
  });

  server.registerTool("plex_search", {
    title: "Plex Search",
    description: "Search Plex libraries.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ query, limit }) => jsonText(limitPlexContainer(await plexApi("hubs/search", { query: { query } }), limit)));

  server.registerTool("plex_get_metadata", {
    title: "Plex Get Metadata",
    description: "Get Plex metadata for a rating key.",
    inputSchema: {
      ratingKey: z.string().min(1)
    }
  }, async ({ ratingKey }) => jsonText(await plexApi(`library/metadata/${encodeURIComponent(ratingKey)}`)));

  server.registerTool("plex_refresh_metadata", {
    title: "Plex Refresh Metadata",
    description: "Refresh Plex metadata for one exact rating key. Dry-run is enabled by default.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      ratingKey: z.union([z.string(), z.number()]),
      dryRun: z.boolean().default(true)
    }
  }, async ({ ratingKey, dryRun }) => jsonText(await plexMetadataMaintenance(ratingKey, "refresh", dryRun)));

  server.registerTool("plex_analyze_metadata", {
    title: "Plex Analyze Metadata",
    description: "Analyze Plex media for one exact rating key. Dry-run is enabled by default.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      ratingKey: z.union([z.string(), z.number()]),
      dryRun: z.boolean().default(true)
    }
  }, async ({ ratingKey, dryRun }) => jsonText(await plexMetadataMaintenance(ratingKey, "analyze", dryRun)));

  server.registerTool("plex_verify_subtitle_track", {
    title: "Plex Verify Subtitle Track",
    description: "Verify that Plex metadata for one exact rating key exposes a subtitle track for the requested language.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      ratingKey: z.union([z.string(), z.number()]),
      language: z.string().min(1)
    }
  }, async (input) => jsonText(await verifyPlexSubtitleTrack(input)));

  server.registerTool("plex_active_sessions", {
    title: "Plex Active Sessions",
    description: "List active Plex playback sessions."
  }, async () => jsonText(await plexApi("status/sessions")));

  server.registerTool("plex_reported_issues", {
    title: "Plex Reported Issues",
    description: "List normalized user-reported Plex/media issues from configured issue sources.",
    inputSchema: {
      status: z.enum(["open", "resolved", "all"]).default("open"),
      source: z.enum(["all", "seerr", "plex"]).default("all"),
      take: z.number().int().min(1).max(100).default(50),
      skip: z.number().int().min(0).default(0),
      verbose: z.boolean().default(false)
    }
  }, async (input) => jsonText(await plexReportedIssues({ ...input, mediaType: "all" })));

  server.registerTool("plex_recent_user_reports", {
    title: "Plex Recent User Reports",
    description: "List recent normalized user issue reports across configured issue sources.",
    inputSchema: {
      take: z.number().int().min(1).max(100).default(50),
      skip: z.number().int().min(0).default(0),
      verbose: z.boolean().default(false)
    }
  }, async (input) => jsonText(await plexReportedIssues({
    ...input,
    status: "all",
    source: "all",
    mediaType: "all",
    sort: "modified"
  })));

  server.registerTool("plex_issue_details", {
    title: "Plex Issue Details",
    description: "Get normalized issue details and optional Tautulli/Tracearr playback context for a reported Plex/media issue.",
    inputSchema: {
      source: z.enum(["seerr", "plex"]).default("seerr"),
      issueId: z.union([z.number().int().positive(), z.string().min(1)]),
      verbose: z.boolean().default(false)
    }
  }, async (input) => jsonText(await plexIssueDetails(input)));

  server.registerTool("plex_add_reported_issue_comment", {
    title: "Plex Add Reported Issue Comment",
    description: "Reply/comment on an exact Plex-native reported issue ID. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      issueId: z.union([z.number().int().positive(), z.string().min(1)]),
      message: z.string().min(1),
      dryRun: z.boolean().default(true),
      verbose: z.boolean().default(false)
    }
  }, async ({ issueId, message, dryRun, verbose }) => jsonText(await addPlexIssueComment(issueId, message, dryRun, verbose)));

  server.registerTool("tautulli_activity", {
    title: "Tautulli Activity",
    description: "Summarize current Tautulli/Plex activity when Tautulli is configured.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(25)
    }
  }, async ({ limit }) => jsonText(summarizeTautulliActivity(await tautulliApi("get_activity"), limit)));

  server.registerTool("tautulli_history", {
    title: "Tautulli History",
    description: "Summarize recent Tautulli playback history when Tautulli is configured.",
    inputSchema: {
      start: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(100).default(25),
      search: z.string().optional()
    }
  }, async ({ start, length, search }) => jsonText(summarizeTautulliHistory(await tautulliApi("get_history", {
    query: { start, length, search }
  }), length)));

  server.registerTool("tracearr_health", {
    title: "Tracearr Health",
    description: "Get Tracearr public API health and configured media server connectivity."
  }, async () => jsonText(await tracearrApi("health")));

  server.registerTool("tracearr_openapi", {
    title: "Tracearr OpenAPI",
    description: "Get Tracearr's public OpenAPI document."
  }, async () => jsonText(await tracearrApi("docs")));

  server.registerTool("tracearr_stats", {
    title: "Tracearr Stats",
    description: "Get Tracearr dashboard statistics with optional media server filtering.",
    inputSchema: {
      serverId: z.string().uuid().optional()
    }
  }, async ({ serverId }) => jsonText(await tracearrApi("stats", { query: { serverId } })));

  server.registerTool("tracearr_stats_today", {
    title: "Tracearr Stats Today",
    description: "Get Tracearr dashboard metrics for today in the requested timezone.",
    inputSchema: {
      serverId: z.string().uuid().optional(),
      timezone: z.string().min(1).max(100).default("UTC")
    }
  }, async ({ serverId, timezone }) => jsonText(await tracearrApi("stats/today", { query: { serverId, timezone } })));

  server.registerTool("tracearr_activity", {
    title: "Tracearr Activity",
    description: "Get Tracearr playback activity trends and breakdowns.",
    inputSchema: {
      period: z.enum(["week", "month", "year"]).default("month"),
      serverId: z.string().uuid().optional(),
      timezone: z.string().min(1).max(100).default("UTC")
    }
  }, async ({ period, serverId, timezone }) => jsonText(await tracearrApi("activity", { query: { period, serverId, timezone } })));

  server.registerTool("tracearr_active_streams", {
    title: "Tracearr Active Streams",
    description: "List Tracearr active streams with codec and transcode details, or request summary-only output.",
    inputSchema: {
      serverId: z.string().uuid().optional(),
      summary: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(50)
    }
  }, async ({ serverId, summary, limit }) => {
    const body = await tracearrApi("streams", { query: { serverId, summary } });
    return jsonText(summary ? body : summarizeTracearrStreams(body, limit));
  });

  server.registerTool("tracearr_users", {
    title: "Tracearr Users",
    description: "List Tracearr users with activity metrics and trust scores.",
    inputSchema: {
      serverId: z.string().uuid().optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25)
    }
  }, async ({ serverId, page, pageSize }) => {
    return jsonText(summarizeTracearrUsers(await tracearrApi("users", { query: { serverId, page, pageSize } }), pageSize));
  });

  server.registerTool("tracearr_violations", {
    title: "Tracearr Violations",
    description: "List Tracearr rule violations with optional server, severity, and acknowledged filters.",
    inputSchema: {
      serverId: z.string().uuid().optional(),
      severity: z.enum(["low", "warning", "high"]).optional(),
      acknowledged: z.boolean().optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25)
    }
  }, async ({ serverId, severity, acknowledged, page, pageSize }) => {
    return jsonText(summarizeTracearrViolations(await tracearrApi("violations", {
      query: { serverId, severity, acknowledged, page, pageSize }
    }), pageSize));
  });

  server.registerTool("tracearr_history", {
    title: "Tracearr History",
    description: "List Tracearr playback history grouped by unique plays.",
    inputSchema: {
      serverId: z.string().uuid().optional(),
      state: z.enum(["playing", "paused", "stopped"]).optional(),
      mediaType: z.enum(["movie", "episode", "track", "live", "photo", "unknown"]).optional(),
      startDate: z.string().min(1).optional(),
      endDate: z.string().min(1).optional(),
      timezone: z.string().min(1).max(100).default("UTC"),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25)
    }
  }, async ({ serverId, state, mediaType, startDate, endDate, timezone, page, pageSize }) => {
    return jsonText(summarizeTracearrHistory(await tracearrApi("history", {
      query: { serverId, state, mediaType, startDate, endDate, timezone, page, pageSize }
    }), pageSize));
  });

  server.registerTool("bazarr_status", {
    title: "Bazarr Status",
    description: "Get Bazarr system status."
  }, async () => jsonText(await bazarrApi("system/status")));

  server.registerTool("bazarr_download_movie_subtitles_for_plex", {
    title: "Bazarr Download Movie Subtitles For Plex",
    description: "Resolve one Plex movie rating key to one exact Radarr movie and ask Bazarr to download subtitles. Dry-run is enabled by default.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      plexRatingKey: z.union([z.string(), z.number()]),
      language: z.string().min(1),
      title: z.string().optional(),
      year: z.number().int().positive().optional(),
      forced: z.boolean().default(false),
      hi: z.boolean().default(false),
      dryRun: z.boolean().default(true)
    }
  }, async (input) => jsonText(await downloadBazarrMovieSubtitlesForPlex(input)));

  server.registerTool("bazarr_wanted_movies", {
    title: "Bazarr Wanted Movies",
    description: "List Bazarr wanted movie subtitles.",
    inputSchema: {
      start: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ start, length }) => jsonText(limitList(await bazarrApi("movies/wanted", { query: { start, length } }), length)));

  server.registerTool("bazarr_wanted_episodes", {
    title: "Bazarr Wanted Episodes",
    description: "List Bazarr wanted episode subtitles.",
    inputSchema: {
      start: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ start, length }) => jsonText(limitList(await bazarrApi("episodes/wanted", { query: { start, length } }), length)));

  server.registerTool("bazarr_providers", {
    title: "Bazarr Providers",
    description: "List Bazarr subtitle providers."
  }, async () => jsonText(await bazarrApi("providers")));

  server.registerTool("bazarr_movies_history", {
    title: "Bazarr Movies History",
    description: "List recent Bazarr movie subtitle history.",
    inputSchema: {
      start: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ start, length }) => jsonText(limitList(await bazarrApi("movies/history", { query: { start, length } }), length)));

  server.registerTool("bazarr_episodes_history", {
    title: "Bazarr Episodes History",
    description: "List recent Bazarr episode subtitle history.",
    inputSchema: {
      start: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ start, length }) => jsonText(limitList(await bazarrApi("episodes/history", { query: { start, length } }), length)));

  server.registerTool("bazarr_subtitle_overview", {
    title: "Bazarr Subtitle Overview",
    description: "Summarize wanted subtitles, recent subtitle history, and provider configuration.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(25)
    }
  }, async ({ limit }) => jsonText(await bazarrSubtitleOverview(limit)));

  registerServarrConfigTools(server, "sonarr", "Sonarr");
  registerServarrConfigTools(server, "radarr", "Radarr");

  server.registerTool("sonarr_list_series", {
    title: "Sonarr List Series",
    description: "List Sonarr series, optionally filtering by a title substring.",
    inputSchema: {
      term: z.string().optional(),
      limit: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ term, limit }) => {
    let records = await arrApi("sonarr", "v3", "series");
    if (term) {
      const lowered = term.toLowerCase();
      records = records.filter(item => item.title?.toLowerCase().includes(lowered));
    }
    return jsonText(limitList(records, limit));
  });

  server.registerTool("sonarr_lookup_series", {
    title: "Sonarr Lookup Series",
    description: "Search Sonarr's metadata providers for a TV series before adding it.",
    inputSchema: {
      term: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10)
    }
  }, async ({ term, limit }) => {
    return jsonText(limitList(await arrApi("sonarr", "v3", "series/lookup", { query: { term } }), limit));
  });

  server.registerTool("sonarr_add_series", {
    title: "Sonarr Add Series",
    description: "Add a series to Sonarr. Use sonarr_lookup_series and Sonarr profiles/root folders first.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      tvdbId: z.number().int().positive(),
      title: z.string().min(1),
      titleSlug: z.string().min(1),
      qualityProfileId: z.number().int().positive(),
      rootFolderPath: z.string().min(1),
      monitored: z.boolean().default(true),
      seasonFolder: z.boolean().default(true),
      seasons: z.array(z.any()).optional(),
      searchForMissingEpisodes: z.boolean().default(false)
    }
  }, async (input) => {
    const body = {
      tvdbId: input.tvdbId,
      title: input.title,
      titleSlug: input.titleSlug,
      qualityProfileId: input.qualityProfileId,
      rootFolderPath: input.rootFolderPath,
      monitored: input.monitored,
      seasonFolder: input.seasonFolder,
      seasons: input.seasons,
      addOptions: { searchForMissingEpisodes: input.searchForMissingEpisodes }
    };
    return jsonText(await arrApi("sonarr", "v3", "series", { method: "POST", body }));
  });

  server.registerTool("sonarr_queue", {
    title: "Sonarr Queue",
    description: "List current Sonarr queue records.",
    inputSchema: { limit: z.number().int().min(1).max(250).default(50) }
  }, async ({ limit }) => {
    return jsonText(summarizeQueueList(await arrApi("sonarr", "v3", "queue", { query: { page: 1, pageSize: limit } }), limit));
  });

  server.registerTool("sonarr_remove_queue_items", {
    title: "Sonarr Remove Queue Items",
    description: "Remove exact Sonarr queue item IDs. Dry-run is enabled by default and reports the matched records before deletion.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      ids: z.array(z.number().int().positive()).min(1),
      removeFromClient: z.boolean().default(true),
      blocklist: z.boolean().default(false),
      dryRun: z.boolean().default(true)
    }
  }, async (input) => {
    return jsonText(await removeArrQueueItems("sonarr", input.ids, input));
  });

  server.registerTool("sonarr_manual_import_candidates", {
    title: "Sonarr Manual Import Candidates",
    description: "Find Sonarr manual import candidates for an exact queue item ID or path, excluding library-file rows that are outside the queue/download folder.",
    inputSchema: {
      queueId: z.number().int().positive().optional(),
      path: z.string().min(1).optional(),
      downloadId: z.string().min(1).optional(),
      seriesId: z.number().int().positive().optional(),
      filterExistingFiles: z.boolean().default(true),
      limit: z.number().int().min(1).max(250).default(50)
    }
  }, async (input) => {
    if (!input.queueId && !input.path) {
      throw new Error("queueId or path is required");
    }
    return jsonText(await sonarrManualImportCandidates(input));
  });

  server.registerTool("sonarr_queue_item_files", {
    title: "Sonarr Queue Item Files",
    description: "Inspect files under one Sonarr queue item's outputPath from Sonarr's container/API point of view, plus filtered manual import context.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      queueId: z.number().int().positive(),
      limit: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ queueId, limit }) => jsonText(await arrQueueItemFiles("sonarr", queueId, limit)));

  server.registerTool("sonarr_import_queue_item", {
    title: "Sonarr Import Queue Item",
    description: "Discover safe manual import candidates for one Sonarr queue item and queue ManualImport for the safe rows. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      queueId: z.number().int().positive(),
      importMode: z.string().min(1).default("move"),
      dryRun: z.boolean().default(true)
    }
  }, async ({ queueId, importMode, dryRun }) => jsonText(await importArrQueueItem("sonarr", queueId, importMode, dryRun)));

  server.registerTool("sonarr_manual_import", {
    title: "Sonarr Manual Import",
    description: "Import exact Sonarr manual import candidate files. Dry-run is enabled by default and returns the command that would be queued.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      files: z.array(z.object({
        id: z.number().int().positive().optional(),
        path: z.string().min(1),
        seriesId: z.number().int().positive(),
        seasonNumber: z.number().int().min(0).optional(),
        episodeIds: z.array(z.number().int().positive()).min(1),
        quality: z.any().optional(),
        languages: z.array(z.any()).optional(),
        releaseGroup: z.string().optional(),
        downloadId: z.string().optional(),
        customFormats: z.array(z.any()).optional(),
        customFormatScore: z.number().int().optional(),
        indexerFlags: z.number().int().optional(),
        releaseType: z.string().optional()
      })).min(1),
      importMode: z.string().min(1).default("move"),
      dryRun: z.boolean().default(true)
    }
  }, async ({ files, importMode, dryRun }) => {
    const command = manualImportCommand(files, importMode);
    const warnings = manualImportWarnings("sonarr", files);
    if (dryRun) {
      return jsonText({
        dryRun: true,
        service: "sonarr",
        command,
        warnings,
        note: "Set dryRun to false to queue this Sonarr ManualImport command."
      });
    }
    const queued = await arrApi("sonarr", "v3", "command", { method: "POST", body: command });
    return jsonText({
      dryRun: false,
      service: "sonarr",
      warnings,
      commandId: queued?.id,
      command: queued
    });
  });

  server.registerTool("sonarr_profiles", {
    title: "Sonarr Profiles",
    description: "List Sonarr quality profiles and root folders."
  }, async () => {
    return jsonText({
      qualityProfiles: await arrApi("sonarr", "v3", "qualityprofile"),
      rootFolders: await arrApi("sonarr", "v3", "rootfolder")
    });
  });

  server.registerTool("sonarr_wanted_missing", {
    title: "Sonarr Wanted Missing",
    description: "List Sonarr wanted missing episode records with safe page/pageSize or offset/limit pagination.",
    inputSchema: arrWantedPaginationSchema
  }, async (input) => jsonText(await arrWanted("sonarr", "missing", input)));

  server.registerTool("sonarr_wanted_missing_ids", {
    title: "Sonarr Wanted Missing IDs",
    description: "Page through Sonarr wanted missing episodes and return exact episode IDs plus compact metadata without queueing searches.",
    annotations: { readOnlyHint: true },
    inputSchema: sonarrWantedMissingIdsSchema
  }, async (input) => jsonText(await sonarrWantedMissingIds(input)));

  server.registerTool("sonarr_cutoff_unmet", {
    title: "Sonarr Cutoff Unmet",
    description: "List Sonarr cutoff-unmet episode records.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) }
  }, async ({ limit }) => jsonText(await arrWanted("sonarr", "cutoff", limit)));

  server.registerTool("sonarr_recent_history", {
    title: "Sonarr Recent History",
    description: "List recent Sonarr history records with secret-like fields removed.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) }
  }, async ({ limit }) => jsonText(await arrRecentHistory("sonarr", limit)));

  server.registerTool("sonarr_blocklist", {
    title: "Sonarr Blocklist",
    description: "List recent Sonarr blocklist records.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) }
  }, async ({ limit }) => jsonText(await arrBlocklist("sonarr", limit)));

  server.registerTool("sonarr_command_status", {
    title: "Sonarr Command Status",
    description: "List Sonarr command status records, one exact command ID, or a compact summary keyed by multiple command IDs.",
    inputSchema: {
      commandId: z.number().int().positive().optional(),
      commandIds: z.array(z.number().int().positive()).min(1).max(100).optional()
    }
  }, async (input) => jsonText(await arrCommandStatus("sonarr", input)));

  server.registerTool("sonarr_search_missing", {
    title: "Sonarr Search Missing",
    description: "Queue Sonarr MissingEpisodeSearch for all missing monitored episodes. This can enqueue many indexer searches and may grab releases depending on Sonarr settings.",
    annotations: { destructiveHint: false, idempotentHint: false }
  }, async () => jsonText(await queueArrCommand("sonarr", arrCommand("MissingEpisodeSearch"))));

  server.registerTool("sonarr_search_cutoff_unmet", {
    title: "Sonarr Search Cutoff Unmet",
    description: "Queue Sonarr CutoffUnmetEpisodeSearch for all cutoff-unmet monitored episodes. This can enqueue many indexer searches and may grab releases depending on Sonarr settings.",
    annotations: { destructiveHint: false, idempotentHint: false }
  }, async () => jsonText(await queueArrCommand("sonarr", arrCommand("CutoffUnmetEpisodeSearch"))));

  server.registerTool("sonarr_search_episode", {
    title: "Sonarr Search Episode",
    description: "Queue Sonarr EpisodeSearch for exact episode IDs only.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      episodeIds: z.array(z.number().int().positive()).min(1)
    }
  }, async ({ episodeIds }) => jsonText(await queueArrCommand("sonarr", arrCommand("EpisodeSearch", { episodeIds }))));

  server.registerTool("sonarr_search_missing_exact", {
    title: "Sonarr Search Missing Exact",
    description: "Collect wanted missing Sonarr episode IDs with safeguards, then dry-run or queue exact EpisodeSearch commands in batches. Never calls MissingEpisodeSearch.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: sonarrSearchMissingExactSchema
  }, async (input) => jsonText(await arrSearchMissingExact("sonarr", input)));

  server.registerTool("sonarr_search_series", {
    title: "Sonarr Search Series",
    description: "Queue Sonarr SeriesSearch for one exact series ID.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      seriesId: z.number().int().positive()
    }
  }, async ({ seriesId }) => jsonText(await queueArrCommand("sonarr", arrCommand("SeriesSearch", { seriesId }))));

  server.registerTool("sonarr_search_season", {
    title: "Sonarr Search Season",
    description: "Queue Sonarr SeasonSearch for one exact series ID and season number.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      seriesId: z.number().int().positive(),
      seasonNumber: z.number().int().min(0)
    }
  }, async ({ seriesId, seasonNumber }) => jsonText(await queueArrCommand("sonarr", arrCommand("SeasonSearch", { seriesId, seasonNumber }))));

  server.registerTool("sonarr_rescan_series", {
    title: "Sonarr Rescan Series",
    description: "Queue Sonarr RescanSeries globally or for one exact series ID.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      seriesId: z.number().int().positive().optional()
    }
  }, async ({ seriesId }) => jsonText(await queueArrCommand("sonarr", arrCommand("RescanSeries", { seriesId }))));

  server.registerTool("sonarr_refresh_series", {
    title: "Sonarr Refresh Series",
    description: "Queue Sonarr RefreshSeries globally or for one exact series ID.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      seriesId: z.number().int().positive().optional()
    }
  }, async ({ seriesId }) => jsonText(await queueArrCommand("sonarr", arrCommand("RefreshSeries", { seriesId }))));

  server.registerTool("sonarr_rename_files", {
    title: "Sonarr Rename Files",
    description: "Queue Sonarr RenameFiles for one exact series ID and optional exact episode file IDs. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      seriesId: z.number().int().positive(),
      files: z.array(z.number().int().positive()).min(1).optional(),
      dryRun: z.boolean().default(true)
    }
  }, async ({ seriesId, files, dryRun }) => {
    return jsonText(await arrCommandAction("sonarr", arrCommand("RenameFiles", { seriesId, files }), dryRun));
  });

  server.registerTool("sonarr_interactive_search_episode", {
    title: "Sonarr Interactive Search Episode",
    description: "List Sonarr release candidates for one exact episode ID without grabbing a release.",
    annotations: { destructiveHint: false, readOnlyHint: true },
    inputSchema: {
      episodeId: z.number().int().positive(),
      limit: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ episodeId, limit }) => jsonText(await arrInteractiveSearch("sonarr", { episodeId }, limit)));

  server.registerTool("sonarr_grab_release", {
    title: "Sonarr Grab Release",
    description: "Ask Sonarr to grab one exact release from interactive search. Dry-run is enabled by default; provide guid and indexerId or a full exact release object.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      guid: z.string().min(1).optional(),
      indexerId: z.number().int().positive().optional(),
      title: z.string().min(1).optional(),
      indexer: z.string().min(1).optional(),
      release: z.object({}).catchall(z.any()).optional(),
      dryRun: z.boolean().default(true)
    }
  }, async (input) => jsonText(await grabArrRelease("sonarr", input)));

  server.registerTool("sonarr_download_client_scan", {
    title: "Sonarr Download Client Scan",
    description: "Queue Sonarr DownloadedEpisodesScan globally or for an exact path/downloadClientId. Dry-run is enabled by default because scans can import files.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      path: z.string().min(1).optional(),
      downloadClientId: z.string().min(1).optional(),
      importMode: z.string().min(1).optional(),
      dryRun: z.boolean().default(true)
    }
  }, async ({ path, downloadClientId, importMode, dryRun }) => {
    return jsonText(await arrCommandAction("sonarr", arrCommand("DownloadedEpisodesScan", { path, downloadClientId, importMode }), dryRun));
  });

  server.registerTool("sonarr_command_cancel", {
    title: "Sonarr Command Cancel",
    description: "Cancel one exact Sonarr command ID if the Sonarr API accepts cancellation. Dry-run is enabled by default.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      commandId: z.number().int().positive(),
      dryRun: z.boolean().default(true)
    }
  }, async ({ commandId, dryRun }) => jsonText(await cancelArrCommand("sonarr", commandId, dryRun)));

  server.registerTool("sonarr_recent_logs", {
    title: "Sonarr Recent Logs",
    description: "List recent Sonarr logs with token-like values redacted.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) }
  }, async ({ limit }) => jsonText(await arrRecentLogs("sonarr", limit)));

  server.registerTool("radarr_list_movies", {
    title: "Radarr List Movies",
    description: "List Radarr movies, optionally filtering by title substring.",
    inputSchema: {
      term: z.string().optional(),
      limit: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ term, limit }) => {
    let records = await arrApi("radarr", "v3", "movie");
    if (term) {
      const lowered = term.toLowerCase();
      records = records.filter(item => item.title?.toLowerCase().includes(lowered));
    }
    return jsonText(limitList(records, limit));
  });

  server.registerTool("radarr_lookup_movie", {
    title: "Radarr Lookup Movie",
    description: "Search Radarr's metadata providers for a movie before adding it.",
    inputSchema: {
      term: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10)
    }
  }, async ({ term, limit }) => {
    return jsonText(limitList(await arrApi("radarr", "v3", "movie/lookup", { query: { term } }), limit));
  });

  server.registerTool("radarr_add_movie", {
    title: "Radarr Add Movie",
    description: "Add a movie to Radarr. Use radarr_lookup_movie and Radarr profiles/root folders first.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      tmdbId: z.number().int().positive(),
      title: z.string().min(1),
      titleSlug: z.string().min(1),
      year: z.number().int().positive().optional(),
      qualityProfileId: z.number().int().positive(),
      rootFolderPath: z.string().min(1),
      monitored: z.boolean().default(true),
      images: z.array(z.any()).optional(),
      searchForMovie: z.boolean().default(false)
    }
  }, async (input) => {
    const body = {
      tmdbId: input.tmdbId,
      title: input.title,
      titleSlug: input.titleSlug,
      year: input.year,
      qualityProfileId: input.qualityProfileId,
      rootFolderPath: input.rootFolderPath,
      monitored: input.monitored,
      images: input.images,
      addOptions: { searchForMovie: input.searchForMovie }
    };
    return jsonText(await arrApi("radarr", "v3", "movie", { method: "POST", body }));
  });

  server.registerTool("radarr_queue", {
    title: "Radarr Queue",
    description: "List current Radarr queue records.",
    inputSchema: { limit: z.number().int().min(1).max(250).default(50) }
  }, async ({ limit }) => {
    return jsonText(summarizeQueueList(await arrApi("radarr", "v3", "queue", { query: { page: 1, pageSize: limit } }), limit));
  });

  server.registerTool("radarr_remove_queue_items", {
    title: "Radarr Remove Queue Items",
    description: "Remove exact Radarr queue item IDs. Dry-run is enabled by default and reports the matched records before deletion.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      ids: z.array(z.number().int().positive()).min(1),
      removeFromClient: z.boolean().default(true),
      blocklist: z.boolean().default(false),
      dryRun: z.boolean().default(true)
    }
  }, async (input) => {
    return jsonText(await removeArrQueueItems("radarr", input.ids, input));
  });

  server.registerTool("radarr_manual_import_candidates", {
    title: "Radarr Manual Import Candidates",
    description: "Find Radarr manual import candidates for an exact queue item ID or path, excluding library-file rows that are outside the queue/download folder.",
    inputSchema: {
      queueId: z.number().int().positive().optional(),
      path: z.string().min(1).optional(),
      downloadId: z.string().min(1).optional(),
      movieId: z.number().int().positive().optional(),
      filterExistingFiles: z.boolean().default(true),
      limit: z.number().int().min(1).max(250).default(50)
    }
  }, async (input) => {
    if (!input.queueId && !input.path) {
      throw new Error("queueId or path is required");
    }
    return jsonText(await radarrManualImportCandidates(input));
  });

  server.registerTool("radarr_queue_item_files", {
    title: "Radarr Queue Item Files",
    description: "Inspect files under one Radarr queue item's outputPath from Radarr's container/API point of view, plus filtered manual import context.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      queueId: z.number().int().positive(),
      limit: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ queueId, limit }) => jsonText(await arrQueueItemFiles("radarr", queueId, limit)));

  server.registerTool("radarr_import_queue_item", {
    title: "Radarr Import Queue Item",
    description: "Discover safe manual import candidates for one Radarr queue item and queue ManualImport for the safe rows. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      queueId: z.number().int().positive(),
      importMode: z.string().min(1).default("move"),
      dryRun: z.boolean().default(true)
    }
  }, async ({ queueId, importMode, dryRun }) => jsonText(await importArrQueueItem("radarr", queueId, importMode, dryRun)));

  server.registerTool("radarr_manual_import", {
    title: "Radarr Manual Import",
    description: "Import exact Radarr manual import candidate files. Dry-run is enabled by default and returns the command that would be queued.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      files: z.array(z.object({
        id: z.number().int().positive().optional(),
        path: z.string().min(1),
        movieId: z.number().int().positive(),
        quality: z.any().optional(),
        languages: z.array(z.any()).optional(),
        releaseGroup: z.string().optional(),
        downloadId: z.string().optional(),
        customFormats: z.array(z.any()).optional(),
        customFormatScore: z.number().int().optional(),
        indexerFlags: z.number().int().optional(),
        releaseType: z.string().optional()
      })).min(1),
      importMode: z.string().min(1).default("move"),
      dryRun: z.boolean().default(true)
    }
  }, async ({ files, importMode, dryRun }) => {
    const command = manualImportCommand(files, importMode);
    const warnings = manualImportWarnings("radarr", files);
    if (dryRun) {
      return jsonText({
        dryRun: true,
        service: "radarr",
        command,
        warnings,
        note: "Set dryRun to false to queue this Radarr ManualImport command."
      });
    }
    const queued = await arrApi("radarr", "v3", "command", { method: "POST", body: command });
    return jsonText({
      dryRun: false,
      service: "radarr",
      warnings,
      commandId: queued?.id,
      command: queued
    });
  });

  server.registerTool("radarr_profiles", {
    title: "Radarr Profiles",
    description: "List Radarr quality profiles and root folders."
  }, async () => {
    return jsonText({
      qualityProfiles: await arrApi("radarr", "v3", "qualityprofile"),
      rootFolders: await arrApi("radarr", "v3", "rootfolder")
    });
  });

  server.registerTool("radarr_wanted_missing", {
    title: "Radarr Wanted Missing",
    description: "List Radarr wanted missing movie records with safe page/pageSize or offset/limit pagination.",
    inputSchema: arrWantedPaginationSchema
  }, async (input) => jsonText(await arrWanted("radarr", "missing", input)));

  server.registerTool("radarr_wanted_missing_ids", {
    title: "Radarr Wanted Missing IDs",
    description: "Page through Radarr wanted missing movies and return exact movie IDs plus compact metadata without queueing searches.",
    annotations: { readOnlyHint: true },
    inputSchema: radarrWantedMissingIdsSchema
  }, async (input) => jsonText(await radarrWantedMissingIds(input)));

  server.registerTool("radarr_cutoff_unmet", {
    title: "Radarr Cutoff Unmet",
    description: "List Radarr cutoff-unmet movie records.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) }
  }, async ({ limit }) => jsonText(await arrWanted("radarr", "cutoff", limit)));

  server.registerTool("radarr_recent_history", {
    title: "Radarr Recent History",
    description: "List recent Radarr history records with secret-like fields removed.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) }
  }, async ({ limit }) => jsonText(await arrRecentHistory("radarr", limit)));

  server.registerTool("radarr_blocklist", {
    title: "Radarr Blocklist",
    description: "List recent Radarr blocklist records.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) }
  }, async ({ limit }) => jsonText(await arrBlocklist("radarr", limit)));

  server.registerTool("radarr_command_status", {
    title: "Radarr Command Status",
    description: "List Radarr command status records, one exact command ID, or a compact summary keyed by multiple command IDs.",
    inputSchema: {
      commandId: z.number().int().positive().optional(),
      commandIds: z.array(z.number().int().positive()).min(1).max(100).optional()
    }
  }, async (input) => jsonText(await arrCommandStatus("radarr", input)));

  server.registerTool("radarr_search_missing", {
    title: "Radarr Search Missing",
    description: "Queue Radarr MissingMoviesSearch for all missing monitored movies. This can enqueue many indexer searches and may grab releases depending on Radarr settings.",
    annotations: { destructiveHint: false, idempotentHint: false }
  }, async () => jsonText(await queueArrCommand("radarr", arrCommand("MissingMoviesSearch"))));

  server.registerTool("radarr_search_cutoff_unmet", {
    title: "Radarr Search Cutoff Unmet",
    description: "Queue Radarr CutoffUnmetMoviesSearch for all cutoff-unmet monitored movies. This can enqueue many indexer searches and may grab releases depending on Radarr settings.",
    annotations: { destructiveHint: false, idempotentHint: false }
  }, async () => jsonText(await queueArrCommand("radarr", arrCommand("CutoffUnmetMoviesSearch"))));

  server.registerTool("radarr_search_movie", {
    title: "Radarr Search Movie",
    description: "Queue Radarr MoviesSearch for exact movie IDs only.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      movieIds: z.array(z.number().int().positive()).min(1)
    }
  }, async ({ movieIds }) => jsonText(await queueArrCommand("radarr", arrCommand("MoviesSearch", { movieIds }))));

  server.registerTool("radarr_search_missing_exact", {
    title: "Radarr Search Missing Exact",
    description: "Collect wanted missing Radarr movie IDs with safeguards, then dry-run or queue exact MoviesSearch commands in batches. Never calls MissingMoviesSearch.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: radarrSearchMissingExactSchema
  }, async (input) => jsonText(await arrSearchMissingExact("radarr", input)));

  server.registerTool("radarr_rescan_movie", {
    title: "Radarr Rescan Movie",
    description: "Queue Radarr RescanMovie globally or for one exact movie ID.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      movieId: z.number().int().positive().optional()
    }
  }, async ({ movieId }) => jsonText(await queueArrCommand("radarr", arrCommand("RescanMovie", { movieId }))));

  server.registerTool("radarr_refresh_movie", {
    title: "Radarr Refresh Movie",
    description: "Queue Radarr RefreshMovie globally or for one exact movie ID.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      movieId: z.number().int().positive().optional()
    }
  }, async ({ movieId }) => jsonText(await queueArrCommand("radarr", arrCommand("RefreshMovie", { movieId }))));

  server.registerTool("radarr_rename_files", {
    title: "Radarr Rename Files",
    description: "Queue Radarr RenameFiles for one exact movie ID and optional exact movie file IDs. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      movieId: z.number().int().positive(),
      files: z.array(z.number().int().positive()).min(1).optional(),
      dryRun: z.boolean().default(true)
    }
  }, async ({ movieId, files, dryRun }) => {
    return jsonText(await arrCommandAction("radarr", arrCommand("RenameFiles", { movieId, files }), dryRun));
  });

  server.registerTool("radarr_interactive_search_movie", {
    title: "Radarr Interactive Search Movie",
    description: "List Radarr release candidates for one exact movie ID without grabbing a release.",
    annotations: { destructiveHint: false, readOnlyHint: true },
    inputSchema: {
      movieId: z.number().int().positive(),
      limit: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ movieId, limit }) => jsonText(await arrInteractiveSearch("radarr", { movieId }, limit)));

  server.registerTool("radarr_grab_release", {
    title: "Radarr Grab Release",
    description: "Ask Radarr to grab one exact release from interactive search. Dry-run is enabled by default; provide guid and indexerId or a full exact release object.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      guid: z.string().min(1).optional(),
      indexerId: z.number().int().positive().optional(),
      title: z.string().min(1).optional(),
      indexer: z.string().min(1).optional(),
      release: z.object({}).catchall(z.any()).optional(),
      dryRun: z.boolean().default(true)
    }
  }, async (input) => jsonText(await grabArrRelease("radarr", input)));

  server.registerTool("radarr_download_client_scan", {
    title: "Radarr Download Client Scan",
    description: "Queue Radarr DownloadedMoviesScan globally or for an exact path/downloadClientId. Dry-run is enabled by default because scans can import files.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      path: z.string().min(1).optional(),
      downloadClientId: z.string().min(1).optional(),
      importMode: z.string().min(1).optional(),
      sendUpdates: z.boolean().optional(),
      dryRun: z.boolean().default(true)
    }
  }, async ({ path, downloadClientId, importMode, sendUpdates, dryRun }) => {
    return jsonText(await arrCommandAction("radarr", arrCommand("DownloadedMoviesScan", { path, downloadClientId, importMode, sendUpdates }), dryRun));
  });

  server.registerTool("radarr_command_cancel", {
    title: "Radarr Command Cancel",
    description: "Cancel one exact Radarr command ID if the Radarr API accepts cancellation. Dry-run is enabled by default.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      commandId: z.number().int().positive(),
      dryRun: z.boolean().default(true)
    }
  }, async ({ commandId, dryRun }) => jsonText(await cancelArrCommand("radarr", commandId, dryRun)));

  server.registerTool("radarr_recent_logs", {
    title: "Radarr Recent Logs",
    description: "List recent Radarr logs with token-like values redacted.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) }
  }, async ({ limit }) => jsonText(await arrRecentLogs("radarr", limit)));

  server.registerTool("prowlarr_list_indexers", {
    title: "Prowlarr List Indexers",
    description: "List Prowlarr indexers and their enabled state.",
    inputSchema: { limit: z.number().int().min(1).max(250).default(100) }
  }, async ({ limit }) => {
    return jsonText(limitList(await arrApi("prowlarr", "v1", "indexer"), limit));
  });

  server.registerTool("prowlarr_search", {
    title: "Prowlarr Search",
    description: "Search Prowlarr indexers by query. Categories are optional comma-separated Prowlarr category IDs.",
    inputSchema: {
      query: z.string().min(1),
      categories: z.string().optional(),
      limit: z.number().int().min(1).max(250).default(50)
    }
  }, async ({ query, categories, limit }) => {
    return jsonText(limitList(await arrApi("prowlarr", "v1", "search", { query: { query, categories } }), limit));
  });

  server.registerTool("prowlarr_indexer_health", {
    title: "Prowlarr Indexer Health",
    description: "Summarize Prowlarr indexers, health records, and recent indexer history.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(25)
    }
  }, async ({ limit }) => jsonText(await prowlarrIndexerHealth(limit)));

  server.registerTool("qbittorrent_list_torrents", {
    title: "qBittorrent List Torrents",
    description: "List qBittorrent torrents with optional filter, category, tag, and text sort.",
    inputSchema: {
      filter: z.string().optional(),
      category: z.string().optional(),
      tag: z.string().optional(),
      sort: z.string().optional(),
      reverse: z.boolean().optional(),
      limit: z.number().int().min(1).max(250).default(100)
    }
  }, async ({ limit, ...query }) => {
    const params = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== ""));
    const urlParams = new URLSearchParams(params);
    return jsonText(limitList(await qbitRequest(`torrents/info?${urlParams.toString()}`), limit));
  });

  server.registerTool("qbittorrent_control_torrents", {
    title: "qBittorrent Control Torrents",
    description: "Pause or resume specific qBittorrent torrents by hash.",
    inputSchema: {
      action: z.enum(["pause", "resume"]),
      hashes: z.array(z.string().min(1)).min(1)
    }
  }, async ({ action, hashes }) => {
    return jsonText(await qbitRequest(`torrents/${action}`, {
      method: "POST",
      form: { hashes: hashes.join("|") }
    }));
  });

  server.registerTool("qbittorrent_delete_torrents", {
    title: "qBittorrent Delete Torrents",
    description: "Delete specific qBittorrent torrents by hash. File deletion is optional and explicit.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      hashes: z.array(z.string().min(1)).min(1),
      deleteFiles: z.boolean().default(false)
    }
  }, async ({ hashes, deleteFiles }) => {
    return jsonText(await qbitRequest("torrents/delete", {
      method: "POST",
      form: { hashes: hashes.join("|"), deleteFiles: deleteFiles ? "true" : "false" }
    }));
  });

  server.registerTool("qbittorrent_recheck_torrents", {
    title: "qBittorrent Recheck Torrents",
    description: "Ask qBittorrent to recheck exact torrent hashes. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      hashes: z.array(z.string().min(1)).min(1),
      dryRun: z.boolean().default(true)
    }
  }, async ({ hashes, dryRun }) => jsonText(await qbitTorrentHashAction("recheck", hashes, dryRun)));

  server.registerTool("qbittorrent_reannounce_torrents", {
    title: "qBittorrent Reannounce Torrents",
    description: "Ask qBittorrent to reannounce exact torrent hashes. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      hashes: z.array(z.string().min(1)).min(1),
      dryRun: z.boolean().default(true)
    }
  }, async ({ hashes, dryRun }) => jsonText(await qbitTorrentHashAction("reannounce", hashes, dryRun)));

  server.registerTool("nzbget_status", {
    title: "NZBGet Status",
    description: "Get NZBGet server status."
  }, async () => jsonText(await nzbgetRpc("status")));

  server.registerTool("nzbget_list_queue", {
    title: "NZBGet Queue",
    description: "List NZBGet queue groups.",
    inputSchema: { limit: z.number().int().min(1).max(250).default(100) }
  }, async ({ limit }) => jsonText(limitList(await nzbgetRpc("listgroups"), limit)));

  server.registerTool("nzbget_history", {
    title: "NZBGet History",
    description: "List recent NZBGet history records.",
    inputSchema: { limit: z.number().int().min(1).max(250).default(50) }
  }, async ({ limit }) => jsonText(limitList(await nzbgetRpc("history"), limit)));

  server.registerTool("nzbget_history_detail", {
    title: "NZBGet History Detail",
    description: "Return one exact NZBGet history record by NZBID, Arr downloadId/drone parameter, or exact name, including item log when available.",
    inputSchema: {
      nzbId: z.number().int().positive().optional(),
      downloadId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      includeLog: z.boolean().default(true),
      logLimit: z.number().int().min(1).max(500).default(100)
    }
  }, async (input) => jsonText(await nzbgetHistoryDetail(input)));

  server.registerTool("nzbget_download_files", {
    title: "NZBGet Download Files",
    description: "List files NZBGet exposes for one exact history or queue item, including archive-file detection.",
    inputSchema: {
      nzbId: z.number().int().positive().optional(),
      downloadId: z.string().min(1).optional(),
      name: z.string().min(1).optional()
    }
  }, async (input) => jsonText(await nzbgetDownloadFiles(input)));

  server.registerTool("nzbget_retry_postprocess", {
    title: "NZBGet Retry Post-Processing",
    description: "Retry NZBGet post-processing for one exact history item using HistoryProcess. Dry-run is enabled by default and deleted items require force.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      nzbId: z.number().int().positive().optional(),
      downloadId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      dryRun: z.boolean().default(true),
      force: z.boolean().default(false)
    }
  }, async (input) => jsonText(await retryNzbgetPostprocess(input)));

  server.registerTool("download_client_archive_diagnosis", {
    title: "Download Client Archive Diagnosis",
    description: "Diagnose whether a Sonarr/Radarr queue item maps to an NZBGet history item with archive files and unpack statuses that need post-processing or manual extraction.",
    inputSchema: {
      service: z.enum(["sonarr", "radarr"]),
      queueId: z.number().int().positive(),
      logLimit: z.number().int().min(1).max(500).default(100)
    }
  }, async (input) => jsonText(await downloadClientArchiveDiagnosis(input)));

  server.registerTool("nzbget_extract_archives", {
    title: "NZBGet Extract Archives",
    description: "Dry-run or run archive extraction for roots inside one NZBGet history item's DestDir, falling back to filesystem discovery when NZBGet listfiles is empty.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      nzbId: z.number().int().positive().optional(),
      downloadId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      dryRun: z.boolean().default(true),
      force: z.boolean().default(false),
      triggerScanService: z.enum(["sonarr", "radarr"]).optional(),
      importMode: z.string().min(1).optional()
    }
  }, async (input) => jsonText(await extractNzbgetArchives(input)));

  server.registerTool("nzbget_remove_history_items", {
    title: "NZBGet Remove History Items",
    description: "Remove exact NZBGet history NZBID values. Dry-run is enabled by default and reports the matched history records.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      ids: z.array(z.number().int().positive()).min(1),
      deleteFiles: z.boolean().default(false),
      dryRun: z.boolean().default(true)
    }
  }, async ({ ids, deleteFiles, dryRun }) => {
    return jsonText(await removeNzbgetHistory(ids, { deleteFiles, dryRun }));
  });

  server.registerTool("download_client_remove_history", {
    title: "Download Client Remove History",
    description: "Remove exact NZBGet history NZBID values. Dry-run is enabled by default and reports the matched history records.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      clientType: z.enum(["nzbget"]),
      ids: z.array(z.number().int().positive()).min(1),
      deleteFiles: z.boolean().default(false),
      dryRun: z.boolean().default(true)
    }
  }, async ({ clientType, ids, deleteFiles, dryRun }) => {
    if (clientType !== "nzbget") {
      throw new Error(`download client ${clientType} is not supported by this tool`);
    }
    return jsonText(await removeNzbgetHistory(ids, { deleteFiles, dryRun }));
  });

  server.registerTool("nzbget_control_downloads", {
    title: "NZBGet Control Downloads",
    description: "Pause or resume NZBGet downloading.",
    inputSchema: { action: z.enum(["pause", "resume"]) }
  }, async ({ action }) => jsonText(await nzbgetRpc(action === "pause" ? "pausedownload" : "resumedownload")));

  server.registerTool("nzbget_set_rate", {
    title: "NZBGet Set Rate",
    description: "Set the NZBGet download rate in KB/s. Use 0 for unlimited.",
    inputSchema: { rateKb: z.number().int().min(0) }
  }, async ({ rateKb }) => jsonText(await nzbgetRpc("rate", [rateKb])));

  server.registerTool("seerr_search_media", {
    title: "Seerr Search Media",
    description: "Search Seerr, Overseerr, or Jellyseerr for movies and TV shows.",
    inputSchema: {
      query: z.string().min(1),
      page: z.number().int().min(1).default(1)
    }
  }, async ({ query, page }) => jsonText(await seerrApi("search", { query: { query, page } })));

  server.registerTool("seerr_list_issues", {
    title: "Seerr List Issues",
    description: "List Seerr-family user-reported issues without exposing user emails by default.",
    inputSchema: {
      take: z.number().int().min(1).max(100).default(50),
      skip: z.number().int().min(0).default(0),
      status: z.enum(["open", "resolved", "all"]).default("open"),
      mediaType: z.enum(["movie", "tv", "all"]).default("all"),
      verbose: z.boolean().default(false)
    }
  }, async (input) => jsonText(await listSeerrIssues(input)));

  server.registerTool("seerr_issue_details", {
    title: "Seerr Issue Details",
    description: "Get normalized Seerr-family issue details by exact issue ID.",
    inputSchema: {
      issueId: z.number().int().positive(),
      verbose: z.boolean().default(false)
    }
  }, async ({ issueId, verbose }) => jsonText(await getSeerrIssue(issueId, verbose)));

  server.registerTool("seerr_update_issue", {
    title: "Seerr Update Issue",
    description: "Dry-run-first Seerr-family issue metadata update. Only message/body/description is supported, via the first issue comment.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      issueId: z.number().int().positive(),
      patch: z.object({
        message: z.string().min(1).optional(),
        body: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        subject: z.string().min(1).optional(),
        issueType: z.union([z.string(), z.number()]).optional(),
        type: z.union([z.string(), z.number()]).optional(),
        category: z.union([z.string(), z.number()]).optional(),
        status: z.union([z.string(), z.number()]).optional(),
        mediaId: z.union([z.string(), z.number()]).optional(),
        media: z.any().optional(),
        mediaInfo: z.any().optional(),
        tmdbId: z.union([z.string(), z.number()]).optional(),
        tvdbId: z.union([z.string(), z.number()]).optional(),
        plexRatingKey: z.union([z.string(), z.number()]).optional(),
        ratingKey: z.union([z.string(), z.number()]).optional(),
        guid: z.string().optional(),
        problemSeason: z.union([z.string(), z.number()]).optional(),
        problemEpisode: z.union([z.string(), z.number()]).optional()
      }).catchall(z.any()).optional(),
      message: z.string().min(1).optional(),
      body: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      dryRun: z.boolean().default(true),
      verbose: z.boolean().default(false)
    }
  }, async (input) => jsonText(await updateSeerrIssue(input)));

  server.registerTool("seerr_add_issue_comment", {
    title: "Seerr Add Issue Comment",
    description: "Add a comment to an exact Seerr-family issue ID. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      issueId: z.number().int().positive(),
      message: z.string().min(1),
      dryRun: z.boolean().default(true),
      verbose: z.boolean().default(false)
    }
  }, async ({ issueId, message, dryRun, verbose }) => {
    if (dryRun) {
      return jsonText({
        dryRun: true,
        wouldAddComment: { issueId, message },
        issue: await getSeerrIssue(issueId, verbose)
      });
    }
    return jsonText({
      dryRun: false,
      issue: summarizeSeerrIssue(await seerrApi(`issue/${issueId}/comment`, { method: "POST", body: { message } }), verbose)
    });
  });

  server.registerTool("seerr_update_issue_comment", {
    title: "Seerr Update Issue Comment",
    description: "Update an exact Seerr-family issue comment ID. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      commentId: z.number().int().positive(),
      message: z.string().min(1),
      dryRun: z.boolean().default(true),
      verbose: z.boolean().default(false)
    }
  }, async ({ commentId, message, dryRun, verbose }) => {
    if (dryRun) {
      return jsonText({
        dryRun: true,
        wouldUpdateComment: { commentId, message },
        currentComment: summarizeIssueComment(await seerrApi(`issueComment/${commentId}`), verbose)
      });
    }
    return jsonText({
      dryRun: false,
      comment: summarizeIssueComment(await seerrApi(`issueComment/${commentId}`, { method: "PUT", body: { message } }), verbose)
    });
  });

  server.registerTool("seerr_resolve_issue", {
    title: "Seerr Resolve Issue",
    description: "Resolve an exact Seerr-family issue ID. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      issueId: z.number().int().positive(),
      dryRun: z.boolean().default(true),
      verbose: z.boolean().default(false)
    }
  }, async ({ issueId, dryRun, verbose }) => {
    if (dryRun) {
      return jsonText({
        dryRun: true,
        wouldSetStatus: "resolved",
        issue: await getSeerrIssue(issueId, verbose)
      });
    }
    return jsonText({
      dryRun: false,
      issue: summarizeSeerrIssue(await seerrApi(`issue/${issueId}/resolved`, { method: "POST" }), verbose)
    });
  });

  server.registerTool("seerr_reopen_issue", {
    title: "Seerr Reopen Issue",
    description: "Reopen an exact Seerr-family issue ID. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      issueId: z.number().int().positive(),
      dryRun: z.boolean().default(true),
      verbose: z.boolean().default(false)
    }
  }, async ({ issueId, dryRun, verbose }) => {
    if (dryRun) {
      return jsonText({
        dryRun: true,
        wouldSetStatus: "open",
        issue: await getSeerrIssue(issueId, verbose)
      });
    }
    return jsonText({
      dryRun: false,
      issue: summarizeSeerrIssue(await seerrApi(`issue/${issueId}/open`, { method: "POST" }), verbose)
    });
  });

  server.registerTool("seerr_delete_issue", {
    title: "Seerr Delete Issue",
    description: "Delete an exact Seerr-family issue ID. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      issueId: z.number().int().positive(),
      dryRun: z.boolean().default(true),
      verbose: z.boolean().default(false)
    }
  }, async ({ issueId, dryRun, verbose }) => {
    if (dryRun) {
      return jsonText({
        dryRun: true,
        wouldDeleteIssueId: issueId,
        issue: await getSeerrIssue(issueId, verbose)
      });
    }
    await seerrApi(`issue/${issueId}`, { method: "DELETE" });
    return jsonText({
      dryRun: false,
      deletedIssueId: issueId,
      deleted: true
    });
  });

  server.registerTool("seerr_list_requests", {
    title: "Seerr List Requests",
    description: "List normalized Seerr-family media requests without exposing user emails by default.",
    inputSchema: {
      take: z.number().int().min(1).max(100).default(20),
      skip: z.number().int().min(0).default(0),
      filter: z.string().optional(),
      verbose: z.boolean().default(false)
    }
  }, async ({ take, skip, filter, verbose }) => {
    const body = await seerrApi("request", { query: { take, skip, filter } });
    const records = (Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : [])
      .map(request => summarizeSeerrRequest(request, verbose));
    return jsonText({
      pageInfo: body?.pageInfo,
      total: body?.pageInfo?.results ?? records.length,
      returned: records.length,
      records
    });
  });

  server.registerTool("seerr_request_details", {
    title: "Seerr Request Details",
    description: "Get normalized Seerr-family request details by exact request ID.",
    inputSchema: {
      requestId: z.number().int().positive(),
      verbose: z.boolean().default(false)
    }
  }, async ({ requestId, verbose }) => jsonText(await getSeerrRequest(requestId, verbose)));

  server.registerTool("seerr_request_media", {
    title: "Seerr Request Media",
    description: "Create a Seerr-family media request. Seasons apply to TV requests.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      mediaId: z.number().int().positive(),
      mediaType: z.enum(["movie", "tv"]),
      seasons: z.array(z.number().int().min(0)).optional(),
      is4k: z.boolean().optional(),
      serverId: z.number().int().positive().optional(),
      profileId: z.number().int().positive().optional(),
      rootFolder: z.string().optional()
    }
  }, async (input) => jsonText(await seerrApi("request", { method: "POST", body: input })));

  server.registerTool("seerr_update_request_status", {
    title: "Seerr Update Request Status",
    description: "Approve, decline, or delete an exact Seerr-family request. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      requestId: z.number().int().positive(),
      action: z.enum(["approve", "decline", "delete"]),
      dryRun: z.boolean().default(true),
      verbose: z.boolean().default(false)
    }
  }, async ({ requestId, action, dryRun, verbose }) => jsonText(await updateSeerrRequestStatus(requestId, action, dryRun, verbose)));

  server.registerTool("seerr_comment_and_resolve_issue", {
    title: "Seerr Comment And Resolve Issue",
    description: "Add an exact issue comment and resolve the same Seerr-family issue. Dry-run is enabled by default.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      issueId: z.number().int().positive(),
      message: z.string().min(1),
      dryRun: z.boolean().default(true),
      verbose: z.boolean().default(false)
    }
  }, async ({ issueId, message, dryRun, verbose }) => jsonText(await commentAndResolveIssue(issueId, message, dryRun, verbose)));

  server.registerTool("seerr_manage_request", {
    title: "Seerr Manage Request",
    description: "Approve, decline, or delete a Seerr-family media request.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      requestId: z.number().int().positive(),
      action: z.enum(["approve", "decline", "delete"])
    }
  }, async ({ requestId, action }) => {
    if (action === "delete") {
      return jsonText(await seerrApi(`request/${requestId}`, { method: "DELETE" }));
    }
    return jsonText(await seerrApi(`request/${requestId}/${action}`, { method: "POST" }));
  });

  return server;
}

function authorize(req, res, next) {
  const authorization = req.headers.authorization || "";
  if (authorization !== `Bearer ${bearerToken}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

const app = createMcpExpressApp({ host, allowedHosts });
app.use(authorize);

app.get("/health", async (_req, res) => {
  res.json({
    ok: true,
    services: Object.fromEntries(Object.entries(configuredServices).map(([name, config]) => [name, Boolean(config)]))
  });
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("media-mcp: failed handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").send("Method Not Allowed");
});

app.delete("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").send("Method Not Allowed");
});

app.listen(port, host, error => {
  if (error) {
    console.error("media-mcp: failed to start:", error);
    process.exit(1);
  }
  console.error(`media-mcp: listening on ${host}:${port}`);
});
