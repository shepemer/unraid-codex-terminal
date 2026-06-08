#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${CONFIG_DIR:-/config}"
RUNTIME_DIR="/run/codex-terminal"
SSHD_CONFIG="${RUNTIME_DIR}/sshd_config"
SESSION_NAME="${WEBUI_TMUX_SESSION:-codex}"
WEBUI_PORT="${WEBUI_PORT:-7681}"
WEBUI_MAX_CLIENTS="${WEBUI_MAX_CLIENTS:-5}"
WEBUI_ENABLED="${WEBUI_ENABLED:-true}"
WEBUI_AUTH="${WEBUI_AUTH:-true}"
WEBUI_USERNAME="${WEBUI_USERNAME:-codex}"
WEBUI_PASSWORD="${WEBUI_PASSWORD:-}"
WEBUI_LOG_LEVEL="${WEBUI_LOG_LEVEL:-1}"
AUTO_LAUNCH_CODEX="${AUTO_LAUNCH_CODEX:-true}"
CODEX_WEBUI_BYPASS_APPROVALS="${CODEX_WEBUI_BYPASS_APPROVALS:-true}"
MCP_URL="${UNRAID_MCP_URL:-http://unraid-mcp:6970/mcp}"

die() {
  echo "codex-web-terminal: $*" >&2
  exit 1
}

truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

run_as_codex() {
  runuser -u codex -- env \
    HOME=/home/codex \
    CODEX_HOME="${CONFIG_DIR}/.codex" \
    CODEX_WORKSPACE=/workspace \
    XDG_CONFIG_HOME="${CONFIG_DIR}/.config" \
    XDG_CACHE_HOME="${CONFIG_DIR}/cache" \
    XDG_DATA_HOME="${CONFIG_DIR}/local/share" \
    UNRAID_MCP_URL="${MCP_URL}" \
    UNRAID_MCP_BEARER_TOKEN="${UNRAID_MCP_BEARER_TOKEN:-}" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$@"
}

start_sshd() {
  /usr/sbin/sshd -D -e -f "${SSHD_CONFIG}" &
  sshd_pid="$!"
}

start_tmux_session() {
  if run_as_codex tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
    return 0
  fi

  run_as_codex tmux new-session -d -s "${SESSION_NAME}" -c /workspace -x 220 -y 50 bash

  if truthy "${AUTO_LAUNCH_CODEX}"; then
    local codex_command="codex"
    if truthy "${CODEX_WEBUI_BYPASS_APPROVALS}"; then
      codex_command="codex --dangerously-bypass-approvals-and-sandbox"
    fi
    run_as_codex tmux send-keys -t "${SESSION_NAME}" "${codex_command}" Enter
  fi
}

start_webui() {
  local ttyd_args=(
    --port "${WEBUI_PORT}"
    --debug "${WEBUI_LOG_LEVEL}"
    --writable
    --max-clients "${WEBUI_MAX_CLIENTS}"
  )

  if truthy "${WEBUI_AUTH}"; then
    [ -n "${WEBUI_PASSWORD}" ] || die "WEBUI_AUTH is enabled, but WEBUI_PASSWORD is empty"
    ttyd_args+=(--credential "${WEBUI_USERNAME}:${WEBUI_PASSWORD}")
  else
    echo "codex-web-terminal: warning: WEBUI_AUTH is disabled; the WebUI exposes a shell to anyone who can reach the port" >&2
  fi

  run_as_codex ttyd "${ttyd_args[@]}" tmux attach-session -t "${SESSION_NAME}" &
  webui_pid="$!"
}

sshd_pid=""
webui_pid=""

cleanup() {
  if [ -n "${webui_pid}" ]; then
    kill "${webui_pid}" 2>/dev/null || true
  fi
  if [ -n "${sshd_pid}" ]; then
    kill "${sshd_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

[ -s "${SSHD_CONFIG}" ] || die "runtime sshd_config is missing; entrypoint did not finish setup"

if ! truthy "${WEBUI_ENABLED}"; then
  exec /usr/sbin/sshd -D -e -f "${SSHD_CONFIG}"
fi

start_sshd
start_tmux_session
start_webui

wait -n "${sshd_pid}" "${webui_pid}"
exit_code="$?"
cleanup
exit "${exit_code}"
