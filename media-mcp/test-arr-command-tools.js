import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
    });
    req.on("end", () => {
      resolve(data ? JSON.parse(data) : undefined);
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

function parseSse(text) {
  if (!text.startsWith("event:")) {
    return JSON.parse(text);
  }
  const data = text.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim();
  return JSON.parse(data);
}

async function run() {
  const calls = [];
  let commandId = 1000;
  const commandRecords = new Map();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "media-mcp-archives-"));
  const mappedArchiveDir = path.join(tempRoot, "usenet/completed/Series/Archive.Bundle.S01.1080p-GRP");
  await mkdir(mappedArchiveDir, { recursive: true });
  await writeFile(path.join(mappedArchiveDir, "archive.bundle.s01e01.rar"), "placeholder\n");
  await writeFile(path.join(mappedArchiveDir, "archive.bundle.s01e01.r00"), "placeholder\n");
  await writeFile(path.join(mappedArchiveDir, "archive.bundle.s01e02.part01.rar"), "placeholder\n");
  await writeFile(path.join(mappedArchiveDir, "archive.bundle.s01e02.part02.rar"), "placeholder\n");
  const sonarrQueue = [
    {
      id: 1001,
      title: "Show.S01E01.1080p-GRP",
      seriesId: 10,
      series: { id: 10, title: "Show" },
      episodeId: 101,
      outputPath: "/downloads/usenet/completed/Series/Show.S01E01.1080p-GRP",
      downloadId: "sonarr-single"
    },
    {
      id: 1002,
      title: "Show.S01.1080p-GRP",
      seriesId: 10,
      series: { id: 10, title: "Show" },
      outputPath: "/downloads/usenet/completed/Series/Show.S01.1080p-GRP",
      downloadId: "sonarr-pack"
    },
    {
      id: 1003,
      title: "A &amp; B.Show.S01E02.1080p-GRP",
      seriesId: 11,
      series: { id: 11, title: "A & B Show" },
      episodeId: 111,
      outputPath: "/downloads/usenet/completed/Series/A &amp; B.Show.S01E02.1080p-GRP",
      downloadId: "sonarr-amp"
    },
    {
      id: 1004,
      title: "Show.S01E03.1080p-GRP",
      seriesId: 10,
      series: { id: 10, title: "Show" },
      episodeId: 103,
      outputPath: "/downloads/usenet/intermediate/Series/Show.S01E03.1080p-GRP",
      downloadId: "sonarr-intermediate"
    },
    {
      id: 1005,
      title: "Show.S01E04.1080p-GRP",
      seriesId: 10,
      series: { id: 10, title: "Show" },
      episodeId: 104,
      outputPath: "/downloads/usenet/completed/Series/Show.S01E04.1080p-GRP",
      downloadId: "sonarr-library-bug"
    },
    {
      id: 1006,
      title: "Example.Archive.Series.S01.1080p.BluRay.H264-TEST",
      seriesId: 12,
      series: { id: 12, title: "Example Archive Series" },
      outputPath: "/downloads/usenet/completed/Series/Example.Archive.Series.S01.1080p.BluRay.H264-TEST",
      downloadId: "example-archive-drone-id",
      trackedDownloadStatus: "warning",
      statusMessages: [{ title: "Found archive file, might need to be extracted", messages: ["Found archive file, might need to be extracted"] }]
    }
  ];
  const radarrQueue = [
    {
      id: 2001,
      title: "Movie.2025.1080p-GRP",
      movieId: 20,
      movie: { id: 20, title: "Movie" },
      outputPath: "/downloads/usenet/completed/Movies/Movie.2025.1080p-GRP",
      downloadId: "radarr-movie"
    },
    {
      id: 2002,
      title: "Movie.LibraryBug.2025.1080p-GRP",
      movieId: 21,
      movie: { id: 21, title: "Movie Library Bug" },
      outputPath: "/downloads/usenet/completed/Movies/Movie.LibraryBug.2025.1080p-GRP",
      downloadId: "radarr-library-bug"
    }
  ];
  function sonarrWantedEpisode(id, overrides = {}) {
    return {
      id,
      title: `Episode ${id}`,
      seriesId: 10,
      series: { id: 10, title: "Show", monitored: true },
      seasonNumber: 1,
      episodeNumber: id,
      airDateUtc: "2020-01-01T00:00:00Z",
      monitored: true,
      quality: { quality: { name: "Missing" } },
      ...overrides
    };
  }
  function radarrWantedMovie(id, overrides = {}) {
    return {
      id,
      title: `Movie ${id}`,
      year: 2020,
      tmdbId: 100000 + id,
      monitored: true,
      isAvailable: true,
      qualityProfileId: 2,
      ...overrides
    };
  }
  const sonarrWantedMissing = [
    ...Array.from({ length: 260 }, (_, index) => sonarrWantedEpisode(index + 1)),
    sonarrWantedEpisode(1001, { monitored: false }),
    sonarrWantedEpisode(1002, { airDateUtc: "2999-01-01T00:00:00Z" }),
    sonarrWantedEpisode(1003, { seasonNumber: 0 })
  ];
  const radarrWantedMissing = [
    ...Array.from({ length: 205 }, (_, index) => radarrWantedMovie(index + 1)),
    radarrWantedMovie(2001, { monitored: false }),
    radarrWantedMovie(2002, { isAvailable: false })
  ];
  const manualCandidates = {
    "sonarr-single": [{
      id: 1,
      path: "/downloads/usenet/completed/Series/Show.S01E01.1080p-GRP/Show.S01E01.1080p-GRP.mkv",
      series: { id: 10, title: "Show" },
      episodes: [{ id: 101, seasonNumber: 1, episodeNumber: 1, title: "Pilot" }],
      quality: { quality: { name: "WEBDL-1080p" } },
      languages: [{ name: "English" }],
      releaseGroup: "GRP",
      releaseType: "singleEpisode",
      rejections: []
    }],
    "sonarr-pack": [
      {
        id: 2,
        path: "/downloads/usenet/completed/Series/Show.S01.1080p-GRP/Show.S01E01.1080p-GRP.mkv",
        series: { id: 10, title: "Show" },
        episodes: [{ id: 101, seasonNumber: 1, episodeNumber: 1, title: "Pilot" }],
        quality: { quality: { name: "WEBDL-1080p" } },
        languages: [{ name: "English" }],
        releaseGroup: "GRP",
        releaseType: "seasonPack",
        rejections: []
      },
      {
        id: 3,
        path: "/downloads/usenet/completed/Series/Show.S01.1080p-GRP/Show.S01E02.1080p-GRP.mkv",
        series: { id: 10, title: "Show" },
        episodes: [{ id: 102, seasonNumber: 1, episodeNumber: 2, title: "Second" }],
        quality: { quality: { name: "WEBDL-1080p" } },
        languages: [{ name: "English" }],
        releaseGroup: "GRP",
        releaseType: "seasonPack",
        rejections: []
      }
    ],
    "sonarr-amp": [{
      id: 4,
      path: "/downloads/usenet/completed/Series/A & B.Show.S01E02.1080p-GRP/A & B.Show.S01E02.1080p-GRP.mkv",
      series: { id: 11, title: "A & B Show" },
      episodes: [{ id: 111, seasonNumber: 1, episodeNumber: 2, title: "Ampersand" }],
      quality: { quality: { name: "WEBDL-1080p" } },
      languages: [{ name: "English" }],
      releaseGroup: "GRP",
      releaseType: "singleEpisode",
      rejections: []
    }],
    "sonarr-intermediate": [{
      id: 5,
      path: "/downloads/usenet/intermediate/Series/Show.S01E03.1080p-GRP/Show.S01E03.1080p-GRP.mkv",
      series: { id: 10, title: "Show" },
      episodes: [{ id: 103, seasonNumber: 1, episodeNumber: 3, title: "Third" }],
      quality: { quality: { name: "WEBDL-1080p" } },
      languages: [{ name: "English" }],
      releaseGroup: "GRP",
      releaseType: "singleEpisode",
      rejections: []
    }],
    "sonarr-library-bug": [{
      id: 6,
      path: "/tv/Show/Season 01/Show.S01E04.mkv",
      series: { id: 10, title: "Show" },
      episodes: [{ id: 104, seasonNumber: 1, episodeNumber: 4, title: "Fourth" }],
      quality: { quality: { name: "WEBDL-1080p" } },
      languages: [{ name: "English" }],
      releaseGroup: "GRP",
      releaseType: "singleEpisode",
      rejections: []
    }],
    "radarr-movie": [{
      id: 7,
      path: "/downloads/usenet/completed/Movies/Movie.2025.1080p-GRP/Movie.2025.1080p-GRP.mkv",
      movie: { id: 20, title: "Movie" },
      quality: { quality: { name: "WEBDL-1080p" } },
      languages: [{ name: "English" }],
      releaseGroup: "GRP",
      releaseType: "movie",
      rejections: []
    }],
    "radarr-library-bug": [{
      id: 8,
      path: "/movies/Movie Library Bug (2025)/Movie Library Bug.mkv",
      movie: { id: 21, title: "Movie Library Bug" },
      quality: { quality: { name: "WEBDL-1080p" } },
      languages: [{ name: "English" }],
      releaseGroup: "GRP",
      releaseType: "movie",
      rejections: []
    }]
  };
  const nzbgetHistory = [
    {
      NZBID: 70001,
      ID: 70001,
      Name: "Example.Archive.Series.S01.1080p.BluRay.H264-TEST",
      NZBName: "Example.Archive.Series.S01.1080p.BluRay.H264-TEST",
      Status: "SUCCESS/PAR",
      ParStatus: "SUCCESS",
      UnpackStatus: "NONE",
      MoveStatus: "SUCCESS",
      Deleted: false,
      DeleteStatus: "NONE",
      DestDir: "/downloads/usenet/completed/Series/Example.Archive.Series.S01.1080p.BluRay.H264-TEST",
      Parameters: [{ Name: "drone", Value: "example-archive-drone-id" }],
      FileSizeMB: 1234,
      DownloadedSizeMB: 1234
    },
    {
      NZBID: 70002,
      ID: 70002,
      Name: "Archive.Bundle.S01.1080p-GRP",
      NZBName: "Archive.Bundle.S01.1080p-GRP",
      Status: "SUCCESS/PAR",
      ParStatus: "SUCCESS",
      UnpackStatus: "NONE",
      MoveStatus: "SUCCESS",
      Deleted: false,
      DeleteStatus: "NONE",
      DestDir: "/downloads/usenet/completed/Series/Archive.Bundle.S01.1080p-GRP",
      Parameters: [{ Name: "drone", Value: "filesystem-archive-drone-id" }],
      FileSizeMB: 4321,
      DownloadedSizeMB: 4321
    },
    {
      NZBID: 56573,
      Name: "Ambiguous.Release",
      NZBName: "Ambiguous.Release",
      Status: "SUCCESS/ALL",
      Deleted: false,
      DestDir: "/downloads/usenet/completed/Series/Ambiguous.Release"
    },
    {
      NZBID: 56574,
      Name: "Ambiguous.Release",
      NZBName: "Ambiguous.Release",
      Status: "SUCCESS/ALL",
      Deleted: false,
      DestDir: "/downloads/usenet/completed/Series/Ambiguous.Release.2"
    },
    {
      NZBID: 56575,
      Name: "Deleted.Release",
      NZBName: "Deleted.Release",
      Status: "DELETED/MANUAL",
      Deleted: true,
      DestDir: "/downloads/usenet/completed/Series/Deleted.Release"
    }
  ];
  const nzbgetFiles = {
    70001: [
      {
        ID: 9001,
        NZBID: 70001,
        Filename: "Example.Archive.Series.S01E01.part01.rar",
        DestDir: "/downloads/usenet/completed/Series/Example.Archive.Series.S01.1080p.BluRay.H264-TEST",
        FileSizeMB: 500
      },
      {
        ID: 9002,
        NZBID: 70001,
        Filename: "Example.Archive.Series.S01E01.r00",
        DestDir: "/downloads/usenet/completed/Series/Example.Archive.Series.S01.1080p.BluRay.H264-TEST",
        FileSizeMB: 500
      }
    ]
  };
  const nzbgetLog = {
    70001: [
      { ID: 1, Kind: "INFO", Time: 1783120000, Text: "Completed download" },
      { ID: 2, Kind: "WARNING", Time: 1783120001, Text: "Found archive file, might need to be extracted" }
    ]
  };
  const badTermsSpecification = {
    name: "Bad release terms",
    implementation: "ReleaseTitleSpecification",
    implementationName: "Release Title",
    negate: false,
    required: false,
    fields: [{ name: "value", value: "\\b(CAM|HDRip|DCPRip|HDSCR)\\b" }]
  };
  const secretSpecification = {
    name: "Secret setting fixture",
    implementation: "ExampleSpecification",
    implementationName: "Example",
    negate: false,
    required: false,
    fields: [{ name: "apiKey", value: "should-not-leak" }]
  };
  const qualityProfiles = {
    sonarr: [{
      id: 1,
      name: "Best Available",
      upgradeAllowed: true,
      cutoff: 3,
      minFormatScore: 0,
      cutoffFormatScore: 0,
      minUpgradeFormatScore: 0,
      items: [
        { quality: { id: 1, name: "CAM" }, allowed: true },
        {
          id: 1000,
          name: "WEB 1080p",
          allowed: true,
          items: [
            { quality: { id: 3, name: "WEBDL-1080p" }, allowed: true },
            { quality: { id: 4, name: "WEBRip-1080p" }, allowed: true }
          ]
        }
      ],
      formatItems: [{ format: 10, name: "Bad Release Source", score: 0 }]
    }],
    radarr: [{
      id: 2,
      name: "Best Available",
      upgradeAllowed: true,
      cutoff: 3,
      minFormatScore: 0,
      cutoffFormatScore: 0,
      minUpgradeFormatScore: 0,
      items: [
        { quality: { id: 1, name: "CAM" }, allowed: true },
        { quality: { id: 2, name: "TELESYNC" }, allowed: true },
        {
          id: 1000,
          name: "WEB 1080p",
          allowed: true,
          items: [
            { quality: { id: 3, name: "WEBDL-1080p" }, allowed: true },
            { quality: { id: 4, name: "WEBRip-1080p" }, allowed: true }
          ]
        }
      ],
      formatItems: [{ format: 10, name: "Bad Release Source", score: 0 }]
    }]
  };
  const customFormats = {
    sonarr: [{ id: 10, name: "Bad Release Source", includeCustomFormatWhenRenaming: false, specifications: [badTermsSpecification] }],
    radarr: [{ id: 10, name: "Bad Release Source", includeCustomFormatWhenRenaming: false, specifications: [badTermsSpecification] }]
  };
  const qualityDefinitions = {
    sonarr: [
      { id: 101, quality: { id: 1, name: "CAM" }, title: "CAM", minSize: 0, maxSize: 10, preferredSize: 5 },
      { id: 103, quality: { id: 3, name: "WEBDL-1080p" }, title: "WEBDL-1080p", minSize: 1, maxSize: 100, preferredSize: 50 }
    ],
    radarr: [
      { id: 201, quality: { id: 1, name: "CAM" }, title: "CAM", minSize: 0, maxSize: 10, preferredSize: 5 },
      { id: 203, quality: { id: 3, name: "WEBDL-1080p" }, title: "WEBDL-1080p", minSize: 1, maxSize: 100, preferredSize: 50 }
    ]
  };

  function queueForService(service) {
    return service === "sonarr" ? sonarrQueue : radarrQueue;
  }

  function candidatesFor(service, query) {
    if (query.downloadId && manualCandidates[query.downloadId]) {
      return manualCandidates[query.downloadId];
    }
    if (service === "sonarr") {
      return [{
        id: 99,
        path: `${query.folder}/episode.mkv`,
        series: { id: 10, title: "Show" },
        episodes: [{ id: 101, seasonNumber: 1, episodeNumber: 2, title: "Episode" }],
        quality: { quality: { name: "HDTV-1080p" } },
        languages: [{ name: "English" }],
        rejections: []
      }];
    }
    return [{
      id: 100,
      path: `${query.folder}/movie.mkv`,
      movie: { id: 20, title: "Movie" },
      quality: { quality: { name: "Bluray-1080p" } },
      languages: [{ name: "English" }],
      rejections: []
    }];
  }

  const mock = http.createServer(async (req, res) => {
    if (req.url === "/jsonrpc") {
      const request = await readJson(req);
      calls.push({ service: "nzbget", method: "RPC", path: request.method, params: request.params });
      let result;
      switch (request.method) {
        case "history":
          result = nzbgetHistory;
          break;
        case "listfiles":
          result = nzbgetFiles[request.params?.[2]] || [];
          break;
        case "loadlog":
          result = (nzbgetLog[request.params?.[0]] || []).slice(0, request.params?.[2] || 100);
          break;
        case "editqueue":
          result = true;
          break;
        case "listgroups":
          result = [];
          break;
        case "status":
          result = { DownloadPaused: false };
          break;
        default:
          return sendJson(res, 404, { jsonrpc: "2.0", id: request.id, error: { message: `unexpected ${request.method}` } });
      }
      return sendJson(res, 200, { jsonrpc: "2.0", id: request.id, result });
    }

    const url = new URL(req.url, "http://127.0.0.1");
    const [service] = url.pathname.split("/").filter(Boolean);
    const path = url.pathname.replace(`/${service}/api/v3/`, "");
    const body = await readJson(req);
    const query = Object.fromEntries(url.searchParams);
    calls.push({ service, method: req.method, path, query, body });

    if (req.headers["x-api-key"] !== `${service}-key`) {
      return sendJson(res, 401, { error: "bad key" });
    }
    if (req.method === "GET" && path.startsWith("wanted/")) {
      const kind = path.split("/")[1];
      const wantedRecords = kind === "missing"
        ? (service === "sonarr" ? sonarrWantedMissing : radarrWantedMissing)
        : [];
      const page = Number(query.page || 1);
      const pageSize = Number(query.pageSize || 50);
      const start = (page - 1) * pageSize;
      return sendJson(res, 200, {
        page,
        pageSize,
        totalRecords: wantedRecords.length,
        records: wantedRecords.slice(start, start + pageSize)
      });
    }
    if (req.method === "POST" && path === "command") {
      const queued = {
        id: ++commandId,
        name: body.name,
        status: "queued",
        queued: "2026-07-02T00:00:00Z",
        body
      };
      commandRecords.set(queued.id, queued);
      return sendJson(res, 200, queued);
    }
    if (req.method === "GET" && path === "command") {
      return sendJson(res, 200, [...commandRecords.values()]);
    }
    if (req.method === "GET" && path.startsWith("command/")) {
      const id = Number(path.split("/")[1]);
      return sendJson(res, 200, commandRecords.get(id) || {
        id,
        name: "Unknown",
        status: "completed",
        queued: "2026-07-02T00:00:00Z",
        body: {}
      });
    }
    if (req.method === "DELETE" && path.startsWith("command/")) {
      return sendJson(res, 200, { deleted: true, id: Number(path.split("/")[1]) });
    }
    if (req.method === "GET" && path === "release") {
      return sendJson(res, 200, [{
        guid: `${service}-guid`,
        indexerId: service === "sonarr" ? 11 : 22,
        indexer: "Mock Indexer",
        title: `${service} release`,
        downloadAllowed: true,
        downloadUrl: "https://example.invalid/download?apikey=secret",
        rejections: []
      }]);
    }
    if (req.method === "POST" && path === "release") {
      return sendJson(res, 200, {
        grabbed: true,
        ...body,
        downloadUrl: "https://example.invalid/grab?token=secret"
      });
    }
    if (req.method === "GET" && path === "qualityprofile") {
      return sendJson(res, 200, qualityProfiles[service]);
    }
    if (req.method === "PUT" && path.startsWith("qualityprofile/")) {
      const id = Number(path.split("/")[1]);
      const index = qualityProfiles[service].findIndex(profile => profile.id === id);
      if (index === -1) {
        return sendJson(res, 404, { error: "missing profile" });
      }
      qualityProfiles[service][index] = body;
      return sendJson(res, 200, body);
    }
    if (req.method === "GET" && path === "customformat") {
      return sendJson(res, 200, customFormats[service]);
    }
    if (req.method === "POST" && path === "customformat") {
      const created = { id: Math.max(0, ...customFormats[service].map(format => format.id)) + 1, ...body };
      customFormats[service].push(created);
      return sendJson(res, 200, created);
    }
    if (req.method === "PUT" && path.startsWith("customformat/")) {
      const id = Number(path.split("/")[1]);
      const index = customFormats[service].findIndex(format => format.id === id);
      if (index === -1) {
        return sendJson(res, 404, { error: "missing custom format" });
      }
      customFormats[service][index] = body;
      return sendJson(res, 200, body);
    }
    if (req.method === "GET" && path === "qualitydefinition") {
      return sendJson(res, 200, qualityDefinitions[service]);
    }
    if (req.method === "PUT" && path.startsWith("qualitydefinition/")) {
      const id = Number(path.split("/")[1]);
      const index = qualityDefinitions[service].findIndex(definition => definition.id === id);
      if (index === -1) {
        return sendJson(res, 404, { error: "missing quality definition" });
      }
      qualityDefinitions[service][index] = body;
      return sendJson(res, 200, body);
    }
    if (req.method === "GET" && path === "queue/details") {
      return sendJson(res, 200, queueForService(service));
    }
    if (req.method === "GET" && path === "queue") {
      return sendJson(res, 200, { page: 1, pageSize: Number(query.pageSize || 50), totalRecords: queueForService(service).length, records: queueForService(service) });
    }
    if (req.method === "GET" && path === "filesystem") {
      return sendJson(res, 200, {
        path: query.path,
        files: [{
          name: `${query.path.split("/").at(-1)}.mkv`,
          path: `${query.path}/${query.path.split("/").at(-1)}.mkv`,
          size: 123456
        }],
        directories: []
      });
    }
    if (req.method === "GET" && path === "manualimport") {
      return sendJson(res, 200, candidatesFor(service, query));
    }
    return sendJson(res, 404, { error: `unexpected ${req.method} ${url.pathname}` });
  });

  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const mockPort = mock.address().port;
  const mediaPort = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      ...process.env,
      MEDIA_MCP_BEARER_TOKEN: "test-token",
      MEDIA_MCP_HOST: "127.0.0.1",
      MEDIA_MCP_PORT: String(mediaPort),
      SONARR_URL: `http://127.0.0.1:${mockPort}/sonarr`,
      SONARR_API_KEY: "sonarr-key",
      RADARR_URL: `http://127.0.0.1:${mockPort}/radarr`,
      RADARR_API_KEY: "radarr-key",
      NZBGET_URL: `http://127.0.0.1:${mockPort}`,
      NZBGET_USERNAME: "nzbget",
      NZBGET_PASSWORD: "tegbzn6789",
      MEDIA_MCP_PATH_MAPS: `/downloads=${tempRoot}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => {
    stdout += chunk;
  });
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });

  const baseUrl = `http://127.0.0.1:${mediaPort}/mcp`;
  let sessionId;
  let id = 1;

  async function rpc(method, params = {}, hasId = true) {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {})
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(hasId ? { id: id++ } : {}), method, params })
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP ${response.status}: ${text}\nstdout=${stdout}\nstderr=${stderr}`);
    }
    sessionId ||= response.headers.get("mcp-session-id") || undefined;
    return hasId && text ? parseSse(text) : null;
  }

  async function tool(name, args = {}) {
    const response = await rpc("tools/call", { name, arguments: args });
    assert.ok(!response.error, JSON.stringify(response));
    assert.ok(!response.result.isError, response.result.content?.[0]?.text);
    return JSON.parse(response.result.content[0].text);
  }

  async function toolError(name, args = {}) {
    const response = await rpc("tools/call", { name, arguments: args });
    assert.ok(response.error || response.result?.isError, JSON.stringify(response));
    return response.error?.message || response.result?.content?.[0]?.text || "";
  }

  function lastCall() {
    return calls.at(-1);
  }

  function postReleaseCallCount() {
    return calls.filter(call => call.method === "POST" && call.path === "release").length;
  }

  function arrCallCount(method, pathValue) {
    return calls.filter(call => call.method === method && call.path === pathValue).length;
  }

  function commandBodiesSince(index) {
    return calls
      .slice(index)
      .filter(call => call.method === "POST" && call.path === "command")
      .map(call => call.body);
  }

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fetch(baseUrl, { headers: { authorization: "Bearer test-token", accept: "application/json, text/event-stream" } });
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "arr-command-test", version: "1" }
    });
    await rpc("notifications/initialized", {}, false);

    const tools = await rpc("tools/list");
    const toolNames = new Set(tools.result.tools.map(toolInfo => toolInfo.name));
    for (const name of [
      "sonarr_search_missing",
      "sonarr_wanted_missing",
      "sonarr_wanted_missing_ids",
      "sonarr_search_missing_exact",
      "sonarr_search_cutoff_unmet",
      "sonarr_search_episode",
      "sonarr_search_series",
      "sonarr_search_season",
      "sonarr_rescan_series",
      "sonarr_refresh_series",
      "sonarr_rename_files",
      "sonarr_queue_item_files",
      "sonarr_import_queue_item",
      "sonarr_interactive_search_episode",
      "sonarr_grab_release",
      "sonarr_download_client_scan",
      "sonarr_command_cancel",
      "sonarr_quality_profiles",
      "sonarr_update_quality_profile",
      "sonarr_custom_formats",
      "sonarr_update_custom_format",
      "sonarr_quality_definitions",
      "sonarr_update_quality_definition",
      "media_archive_environment_check",
      "radarr_search_missing",
      "radarr_wanted_missing",
      "radarr_wanted_missing_ids",
      "radarr_search_missing_exact",
      "radarr_search_cutoff_unmet",
      "radarr_search_movie",
      "radarr_rescan_movie",
      "radarr_refresh_movie",
      "radarr_rename_files",
      "radarr_queue_item_files",
      "radarr_import_queue_item",
      "radarr_interactive_search_movie",
      "radarr_grab_release",
      "radarr_download_client_scan",
      "radarr_command_cancel",
      "radarr_quality_profiles",
      "radarr_update_quality_profile",
      "radarr_custom_formats",
      "radarr_update_custom_format",
      "radarr_quality_definitions",
      "radarr_update_quality_definition",
      "nzbget_history_detail",
      "nzbget_download_files",
      "nzbget_retry_postprocess",
      "download_client_archive_diagnosis",
      "nzbget_extract_archives"
    ]) {
      assert.ok(toolNames.has(name), `missing tool ${name}`);
    }

    const profileRaw = await tool("radarr_quality_profiles", { name: "Best Available", includeRaw: true });
    assert.equal(profileRaw.records.length, 1);
    assert.equal(profileRaw.records[0].formatItems[0].score, 0);

    const profileDryPutCount = arrCallCount("PUT", "qualityprofile/2");
    const profileDryRun = await tool("radarr_update_quality_profile", {
      name: "Best Available",
      patch: {
        upgradeAllowed: false,
        cutoff: "WEBDL-1080p",
        qualityAllowed: { CAM: false },
        customFormatScores: { "Bad Release Source": -10000 },
        minFormatScore: -10000,
        cutoffFormatScore: 0,
        minUpgradeFormatScore: 0
      }
    });
    assert.equal(profileDryRun.dryRun, true);
    assert.equal(profileDryRun.applied, false);
    assert.equal(profileDryRun.endpoint.method, "PUT");
    assert.equal(profileDryRun.endpoint.path, "/api/v3/qualityprofile/2");
    assert.equal(profileDryRun.proposedObject.upgradeAllowed, false);
    assert.equal(profileDryRun.proposedObject.items[0].allowed, false);
    assert.equal(profileDryRun.proposedObject.formatItems[0].score, -10000);
    assert.equal(profileDryRun.validationErrors.length, 0);
    assert.ok(profileDryRun.diff.some(change => change.path === "$.items[0].allowed"));
    assert.equal(arrCallCount("PUT", "qualityprofile/2"), profileDryPutCount);

    const profileApply = await tool("radarr_update_quality_profile", {
      id: 2,
      patch: {
        qualityAllowed: [{ qualityId: 2, allowed: false }],
        customFormatScores: [{ id: 10, score: -10000 }]
      },
      dryRun: false
    });
    assert.equal(profileApply.applied, true);
    assert.equal(lastCall().method, "PUT");
    assert.equal(lastCall().path, "qualityprofile/2");
    assert.equal(lastCall().body.items[1].allowed, false);
    assert.equal(lastCall().body.formatItems[0].score, -10000);

    const customFormatSummary = await tool("radarr_custom_formats", { name: "Bad Release Source" });
    assert.equal(customFormatSummary.records[0].name, "Bad Release Source");
    const customFormatDryRun = await tool("radarr_update_custom_format", {
      name: "Bad Release Source",
      patch: { includeCustomFormatWhenRenaming: true },
      testTitles: ["Movie.2026.CAM-GRP", "Movie.2026.1080p.BluRay-GRP"]
    });
    assert.equal(customFormatDryRun.dryRun, true);
    assert.equal(customFormatDryRun.applied, false);
    assert.equal(customFormatDryRun.endpoint.path, "/api/v3/customformat/10");
    assert.equal(customFormatDryRun.titleTests.records[0].matches, true);
    assert.equal(customFormatDryRun.titleTests.records[1].matches, false);

    const customFormatApply = await tool("radarr_update_custom_format", {
      id: 10,
      patch: { includeCustomFormatWhenRenaming: true },
      dryRun: false
    });
    assert.equal(customFormatApply.applied, true);
    assert.equal(lastCall().method, "PUT");
    assert.equal(lastCall().path, "customformat/10");
    assert.equal(lastCall().body.includeCustomFormatWhenRenaming, true);

    const customFormatCreateDryRun = await tool("sonarr_update_custom_format", {
      name: "New Bad Terms",
      definition: {
        name: "New Bad Terms",
        includeCustomFormatWhenRenaming: false,
        specifications: [badTermsSpecification, secretSpecification]
      },
      testTitles: ["Show.S01E01.HDRip-GRP", "Show.S01E01.WEBDL-GRP"]
    });
    assert.equal(customFormatCreateDryRun.action, "create");
    assert.equal(customFormatCreateDryRun.endpoint.method, "POST");
    assert.equal(customFormatCreateDryRun.endpoint.path, "/api/v3/customformat");
    assert.equal(customFormatCreateDryRun.proposedObject.specifications[1].fields[0].value, "[redacted]");
    assert.equal(customFormatCreateDryRun.apiPayload.specifications[1].fields[0].value, "[redacted]");
    assert.equal(customFormatCreateDryRun.titleTests.records[0].matches, true);
    assert.equal(customFormatCreateDryRun.titleTests.records[1].matches, false);

    const definitions = await tool("sonarr_quality_definitions", { qualityName: "WEBDL-1080p" });
    assert.equal(definitions.records[0].qualityId, 3);
    const definitionDryRun = await tool("sonarr_update_quality_definition", {
      qualityName: "WEBDL-1080p",
      patch: { minSize: 2, preferredSize: 60, maxSize: 110 }
    });
    assert.equal(definitionDryRun.dryRun, true);
    assert.equal(definitionDryRun.endpoint.path, "/api/v3/qualitydefinition/103");
    assert.equal(definitionDryRun.proposedObject.preferredSize, 60);
    assert.equal(definitionDryRun.validationErrors.length, 0);

    const definitionApply = await tool("sonarr_update_quality_definition", {
      qualityId: 3,
      patch: { preferredSize: 65 },
      dryRun: false
    });
    assert.equal(definitionApply.applied, true);
    assert.equal(lastCall().method, "PUT");
    assert.equal(lastCall().path, "qualitydefinition/103");
    assert.equal(lastCall().body.preferredSize, 65);

    const sonarrPage2 = await tool("sonarr_wanted_missing", { page: 2, pageSize: 100 });
    assert.equal(sonarrPage2.page, 2);
    assert.equal(sonarrPage2.pageSize, 100);
    assert.equal(sonarrPage2.totalRecords, 263);
    assert.equal(sonarrPage2.returned, 100);
    assert.equal(sonarrPage2.records[0].episodeId, 101);
    assert.deepEqual(lastCall().query, { page: "2", pageSize: "100" });

    const sonarrLargeLimit = await tool("sonarr_wanted_missing", { limit: 260 });
    assert.equal(sonarrLargeLimit.page, 1);
    assert.equal(sonarrLargeLimit.pageSize, 250);
    assert.equal(sonarrLargeLimit.returned, 260);
    assert.equal(sonarrLargeLimit.records.at(-1).episodeId, 260);

    const sonarrWantedIds = await tool("sonarr_wanted_missing_ids", {});
    assert.equal(sonarrWantedIds.returned, 260);
    assert.equal(sonarrWantedIds.episodeIds.length, 260);
    assert.equal(sonarrWantedIds.skipped.total, 3);
    assert.equal(sonarrWantedIds.skipped.reasons.unmonitored, 1);
    assert.equal(sonarrWantedIds.skipped.reasons.unaired, 1);
    assert.equal(sonarrWantedIds.skipped.reasons.special, 1);

    const beforeSonarrDryExact = calls.length;
    const sonarrDryExact = await tool("sonarr_search_missing_exact", { dryRun: true });
    assert.equal(sonarrDryExact.dryRun, true);
    assert.equal(sonarrDryExact.totalIds, 260);
    assert.equal(sonarrDryExact.batchCount, 3);
    assert.equal(sonarrDryExact.plannedCommands[0].name, "EpisodeSearch");
    assert.equal(commandBodiesSince(beforeSonarrDryExact).length, 0);

    const beforeSonarrExact = calls.length;
    const sonarrExact = await tool("sonarr_search_missing_exact", { batchSize: 120, dryRun: false });
    assert.equal(sonarrExact.dryRun, false);
    assert.equal(sonarrExact.totalIds, 260);
    assert.equal(sonarrExact.batchCount, 3);
    assert.equal(sonarrExact.queuedCommandIds.length, 3);
    const sonarrExactBodies = commandBodiesSince(beforeSonarrExact);
    assert.deepEqual(sonarrExactBodies.map(body => body.name), ["EpisodeSearch", "EpisodeSearch", "EpisodeSearch"]);
    assert.ok(!sonarrExactBodies.some(body => body.name === "MissingEpisodeSearch"));
    assert.deepEqual(sonarrExactBodies.map(body => body.episodeIds.length), [120, 120, 20]);
    const sonarrExactStatus = await tool("sonarr_command_status", { commandIds: sonarrExact.queuedCommandIds });
    assert.equal(sonarrExactStatus.total, 3);
    assert.equal(sonarrExactStatus.commands[String(sonarrExact.queuedCommandIds[0])].name, "EpisodeSearch");
    assert.equal(sonarrExactStatus.commands[String(sonarrExact.queuedCommandIds[0])].episodeIdCount, 120);

    const radarrPage2 = await tool("radarr_wanted_missing", { page: 2, pageSize: 100 });
    assert.equal(radarrPage2.page, 2);
    assert.equal(radarrPage2.returned, 100);
    assert.equal(radarrPage2.records[0].movieId, 101);

    const radarrWantedIds = await tool("radarr_wanted_missing_ids", {});
    assert.equal(radarrWantedIds.returned, 205);
    assert.equal(radarrWantedIds.movieIds.length, 205);
    assert.equal(radarrWantedIds.skipped.total, 2);
    assert.equal(radarrWantedIds.skipped.reasons.unmonitored, 1);
    assert.equal(radarrWantedIds.skipped.reasons.unavailable, 1);

    const beforeRadarrDryExact = calls.length;
    const radarrDryExact = await tool("radarr_search_missing_exact", { batchSize: 80, dryRun: true });
    assert.equal(radarrDryExact.dryRun, true);
    assert.equal(radarrDryExact.totalIds, 205);
    assert.equal(radarrDryExact.batchCount, 3);
    assert.equal(radarrDryExact.plannedCommands[0].name, "MoviesSearch");
    assert.equal(commandBodiesSince(beforeRadarrDryExact).length, 0);

    const beforeRadarrExact = calls.length;
    const radarrExact = await tool("radarr_search_missing_exact", { batchSize: 80, dryRun: false });
    assert.equal(radarrExact.dryRun, false);
    assert.equal(radarrExact.totalIds, 205);
    assert.equal(radarrExact.batchCount, 3);
    assert.equal(radarrExact.queuedCommandIds.length, 3);
    const radarrExactBodies = commandBodiesSince(beforeRadarrExact);
    assert.deepEqual(radarrExactBodies.map(body => body.name), ["MoviesSearch", "MoviesSearch", "MoviesSearch"]);
    assert.ok(!radarrExactBodies.some(body => body.name === "MissingMoviesSearch"));
    assert.deepEqual(radarrExactBodies.map(body => body.movieIds.length), [80, 80, 45]);
    const radarrExactStatus = await tool("radarr_command_status", { commandIds: radarrExact.queuedCommandIds });
    assert.equal(radarrExactStatus.total, 3);
    assert.equal(radarrExactStatus.commands[String(radarrExact.queuedCommandIds[0])].name, "MoviesSearch");
    assert.equal(radarrExactStatus.commands[String(radarrExact.queuedCommandIds[0])].movieIdCount, 80);

    assert.equal((await tool("sonarr_search_missing")).name, "MissingEpisodeSearch");
    assert.deepEqual(lastCall().body, { name: "MissingEpisodeSearch" });
    assert.equal((await tool("radarr_search_missing")).name, "MissingMoviesSearch");
    assert.deepEqual(lastCall().body, { name: "MissingMoviesSearch" });
    await tool("sonarr_search_cutoff_unmet");
    assert.deepEqual(lastCall().body, { name: "CutoffUnmetEpisodeSearch" });
    await tool("radarr_search_cutoff_unmet");
    assert.deepEqual(lastCall().body, { name: "CutoffUnmetMoviesSearch" });
    await tool("sonarr_search_episode", { episodeIds: [101, 102] });
    assert.deepEqual(lastCall().body, { name: "EpisodeSearch", episodeIds: [101, 102] });
    await tool("radarr_search_movie", { movieIds: [201] });
    assert.deepEqual(lastCall().body, { name: "MoviesSearch", movieIds: [201] });
    await tool("sonarr_search_series", { seriesId: 10 });
    assert.deepEqual(lastCall().body, { name: "SeriesSearch", seriesId: 10 });
    await tool("sonarr_search_season", { seriesId: 10, seasonNumber: 2 });
    assert.deepEqual(lastCall().body, { name: "SeasonSearch", seriesId: 10, seasonNumber: 2 });
    await tool("sonarr_rescan_series", { seriesId: 10 });
    assert.deepEqual(lastCall().body, { name: "RescanSeries", seriesId: 10 });
    await tool("radarr_refresh_movie", {});
    assert.deepEqual(lastCall().body, { name: "RefreshMovie" });

    const beforeInvalid = calls.length;
    const invalid = await rpc("tools/call", { name: "sonarr_search_episode", arguments: { episodeIds: [0] } });
    assert.ok(invalid.error || invalid.result?.isError, "invalid ID should be rejected");
    assert.equal(calls.length, beforeInvalid, "invalid ID call reached Arr");

    const beforeDryRename = calls.length;
    const dryRename = await tool("sonarr_rename_files", { seriesId: 10, files: [9001], dryRun: true });
    assert.deepEqual(dryRename.command, { name: "RenameFiles", seriesId: 10, files: [9001] });
    assert.equal(calls.length, beforeDryRename);
    await tool("radarr_rename_files", { movieId: 20, files: [8001], dryRun: false });
    assert.deepEqual(lastCall().body, { name: "RenameFiles", movieId: 20, files: [8001] });

    const dryScan = await tool("sonarr_download_client_scan", {
      path: "/downloads/show",
      downloadClientId: "abc",
      importMode: "move",
      dryRun: true
    });
    assert.deepEqual(dryScan.command, {
      name: "DownloadedEpisodesScan",
      path: "/downloads/show",
      downloadClientId: "abc",
      importMode: "move"
    });
    const sonarrScan = await tool("sonarr_download_client_scan", {
      path: "/downloads/show",
      downloadClientId: "abc",
      importMode: "move",
      dryRun: false
    });
    assert.equal(sonarrScan.commandId > 0, true);
    assert.deepEqual(lastCall().body, {
      name: "DownloadedEpisodesScan",
      path: "/downloads/show",
      downloadClientId: "abc",
      importMode: "move"
    });
    const radarrScan = await tool("radarr_download_client_scan", {
      path: "/downloads/movie",
      downloadClientId: "def",
      sendUpdates: true,
      dryRun: false
    });
    assert.equal(radarrScan.commandId > 0, true);
    assert.deepEqual(lastCall().body, {
      name: "DownloadedMoviesScan",
      path: "/downloads/movie",
      downloadClientId: "def",
      sendUpdates: true
    });

    const sonarrReleases = await tool("sonarr_interactive_search_episode", { episodeId: 101, limit: 5 });
    assert.equal(sonarrReleases.records[0].guid, "sonarr-guid");
    assert.equal(sonarrReleases.records[0].downloadUrl, undefined);
    assert.deepEqual(lastCall().query, { episodeId: "101" });
    const radarrReleases = await tool("radarr_interactive_search_movie", { movieId: 201, limit: 5 });
    assert.equal(radarrReleases.records[0].guid, "radarr-guid");
    assert.deepEqual(lastCall().query, { movieId: "201" });

    const beforeDryGrab = postReleaseCallCount();
    const dryGrab = await tool("sonarr_grab_release", { guid: "sonarr-guid", indexerId: 11, dryRun: true });
    assert.equal(dryGrab.dryRun, true);
    assert.equal(postReleaseCallCount(), beforeDryGrab);
    const grab = await tool("sonarr_grab_release", { guid: "sonarr-guid", indexerId: 11, dryRun: false });
    assert.deepEqual(lastCall().body, { guid: "sonarr-guid", indexerId: 11 });
    assert.equal(grab.result.downloadUrl, "[redacted]");

    const beforeDryCancel = calls.length;
    const dryCancel = await tool("sonarr_command_cancel", { commandId: 777, dryRun: true });
    assert.equal(dryCancel.wouldCancelCommandId, 777);
    assert.equal(calls.length, beforeDryCancel);
    await tool("radarr_command_cancel", { commandId: 778, dryRun: false });
    assert.equal(lastCall().method, "DELETE");
    assert.equal(lastCall().path, "command/778");

    const historyDetail = await tool("nzbget_history_detail", { nzbId: 70001, includeLog: true, logLimit: 10 });
    assert.equal(historyDetail.record.NZBID, 70001);
    assert.equal(historyDetail.record.UnpackStatus, "NONE");
    assert.equal(historyDetail.record.Log.length, 2);
    assert.equal(historyDetail.log.length, 2);

    const downloadFiles = await tool("nzbget_download_files", { downloadId: "example-archive-drone-id" });
    assert.equal(downloadFiles.record.nzbId, 70001);
    assert.equal(downloadFiles.records.length, 2);
    assert.equal(downloadFiles.archiveSummary.hasArchives, true);
    assert.equal(downloadFiles.archiveSummary.rootCount, 1);

    const retryDryRun = await tool("nzbget_retry_postprocess", { nzbId: 70001, dryRun: true });
    assert.equal(retryDryRun.dryRun, true);
    assert.equal(retryDryRun.matchedRecord.NZBID, 70001);
    assert.deepEqual(retryDryRun.apiCall.params, ["HistoryProcess", 0, [70001]]);
    assert.equal(retryDryRun.apiCall.display, "editqueue(\"HistoryProcess\", 0, [70001])");

    const retryExec = await tool("nzbget_retry_postprocess", { downloadId: "example-archive-drone-id", dryRun: false });
    assert.equal(retryExec.dryRun, false);
    assert.equal(retryExec.result, true);
    assert.equal(lastCall().service, "nzbget");
    assert.equal(lastCall().path, "editqueue");
    assert.deepEqual(lastCall().params, ["HistoryProcess", 0, [70001]]);

    const ambiguousMessage = await toolError("nzbget_retry_postprocess", { name: "Ambiguous.Release", dryRun: true });
    assert.match(ambiguousMessage, /ambiguous/i);
    const deletedMessage = await toolError("nzbget_retry_postprocess", { name: "Deleted.Release", dryRun: false });
    assert.match(deletedMessage, /deleted/i);

    const archiveDiagnosis = await tool("download_client_archive_diagnosis", { service: "sonarr", queueId: 1006, logLimit: 10 });
    assert.equal(archiveDiagnosis.nzbget.record.NZBID, 70001);
    assert.equal(archiveDiagnosis.archiveDiagnosis.hasArchives, true);
    assert.equal(archiveDiagnosis.archiveDiagnosis.unpackStatus, "NONE");
    assert.equal(archiveDiagnosis.blockers[0].type, "archives_still_present");

    const extractDryRun = await tool("nzbget_extract_archives", { nzbId: 70001, dryRun: true });
    assert.equal(extractDryRun.dryRun, true);
    assert.equal(extractDryRun.archiveRoots.length, 1);
    assert.equal(extractDryRun.plan[0].command, "unrar");
    assert.deepEqual(extractDryRun.plan[0].args.slice(0, 2), ["x", "-o-"]);

    const filesystemExtractDryRun = await tool("nzbget_extract_archives", { nzbId: 70002, dryRun: true });
    assert.equal(filesystemExtractDryRun.dryRun, true);
    assert.equal(filesystemExtractDryRun.archiveSource, "filesystem");
    assert.equal(filesystemExtractDryRun.localDestDir, mappedArchiveDir);
    assert.deepEqual(filesystemExtractDryRun.archiveRoots.map(root => path.basename(root)).sort(), [
      "archive.bundle.s01e01.rar",
      "archive.bundle.s01e02.part01.rar"
    ]);
    assert.ok(!filesystemExtractDryRun.archiveRoots.some(root => root.endsWith(".r00") || root.endsWith(".part02.rar")));

    const archiveEnvironment = await tool("media_archive_environment_check", { downloadsPath: "/downloads", writeTest: false });
    assert.equal(archiveEnvironment.visiblePath, tempRoot);
    assert.equal(archiveEnvironment.writeCheck.skipped, true);
    assert.ok(Array.isArray(archiveEnvironment.blockers));

    const queue = await tool("sonarr_queue", { limit: 5 });
    const escapedQueueItem = queue.records.find(record => record.id === 1003);
    assert.equal(escapedQueueItem.title, "A & B.Show.S01E02.1080p-GRP");
    assert.equal(escapedQueueItem.titleRaw, "A &amp; B.Show.S01E02.1080p-GRP");
    assert.equal(escapedQueueItem.outputPath, "/downloads/usenet/completed/Series/A & B.Show.S01E02.1080p-GRP");
    assert.equal(escapedQueueItem.outputPathRaw, "/downloads/usenet/completed/Series/A &amp; B.Show.S01E02.1080p-GRP");

    const singleEpisode = await tool("sonarr_manual_import_candidates", { queueId: 1001, limit: 5 });
    assert.equal(singleEpisode.records.length, 1);
    assert.equal(singleEpisode.records[0].path, "/downloads/usenet/completed/Series/Show.S01E01.1080p-GRP/Show.S01E01.1080p-GRP.mkv");
    assert.deepEqual(singleEpisode.records[0].episodeIds, [101]);
    assert.equal(singleEpisode.records[0].seriesId, 10);
    assert.equal(singleEpisode.records[0].releaseGroup, "GRP");
    assert.equal(singleEpisode.records[0].releaseType, "singleEpisode");
    assert.equal(singleEpisode.records[0].safeToImport, true);

    const seasonPack = await tool("sonarr_manual_import_candidates", { queueId: 1002, limit: 5 });
    assert.equal(seasonPack.records.length, 2);
    assert.deepEqual(seasonPack.records.map(record => record.episodeIds[0]), [101, 102]);
    assert.ok(seasonPack.records.every(record => record.safeToImport));

    const ampPath = await tool("sonarr_manual_import_candidates", { queueId: 1003, limit: 5 });
    assert.equal(ampPath.queueRecord.outputPathRaw, "/downloads/usenet/completed/Series/A &amp; B.Show.S01E02.1080p-GRP");
    assert.equal(ampPath.queueRecord.outputPath, "/downloads/usenet/completed/Series/A & B.Show.S01E02.1080p-GRP");
    assert.equal(ampPath.query.folder, "/downloads/usenet/completed/Series/A & B.Show.S01E02.1080p-GRP");
    assert.equal(ampPath.records[0].path, "/downloads/usenet/completed/Series/A & B.Show.S01E02.1080p-GRP/A & B.Show.S01E02.1080p-GRP.mkv");

    const intermediate = await tool("sonarr_manual_import_candidates", { queueId: 1004, limit: 5 });
    assert.equal(intermediate.records[0].path, "/downloads/usenet/intermediate/Series/Show.S01E03.1080p-GRP/Show.S01E03.1080p-GRP.mkv");
    assert.equal(intermediate.records[0].safeToImport, true);

    const libraryBug = await tool("sonarr_manual_import_candidates", { queueId: 1005, limit: 5 });
    assert.equal(libraryBug.records.length, 0);
    assert.equal(libraryBug.apiBug.rejectedCount, 1);
    assert.equal(libraryBug.blockers[0].likelyLibraryPath, true);
    assert.equal(libraryBug.blockers[0].candidate.path, "/tv/Show/Season 01/Show.S01E04.mkv");

    const movie = await tool("radarr_manual_import_candidates", { queueId: 2001, limit: 5 });
    assert.equal(movie.records.length, 1);
    assert.equal(movie.records[0].movieId, 20);
    assert.equal(movie.records[0].path, "/downloads/usenet/completed/Movies/Movie.2025.1080p-GRP/Movie.2025.1080p-GRP.mkv");
    assert.equal(movie.records[0].releaseGroup, "GRP");
    assert.equal(movie.records[0].releaseType, "movie");
    assert.equal(movie.records[0].safeToImport, true);

    const radarrLibraryBug = await tool("radarr_manual_import_candidates", { queueId: 2002, limit: 5 });
    assert.equal(radarrLibraryBug.records.length, 0);
    assert.equal(radarrLibraryBug.blockers[0].likelyLibraryPath, true);
    assert.equal(radarrLibraryBug.blockers[0].candidate.path, "/movies/Movie Library Bug (2025)/Movie Library Bug.mkv");

    const queueFiles = await tool("sonarr_queue_item_files", { queueId: 1001, limit: 5 });
    assert.equal(queueFiles.filesystem.files.length, 1);
    assert.equal(queueFiles.manualImportCandidates.records[0].safeToImport, true);

    const importDryRun = await tool("sonarr_import_queue_item", { queueId: 1001, importMode: "move", dryRun: true });
    assert.equal(importDryRun.dryRun, true);
    assert.equal(importDryRun.imported.length, 1);
    assert.equal(importDryRun.command.name, "ManualImport");
    assert.equal(importDryRun.command.files[0].path, "/downloads/usenet/completed/Series/Show.S01E01.1080p-GRP/Show.S01E01.1080p-GRP.mkv");

    const beforeLibraryImport = calls.length;
    const blockedImport = await tool("sonarr_import_queue_item", { queueId: 1005, dryRun: false });
    assert.equal(blockedImport.imported.length, 0);
    assert.equal(blockedImport.blockers[0].type, "candidate_outside_queue_path");
    assert.equal(calls.length, beforeLibraryImport + 2);
    assert.notEqual(lastCall().path, "command");

    const movieImport = await tool("radarr_import_queue_item", { queueId: 2001, dryRun: false });
    assert.equal(movieImport.commandId > 0, true);
    assert.equal(lastCall().path, "command");
    assert.equal(lastCall().body.name, "ManualImport");
    assert.equal(lastCall().body.files[0].movieId, 20);

    const candidates = await tool("sonarr_manual_import_candidates", { path: "/downloads/show", limit: 5 });
    assert.equal(candidates.records[0].safeToImport, true);
    const directImportDryRun = await tool("radarr_manual_import", {
      files: [{ path: "/downloads/movie/movie.mkv", movieId: 20 }],
      dryRun: true
    });
    assert.equal(directImportDryRun.command.name, "ManualImport");
  } finally {
    child.kill("SIGTERM");
    mock.close();
    await once(mock, "close");
    await rm(tempRoot, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log("arr command/manual import tools tests passed");
}).catch(error => {
  console.error(error);
  process.exit(1);
});
