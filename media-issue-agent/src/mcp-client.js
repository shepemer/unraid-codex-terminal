import { redactText } from "./redact.js";

function parseMcpResponse(text, expectedId = null) {
  if (!text.startsWith("event:")) {
    return JSON.parse(text);
  }
  const frames = text.split(/\r?\n\r?\n/).map(frame => frame.trim()).filter(Boolean);
  const parsedFrames = [];
  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) {
      continue;
    }
    try {
      parsedFrames.push(JSON.parse(data));
    } catch {
      continue;
    }
  }
  return parsedFrames.find(frame => frame?.id === expectedId && (frame.result || frame.error))
    || parsedFrames.find(frame => frame?.result || frame?.error)
    || parsedFrames.at(-1)
    || null;
}

export class MediaMcpClient {
  constructor(config) {
    this.url = config.mediaMcpUrl;
    this.token = config.mediaMcpBearerToken;
    this.timeoutMs = config.mcpRequestTimeoutMs;
    this.id = 1;
  }

  async request(method, params = {}, label = method) {
    const body = {
      jsonrpc: "2.0",
      id: this.id++,
      method,
      params
    };
    const response = await fetch(this.url, {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`media-mcp ${response.status}: ${redactText(text)}`);
    }
    const parsed = parseMcpResponse(text, body.id);
    if (parsed?.error) {
      throw new Error(`media-mcp ${label} failed: ${redactText(parsed.error.message || JSON.stringify(parsed.error))}`);
    }
    if (parsed?.result?.isError) {
      const message = parsed.result.content?.[0]?.text || "tool returned error";
      throw new Error(`media-mcp ${label} failed: ${redactText(message)}`);
    }
    return parsed?.result;
  }

  async callTool(name, args = {}) {
    const result = await this.request("tools/call", {
      name,
      arguments: args
    }, name);
    const toolText = result?.content?.[0]?.text;
    return toolText ? JSON.parse(toolText) : result;
  }

  async listTools() {
    const result = await this.request("tools/list", {}, "tools/list");
    return Array.isArray(result?.tools) ? result.tools : [];
  }
}
