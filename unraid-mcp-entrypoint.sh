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

exec unraid-mcp-server "$@"
