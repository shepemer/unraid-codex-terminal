import crypto from "node:crypto";

export const OPENAI_MODERATIONS_URL = "https://api.openai.com/v1/moderations";
export const SLACK_MODERATION_MODEL = "omni-moderation-latest";
export const SLACK_MODERATION_POLICY_VERSION = "2026-07-25.1";
export const SLACK_MODERATION_MAX_CHARACTERS = 4000;

const MODERATION_TIMEOUT_MS = 10000;
const MODERATION_MAX_ATTEMPTS = 2;
const INVISIBLE_OR_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const NON_THREATENING_HARASSMENT = new Set(["harassment"]);

function compact(value, maxLength = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizeSlackModerationText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(INVISIBLE_OR_CONTROL_CHARACTERS, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

export function createSlackPendingEncryptionKey() {
  return crypto.randomBytes(32);
}

export function keyedSlackContentDigest(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Slack content digest requires a 32-byte process key.");
  }
  return crypto.createHmac("sha256", key)
    .update(normalizeSlackModerationText(value))
    .digest("hex");
}

function pendingAad(reference) {
  return Buffer.from(`media-issue-agent:slack-moderation:${String(reference || "")}`, "utf8");
}

export function encryptSlackPendingText(value, key, reference) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Slack pending-message encryption requires a 32-byte process key.");
  }
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(pendingAad(reference));
  const plaintext = Buffer.from(String(value ?? ""), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    contentDigest: keyedSlackContentDigest(value, key)
  };
}

export function decryptSlackPendingText(payload, key, reference) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Slack pending-message decryption requires a 32-byte process key.");
  }
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(String(payload?.nonce || ""), "base64")
    );
    decipher.setAAD(pendingAad(reference));
    decipher.setAuthTag(Buffer.from(String(payload?.authTag || ""), "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(String(payload?.ciphertext || ""), "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new Error("Encrypted Slack pending message could not be decrypted.");
  }
}

export function highConfidenceSlackSafetyCategory(value) {
  const text = normalizeSlackModerationText(value);
  if (
    /\b(?:sk-[A-Za-z0-9_-]{8,}|(?:gho|ghp|github_pat)_[A-Za-z0-9_=-]{8,}|(?:xox[abprs]|xapp)-[A-Za-z0-9-]{8,})\b/i.test(text)
    || /\b(?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd)\s*[:=]\s*\S+/i.test(text)
  ) {
    return "exposed_secret";
  }
  if (
    /\b(?:doxx?|find|locate|publish|post|reveal|share|give me|track down)\b.{0,120}\b(?:home address|private address|phone number|personal email|where .{0,40} lives|private information)\b/i.test(text)
  ) {
    return "doxxing";
  }
  if (
    /\b(?:steal|phish|harvest|dump|exfiltrate)\b.{0,100}\b(?:credentials?|passwords?|session cookies?|access tokens?|api keys?)\b/i.test(text)
  ) {
    return "credential_theft";
  }
  return "";
}

export function parseOpenAiModerationResponse(payload) {
  const result = payload?.results?.[0];
  if (!result || typeof result.flagged !== "boolean") {
    throw new Error("OpenAI Moderation API returned a malformed response.");
  }
  if (!result.categories || typeof result.categories !== "object" || Array.isArray(result.categories)) {
    throw new Error("OpenAI Moderation API response is missing categories.");
  }
  if (!result.category_scores || typeof result.category_scores !== "object" || Array.isArray(result.category_scores)) {
    throw new Error("OpenAI Moderation API response is missing category scores.");
  }
  const categories = Object.fromEntries(
    Object.entries(result.categories).map(([name, flagged]) => [String(name), flagged === true])
  );
  const categoryScores = Object.fromEntries(
    Object.entries(result.category_scores)
      .filter(([, score]) => Number.isFinite(Number(score)))
      .map(([name, score]) => [String(name), Number(score)])
  );
  return {
    id: compact(payload.id, 160),
    model: compact(payload.model || SLACK_MODERATION_MODEL, 120),
    flagged: result.flagged,
    categories,
    categoryScores
  };
}

function primaryBlockedCategory(flaggedCategories) {
  const ordered = [
    ["sexual/minors", "sexual_minors"],
    ["self-harm/intent", "self_harm"],
    ["self-harm/instructions", "self_harm"],
    ["self-harm", "self_harm"],
    ["hate/threatening", "hate_threatening"],
    ["harassment/threatening", "harassment_threatening"],
    ["illicit/violent", "illicit_violent"],
    ["violence/graphic", "graphic_violence"],
    ["hate", "hate"],
    ["illicit", "illicit"],
    ["sexual", "sexual"],
    ["violence", "violence"],
    ["harassment", "harassment"]
  ];
  return ordered.find(([name]) => flaggedCategories.includes(name))?.[1] || "policy_violation";
}

export function decideSlackModeration(parsed, options = {}) {
  const flaggedCategories = Object.entries(parsed?.categories || {})
    .filter(([, flagged]) => flagged === true)
    .map(([name]) => name)
    .sort();
  if (!parsed?.flagged) {
    return { verdict: "allow", category: "", flaggedCategories };
  }
  if (
    options.direction !== "outbound"
    && flaggedCategories.length > 0
    && flaggedCategories.every(category => NON_THREATENING_HARASSMENT.has(category))
  ) {
    return {
      verdict: "allow",
      category: "non_threatening_harassment",
      flaggedCategories
    };
  }
  return {
    verdict: "block",
    category: primaryBlockedCategory(flaggedCategories),
    flaggedCategories
  };
}

export function blockedSlackResponse(category) {
  if (category === "self_harm") {
    return "I am concerned about what you wrote. Please contact someone you trust or local emergency services now if there is any immediate danger.";
  }
  if (category === "exposed_secret") {
    return "That message appears to contain a credential or secret. Revoke or rotate it, then resend the request without the sensitive value.";
  }
  if (category === "doxxing") {
    return "Leave the private-person details out. Describe the legitimate outcome you need without identifying or locating anyone.";
  }
  if (category === "credential_theft") {
    return "Reframe that around securing or recovering the account or system, without trying to obtain someone else's credentials.";
  }
  if (category === "hate" || category === "hate_threatening") {
    return "I can help with the underlying conflict or question, but leave out attacks on people for who they are. Rephrase it around the actual situation or outcome.";
  }
  if (category === "harassment_threatening" || category === "violence") {
    return "I can help de-escalate this or work through a safe next step, but not carry forward threats or violent content. If someone is in immediate danger, contact local emergency services.";
  }
  if (category === "illicit" || category === "illicit_violent") {
    return "Tell me the legitimate outcome you are trying to reach, without instructions for wrongdoing or harm, and I will help find a safe route.";
  }
  if (category === "graphic_violence") {
    return "Leave out the graphic details. If this is a media report, send the title and the technical playback, metadata, or file-quality symptom instead.";
  }
  if (category === "sexual" || category === "sexual_minors") {
    return "Keep the message non-explicit. If this is a media report, send only the title and the technical playback, subtitle, metadata, or file-quality problem.";
  }
  if (category === "prompt_injection") {
    return "That prompt-injection attempt was discarded. Ask the actual question without fake instructions or attempts to override the system.";
  }
  if (category === "message_too_long") {
    return "That message is too long to process safely. Send the essential details in a message under 4,000 characters.";
  }
  if (category === "rate_limit") {
    return "You already have several requests in progress. Let those finish, then try again.";
  }
  return "I am not passing that content further. Rephrase the underlying request without harmful instructions or graphic detail.";
}

export function moderationErrorSlackResponse() {
  return "I cannot safely process that message right now. Please try again shortly.";
}

export function outboundModerationFallback(category = "") {
  if (category === "self_harm") {
    return blockedSlackResponse(category);
  }
  return "I could not safely send the drafted response. Please rephrase the request and try again.";
}

export class OpenAiModerationClient {
  constructor(config, options = {}) {
    this.apiKey = String(config?.slackModerationApiKey || "");
    this.fetch = options.fetch || globalThis.fetch;
    this.endpoint = options.endpoint || OPENAI_MODERATIONS_URL;
    this.timeoutMs = Number(options.timeoutMs || MODERATION_TIMEOUT_MS);
    this.maxAttempts = Number(options.maxAttempts || MODERATION_MAX_ATTEMPTS);
  }

  async moderate(input) {
    if (!this.apiKey) {
      throw new Error("OpenAI Moderation API key is not configured.");
    }
    if (typeof this.fetch !== "function") {
      throw new Error("OpenAI Moderation API requires fetch support.");
    }
    const startedAt = Date.now();
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          signal: AbortSignal.timeout(this.timeoutMs),
          body: JSON.stringify({
            model: SLACK_MODERATION_MODEL,
            input: String(input || "")
          })
        });
        if (!response.ok) {
          const error = new Error(`OpenAI Moderation API failed with HTTP ${response.status}.`);
          error.code = `http_${response.status}`;
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        const parsed = parseOpenAiModerationResponse(await response.json());
        return {
          ...parsed,
          latencyMs: Date.now() - startedAt
        };
      } catch (error) {
        lastError = error;
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        const retryable = timedOut || error?.retryable === true || error instanceof TypeError;
        if (!retryable || attempt >= this.maxAttempts) {
          break;
        }
        await wait(150 * attempt);
      }
    }
    const error = new Error(compact(lastError?.message || "OpenAI Moderation API request failed.", 240));
    error.code = lastError?.code || (lastError?.name === "TimeoutError" ? "timeout" : "request_failed");
    throw error;
  }
}
