import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

function parseResponse(text) {
  if (!text.startsWith("event:")) {
    return JSON.parse(text);
  }
  const data = text.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim();
  return JSON.parse(data);
}

async function run() {
  const requests = [];
  const scrutiny = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/scrutiny/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected path" }));
  });
  scrutiny.listen(0, "127.0.0.1");
  await once(scrutiny, "listening");

  const scrutinyPort = scrutiny.address().port;
  const utilitiesPort = await freePort();
  const childEnv = {
    ...process.env,
    UTILITIES_MCP_BEARER_TOKEN: "test-token",
    UTILITIES_MCP_HOST: "127.0.0.1",
    UTILITIES_MCP_PORT: String(utilitiesPort),
    SCRUTINY_URL: `http://127.0.0.1:${scrutinyPort}/scrutiny`
  };
  delete childEnv.SCRUTINY_BASE_PATH;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const childExit = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => {
    stdout += chunk;
  });
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });

  const mcpUrl = `http://127.0.0.1:${utilitiesPort}/mcp`;
  let id = 1;
  async function rpc(method, params = {}, hasId = true) {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(hasId ? { id: id++ } : {}), method, params })
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP ${response.status}: ${text}\nstdout=${stdout}\nstderr=${stderr}`);
    }
    return hasId && text ? parseResponse(text) : null;
  }

  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${utilitiesPort}/health`, {
          headers: { authorization: "Bearer test-token" }
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // Retry while the child initializes.
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, `utilities-mcp did not start\nstdout=${stdout}\nstderr=${stderr}`);

    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "scrutiny-url-test", version: "1" }
    });
    await rpc("notifications/initialized", {}, false);
    const result = await rpc("tools/call", {
      name: "scrutiny_health",
      arguments: {}
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.result.isError, true);
    assert.deepEqual(JSON.parse(result.result.content[0].text), { success: true });
    assert.deepEqual(requests, ["/scrutiny/api/health"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    const scrutinyClosed = once(scrutiny, "close");
    scrutiny.close();
    await Promise.all([
      childExit,
      scrutinyClosed
    ]);
  }
}

run().then(() => {
  console.log("Scrutiny URL path test passed");
}).catch(error => {
  console.error(error);
  process.exit(1);
});
