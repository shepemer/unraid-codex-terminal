# Security Checklist

Use this before deploying or publishing the templates.

## Required

- [ ] `codex-terminal` SSH is exposed only on LAN, VPN, or Tailscale.
- [ ] `codex-terminal` WebUI is exposed only on LAN, VPN, or Tailscale.
- [ ] `WEBUI_PASSWORD` is strong; the supported deployment keeps WebUI authentication enabled and the internal `ttyd` log level fixed at its safe value.
- [ ] `unraid-mcp` has no host port mapping.
- [ ] Optional `media-mcp` has no host port mapping.
- [ ] Optional `media-issue-agent` WebUI is exposed only on LAN, VPN, or Tailscale.
- [ ] Optional `media-issue-agent` has a strong `ISSUE_AGENT_WEB_PASSWORD`.
- [ ] Optional `utilities-mcp` has no host port mapping.
- [ ] All deployed containers are on `codex-mgmt`.
- [ ] `UNRAID_API_KEY` is configured only on `unraid-mcp`.
- [ ] `UNRAID_MCP_BEARER_TOKEN` is long, random, and matches `unraid-mcp` and `codex-terminal`.
- [ ] Media app API keys and passwords are configured only on `media-mcp`.
- [ ] `MEDIA_MCP_BEARER_TOKEN` is long, random, and matches `media-mcp` and `codex-terminal` when media MCP is enabled.
- [ ] `media-issue-agent` has `ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN` configured and no media app credentials of its own.
- [ ] `media-issue-agent` has no `OPENAI_API_KEY` or `CODEX_API_KEY`; it uses Codex ChatGPT auth under `/config/codex`.
- [ ] `media-issue-agent` `/config/codex/auth.json` and `/config/state` are treated as sensitive and are never committed, pasted, or logged.
- [ ] Pushover, Slack, moderation, API-key, password, and bearer-token template fields are masked and have empty defaults.
- [ ] Integration secrets remain in Unraid environment fields; they are not saved in the issue agent's plaintext SQLite settings table.
- [ ] Scrutiny endpoints are configured only on `utilities-mcp`.
- [ ] `UTILITIES_MCP_BEARER_TOKEN` is long, random, and matches `utilities-mcp` and `codex-terminal` when utilities MCP is enabled.
- [ ] Root SSH login is disabled.
- [ ] Password SSH login is disabled unless there is a specific need.
- [ ] If password SSH login is enabled, `SSH_PASSWORD` is strong and unique.
- [ ] No container uses `privileged: true`.
- [ ] No container uses host networking, host PID, host IPC, or host devices.
- [ ] No container mounts `/var/run/docker.sock`.
- [ ] No container mounts `/`, `/boot`, broad `/mnt`, or all appdata.
- [ ] The optional terminal media diagnostic mount is narrow and read-only.
- [ ] The optional terminal downloads diagnostic mount is present only when intentional shell-side archive work requires read/write access.
- [ ] Optional automation mounts on `media-mcp` are narrow; media roots are explicitly allowlisted before deletion and downloads are read/write only when archive extraction is intended.
- [ ] `CODEX_MEDIA_PATH_MAPS` maps only service paths to the two narrow terminal diagnostic mounts.
- [ ] MCP sidecars require bearer-token auth.

## API Key Scope

- [ ] The Unraid API key is not `ADMIN` by default.
- [ ] `UNRAID_API_URL` includes `/graphql` and uses the same `http` or `https` scheme as the Unraid WebUI/API.
- [ ] Read permissions cover only the needed resources.
- [ ] Docker mutations are enabled only if Codex should manage containers.
- [ ] VM mutations are enabled only if Codex should manage VMs.
- [ ] Array mutations, flash, API key, config, network, OS, permission, and plugin mutations remain disabled unless intentionally enabled.

## Media App Scope

- [ ] Only the media services Codex should manage are configured on `media-mcp`.
- [ ] Tracearr tools are read-only diagnostics only; stream termination is not exposed.
- [ ] qBittorrent delete-with-files is treated as destructive and requires explicit confirmation.
- [ ] Seerr request approval, decline, and delete actions require explicit confirmation.
- [ ] Sonarr/Radarr add actions use known root folders and quality profiles.
- [ ] `MEDIA_MCP_PATH_MAPS` contains only additional nonstandard mappings; the standard `/downloads=/mnt/unraid/downloads` mapping remains built in.

## Utility App Scope

- [ ] Only the utility services Codex should inspect are configured on `utilities-mcp`.
- [ ] Scrutiny tools are read-only health, summary, temperature, and detail calls.
- [ ] Any Scrutiny reverse-proxy path is part of `SCRUTINY_URL`; no separate base-path variable is used.

## Validation

- [ ] `bash -n entrypoint.sh` passes.
- [ ] `bash -n media-path-check` passes.
- [ ] `bash -n web-terminal.sh` passes.
- [ ] `npm --prefix media-mcp run check` passes.
- [ ] `npm --prefix media-issue-agent run check` passes.
- [ ] `npm --prefix media-issue-agent test` passes.
- [ ] `npm --prefix utilities-mcp run check` passes.
- [ ] All XML templates parse.
- [ ] `docker compose config` passes.
- [ ] `docker compose --profile media config` passes.
- [ ] `docker compose --profile issue-agent config` passes.
- [ ] `docker compose --profile utilities config` passes.
- [ ] `docker compose --profile issue-agent --profile utilities config` passes.
- [ ] `docker compose --profile media --profile utilities config` passes.
- [ ] CI vulnerability scans pass before images are pushed.
- [ ] `sshd -t` passes inside the built `codex-terminal` image.
- [ ] The fixed Codex CLI startup update succeeds, or logs a warning and continues with the bundled version after the 180-second limit.
- [ ] `unraid-mcp` starts with root-owned appdata directories and rewrites them to UID/GID 1000.
- [ ] `media-mcp` starts with a read-only root filesystem and no host mounts unless narrow automation paths were explicitly enabled.
- [ ] `media-issue-agent` starts with a read-only root filesystem, one `/config` appdata mount, and only its WebUI port published.
- [ ] `utilities-mcp` starts with a read-only root filesystem and no host mounts.
- [ ] `media-path-check --json` reports mapped alternatives without creating, deleting, or editing files.
- [ ] `ssh unraid-codex codex --version` works.
- [ ] `ssh unraid-codex codex mcp list --json` shows the `unraid` MCP server.
- [ ] If media MCP is enabled, `ssh unraid-codex codex mcp list --json` shows the `media` MCP server.
- [ ] If utilities MCP is enabled, `ssh unraid-codex codex mcp list --json` shows the `utilities` MCP server.
- [ ] WebUI login works and attaches to the persistent `tmux` session.
- [ ] WebUI without credentials fails.
- [ ] Root SSH login fails.
- [ ] Password SSH login fails by default.
- [ ] Interactive SSH with a TTY stays connected.
- [ ] Password SSH login works only after `SSH_PASSWORD_LOGIN=true` and `SSH_PASSWORD` are set.
- [ ] The `codex` shell user cannot modify global npm packages directly.
- [ ] The container cannot access `/var/run/docker.sock`.
- [ ] Recreating `codex-terminal` preserves `/config/.codex`, SSH host keys, authorized keys, and workspace files.
- [ ] Recreating `media-issue-agent` with its appdata parent at `/config` preserves database history, logs, repair workspaces, and Codex auth under the existing host `state/` and `codex/` directories.
