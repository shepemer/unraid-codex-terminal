# Unraid Addons

A five-component suite of Unraid Docker templates for Codex access, isolated Unraid management, media automation, human-approved issue repair, and utility monitoring.

Codex connects to the `codex-terminal` container, not to the Unraid host shell. Unraid control goes through `unraid-mcp` and the Unraid GraphQL API, not the Docker socket or broad host mounts.

## AI-Generated Code Disclaimer

The code and documentation in this repository were generated with AI assistance. Review the implementation, templates, and security settings before using them on a real Unraid system.

## Version Mismatch? Restart The Container

If Codex Desktop reports a Codex version mismatch when connecting over SSH, manually restart the `codex-terminal` container from Unraid. The container updates `@openai/codex` on startup by default, so a restart is the expected fix.

For full configuration, validation, local development, and security notes, see [docs.md](docs.md).

## Upgrading From unraid-codex-terminal

The project and its five GHCR images have moved to the `unraid-addons` namespace. The legacy images are frozen, and replacing an XML file does not change an installed container's Repository or remove obsolete DockerMan fields. Existing installations must update each Repository explicitly, boot the new issue-agent image once with its legacy mounts, and then recreate the containers from the reduced templates. Host appdata stays in place. See [Upgrade From unraid-codex-terminal](docs.md#upgrade-from-unraid-codex-terminal) for the ordered migration.

## What Runs

- `codex-terminal`: SSH on container port `2222`, WebUI on `7681`, Codex CLI, persistent `/config`, and `/workspace`.
- `unraid-mcp`: internal HTTP MCP sidecar for Unraid API access.
- `media-mcp`: optional internal HTTP MCP sidecar for Sonarr, Radarr, Plex, Tautulli, Tracearr, Bazarr, Prowlarr, qBittorrent, NZBGet, Threadfin, and Seerr-family media automation.
- `media-issue-agent`: optional internal worker for human-approved triage and repair of Plex-native reports and Seerr-family issues, using `media-mcp` and Codex ChatGPT auth.
- `utilities-mcp`: optional internal HTTP MCP sidecar for Scrutiny storage health monitoring.
- `codex-mgmt`: private Docker bridge network shared by the containers.

## Install On Unraid

The five templates expose 66 fields total; 22 routine fields are visible without Advanced View. Host ports, mounts, and startup credentials stay in Unraid, while non-secret issue-agent runner and operations preferences live in its authenticated Web UI.

1. Create the internal Docker network:

   ```sh
   docker network create codex-mgmt
   ```

2. Copy the XML templates from `templates/` into:

   ```text
   /boot/config/plugins/dockerMan/templates-user/
   ```

3. Install `unraid-mcp` first.

   Required settings:

   - `UNRAID_API_URL`, usually `http://tower.local/graphql` or `https://tower.local/graphql`
   - `UNRAID_API_KEY`
   - `UNRAID_MCP_BEARER_TOKEN`

4. Install `codex-terminal`.

   Required settings:

   - same `UNRAID_MCP_BEARER_TOKEN` used by `unraid-mcp`
   - at least one public key in `SSH_AUTHORIZED_KEYS`, or intentionally enabled password login with exactly one of `SSH_PASSWORD` and `SSH_PASSWORD_HASH`
   - strong `WEBUI_PASSWORD`

   Optional: add narrow media/download diagnostics mounts on `codex-terminal` and set `CODEX_MEDIA_PATH_MAPS` so agents can use `media-path-check --json` for path troubleshooting. The media mount is read-only. The downloads mount is read/write only for intentional shell-side archive checks or extraction; leave it empty otherwise.

5. Optional: install `media-mcp` on the same network.

   Required settings:

   - `MEDIA_MCP_BEARER_TOKEN`
   - at least one complete media app credential pair, such as `SONARR_URL` and `SONARR_API_KEY`, or `THREADFIN_URL` with optional Threadfin credentials

   Set the same `MEDIA_MCP_BEARER_TOKEN` in `codex-terminal` to add the optional `media` MCP server to Codex config.

   The media MCP includes guarded Sonarr/Radarr queue, manual import, queue-item import, NZBGet post-processing diagnostics, archive extraction with filesystem fallback, command trigger, interactive search, release-grab tools, scoped media-file deletion, Plex metadata cleanup/scan tools, Radarr movie-file deletion, and Threadfin read/write configuration tools. Search/rescan/refresh commands queue immediately; file-changing actions stay exact-ID/path and dry-run-first. Threadfin tools can parse configured M3U/XMLTV sources, create group filters, update mappings, and verify public output endpoints through Threadfin's own API/websocket control surfaces, not appdata mounts. Threadfin writes require `confirm=true` when `dryRun=false`. For archive extraction, mount the downloads share read/write at `/mnt/unraid/downloads` and optionally set **Download Path** to the absolute download root reported by the apps, such as `/downloads`. For raw media-file operations, mount a narrow library root at `/mnt/unraid/media`, optionally set **Media Path** to its service-reported root, such as `/media`, and explicitly allow deletion with `MEDIA_MCP_MEDIA_ROOTS=/mnt/unraid/media`. The two service-path fields are optional Advanced settings and do not create host mounts.

   Optional media and downloads mounts deliberately have no host-path defaults. Select only an existing Unraid share and preserve its exact capitalization; `/mnt/user/Media` and `/mnt/user/media` can become separate shares. Compose users can opt in with `docker-compose.media-paths.yml.example`, which refuses to create missing host directories.

6. Optional: install `utilities-mcp` on the same network.

   Required settings:

   - `UTILITIES_MCP_BEARER_TOKEN`
   - full `SCRUTINY_URL`, including any reverse-proxy path such as `https://host.example/scrutiny`

   Set the same `UTILITIES_MCP_BEARER_TOKEN` in `codex-terminal` to add the optional `utilities` MCP server to Codex config.

7. Optional: install `media-issue-agent` on the same network after `media-mcp`.

   Required settings:

   - `ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN`, matching `media-mcp`
   - a persistent appdata parent mounted at `/config`; its `state/` and `codex/` subdirectories hold agent history and Codex ChatGPT auth
   - strong `ISSUE_AGENT_WEB_PASSWORD`

   The issue agent refuses generic Codex API-key auth through `OPENAI_API_KEY` and `CODEX_API_KEY`; use the Web UI Codex Auth panel or run Codex login with ChatGPT auth instead. Configure the Codex runner plus poll interval, snapshot retention, and comma-separated trusted server-owner reporters in the authenticated Web UI. Keep Pushover and Slack credentials in the masked Advanced Unraid fields. Approved server-side fixes run as autonomous Codex repair prompts with direct `media-mcp` access, live tool discovery, optional non-secret repair context, and per-job scratch workspaces, then return to the Web UI for final resolution-comment approval. The Improvement Backlog tracks missing MCP capabilities and reusable investigation-prompt lessons learned from operator steering; resolved issues can also be analyzed retroactively from the issue list. An optional Socket Mode Slack bot can receive media reports and flexible single or multi-title requests, hold basic conversations, and answer privacy-safe read-only questions about library counts, title status/storage, aggregate watch time and play counts, bandwidth, queues, subtitles, recent additions, and service health; user-specific viewing history is excluded. Slack requires a restricted `ISSUE_AGENT_OPENAI_MODERATION_API_KEY` used only with the free Moderation endpoint. See `docs.md` and `media-issue-agent/slack-app-manifest.yml`. Never mount media or download folders into `media-issue-agent`; those mounts belong only to `media-mcp`.

Do not publish host ports for `unraid-mcp`, `media-mcp`, or `utilities-mcp`. Only SSH, the Codex terminal WebUI, and the password-protected media issue agent WebUI should be reachable from your LAN, VPN, or Tailscale.

The templates use the stable `:latest` image channel. Change the repository tag to `:beta` if you want to follow preview builds.

## Connect

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

## WebUI

Open:

```text
http://<unraid-ip>:7681/
```

The WebUI attaches to a persistent `tmux` session and starts Codex automatically by default.

## Essential Safety

- Expose SSH and the WebUI only on LAN, VPN, or Tailscale.
- Use SSH keys when possible.
- Use a strong `WEBUI_PASSWORD`; WebUI authentication is always enabled in the supported deployment.
- Never mount `/var/run/docker.sock`, `/`, `/boot`, broad `/mnt`, or all of `/mnt/user/appdata`.
- Keep optional media/download mounts narrow. Use read/write downloads mounts only when you intentionally enable archive extraction.
- Use a scoped Unraid API key, not an unrestricted admin key.
- Keep media app API keys and Threadfin credentials only on `media-mcp`, and enable only the services you want Codex to manage.
- Keep Scrutiny endpoints only on `utilities-mcp`, and do not expose MCP sidecar ports to the host.
