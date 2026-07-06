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
  return Array.isArray(comments)
    && comments.some(comment => String(comment?.message ?? "").trim().toLowerCase() === "closed.");
}

export function plexNeedsCommentDetails(issue) {
  if (issue.source !== "plex") {
    return false;
  }
  return !Array.isArray(issue.comments) || Number(issue.commentCount || 0) > 0;
}

export function normalizeIssue(issue) {
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
    status: firstString(issue.status, issue.rawStatus, "open"),
    description: firstString(issue.description, issue.message, issue.subject),
    createdAt: issue.createdAt || issue.date || "",
    updatedAt: issue.updatedAt || "",
    raw: issue
  };
}

export async function filterOpenIssues(records, client) {
  const open = [];
  for (const record of records) {
    let issue = record;
    if (record.source === "plex" && plexNeedsCommentDetails(record)) {
      const details = await client.callTool("plex_issue_details", {
        source: "plex",
        issueId: String(record.id ?? record.issueId),
        verbose: false
      });
      issue = details.issue || details;
    }
    if (issue.source === "plex" && hasPlexClosedComment(issue.comments)) {
      continue;
    }
    open.push(normalizeIssue(issue));
  }
  return open.sort((left, right) => {
    const leftDate = left.updatedAt || left.createdAt || left.date || "";
    const rightDate = right.updatedAt || right.createdAt || right.date || "";
    return rightDate.localeCompare(leftDate);
  });
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
