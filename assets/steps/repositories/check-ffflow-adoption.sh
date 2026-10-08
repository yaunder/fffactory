#!/usr/bin/env bash

set -euo pipefail

if (($# != 2)); then
  printf 'Usage: check-ffflow-adoption REMOTE BRANCH\n' >&2
  exit 2
fi

remote=$1
branch=$2
git_bin=${FACTORY_GIT_BIN:-git}
"${git_bin}" check-ref-format --branch "${branch}" >/dev/null 2>&1 || {
  printf 'invalid repository branch: %s\n' "${branch}" >&2
  exit 1
}

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/factory-ffflow-adoption.XXXXXX")"
trap 'rm -rf -- "${probe_root}"' EXIT
"${git_bin}" init --quiet --bare "${probe_root}/repository.git"
if ! "${git_bin}" -C "${probe_root}/repository.git" fetch --quiet --no-tags \
  "${remote}" "+refs/heads/${branch}:refs/remotes/origin/${branch}"; then
  printf 'cannot fetch %s branch %s\n' "${remote}" "${branch}" >&2
  exit 1
fi

revision="refs/remotes/origin/${branch}"
config_path=.ffflow/config.yaml
mode="$("${git_bin}" -C "${probe_root}/repository.git" ls-tree \
  "${revision}" -- "${config_path}" | awk '{print $1}')"
if [[ ${mode} != 100644 && ${mode} != 100755 ]] \
  || ! "${git_bin}" -C "${probe_root}/repository.git" show \
    "${revision}:${config_path}" >"${probe_root}/config.yaml" 2>/dev/null; then
  printf '%s branch %s has no regular .ffflow/config.yaml\n' \
    "${remote}" "${branch}" >&2
  exit 1
fi

if ! awk '
  /^version:[[:space:]]*1[[:space:]]*($|#)/ { version++ }
  /^level:[[:space:]]*L[0-3][[:space:]]*($|#)/ { level++ }
  /^ffflow_version:[[:space:]]*[0-9]+[.][0-9]+[.][0-9]+[[:space:]]*($|#)/ { stamp++ }
  END { exit !(version == 1 && level == 1 && stamp == 1) }
' "${probe_root}/config.yaml"; then
  printf '%s branch %s has an invalid FFFlow adoption config\n' \
    "${remote}" "${branch}" >&2
  exit 1
fi
