import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from "zod/v4";

const env = process.env;
const port = Number(env.MEDIA_MCP_PORT || 6971);
const host = env.MEDIA_MCP_HOST || "0.0.0.0";
const bearerToken = env.MEDIA_MCP_BEARER_TOKEN || "";
const requestTimeoutMs = Number(env.MEDIA_MCP_REQUEST_TIMEOUT_MS || 30000);
const allowedHosts = allowedHostnames(env.MEDIA_MCP_ALLOWED_HOSTS, "media-mcp", host);

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
  seerr: seerrConfig()
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
  return { url: normalizeBaseUrl(url), token };
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
  return fetchJson(url, { method: "GET", headers });
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
  return fetchJson(url, { method: "GET", headers });
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

function summarizeQueueRecord(record) {
  return compactObject({
    id: record.id,
    title: record.title,
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
    outputPath: record.outputPath,
    size: record.size,
    sizeLeft: record.sizeLeft ?? record.sizeleft,
    timeLeft: record.timeLeft ?? record.timeleft,
    estimatedCompletionTime: record.estimatedCompletionTime,
    statusMessages: Array.isArray(record.statusMessages)
      ? record.statusMessages.map(message => compactObject({
        title: message.title,
        messages: message.messages
      }))
      : undefined
  });
}

function summarizeImportCandidate(candidate) {
  return compactObject({
    id: candidate.id,
    path: candidate.path,
    relativePath: candidate.relativePath,
    folderName: candidate.folderName,
    name: candidate.name,
    size: candidate.size,
    seriesId: candidate.series?.id,
    seriesTitle: candidate.series?.title,
    tvdbId: candidate.series?.tvdbId,
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
    episodeIds: Array.isArray(candidate.episodeIds)
      ? candidate.episodeIds
      : candidate.episodes?.map(episode => episode.id).filter(Boolean),
    episodeFileId: candidate.episodeFileId,
    releaseGroup: candidate.releaseGroup,
    quality: candidate.quality,
    languages: candidate.languages,
    downloadId: candidate.downloadId,
    customFormats: candidate.customFormats,
    customFormatScore: candidate.customFormatScore,
    indexerFlags: candidate.indexerFlags,
    releaseType: candidate.releaseType,
    rejections: Array.isArray(candidate.rejections)
      ? candidate.rejections.map(rejection => compactObject({
        reason: rejection.reason,
        type: rejection.type
      }))
      : undefined
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

async function arrQueueDetails(serviceName) {
  const records = await arrApi(serviceName, "v3", "queue/details");
  return Array.isArray(records) ? records : [];
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

async function sonarrManualImportCandidates(input) {
  let folder = input.path;
  let downloadId = input.downloadId;
  let seriesId = input.seriesId;
  let queueRecord = null;

  if (input.queueId) {
    const records = await arrQueueDetails("sonarr");
    queueRecord = records.find(record => record.id === input.queueId);
    if (!queueRecord) {
      throw new Error(`sonarr queue item ${input.queueId} was not found`);
    }
    folder = folder || queueRecord.outputPath;
    downloadId = downloadId || queueRecord.downloadId;
    seriesId = seriesId || queueRecord.seriesId || queueRecord.series?.id;
  }

  if (!folder) {
    throw new Error("path is required when queueId does not provide an outputPath");
  }

  const candidates = await arrApi("sonarr", "v3", "manualimport", {
    query: {
      folder,
      downloadId,
      seriesId,
      filterExistingFiles: input.filterExistingFiles
    }
  });
  const records = Array.isArray(candidates) ? candidates : [];
  const limited = limitList(records.map(summarizeImportCandidate), input.limit);
  return {
    queueRecord: queueRecord ? summarizeQueueRecord(queueRecord) : undefined,
    query: compactObject({
      folder,
      downloadId,
      seriesId,
      filterExistingFiles: input.filterExistingFiles
    }),
    ...limited
  };
}

function manualImportFile(input) {
  return compactObject({
    id: input.id,
    path: input.path,
    seriesId: input.seriesId,
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
      default:
        return { configured: false };
    }
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

function createServer() {
  const server = new McpServer({
    name: "unraid-codex-media-mcp",
    version: "0.1.0"
  });

  server.registerTool("media_services_status", {
    title: "Media Services Status",
    description: "Check configured Sonarr, Radarr, Plex, Bazarr, Prowlarr, qBittorrent, NZBGet, and Seerr-family services."
  }, async () => {
    const entries = await Promise.all(Object.entries(configuredServices).map(async ([name, config]) => {
      if (!config) {
        return [name, { configured: false }];
      }
      return [name, await serviceStatus(name)];
    }));
    return jsonText(Object.fromEntries(entries));
  });

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

  server.registerTool("plex_active_sessions", {
    title: "Plex Active Sessions",
    description: "List active Plex playback sessions."
  }, async () => jsonText(await plexApi("status/sessions")));

  server.registerTool("bazarr_status", {
    title: "Bazarr Status",
    description: "Get Bazarr system status."
  }, async () => jsonText(await bazarrApi("system/status")));

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
    return jsonText(limitList(await arrApi("sonarr", "v3", "queue", { query: { page: 1, pageSize: limit } }), limit));
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
    description: "Find Sonarr manual import candidates for an exact queue item ID or path.",
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
    const command = {
      name: "ManualImport",
      importMode,
      files: files.map(manualImportFile)
    };
    if (dryRun) {
      return jsonText({
        dryRun: true,
        command,
        note: "Set dryRun to false to queue this Sonarr ManualImport command."
      });
    }
    return jsonText({
      dryRun: false,
      command: await arrApi("sonarr", "v3", "command", { method: "POST", body: command })
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
    return jsonText(limitList(await arrApi("radarr", "v3", "queue", { query: { page: 1, pageSize: limit } }), limit));
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

  server.registerTool("radarr_profiles", {
    title: "Radarr Profiles",
    description: "List Radarr quality profiles and root folders."
  }, async () => {
    return jsonText({
      qualityProfiles: await arrApi("radarr", "v3", "qualityprofile"),
      rootFolders: await arrApi("radarr", "v3", "rootfolder")
    });
  });

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

  server.registerTool("seerr_list_requests", {
    title: "Seerr List Requests",
    description: "List Seerr-family media requests.",
    inputSchema: {
      take: z.number().int().min(1).max(100).default(20),
      skip: z.number().int().min(0).default(0),
      filter: z.string().optional()
    }
  }, async ({ take, skip, filter }) => jsonText(await seerrApi("request", { query: { take, skip, filter } })));

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
