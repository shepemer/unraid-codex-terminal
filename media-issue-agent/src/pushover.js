import { redactText } from "./redact.js";

export const PUSHOVER_MESSAGES_URL = "https://api.pushover.net/1/messages.json";

function compactText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

export function pushoverConfigured(config = {}) {
  return Boolean(config.pushoverAppToken && config.pushoverUserKey);
}

export function newOpenIssuePushoverPayload(config, issue) {
  const source = String(issue.source || "issue").toUpperCase();
  const title = compactText(`New ${source} media issue`, 250);
  const mediaTitle = compactText(issue.mediaTitle || "Unknown media", 160);
  const reporter = compactText(issue.reporter || "unknown reporter", 80);
  const description = compactText(issue.description || "No description provided.", 420);
  const message = [
    mediaTitle,
    `Reporter: ${reporter}`,
    `Issue: ${issue.source} ${issue.issueId}`,
    description
  ].join("\n");
  const payload = {
    token: config.pushoverAppToken,
    user: config.pushoverUserKey,
    title,
    message
  };
  return payload;
}

export async function sendPushoverMessage(config, issue, fetchImpl = globalThis.fetch) {
  if (!pushoverConfigured(config)) {
    return { skipped: true, reason: "not_configured" };
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Pushover notifications require fetch support.");
  }
  const payload = newOpenIssuePushoverPayload(config, issue);
  const response = await fetchImpl(PUSHOVER_MESSAGES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(10000),
    body: new URLSearchParams(payload)
  });
  if (!response.ok) {
    const text = typeof response.text === "function" ? await response.text() : "";
    throw new Error(`Pushover notification failed with HTTP ${response.status}: ${redactText(text)}`);
  }
  return { skipped: false, status: response.status };
}
