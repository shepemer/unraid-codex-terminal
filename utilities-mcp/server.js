import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from "zod/v4";

const env = process.env;
const port = Number(env.UTILITIES_MCP_PORT || 6972);
const host = env.UTILITIES_MCP_HOST || "0.0.0.0";
const bearerToken = env.UTILITIES_MCP_BEARER_TOKEN || "";
const requestTimeoutMs = Number(env.UTILITIES_MCP_REQUEST_TIMEOUT_MS || 30000);
const allowedHosts = allowedHostnames(env.UTILITIES_MCP_ALLOWED_HOSTS, "utilities-mcp", host);

if (!bearerToken) {
  console.error("utilities-mcp: UTILITIES_MCP_BEARER_TOKEN is required");
  process.exit(1);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("utilities-mcp: UTILITIES_MCP_PORT must be a valid TCP port");
  process.exit(1);
}

if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000) {
  console.error("utilities-mcp: UTILITIES_MCP_REQUEST_TIMEOUT_MS must be at least 1000");
  process.exit(1);
}

const configuredServices = {
  scrutiny: scrutinyConfig()
};

if (!Object.values(configuredServices).some(Boolean)) {
  console.error("utilities-mcp: configure at least one supported utility service");
  process.exit(1);
}

function scrutinyConfig() {
  const url = env.SCRUTINY_URL;
  const basePath = env.SCRUTINY_BASE_PATH || "";
  if (!url && !basePath) {
    return null;
  }
  if (!url) {
    console.error("utilities-mcp: SCRUTINY_URL is required when SCRUTINY_BASE_PATH is set");
    process.exit(1);
  }
  return { url: normalizeBaseUrl(url), basePath: normalizePath(basePath) };
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

function normalizePath(value) {
  return value.replace(/^\/+|\/+$/g, "");
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

function applyQuery(url, query = {}) {
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function serviceUrl(service, path) {
  const segments = [service.basePath, path]
    .filter(Boolean)
    .map(segment => String(segment).replace(/^\/+|\/+$/g, ""));
  return new URL(segments.length ? `${service.url}/${segments.join("/")}` : `${service.url}/`);
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

async function scrutinyApi(path, options = {}) {
  const service = requireService("scrutiny");
  const url = applyQuery(serviceUrl(service, `api/${path.replace(/^\/+/, "")}`), options.query);
  return fetchJson(url, { method: "GET", headers: { Accept: "application/json" } });
}

async function serviceStatus(name) {
  try {
    switch (name) {
      case "scrutiny":
        return { configured: true, health: await scrutinyApi("health") };
      default:
        return { configured: false };
    }
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

function createServer() {
  const server = new McpServer({
    name: "unraid-codex-utilities-mcp",
    version: "0.1.0"
  });

  server.registerTool("utilities_services_status", {
    title: "Utilities Services Status",
    description: "Check configured Scrutiny storage health service."
  }, async () => {
    const entries = await Promise.all(Object.entries(configuredServices).map(async ([name, config]) => {
      if (!config) {
        return [name, { configured: false }];
      }
      return [name, await serviceStatus(name)];
    }));
    return jsonText(Object.fromEntries(entries));
  });

  server.registerTool("scrutiny_health", {
    title: "Scrutiny Health",
    description: "Get Scrutiny API health."
  }, async () => jsonText(await scrutinyApi("health")));

  server.registerTool("scrutiny_device_summary", {
    title: "Scrutiny Device Summary",
    description: "List Scrutiny device health summaries."
  }, async () => jsonText(await scrutinyApi("summary")));

  server.registerTool("scrutiny_temperature_history", {
    title: "Scrutiny Temperature History",
    description: "Get Scrutiny device temperature history used by the dashboard."
  }, async () => jsonText(await scrutinyApi("summary/temp")));

  server.registerTool("scrutiny_device_details", {
    title: "Scrutiny Device Details",
    description: "Get Scrutiny details for a device UUID.",
    inputSchema: {
      scrutinyUuid: z.string().min(1)
    }
  }, async ({ scrutinyUuid }) => jsonText(await scrutinyApi(`device/${encodeURIComponent(scrutinyUuid)}/details`)));

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
    console.error("utilities-mcp: failed handling MCP request:", error);
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
    console.error("utilities-mcp: failed to start:", error);
    process.exit(1);
  }
  console.error(`utilities-mcp: listening on ${host}:${port}`);
});
