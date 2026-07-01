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
  tautulli: serviceConfig("TAUTULLI", "apiKey")
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
    tautulli: await tautulliIssueContext(rawIssue)
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
    tautulli
  ] = await Promise.all([
    serviceResult("sonarr", () => arrQueueOverview("sonarr")),
    serviceResult("radarr", () => arrQueueOverview("radarr")),
    serviceResult("nzbget", nzbgetOverview),
    serviceResult("qbittorrent", qbittorrentOverview),
    serviceResult("plex", plexOverview),
    serviceResult("seerr", seerrOverview),
    serviceResult("tautulli", tautulliOverview)
  ]);
  return {
    generatedAt: new Date().toISOString(),
    sonarr,
    radarr,
    nzbget,
    qbittorrent,
    plex,
    seerr,
    tautulli
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
      case "tautulli":
        return { configured: true, status: await tautulliApi("server_status") };
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
    description: "Check configured Sonarr, Radarr, Plex, Bazarr, Prowlarr, qBittorrent, NZBGet, Seerr-family, and Tautulli services."
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
    description: "Get normalized issue details and optional Tautulli playback context for a reported Plex/media issue.",
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
