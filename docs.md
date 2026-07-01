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
- `media-mcp`: optional HTTP MCP server on the internal `codex-mgmt` network for Sonarr, Radarr, Plex, Tautulli, Bazarr, Prowlarr, qBittorrent, NZBGet, and Seerr-family media automation.
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
   - `ghcr.io/shepemer/unraid-codex-terminal-utilities-mcp:latest`

4. Install `unraid-mcp` first. Set:

   - `UNRAID_API_URL`, usually `http://tower.local/graphql` or `https://tower.local/graphql`
   - `UNRAID_API_KEY`
   - `UNRAID_MCP_BEARER_TOKEN`

5. Install `codex-terminal`. Set the same `UNRAID_MCP_BEARER_TOKEN`, at least one public SSH key in `SSH_AUTHORIZED_KEYS`, and a strong `WEBUI_PASSWORD`. If you need SSH password login, set `SSH_PASSWORD_LOGIN=true` and a strong masked `SSH_PASSWORD`.

6. Optional: install `media-mcp` on `codex-mgmt`. Set `MEDIA_MCP_BEARER_TOKEN` and at least one complete service credential set:

   - Sonarr: `SONARR_URL` and `SONARR_API_KEY`
   - Radarr: `RADARR_URL` and `RADARR_API_KEY`
   - Plex: `PLEX_URL` and `PLEX_TOKEN`
   - Bazarr: `BAZARR_URL` and `BAZARR_API_KEY`
   - Prowlarr: `PROWLARR_URL` and `PROWLARR_API_KEY`
   - qBittorrent: `QBITTORRENT_URL`, `QBITTORRENT_USERNAME`, and `QBITTORRENT_PASSWORD`
   - NZBGet: `NZBGET_URL`, `NZBGET_USERNAME`, and `NZBGET_PASSWORD`
   - Seerr, Overseerr, or Jellyseerr: `SEERR_URL` and `SEERR_API_KEY`

   Set the same `MEDIA_MCP_BEARER_TOKEN` in `codex-terminal` to add this optional sidecar to `/config/.codex/config.toml`.

7. Optional: install `utilities-mcp` on `codex-mgmt`. Set `UTILITIES_MCP_BEARER_TOKEN` and the Scrutiny endpoint:

   - Scrutiny: `SCRUTINY_URL`, plus optional `SCRUTINY_BASE_PATH` for reverse-proxy base paths

   Set the same `UTILITIES_MCP_BEARER_TOKEN` in `codex-terminal` to add this optional sidecar to `/config/.codex/config.toml`.

Do not add a port mapping for `unraid-mcp`, `media-mcp`, or `utilities-mcp`. MCP servers should only be reachable from containers attached to `codex-mgmt`.

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

- Shared: configured service status and compact media admin overview.
- Sonarr: list, lookup, add series, queue, guarded queue removal, manual import candidates/import, quality profiles, and root folders.
- Radarr: list, lookup, add movies, queue, guarded queue removal, manual import candidates/import, quality profiles, and root folders.
- Plex: server status, libraries, library items, search, metadata, active sessions, and normalized user-reported issue views.
- Tautulli: current activity and playback history diagnostics.
- Bazarr: status, wanted movie subtitles, wanted episode subtitles, providers, and subtitle history.
- Prowlarr: list indexers and search.
- qBittorrent: list torrents, pause or resume selected hashes, and delete selected hashes with explicit optional file deletion.
- NZBGet: status, queue, history, guarded history removal, pause or resume downloads, and set rate limits.
- Seerr, Overseerr, or Jellyseerr: search media, list/manage requests, and list/comment/resolve/reopen/delete reported issues.

Container lifecycle management stays with `unraid-mcp` and the scoped Unraid API. The media sidecar does not mount the Docker socket, media shares, or appdata directories.

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

The Unraid MCP sidecar entrypoint refuses to start unless `UNRAID_API_URL`, `UNRAID_API_KEY`, and `UNRAID_MCP_BEARER_TOKEN` are set. The media MCP sidecar refuses to start unless `MEDIA_MCP_BEARER_TOKEN` and at least one supported media service credential set are configured. The utilities MCP sidecar refuses to start unless `UTILITIES_MCP_BEARER_TOKEN` and at least one supported utility endpoint are configured.

To include the optional media sidecar in local compose runs:

```sh
docker compose --profile media config
docker compose --profile media build media-mcp
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
bash -n web-terminal.sh
bash -n codex-terminal-shell
sh -n codex-terminal-profile.sh
npm --prefix media-mcp run check
npm --prefix utilities-mcp run check
python3 -c 'import xml.etree.ElementTree as ET; [ET.parse(p) for p in ("templates/codex-terminal.xml", "templates/unraid-mcp.xml", "templates/media-mcp.xml", "templates/utilities-mcp.xml")]'
docker compose config
docker compose --profile media config
docker compose --profile utilities config
docker compose --profile media --profile utilities config
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
- Keep Sonarr, Radarr, Plex, Tautulli, Bazarr, Prowlarr, qBittorrent, NZBGet, and Seerr-family credentials only in the optional media MCP sidecar.
- Keep Scrutiny endpoints only in the optional utilities MCP sidecar.
- MCP sidecars require bearer-token auth; do not add host port mappings for MCP.
- The terminal container root filesystem is writable so it can apply an SSH password at startup. It still runs without privileged mode, host networking, host devices, host PID/IPC, broad mounts, or Docker socket access.
- Codex CLI startup updates download from npm as root before user sessions start. Disable `CODEX_UPDATE_ON_START` if you prefer only image-published Codex versions.
- The MCP sidecar keeps a read-only root filesystem. It starts as root only to fix ownership on its mounted appdata directories, then runs the server as the unprivileged `mcp` user.
- The media MCP sidecar runs as the unprivileged `mcp` user with a read-only root filesystem and no host mounts.

## MCP Fallback

The default sidecar image builds from pinned `unraid-mcp==1.2.4` from the `jmagar/unraid-mcp` package lineage. If you need a prebuilt fallback image instead, `ghcr.io/mlamoure/unraid-mcp:latest` is documented by that fork, but it should be evaluated separately before use.
