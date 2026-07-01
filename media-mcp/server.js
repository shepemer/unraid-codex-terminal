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
  seerr: seerrConfig(),
  tautulli: serviceConfig("TAUTULLI", "apiKey"),
  tracearr: serviceConfig("TRACEARR", "apiKey")
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
    displayName: firstString(user.displayName, user.username, user.plexUsername, user.name, verbose ? user.email : undefined),
    username: firstString(user.username, user.plexUsername),
    email: verbose ? user.email : undefined
  });
}

function mediaTitle(media) {
  return firstString(media?.title, media?.name, media?.mediaInfo?.title, media?.movie?.title, media?.tv?.title);
}

function mediaType(media) {
  return firstString(media?.mediaType, media?.type, media?.mediaInfo?.mediaType)
    || (media?.tvdbId ? "tv" : undefined)
    || (media?.tmdbId ? "movie" : undefined);
}

function plexRatingKey(media) {
  return firstPresent(media?.ratingKey, media?.plexRatingKey, media?.plexId, media?.externalServiceId);
}

function summarizeIssueComment(comment, verbose = false) {
  return compactObject({
    id: comment.id,
    message: comment.message,
    reporter: summarizeUser(comment.user ?? comment.createdBy, verbose),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt
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
    rawStatus: verbose ? issue.status : undefined
  });
}

function seerrIssueMatchesMediaType(issue, desired) {
  if (!desired || desired === "all") {
    return true;
  }
  return mediaType(issue.media ?? issue.mediaInfo) === desired;
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
    safeToImport: Boolean(candidate.path && hasTarget && rejections.length === 0),
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

async function arrManualImportCandidates(serviceName, input) {
  let folder = input.path;
  let downloadId = input.downloadId;
  let seriesId = serviceName === "sonarr" ? input.seriesId : undefined;
  let movieId = serviceName === "radarr" ? input.movieId : undefined;
  let queueRecord = null;

  if (input.queueId) {
    const records = await arrQueueDetails(serviceName);
    queueRecord = records.find(record => record.id === input.queueId);
    if (!queueRecord) {
      throw new Error(`${serviceName} queue item ${input.queueId} was not found`);
    }
    folder = folder || queueRecord.outputPath;
    downloadId = downloadId || queueRecord.downloadId;
    seriesId = seriesId || queueRecord.seriesId || queueRecord.series?.id;
    movieId = movieId || queueRecord.movieId || queueRecord.movie?.id;
  }

  if (!folder) {
    throw new Error("path is required when queueId does not provide an outputPath");
  }

  const candidates = await arrApi(serviceName, "v3", "manualimport", {
    query: {
      folder,
      downloadId,
      seriesId,
      movieId,
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
      movieId,
      filterExistingFiles: input.filterExistingFiles
    }),
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

async function plexReportedIssues(input) {
  if (input.source && !["all", "seerr"].includes(input.source)) {
    throw new Error(`issue source ${input.source} is not supported`);
  }
  if (!configuredServices.seerr) {
    return {
      sources: [],
      records: [],
      returned: 0,
      note: "Seerr-family issue source is not configured"
    };
  }
  const issues = await listSeerrIssues(input);
  return {
    sources: ["seerr"],
    ...issues
  };
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
  const title = mediaTitle(issue.media ?? issue.mediaInfo);
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
    return { configured: true, error: error.message };
  }
}

async function tautulliIssueContext(issue) {
  if (!configuredServices.tautulli) {
    return { configured: false };
  }
  const title = mediaTitle(issue.media ?? issue.mediaInfo);
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

async function plexIssueDetails(input) {
  if (input.source !== "seerr") {
    throw new Error(`issue source ${input.source} is not supported`);
  }
  const rawIssue = await seerrApi(`issue/${input.issueId}`);
  return {
    issue: summarizeSeerrIssue(rawIssue, input.verbose),
    tautulli: await tautulliIssueContext(rawIssue),
    tracearr: await tracearrIssueContext(rawIssue)
  };
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
    tracearr
  ] = await Promise.all([
    serviceResult("sonarr", () => arrQueueOverview("sonarr")),
    serviceResult("radarr", () => arrQueueOverview("radarr")),
    serviceResult("nzbget", nzbgetOverview),
    serviceResult("qbittorrent", qbittorrentOverview),
    serviceResult("plex", plexOverview),
    serviceResult("seerr", seerrOverview),
    serviceResult("tautulli", tautulliOverview),
    serviceResult("tracearr", tracearrOverview)
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
    tracearr
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
  return compactObject({
    id: record.id,
    title: record.title,
    seriesId: record.seriesId ?? record.series?.id,
    seriesTitle: record.series?.title,
    movieId: record.movieId ?? record.movie?.id,
    movieTitle: record.movie?.title,
    episodeId: record.episodeId ?? record.id,
    seasonNumber: record.seasonNumber,
    episodeNumber: record.episodeNumber,
    airDateUtc: record.airDateUtc,
    quality: record.quality,
    monitored: record.monitored
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

async function arrWanted(serviceName, kind, limit) {
  const body = await arrApi(serviceName, "v3", `wanted/${kind}`, {
    query: { page: 1, pageSize: limit }
  });
  return arrRecordsPage(body, summarizeArrWantedRecord, limit);
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

async function arrCommandStatus(serviceName, commandId) {
  return arrApi(serviceName, "v3", commandId ? `command/${commandId}` : "command");
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
  if (dryRun) {
    return {
      dryRun: true,
      wouldAddComment: { issueId, message },
      wouldSetStatus: "resolved",
      issue: await getSeerrIssue(issueId, verbose)
    };
  }
  const commented = await seerrApi(`issue/${issueId}/comment`, { method: "POST", body: { message } });
  const resolved = await seerrApi(`issue/${issueId}/resolved`, { method: "POST" });
  return {
    dryRun: false,
    commentedIssue: summarizeSeerrIssue(commented, verbose),
    resolvedIssue: summarizeSeerrIssue(resolved, verbose)
  };
}

async function diagnoseIssue(source, issueId, verbose = false) {
  if (source !== "seerr") {
    throw new Error(`issue source ${source} is not supported`);
  }
  const details = await plexIssueDetails({ source, issueId, verbose });
  return {
    ...details,
    suggestedActions: [
      { type: "seerr_add_comment", issueId, message: "Investigated and found a likely fix. Confirm before applying." },
      { type: "seerr_resolve_issue", issueId }
    ]
  };
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
    bundle.issues = await serviceResult("seerr", () => plexReportedIssues({ status: "open", source: "seerr", mediaType: "all", take: limit, skip: 0, verbose: false }));
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
    description: "Check configured Sonarr, Radarr, Plex, Bazarr, Prowlarr, qBittorrent, NZBGet, Seerr-family, Tautulli, and Tracearr services."
  }, async () => {
    const entries = await Promise.all(Object.entries(configuredServices).map(async ([name, config]) => {
      if (!config) {
        return [name, { configured: false }];
      }
      return [name, await serviceStatus(name)];
    }));
    return jsonText(Object.fromEntries(entries));
  });

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
    description: "Diagnose one normalized Seerr-family user-reported issue with optional Plex, Tautulli, and Tracearr context.",
    inputSchema: {
      source: z.enum(["seerr"]).default("seerr"),
      issueId: z.number().int().positive(),
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

  server.registerTool("plex_reported_issues", {
    title: "Plex Reported Issues",
    description: "List normalized user-reported Plex/media issues from configured issue sources.",
    inputSchema: {
      status: z.enum(["open", "resolved", "all"]).default("open"),
      source: z.enum(["all", "seerr"]).default("all"),
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
      source: z.enum(["seerr"]).default("seerr"),
      issueId: z.number().int().positive(),
      verbose: z.boolean().default(false)
    }
  }, async (input) => jsonText(await plexIssueDetails(input)));

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
    return jsonText({
      dryRun: false,
      service: "sonarr",
      warnings,
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

  server.registerTool("sonarr_wanted_missing", {
    title: "Sonarr Wanted Missing",
    description: "List Sonarr wanted missing episode records.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) }
  }, async ({ limit }) => jsonText(await arrWanted("sonarr", "missing", limit)));

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
    description: "List Sonarr command status records or one exact command ID.",
    inputSchema: { commandId: z.number().int().positive().optional() }
  }, async ({ commandId }) => jsonText(await arrCommandStatus("sonarr", commandId)));

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

  server.registerTool("radarr_manual_import_candidates", {
    title: "Radarr Manual Import Candidates",
    description: "Find Radarr manual import candidates for an exact queue item ID or path.",
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
    return jsonText({
      dryRun: false,
      service: "radarr",
      warnings,
      command: await arrApi("radarr", "v3", "command", { method: "POST", body: command })
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
    description: "List Radarr wanted missing movie records.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) }
  }, async ({ limit }) => jsonText(await arrWanted("radarr", "missing", limit)));

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
    description: "List Radarr command status records or one exact command ID.",
    inputSchema: { commandId: z.number().int().positive().optional() }
  }, async ({ commandId }) => jsonText(await arrCommandStatus("radarr", commandId)));

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
