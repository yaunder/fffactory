#!/usr/bin/env bash
# Install step `user` (docs/specs/host-protocol.md §apply): the runtime account's workspace,
# private directories, login profile, npm prefix, and the system's Git defaults.
# Wrapped from v1's development-environment/scripts/setup-host.sh (deleted in #102); `host
# apply` runs it as root after `packages`, and records its result. Idempotent: a rerun
# converges.
set -Eeuo pipefail

readonly FACTORY_USER="factory"
readonly FACTORY_GROUP="factory"
readonly FACTORY_HOME="/home/factory"
readonly FACTORY_ROOT="/workspace"
readonly PROFILE_PATH="/etc/profile.d/software-factory.sh"

temp_paths=()
cleanup() {
  local path
  for path in "${temp_paths[@]}"; do
    rm -rf -- "${path}"
  done
}
trap cleanup EXIT

fail() {
  echo "user: $1" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail "must run as root"
id "${FACTORY_USER}" >/dev/null 2>&1 || fail "bootstrap must create the ${FACTORY_USER} account first"

install -d -o "${FACTORY_USER}" -g "${FACTORY_GROUP}" -m 0750 \
  "${FACTORY_ROOT}" \
  "${FACTORY_ROOT}/repos" \
  "${FACTORY_ROOT}/cache" \
  "${FACTORY_HOME}/.cache" \
  "${FACTORY_HOME}/.config" \
  "${FACTORY_HOME}/.local" \
  "${FACTORY_HOME}/.local/bin"
install -d -o "${FACTORY_USER}" -g "${FACTORY_GROUP}" -m 0700 \
  "${FACTORY_HOME}/.codex" \
  "${FACTORY_HOME}/.claude"

profile_tmp="$(mktemp)"
temp_paths+=("${profile_tmp}")
# The profile expands these when a login shell reads it, not now.
# shellcheck disable=SC2016
printf '%s\n' \
  '# Managed by fffactory: the factory account environment.' \
  'export FACTORY_ROOT=/workspace' \
  'export FACTORY_REPOS=/workspace/repos' \
  'case ":${PATH}:" in' \
  '  *":${HOME}/.local/bin:"*) ;;' \
  '  *) export PATH="${HOME}/.local/bin:${PATH}" ;;' \
  'esac' >"${profile_tmp}"
install -o root -g root -m 0644 "${profile_tmp}" "${PROFILE_PATH}"

(cd "${FACTORY_HOME}" && runuser -u "${FACTORY_USER}" -- \
  env HOME="${FACTORY_HOME}" /usr/bin/npm-22 config set prefix "${FACTORY_HOME}/.local")

git config --system init.defaultBranch main
git config --system fetch.prune true
git lfs install --system

echo "user: the ${FACTORY_USER} account is set up."
