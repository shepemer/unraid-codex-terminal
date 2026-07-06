import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { sanitizeValue } from "./redact.js";

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Codex timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
    child.on("close", code => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Codex exited with ${code}: ${stderr || stdout}`));
      }
    });
  });
}

export function investigationPrompt(evidence) {
  return [
    "You are Codex running inside media-issue-agent.",
    "Use only the sanitized evidence below. Do not infer private URLs, tokens, hostnames, or identities.",
    "Do not execute fixes. Return a concise investigation summary, likely causes, and exact safe next actions.",
    "Mention user-side causes separately from server-side actions.",
    "",
    "Sanitized evidence JSON:",
    JSON.stringify(sanitizeValue(evidence), null, 2)
  ].join("\n");
}

export function commentDraftPrompt(evidence) {
  return [
    "Draft a reporter-facing media issue update from the sanitized evidence below.",
    "The comment must be understandable to the reporter and useful to the server owner.",
    "End exactly with: Automated response from Codex.",
    "If the source is Plex, keep the whole comment at 300 characters or fewer.",
    "",
    "Sanitized evidence JSON:",
    JSON.stringify(sanitizeValue(evidence), null, 2)
  ].join("\n");
}

export async function runCodex(config, prompt) {
  await mkdir(config.codexWorkspace, { recursive: true });
  const env = {
    ...process.env,
    CODEX_HOME: config.codexHome,
    HOME: process.env.HOME || "/home/agent"
  };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  const result = await runProcess(
    config.codexBin,
    ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-"],
    {
      cwd: config.codexWorkspace,
      env,
      input: prompt,
      timeoutMs: config.codexTimeoutMs
    }
  );
  return result.stdout.trim();
}
