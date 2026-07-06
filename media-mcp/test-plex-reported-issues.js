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
  const graphqlCalls = [];
  const reports = [
    {
      __typename: "Report",
      id: "report-1",
      message: "Audio drops out around the 10 minute mark.",
      user: {
        id: "user-1",
        avatar: "https://example.invalid/avatar.png",
        username: "viewer",
        displayName: "Viewer One",
        isMuted: false,
        isBlocked: false
      },
      url: "server://mock-machine/com.plexapp.plugins.library/library/metadata/123",
      date: "2026-07-01T12:00:00Z",
      commentCount: 1
    },
    {
      __typename: "Report",
      id: "report-2",
      message: "Subtitles are missing.",
      user: {
        id: "user-2",
        username: "subtitle-fan",
        displayName: "Subtitle Fan",
        isMuted: false,
        isBlocked: false
      },
      url: "server://mock-machine/com.plexapp.plugins.library/library/metadata/456",
      date: "2026-07-02T12:00:00Z",
      commentCount: 0
    }
  ];
  const comments = new Map([
    ["report-1", [{
      __typename: "ReportComment",
      date: "2026-07-01T13:00:00Z",
      id: "comment-1",
      message: "I can reproduce this on Apple TV.",
      status: "PUBLISHED",
      user: { id: "user-1", username: "viewer", displayName: "Viewer One", isMuted: false, isBlocked: false, isHidden: false }
    }]],
    ["report-2", []]
  ]);

  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/community/api") {
      assert.equal(req.headers["x-plex-token"], "plex-token");
      const body = await readJson(req);
      graphqlCalls.push({ operationName: body.operationName, variables: body.variables });
      if (body.operationName === "getReportedIssues") {
        return sendJson(res, 200, {
          data: {
            reports: {
              nodes: reports.slice(0, body.variables.first),
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        });
      }
      if (body.operationName === "reportById") {
        return sendJson(res, 200, {
          data: {
            reportByID: reports.find(report => report.id === body.variables.id) || null
          }
        });
      }
      if (body.operationName === "reportComments") {
        return sendJson(res, 200, {
          data: {
            reportComments: {
              nodes: comments.get(body.variables.id) || [],
              pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null }
            }
          }
        });
      }
      if (body.operationName === "createReportComment") {
        const created = {
          __typename: "ReportComment",
          date: "2026-07-03T12:00:00Z",
          id: "comment-new",
          message: body.variables.input.message,
          status: "PUBLISHED",
          user: { id: "admin-1", username: "admin", displayName: "Server Admin", isHidden: false, isMuted: false, isBlocked: false }
        };
        const issueComments = comments.get(body.variables.input.report) || [];
        issueComments.push(created);
        comments.set(body.variables.input.report, issueComments);
        const report = reports.find(item => item.id === body.variables.input.report);
        report.commentCount = issueComments.length;
        return sendJson(res, 200, { data: { createReportComment: created } });
      }
      return sendJson(res, 400, { errors: [{ message: `unexpected GraphQL operation ${body.operationName}` }] });
    }
    if (req.method === "GET" && url.pathname === "/plex/library/metadata/123") {
      return sendJson(res, 200, {
        MediaContainer: {
          Metadata: [{
            ratingKey: "123",
            key: "/library/metadata/123",
            guid: "plex://movie/abc123",
            type: "movie",
            title: "Example Movie",
            year: 2026,
            librarySectionTitle: "Movies"
          }]
        }
      });
    }
    if (req.method === "GET" && url.pathname === "/plex/library/metadata/456") {
      return sendJson(res, 200, {
        MediaContainer: {
          Metadata: [{
            ratingKey: "456",
            key: "/library/metadata/456",
            guid: "plex://episode/def456",
            type: "episode",
            title: "Pilot",
            grandparentTitle: "Example Show",
            parentTitle: "Season 1",
            grandparentRatingKey: "455",
            librarySectionTitle: "TV Shows"
          }]
        }
      });
    }
    if (req.method === "GET" && url.pathname === "/plex/status/sessions") {
      return sendJson(res, 200, {
        MediaContainer: {
          Metadata: [{
            sessionKey: "session-1",
            ratingKey: "123",
            type: "movie",
            title: "Example Movie",
            User: { id: 10, username: "viewer", title: "Viewer One" },
            Player: { title: "Apple TV", product: "Plex for Apple TV", platform: "tvOS", state: "playing", local: false },
            TranscodeSession: { key: "transcode-1", videoDecision: "copy", audioDecision: "transcode" }
          }]
        }
      });
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
      PLEX_URL: `http://127.0.0.1:${mockPort}/plex`,
      PLEX_TOKEN: "plex-token",
      PLEX_COMMUNITY_URL: `http://127.0.0.1:${mockPort}/community`
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
      clientInfo: { name: "plex-report-test", version: "1" }
    });
    await rpc("notifications/initialized", {}, false);

    const tools = await rpc("tools/list");
    const toolNames = new Set(tools.result.tools.map(toolInfo => toolInfo.name));
    assert.ok(toolNames.has("plex_add_reported_issue_comment"));
    assert.ok(toolNames.has("plex_update_reported_issue_state"));

    const listed = await tool("plex_reported_issues", { source: "plex", status: "open", take: 10 });
    assert.deepEqual(listed.sources, ["plex"]);
    assert.equal(listed.records.length, 2);
    assert.equal(listed.records[0].source, "plex");
    assert.equal(listed.records[0].mediaTitle, "Example Movie");
    assert.equal(listed.records[0].plexRatingKey, "123");
    assert.equal(listed.records[0].plexGuid, "plex://movie/abc123");
    assert.equal(listed.records[0].reporter.displayName, "Viewer One");
    assert.equal(listed.records[0].reporter.avatar, undefined);

    const recent = await tool("plex_recent_user_reports", { take: 10 });
    assert.equal(recent.records[0].id, "report-2");
    assert.equal(recent.records[0].mediaType, "tv");

    const resolved = await tool("plex_reported_issues", { source: "plex", status: "resolved" });
    assert.equal(resolved.records.length, 0);
    assert.match(resolved.note, /do not expose resolved\/closed/i);

    const details = await tool("plex_issue_details", { source: "plex", issueId: "report-1", verbose: true });
    assert.equal(details.issue.comments.length, 1);
    assert.equal(details.issue.comments[0].message, "I can reproduce this on Apple TV.");
    assert.equal(details.issue.raw.report.id, "report-1");
    assert.equal(details.plex.metadata.title, "Example Movie");
    assert.equal(details.plex.activeSessions.length, 1);

    const diagnosis = await tool("media_diagnose_issue", { source: "plex", issueId: "report-1" });
    assert.equal(diagnosis.issue.id, "report-1");
    assert.equal(diagnosis.tautulli.configured, false);
    assert.equal(diagnosis.tracearr.configured, false);
    assert.equal(diagnosis.suggestedActions[0].type, "plex_add_reported_issue_comment");
    assert.match(diagnosis.limitations[0], /do not expose/i);

    const beforeCommentMutations = graphqlCalls.filter(call => call.operationName === "createReportComment").length;
    const dryComment = await tool("plex_add_reported_issue_comment", {
      issueId: "report-1",
      message: "Checking the source file.",
      dryRun: true
    });
    assert.equal(dryComment.dryRun, true);
    assert.equal(dryComment.issue.comments.length, 1);
    assert.equal(graphqlCalls.filter(call => call.operationName === "createReportComment").length, beforeCommentMutations);

    const added = await tool("plex_add_reported_issue_comment", {
      issueId: "report-1",
      message: "I found the likely source file problem.",
      dryRun: false
    });
    assert.equal(added.dryRun, false);
    assert.equal(added.comment.message, "I found the likely source file problem.");
    assert.equal(added.issue.comments.length, 2);

    const dryState = await tool("plex_update_reported_issue_state", {
      issueId: "report-1",
      action: "resolve",
      dryRun: true
    });
    assert.equal(dryState.supported, false);
    assert.equal(dryState.applied, false);
    assert.equal(dryState.wouldSetStatus, "resolved");

    const appliedState = await tool("plex_update_reported_issue_state", {
      issueId: "report-1",
      action: "reopen",
      dryRun: false
    });
    assert.equal(appliedState.supported, false);
    assert.equal(appliedState.applied, false);
    assert.equal(appliedState.wouldSetStatus, "open");
    assert.equal(graphqlCalls.some(call => /state/i.test(call.operationName)), false);
  } finally {
    child.kill("SIGTERM");
    mock.close();
    await once(mock, "close");
  }
}

run().then(() => {
  console.log("plex reported issue tests passed");
}).catch(error => {
  console.error(error);
  process.exit(1);
});
