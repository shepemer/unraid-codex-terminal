import { redactText } from "./redact.js";

function parseMcpResponse(text) {
  if (!text.startsWith("event:")) {
    return JSON.parse(text);
  }
  const data = text.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim();
  return data ? JSON.parse(data) : null;
}

export class MediaMcpClient {
  constructor(config) {
    this.url = config.mediaMcpUrl;
    this.token = config.mediaMcpBearerToken;
    this.timeoutMs = config.mcpRequestTimeoutMs;
    this.id = 1;
  }

  async callTool(name, args = {}) {
    const body = {
      jsonrpc: "2.0",
      id: this.id++,
      method: "tools/call",
      params: {
        name,
        arguments: args
      }
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
    const parsed = parseMcpResponse(text);
    if (parsed?.error) {
      throw new Error(`media-mcp ${name} failed: ${redactText(parsed.error.message || JSON.stringify(parsed.error))}`);
    }
    if (parsed?.result?.isError) {
      const message = parsed.result.content?.[0]?.text || "tool returned error";
      throw new Error(`media-mcp ${name} failed: ${redactText(message)}`);
    }
    const toolText = parsed?.result?.content?.[0]?.text;
    return toolText ? JSON.parse(toolText) : parsed?.result;
  }
}
