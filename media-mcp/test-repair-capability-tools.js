import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
    });
    req.on("end", () => resolve(data ? JSON.parse(data) : undefined));
    req.on("error", reject);
  });
}

async function run() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "media-mcp-repair-capabilities-"));
  const mediaRoot = path.join(tempRoot, "media");
  const movieDir = path.join(mediaRoot, "Fixture Movie (2026)");
  const movieFile = path.join(movieDir, "Fixture Movie.mkv");
  const deleteDir = path.join(mediaRoot, "Delete Fixture (2026)");
  const deleteFile = path.join(deleteDir, "Delete Fixture.mkv");
  const tvDir = path.join(mediaRoot, "Fixture Series", "Season 13");
  const episodeFile = path.join(tvDir, "Fixture Series - S13E03.mkv");
  const compareEpisodeFile = path.join(tvDir, "Fixture Series - S13E03.compare.mkv");
  const hangingProbeFile = path.join(tvDir, "Fixture Series - S13E04.hang.mkv");
  const plexRoot = path.join(tempRoot, "plex-root");
  const plexTvDir = path.join(plexRoot, "tv", "Fixture Series", "Season 13");
  const plexMappedEpisodeFile = path.join(plexTvDir, "Fixture Series - S13E03.mkv");
  const fakeBinDir = path.join(tempRoot, "bin");
  await mkdir(movieDir, { recursive: true });
  await mkdir(deleteDir, { recursive: true });
  await mkdir(tvDir, { recursive: true });
  await mkdir(plexTvDir, { recursive: true });
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(movieFile, "movie fixture\n");
  await writeFile(deleteFile, "delete fixture\n");
  await writeFile(episodeFile, "episode fixture\n");
  await writeFile(compareEpisodeFile, "compare fixture\n");
  await writeFile(hangingProbeFile, "hanging fixture\n");
  await writeFile(plexMappedEpisodeFile, "episode fixture\n");
  const fakeFfprobe = path.join(fakeBinDir, "ffprobe");
  await writeFile(fakeFfprobe, [
    "#!/usr/bin/env node",
    "if (process.argv.at(-1).includes('.hang.')) {",
    "  setTimeout(() => {}, 5000);",
    "} else {",
    "process.stdout.write(JSON.stringify({",
    "  format: { filename: process.argv.at(-1), tags: { title: 'Embedded Fixture Title' } },",
    "  streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, tags: { title: 'Video Track Title' } }]",
    "}));",
    "}"
  ].join("\n"));
  await chmod(fakeFfprobe, 0o700);
  const fakeFfmpeg = path.join(fakeBinDir, "ffmpeg");
  await writeFile(fakeFfmpeg, [
    "#!/usr/bin/env node",
    "const buffer = Buffer.alloc(64);",
    "for (let index = 0; index < 64; index += 1) buffer[index] = index;",
    "process.stdout.write(buffer);"
  ].join("\n"));
  await chmod(fakeFfmpeg, 0o700);

  const calls = [];
  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = await readBody(req);
    calls.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: req.headers
    });

    if (url.pathname.startsWith("/plex")) {
      assert.equal(req.headers["x-plex-token"], "plex-token");
    }
    if (url.pathname.startsWith("/radarr")) {
      assert.equal(req.headers["x-api-key"], "radarr-key");
    }
    if (url.pathname.startsWith("/sonarr")) {
      assert.equal(req.headers["x-api-key"], "sonarr-key");
    }

    if (req.method === "DELETE" && url.pathname === "/plex/library/metadata/900001") {
      return sendJson(res, 200, { deleted: true, ratingKey: "900001" });
    }
    if (req.method === "GET" && url.pathname === "/plex/library/metadata/season-13/children") {
      return sendJson(res, 200, {
        MediaContainer: {
          Metadata: [{
            ratingKey: "episode-1301",
            key: "/library/metadata/episode-1301",
            type: "episode",
            grandparentTitle: "Fixture Series",
            parentTitle: "Season 13",
            title: "Building Fixture",
            parentIndex: 13,
            index: 3,
            Media: [{
              id: 501,
              videoResolution: "1080",
              videoCodec: "h264",
              audioCodec: "aac",
              Part: [{
                id: 6001,
                key: "/library/parts/6001/file.mkv",
                file: "/tv/Fixture Series/Season 13/Fixture Series - S13E03.mkv",
                size: 16,
                Stream: [{ id: 1, streamType: 1, codec: "h264", width: 1920, height: 1080 }]
              }]
            }]
          }]
        }
      });
    }
    if (req.method === "GET" && url.pathname === "/plex/library/metadata/show-55/children") {
      return sendJson(res, 200, {
        MediaContainer: {
          Metadata: [{
            ratingKey: "season-13",
            key: "/library/metadata/season-13",
            type: "season",
            title: "Season 13",
            parentTitle: "Fixture Series",
            parentRatingKey: "show-55",
            index: 13,
            librarySectionID: "2",
            librarySectionTitle: "TV",
            leafCount: 12,
            viewedLeafCount: 1
          }]
        }
      });
    }
    if (req.method === "GET" && url.pathname === "/plex/library/metadata/episode-1301") {
      return sendJson(res, 200, {
        MediaContainer: {
          Metadata: [{
            ratingKey: "episode-1301",
            type: "episode",
            title: "Building Fixture",
            librarySectionID: "2",
            librarySectionTitle: "TV",
            Media: [{
              id: 501,
              Part: [{
                id: 6001,
                file: "/tv/Fixture Series/Season 13/Fixture Series - S13E03.mkv",
                Stream: [{ id: 1, streamType: 1, codec: "h264", width: 1920, height: 1080 }]
              }]
            }]
          }]
        }
      });
    }
    if (req.method === "PUT" && url.pathname === "/plex/library/sections/2/refresh") {
      assert.deepEqual(Object.fromEntries(url.searchParams), { path: "/tv/Fixture Series/Season 13" });
      return sendJson(res, 200, { refreshed: true, sectionKey: "2" });
    }
    if (req.method === "PUT" && url.pathname === "/plex/library/metadata/episode-1301/refresh") {
      return sendJson(res, 200, { refreshed: true, ratingKey: "episode-1301" });
    }
    if (req.method === "PUT" && url.pathname === "/plex/library/metadata/episode-1301/analyze") {
      return sendJson(res, 200, { analyzed: true, ratingKey: "episode-1301" });
    }
    if (req.method === "PUT" && url.pathname === "/plex/library/sections/1/refresh") {
      assert.deepEqual(Object.fromEntries(url.searchParams), { path: "/movies/Fixture Movie (2026)" });
      return sendJson(res, 200, { refreshed: true, sectionKey: "1" });
    }
    if (req.method === "PUT" && url.pathname === "/plex/library/sections/1/emptyTrash") {
      return sendJson(res, 200, { emptied: true, sectionKey: "1" });
    }
    if (req.method === "GET" && url.pathname === "/radarr/api/v3/moviefile/700") {
      return sendJson(res, 200, {
        id: 700,
        movieId: 44,
        path: "/movies/Fixture Movie (2026)/Fixture Movie.mkv",
        relativePath: "Fixture Movie.mkv",
        size: 14,
        dateAdded: "2026-01-01T00:00:00Z",
        quality: { quality: { name: "HD-1080p" } }
      });
    }
    if (req.method === "DELETE" && url.pathname === "/radarr/api/v3/moviefile/700") {
      assert.deepEqual(Object.fromEntries(url.searchParams), { deleteFiles: "true" });
      return sendJson(res, 200, { deleted: true, movieFileId: 700 });
    }
    if (req.method === "GET" && url.pathname === "/sonarr/api/v3/episode") {
      assert.equal(url.searchParams.get("seriesId"), "55");
      return sendJson(res, 200, [{
        id: 1301,
        seriesId: 55,
        seasonNumber: 13,
        episodeNumber: 3,
        title: "Building Fixture",
        hasFile: true,
        monitored: true,
        episodeFileId: 800,
        sceneSeasonNumber: 13,
        sceneEpisodeNumber: 3
      }]);
    }
    if (req.method === "GET" && url.pathname === "/sonarr/api/v3/history") {
      assert.equal(url.searchParams.get("episodeId"), "1301");
      return sendJson(res, 200, {
        page: 1,
        pageSize: 5,
        records: [{
          id: 9001,
          episodeId: 1301,
          seriesId: 55,
          eventType: "downloadFolderImported",
          date: "2026-01-01T00:00:00Z",
          sourceTitle: "Fixture.Series.S13E03.1080p"
        }]
      });
    }
    if (req.method === "GET" && url.pathname === "/sonarr/api/v3/episodefile/800") {
      return sendJson(res, 200, {
        id: 800,
        seriesId: 55,
        seasonNumber: 13,
        relativePath: "Season 13/Fixture Series - S13E03.mkv",
        path: "/tv/Fixture Series/Season 13/Fixture Series - S13E03.mkv",
        size: 16,
        quality: { quality: { name: "HD-1080p" } },
        customFormats: [{ id: 1, name: "Fixture Format" }],
        customFormatScore: 10,
        mediaInfo: { videoCodec: "h264", audioCodec: "aac" }
      });
    }
    if (req.method === "DELETE" && url.pathname === "/sonarr/api/v3/episodefile/800") {
      assert.deepEqual(Object.fromEntries(url.searchParams), { deleteFiles: "true" });
      return sendJson(res, 200, { deleted: true, episodeFileId: 800 });
    }
    if (req.method === "POST" && url.pathname === "/sonarr/api/v3/command") {
      assert.deepEqual(body, { name: "EpisodeSearch", episodeIds: [1301] });
      return sendJson(res, 200, { id: 9100, name: "EpisodeSearch", episodeIds: [1301] });
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
      MEDIA_MCP_PATH_MAPS: `/movies=${mediaRoot},/tv=${mediaRoot}`,
      MEDIA_MCP_MEDIA_ROOTS: `${mediaRoot},${plexRoot}`,
      MEDIA_MCP_MEDIA_PROBE_COMMAND_TIMEOUT_MS: "1000",
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ""}`,
      PLEX_URL: `http://127.0.0.1:${mockPort}/plex`,
      PLEX_TOKEN: "plex-token",
      RADARR_URL: `http://127.0.0.1:${mockPort}/radarr`,
      RADARR_API_KEY: "radarr-key",
      SONARR_URL: `http://127.0.0.1:${mockPort}/sonarr`,
      SONARR_API_KEY: "sonarr-key"
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
      clientInfo: { name: "repair-capability-test", version: "1" }
    });
    await rpc("notifications/initialized", {}, false);

    const tools = await rpc("tools/list");
    const toolNames = new Set(tools.result.tools.map(toolInfo => toolInfo.name));
    assert.ok(toolNames.has("media_file_delete"));
    assert.ok(toolNames.has("media_probe_video_content"));
    assert.ok(toolNames.has("plex_delete_metadata"));
    assert.ok(toolNames.has("plex_list_show_seasons"));
    assert.ok(toolNames.has("plex_list_season_children"));
    assert.ok(toolNames.has("plex_scan_library_path"));
    assert.ok(toolNames.has("radarr_delete_movie_file"));
    assert.ok(toolNames.has("sonarr_list_episodes"));
    assert.ok(toolNames.has("sonarr_replace_episode_files"));

    const dryFileDelete = await tool("media_file_delete", {
      path: "/movies/Delete Fixture (2026)/Delete Fixture.mkv",
      dryRun: true
    });
    assert.equal(dryFileDelete.dryRun, true);
    assert.equal(dryFileDelete.deleted, false);
    assert.equal(dryFileDelete.resolvedPath, deleteFile);
    assert.equal(dryFileDelete.file.size, 15);

    const outside = await tool("media_file_delete", {
      path: "/outside/not-allowed.mkv",
      dryRun: true
    });
    assert.equal(outside.deleted, false);
    assert.equal(outside.blockers[0].type, "path_outside_allowed_roots");

    const deleted = await tool("media_file_delete", {
      path: "/movies/Delete Fixture (2026)/Delete Fixture.mkv",
      expectedSize: 15,
      dryRun: false
    });
    assert.equal(deleted.deleted, true);
    await assert.rejects(() => access(deleteFile));

    const radarrDry = await tool("radarr_delete_movie_file", {
      movieFileId: 700,
      movieId: 44,
      expectedPath: movieFile,
      dryRun: true
    });
    assert.equal(radarrDry.dryRun, true);
    assert.equal(radarrDry.noSearch, true);
    assert.equal(radarrDry.searchQueued, false);
    assert.equal(radarrDry.movieFile.id, 700);
    assert.equal(calls.filter(call => call.method === "DELETE" && call.path === "/radarr/api/v3/moviefile/700").length, 0);

    const radarrMismatch = await tool("radarr_delete_movie_file", {
      movieFileId: 700,
      movieId: 99,
      dryRun: true
    });
    assert.equal(radarrMismatch.blockers[0].type, "movie_id_mismatch");

    const radarrDeleted = await tool("radarr_delete_movie_file", {
      movieFileId: 700,
      movieId: 44,
      expectedPath: "/movies/Fixture Movie (2026)/Fixture Movie.mkv",
      dryRun: false
    });
    assert.equal(radarrDeleted.dryRun, false);
    assert.equal(radarrDeleted.result.deleted, true);
    assert.equal(calls.filter(call => call.method === "DELETE" && call.path === "/radarr/api/v3/moviefile/700").length, 1);

    const sonarrEpisodes = await tool("sonarr_list_episodes", {
      seriesId: 55,
      seasonNumber: 13,
      includeHistory: true
    });
    assert.equal(sonarrEpisodes.total, 1);
    assert.equal(sonarrEpisodes.episodes[0].id, 1301);
    assert.equal(sonarrEpisodes.episodes[0].episodeFile.id, 800);
    assert.equal(sonarrEpisodes.episodes[0].customFormatScore, 10);
    assert.equal(sonarrEpisodes.episodes[0].recentHistory[0].sourceTitle, "Fixture.Series.S13E03.1080p");

    const sonarrDry = await tool("sonarr_replace_episode_files", {
      episodeFileIds: [800],
      seriesId: 55,
      expectedPaths: ["/tv/Fixture Series/Season 13/Fixture Series - S13E03.mkv"],
      dryRun: true
    });
    assert.equal(sonarrDry.dryRun, true);
    assert.equal(sonarrDry.deleted, false);
    assert.equal(sonarrDry.searchQueued, false);
    assert.deepEqual(sonarrDry.episodeIds, [1301]);
    assert.deepEqual(sonarrDry.searchCommand, { name: "EpisodeSearch", episodeIds: [1301] });
    assert.equal(calls.filter(call => call.method === "DELETE" && call.path === "/sonarr/api/v3/episodefile/800").length, 0);

    const sonarrMismatch = await tool("sonarr_replace_episode_files", {
      episodeFileIds: [800],
      seriesId: 99,
      dryRun: true
    });
    assert.equal(sonarrMismatch.blockers[0].type, "series_id_mismatch");

    const sonarrEpisodeIdMismatch = await tool("sonarr_replace_episode_files", {
      episodeFileIds: [800],
      seriesId: 55,
      episodeIds: [9999],
      dryRun: true
    });
    assert.equal(sonarrEpisodeIdMismatch.deleted, false);
    assert.equal(sonarrEpisodeIdMismatch.searchQueued, false);
    assert.equal(sonarrEpisodeIdMismatch.blockers.some(blocker => blocker.type === "episode_id_mismatch"), true);
    assert.deepEqual(sonarrEpisodeIdMismatch.blockers.find(blocker => blocker.type === "episode_id_mismatch").derivedEpisodeIds, [1301]);

    const sonarrLookupFailure = await tool("sonarr_replace_episode_files", {
      episodeFileIds: [999],
      episodeIds: [1301],
      dryRun: true
    });
    assert.equal(sonarrLookupFailure.deleted, false);
    assert.equal(sonarrLookupFailure.searchQueued, false);
    assert.equal(sonarrLookupFailure.blockers.some(blocker => blocker.type === "episode_file_lookup_failed"), true);
    assert.equal(sonarrLookupFailure.blockers.some(blocker => blocker.type === "episode_id_unverified"), true);
    assert.equal(calls.filter(call => call.method === "DELETE" && call.path === "/sonarr/api/v3/episodefile/999").length, 0);

    const sonarrReplaced = await tool("sonarr_replace_episode_files", {
      episodeFileIds: [800],
      seriesId: 55,
      dryRun: false
    });
    assert.equal(sonarrReplaced.deleted, true);
    assert.equal(sonarrReplaced.searchQueued, true);
    assert.equal(sonarrReplaced.searchResult.id, 9100);
    assert.equal(calls.filter(call => call.method === "DELETE" && call.path === "/sonarr/api/v3/episodefile/800").length, 1);

    const seasonChildren = await tool("plex_list_season_children", {
      ratingKey: "season-13"
    });
    assert.equal(seasonChildren.total, 1);
    assert.equal(seasonChildren.children[0].ratingKey, "episode-1301");
    assert.equal(seasonChildren.children[0].parts[0].file, "/tv/Fixture Series/Season 13/Fixture Series - S13E03.mkv");

    const showSeasons = await tool("plex_list_show_seasons", {
      ratingKey: "show-55"
    });
    assert.equal(showSeasons.total, 1);
    assert.equal(showSeasons.seasons[0].ratingKey, "season-13");
    assert.equal(showSeasons.seasons[0].childCount, 12);

    const plexScanDry = await tool("plex_scan_library_path", {
      ratingKey: "episode-1301",
      analyzeMetadata: true,
      dryRun: true
    });
    assert.equal(plexScanDry.dryRun, true);
    assert.deepEqual(plexScanDry.actions.map(action => action.type), ["scan_path", "refresh_metadata", "analyze_metadata"]);
    assert.equal(plexScanDry.paths[0], "/tv/Fixture Series/Season 13");

    const plexScanRun = await tool("plex_scan_library_path", {
      ratingKey: "episode-1301",
      analyzeMetadata: true,
      dryRun: false
    });
    assert.equal(plexScanRun.ok, true);
    assert.deepEqual(plexScanRun.results.map(result => result.action), ["scan_path", "refresh_metadata", "analyze_metadata"]);

    const probe = await tool("media_probe_video_content", {
      ratingKey: "episode-1301",
      includeFrameHashes: true,
      hashTimestampsSeconds: [12],
      comparePath: "/tv/Fixture Series/Season 13/Fixture Series - S13E03.compare.mkv"
    });
    assert.equal(probe.resolvedPath, episodeFile);
    assert.equal(probe.embeddedTitles[0].title, "Embedded Fixture Title");
    assert.equal(probe.frameHashes[0].ok, true);
    assert.equal(probe.frameHashes[0].algorithm, "average_hash_8x8");
    assert.equal(probe.comparison.resolvedPath, compareEpisodeFile);
    assert.equal(probe.comparison.hammingDistances[0].distance, 0);

    const suffixMappedProbe = await tool("media_probe_video_content", {
      path: "/opaque/plex/library/tv/Fixture Series/Season 13/Fixture Series - S13E03.mkv"
    });
    assert.equal(suffixMappedProbe.resolvedPath, plexMappedEpisodeFile);

    const timedOutProbe = await tool("media_probe_video_content", {
      path: "/tv/Fixture Series/Season 13/Fixture Series - S13E04.hang.mkv"
    });
    assert.equal(timedOutProbe.resolvedPath, hangingProbeFile);
    assert.equal(Object.hasOwn(timedOutProbe, "metadata"), false);
    assert.match(timedOutProbe.ffprobe.error, /timed out/i);

    const plexDry = await tool("plex_delete_metadata", {
      operation: "delete_metadata",
      ratingKey: "900001",
      dryRun: true
    });
    assert.equal(plexDry.dryRun, true);
    assert.equal(calls.filter(call => call.method === "DELETE" && call.path === "/plex/library/metadata/900001").length, 0);

    const plexDeleted = await tool("plex_delete_metadata", {
      operation: "delete_metadata",
      ratingKey: "900001",
      dryRun: false
    });
    assert.equal(plexDeleted.result.deleted, true);

    const plexScanned = await tool("plex_delete_metadata", {
      operation: "scan_section",
      sectionKey: "1",
      path: "/movies/Fixture Movie (2026)",
      dryRun: false
    });
    assert.equal(plexScanned.result.refreshed, true);

    const plexTrash = await tool("plex_delete_metadata", {
      operation: "empty_trash",
      sectionKey: "1",
      dryRun: false
    });
    assert.equal(plexTrash.result.emptied, true);
  } finally {
    child.kill("SIGTERM");
    mock.close();
    await once(mock, "close");
    await rm(tempRoot, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log("repair capability tool tests passed");
}).catch(error => {
  console.error(error);
  process.exit(1);
});
