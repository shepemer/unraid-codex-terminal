const SECRET_KEY_PATTERN = /(authorization|bearer|token|api[_-]?key|password|passwd|secret|cookie|session)/i;

const TEXT_PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+/\-=]+/gi, "Bearer [REDACTED]"],
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|(?:gho|ghp|github_pat)_[A-Za-z0-9_=-]{8,})\b/g, "[REDACTED_TOKEN]"],
  [/\b[A-Za-z0-9_]*API[_-]?KEY[A-Za-z0-9_]*\s*=\s*[^\s]+/gi, "API_KEY=[REDACTED]"],
  [/\b[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*=\s*[^\s]+/gi, "TOKEN=[REDACTED]"],
  [/https?:\/\/[^\s"'<>),]+/gi, "[REDACTED_URL]"],
  [/(?:\/Users|\/home|\/mnt\/user|\/mnt\/unraid|\/config|\/boot|\/var\/run)\/[^\s"'<>),]+/g, "[REDACTED_PATH]"]
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
  if (SECRET_KEY_PATTERN.test(key)) {
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
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey)])
  );
}

export function redactJson(value) {
  return JSON.stringify(sanitizeValue(value), null, 2);
}
