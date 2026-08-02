#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
function_source="$(awk '
  /^configure_ssh_password\(\) \{/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "${repo_root}/entrypoint.sh")"

[ -n "${function_source}" ] || {
  echo "configure_ssh_password function was not found" >&2
  exit 1
}
eval "${function_source}"

die() {
  echo "codex-terminal: $*" >&2
  exit 1
}

test_tmp="$(mktemp -d)"
trap 'rm -rf -- "${test_tmp}"' EXIT
args_log="${test_tmp}/args"
stdin_log="${test_tmp}/stdin"
error_log="${test_tmp}/error"

fake_chpasswd() {
  printf '%s' "$*" > "${args_log}"
  local input=""
  IFS= read -r input || true
  printf '%s' "${input}" > "${stdin_log}"
}

SSH_PASSWORD='plain fixture password' \
SSH_PASSWORD_HASH='' \
CHPASSWD_BIN=fake_chpasswd \
  configure_ssh_password
[ "$(<"${args_log}")" = "" ]
[ "$(<"${stdin_log}")" = 'codex:plain fixture password' ]

SSH_PASSWORD='' \
SSH_PASSWORD_HASH='$6$fixture-salt$fixture-hash' \
CHPASSWD_BIN=fake_chpasswd \
  configure_ssh_password
[ "$(<"${args_log}")" = "-e" ]
[ "$(<"${stdin_log}")" = 'codex:$6$fixture-salt$fixture-hash' ]

if (
  SSH_PASSWORD='plain fixture password' \
  SSH_PASSWORD_HASH='$6$fixture-salt$fixture-hash' \
  CHPASSWD_BIN=fake_chpasswd \
    configure_ssh_password
) 2> "${error_log}"; then
  echo "both SSH password forms unexpectedly succeeded" >&2
  exit 1
fi
grep -F 'SSH_PASSWORD and SSH_PASSWORD_HASH are both set' "${error_log}" >/dev/null

if (
  SSH_PASSWORD='' \
  SSH_PASSWORD_HASH=$'$6$fixture\nnewline' \
  CHPASSWD_BIN=fake_chpasswd \
    configure_ssh_password
) 2> "${error_log}"; then
  echo "multiline SSH password hash unexpectedly succeeded" >&2
  exit 1
fi
grep -F 'SSH_PASSWORD_HASH must not contain newlines' "${error_log}" >/dev/null

if (
  SSH_PASSWORD='' \
  SSH_PASSWORD_HASH='' \
  CHPASSWD_BIN=fake_chpasswd \
    configure_ssh_password
) 2> "${error_log}"; then
  echo "empty SSH password configuration unexpectedly succeeded" >&2
  exit 1
fi
grep -F 'neither SSH_PASSWORD nor SSH_PASSWORD_HASH is set' "${error_log}" >/dev/null

echo "SSH password configuration tests passed"
