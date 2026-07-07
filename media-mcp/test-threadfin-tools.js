import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
      resolve(data ? JSON.parse(data) : {});
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

function websocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function decodeWebsocketFrame(buffer) {
  const first = buffer[0];
  const opcode = first & 0x0f;
  if (opcode === 0x8) {
    return null;
  }
  let offset = 2;
  let length = buffer[1] & 0x7f;
  if (length === 126) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const masked = (buffer[1] & 0x80) !== 0;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += masked ? 4 : 0;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }
  }
  return payload.toString("utf8");
}

function encodeWebsocketText(text) {
  const payload = Buffer.from(text);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

async function run() {
  const calls = [];
  let apiToken = "";
  let webToken = "";
  const config = {
    status: true,
    clientInfo: {
      version: "1.2.37",
      streams: "1 / 3",
      activeClients: 1,
      totalClients: 8,
      activePlaylist: 1,
      totalPlaylist: 4,
      xepg: 2,
      errors: 0,
      warnings: 1,
      "m3u-url": "http://threadfin:34400/m3u/threadfin.m3u",
      "xepg-url": "http://threadfin:34400/xmltv/threadfin.xml"
    },
    settings: {
      api: true,
      "authentication.web": true,
      "authentication.api": true,
      "authentication.m3u": true,
      "authentication.xml": true,
      epgSource: "XEPG",
      tuner: 8,
      buffer: "ffmpeg",
      files: {
        m3u: {
          M1: {
            name: "Provider",
            description: "Primary",
            "file.source": "http://provider.example/playlist.m3u?token=secret",
            buffer: "ffmpeg",
            tuner: 2,
            "id.provider": "M1",
            "http_headers.user-agent": "ThreadfinTest/1.0",
            "http_headers.origin": "http://provider.example",
            "http_headers.referer": "http://provider.example/watch"
          }
        },
        hdhr: {},
        xmltv: {
          X1: {
            name: "Guide",
            description: "EPG",
            "file.source": "http://provider.example/xmltv.xml?password=secret",
            "id.provider": "X1"
          }
        }
      },
      filter: {
        1: {
          name: "News",
          type: "group-title",
          filter: "News",
          active: true
        }
      }
    },
    users: {
      U1: {
        username: "admin",
        "authentication.web": true,
        "authentication.api": true,
        password: "hidden"
      }
    },
    xepg: {
      epgMapping: {
        C1: {
          "x-active": true,
          "x-channelID": "100",
          "x-name": "News One",
          "x-description": "Original",
          "x-group-title": "News",
          "x-category": "News",
          "x-xmltv-file": "guide.xml",
          "x-mapping": "news.one",
          "x-backup-channel-1": "-",
          "tvg-id": "news.one",
          "tvg-name": "News One",
          "tvg-logo": "http://logo.example/news.png",
          url: "http://stream.example/news?token=secret",
          "_file.m3u.id": "M1",
          "_file.m3u.name": "Provider"
        },
        C2: {
          "x-active": false,
          "x-channelID": "101",
          "x-name": "Sports Two",
          "x-group-title": "Sports",
          "x-xmltv-file": "-",
          "x-mapping": "-",
          url: "http://stream.example/sports"
        },
        C3: {
          "x-active": false,
          "x-channelID": "500",
          "x-name": "FIFAWC 01: Opening Match",
          "x-group-title": "FIFA World Cup 2026",
          "x-category": "-",
          "x-xmltv-file": "-",
          "x-mapping": "-",
          "x-hide-channel": false,
          "tvg-id": "fifawc.01",
          "tvg-name": "FIFAWC 01",
          url: "http://stream.example/fifa/01?token=secret",
          "_file.m3u.id": "M1",
          "_file.m3u.name": "Provider"
        },
        C4: {
          "x-active": false,
          "x-channelID": "501",
          "x-name": "FIFAWC 02: Group Stage",
          "x-group-title": "FIFA World Cup 2026",
          "x-category": "-",
          "x-xmltv-file": "-",
          "x-mapping": "-",
          "x-hide-channel": false,
          "tvg-id": "fifawc.02",
          "tvg-name": "FIFAWC 02",
          url: "http://stream.example/fifa/02?token=secret",
          "_file.m3u.id": "M1",
          "_file.m3u.name": "Provider"
        },
        C5: {
          "x-active": false,
          "x-channelID": "502",
          "x-name": "FIFAWC 03 | Knockout",
          "x-group-title": "FIFA World Cup 2026",
          "x-category": "-",
          "x-xmltv-file": "-",
          "x-mapping": "-",
          "x-hide-channel": false,
          "tvg-id": "fifawc.03",
          "tvg-name": "FIFAWC 03",
          url: "http://stream.example/fifa/03?token=secret",
          "_file.m3u.id": "M1",
          "_file.m3u.name": "Provider"
        }
      },
      xmltvMap: {
        "guide.xml": {
          "news.one": {
            "display-name": ["News One"],
            icon: "http://logo.example/news.png"
          },
          "fifawc.01": {
            "display-name": ["FIFAWC 01"]
          },
          "fifawc.02": {
            "display-name": ["FIFAWC 02"]
          },
          "fifawc.03": {
            "display-name": ["FIFAWC 03"]
          }
        }
      }
    },
    log: {
      errors: 0,
      warnings: 1,
      log: ["Started Threadfin", "Loaded token=secret"]
    }
  };

  function websocketResponse(request, token) {
    calls.push({ transport: "websocket", cmd: request.cmd, body: request, token });
    if (config.settings["authentication.web"] && token !== webToken && token !== apiToken) {
      return { status: false, err: "User authentication failed", reload: true };
    }
    switch (request.cmd) {
      case "getServerConfig":
        return { ...config, token: webToken };
      case "saveSettings":
        Object.assign(config.settings, request.settings || {});
        return { ...config, token: webToken };
      case "saveFilesM3U":
      case "saveFilesHDHR":
      case "saveFilesXMLTV": {
        const type = request.cmd.endsWith("M3U") ? "m3u" : request.cmd.endsWith("HDHR") ? "hdhr" : "xmltv";
        for (const [id, source] of Object.entries(request.files?.[type] || {})) {
          if (source.delete) {
            delete config.settings.files[type][id];
          } else {
            const targetId = id === "-" ? `${type[0].toUpperCase()}NEW` : id;
            config.settings.files[type][targetId] = {
              ...(config.settings.files[type][targetId] || {}),
              ...source,
              "id.provider": targetId
            };
          }
        }
        return { ...config, token: webToken };
      }
      case "updateFileM3U":
      case "updateFileHDHR":
      case "updateFileXMLTV":
        return { ...config, token: webToken, alert: "updated" };
      case "saveFilter":
        Object.assign(config.settings.filter, request.filter || {});
        return { ...config, token: webToken };
      case "saveEpgMapping":
        config.xepg.epgMapping = request.epgMapping;
        return { ...config, token: webToken };
      case "saveNewUser":
        config.users.UNEW = request.userData;
        return { ...config, token: webToken };
      case "saveUserData":
        Object.assign(config.users, request.userData || {});
        return { ...config, token: webToken };
      case "updateLog":
        return { status: true, token: webToken, log: config.log, clientInfo: config.clientInfo };
      case "resetLogs":
        config.log.log = [];
        return { ...config, token: webToken };
      case "ThreadfinBackup":
        return { status: true, token: webToken, openLink: "http://threadfin/download/backup.zip" };
      case "ThreadfinRestore":
        return { status: true, token: webToken, alert: "Backup was successfully restored." };
      case "rawWebsocketFixture":
        return { status: true, token: webToken, echoed: request.value };
      default:
        return { status: false, err: `unknown command ${request.cmd}` };
    }
  }

  const providerM3u = [
    "#EXTM3U",
    "#EXTINF:-1 tvg-id=\"fifawc.01\" tvg-name=\"FIFAWC 01\" group-title=\"FIFA World Cup 2026\",FIFAWC 01: Opening Match",
    "http://stream.example/fifa/01?token=secret",
    "#EXTINF:-1 tvg-id=\"fifawc.02\" tvg-name=\"FIFAWC 02\" group-title=\"FIFA World Cup 2026\",FIFAWC 02: Group Stage",
    "http://stream.example/fifa/02?token=secret",
    "#EXTINF:-1 tvg-id=\"fifawc.03\" tvg-name=\"FIFAWC 03\" group-title=\"FIFA World Cup 2026\",FIFAWC 03 | Knockout",
    "http://stream.example/fifa/03?token=secret",
    "#EXTINF:-1 tvg-id=\"news.one\" tvg-name=\"News One\" group-title=\"News\",News One",
    "http://stream.example/news?token=secret",
    ""
  ].join("\n");

  const providerXmltv = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<tv>",
    "  <channel id=\"fifawc.01\"><display-name>FIFAWC 01</display-name><display-name>FIFAWC 01: Opening Match</display-name></channel>",
    "  <channel id=\"fifawc.02\"><display-name>FIFAWC 02</display-name><display-name>FIFAWC 02: Group Stage</display-name></channel>",
    "  <channel id=\"fifawc.03\"><display-name>FIFAWC 03</display-name><display-name>FIFAWC 03 | Knockout</display-name></channel>",
    "  <channel id=\"news.one\"><display-name>News One</display-name></channel>",
    "</tv>",
    ""
  ].join("\n");

  const threadfin = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/api/") {
      const body = await readJson(req);
      calls.push({ transport: "api", cmd: body.cmd, body });
      if (body.cmd === "login") {
        if (body.username === "admin" && body.password === "password") {
          apiToken = "api-token";
          sendJson(res, 200, { status: true, token: apiToken });
        } else {
          sendJson(res, 200, { status: false, err: "Login incorrect" });
        }
        return;
      }
      if (config.settings["authentication.api"] && body.token !== apiToken) {
        sendJson(res, 200, { status: false, err: "Login incorrect" });
        return;
      }
      if (body.cmd === "status") {
        sendJson(res, 200, {
          status: true,
          token: apiToken,
          "version.threadfin": "1.2.37",
          "version.api": "1.1.0",
          "streams.active": 1,
          "streams.all": 3,
          "streams.xepg": 2,
          "url.m3u": "http://127.0.0.1/m3u/threadfin.m3u?token=secret",
          "url.xepg": "http://127.0.0.1/xmltv/threadfin.xml?password=secret"
        });
        return;
      }
      if (body.cmd === "update.m3u") {
        sendJson(res, 200, { status: true, token: apiToken, updated: "m3u" });
        return;
      }
      if (body.cmd === "rawApiFixture") {
        sendJson(res, 200, { status: true, token: apiToken, echoed: body.value });
        return;
      }
      sendJson(res, 200, { status: false, err: `unknown api command ${body.cmd}` });
      return;
    }
    if (req.method === "POST" && (url.pathname === "/web" || url.pathname === "/web/")) {
      let data = "";
      req.on("data", chunk => {
        data += chunk;
      });
      req.on("end", () => {
        const form = new URLSearchParams(data);
        if (form.get("username") === "admin" && form.get("password") === "password") {
          webToken = "web-token";
          res.writeHead(301, { "set-cookie": `Token=${webToken}; Path=/`, location: "/web" });
          res.end();
        } else {
          res.writeHead(403);
          res.end("forbidden");
        }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/ppv/enable") {
      calls.push({ transport: "http", path: "ppv/enable" });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/ppv/disable") {
      calls.push({ transport: "http", path: "ppv/disable" });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/provider/playlist.m3u") {
      calls.push({ transport: "http", path: "provider/playlist.m3u", userAgent: req.headers["user-agent"] });
      res.writeHead(200, { "content-type": "audio/x-mpegurl" });
      res.end(providerM3u);
      return;
    }
    if (req.method === "GET" && url.pathname === "/provider/xmltv.xml") {
      calls.push({ transport: "http", path: "provider/xmltv.xml", userAgent: req.headers["user-agent"] });
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(providerXmltv);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/m3u/threadfin.m3u" || url.pathname === "/m3u/")) {
      res.writeHead(200, { "content-type": "audio/x-mpegurl" });
      res.end(providerM3u);
      return;
    }
    if (req.method === "GET" && url.pathname === "/lineup.json") {
      sendJson(res, 200, [
        { GuideNumber: "100", GuideName: "News One" },
        { GuideNumber: "500", GuideName: "FIFAWC 01: Opening Match" },
        { GuideNumber: "501", GuideName: "FIFAWC 02: Group Stage" },
        { GuideNumber: "502", GuideName: "FIFAWC 03 | Knockout" }
      ]);
      return;
    }
    if (req.method === "GET" && url.pathname === "/discover.json") {
      sendJson(res, 200, {
        FriendlyName: "Threadfin",
        ModelNumber: "HDTC-2US",
        FirmwareName: "Threadfin",
        TunerCount: 8,
        DeviceID: "threadfin-test",
        LineupURL: `http://127.0.0.1:${threadfinPort}/lineup.json?token=secret`
      });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });

  threadfin.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/data/") {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      "",
      ""
    ].join("\r\n"));
    socket.once("data", chunk => {
      const decoded = decodeWebsocketFrame(chunk);
      const request = decoded ? JSON.parse(decoded) : {};
      const response = websocketResponse(request, url.searchParams.get("Token") || "-");
      socket.write(encodeWebsocketText(JSON.stringify(response)));
      socket.end();
    });
  });

  const threadfinPort = await freePort();
  config.settings.files.m3u.M1["file.source"] = `http://127.0.0.1:${threadfinPort}/provider/playlist.m3u?token=secret`;
  config.settings.files.xmltv.X1["file.source"] = `http://127.0.0.1:${threadfinPort}/provider/xmltv.xml?password=secret`;
  threadfin.listen(threadfinPort, "127.0.0.1");
  await once(threadfin, "listening");

  const mediaPort = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      ...process.env,
      MEDIA_MCP_BEARER_TOKEN: "test-token",
      MEDIA_MCP_HOST: "127.0.0.1",
      MEDIA_MCP_PORT: String(mediaPort),
      THREADFIN_URL: `http://127.0.0.1:${threadfinPort}`,
      THREADFIN_USERNAME: "admin",
      THREADFIN_PASSWORD: "password"
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
  let id = 1;
  let sessionId;

  async function rpc(method, params = {}, hasId = true) {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {})
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: hasId ? id++ : undefined, method, params })
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
    assert.ok(response.result.isError, JSON.stringify(response));
    return response.result.content?.[0]?.text || "";
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
      clientInfo: { name: "threadfin-tools-test", version: "1" }
    });
    await rpc("notifications/initialized", {}, false);

    const tools = await rpc("tools/list");
    const toolNames = new Set(tools.result.tools.map(toolInfo => toolInfo.name));
    assert.ok(toolNames.has("threadfin_status"));
    assert.ok(toolNames.has("threadfin_save_source"));
    assert.ok(toolNames.has("threadfin_list_source_groups"));
    assert.ok(toolNames.has("threadfin_set_mapping_fields"));
    assert.ok(toolNames.has("threadfin_verify_output"));
    assert.ok(toolNames.has("threadfin_raw_websocket_command"));

    const status = await tool("threadfin_status");
    assert.equal(status.api["version.threadfin"], "1.2.37");
    assert.equal(status.api["url.m3u"], "[redacted]");
    assert.equal(status.clientInfo.version, "1.2.37");

    const services = await tool("media_services_status");
    assert.equal(services.threadfin.configured, true);
    assert.equal(services.threadfin.status.clientInfo.version, "1.2.37");

    const configSnapshot = await tool("threadfin_get_config");
    assert.equal(configSnapshot.settings.files.m3u.M1["file.source"], "[redacted]");
    assert.equal(configSnapshot.users.U1.password, "[redacted]");
    assert.equal(configSnapshot.summary.mappings.total, 5);
    assert.equal(configSnapshot.summary.playlists[0].fileSource, "[redacted]");

    const sources = await tool("threadfin_list_sources", { type: "m3u" });
    assert.equal(sources.records.length, 1);
    assert.equal(sources.records[0].fileSource, "[redacted]");

    const sourceGroups = await tool("threadfin_list_source_groups", {
      playlistId: "M1",
      includeChannels: true
    });
    const fifaGroup = sourceGroups.groups.find(group => group.groupTitle === "FIFA World Cup 2026");
    assert.equal(fifaGroup.count, 3);
    assert.equal(fifaGroup.channels[0].url, undefined);
    assert.equal(calls.some(call => call.path === "provider/playlist.m3u" && call.userAgent === "ThreadfinTest/1.0"), true);

    const sourceChannels = await tool("threadfin_find_source_channels", {
      playlistId: "M1",
      group: "FIFA World Cup 2026",
      includeTokens: ["FIFAWC 01", "FIFAWC 02", "FIFAWC 03"]
    });
    assert.equal(sourceChannels.total, 3);
    assert.equal(sourceChannels.records[0].name, "FIFAWC 01: Opening Match");
    assert.equal(sourceChannels.records[0].url, undefined);
    assert.equal(sourceChannels.records[0].urlTail, "fifa/01");

    const channels = await tool("threadfin_list_channels", { includeInactive: false });
    assert.equal(channels.records.length, 1);
    assert.equal(channels.records[0].name, "News One");
    assert.equal(channels.records[0].url, "[redacted]");

    const channel = await tool("threadfin_get_channel", { id: "C1", includeSensitive: true });
    assert.match(channel.url, /token=secret/);

    const xmltv = await tool("threadfin_list_xmltv_channels", { file: "guide.xml" });
    assert.equal(xmltv.records[0].id, "news.one");

    const settingsDryRun = await tool("threadfin_update_settings", { patch: { tuner: 10 } });
    assert.equal(settingsDryRun.dryRun, true);
    assert.equal(settingsDryRun.proposedObject.tuner, 10);
    assert.equal(config.settings.tuner, 8);
    await tool("threadfin_update_settings", { patch: { tuner: 10 }, dryRun: false, confirm: true });
    assert.equal(config.settings.tuner, 10);

    const sourceDryRun = await tool("threadfin_save_source", {
      type: "m3u",
      id: "M1",
      name: "Provider Updated",
      dryRun: true
    });
    assert.equal(sourceDryRun.dryRun, true);
    assert.equal(config.settings.files.m3u.M1.name, "Provider");
    await tool("threadfin_save_source", {
      type: "m3u",
      id: "M1",
      name: "Provider Updated",
      dryRun: false,
      confirm: true
    });
    assert.equal(config.settings.files.m3u.M1.name, "Provider Updated");

    const refreshDryRun = await tool("threadfin_refresh_source", { type: "m3u", id: "M1" });
    assert.equal(refreshDryRun.command, "updateFileM3U");
    await tool("threadfin_refresh_source", { type: "m3u", dryRun: false, confirm: true });
    assert.equal(calls.some(call => call.transport === "api" && call.cmd === "update.m3u"), true);

    const updateM3uDryRun = await tool("threadfin_update_m3u", { playlistId: "M1" });
    assert.equal(updateM3uDryRun.command, "updateFileM3U");
    assert.equal(updateM3uDryRun.payload.files.m3u.M1["file.source"], "[redacted]");
    assert.equal(updateM3uDryRun.sourceGroups.totalGroups, 2);
    await tool("threadfin_update_m3u", { playlistId: "M1", dryRun: false, confirm: true });
    const updateCall = calls.findLast(call => call.transport === "websocket" && call.cmd === "updateFileM3U");
    assert.match(updateCall.body.files.m3u.M1["file.source"], /provider\/playlist\.m3u/);

    const filterDryRun = await tool("threadfin_save_filter", { id: 1, name: "News Updated" });
    assert.equal(filterDryRun.dryRun, true);
    await tool("threadfin_save_filter", { id: 1, name: "News Updated", dryRun: false, confirm: true });
    assert.equal(config.settings.filter[1].name, "News Updated");

    const groupFilterDryRun = await tool("threadfin_save_group_filter", {
      name: "World Cup",
      groupTitle: "FIFA World Cup 2026",
      include: "FIFAWC 01,FIFAWC 02,FIFAWC 03",
      startingNumber: 500,
      "x-category": "sports"
    });
    assert.equal(groupFilterDryRun.command, "saveFilter");
    assert.equal(groupFilterDryRun.after.filter, "FIFA World Cup 2026");
    await tool("threadfin_save_group_filter", {
      name: "World Cup",
      groupTitle: "FIFA World Cup 2026",
      include: "FIFAWC 01,FIFAWC 02,FIFAWC 03",
      startingNumber: 500,
      "x-category": "sports",
      dryRun: false,
      confirm: true
    });
    assert.equal(config.settings.filter[-1].include, "FIFAWC 01,FIFAWC 02,FIFAWC 03");

    const channelDryRun = await tool("threadfin_update_channels", {
      channels: [{ id: "C1", patch: { "x-name": "News Prime" } }]
    });
    assert.equal(channelDryRun.dryRun, true);
    assert.equal(config.xepg.epgMapping.C1["x-name"], "News One");
    await tool("threadfin_update_channels", {
      channels: [{ id: "C1", patch: { "x-name": "News Prime" } }],
      dryRun: false,
      confirm: true
    });
    assert.equal(config.xepg.epgMapping.C1["x-name"], "News Prime");

    const mappingDryRun = await tool("threadfin_set_mapping_fields", {
      groupTitle: "FIFA World Cup 2026",
      searchTokens: ["FIFAWC 01", "FIFAWC 02", "FIFAWC 03"],
      "x-active": true,
      "x-category": "sports",
      "x-xmltv-file": "guide.xml",
      channelNumberStart: 500
    });
    assert.deepEqual(mappingDryRun.selectedMappingKeys, ["C3", "C4", "C5"]);
    assert.equal(config.xepg.epgMapping.C3["x-active"], false);
    await tool("threadfin_set_mapping_fields", {
      groupTitle: "FIFA World Cup 2026",
      searchTokens: ["FIFAWC 01", "FIFAWC 02", "FIFAWC 03"],
      "x-active": true,
      "x-category": "sports",
      "x-xmltv-file": "guide.xml",
      channelNumberStart: 500,
      dryRun: false,
      confirm: true
    });
    assert.equal(config.xepg.epgMapping.C3["x-active"], true);
    assert.equal(config.xepg.epgMapping.C4["x-channelID"], "501");
    assert.equal(config.xepg.epgMapping.C5["x-category"], "sports");

    const xmltvMatches = await tool("threadfin_find_xmltv_channels", {
      xmltvId: "X1",
      searchTokens: ["FIFAWC 01", "FIFAWC 02", "FIFAWC 03"]
    });
    assert.equal(xmltvMatches.total, 3);
    assert.equal(xmltvMatches.records.every(record => record.matchType === "exact"), true);

    const userDryRun = await tool("threadfin_save_user", {
      id: "U1",
      username: "admin2",
      password: "new-password"
    });
    assert.equal(userDryRun.payload.userData.U1.password, "[redacted]");
    await tool("threadfin_save_user", {
      id: "U1",
      username: "admin2",
      dryRun: false,
      confirm: true
    });
    assert.equal(config.users.U1.username, "admin2");

    const logs = await tool("threadfin_logs", { limit: 5 });
    assert.equal(logs.records[1], "Loaded token=[redacted]");
    const resetLogsDryRun = await tool("threadfin_reset_logs");
    assert.equal(resetLogsDryRun.dryRun, true);
    await tool("threadfin_reset_logs", { dryRun: false, confirm: true });
    assert.equal(config.log.log.length, 0);

    const backupDryRun = await tool("threadfin_backup_config");
    assert.equal(backupDryRun.command, "ThreadfinBackup");
    const backup = await tool("threadfin_backup_config", { dryRun: false });
    assert.equal(backup.response.openLink, "http://threadfin/download/backup.zip");

    const restoreDryRun = await tool("threadfin_restore_config", { base64: "ZmFrZQ==" });
    assert.equal(restoreDryRun.base64Bytes, 8);
    const restore = await tool("threadfin_restore_config", { base64: "ZmFrZQ==", dryRun: false, confirm: true });
    assert.match(restore.response.alert, /restored/i);

    const ppvDryRun = await tool("threadfin_set_ppv", { enabled: true });
    assert.equal(ppvDryRun.dryRun, true);
    await tool("threadfin_set_ppv", { enabled: true, dryRun: false, confirm: true });
    assert.equal(calls.some(call => call.path === "ppv/enable"), true);

    const exported = await tool("threadfin_export_output", { kind: "m3u", includeContent: true });
    assert.equal(exported.content.includes("token=secret"), false);
    assert.equal(exported.content.includes("http://stream.example"), false);
    assert.equal(exported.content.includes("[redacted]"), true);

    const verification = await tool("threadfin_verify_output", {
      expectedTokens: ["FIFAWC 01", "FIFAWC 02", "FIFAWC 03"]
    });
    assert.equal(verification.tunerCount, 8);
    assert.equal(verification.lineupCount, 4);
    assert.equal(verification.m3uCount, 4);
    assert.equal(verification.matches.every(match => match.matched), true);

    const rawDryRun = await tool("threadfin_raw_websocket_command", {
      cmd: "rawWebsocketFixture",
      payload: { value: "ok" }
    });
    assert.equal(rawDryRun.dryRun, true);
    const unsafeError = await toolError("threadfin_raw_websocket_command", {
      cmd: "rawWebsocketFixture",
      payload: { value: "ok" },
      dryRun: false
    });
    assert.match(unsafeError, /confirmUnsafe/i);
    const rawWs = await tool("threadfin_raw_websocket_command", {
      cmd: "rawWebsocketFixture",
      payload: { value: "ok" },
      dryRun: false,
      confirmUnsafe: true
    });
    assert.equal(rawWs.response.echoed, "ok");

    const rawApi = await tool("threadfin_raw_api_command", {
      cmd: "rawApiFixture",
      payload: { value: "ok" },
      dryRun: false,
      confirmUnsafe: true
    });
    assert.equal(rawApi.response.echoed, "ok");
  } finally {
    child.kill("SIGTERM");
    threadfin.close();
    await once(threadfin, "close");
  }
}

run().then(() => {
  console.log("threadfin tools tests passed");
}).catch(error => {
  console.error(error);
  process.exit(1);
});
