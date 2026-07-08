import { CLOSED_MARKER, REOPENED_MARKER } from "./comments.js";
import { redactText } from "./redact.js";

function firstString(...values) {
  return values.find(value => typeof value === "string" && value.trim())?.trim() || "";
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasPlexClosedComment(comments) {
  return issueLifecycleFromComments(comments).closed;
}

function markerType(message) {
  const normalized = String(message ?? "").trim().toLowerCase();
  if (normalized === CLOSED_MARKER.toLowerCase()) {
    return "closed";
  }
  if (normalized === REOPENED_MARKER.toLowerCase()) {
    return "open";
  }
  return null;
}

function commentTimestamp(comment) {
  const timestamp = Date.parse(comment?.createdAt || comment?.updatedAt || comment?.date || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function issueLifecycleFromComments(comments, fallbackStatus = "") {
  const markers = [];
  if (Array.isArray(comments)) {
    comments.forEach((comment, index) => {
      const type = markerType(comment?.message);
      if (!type) return;
      markers.push({ type, index, timestamp: commentTimestamp(comment) });
    });
  }
  const allMarkersHaveTimestamps = markers.length > 0 && markers.every(marker => marker.timestamp !== null);
  const latest = allMarkersHaveTimestamps
    ? markers.toSorted((left, right) => left.timestamp - right.timestamp || left.index - right.index).at(-1)
    : markers.at(-1);
  if (latest) {
    return {
      status: latest.type,
      closed: latest.type === "closed",
      marker: latest.type === "closed" ? CLOSED_MARKER : REOPENED_MARKER
    };
  }
  const normalizedStatus = String(fallbackStatus || "").toLowerCase();
  const closed = normalizedStatus.includes("closed") || normalizedStatus.includes("resolved");
  return {
    status: closed ? "closed" : "open",
    closed,
    marker: null
  };
}

export function plexNeedsCommentDetails(issue) {
  if (issue.source !== "plex") {
    return false;
  }
  return !Array.isArray(issue.comments) || Number(issue.commentCount || 0) > 0;
}

export function normalizeIssue(issue) {
  const lifecycle = issueLifecycleFromComments(issue.comments, firstString(issue.status, issue.rawStatus, "open"));
  const reporter = typeof issue.reporter === "string"
    ? issue.reporter
    : firstString(issue.reporter?.displayName, issue.reporter?.username, issue.user?.displayName, issue.user?.username);
  const mediaTitle = firstString(
    issue.mediaTitle,
    issue.title,
    issue.subject,
    issue.metadata?.title,
    issue.media?.title,
    issue.mediaInfo?.title
  );
  return {
    source: issue.source,
    issueId: String(issue.id ?? issue.issueId),
    date: firstString(issue.date, issue.createdAt, issue.updatedAt),
    reporter,
    mediaTitle,
    status: lifecycle.closed ? "closed" : firstString(issue.status, issue.rawStatus, "open"),
    lifecycle: lifecycle.status,
    isClosed: lifecycle.closed,
    lifecycleMarker: lifecycle.marker,
    description: firstString(issue.description, issue.message, issue.subject),
    createdAt: issue.createdAt || issue.date || "",
    updatedAt: issue.updatedAt || "",
    detailError: issue.detailError || "",
    detailToolName: issue.detailToolName || "",
    detailUnavailable: Boolean(issue.detailUnavailable),
    raw: issue
  };
}

function needsCommentDetails(issue) {
  if (issue.source === "plex") {
    return plexNeedsCommentDetails(issue);
  }
  return !Array.isArray(issue.comments) && Number(issue.commentCount || 0) > 0;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) {
        return;
      }
      results[index] = await mapper(values[index], index);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, values.length || 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

function issueSource(record) {
  return String(record?.source || "").toLowerCase();
}

function issueId(record) {
  return String(record?.id ?? record?.issueId);
}

function detailToolName(record) {
  if (issueSource(record) === "seerr") {
    return "seerr_issue_details";
  }
  return "plex_issue_details";
}

function detailToolArgs(record, toolName) {
  if (toolName === "seerr_issue_details") {
    return {
      issueId: Number(issueId(record)),
      verbose: false
    };
  }
  return {
    source: record.source,
    issueId: issueId(record),
    verbose: false
  };
}

export async function issueQueue(records, client, options = {}) {
  const detailConcurrency = Math.max(1, Math.min(Number(options.detailConcurrency || 4), 16));
  const queued = await mapWithConcurrency(records, detailConcurrency, async record => {
    let issue = record;
    if (needsCommentDetails(record)) {
      const toolName = detailToolName(record);
      try {
        const details = await client.callTool(toolName, detailToolArgs(record, toolName));
        issue = { ...record, ...(details.issue || details) };
      } catch (error) {
        const detailError = redactText(error.message);
        options.onDetailError?.({
          source: record.source,
          issueId: issueId(record),
          toolName,
          error: detailError
        });
        issue = {
          ...record,
          detailError,
          detailToolName: toolName,
          detailUnavailable: true
        };
      }
    }
    return normalizeIssue(issue);
  });
  return queued.sort((left, right) => {
    if (left.isClosed !== right.isClosed) {
      return left.isClosed ? 1 : -1;
    }
    const leftDate = left.updatedAt || left.createdAt || left.date || "";
    const rightDate = right.updatedAt || right.createdAt || right.date || "";
    return rightDate.localeCompare(leftDate);
  });
}

export async function filterOpenIssues(records, client) {
  return (await issueQueue(records, client)).filter(issue => !issue.isClosed);
}

export function issueTableMarkdown(entries) {
  const rows = [
    "| # | Source | Issue ID | Date | Reporter | Media/title | Status | Description |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  entries.forEach((entry, index) => {
    rows.push([
      index + 1,
      escapeMarkdownCell(entry.source),
      escapeMarkdownCell(entry.issueId),
      escapeMarkdownCell(entry.date),
      escapeMarkdownCell(entry.reporter),
      escapeMarkdownCell(entry.mediaTitle),
      escapeMarkdownCell(entry.status),
      escapeMarkdownCell(entry.description)
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  });
  return rows.join("\n");
}
