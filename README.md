# Unraid Codex Terminal

Unraid Docker templates for running Codex in a container that is reachable by SSH and a browser terminal, with Unraid management isolated behind an internal MCP sidecar.

Codex connects to the `codex-terminal` container, not to the Unraid host shell. Unraid control goes through `unraid-mcp` and the Unraid GraphQL API, not the Docker socket or broad host mounts.

## AI-Generated Code Disclaimer

The code and documentation in this repository were generated with AI assistance. Review the implementation, templates, and security settings before using them on a real Unraid system.

## Version Mismatch? Restart The Container

If Codex Desktop reports a Codex version mismatch when connecting over SSH, manually restart the `codex-terminal` container from Unraid. The container updates `@openai/codex` on startup by default, so a restart is the expected fix.

For full configuration, validation, local development, and security notes, see [docs.md](docs.md).

## What Runs

- `codex-terminal`: SSH on container port `2222`, WebUI on `7681`, Codex CLI, persistent `/config`, and `/workspace`.
- `unraid-mcp`: internal HTTP MCP sidecar for Unraid API access.
- `codex-mgmt`: private Docker bridge network shared by both containers.

## Install On Unraid

1. Create the internal Docker network:

   ```sh
   docker network create codex-mgmt
   ```

2. Copy both XML templates from `templates/` into:

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
   - at least one public key in `SSH_AUTHORIZED_KEYS`
   - strong `WEBUI_PASSWORD`

Do not publish a host port for `unraid-mcp`. Only SSH and the WebUI should be reachable from your LAN, VPN, or Tailscale.

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
- Keep `WEBUI_AUTH=true` and use a strong `WEBUI_PASSWORD`.
- Never mount `/var/run/docker.sock`, `/`, `/boot`, broad `/mnt`, or all of `/mnt/user/appdata`.
- Use a scoped Unraid API key, not an unrestricted admin key.
