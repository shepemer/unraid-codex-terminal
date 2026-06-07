# Unraid Codex Terminal

Unraid-native Docker templates for running Codex in an SSH and browser-accessible container, with Unraid management isolated behind an internal MCP sidecar.

The design has two hard boundaries:

- Codex connects to `codex-terminal` over SSH, not to the Unraid host shell.
- Unraid control uses the `unraid-mcp` sidecar and the Unraid GraphQL API, not the Docker socket or broad host mounts.

## Architecture

- `codex-terminal`: OpenSSH server on container port `2222`, `ttyd` WebUI on container port `7681`, Codex CLI, common diagnostic tools, persistent `/config`, and `/workspace` backed by `/config/workspace`.
- `unraid-mcp`: pinned `unraid-mcp==1.2.4` HTTP MCP server on the internal `codex-mgmt` network.
- `codex-mgmt`: user-defined Docker bridge network. SSH and the WebUI are published to the host; MCP is internal only.

## Unraid Install

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
   - `ghcr.io/shepemer/unraid-codex-terminal-unraid-mcp:1.2.4`

4. Install `unraid-mcp` first. Set:

   - `UNRAID_API_URL`, usually `https://tower.local/graphql`
   - `UNRAID_API_KEY`
   - `UNRAID_MCP_BEARER_TOKEN`

5. Install `codex-terminal`. Set the same `UNRAID_MCP_BEARER_TOKEN`, at least one public SSH key in `SSH_AUTHORIZED_KEYS`, and a strong `WEBUI_PASSWORD`. If you need SSH password login, set `SSH_PASSWORD_LOGIN=true` and a strong masked `SSH_PASSWORD`.

Do not add a port mapping for `unraid-mcp`. The MCP server should only be reachable from containers attached to `codex-mgmt`.

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

Sign in to Codex inside the SSH container if needed:

```sh
ssh -t unraid-codex codex login
```

## Local Development

Create `.env` from `.env.example`, fill in the required values, then run:

```sh
docker compose config
docker compose build
docker compose up -d
```

For local SSH testing, set `SSH_AUTHORIZED_KEYS` to your public key.
To test SSH password login, set `SSH_PASSWORD_LOGIN=true` and `SSH_PASSWORD`.
For local WebUI testing, set `WEBUI_PASSWORD` before starting the container.
The MCP sidecar entrypoint refuses to start unless `UNRAID_API_URL`, `UNRAID_API_KEY`, and `UNRAID_MCP_BEARER_TOKEN` are set.

## Validation

Static checks:

```sh
bash -n entrypoint.sh
bash -n web-terminal.sh
python3 -c 'import xml.etree.ElementTree as ET; [ET.parse(p) for p in ("templates/codex-terminal.xml", "templates/unraid-mcp.xml")]'
docker compose config
```

CI builds both images locally and scans them with Trivy for fixed high and critical OS/library vulnerabilities on pull requests. Pushes to `main`, tags, and manual runs publish to GHCR only after both scans pass.

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
- MCP can list Unraid system status and Docker containers.
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
- The MCP sidecar always requires bearer-token auth; do not add a host port mapping for MCP.
- The terminal container root filesystem is writable so it can apply an SSH password at startup. It still runs without privileged mode, host networking, host devices, host PID/IPC, broad mounts, or Docker socket access.

## MCP Fallback

The default sidecar image builds from pinned `unraid-mcp==1.2.4` from the `jmagar/unraid-mcp` package lineage. If you need a prebuilt fallback image instead, `ghcr.io/mlamoure/unraid-mcp:latest` is documented by that fork, but it should be evaluated separately before use.
