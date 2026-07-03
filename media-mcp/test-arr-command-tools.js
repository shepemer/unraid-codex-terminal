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
  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const [service] = url.pathname.split("/").filter(Boolean);
    const path = url.pathname.replace(`/${service}/api/v3/`, "");
    const body = await readJson(req);
    calls.push({ service, method: req.method, path, query: Object.fromEntries(url.searchParams), body });

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
      return sendJson(res, 200, []);
    }
    if (req.method === "GET" && path === "manualimport") {
      return sendJson(res, 200, service === "sonarr" ? [{
        id: 1,
        path: "/downloads/show/episode.mkv",
        series: { id: 10, title: "Show" },
        episodes: [{ id: 101, seasonNumber: 1, episodeNumber: 2, title: "Episode" }],
        quality: { quality: { name: "HDTV-1080p" } },
        languages: [{ name: "English" }],
        rejections: []
      }] : [{
        id: 2,
        path: "/downloads/movie/movie.mkv",
        movie: { id: 20, title: "Movie" },
        quality: { quality: { name: "Bluray-1080p" } },
        languages: [{ name: "English" }],
        rejections: []
      }]);
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
      RADARR_API_KEY: "radarr-key"
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
      "radarr_interactive_search_movie",
      "radarr_grab_release",
      "radarr_download_client_scan",
      "radarr_command_cancel"
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
    await tool("radarr_download_client_scan", {
      path: "/downloads/movie",
      downloadClientId: "def",
      sendUpdates: true,
      dryRun: false
    });
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

    const candidates = await tool("sonarr_manual_import_candidates", { path: "/downloads/show", limit: 5 });
    assert.equal(candidates.records[0].safeToImport, true);
    const importDryRun = await tool("radarr_manual_import", {
      files: [{ path: "/downloads/movie/movie.mkv", movieId: 20 }],
      dryRun: true
    });
    assert.equal(importDryRun.command.name, "ManualImport");
  } finally {
    child.kill("SIGTERM");
    mock.close();
    await once(mock, "close");
  }
}

run().then(() => {
  console.log("arr command tools tests passed");
}).catch(error => {
  console.error(error);
  process.exit(1);
});
