#!/usr/bin/env bash
set -euo pipefail

required_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "unraid-mcp: ${name} is required" >&2
    exit 1
  fi
}

required_env UNRAID_API_URL
required_env UNRAID_API_KEY
required_env UNRAID_MCP_BEARER_TOKEN

mkdir -p /home/mcp/.unraid-mcp /app/logs /app/backups
chown -R mcp:mcp /home/mcp/.unraid-mcp /app/logs /app/backups
chmod 0700 /home/mcp/.unraid-mcp

exec runuser -u mcp -- env \
  HOME=/home/mcp \
  PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin \
  unraid-mcp-server "$@"
