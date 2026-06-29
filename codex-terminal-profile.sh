# shellcheck shell=sh

if [ "${USER:-}" = "codex" ] || [ "${LOGNAME:-}" = "codex" ] || [ "${HOME:-}" = "/home/codex" ]; then
  codex_terminal_env_file="/run/codex-terminal/codex-env.sh"

  if [ -r "${codex_terminal_env_file}" ]; then
    . "${codex_terminal_env_file}"
  else
    export CODEX_HOME="${CODEX_HOME:-/config/.codex}"
    export CODEX_WORKSPACE="${CODEX_WORKSPACE:-/workspace}"
    export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/config/.config}"
    export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/config/cache}"
    export XDG_DATA_HOME="${XDG_DATA_HOME:-/config/local/share}"
    export UNRAID_MCP_URL="${UNRAID_MCP_URL:-http://unraid-mcp:6970/mcp}"
    export MEDIA_MCP_URL="${MEDIA_MCP_URL:-http://media-mcp:6971/mcp}"
    export UTILITIES_MCP_URL="${UTILITIES_MCP_URL:-http://utilities-mcp:6972/mcp}"
    export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  fi

  unset codex_terminal_env_file
fi
