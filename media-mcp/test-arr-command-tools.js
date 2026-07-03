import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";

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
    if (req.method === "POST" && path === "command") {
      return sendJson(res, 200, {
        id: ++commandId,
        name: body.name,
        status: "queued",
        queued: "2026-07-02T00:00:00Z",
        body
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
      NZBGET_PASSWORD: "tegbzn6789"
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
      "radarr_search_missing",
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
      "nzbget_history_detail",
      "nzbget_download_files",
      "nzbget_retry_postprocess",
      "download_client_archive_diagnosis",
      "nzbget_extract_archives"
    ]) {
      assert.ok(toolNames.has(name), `missing tool ${name}`);
    }

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
  }
}

run().then(() => {
  console.log("arr command/manual import tools tests passed");
}).catch(error => {
  console.error(error);
  process.exit(1);
});
