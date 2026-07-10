const SECRET_KEY_PATTERN = /(authorization|bearer|token|api[_-]?key|password|passwd|secret|cookie|session)/i;
const NON_SECRET_CONTAINER_KEYS = new Set(["tokenUsage"]);
const NON_SECRET_TOKEN_COUNT_KEY_PATTERN = /^(inputTokens|cachedInputTokens|outputTokens|reasoningOutputTokens|totalTokens|input_tokens|cached_input_tokens|output_tokens|reasoning_output_tokens|total_tokens)$/;
const PATH_ROOT_PATTERN = String.raw`(?:\/Users|\/home|\/mnt\/user|\/mnt\/unraid|\/config|\/codex-home|\/boot|\/var\/run|\/var\/folders|\/private\/var|\/tmp|\/state|\/data|\/tv|\/movies|\/movie|\/downloads|\/download|\/music|\/photos|\/media)`;
const MEDIA_PATH_PATTERN = new RegExp(`${PATH_ROOT_PATTERN}\\/.+?(?=(?:,\\s*[A-Za-z][A-Za-z0-9_-]*=)|["'<>\\r\\n]|$)`, "g");
const LABELED_SECRET_NAMES = String.raw`(?:access[_-]?token|refresh[_-]?token|id[_-]?token|x-plex-token|x-api-key|api[_-]?key|authorization|bearer|password|passwd|client[_-]?secret|secret|cookie|session|token)`;

const TEXT_PATTERNS = [
  [new RegExp(`((?:"|')?${LABELED_SECRET_NAMES}(?:"|')?\\s*:\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*')`, "gi"), '$1"[REDACTED]"'],
  [new RegExp(`\\b(${LABELED_SECRET_NAMES}\\s*=\\s*)[^\\s,;]+`, "gi"), "$1[REDACTED]"],
  [new RegExp(`\\b((?:authorization|x-plex-token|x-api-key)\\s*:\\s*)[^\\r\\n]+`, "gi"), "$1[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/\-=]+/gi, "Bearer [REDACTED]"],
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|(?:gho|ghp|github_pat)_[A-Za-z0-9_=-]{8,})\b/g, "[REDACTED_TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [/\b[A-Za-z0-9_]*API[_-]?KEY[A-Za-z0-9_]*\s*=\s*[^\s]+/gi, "API_KEY=[REDACTED]"],
  [/\b[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*=\s*[^\s]+/gi, "TOKEN=[REDACTED]"],
  [/https?:\/\/[^\s"'<>),]+/gi, "[REDACTED_URL]"],
  [/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g, "[REDACTED_PRIVATE_IP]"],
  [MEDIA_PATH_PATTERN, "[REDACTED_PATH]"]
];

export function redactText(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function sanitizeValue(value, key = "") {
  if (value === null || value === undefined) {
    return value;
  }
  if (
    SECRET_KEY_PATTERN.test(key)
    && !NON_SECRET_CONTAINER_KEYS.has(key)
    && !(NON_SECRET_TOKEN_COUNT_KEY_PATTERN.test(key) && typeof value === "number")
  ) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item));
  }
  if (
    typeof value.Name === "string"
    && SECRET_KEY_PATTERN.test(value.Name)
    && Object.prototype.hasOwnProperty.call(value, "Value")
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        childKey === "Value" ? "[REDACTED]" : sanitizeValue(childValue, childKey)
      ])
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey)])
  );
}

export function redactJson(value) {
  return JSON.stringify(sanitizeValue(value), null, 2);
}
