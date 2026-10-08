#!/usr/bin/env bash
# Install step `plugins` (docs/specs/host-protocol.md §apply): the runtime account's Claude
# Code plugins, exactly as plugins.json pins them, each from a marketplace checkout at its
# pinned revision; undeclared user plugins and marketplaces are removed.
#
#   bash plugins.sh [install|verify]
#
# `host apply` runs it as root after `harness` with no argument, which installs; the `plugins`
# verifier of `host verify` runs it with `verify`, which changes nothing. FFFACTORY_STEPS
# names this release's steps directory. Idempotent: plugins at their pins are left alone.
# Wrapped from v1's agent-harness/scripts/manage-plugins.sh (deleted in #102).
# TODO(re-evaluate when this step is next changed, which D3 makes the time to port it to
# TypeScript): read the manifest and Claude Code's JSON without jq.
set -Eeuo pipefail

action=${1:-install}
[[ ${action} == install || ${action} == verify ]] || {
  echo 'Usage: plugins.sh [install|verify]' >&2
  exit 2
}

: "${FFFACTORY_STEPS:?FFFACTORY_STEPS must name the steps directory of the release}"
readonly factory_home=/home/factory
readonly factory_path="${factory_home}/.local/bin:/usr/local/bin:/usr/bin:/bin"
readonly manifest="${FFFACTORY_STEPS}/plugins.json"
readonly checkout_root="${factory_home}/.local/share/software-factory/marketplaces"

bash "${FFFACTORY_STEPS}/validate-plugins.sh" "${manifest}"

factory_command() {
  (cd "${factory_home}" && runuser -u factory -- env \
    HOME="${factory_home}" PATH="${factory_path}" DISABLE_UPDATES=1 \
    "$@")
}

fail() {
  echo "plugins: $1" >&2
  exit 1
}

remove_plugin_cache() {
  local id=$1
  if [[ ${id} =~ ^[a-z][a-z0-9-]*@[a-z][a-z0-9-]*$ ]]; then
    rm -rf -- "${factory_home}/.claude/plugins/cache/${id#*@}/${id%@*}"
  fi
}

plugin_rows=$(jq -c '.providers.claude.plugins[]' "${manifest}")
desired_ids=$(jq -c '[.providers.claude.plugins[].id]' "${manifest}")
desired_marketplaces=$(jq -c '[.providers.claude.plugins[].marketplace]' "${manifest}")

marketplace_json() { factory_command claude plugin marketplace list --json; }
plugin_json() { factory_command claude plugin list --json; }

check_plugin() {
  local row=$1 id marketplace version revision path checkout installed
  id=$(jq -r '.id' <<<"${row}")
  marketplace=$(jq -r '.marketplace' <<<"${row}")
  version=$(jq -r '.version' <<<"${row}")
  revision=$(jq -r '.source.revision' <<<"${row}")
  path=$(jq -r '.path' <<<"${row}")
  checkout="${checkout_root}/${marketplace}"

  [[ -d ${checkout}/.git ]] || return 1
  [[ $(factory_command git -C "${checkout}" rev-parse HEAD 2>/dev/null) == "${revision}" ]] || return 1
  [[ -z $(factory_command git -C "${checkout}" status --porcelain --untracked-files=all) ]] || return 1
  jq -e --arg id "${id%@*}" --arg version "${version}" --arg path "./${path}" \
    '.plugins | any(.name == $id and .version == $version and .source == $path)' \
    "${checkout}/.claude-plugin/marketplace.json" >/dev/null || return 1
  jq -e --arg id "${id%@*}" --arg version "${version}" \
    '.name == $id and .version == $version' \
    "${checkout}/${path}/.claude-plugin/plugin.json" >/dev/null || return 1

  marketplace_json | jq -e --arg name "${marketplace}" --arg checkout "${checkout}" \
    'any(.[]; .name == $name and .source == "directory" and .path == $checkout)' \
    >/dev/null || return 1
  installed=$(plugin_json | jq -r --arg id "${id}" --arg version "${version}" \
    '[.[] | select(.id == $id and .scope == "user" and .enabled == true and .version == $version)] | if length == 1 then .[0].installPath else empty end')
  [[ -n ${installed} && -d ${installed} ]] || return 1
  [[ ${installed} == "${factory_home}/.claude/plugins/cache/${marketplace}/${id%@*}/${version}" ]] || return 1
  jq -e --arg id "${id}" --arg revision "${revision}" \
    '.plugins[$id] | any(.scope == "user" and .gitCommitSha == $revision)' \
    "${factory_home}/.claude/plugins/installed_plugins.json" >/dev/null || return 1
  diff -rq "${checkout}/${path}" "${installed}" >/dev/null || return 1
}

verify_all() {
  local row id extras
  extras=$(plugin_json | jq -r --argjson desired "${desired_ids}" \
    '[.[] | select(.scope == "user" and (.id | IN($desired[]) | not)) | .id] | unique | join(", ")')
  [[ -z ${extras} ]] || fail "undeclared Claude user plugins: ${extras}"
  extras=$(marketplace_json | jq -r --argjson desired "${desired_marketplaces}" \
    '[.[] | select(.name | IN($desired[]) | not) | .name] | unique | join(", ")')
  [[ -z ${extras} ]] || fail "undeclared Claude marketplaces: ${extras}"
  while IFS= read -r row; do
    [[ -n ${row} ]] || continue
    id=$(jq -r '.id' <<<"${row}")
    if check_plugin "${row}"; then
      echo "plugins: ${id} matches its declared version, revision, and content"
    else
      fail "${id} is missing or differs from its declared version, revision, or content"
    fi
  done <<<"${plugin_rows}"
}

[[ ${EUID} -eq 0 ]] || fail "must run as root"

if [[ ${action} == verify ]]; then
  verify_all
  exit 0
fi

install -d -o factory -g factory -m 0700 "${checkout_root}"

# The factory account is dedicated to managed agents. Remove user-scope plugins
# and marketplaces that no longer appear in the release's manifest.
while IFS= read -r id; do
  [[ -n ${id} ]] || continue
  factory_command claude plugin uninstall "${id}" --scope user --yes
  remove_plugin_cache "${id}"
done < <(plugin_json | jq -r --argjson desired "${desired_ids}" \
  '.[] | select(.scope == "user" and (.id | IN($desired[]) | not)) | .id' | sort -u)
while IFS= read -r name; do
  [[ -n ${name} ]] || continue
  factory_command claude plugin marketplace remove "${name}"
  if [[ ${name} =~ ^[a-z][a-z0-9-]*$ ]]; then
    rm -rf -- "${checkout_root:?}/${name}"
  fi
done < <(marketplace_json | jq -r --argjson desired "${desired_marketplaces}" \
  '.[] | select(.name | IN($desired[]) | not) | .name' | sort -u)

while IFS= read -r row; do
  [[ -n ${row} ]] || continue
  id=$(jq -r '.id' <<<"${row}")
  name=$(jq -r '.marketplace' <<<"${row}")
  repository=$(jq -r '.source.repository' <<<"${row}")
  revision=$(jq -r '.source.revision' <<<"${row}")
  checkout="${checkout_root}/${name}"

  if check_plugin "${row}"; then
    echo "plugins: ${id} already matches its pin"
    continue
  fi

  if marketplace_json | jq -e --arg name "${name}" 'any(.[]; .name == $name)' >/dev/null; then
    factory_command claude plugin marketplace remove "${name}"
  fi
  if plugin_json | jq -e --arg id "${id}" 'any(.[]; .id == $id and .scope == "user")' >/dev/null; then
    factory_command claude plugin uninstall "${id}" --scope user --yes
  fi
  remove_plugin_cache "${id}"
  rm -rf -- "${checkout}"
  factory_command git clone --quiet "https://github.com/${repository}.git" "${checkout}"
  factory_command git -C "${checkout}" checkout --quiet --detach "${revision}"
  [[ $(factory_command git -C "${checkout}" rev-parse HEAD) == "${revision}" ]] ||
    fail "${id} resolved to the wrong revision"
  factory_command claude plugin marketplace add "${checkout}"
  factory_command claude plugin install "${id}" --scope user
  check_plugin "${row}" || fail "${id} failed post-install verification"
done <<<"${plugin_rows}"

verify_all
