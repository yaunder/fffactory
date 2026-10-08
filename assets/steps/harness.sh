#!/usr/bin/env bash
# Install step `harness` (docs/specs/host-protocol.md §apply): Codex and Claude Code for the
# runtime account at the versions and registry integrity values versions.env pins.
# Wrapped from v1's agent-harness/scripts/setup-host.sh (deleted in #102); `host apply` runs
# it as root after `user`, with FFFACTORY_STEPS naming this release's steps directory, and
# records its result. Idempotent: agents already at their pins are left alone.
# TODO(re-evaluate when this step is next changed, which D3 makes the time to port it to
# TypeScript): read npm pack's JSON without jq.
set -Eeuo pipefail

readonly FACTORY_USER="factory"
readonly FACTORY_GROUP="factory"
readonly FACTORY_HOME="/home/factory"
readonly FACTORY_PATH="${FACTORY_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"

temp_paths=()
cleanup() {
  local path
  for path in "${temp_paths[@]}"; do
    rm -rf -- "${path}"
  done
}
trap cleanup EXIT

fail() {
  echo "harness: $1" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail "must run as root"
: "${FFFACTORY_STEPS:?FFFACTORY_STEPS must name the steps directory of the release}"
readonly VERSIONS_FILE="${FFFACTORY_STEPS}/versions.env"
[[ -r ${VERSIONS_FILE} ]] || fail "the release has no ${VERSIONS_FILE}"
id "${FACTORY_USER}" >/dev/null 2>&1 || fail "bootstrap must create the ${FACTORY_USER} account first"

# shellcheck disable=SC1090
source "${VERSIONS_FILE}"
: "${CODEX_VERSION:?CODEX_VERSION is required}"
: "${CODEX_INTEGRITY:?CODEX_INTEGRITY is required}"
: "${CLAUDE_CODE_VERSION:?CLAUDE_CODE_VERSION is required}"
: "${CLAUDE_CODE_INTEGRITY:?CLAUDE_CODE_INTEGRITY is required}"

factory_command() {
  (cd "${FACTORY_HOME}" && runuser -u "${FACTORY_USER}" -- env \
    HOME="${FACTORY_HOME}" PATH="${FACTORY_PATH}" DISABLE_UPDATES=1 "$@")
}

download_package() {
  local package_name=$1
  local package_version=$2
  local expected_integrity=$3
  local result_file=$4
  local actual_integrity

  if ! factory_command /usr/bin/npm-22 pack "${package_name}@${package_version}" \
    --pack-destination "${package_tmp}" --json >"${result_file}"; then
    fail "failed to download ${package_name}@${package_version}"
  fi

  actual_integrity="$(jq -er '.[0].integrity' "${result_file}")"
  if [[ ${actual_integrity} != "${expected_integrity}" ]]; then
    fail "integrity mismatch for ${package_name}@${package_version}"
  fi
}

if codex_current="$(factory_command codex --version 2>/dev/null)" &&
  claude_current="$(factory_command claude --version 2>/dev/null)" &&
  [[ ${codex_current} == *"${CODEX_VERSION}"* && ${claude_current} == *"${CLAUDE_CODE_VERSION}"* ]]; then
  echo "harness: coding agents already match their pins."
else
  package_tmp="$(mktemp -d)"
  chown "${FACTORY_USER}:${FACTORY_GROUP}" "${package_tmp}"
  temp_paths+=("${package_tmp}")
  codex_pack_result="$(mktemp)"
  claude_pack_result="$(mktemp)"
  temp_paths+=("${codex_pack_result}" "${claude_pack_result}")

  download_package \
    "@openai/codex" "${CODEX_VERSION}" "${CODEX_INTEGRITY}" \
    "${codex_pack_result}"
  download_package \
    "@anthropic-ai/claude-code" "${CLAUDE_CODE_VERSION}" \
    "${CLAUDE_CODE_INTEGRITY}" "${claude_pack_result}"

  codex_tarball="${package_tmp}/$(jq -er '.[0].filename' "${codex_pack_result}")"
  claude_tarball="${package_tmp}/$(jq -er '.[0].filename' "${claude_pack_result}")"

  factory_command /usr/bin/npm-22 install --global --no-audit --no-fund \
    "${codex_tarball}" "${claude_tarball}"
fi

codex_reported="$(factory_command codex --version)"
claude_reported="$(factory_command claude --version)"
[[ ${codex_reported} == *"${CODEX_VERSION}"* ]] ||
  fail "Codex reported another version than its pin, ${CODEX_VERSION}"
[[ ${claude_reported} == *"${CLAUDE_CODE_VERSION}"* ]] ||
  fail "Claude Code reported another version than its pin, ${CLAUDE_CODE_VERSION}"

echo "harness: Codex ${CODEX_VERSION} and Claude Code ${CLAUDE_CODE_VERSION} are installed."
