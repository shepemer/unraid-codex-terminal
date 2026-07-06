# Unraid Codex Terminal Docs

This file holds the detailed reference material. The short install and connection path lives in [README.md](README.md).

## Version Mismatch And Codex Updates

If Codex Desktop reports a Codex version mismatch when connecting over SSH, manually restart the `codex-terminal` container from the Unraid Docker page or run:

```sh
docker restart codex-terminal
```

The terminal container updates Codex CLI during startup by default:

```text
npm install -g @openai/codex@latest
```

The update runs as root before SSH and WebUI sessions start, then verifies `codex --version` as the `codex` user. The interactive `codex` user does not need write access to global npm packages. If npm is unavailable or the update times out, the container logs a warning and continues with the bundled Codex version.

Advanced settings:

- `CODEX_UPDATE_ON_START=true` updates Codex on every container start.
- `CODEX_NPM_VERSION=latest` controls the npm version spec for `@openai/codex`.
- `CODEX_UPDATE_ON_START_TIMEOUT=180` controls the maximum update time in seconds.

Set `CODEX_UPDATE_ON_START=false` if you want deterministic image contents and only want Codex to change when the container image is updated.

## Architecture

- `codex-terminal`: OpenSSH server on container port `2222`, `ttyd` WebUI on container port `7681`, Codex CLI, common diagnostic tools, persistent `/config`, and `/workspace` backed by `/config/workspace`.
- `unraid-mcp`: pinned `unraid-mcp==1.2.4` HTTP MCP server on the internal `codex-mgmt` network.
- `media-mcp`: optional HTTP MCP server on the internal `codex-mgmt` network for Sonarr, Radarr, Plex, Tautulli, Tracearr, Bazarr, Prowlarr, qBittorrent, NZBGet, and Seerr-family media automation.
- `media-issue-agent`: optional human-in-the-loop worker on the internal `codex-mgmt` network for Plex-native reports and Seerr-family issue triage. It uses `media-mcp` for media API access and local Codex ChatGPT auth for investigation summaries and comment drafts.
- `utilities-mcp`: optional HTTP MCP server on the internal `codex-mgmt` network for Scrutiny storage health monitoring.
- `codex-mgmt`: user-defined Docker bridge network. SSH and the WebUI are published to the host; MCP is internal only.

## Unraid Install Details

1. Create the internal Docker network from the Unraid terminal:

   ```sh
   docker network create codex-mgmt
   ```

2. Copy the templates from `templates/` into:

   ```text
   /boot/config/plugins/dockerMan/templates-user/
   ```

3. Confirm the templates reference the published images:

   - `ghcr.io/shepemer/unraid-codex-terminal:latest`
   - `ghcr.io/shepemer/unraid-codex-terminal-unraid-mcp:latest`
   - `ghcr.io/shepemer/unraid-codex-terminal-media-mcp:latest`
   - `ghcr.io/shepemer/unraid-codex-terminal-media-issue-agent:latest`
   - `ghcr.io/shepemer/unraid-codex-terminal-utilities-mcp:latest`

4. Install `unraid-mcp` first. Set:

   - `UNRAID_API_URL`, usually `http://tower.local/graphql` or `https://tower.local/graphql`
   - `UNRAID_API_KEY`
   - `UNRAID_MCP_BEARER_TOKEN`

5. Install `codex-terminal`. Set the same `UNRAID_MCP_BEARER_TOKEN`, at least one public SSH key in `SSH_AUTHORIZED_KEYS`, and a strong `WEBUI_PASSWORD`. If you need SSH password login, set `SSH_PASSWORD_LOGIN=true` and a strong masked `SSH_PASSWORD`.

   Optional media/download path diagnostics belong on `codex-terminal` unless you intentionally need write access for archive extraction. If you want agents to compare media-service paths with host files, configure narrow mounts such as `/mnt/user/media` and `/mnt/user/downloads`, then set `CODEX_MEDIA_PATH_MAPS` to mappings such as `/downloads=/mnt/unraid/downloads,/media=/mnt/unraid/media`. Keep downloads read-only unless you are deliberately doing shell-side extraction.

6. Optional: install `media-mcp` on `codex-mgmt`. For guarded archive extraction, mount the downloads share read/write at `/mnt/unraid/downloads` and keep `MEDIA_MCP_PATH_MAPS=/downloads=/mnt/unraid/downloads` unless your download client reports a different container path. Set `MEDIA_MCP_BEARER_TOKEN` and at least one complete service credential set:

   - Sonarr: `SONARR_URL` and `SONARR_API_KEY`
   - Radarr: `RADARR_URL` and `RADARR_API_KEY`
   - Plex: `PLEX_URL` and `PLEX_TOKEN`
   - Bazarr: `BAZARR_URL` and `BAZARR_API_KEY`
   - Prowlarr: `PROWLARR_URL` and `PROWLARR_API_KEY`
   - qBittorrent: `QBITTORRENT_URL`, `QBITTORRENT_USERNAME`, and `QBITTORRENT_PASSWORD`
   - NZBGet: `NZBGET_URL`, `NZBGET_USERNAME`, and `NZBGET_PASSWORD`
   - Seerr, Overseerr, or Jellyseerr: `SEERR_URL` and `SEERR_API_KEY`
   - Tautulli: `TAUTULLI_URL` and `TAUTULLI_API_KEY`
   - Tracearr: `TRACEARR_URL` and `TRACEARR_API_KEY`

   Set the same `MEDIA_MCP_BEARER_TOKEN` in `codex-terminal` to add this optional sidecar to `/config/.codex/config.toml`.

7. Optional: install `media-issue-agent` on `codex-mgmt` after `media-mcp`.

   Set:

   - `ISSUE_AGENT_MEDIA_MCP_URL`, normally `http://media-mcp:6971/mcp`
   - `ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN`, matching the media MCP bearer token until scoped tokens are available
   - `CODEX_HOME`, normally `/codex-home` inside the container
   - `ISSUE_AGENT_WEB_PASSWORD`, a strong Web UI password
   - a persistent Codex home path mounted to `/codex-home`
   - a persistent state path mounted to `/state`

   The state and Codex home host directories must be writable by the container's `agent` user, which runs as uid/gid `1000`. For the default Unraid template paths:

   ```sh
   mkdir -p /mnt/user/appdata/media-issue-agent/state /mnt/user/appdata/media-issue-agent/codex
   chown -R 1000:1000 /mnt/user/appdata/media-issue-agent/state /mnt/user/appdata/media-issue-agent/codex
   ```

   The issue agent refuses `OPENAI_API_KEY` and `CODEX_API_KEY`. It is intended to use ChatGPT-managed Codex access, such as a Pro plan, through Codex local authentication. On first start, open the Web UI and use the Codex Auth panel to start a ChatGPT device-login flow. To prepare the mounted Codex home from a trusted shell instead, run:

   ```sh
   docker compose --profile issue-agent run --rm media-issue-agent codex login --device-auth
   ```

   You can also copy a trusted Codex `auth.json` into the mounted Codex home. Treat `auth.json` like a password: never commit it, paste it into chat, include it in issue reports, or expose it in logs.

   Open the Web UI at:

   ```text
   http://<unraid-ip>:6983/
   ```

   Use `ISSUE_AGENT_WEB_USERNAME` and `ISSUE_AGENT_WEB_PASSWORD` for browser Basic auth. The Web UI can complete Codex ChatGPT setup, poll, list current snapshots, start investigations, inspect jobs, and approve or reject pending work. Investigations are cached per job after they run; selecting an issue shows the cached result, while Re-investigate reruns Codex and replaces the stored investigation. Action approval advances the job to a drafted reporter comment for a second approval. Comment approval posts through `media-mcp` using the configured dry-run mode. The CLI remains available for the same workflow:

   ```sh
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js poll-once
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js list
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js investigate 1 1
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js investigate 1 1 --force
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js approve 1
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js continue 1
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js status
   ```

   Local state stores snapshots, job state, approvals, retries, and audit events only. Plex and Seerr remain the source of truth for issue status and comments.

8. Optional: install `utilities-mcp` on `codex-mgmt`. Set `UTILITIES_MCP_BEARER_TOKEN` and the Scrutiny endpoint:

   - Scrutiny: `SCRUTINY_URL`, plus optional `SCRUTINY_BASE_PATH` for reverse-proxy base paths

   Set the same `UTILITIES_MCP_BEARER_TOKEN` in `codex-terminal` to add this optional sidecar to `/config/.codex/config.toml`.

Do not add a port mapping for `unraid-mcp`, `media-mcp`, or `utilities-mcp`. The media issue agent publishes only its password-protected Web UI port; expose it only on LAN, VPN, or Tailscale.

`UNRAID_API_URL` must include `/graphql` and must match the scheme your Unraid WebUI/API actually serves. If `https://<unraid-ip>` refuses port `443` but `http://<unraid-ip>` works on port `80`, use `http://<unraid-ip>/graphql`.

## WebUI

Open the container WebUI at:

```text
http://<unraid-ip>:7681/
```

The WebUI is a `ttyd` browser terminal attached to a persistent `tmux` session named `codex` by default. It starts Codex automatically with `--dangerously-bypass-approvals-and-sandbox`, matching the Home Assistant add-on behavior; set `AUTO_LAUNCH_CODEX=false` or `CODEX_WEBUI_BYPASS_APPROVALS=false` if you want a plain shell or normal Codex approval prompts.

Because this is a shell, keep `WEBUI_AUTH=true`, use a strong `WEBUI_PASSWORD`, and expose the port only on LAN, VPN, or Tailscale. Home Assistant ingress provides an auth layer for the add-on version; this Unraid template uses `ttyd` basic auth instead.

`WEBUI_LOG_LEVEL` defaults to `1` so `ttyd` does not print the basic-auth credential in container startup logs. Increase it only temporarily while troubleshooting.

## Unraid API Key

Do not use an `ADMIN` key by default. Create a scoped operator key in Settings > Management Access > API Keys.

Recommended starting permissions:

- Read: `INFO`, `LOGS`, `DOCKER`, `ARRAY`, `DISK`, `SHARE`, `VMS`, `NOTIFICATIONS`
- Mutating: Docker start, stop, restart, and update if you want Codex to manage containers
- Optional: VM start and stop if you want Codex to manage VMs

Leave array mutations, flash, API key, config, network, OS, permission, and plugin mutation permissions disabled until you intentionally need them.

## SSH Config

Add an SSH host on your workstation:

```sshconfig
Host unraid-codex
  HostName <unraid-ip-or-tailnet-name>
  Port 2222
  User codex
  IdentityFile ~/.ssh/id_ed25519
```

Verify:

```sh
ssh unraid-codex codex --version
ssh unraid-codex codex mcp list --json
```

Codex Desktop Remote SSH should detect this host from your local SSH config. Open `/workspace` as the project path.

SSH password auth is disabled by default. If a client cannot use SSH keys, set `SSH_PASSWORD_LOGIN=true` and `SSH_PASSWORD`; keep SSH exposed only on LAN, VPN, or Tailscale. `SSH_PASSWORD_HASH` is still supported for advanced deployments, but leave it empty when `SSH_PASSWORD` is set.

SSH as `codex`, not `root`. Root login is intentionally disabled.

## Codex Auth And State

The container persists these paths under `/mnt/user/appdata/codex-terminal`:

- `/config/.codex` for Codex auth and configuration
- `/config/ssh` for SSH host keys and authorized keys
- `/config/workspace` for the default project workspace

On first start, the entrypoint creates `/config/.codex/config.toml` with:

```toml
[mcp_servers.unraid]
url = "http://unraid-mcp:6970/mcp"
bearer_token_env_var = "UNRAID_MCP_BEARER_TOKEN"
```

When `MEDIA_MCP_BEARER_TOKEN` is set on `codex-terminal`, startup also adds this block if it is not already present:

```toml
[mcp_servers.media]
url = "http://media-mcp:6971/mcp"
bearer_token_env_var = "MEDIA_MCP_BEARER_TOKEN"
```

When `UTILITIES_MCP_BEARER_TOKEN` is set on `codex-terminal`, startup also adds this block if it is not already present:

```toml
[mcp_servers.utilities]
url = "http://utilities-mcp:6972/mcp"
bearer_token_env_var = "UTILITIES_MCP_BEARER_TOKEN"
```

Sign in to Codex inside the SSH container if needed:

```sh
ssh -t unraid-codex codex login
```

## Optional Media MCP

`media-mcp` exposes a single `media` MCP server with a conservative first-party tool set:

- Shared: configured service status, compact media admin overview, diagnostics bundles, exact queue-item diagnosis, exact queue repair plans, issue diagnosis, and request triage.
- Sonarr: list, lookup, add series, queue, guarded queue removal, manual import candidates/import, queue-item file inspection, dry-run-first queue-item import, paginated wanted missing, wanted missing exact-ID collection, dry-run-first exact missing episode searches, cutoff unmet, recent history, blocklist, command status/cancel, command triggers for missing/cutoff/episode/series/season searches, rescan/refresh, dry-run-first rename/download scans, interactive release search/grab, recent logs, quality profiles, generic quality profile/custom format/quality definition management, and root folders.
- Radarr: list, lookup, add movies, queue, guarded queue removal, manual import candidates/import, queue-item file inspection, dry-run-first queue-item import, paginated wanted missing, wanted missing exact-ID collection, dry-run-first exact missing movie searches, cutoff unmet, recent history, blocklist, command status/cancel, command triggers for missing/cutoff/movie searches, rescan/refresh, dry-run-first rename/download scans, interactive release search/grab, recent logs, quality profiles, generic quality profile/custom format/quality definition management, and root folders.
- Plex: server status, libraries, library items, search, metadata, active sessions, and normalized Seerr/Plex-native user-reported issue views with Plex-native comment replies.
- Tautulli: current activity and playback history diagnostics.
- Tracearr: health, OpenAPI, stats, today stats, activity trends, active streams, users, violations, and playback history diagnostics.
- Bazarr: status, wanted movie subtitles, wanted episode subtitles, providers, subtitle history, and subtitle overview.
- Prowlarr: list indexers, search, and indexer health/history summary.
- qBittorrent: list torrents, pause or resume selected hashes, recheck/reannounce exact hashes, and delete selected hashes with explicit optional file deletion.
- NZBGet: status, queue, history/detail, exposed download files, archive diagnosis, dry-run-first post-processing retry, guarded history removal, optional local archive extraction with filesystem fallback, pause or resume downloads, and set rate limits.
- Seerr, Overseerr, or Jellyseerr: search media, list/request details, guarded request status updates, and list/comment/resolve/reopen/delete reported issues. Plex-native reports can be listed, diagnosed, and commented on through Plex's community GraphQL API; the current Plex Web API does not expose resolve/reopen/archive/delete state transitions for those native reports.

Container lifecycle management stays with `unraid-mcp` and the scoped Unraid API. The media sidecar does not mount the Docker socket, library media shares, or appdata directories; the optional downloads mount is only for guarded archive extraction. Tracearr support is read-only and does not expose stream termination.

Mutating media tools use exact IDs, exact hashes, or exact manual-import paths, and file-changing admin actions default to `dryRun=true`. Use `media_queue_repair_plan` before `media_apply_queue_repair_plan`; real execution accepts only exact plan actions or exact Seerr follow-up actions.

Sonarr/Radarr search, rescan, and refresh command tools queue the native Arr command immediately and return the queued command record. Global missing and cutoff searches can fan out into many indexer searches and may grab releases depending on each app's own settings. Prefer `sonarr_wanted_missing_ids` plus `sonarr_search_missing_exact`, or `radarr_wanted_missing_ids` plus `radarr_search_missing_exact`, when you need controlled missing-media searches: the exact tools page through wanted records, apply monitored/aired/available safeguards, default to `dryRun=true`, and queue only `EpisodeSearch` or `MoviesSearch` batches when explicitly executed. File-changing actions such as rename, downloaded scan, manual import, release grab, queue removal, download-client cleanup, and Servarr profile/custom format/quality definition updates are guarded with exact IDs/names/paths and dry-run-first behavior. Servarr config dry-runs return the current object, proposed object, compact diff, validation errors, and exact API method/path before any PUT or POST is attempted.

Queue-based manual import tools use the queue item's decoded `outputPath`, `downloadId`, and target `seriesId` or `movieId` when calling the Arr manual import API. If the API returns rows from library roots such as `/tv/...` or `/movies/...` instead of the queue/download folder, those rows are excluded from valid candidates and reported as blockers. Queue summaries expose decoded display paths and include raw values when upstream fields arrive HTML-escaped.

NZBGet post-processing retry tools are dry-run-first and never remove history or files. Use `download_client_archive_diagnosis` with a Sonarr/Radarr queue item to match the NZBGet history record by Arr `downloadId`/NZBGet `drone` parameter, inspect `UnpackStatus`, and report archive files exposed by NZBGet. Use `nzbget_retry_postprocess` with `dryRun=false` to call `editqueue("HistoryProcess", 0, [NZBID])` for one exact history item. Deleted history items require `force=true`. `nzbget_extract_archives` only operates inside the matched history item's `DestDir`, requires `dryRun=false`, and requires the media MCP container to see that path, write to it, and run `unrar` or `7z`/`7zz`. If NZBGet exposes no `listfiles` archive roots for a completed history item, the tool maps `DestDir` with `MEDIA_MCP_PATH_MAPS`, finds root archives directly on disk, skips volume-only files such as `.r00`, extracts the roots, and can queue the matching Sonarr/Radarr downloaded scan for the original download path and download ID.

Use `media_archive_environment_check` or the container command below to verify the archive environment. The command reports `unrar`, `7z` or `7zz`, and a safe temporary write probe under the downloads mount when it is present:

```sh
archive-tools-check --downloads-dir /mnt/unraid/downloads
```

## Optional Media Issue Agent

`media-issue-agent` is a separate worker for user-reported media issues. It periodically reconciles both Plex-native reports and Seerr-family issues through `media-mcp`, writes a GitHub-flavored Markdown table with stable numeric indexes, serves a password-protected Web UI, and stores only automation bookkeeping in SQLite.

Important behavior:

- Plex-native reports with any comment exactly `Closed.` are treated as resolved. Matching is case-insensitive and ignores leading or trailing whitespace.
- If a Plex list response does not include comments, or `commentCount` shows comments may exist, the agent fetches issue details before deciding whether the report is open.
- Local SQLite state never overrides Plex or Seerr truth. It stores snapshots, job state, locks, approval records, retries, timestamps, and redacted audit events.
- Investigation summaries and sanitized evidence are cached per job. Selecting an issue in the Web UI shows the cached investigation when one exists; Re-investigate or CLI `--force` reruns Codex and replaces the cached result.
- The agent uses Codex local through ChatGPT auth for investigation summaries and comment drafts. It refuses OpenAI API key auth, so `OPENAI_API_KEY` and `CODEX_API_KEY` must be unset.
- The Web UI requires Basic auth through `ISSUE_AGENT_WEB_USERNAME` and `ISSUE_AGENT_WEB_PASSWORD`.
- If Codex auth is missing, the Web UI starts in setup mode and can launch `codex login --device-auth` against the mounted `CODEX_HOME`.
- The Web UI defaults to dark mode and includes an optional light theme. The selected theme is stored in the browser only and does not change server-side agent behavior.
- Job rows in the Activity panel are clickable. The detail pane shows the current state, pending approval kind, draft comments, planned action dry-run/live results, and recent audit events.
- Action approval does not post comments directly. It generates a reporter-facing draft and moves the job to comment approval. Comment approval posts the exact draft through `media-mcp`; with dry-run enabled, the job finishes as `dry_run_complete` after recording the dry-run result.
- Mutating media actions are intended to stay behind explicit approvals and exact allowlists. Dry-run mode defaults to `true`.
- Plex-native final comments must be 300 characters or fewer and automated comments must end with `Automated response from Codex.`

The Web UI is the primary approval surface. The CLI remains available for the same operations:

```sh
media-issue-agent poll-once
media-issue-agent list
media-issue-agent investigate <snapshot-id> <index> [--force]
media-issue-agent approve <job-id>
media-issue-agent reject <job-id>
media-issue-agent continue <job-id>
media-issue-agent status
```

Do not mount media libraries, download shares, appdata, Docker sockets, or broad host paths into `media-issue-agent`. It should only need `/state`, `/codex-home`, the internal `media-mcp` URL, and the media MCP bearer token.

The `/state` and `/codex-home` bind mounts must be writable by uid/gid `1000`; otherwise SQLite cannot create `/state/media-issue-agent.sqlite` and Codex cannot refresh ChatGPT auth.

Example media MCP payloads:

```json
{
  "tool": "sonarr_wanted_missing",
  "arguments": {
    "page": 2,
    "pageSize": 100
  }
}
```

```json
{
  "tool": "sonarr_wanted_missing_ids",
  "arguments": {
    "monitoredOnly": true,
    "airedOnly": true,
    "includeSpecials": false
  }
}
```

```json
{
  "tool": "sonarr_search_missing_exact",
  "arguments": {
    "batchSize": 100,
    "dryRun": true
  }
}
```

```json
{
  "tool": "sonarr_search_episode",
  "arguments": {
    "episodeIds": [12345]
  }
}
```

```json
{
  "tool": "radarr_search_movie",
  "arguments": {
    "movieIds": [6789]
  }
}
```

```json
{
  "tool": "radarr_search_missing_exact",
  "arguments": {
    "batchSize": 100,
    "dryRun": true
  }
}
```

```json
{
  "tool": "radarr_command_status",
  "arguments": {
    "commandIds": [101, 102, 103]
  }
}
```

```json
{
  "tool": "sonarr_interactive_search_episode",
  "arguments": {
    "episodeId": 12345,
    "limit": 10
  }
}
```

```json
{
  "tool": "radarr_grab_release",
  "arguments": {
    "guid": "exact-guid-from-interactive-search",
    "indexerId": 4,
    "dryRun": true
  }
}
```

```json
{
  "tool": "sonarr_rename_files",
  "arguments": {
    "seriesId": 55,
    "files": [9876],
    "dryRun": true
  }
}
```

```json
{
  "tool": "sonarr_queue_item_files",
  "arguments": {
    "queueId": 1309106746,
    "limit": 50
  }
}
```

```json
{
  "tool": "sonarr_import_queue_item",
  "arguments": {
    "queueId": 1309106746,
    "importMode": "move",
    "dryRun": true
  }
}
```

```json
{
  "tool": "nzbget_retry_postprocess",
  "arguments": {
    "nzbId": 70001,
    "dryRun": true
  }
}
```

```json
{
  "tool": "download_client_archive_diagnosis",
  "arguments": {
    "service": "sonarr",
    "queueId": 1309106746
  }
}
```

## Codex-Terminal Path Diagnostics

The `media-path-check` command runs inside `codex-terminal`, not the MCP sidecars. It only performs `stat` and readability checks:

```sh
media-path-check --json /downloads/example.mkv /media/library-item
```

When `CODEX_MEDIA_PATH_MAPS=/downloads=/mnt/unraid/downloads,/media=/mnt/unraid/media`, the command reports both the original service path and the mapped mount alternative. Keep mounts narrow. Do not mount `/mnt/user`, `/`, `/boot`, appdata, or the Docker socket for this workflow.

## Optional Utilities MCP

`utilities-mcp` exposes a separate `utilities` MCP server for operational services that do not belong in media automation:

- Shared: configured service status.
- Scrutiny: API health, device summary, temperature history, and device details.

## Local Development

Create `.env` from `.env.example`, fill in the required values, then run:

```sh
docker compose config
docker compose build
docker compose up -d
```

For local SSH testing, set `SSH_AUTHORIZED_KEYS` to your public key. To test SSH password login, set `SSH_PASSWORD_LOGIN=true` and `SSH_PASSWORD`. For local WebUI testing, set `WEBUI_PASSWORD` before starting the container.

The Unraid MCP sidecar entrypoint refuses to start unless `UNRAID_API_URL`, `UNRAID_API_KEY`, and `UNRAID_MCP_BEARER_TOKEN` are set. The media MCP sidecar refuses to start unless `MEDIA_MCP_BEARER_TOKEN` and at least one supported media service credential set are configured. The media issue agent refuses to start if OpenAI API key auth is present, if `CODEX_HOME/auth.json` is missing, or if `ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN` is unset. The utilities MCP sidecar refuses to start unless `UTILITIES_MCP_BEARER_TOKEN` and at least one supported utility endpoint are configured.

To include the optional media sidecar in local compose runs:

```sh
docker compose --profile media config
docker compose --profile media build media-mcp
```

To include the optional media issue agent in local compose runs:

```sh
docker compose --profile issue-agent config
docker compose --profile issue-agent build media-issue-agent
```

To include the optional utilities sidecar in local compose runs:

```sh
docker compose --profile utilities config
docker compose --profile utilities build utilities-mcp
```

## Release Channels

The Docker workflow separates validation from release promotion:

- Pull requests build and scan all images, but do not push tags.
- Merges to `main` build, scan, and push `:main` plus an immutable full commit SHA tag.
- Pushing a Git tag named `v*`, such as `v0.2.0`, builds, scans, and pushes that version tag plus the full commit SHA tag.
- Manual workflow runs promote a chosen Git ref to either `:beta` or `:latest`.

Use these image channels:

- `:beta` for preview installs you control.
- `:latest` for the stable public install path.
- `:main` for the newest merged code after CI passes.
- `:<sha>` for an exact immutable build.
- `:v*` for named release tags.

To promote a ref in GitHub:

1. Open Actions > Docker > Run workflow.
2. Enter the ref to publish, such as `main`, a full commit SHA, or `v0.2.0`.
3. Choose `beta` or `latest`.
4. Run the workflow and wait for the build, scan, and push steps to pass.

Example release flow:

```text
Merge PR to main
Run Docker workflow with ref=main, channel=beta
Test :beta on your Unraid install
Run Docker workflow with the same commit SHA, channel=latest
Optionally create and push v0.2.0 for an immutable named release
```

## Validation

Static checks:

```sh
bash -n entrypoint.sh
bash -n media-path-check
bash -n web-terminal.sh
bash -n codex-terminal-shell
bash -n archive-tools-check
sh -n codex-terminal-profile.sh
npm --prefix media-mcp run check
npm --prefix media-mcp run test:arr-commands
npm --prefix media-issue-agent run check
npm --prefix media-issue-agent test
npm --prefix utilities-mcp run check
python3 -c 'import xml.etree.ElementTree as ET; [ET.parse(p) for p in ("templates/codex-terminal.xml", "templates/unraid-mcp.xml", "templates/media-mcp.xml", "templates/media-issue-agent.xml", "templates/utilities-mcp.xml")]'
docker compose config
docker compose --profile media config
docker compose --profile issue-agent config
docker compose --profile utilities config
docker compose --profile media --profile utilities config
tmpdir="$(mktemp -d)" && mkdir -p "$tmpdir/downloads" && touch "$tmpdir/downloads/sample.mkv" && CODEX_MEDIA_PATH_MAPS="/downloads=$tmpdir/downloads" ./media-path-check --json /downloads/sample.mkv >/dev/null
```

CI builds all images locally and scans them with Trivy for fixed high and critical OS/library vulnerabilities on pull requests. Pushes to `main`, tags, and manual runs publish to GHCR only after scans pass.

Container checks:

```sh
mkdir -p /tmp/codex-terminal-smoke
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --tmpfs /run:rw,nosuid,size=64m --tmpfs /var/run:rw,nosuid,size=32m -v /tmp/codex-terminal-smoke:/config:rw ghcr.io/shepemer/unraid-codex-terminal:latest /usr/sbin/sshd -t -f /run/codex-terminal/sshd_config
ssh unraid-codex codex --version
ssh unraid-codex test ! -S /var/run/docker.sock
ssh unraid-codex test ! -w /mnt/user
curl -fsS -u codex:<webui-password> http://<unraid-ip>:7681/
```

Unraid acceptance:

- Codex Desktop can connect to `unraid-codex` and open `/workspace`.
- If Codex Desktop reports a version mismatch, restart `codex-terminal` and reconnect.
- MCP can list Unraid system status and Docker containers.
- Optional media MCP can list configured media service status.
- Optional utilities MCP can list configured utility service status.
- Destructive MCP actions require explicit confirmation.
- Recreating containers preserves Codex config, SSH host keys, authorized keys, and workspace files.

## Security Notes

- Never expose SSH directly to the public internet. Use LAN, VPN, or Tailscale.
- Prefer SSH keys. If SSH password login is enabled, use a strong unique password.
- Never expose the WebUI directly to the public internet. It is an authenticated browser shell, not a hardened public web app.
- Keep `WEBUI_AUTH=true` unless another authenticated proxy is in front of the WebUI.
- Never mount `/var/run/docker.sock`.
- Never mount `/`, `/boot`, broad `/mnt`, or all of `/mnt/user/appdata`.
- Use only narrow read-only diagnostic mounts.
- Keep the Unraid API key only in the MCP sidecar.
- Keep Sonarr, Radarr, Plex, Tautulli, Tracearr, Bazarr, Prowlarr, qBittorrent, NZBGet, and Seerr-family credentials only in the optional media MCP sidecar.
- Keep Scrutiny endpoints only in the optional utilities MCP sidecar.
- MCP sidecars require bearer-token auth; do not add host port mappings for MCP.
- The terminal container root filesystem is writable so it can apply an SSH password at startup. It still runs without privileged mode, host networking, host devices, host PID/IPC, broad mounts, or Docker socket access.
- Codex CLI startup updates download from npm as root before user sessions start. Disable `CODEX_UPDATE_ON_START` if you prefer only image-published Codex versions.
- The MCP sidecar keeps a read-only root filesystem. It starts as root only to fix ownership on its mounted appdata directories, then runs the server as the unprivileged `mcp` user.
- The media MCP sidecar runs as the unprivileged `mcp` user with a read-only root filesystem and no host mounts.

## MCP Fallback

The default sidecar image builds from pinned `unraid-mcp==1.2.4` from the `jmagar/unraid-mcp` package lineage. If you need a prebuilt fallback image instead, `ghcr.io/mlamoure/unraid-mcp:latest` is documented by that fork, but it should be evaluated separately before use.
