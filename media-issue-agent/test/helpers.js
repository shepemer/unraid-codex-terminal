import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function closeServer(server) {
  if (!server) {
    return;
  }
  await new Promise(resolve => server.close(resolve));
}

export async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

export function jsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{
        type: "text",
        text: JSON.stringify(result)
      }]
    }
  };
}

export function jsonRpcError(id, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message
    }
  };
}

export async function createCodexHome(root, auth = {}) {
  const codexHome = path.join(root, "codex-home");
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "fixture-id-token",
      access_token: "fixture-access-token",
      refresh_token: "fixture-refresh-token",
      account_id: "fixture-account",
      ...(auth.tokens || {})
    },
    last_refresh: "2026-01-01T00:00:00.000000000Z",
    ...auth
  }, null, 2));
  return codexHome;
}
