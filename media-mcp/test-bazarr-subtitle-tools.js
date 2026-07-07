import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "media-mcp-subtitles-"));
  const calls = [];
  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", chunk => {
        data += chunk;
      });
      req.on("end", () => resolve(data ? JSON.parse(data) : undefined));
      req.on("error", reject);
    });
    calls.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: req.headers
    });

    if (req.method === "GET" && url.pathname === "/plex/library/metadata/900001") {
      assert.equal(req.headers["x-plex-token"], "plex-token");
      return sendJson(res, 200, {
        MediaContainer: {
          Metadata: [{
            ratingKey: "900001",
            key: "/library/metadata/900001",
            guid: "plex://movie/fixture",
            Guid: [{ id: "tmdb://98765" }],
            type: "movie",
            title: "Fixture Movie",
            year: 2026,
            librarySectionTitle: "Movies",
            Media: [{
              id: 1,
              Part: [{
                id: 2,
                Stream: [
                  { id: 10, streamType: 1, codec: "h264" },
                  { id: 11, streamType: 2, codec: "aac", languageCode: "eng", language: "English" },
                  { id: 12, streamType: 3, codec: "srt", languageCode: "kor", language: "Korean", title: "Korean" }
                ]
              }]
            }]
          }]
        }
      });
    }
    if (req.method === "PUT" && url.pathname === "/plex/library/metadata/900001/refresh") {
      assert.equal(req.headers["x-plex-token"], "plex-token");
      return sendJson(res, 200, { refreshed: true });
    }
    if (req.method === "PUT" && url.pathname === "/plex/library/metadata/900001/analyze") {
      assert.equal(req.headers["x-plex-token"], "plex-token");
      return sendJson(res, 200, { analyzed: true });
    }
    if (req.method === "GET" && url.pathname === "/radarr/api/v3/movie") {
      assert.equal(req.headers["x-api-key"], "radarr-key");
      return sendJson(res, 200, [{
        id: 44,
        title: "Fixture Movie",
        year: 2026,
        tmdbId: 98765,
        monitored: true,
        hasFile: true,
        path: "/movies/fixture-private-path"
      }]);
    }
    if (req.method === "PATCH" && url.pathname === "/bazarr/api/movies/subtitles") {
      assert.equal(req.headers["x-api-key"], "bazarr-key");
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        radarrid: "44",
        language: "ko",
        forced: "false",
        hi: "false"
      });
      res.writeHead(204);
      res.end();
      return;
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
      MEDIA_MCP_STATE_DIR: stateDir,
      PLEX_URL: `http://127.0.0.1:${mockPort}/plex`,
      PLEX_TOKEN: "plex-token",
      RADARR_URL: `http://127.0.0.1:${mockPort}/radarr`,
      RADARR_API_KEY: "radarr-key",
      BAZARR_URL: `http://127.0.0.1:${mockPort}/bazarr`,
      BAZARR_API_KEY: "bazarr-key"
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
        authorization: ["Bearer", "test-token"].join(" "),
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

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fetch(baseUrl, { headers: { authorization: ["Bearer", "test-token"].join(" "), accept: "application/json, text/event-stream" } });
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bazarr-subtitle-test", version: "1" }
    });
    await rpc("notifications/initialized", {}, false);

    const tools = await rpc("tools/list");
    const toolNames = new Set(tools.result.tools.map(toolInfo => toolInfo.name));
    assert.ok(toolNames.has("bazarr_download_movie_subtitles_for_plex"));
    assert.ok(toolNames.has("plex_refresh_metadata"));
    assert.ok(toolNames.has("plex_analyze_metadata"));
    assert.ok(toolNames.has("plex_verify_subtitle_track"));

    const dryRun = await tool("bazarr_download_movie_subtitles_for_plex", {
      plexRatingKey: "900001",
      language: "ko",
      dryRun: true
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.radarrMovie.id, 44);
    assert.equal(dryRun.radarrMovie.path, undefined);
    assert.equal(dryRun.endpoint.query.radarrid, 44);
    assert.equal(calls.filter(call => call.method === "PATCH" && call.path === "/bazarr/api/movies/subtitles").length, 0);

    const downloaded = await tool("bazarr_download_movie_subtitles_for_plex", {
      plexRatingKey: "900001",
      language: "ko",
      dryRun: false
    });
    assert.equal(downloaded.dryRun, false);
    assert.equal(downloaded.radarrMovie.id, 44);
    assert.equal(calls.filter(call => call.method === "PATCH" && call.path === "/bazarr/api/movies/subtitles").length, 1);

    const refreshed = await tool("plex_refresh_metadata", { ratingKey: "900001", dryRun: false });
    assert.equal(refreshed.dryRun, false);
    assert.deepEqual(refreshed.result, { refreshed: true });
    const analyzeDryRun = await tool("plex_analyze_metadata", { ratingKey: "900001", dryRun: true });
    assert.equal(analyzeDryRun.dryRun, true);
    assert.equal(calls.filter(call => call.method === "PUT" && call.path.endsWith("/analyze")).length, 0);

    const verified = await tool("plex_verify_subtitle_track", { ratingKey: "900001", language: "ko" });
    assert.equal(verified.found, true);
    assert.equal(verified.subtitleCount, 1);
    assert.equal(verified.matches[0].languageCode, "kor");
  } finally {
    child.kill("SIGTERM");
    mock.close();
    await once(mock, "close");
    await rm(stateDir, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log("bazarr subtitle tool tests passed");
}).catch(error => {
  console.error(error);
  process.exit(1);
});
