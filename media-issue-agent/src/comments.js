export const AUTOMATED_SUFFIX = "Automated response from Codex.";
export const CLOSED_MARKER = "Closed.";
export const REOPENED_MARKER = "Re-opened issue.";

export function countCharacters(value) {
  return [...String(value ?? "")].length;
}

export function validateDraftComment(source, message) {
  const text = String(message ?? "");
  const errors = [];
  if (!text.trim()) {
    errors.push("Comment must not be empty.");
  }
  if (!text.endsWith(AUTOMATED_SUFFIX)) {
    errors.push(`Comment must end with: ${AUTOMATED_SUFFIX}`);
  }
  const characterCount = countCharacters(text);
  if (source === "plex" && characterCount > 300) {
    errors.push(`Plex-native comments must be 300 characters or fewer; got ${characterCount}.`);
  }
  return { valid: errors.length === 0, characterCount, errors };
}
