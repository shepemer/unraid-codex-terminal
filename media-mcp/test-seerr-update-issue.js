import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
  const requests = [];
  const issue = {
    id: 1,
    issueType: 1,
    status: 1,
    problemSeason: 2,
    problemEpisode: 3,
    createdAt: "2026-07-01T12:00:00Z",
    updatedAt: "2026-07-01T12:30:00Z",
    createdBy: {
      id: 7,
      username: "viewer",
      displayName: "Viewer One",
      email: "viewer@example.invalid"
    },
    media: {
      id: 10,
      mediaType: "movie",
      title: "Example Movie",
      tmdbId: 12345,
      tvdbId: 67890,
      ratingKey: "555",
      status: 5
    },
    comments: [
      {
        id: 11,
        message: "Original issue description",
        createdAt: "2026-07-01T12:00:00Z",
        updatedAt: "2026-07-01T12:00:00Z",
        user: {
          id: 7,
          username: "viewer",
          displayName: "Viewer One",
          email: "viewer@example.invalid"
        }
      },
      {
        id: 12,
        message: "Follow-up detail",
        createdAt: "2026-07-01T12:05:00Z",
        updatedAt: "2026-07-01T12:05:00Z",
        user: { id: 8, username: "admin", displayName: "Admin User" }
      }
    ]
  };

  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req) : undefined;
    requests.push({ method: req.method, path: url.pathname, apiKey: req.headers["x-api-key"], body });

    if (url.pathname.startsWith("/seerr/api/v1/")) {
      if (url.pathname === "/seerr/api/v1/issue/401") {
        return sendJson(res, 401, { message: "Unauthorized" });
      }
      if (req.headers["x-api-key"] !== "seerr-key") {
        return sendJson(res, 401, { message: "Unauthorized" });
      }
    }

    if (req.method === "GET" && url.pathname === "/seerr/api/v1/issue/1") {
      return sendJson(res, 200, clone(issue));
    }
    if (req.method === "GET" && url.pathname === "/seerr/api/v1/issue/404") {
      return sendJson(res, 404, { message: "Issue not found." });
    }
    if (req.method === "GET" && url.pathname === "/seerr/api/v1/issueComment/11") {
      return sendJson(res, 200, clone(issue.comments[0]));
    }
    if (req.method === "PUT" && url.pathname === "/seerr/api/v1/issueComment/11") {
      assert.deepEqual(body, { message: "Updated issue description" });
      issue.comments[0].message = body.message;
      issue.comments[0].updatedAt = "2026-07-02T12:00:00Z";
      issue.updatedAt = "2026-07-02T12:00:00Z";
      return sendJson(res, 200, clone(issue.comments[0]));
    }
    if (req.method === "POST" && url.pathname === "/seerr/api/v1/issue/1/comment") {
      const comment = {
        id: 13,
        message: body.message,
        createdAt: "2026-07-02T12:05:00Z",
        updatedAt: "2026-07-02T12:05:00Z",
        user: { id: 8, username: "admin", displayName: "Admin User" }
      };
      issue.comments.push(comment);
      return sendJson(res, 200, clone(issue));
    }
    if (req.method === "POST" && url.pathname === "/seerr/api/v1/issue/1/resolved") {
      issue.status = 2;
      return sendJson(res, 200, clone(issue));
    }
    if (req.method === "POST" && url.pathname === "/seerr/api/v1/issue/1/open") {
      issue.status = 1;
      return sendJson(res, 200, clone(issue));
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
      SEERR_URL: `http://127.0.0.1:${mockPort}/seerr`,
      SEERR_API_KEY: "seerr-key"
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
      clientInfo: { name: "seerr-update-issue-test", version: "1" }
    });
    await rpc("notifications/initialized", {}, false);

    const tools = await rpc("tools/list");
    const toolNames = new Set(tools.result.tools.map(toolInfo => toolInfo.name));
    assert.ok(toolNames.has("seerr_update_issue"));
    assert.ok(toolNames.has("seerr_update_issue_comment"));

    const beforeDryRunPuts = requests.filter(request => request.method === "PUT").length;
    const dryRun = await tool("seerr_update_issue", {
      issueId: 1,
      patch: { message: "Updated issue description" }
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.supported, true);
    assert.equal(dryRun.applied, false);
    assert.equal(dryRun.endpoint.method, "PUT");
    assert.equal(dryRun.endpoint.resolvedPath, "/api/v1/issueComment/11");
    assert.equal(dryRun.current.message, "Original issue description");
    assert.equal(dryRun.proposed.message, "Updated issue description");
    assert.equal(dryRun.issue.reporter.email, undefined);
    assert.equal(requests.filter(request => request.method === "PUT").length, beforeDryRunPuts);

    const unsupported = await tool("seerr_update_issue", {
      issueId: 1,
      patch: { issueType: "audio", status: "resolved" }
    });
    assert.equal(unsupported.dryRun, true);
    assert.equal(unsupported.supported, false);
    assert.equal(unsupported.applied, false);
    assert.deepEqual(unsupported.unsupportedFields.map(field => field.field), ["issueType", "status"]);
    assert.match(unsupported.unsupportedFields[1].reason, /seerr_resolve_issue/i);
    assert.equal(requests.filter(request => request.method === "PUT").length, beforeDryRunPuts);

    const conflictingAliases = await tool("seerr_update_issue", {
      issueId: 1,
      patch: { message: "A", body: "B" }
    });
    assert.equal(conflictingAliases.supported, false);
    assert.match(conflictingAliases.blockers[0].reason, /aliases/i);

    const updated = await tool("seerr_update_issue", {
      issueId: 1,
      patch: { body: "Updated issue description" },
      dryRun: false
    });
    assert.equal(updated.dryRun, false);
    assert.equal(updated.supported, true);
    assert.equal(updated.applied, true);
    assert.equal(updated.updatedComment.id, 11);
    assert.equal(updated.updatedComment.message, "Updated issue description");
    assert.equal(updated.issue.message, "Updated issue description");
    assert.equal(updated.issue.comments[0].message, "Updated issue description");
    assert.equal(updated.issue.reporter.email, undefined);
    assert.equal(requests.filter(request => request.method === "PUT").length, beforeDryRunPuts + 1);

    const commentDryRun = await tool("seerr_update_issue_comment", {
      commentId: 11,
      message: "Direct comment update",
      dryRun: true
    });
    assert.equal(commentDryRun.dryRun, true);
    assert.equal(commentDryRun.currentComment.message, "Updated issue description");

    const addCommentDryRun = await tool("seerr_add_issue_comment", {
      issueId: 1,
      message: "I am checking this.",
      dryRun: true
    });
    assert.equal(addCommentDryRun.dryRun, true);
    assert.equal(addCommentDryRun.issue.id, 1);

    const resolveDryRun = await tool("seerr_resolve_issue", { issueId: 1, dryRun: true });
    assert.equal(resolveDryRun.dryRun, true);
    assert.equal(resolveDryRun.wouldSetStatus, "resolved");

    const notFound = await toolError("seerr_update_issue", {
      issueId: 404,
      patch: { message: "No issue here" }
    });
    assert.match(notFound, /404|Issue not found/i);

    const authFailure = await toolError("seerr_update_issue", {
      issueId: 401,
      patch: { message: "Unauthorized update" }
    });
    assert.match(authFailure, /401|Unauthorized/i);
  } finally {
    child.kill("SIGTERM");
    mock.close();
    await once(mock, "close");
  }
}

run().then(() => {
  console.log("seerr update issue tests passed");
}).catch(error => {
  console.error(error);
  process.exit(1);
});
