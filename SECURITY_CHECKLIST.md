# Security Checklist

Use this before deploying or publishing the templates.

## Required

- [ ] `codex-terminal` SSH is exposed only on LAN, VPN, or Tailscale.
- [ ] `codex-terminal` WebUI is exposed only on LAN, VPN, or Tailscale.
- [ ] `WEBUI_AUTH=true` and `WEBUI_PASSWORD` is strong, unless another authenticated proxy is in front of the WebUI.
- [ ] `WEBUI_LOG_LEVEL=1` unless temporarily troubleshooting, because higher `ttyd` startup logs can include the basic-auth credential.
- [ ] `unraid-mcp` has no host port mapping.
- [ ] Both containers are on `codex-mgmt`.
- [ ] `UNRAID_API_KEY` is configured only on `unraid-mcp`.
- [ ] `UNRAID_MCP_BEARER_TOKEN` is long, random, and matches both containers.
- [ ] Root SSH login is disabled.
- [ ] Password SSH login is disabled unless there is a specific need.
- [ ] No container uses `privileged: true`.
- [ ] No container uses host networking, host PID, host IPC, or host devices.
- [ ] No container mounts `/var/run/docker.sock`.
- [ ] No container mounts `/`, `/boot`, broad `/mnt`, or all appdata.
- [ ] Any diagnostic mount is narrow and read-only.
- [ ] The MCP sidecar requires bearer-token auth.

## API Key Scope

- [ ] The Unraid API key is not `ADMIN` by default.
- [ ] Read permissions cover only the needed resources.
- [ ] Docker mutations are enabled only if Codex should manage containers.
- [ ] VM mutations are enabled only if Codex should manage VMs.
- [ ] Array mutations, flash, API key, config, network, OS, permission, and plugin mutations remain disabled unless intentionally enabled.

## Validation

- [ ] `bash -n entrypoint.sh` passes.
- [ ] `bash -n web-terminal.sh` passes.
- [ ] Both XML templates parse.
- [ ] `docker compose config` passes.
- [ ] CI vulnerability scans pass before images are pushed.
- [ ] `sshd -t` passes inside the built `codex-terminal` image.
- [ ] `ssh unraid-codex codex --version` works.
- [ ] `ssh unraid-codex codex mcp list --json` shows the `unraid` MCP server.
- [ ] WebUI login works and attaches to the persistent `tmux` session.
- [ ] WebUI without credentials fails when `WEBUI_AUTH=true`.
- [ ] Root SSH login fails.
- [ ] Password SSH login fails by default.
- [ ] The container cannot access `/var/run/docker.sock`.
- [ ] Recreating `codex-terminal` preserves `/config/.codex`, SSH host keys, authorized keys, and workspace files.
