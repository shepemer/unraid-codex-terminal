import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import { inspectCodexAuth } from "./config.js";
import { redactText, sanitizeValue } from "./redact.js";

const HTML = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Media Issue Agent</title>
  <script>
    const savedTheme = localStorage.getItem("media-issue-agent-theme");
    document.documentElement.dataset.theme = savedTheme || "dark";
  </script>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-block">
        <div class="app-mark" aria-hidden="true">MI</div>
        <div>
          <h1>Media Issue Agent</h1>
          <p id="snapshot-meta">No snapshot loaded</p>
        </div>
      </div>
      <nav class="toolbar" aria-label="Primary actions">
        <div class="theme-toggle" aria-label="Theme">
          <button type="button" data-theme-choice="light">Light</button>
          <button type="button" data-theme-choice="dark">Dark</button>
        </div>
        <button id="reload-button" class="ghost" type="button">Reload</button>
        <button id="poll-button" type="button">Poll Now</button>
      </nav>
    </header>

    <section id="auth-panel" class="auth-panel panel hidden" aria-labelledby="auth-heading">
      <div class="auth-copy">
        <span class="eyebrow">Codex Auth</span>
        <h2 id="auth-heading">Connect ChatGPT</h2>
        <p id="auth-message">Codex ChatGPT auth is required before investigations can run.</p>
      </div>
      <button id="login-button" type="button">Start Login</button>
      <pre id="login-output" class="login-output hidden"></pre>
    </section>

    <main class="workspace">
      <section class="issue-section panel" aria-labelledby="issues-heading">
        <div class="section-header">
          <div>
            <span class="eyebrow">Triage Queue</span>
            <h2 id="issues-heading">Issues</h2>
          </div>
          <span id="issue-count" class="badge">0</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Source</th>
                <th>Issue ID</th>
                <th>Date</th>
                <th>Reporter</th>
                <th>Media/title</th>
                <th>Status</th>
                <th>Description</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="issue-rows">
              <tr><td colspan="9" class="empty">No snapshot loaded.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <aside class="side-panel panel" aria-labelledby="activity-heading">
        <div class="section-header">
          <div>
            <span class="eyebrow">Operations</span>
            <h2 id="activity-heading">Activity</h2>
          </div>
          <span id="dry-run" class="badge warning">approval-gated</span>
        </div>
        <div class="stats-grid" id="stats-grid"></div>
        <div class="job-list" id="job-list"></div>
      </aside>
    </main>

    <section class="detail-band panel" aria-live="polite">
      <div class="section-header">
        <div>
          <span class="eyebrow">Decision Detail</span>
          <h2 id="detail-heading">Investigation</h2>
        </div>
        <div class="toolbar">
          <button id="reopen-button" type="button" class="secondary hidden">Re-open</button>
          <button id="continue-button" type="button" class="secondary hidden">Continue</button>
          <div id="approval-actions" class="toolbar hidden">
            <button id="approve-button" type="button">Approve</button>
            <button id="reject-button" type="button" class="danger">Reject</button>
          </div>
        </div>
      </div>
      <pre id="investigation-output">Select an issue to investigate.</pre>
      <div id="steer-panel" class="steer-panel hidden">
        <textarea id="steer-input" rows="3" placeholder="Steer the investigation"></textarea>
        <button id="steer-button" type="button" class="secondary">Send</button>
      </div>
    </section>
  </div>
  <div id="close-dialog" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="close-dialog-title">
    <div class="modal-panel">
      <div class="section-header">
        <div>
          <span class="eyebrow">Manual Closure</span>
          <h2 id="close-dialog-title">Close Issue</h2>
        </div>
      </div>
      <div class="modal-body">
        <label for="close-comment">Optional comment</label>
        <textarea id="close-comment" rows="4" placeholder="Add a note before closing"></textarea>
      </div>
      <div class="modal-actions">
        <button id="close-cancel-button" type="button" class="secondary">Cancel</button>
        <button id="close-confirm-button" type="button" class="danger">Close Issue</button>
      </div>
    </div>
  </div>
  <div id="toast" role="status" aria-live="polite"></div>
  <script src="/assets/app.js"></script>
</body>
</html>`;

const CSS = `:root {
  color-scheme: light;
  --bg: #f5f7f3;
  --bg-soft: #e8eee9;
  --panel: #ffffff;
  --panel-2: #f1f5f1;
  --line: #d6ded8;
  --line-soft: #e6ece7;
  --text: #15191b;
  --muted: #64706a;
  --subtle: #7c8780;
  --accent: #147d76;
  --accent-strong: #0f5e59;
  --accent-soft: #dff2ee;
  --success: #27784d;
  --success-soft: #e3f3e8;
  --danger: #ad3d39;
  --danger-soft: #fae7e4;
  --warning: #9b6812;
  --warning-soft: #fff0c7;
  --shadow: 0 16px 40px rgba(19, 33, 29, 0.10);
  --shadow-soft: 0 1px 2px rgba(19, 33, 29, 0.08);
  --focus: 0 0 0 3px rgba(20, 125, 118, 0.22);
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #101312;
  --bg-soft: #171b19;
  --panel: #1c211f;
  --panel-2: #242a27;
  --line: #343d38;
  --line-soft: #2c3430;
  --text: #f1f5f0;
  --muted: #a8b3ad;
  --subtle: #7d8a83;
  --accent: #45b8a8;
  --accent-strong: #79d6ca;
  --accent-soft: #133d39;
  --success: #77ca95;
  --success-soft: #163823;
  --danger: #e07b72;
  --danger-soft: #46201e;
  --warning: #dfb256;
  --warning-soft: #402e12;
  --shadow: 0 18px 50px rgba(0, 0, 0, 0.42);
  --shadow-soft: 0 1px 1px rgba(0, 0, 0, 0.28);
  --focus: 0 0 0 3px rgba(69, 184, 168, 0.28);
}

* { box-sizing: border-box; }

html {
  min-width: 320px;
  background: var(--bg);
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(circle at top left, color-mix(in srgb, var(--accent-soft) 72%, transparent), transparent 32rem),
    linear-gradient(145deg, var(--bg), var(--bg-soft));
  color: var(--text);
  font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

button {
  min-height: 36px;
  border: 1px solid var(--accent);
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  padding: 0 14px;
  font-weight: 720;
  cursor: pointer;
  box-shadow: var(--shadow-soft);
  transition: background 150ms ease, border-color 150ms ease, color 150ms ease, transform 120ms ease;
}

button:hover {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
  transform: translateY(-1px);
}

button:focus-visible { outline: none; box-shadow: var(--focus); }
button:disabled { cursor: wait; opacity: 0.58; transform: none; }
button.secondary,
button.ghost {
  background: color-mix(in srgb, var(--panel) 86%, transparent);
  color: var(--accent-strong);
  border-color: var(--line);
}
button.secondary:hover,
button.ghost:hover {
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
}
button.danger {
  border-color: var(--danger);
  background: var(--danger);
  color: #fff;
}
button.danger:hover { background: color-mix(in srgb, var(--danger) 84%, #000); }

.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
}

.topbar {
  min-height: 82px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 20px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(14px);
  position: sticky;
  top: 0;
  z-index: 10;
}

.brand-block {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.app-mark {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--warning) 58%, var(--accent)));
  color: #fff;
  font-size: 13px;
  font-weight: 850;
  letter-spacing: 0;
  box-shadow: var(--shadow-soft);
}

h1, h2, p { margin: 0; }
h1 { font-size: 21px; line-height: 1.1; font-weight: 780; letter-spacing: 0; }
h2 { font-size: 16px; line-height: 1.2; font-weight: 780; letter-spacing: 0; }
p { color: var(--muted); margin-top: 4px; }

.eyebrow {
  display: block;
  margin-bottom: 3px;
  color: var(--subtle);
  font-size: 11px;
  line-height: 1;
  font-weight: 760;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.theme-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-height: 36px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
}

.theme-toggle button {
  min-height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  padding: 0 10px;
  box-shadow: none;
  font-size: 12px;
}

.theme-toggle button:hover,
.theme-toggle button.active {
  background: var(--panel);
  color: var(--text);
  transform: none;
}

.auth-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  margin: 16px 16px 0;
  padding: 14px;
}

.auth-panel.connected {
  display: none;
}

.auth-copy {
  min-width: 0;
}

.login-output {
  grid-column: 1 / -1;
  width: 100%;
  min-height: 96px;
  max-height: 220px;
  border-top: 1px solid var(--line);
}

.workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 344px;
  gap: 16px;
  padding: 16px;
  min-height: 0;
}

.panel {
  background: color-mix(in srgb, var(--panel) 96%, transparent);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow);
  overflow: hidden;
}

.issue-section,
.side-panel {
  min-height: 430px;
}

.detail-band {
  margin: 0 16px 16px;
  min-height: 224px;
}

.section-header {
  min-height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, color-mix(in srgb, var(--panel-2) 82%, transparent), color-mix(in srgb, var(--panel) 92%, transparent));
}

.badge {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  min-height: 24px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--line));
  border-radius: 999px;
  padding: 0 9px;
  color: var(--accent-strong);
  background: var(--accent-soft);
  font-size: 12px;
  font-weight: 760;
}

.badge.muted { color: var(--muted); background: var(--panel-2); border-color: var(--line); }
.badge.success { color: var(--success); background: var(--success-soft); border-color: color-mix(in srgb, var(--success) 35%, var(--line)); }
.badge.warning { color: var(--warning); background: var(--warning-soft); border-color: color-mix(in srgb, var(--warning) 35%, var(--line)); }
.badge.danger { color: var(--danger); background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }

.source-pill,
.status-pill {
  display: inline-flex;
  align-items: center;
  min-height: 23px;
  border-radius: 999px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 720;
  white-space: nowrap;
}

.source-pill {
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--line);
}

.status-pill {
  color: var(--accent-strong);
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--line));
}

.status-pill.muted { color: var(--muted); background: var(--panel-2); border-color: var(--line); }
.status-pill.success { color: var(--success); background: var(--success-soft); border-color: color-mix(in srgb, var(--success) 35%, var(--line)); }
.status-pill.warning { color: var(--warning); background: var(--warning-soft); border-color: color-mix(in srgb, var(--warning) 35%, var(--line)); }

.table-wrap {
  overflow: auto;
  max-height: calc(100vh - 290px);
}

table {
  width: 100%;
  min-width: 1040px;
  border-collapse: separate;
  border-spacing: 0;
}

th, td {
  border-bottom: 1px solid var(--line-soft);
  padding: 10px 12px;
  text-align: left;
  vertical-align: top;
}

th {
  position: sticky;
  top: 0;
  background: var(--panel-2);
  color: var(--muted);
  font-size: 11px;
  font-weight: 780;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  z-index: 1;
}

tbody tr {
  background: var(--panel);
}

tbody tr:hover {
  background: color-mix(in srgb, var(--accent-soft) 30%, var(--panel));
}

tbody tr.issue-closed {
  background: color-mix(in srgb, var(--success-soft) 42%, var(--panel));
}

tbody tr.issue-closed:hover {
  background: color-mix(in srgb, var(--success-soft) 68%, var(--panel));
}

td {
  max-width: 280px;
  overflow-wrap: anywhere;
}

td:first-child,
th:first-child {
  width: 48px;
  color: var(--muted);
}

td:last-child,
th:last-child {
  width: 224px;
}

.issue-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.issue-actions button {
  min-height: 32px;
  padding: 0 10px;
}

.empty {
  color: var(--muted);
  text-align: center;
  padding: 34px 10px;
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--line);
}

.stat {
  min-height: 74px;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 10px;
  background: var(--panel-2);
}

.stat span {
  display: block;
  color: var(--muted);
  font-size: 11px;
  font-weight: 760;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.stat strong {
  display: block;
  margin-top: 4px;
  font-size: 24px;
  line-height: 1;
  letter-spacing: 0;
}

.job-list {
  display: grid;
  gap: 9px;
  padding: 12px;
  max-height: calc(100vh - 354px);
  overflow: auto;
}

button.job-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 12px;
  width: 100%;
  min-height: 0;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 11px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  text-align: left;
  box-shadow: none;
}

button.job-row:hover,
button.job-row.active {
  background: color-mix(in srgb, var(--accent-soft) 28%, var(--panel));
  border-color: color-mix(in srgb, var(--accent) 38%, var(--line));
  transform: none;
}

.job-main {
  min-width: 0;
}

.job-main strong,
.job-main span {
  display: block;
}

.job-main strong {
  font-size: 15px;
}

.job-main span {
  color: var(--muted);
  font-size: 12px;
  margin-top: 3px;
  overflow-wrap: anywhere;
}

.job-row .badge {
  justify-self: end;
  max-width: none;
  white-space: nowrap;
  text-align: right;
}

pre {
  margin: 0;
  padding: 16px;
  min-height: 164px;
  max-height: 360px;
  overflow: auto;
  white-space: pre-wrap;
  color: var(--text);
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--accent-soft) 34%, transparent), transparent 28rem),
    var(--panel);
  font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

.steer-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: end;
  padding: 12px;
  border-top: 1px solid var(--line);
  background: var(--panel);
}

.steer-panel textarea {
  width: 100%;
  min-height: 76px;
  border: 1px solid var(--line);
  border-radius: 8px;
  resize: vertical;
  padding: 10px;
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
}

.steer-panel textarea:focus-visible {
  outline: none;
  box-shadow: var(--focus);
}

.hidden { display: none; }

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(0, 0, 0, 0.54);
}

.modal-panel {
  width: min(520px, 100%);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
  box-shadow: var(--shadow);
}

.modal-body {
  display: grid;
  gap: 8px;
  padding: 14px;
}

.modal-body label {
  color: var(--muted);
  font-size: 12px;
  font-weight: 760;
}

.modal-body textarea {
  width: 100%;
  min-height: 116px;
  border: 1px solid var(--line);
  border-radius: 8px;
  resize: vertical;
  padding: 10px;
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--line);
}

.modal-backdrop.hidden {
  display: none;
}

#toast {
  position: fixed;
  right: 18px;
  bottom: 18px;
  max-width: min(460px, calc(100vw - 36px));
  min-height: 42px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel);
  box-shadow: var(--shadow);
  padding: 10px 13px;
  transform: translateY(80px);
  opacity: 0;
  transition: opacity 160ms ease, transform 160ms ease;
}

#toast.show {
  transform: translateY(0);
  opacity: 1;
}

@media (max-width: 980px) {
  .topbar {
    align-items: flex-start;
    display: grid;
    grid-template-columns: 1fr;
  }

  .workspace {
    display: block;
    padding: 12px;
  }

  .toolbar {
    margin-top: 0;
  }

  .side-panel {
    margin-top: 12px;
  }

  .detail-band {
    margin: 0 12px 12px;
  }

  .table-wrap,
  .job-list {
    max-height: none;
  }
}

@media (max-width: 560px) {
  .topbar {
    padding: 12px;
  }

  .brand-block {
    align-items: flex-start;
  }

  .app-mark {
    width: 34px;
    height: 34px;
    border-radius: 8px;
  }

  h1 { font-size: 18px; }

  .theme-toggle,
  .toolbar > button {
    width: 100%;
  }

  .theme-toggle button {
    flex: 1;
  }

  .auth-panel {
    grid-template-columns: 1fr;
    margin: 12px 12px 0;
  }

  .auth-panel > button {
    width: 100%;
  }

  .stats-grid {
    grid-template-columns: 1fr;
  }
}`;

const JS = `const state = {
  snapshotId: null,
  entries: [],
  jobs: [],
  activeJobId: null,
  activeEntryIndex: null,
  closeEntryIndex: null,
  busy: false,
  authOk: false,
  loginRunning: false,
  authTimer: null,
  jobPollTimer: null
};

const el = {
  authPanel: document.getElementById("auth-panel"),
  authHeading: document.getElementById("auth-heading"),
  authMessage: document.getElementById("auth-message"),
  loginButton: document.getElementById("login-button"),
  loginOutput: document.getElementById("login-output"),
  snapshotMeta: document.getElementById("snapshot-meta"),
  issueCount: document.getElementById("issue-count"),
  issueRows: document.getElementById("issue-rows"),
  pollButton: document.getElementById("poll-button"),
  reloadButton: document.getElementById("reload-button"),
  statsGrid: document.getElementById("stats-grid"),
  jobList: document.getElementById("job-list"),
  dryRun: document.getElementById("dry-run"),
  detailHeading: document.getElementById("detail-heading"),
  output: document.getElementById("investigation-output"),
  reopenButton: document.getElementById("reopen-button"),
  continueButton: document.getElementById("continue-button"),
  approvalActions: document.getElementById("approval-actions"),
  approveButton: document.getElementById("approve-button"),
  rejectButton: document.getElementById("reject-button"),
  steerPanel: document.getElementById("steer-panel"),
  steerInput: document.getElementById("steer-input"),
  steerButton: document.getElementById("steer-button"),
  closeDialog: document.getElementById("close-dialog"),
  closeComment: document.getElementById("close-comment"),
  closeCancelButton: document.getElementById("close-cancel-button"),
  closeConfirmButton: document.getElementById("close-confirm-button"),
  toast: document.getElementById("toast"),
  themeButtons: [...document.querySelectorAll("[data-theme-choice]")]
};

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.remove("show"), 2800);
}

function setBusy(value) {
  state.busy = value;
  for (const button of document.querySelectorAll("button:not([data-theme-choice])")) {
    if (value) {
      button.disabled = true;
    } else if (button === el.loginButton) {
      button.disabled = state.loginRunning || state.authOk;
    } else if (button.dataset.investigate) {
      button.disabled = !state.authOk;
    } else {
      button.disabled = false;
    }
  }
}

function applyTheme(theme) {
  const selected = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = selected;
  localStorage.setItem("media-issue-agent-theme", selected);
  for (const button of el.themeButtons) {
    const isActive = button.dataset.themeChoice === selected;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || "Request failed");
  }
  return body;
}

function badgeClass(stateName) {
  const normalized = String(stateName || "");
  if (!normalized) return "badge muted";
  if (normalized === "closed" || normalized === "approved_for_execution" || normalized === "dry_run_complete") return "badge success";
  if (normalized.startsWith("failed") || normalized === "blocked_needs_human") return "badge danger";
  if (normalized.includes("awaiting")) return "badge warning";
  return "badge muted";
}

function stateLabel(stateName) {
  const labels = {
    detected: "Detected",
    queued_for_investigation: "Queued",
    investigating: "Investigating",
    awaiting_action_approval: "Needs approval",
    approved_for_execution: "Approved",
    executing: "Executing",
    waiting_for_plex_verification: "Verifying",
    drafting_comment: "Drafting",
    awaiting_comment_approval: "Comment review",
    awaiting_resolution_approval: "Approve fix",
    posting_comment: "Posting",
    closing_issue: "Closing",
    closed: "Closed",
    dry_run_complete: "Dry-run done",
    blocked_needs_human: "Needs human",
    failed_retryable: "Retry needed",
    failed_terminal: "Failed"
  };
  return labels[stateName] || String(stateName || "").replaceAll("_", " ");
}

function statusBadgeClass(status) {
  const normalized = String(status || "").toLowerCase();
  if (!normalized) return "status-pill muted";
  if (normalized.includes("closed") || normalized.includes("resolved")) return "status-pill success";
  if (normalized.includes("open") || normalized.includes("pending")) return "status-pill warning";
  return "status-pill";
}

function renderStats(status) {
  const jobTotal = (status.jobs || []).reduce((sum, row) => sum + Number(row.count || 0), 0);
  const pending = (status.approvals || []).find(row => row.status === "pending")?.count || 0;
  const latest = status.snapshots?.latestId || "-";
  el.dryRun.textContent = "approval-gated";
  el.dryRun.className = "badge warning";
  el.statsGrid.innerHTML = [
    ["Snapshots", status.snapshots?.count || 0],
    ["Latest", latest],
    ["Jobs", jobTotal],
    ["Pending", pending]
  ].map(([label, value]) => \`<div class="stat"><span>\${label}</span><strong>\${value}</strong></div>\`).join("");
}

function renderJobs(jobs) {
  state.jobs = jobs;
  if (!jobs.length) {
    el.jobList.innerHTML = '<div class="empty">No jobs yet.</div>';
    return;
  }
  el.jobList.innerHTML = jobs.map(job => \`
    <button class="job-row \${Number(state.activeJobId) === Number(job.id) ? "active" : ""}" type="button" data-job-id="\${job.id}">
      <div class="job-main">
        <strong>Job \${escapeHtml(job.id)}</strong>
        <span>\${escapeHtml(job.source)} \${escapeHtml(job.issueId)}</span>
      </div>
      <span class="\${badgeClass(job.state)}">\${escapeHtml(stateLabel(job.state))}</span>
    </button>
  \`).join("");
}

function canReinvestigate(entry) {
  return Boolean(entry.investigationSummary)
    && ["awaiting_action_approval", "failed_retryable", "blocked_needs_human"].includes(entry.jobState);
}

function isClosedEntry(entry) {
  return entry?.isClosed === true
    || entry?.raw?.isClosed === true
    || entry?.lifecycle === "closed"
    || entry?.jobState === "closed"
    || String(entry?.status || "").toLowerCase().includes("closed")
    || String(entry?.status || "").toLowerCase().includes("resolved");
}

function canInvestigate(entry) {
  return !isClosedEntry(entry)
    && !entry.investigationSummary
    && (!entry.jobState || ["detected", "queued_for_investigation", "failed_retryable", "blocked_needs_human"].includes(entry.jobState));
}

function issueAction(entry) {
  if (isClosedEntry(entry)) {
    return { kind: "summary", label: "View summary" };
  }
  if (canReinvestigate(entry)) {
    return { kind: "investigate", label: "Re-investigate", force: true };
  }
  if (canInvestigate(entry)) {
    return { kind: "investigate", label: "Investigate", force: false };
  }
  if (entry.jobId) {
    return { kind: "open", label: "Open job" };
  }
  return { kind: "none", label: "Unavailable" };
}

function issueActionButton(entry) {
  const action = issueAction(entry);
  const closeButton = isClosedEntry(entry)
    ? ""
    : \`<button class="secondary" type="button" data-close-issue="\${entry.idx}">Close</button>\`;
  let primary;
  if (action.kind === "summary") {
    primary = \`<button class="secondary" type="button" data-issue-summary="\${entry.idx}">\${action.label}</button>\`;
  } else if (action.kind === "open") {
    primary = \`<button class="secondary" type="button" data-open-job="\${escapeHtml(entry.jobId)}">\${action.label}</button>\`;
  } else if (action.kind === "investigate") {
    primary = \`<button class="secondary" type="button" data-investigate="\${entry.idx}" data-force="\${action.force ? "true" : "false"}" \${state.authOk ? "" : "disabled"}>\${action.label}</button>\`;
  } else {
    primary = \`<button class="secondary" type="button" disabled>\${action.label}</button>\`;
  }
  return \`<div class="issue-actions">\${primary}\${closeButton}</div>\`;
}

function setSteerVisible(visible) {
  el.steerPanel.classList.toggle("hidden", !visible);
  el.steerButton.disabled = !visible || state.busy || !state.authOk;
}

function renderAuth(auth, login) {
  state.authOk = Boolean(auth?.ok);
  state.loginRunning = login?.status === "running";
  el.authPanel.classList.toggle("hidden", state.authOk && !state.loginRunning);
  el.authPanel.classList.toggle("connected", state.authOk && !state.loginRunning);
  el.authHeading.textContent = state.authOk ? "ChatGPT Connected" : "Connect ChatGPT";
  el.authMessage.textContent = auth?.message || "Codex ChatGPT auth is required before investigations can run.";
  el.loginButton.textContent = state.loginRunning ? "Login Running" : "Start Login";
  el.loginButton.disabled = state.busy || state.loginRunning || state.authOk;
  const output = login?.output || "";
  el.loginOutput.classList.toggle("hidden", !output);
  el.loginOutput.textContent = output;
}

function renderSnapshot(snapshot) {
  if (!snapshot) {
    state.snapshotId = null;
    state.entries = [];
    setSteerVisible(false);
    el.snapshotMeta.textContent = "No snapshot loaded";
    el.issueCount.textContent = "0";
    el.issueRows.innerHTML = '<tr><td colspan="9" class="empty">No snapshot loaded.</td></tr>';
    return;
  }
  state.snapshotId = snapshot.id;
  state.entries = snapshot.entries || [];
  el.snapshotMeta.textContent = \`Snapshot \${snapshot.id} · \${snapshot.generatedAt}\`;
  el.issueCount.textContent = String(snapshot.entries.length);
  if (!snapshot.entries.length) {
    el.issueRows.innerHTML = '<tr><td colspan="9" class="empty">No issues.</td></tr>';
    return;
  }
  el.issueRows.innerHTML = snapshot.entries.map(entry => \`
    <tr data-entry-index="\${entry.idx}" class="\${isClosedEntry(entry) ? "issue-closed" : ""}">
      <td>\${entry.idx}</td>
      <td><span class="source-pill">\${escapeHtml(entry.source)}</span></td>
      <td>\${escapeHtml(entry.issueId)}</td>
      <td>\${escapeHtml(entry.date)}</td>
      <td>\${escapeHtml(entry.reporter)}</td>
      <td>\${escapeHtml(entry.mediaTitle)}</td>
      <td><span class="\${statusBadgeClass(entry.status)}">\${escapeHtml(entry.status)}</span></td>
      <td>\${escapeHtml(entry.description)}</td>
      <td>\${issueActionButton(entry)}</td>
    </tr>
  \`).join("");
}

function showEntry(index) {
  const entry = state.entries.find(row => Number(row.idx) === Number(index));
  if (!entry) return;
  state.activeEntryIndex = Number(index);
  if (isClosedEntry(entry)) {
    showIssueSummary(index);
    return;
  }
  if (issueAction(entry).kind === "open") {
    showJob(entry.jobId);
    return;
  }
  state.activeJobId = entry.jobId || null;
  el.detailHeading.textContent = "Investigation";
  el.reopenButton.classList.add("hidden");
  el.continueButton.classList.add("hidden");
  setSteerVisible(Boolean(entry.jobId) && ["awaiting_action_approval", "failed_retryable", "blocked_needs_human"].includes(entry.jobState));
  if (entry.investigationSummary) {
    const status = entry.investigationStatus ? \`Status: \${stateLabel(entry.jobState || entry.investigationStatus)}\` : "Status: Investigation cached";
    const updated = entry.investigationUpdatedAt ? \`Updated: \${entry.investigationUpdatedAt}\` : "";
    el.output.textContent = [status, updated, "", entry.investigationSummary].filter(Boolean).join("\\n");
    el.approvalActions.classList.toggle("hidden", entry.jobState !== "awaiting_action_approval");
  } else {
    el.output.textContent = \`No cached investigation for \${entry.source} issue \${entry.issueId}. Select Investigate to run Codex.\`;
    el.approvalActions.classList.add("hidden");
    setSteerVisible(false);
  }
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function pendingApproval(detail) {
  return (detail.approvals || []).find(approval => approval.status === "pending") || null;
}

function formatJobDetail(detail) {
  const job = detail.job;
  const pending = pendingApproval(detail);
  const lines = [
    \`Job \${job.id} · \${stateLabel(job.state)}\`,
    \`\${job.source} issue \${job.issueId}\`,
    \`Updated: \${job.updatedAt}\`
  ];
  if (job.lastError) {
    lines.push(\`Last note: \${job.lastError}\`);
  }
  if (pending) {
    lines.push("", \`Pending \${pending.kind} approval #\${pending.id}\`);
    if (pending.payload?.plan) {
      lines.push("", "Approved plan waiting for your decision:", formatJson(pending.payload.plan));
    }
    if (pending.payload?.executionResult) {
      lines.push("", "Fix result:", formatJson(pending.payload.executionResult));
    }
    if (pending.payload?.message) {
      lines.push("", "Draft resolution comment:", pending.payload.message);
    }
  }
  if (detail.investigation?.summary) {
    lines.push("", "Investigation:", detail.investigation.summary);
  }
  if (detail.plannedActions?.length) {
    lines.push("", "Planned/executed actions:");
    for (const action of detail.plannedActions) {
      lines.push(formatJson({
        tool: action.toolName,
        risk: action.riskLevel,
        args: action.args,
        dryRunResult: action.dryRunResult,
        result: action.result
      }));
    }
  }
  if (detail.auditEvents?.length) {
    lines.push("", "Recent activity:");
    for (const event of detail.auditEvents.slice(0, 8)) {
      lines.push(\`- \${event.createdAt} \${event.eventType}\`);
    }
  }
  return lines.join("\\n");
}

function updateJobControls(detail) {
  const pending = pendingApproval(detail);
  const stateName = detail.job.state;
  const canApprove = Boolean(pending) && ["awaiting_action_approval", "awaiting_comment_approval", "awaiting_resolution_approval"].includes(stateName);
  el.approvalActions.classList.toggle("hidden", !canApprove);
  el.continueButton.classList.toggle("hidden", stateName !== "approved_for_execution");
  setSteerVisible(stateName === "awaiting_action_approval");
}

function shouldPollJob(detail) {
  return ["investigating", "approved_for_execution", "executing", "drafting_comment", "closing_issue"].includes(detail.job.state);
}

function clearJobPolling() {
  clearInterval(state.jobPollTimer);
  state.jobPollTimer = null;
}

function startJobPolling() {
  clearJobPolling();
  if (!state.activeJobId) return;
  state.jobPollTimer = setInterval(() => {
    if (!state.activeJobId) {
      clearJobPolling();
      return;
    }
    showJob(state.activeJobId, { quiet: true }).catch(() => {});
  }, 1600);
}

async function showJob(jobId, options = {}) {
  state.activeJobId = Number(jobId);
  state.activeEntryIndex = null;
  el.detailHeading.textContent = "Job Detail";
  if (!options.quiet) {
    el.output.textContent = "Loading job detail...";
  }
  el.approvalActions.classList.add("hidden");
  el.reopenButton.classList.add("hidden");
  el.continueButton.classList.add("hidden");
  try {
    const result = await api(\`/api/jobs/\${state.activeJobId}\`);
    el.output.textContent = formatJobDetail(result.detail);
    updateJobControls(result.detail);
    renderJobs(state.jobs);
    if (shouldPollJob(result.detail)) {
      if (!state.jobPollTimer) startJobPolling();
    } else {
      clearJobPolling();
    }
  } catch (error) {
    el.output.textContent = error.message;
    toast(error.message);
  }
}

async function refresh() {
  const [status, snapshot, jobs, auth] = await Promise.all([
    api("/api/status"),
    api("/api/snapshot/latest"),
    api("/api/jobs"),
    api("/api/auth")
  ]);
  renderStats(status.status);
  renderAuth(auth.auth, auth.login);
  renderSnapshot(snapshot.snapshot);
  renderJobs(jobs.jobs);
  scheduleAuthRefresh();
}

async function showIssueSummary(index) {
  state.activeEntryIndex = Number(index);
  const entry = state.entries.find(row => Number(row.idx) === Number(index));
  state.activeJobId = entry?.jobId || null;
  el.detailHeading.textContent = "Issue Summary";
  el.approvalActions.classList.add("hidden");
  el.continueButton.classList.add("hidden");
  setSteerVisible(false);
  el.reopenButton.classList.toggle("hidden", !entry || !isClosedEntry(entry));
  el.output.textContent = "Loading issue summary...";
  try {
    const result = await api(\`/api/issues/\${state.snapshotId}/\${index}/summary\`);
    el.output.textContent = result.summary;
    el.reopenButton.classList.toggle("hidden", !result.closed);
  } catch (error) {
    el.output.textContent = error.message;
    toast(error.message);
  }
}

function scheduleAuthRefresh() {
  clearTimeout(state.authTimer);
  if (state.loginRunning) {
    state.authTimer = setTimeout(() => refresh().catch(error => toast(error.message)), 2000);
  }
}

async function startLogin() {
  setBusy(true);
  try {
    const result = await api("/api/auth/login", { method: "POST", body: "{}" });
    renderAuth(result.auth, result.login);
    toast("Codex login started");
    scheduleAuthRefresh();
  } catch (error) {
    el.output.textContent = error.message;
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function poll() {
  setBusy(true);
  try {
    const result = await api("/api/poll", { method: "POST", body: "{}" });
    toast(\`Snapshot \${result.result.snapshotId} recorded\`);
    await refresh();
  } catch (error) {
    el.output.textContent = error.message;
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function openCloseDialog(index) {
  state.closeEntryIndex = Number(index);
  el.closeComment.value = "";
  el.closeDialog.classList.remove("hidden");
  el.closeComment.focus();
}

function closeCloseDialog() {
  state.closeEntryIndex = null;
  el.closeDialog.classList.add("hidden");
  el.closeComment.value = "";
}

async function closeIssueFromDialog() {
  if (!state.snapshotId || !state.closeEntryIndex) return;
  const index = state.closeEntryIndex;
  const comment = el.closeComment.value;
  setBusy(true);
  try {
    const result = await api(\`/api/issues/\${state.snapshotId}/\${index}/close\`, {
      method: "POST",
      body: JSON.stringify({ comment })
    });
    closeCloseDialog();
    toast("Issue closed");
    await refresh();
    el.output.textContent = formatJson(result.result);
    await showIssueSummary(index);
  } catch (error) {
    el.output.textContent = error.message;
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function reopenIssue() {
  if (!state.snapshotId || !state.activeEntryIndex) return;
  const index = state.activeEntryIndex;
  setBusy(true);
  try {
    const result = await api(\`/api/issues/\${state.snapshotId}/\${index}/reopen\`, {
      method: "POST",
      body: "{}"
    });
    toast("Issue re-opened");
    await refresh();
    el.output.textContent = formatJson(result.result);
    showEntry(index);
  } catch (error) {
    el.output.textContent = error.message;
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function investigate(index, force = false) {
  if (!state.snapshotId) return;
  setBusy(true);
  el.output.textContent = "Investigation running...";
  el.approvalActions.classList.add("hidden");
  try {
    const result = await api("/api/investigate", {
      method: "POST",
      body: JSON.stringify({ snapshotId: state.snapshotId, index, force })
    });
    state.activeJobId = result.result.jobId;
    el.output.textContent = result.result.summary;
    el.approvalActions.classList.toggle("hidden", !result.result.approvalId);
    toast(\`Job \${state.activeJobId} ready\`);
    await refresh();
    await showJob(state.activeJobId);
  } catch (error) {
    el.output.textContent = error.message;
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function approval(action) {
  if (!state.activeJobId) return;
  setBusy(true);
  const polling = setInterval(() => {
    if (state.activeJobId) {
      showJob(state.activeJobId, { quiet: true }).catch(() => {});
    }
  }, 1500);
  try {
    const result = await api(\`/api/jobs/\${state.activeJobId}/\${action}\`, { method: "POST", body: "{}" });
    toast(\`Job \${state.activeJobId} \${action}d\`);
    el.approvalActions.classList.add("hidden");
    el.output.textContent = result.result?.message || formatJson(result.result);
    await refresh();
    await showJob(state.activeJobId);
  } catch (error) {
    el.output.textContent = error.message;
    toast(error.message);
  } finally {
    clearInterval(polling);
    setBusy(false);
  }
}

async function continueJob() {
  if (!state.activeJobId) return;
  setBusy(true);
  const polling = setInterval(() => {
    if (state.activeJobId) {
      showJob(state.activeJobId, { quiet: true }).catch(() => {});
    }
  }, 1500);
  try {
    const result = await api(\`/api/jobs/\${state.activeJobId}/continue\`, { method: "POST", body: "{}" });
    toast(\`Job \${state.activeJobId} continued\`);
    el.output.textContent = result.result?.message || formatJson(result.result);
    await refresh();
    await showJob(state.activeJobId);
  } catch (error) {
    el.output.textContent = error.message;
    toast(error.message);
  } finally {
    clearInterval(polling);
    setBusy(false);
  }
}

async function steerInvestigation() {
  if (!state.activeJobId) return;
  const message = el.steerInput.value.trim();
  if (!message) return;
  setBusy(true);
  el.output.textContent = "Revising investigation...";
  el.approvalActions.classList.add("hidden");
  try {
    const result = await api(\`/api/jobs/\${state.activeJobId}/steer\`, {
      method: "POST",
      body: JSON.stringify({ message })
    });
    el.steerInput.value = "";
    el.output.textContent = result.result.summary;
    toast("Investigation revised");
    await refresh();
    await showJob(state.activeJobId);
  } catch (error) {
    el.output.textContent = error.message;
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

el.pollButton.addEventListener("click", poll);
el.reloadButton.addEventListener("click", () => refresh().catch(error => toast(error.message)));
el.loginButton.addEventListener("click", startLogin);
for (const button of el.themeButtons) {
  button.addEventListener("click", () => applyTheme(button.dataset.themeChoice));
}
el.issueRows.addEventListener("click", event => {
  const summaryButton = event.target.closest("[data-issue-summary]");
  if (summaryButton) {
    showIssueSummary(Number(summaryButton.dataset.issueSummary));
    return;
  }
  const closeButton = event.target.closest("[data-close-issue]");
  if (closeButton) {
    openCloseDialog(Number(closeButton.dataset.closeIssue));
    return;
  }
  const openButton = event.target.closest("[data-open-job]");
  if (openButton) {
    showJob(Number(openButton.dataset.openJob));
    return;
  }
  const button = event.target.closest("[data-investigate]");
  if (button) {
    investigate(Number(button.dataset.investigate), button.dataset.force === "true");
    return;
  }
  const row = event.target.closest("[data-entry-index]");
  if (row) {
    showEntry(Number(row.dataset.entryIndex));
  }
});
el.approveButton.addEventListener("click", () => approval("approve"));
el.rejectButton.addEventListener("click", () => approval("reject"));
el.reopenButton.addEventListener("click", reopenIssue);
el.continueButton.addEventListener("click", continueJob);
el.steerButton.addEventListener("click", steerInvestigation);
el.steerInput.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    steerInvestigation();
  }
});
el.closeCancelButton.addEventListener("click", closeCloseDialog);
el.closeConfirmButton.addEventListener("click", closeIssueFromDialog);
el.closeDialog.addEventListener("click", event => {
  if (event.target === el.closeDialog) {
    closeCloseDialog();
  }
});
el.jobList.addEventListener("click", event => {
  const row = event.target.closest("[data-job-id]");
  if (row) {
    showJob(Number(row.dataset.jobId));
  }
});

applyTheme(document.documentElement.dataset.theme || "dark");
refresh().catch(error => toast(error.message));`;

function safeJson(value) {
  return JSON.stringify(sanitizeValue(value));
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(req, config) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    return false;
  }
  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) {
    return false;
  }
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return timingSafeEqual(username, config.webUsername) && timingSafeEqual(password, config.webPassword);
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, safeJson(value), "application/json; charset=utf-8");
}

function sendPublicJson(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

async function readJson(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64 * 1024) {
      throw new Error("Request body is too large");
    }
  }
  return data ? JSON.parse(data) : {};
}

let loginSession = null;

function redactLoginText(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/\-=]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|(?:gho|ghp|github_pat)_[A-Za-z0-9_=-]{8,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9_]*API[_-]?KEY[A-Za-z0-9_]*\s*=\s*[^\s]+/gi, "API_KEY=[REDACTED]")
    .replace(/\b[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*=\s*[^\s]+/gi, "TOKEN=[REDACTED]")
    .replace(/(?:\/Users|\/home|\/mnt\/user|\/mnt\/unraid|\/config|\/codex-home|\/boot|\/var\/run)\/[^\s"'<>),]+/g, "[REDACTED_PATH]");
}

function appendLoginOutput(session, chunk) {
  session.output = `${session.output}${redactLoginText(chunk)}`.slice(-16000);
}

function publicLoginSession() {
  if (!loginSession) {
    return null;
  }
  return {
    id: loginSession.id,
    status: loginSession.status,
    startedAt: loginSession.startedAt,
    completedAt: loginSession.completedAt,
    exitCode: loginSession.exitCode,
    output: loginSession.output
  };
}

function publicAuthStatus(auth) {
  return {
    ok: auth.ok,
    status: auth.status,
    message: auth.message
  };
}

async function currentAuthStatus(config) {
  return publicAuthStatus(await inspectCodexAuth(config.codexHome));
}

async function startCodexLogin(config) {
  if (loginSession?.status === "running") {
    return publicLoginSession();
  }
  await mkdir(config.codexWorkspace, { recursive: true });
  await mkdir(config.codexHome, { recursive: true });
  const session = {
    id: crypto.randomUUID(),
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
    output: ""
  };
  loginSession = session;
  const env = {
    ...process.env,
    CODEX_HOME: config.codexHome,
    HOME: process.env.HOME || "/home/agent"
  };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  const child = spawn(config.codexBin, ["login", "--device-auth"], {
    cwd: config.codexWorkspace,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => appendLoginOutput(session, chunk));
  child.stderr.on("data", chunk => appendLoginOutput(session, chunk));
  child.on("error", error => {
    session.status = "failed";
    session.completedAt = new Date().toISOString();
    appendLoginOutput(session, `\n${error.message}\n`);
  });
  child.on("close", code => {
    session.status = code === 0 ? "completed" : "failed";
    session.exitCode = code;
    session.completedAt = new Date().toISOString();
  });
  return publicLoginSession();
}

export function createWebHandler(agent, config) {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!isAuthorized(req, config)) {
        res.writeHead(401, {
          "www-authenticate": 'Basic realm="media-issue-agent"',
          "cache-control": "no-store"
        });
        res.end("Unauthorized");
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        send(res, 200, HTML, "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/assets/app.css") {
        send(res, 200, CSS, "text/css; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/assets/app.js") {
        send(res, 200, JS, "text/javascript; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/auth") {
        sendPublicJson(res, 200, { ok: true, auth: await currentAuthStatus(config), login: publicLoginSession() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        await readJson(req);
        const login = await startCodexLogin(config);
        sendPublicJson(res, 200, { ok: true, auth: await currentAuthStatus(config), login });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        sendJson(res, 200, { ok: true, status: agent.status() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/snapshot/latest") {
        sendJson(res, 200, { ok: true, snapshot: agent.latestWithEntries() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/jobs") {
        sendJson(res, 200, { ok: true, jobs: agent.jobs(50), approvals: agent.approvals(50) });
        return;
      }
      const jobDetailMatch = url.pathname.match(/^\/api\/jobs\/(\d+)$/);
      if (req.method === "GET" && jobDetailMatch) {
        sendJson(res, 200, { ok: true, detail: agent.jobDetails(Number(jobDetailMatch[1])) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/poll") {
        await readJson(req);
        sendJson(res, 200, { ok: true, result: await agent.pollOnce() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/investigate") {
        const body = await readJson(req);
        sendJson(res, 200, { ok: true, result: await agent.investigate(Number(body.snapshotId), Number(body.index), {
          force: Boolean(body.force)
        }) });
        return;
      }
      const issueSummaryMatch = url.pathname.match(/^\/api\/issues\/(\d+)\/(\d+)\/summary$/);
      if (req.method === "GET" && issueSummaryMatch) {
        const [, snapshotId, index] = issueSummaryMatch;
        const result = await agent.issueSummary(Number(snapshotId), Number(index));
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      const issueCloseMatch = url.pathname.match(/^\/api\/issues\/(\d+)\/(\d+)\/close$/);
      if (req.method === "POST" && issueCloseMatch) {
        const body = await readJson(req);
        const [, snapshotId, index] = issueCloseMatch;
        sendJson(res, 200, { ok: true, result: await agent.closeIssue(Number(snapshotId), Number(index), body.comment || "", "web") });
        return;
      }
      const issueReopenMatch = url.pathname.match(/^\/api\/issues\/(\d+)\/(\d+)\/reopen$/);
      if (req.method === "POST" && issueReopenMatch) {
        await readJson(req);
        const [, snapshotId, index] = issueReopenMatch;
        sendJson(res, 200, { ok: true, result: await agent.reopenIssue(Number(snapshotId), Number(index), "web") });
        return;
      }
      const approvalMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/(approve|reject)$/);
      if (req.method === "POST" && approvalMatch) {
        await readJson(req);
        const [, jobId, action] = approvalMatch;
        const result = action === "approve" ? await agent.approve(Number(jobId), "web") : agent.reject(Number(jobId), "web");
        sendJson(res, 200, { ok: true, result });
        return;
      }
      const continueMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/continue$/);
      if (req.method === "POST" && continueMatch) {
        await readJson(req);
        const result = await agent.continueJob(Number(continueMatch[1]), "web");
        sendJson(res, 200, { ok: true, result });
        return;
      }
      const steerMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/steer$/);
      if (req.method === "POST" && steerMatch) {
        const body = await readJson(req);
        const result = await agent.steerInvestigation(Number(steerMatch[1]), body.message, "web");
        sendJson(res, 200, { ok: true, result });
        return;
      }
      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: redactText(error.message) });
    }
  };
}

export async function startWebServer(agent, config, log = console.error) {
  if (!config.webPassword) {
    throw new Error("ISSUE_AGENT_WEB_PASSWORD is required when the media issue agent Web UI is enabled.");
  }
  const server = http.createServer(createWebHandler(agent, config));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.webPort, config.webHost, resolve);
  });
  log(`media-issue-agent: Web UI listening on ${config.webHost}:${config.webPort}`);
  return server;
}
