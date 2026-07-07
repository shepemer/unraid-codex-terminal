#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${CONFIG_DIR:-/config}"
RUNTIME_DIR="/run/codex-terminal"
SSHD_TEMPLATE="/etc/codex-terminal/sshd_config"
SSHD_RUNTIME="${RUNTIME_DIR}/sshd_config"
MCP_URL="${UNRAID_MCP_URL:-http://unraid-mcp:6970/mcp}"
MEDIA_MCP_URL="${MEDIA_MCP_URL:-http://media-mcp:6971/mcp}"
UTILITIES_MCP_URL="${UTILITIES_MCP_URL:-http://utilities-mcp:6972/mcp}"
CODEX_ENV_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

die() {
  echo "codex-terminal: $*" >&2
  exit 1
}

truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

shell_quote() {
  local value="$1"
  printf "'%s'" "$(printf '%s' "$value" | sed "s/'/'\\\\''/g")"
}

remove_mcp_server_block() {
  local server_name="$1"
  local config_file="$2"
  awk -v server_name="${server_name}" '
    $0 == "[mcp_servers." server_name "]" {
      skip = 1
      next
    }
    skip && /^\[/ {
      skip = 0
    }
    !skip
  ' "${config_file}" > "${config_file}.tmp"
  mv "${config_file}.tmp" "${config_file}"
}

ensure_mcp_server_block() {
  local server_name="$1"
  local server_url="$2"
  local token_env_var="$3"
  local config_file="$4"

  remove_mcp_server_block "${server_name}" "${config_file}"
  cat >> "${config_file}" <<EOF

[mcp_servers.${server_name}]
url = "${server_url}"
bearer_token_env_var = "${token_env_var}"
EOF
}

sync_optional_mcp_server_block() {
  local server_name="$1"
  local server_url="$2"
  local token_env_var="$3"
  local token_value="$4"
  local config_file="$5"

  if [ -n "${token_value}" ]; then
    ensure_mcp_server_block "${server_name}" "${server_url}" "${token_env_var}" "${config_file}"
  else
    remove_mcp_server_block "${server_name}" "${config_file}"
  fi
}

update_codex_cli() {
  truthy "${CODEX_UPDATE_ON_START:-true}" || return 0

  local version="${CODEX_NPM_VERSION:-latest}"
  local timeout_seconds="${CODEX_UPDATE_ON_START_TIMEOUT:-180}"

  case "${version}" in
    ""|*[[:space:]]*) die "CODEX_NPM_VERSION must not be empty or contain whitespace" ;;
  esac
  case "${timeout_seconds}" in
    ""|*[!0-9]*) die "CODEX_UPDATE_ON_START_TIMEOUT must be a positive integer number of seconds" ;;
    0) die "CODEX_UPDATE_ON_START_TIMEOUT must be greater than zero" ;;
  esac

  echo "codex-terminal: updating Codex CLI via npm install -g @openai/codex@${version}" >&2
  if timeout "${timeout_seconds}" npm install -g "@openai/codex@${version}"; then
    npm cache clean --force >/dev/null 2>&1 || true
    verify_codex_cli
  else
    echo "codex-terminal: warning: Codex CLI update failed; continuing with bundled version" >&2
  fi
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
    MEDIA_MCP_URL="${MEDIA_MCP_URL}" \
    MEDIA_MCP_BEARER_TOKEN="${MEDIA_MCP_BEARER_TOKEN:-}" \
    UTILITIES_MCP_URL="${UTILITIES_MCP_URL}" \
    UTILITIES_MCP_BEARER_TOKEN="${UTILITIES_MCP_BEARER_TOKEN:-}" \
    CODEX_MEDIA_PATH_MAPS="${CODEX_MEDIA_PATH_MAPS:-}" \
    PATH="${CODEX_ENV_PATH}" \
    "$@"
}

verify_codex_cli() {
  local codex_version

  if codex_version="$(run_as_codex codex --version 2>/dev/null)"; then
    echo "codex-terminal: Codex CLI ready for SSH/WebUI sessions: ${codex_version}" >&2
  else
    echo "codex-terminal: warning: Codex CLI update completed, but verification as codex user failed" >&2
  fi
}

validate_runtime_env() {
  case "${MCP_URL}" in
    *[[:space:]]*) die "UNRAID_MCP_URL must not contain whitespace" ;;
  esac
  case "${MEDIA_MCP_URL}" in
    *[[:space:]]*) die "MEDIA_MCP_URL must not contain whitespace" ;;
  esac
  case "${UTILITIES_MCP_URL}" in
    *[[:space:]]*) die "UTILITIES_MCP_URL must not contain whitespace" ;;
  esac
  if [ -n "${UNRAID_MCP_BEARER_TOKEN:-}" ]; then
    case "${UNRAID_MCP_BEARER_TOKEN}" in
      *[[:space:]]*) die "UNRAID_MCP_BEARER_TOKEN must not contain whitespace" ;;
    esac
  fi
  if [ -n "${MEDIA_MCP_BEARER_TOKEN:-}" ]; then
    case "${MEDIA_MCP_BEARER_TOKEN}" in
      *[[:space:]]*) die "MEDIA_MCP_BEARER_TOKEN must not contain whitespace" ;;
    esac
  fi
  if [ -n "${UTILITIES_MCP_BEARER_TOKEN:-}" ]; then
    case "${UTILITIES_MCP_BEARER_TOKEN}" in
      *[[:space:]]*) die "UTILITIES_MCP_BEARER_TOKEN must not contain whitespace" ;;
    esac
  fi
  if [ -n "${CODEX_MEDIA_PATH_MAPS:-}" ]; then
    case "${CODEX_MEDIA_PATH_MAPS}" in
      *$'\n'*|*$'\r'*) die "CODEX_MEDIA_PATH_MAPS must not contain newlines" ;;
    esac
  fi
}

mkdir -p \
  "${CONFIG_DIR}/.codex" \
  "${CONFIG_DIR}/cache" \
  "${CONFIG_DIR}/local" \
  "${CONFIG_DIR}/ssh" \
  "${CONFIG_DIR}/workspace" \
  "${RUNTIME_DIR}" \
  /run/sshd

# OpenSSH StrictModes rejects group/other-writable path components for
# AuthorizedKeysFile, including the bind-mounted /config directory itself.
chown codex:codex "${CONFIG_DIR}"
chmod 0755 "${CONFIG_DIR}"

chown -R codex:codex \
  "${CONFIG_DIR}/.codex" \
  "${CONFIG_DIR}/cache" \
  "${CONFIG_DIR}/local" \
  "${CONFIG_DIR}/ssh" \
  "${CONFIG_DIR}/workspace"
chmod 0700 "${CONFIG_DIR}/ssh"

if [ ! -s "${CONFIG_DIR}/ssh/ssh_host_ed25519_key" ]; then
  ssh-keygen -q -t ed25519 -N "" -f "${CONFIG_DIR}/ssh/ssh_host_ed25519_key"
fi

if [ ! -s "${CONFIG_DIR}/ssh/ssh_host_rsa_key" ]; then
  ssh-keygen -q -t rsa -b 4096 -N "" -f "${CONFIG_DIR}/ssh/ssh_host_rsa_key"
fi

if [ -n "${SSH_AUTHORIZED_KEYS_FILE:-}" ]; then
  [ -r "${SSH_AUTHORIZED_KEYS_FILE}" ] || die "SSH_AUTHORIZED_KEYS_FILE is set but cannot be read"
  cp "${SSH_AUTHORIZED_KEYS_FILE}" "${CONFIG_DIR}/ssh/authorized_keys"
elif [ -n "${SSH_AUTHORIZED_KEYS:-}" ]; then
  printf '%s\n' "${SSH_AUTHORIZED_KEYS}" > "${CONFIG_DIR}/ssh/authorized_keys"
fi

touch "${CONFIG_DIR}/ssh/authorized_keys"
chown codex:codex "${CONFIG_DIR}/ssh/authorized_keys" "${CONFIG_DIR}/ssh"/ssh_host_*_key*
chmod 0600 "${CONFIG_DIR}/ssh/authorized_keys" "${CONFIG_DIR}/ssh"/ssh_host_*_key
chmod 0644 "${CONFIG_DIR}/ssh"/ssh_host_*_key.pub

validate_runtime_env
update_codex_cli

password_authentication="no"
if truthy "${SSH_PASSWORD_LOGIN:-false}"; then
  if [ -n "${SSH_PASSWORD:-}" ] && [ -n "${SSH_PASSWORD_HASH:-}" ]; then
    die "SSH_PASSWORD and SSH_PASSWORD_HASH are both set; use only one"
  fi

  if [ -n "${SSH_PASSWORD:-}" ]; then
    case "${SSH_PASSWORD}" in
      *$'\n'*|*$'\r'*) die "SSH_PASSWORD must not contain newlines" ;;
    esac
    printf 'codex:%s\n' "${SSH_PASSWORD}" | chpasswd \
      || die "failed to apply SSH_PASSWORD; password mode requires a writable root filesystem"
  elif [ -n "${SSH_PASSWORD_HASH:-}" ]; then
    printf 'codex:%s\n' "${SSH_PASSWORD_HASH}" | chpasswd -e \
      || die "failed to apply SSH_PASSWORD_HASH; password mode requires a writable root filesystem"
  else
    die "SSH_PASSWORD_LOGIN is enabled, but SSH_PASSWORD is empty"
  fi
  password_authentication="yes"
fi

awk \
  -v password_authentication="${password_authentication}" \
  '{
    gsub("__PASSWORD_AUTHENTICATION__", password_authentication)
    print
  }' "${SSHD_TEMPLATE}" > "${SSHD_RUNTIME}"
chmod 0600 "${SSHD_RUNTIME}"

cat > "${RUNTIME_DIR}/codex-env.sh" <<EOF
export CODEX_HOME=$(shell_quote "${CONFIG_DIR}/.codex")
export CODEX_WORKSPACE=/workspace
export XDG_CONFIG_HOME=$(shell_quote "${CONFIG_DIR}/.config")
export XDG_CACHE_HOME=$(shell_quote "${CONFIG_DIR}/cache")
export XDG_DATA_HOME=$(shell_quote "${CONFIG_DIR}/local/share")
export UNRAID_MCP_URL=$(shell_quote "${MCP_URL}")
export MEDIA_MCP_URL=$(shell_quote "${MEDIA_MCP_URL}")
export UTILITIES_MCP_URL=$(shell_quote "${UTILITIES_MCP_URL}")
export CODEX_MEDIA_PATH_MAPS=$(shell_quote "${CODEX_MEDIA_PATH_MAPS:-}")
export PATH=$(shell_quote "${CODEX_ENV_PATH}")
EOF
if [ -n "${UNRAID_MCP_BEARER_TOKEN:-}" ]; then
  printf 'export UNRAID_MCP_BEARER_TOKEN=%s\n' "$(shell_quote "${UNRAID_MCP_BEARER_TOKEN}")" >> "${RUNTIME_DIR}/codex-env.sh"
fi
if [ -n "${MEDIA_MCP_BEARER_TOKEN:-}" ]; then
  printf 'export MEDIA_MCP_BEARER_TOKEN=%s\n' "$(shell_quote "${MEDIA_MCP_BEARER_TOKEN}")" >> "${RUNTIME_DIR}/codex-env.sh"
fi
if [ -n "${UTILITIES_MCP_BEARER_TOKEN:-}" ]; then
  printf 'export UTILITIES_MCP_BEARER_TOKEN=%s\n' "$(shell_quote "${UTILITIES_MCP_BEARER_TOKEN}")" >> "${RUNTIME_DIR}/codex-env.sh"
fi
chown root:codex "${RUNTIME_DIR}/codex-env.sh"
chmod 0640 "${RUNTIME_DIR}/codex-env.sh"

if [ ! -s "${CONFIG_DIR}/.codex/config.toml" ]; then
  cat > "${CONFIG_DIR}/.codex/config.toml" <<EOF
[mcp_servers.unraid]
url = "${MCP_URL}"
bearer_token_env_var = "UNRAID_MCP_BEARER_TOKEN"
EOF
fi
sync_optional_mcp_server_block "media" "${MEDIA_MCP_URL}" "MEDIA_MCP_BEARER_TOKEN" "${MEDIA_MCP_BEARER_TOKEN:-}" "${CONFIG_DIR}/.codex/config.toml"
sync_optional_mcp_server_block "utilities" "${UTILITIES_MCP_URL}" "UTILITIES_MCP_BEARER_TOKEN" "${UTILITIES_MCP_BEARER_TOKEN:-}" "${CONFIG_DIR}/.codex/config.toml"
chown codex:codex "${CONFIG_DIR}/.codex/config.toml"
chmod 0600 "${CONFIG_DIR}/.codex/config.toml"

if [ ! -s "${CONFIG_DIR}/workspace/AGENTS.md" ]; then
  cat > "${CONFIG_DIR}/workspace/AGENTS.md" <<'EOF'
# Codex Rules For This Unraid Environment

- Do not request or use SSH access to the Unraid host.
- Do not request or use access to `/var/run/docker.sock`.
- Use the configured Unraid MCP server for Unraid management.
- Use the configured media MCP server for Sonarr, Radarr, Plex, Tautulli, Tracearr, Bazarr, Prowlarr, qBittorrent, NZBGet, Threadfin, and Seerr-family media automation when present.
- Use the configured utilities MCP server for Scrutiny monitoring when present.
- Ask for explicit user confirmation before array start or stop, correcting parity checks, VM force stop or reset, container deletes, plugin changes, API key changes, flash backup, network settings changes, and destructive notification archive or delete actions.
- Summarize logs. Do not print secrets, bearer tokens, API keys, cookies, passwords, or session values.
- Treat `/mnt/unraid/*` diagnostic mounts as read-only inspection surfaces.
- Use `media-path-check --json <path...>` for read-only media and download path diagnosis when optional path maps or `/mnt/unraid` mounts are configured.
EOF
  chown codex:codex "${CONFIG_DIR}/workspace/AGENTS.md"
  chmod 0644 "${CONFIG_DIR}/workspace/AGENTS.md"
fi

if [ ! -s "${CONFIG_DIR}/ssh/authorized_keys" ] && ! truthy "${SSH_PASSWORD_LOGIN:-false}"; then
  echo "codex-terminal: warning: no SSH authorized keys configured and password login is disabled" >&2
fi

exec "$@"
