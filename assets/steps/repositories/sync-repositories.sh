#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_MANIFEST="/var/lib/fffactory/repositories.json"
readonly DEFAULT_REPOSITORY_ROOT="/workspace/repos"
readonly SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: sync-repositories.sh [--plan | --apply] [--host HOST]
                                 [--manifest PATH] [--json]

Resolve the current host's repository sets and reconcile durable primary
clones under /workspace/repos. The default mode is --plan.

Actions:
  --plan           Probe declared remotes and report the changes that --apply
                   would make without changing managed checkouts (default).
  --apply          Clone missing repositories and fast-forward eligible clean
                   repositories according to the manifest.

Options:
  --host HOST      Override the short hostname used for placement.
  --manifest PATH  Override the installed inventory path.
  --json           Print only the versioned repository result on stdout;
                   diagnostics and progress go to stderr.
  -h, --help       Show this help.

Environment overrides for testing or nonstandard installations:
  FACTORY_REPOSITORY_ROOT
  FACTORY_GH_BIN
  FACTORY_GIT_BIN
  FACTORY_JQ_BIN
  FACTORY_FFFLOW_CHECK_BIN
EOF
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

resolve_command() {
  local override=$1
  local command_name=$2

  if [[ -n ${override} ]]; then
    [[ -x ${override} ]] || fail "${command_name} is not executable: ${override}"
    printf '%s\n' "${override}"
    return
  fi

  command -v "${command_name}" 2>/dev/null \
    || fail "Required command not found: ${command_name}"
}

normalize_github_remote() {
  local remote=$1
  local slug

  case "${remote}" in
    https://github.com/*)
      slug=${remote#https://github.com/}
      ;;
    http://github.com/*)
      slug=${remote#http://github.com/}
      ;;
    git@github.com:*)
      slug=${remote#git@github.com:}
      ;;
    ssh://git@github.com/*)
      slug=${remote#ssh://git@github.com/}
      ;;
    git://github.com/*)
      slug=${remote#git://github.com/}
      ;;
    *)
      return 1
      ;;
  esac

  slug=${slug%/}
  slug=${slug%.git}
  printf '%s\n' "${slug}" | tr '[:upper:]' '[:lower:]'
}

has_symlink_component() {
  local relative_path=$1
  local current_path=${repository_root}
  local component
  local components=()
  IFS='/' read -r -a components <<<"${relative_path}"
  for component in "${components[@]}"; do
    current_path="${current_path}/${component}"
    [[ ! -L ${current_path} ]] || return 0
  done
  return 1
}

validate_primary_repository() {
  local destination=$1
  [[ -d ${destination} && ! -L ${destination} && -d ${destination}/.git ]] \
    || return 1

  local top_level physical_destination
  top_level="$("${git_bin}" -C "${destination}" rev-parse --show-toplevel 2>/dev/null)" \
    || return 1
  physical_destination="$(cd "${destination}" && pwd -P)" || return 1
  [[ ${top_level} == "${physical_destination}" ]]
}

probe_repository() {
  local destination=$1
  local remote_url=$2
  local branch=$3
  local repository_alias=$4
  local probe_directory="${probe_root}/${repository_alias}"

  "${git_bin}" init --quiet --bare "${probe_directory}"
  if ! "${git_bin}" -C "${probe_directory}" fetch --quiet --no-tags \
    "${remote_url}" \
    "+refs/heads/${branch}:refs/remotes/origin/${branch}"; then
    return 1
  fi
  "${git_bin}" -C "${probe_directory}" fetch --quiet --no-tags \
    "${destination}" "+refs/heads/${branch}:refs/heads/local"
}

mode=plan
json=false
host_name=""
manifest_path="${DEFAULT_MANIFEST}"
repository_root="${FACTORY_REPOSITORY_ROOT:-${DEFAULT_REPOSITORY_ROOT}}"
probe_root=''
staging_path=''

cleanup() {
  if [[ -n ${staging_path} && -e ${staging_path} ]]; then
    rm -rf -- "${staging_path}"
  fi
  if [[ -n ${probe_root} && -d ${probe_root} ]]; then
    rm -rf -- "${probe_root}"
  fi
}
trap cleanup EXIT

while (($# > 0)); do
  case "$1" in
    --plan)
      mode=plan
      ;;
    --apply)
      mode=apply
      ;;
    --host)
      (($# >= 2)) || fail "--host requires a value"
      host_name=$2
      shift
      ;;
    --manifest)
      (($# >= 2)) || fail "--manifest requires a value"
      manifest_path=$2
      shift
      ;;
    --json)
      json=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
  shift
done

if [[ ${EUID} -eq 0 ]]; then
  fail "repository synchronization must run as the factory account through fffactory"
fi

jq_bin="$(resolve_command "${FACTORY_JQ_BIN:-}" jq)"
git_bin="$(resolve_command "${FACTORY_GIT_BIN:-}" git)"
gh_bin="$(resolve_command "${FACTORY_GH_BIN:-}" gh)"
ffflow_check_bin="$(resolve_command "${FACTORY_FFFLOW_CHECK_BIN:-}" "${SCRIPT_DIRECTORY}/check-ffflow-adoption.sh")"

# In protocol mode stdout is the machine-readable document alone. The ordinary progress and
# diagnostics remain visible on stderr, and descriptor 3 retains the caller's stdout.
if [[ ${json} == true ]]; then
  exec 3>&1
  exec 1>&2
fi

[[ -r ${manifest_path} ]] || fail "Repository manifest is not readable: ${manifest_path}"
[[ -d ${repository_root} ]] || fail "Repository root does not exist: ${repository_root}"
[[ ! -L ${repository_root} ]] || fail "Repository root must not be a symbolic link: ${repository_root}"

if ! "${jq_bin}" -e '
  . as $manifest
  | type == "object"
  and .version == 2
  and (.repositories | type == "object")
  and (.repository_sets | type == "object")
  and (.hosts | type == "object")
  and all(.repositories | to_entries[];
    (.key | test("^[A-Za-z0-9._-]+$"))
    and (.key != "." and .key != "..")
    and (.value | type == "object")
    and (.value.remote | type == "string"
      and test("^https://github[.]com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+([.]git)?$"))
    and (.value.path | type == "string"
      and test("^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")
      and (split("/") | all(. != "." and . != "..")))
    and (.value.branch | type == "string" and length > 0)
    and .value.update_policy == "fast-forward-only")
  and ([.repositories[].path] | length == (unique | length))
  and ([.repositories[].remote | ascii_downcase] | length == (unique | length))
  and all(.repository_sets | to_entries[];
    (.key | test("^[A-Za-z0-9._-]+$"))
    and (.key != "." and .key != "..")
    and (.value | type == "array" and length == (unique | length))
    and all(.value[]; . as $repository | $manifest.repositories | has($repository)))
  and all(.hosts | to_entries[];
    (.key | test("^[A-Za-z0-9][A-Za-z0-9.-]*$"))
    and (.value | type == "object")
    and (.value.repository_sets | type == "array" and length == (unique | length))
    and all(.value.repository_sets[]; . as $set | $manifest.repository_sets | has($set)))
' "${manifest_path}" >/dev/null; then
  fail "Repository manifest failed schema or reference validation: ${manifest_path}"
fi

while IFS= read -r branch; do
  "${git_bin}" check-ref-format --branch "${branch}" >/dev/null 2>&1 \
    || fail "Repository manifest contains an invalid branch: ${branch}"
done < <("${jq_bin}" -r '.repositories[].branch' "${manifest_path}" | sort -u)

if [[ -z ${host_name} ]]; then
  host_name="$(hostname --short)"
fi

if ! "${jq_bin}" -e --arg host "${host_name}" '.hosts | has($host)' \
  "${manifest_path}" >/dev/null; then
  available="$("${jq_bin}" -r '.hosts | keys | sort | join(", ")' "${manifest_path}")"
  fail "Host '${host_name}' is not mapped in the repository manifest. Available hosts: ${available}"
fi

repository_aliases="$("${jq_bin}" -r --arg host "${host_name}" '
  . as $manifest
  | .hosts[$host].repository_sets[] as $set
  | $manifest.repository_sets[$set][]
' "${manifest_path}" | sort -u)"
probe_root="$(mktemp -d "${TMPDIR:-/tmp}/sync-factory-repositories.XXXXXX")" \
  || fail "Could not create a temporary repository probe directory"

ready=0
missing=0
planned_updates=0
cloned=0
updated=0
errors=0

printf 'Repository plan for %s (%s mode):\n' "${host_name}" "${mode}"
while IFS= read -r repository_alias; do
  [[ -n ${repository_alias} ]] || continue

  remote_url="$("${jq_bin}" -er --arg repository "${repository_alias}" \
    '.repositories[$repository].remote' "${manifest_path}")"
  relative_path="$("${jq_bin}" -er --arg repository "${repository_alias}" \
    '.repositories[$repository].path' "${manifest_path}")"
  branch="$("${jq_bin}" -er --arg repository "${repository_alias}" \
    '.repositories[$repository].branch' "${manifest_path}")"
  update_policy="$("${jq_bin}" -er --arg repository "${repository_alias}" \
    '.repositories[$repository].update_policy' "${manifest_path}")"
  destination="${repository_root}/${relative_path}"

  if has_symlink_component "${relative_path}"; then
    errors=$((errors + 1))
    printf 'ERROR    %-20s destination contains a symbolic link: %s\n' \
      "${repository_alias}" "${destination}" >&2
    continue
  fi

  if ! "${ffflow_check_bin}" "${remote_url}" "${branch}"; then
    errors=$((errors + 1))
    printf 'UNADOPTED %-20s declared branch is not FFFlow-adopted; left untouched\n' \
      "${repository_alias}" >&2
    continue
  fi

  if [[ ! -e ${destination} ]]; then
    missing=$((missing + 1))
    if [[ ${mode} == plan ]]; then
      printf 'MISSING  %-20s clone %s branch %s -> %s\n' \
        "${repository_alias}" "${remote_url}" "${branch}" "${destination}"
      continue
    fi

    mkdir -p "$(dirname "${destination}")"
    staging_path="${destination}.factory-sync.$$"
    if [[ -e ${staging_path} ]]; then
      errors=$((errors + 1))
      printf 'ERROR    %-20s temporary clone destination already exists: %s\n' \
        "${repository_alias}" "${staging_path}" >&2
      staging_path=''
      continue
    fi
    if ! "${gh_bin}" repo clone "${remote_url}" "${staging_path}" -- \
      --branch "${branch}"; then
      errors=$((errors + 1))
      printf 'ERROR    %-20s clone failed (check the factory user credential and remote branch)\n' \
        "${repository_alias}" >&2
      rm -rf -- "${staging_path}"
      staging_path=''
      continue
    fi
    cloned_origin="$("${git_bin}" -C "${staging_path}" config --get remote.origin.url 2>/dev/null || true)"
    cloned_branch="$("${git_bin}" -C "${staging_path}" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    if ! validate_primary_repository "${staging_path}" \
      || [[ $(normalize_github_remote "${cloned_origin}" 2>/dev/null || true) \
        != $(normalize_github_remote "${remote_url}") ]] \
      || [[ ${cloned_branch} != "${branch}" ]]; then
      errors=$((errors + 1))
      printf 'ERROR    %-20s cloned repository failed remote or branch validation\n' \
        "${repository_alias}" >&2
      rm -rf -- "${staging_path}"
      staging_path=''
      continue
    fi
    if [[ -e ${destination} ]]; then
      errors=$((errors + 1))
      printf 'ERROR    %-20s destination appeared during clone: %s\n' \
        "${repository_alias}" "${destination}" >&2
      rm -rf -- "${staging_path}"
      staging_path=''
      continue
    fi
    if ! mv -n "${staging_path}" "${destination}" \
      || [[ -e ${staging_path} ]]; then
      errors=$((errors + 1))
      printf 'ERROR    %-20s could not publish clone without replacing an existing destination\n' \
        "${repository_alias}" >&2
      rm -rf -- "${staging_path}"
      staging_path=''
      continue
    fi
    staging_path=''
    cloned=$((cloned + 1))
    printf 'CLONED   %-20s %s branch %s -> %s\n' \
      "${repository_alias}" "${remote_url}" "${branch}" "${destination}"
    continue
  fi

  if ! validate_primary_repository "${destination}"; then
    errors=$((errors + 1))
    printf 'ERROR    %-20s %s is not a primary Git repository directory\n' \
      "${repository_alias}" "${destination}" >&2
    continue
  fi

  origin="$("${git_bin}" -C "${destination}" config --get remote.origin.url 2>/dev/null || true)"
  normalized_origin="$(normalize_github_remote "${origin}" 2>/dev/null || true)"
  normalized_expected="$(normalize_github_remote "${remote_url}")"
  if [[ ${normalized_origin} != "${normalized_expected}" ]]; then
    errors=$((errors + 1))
    printf 'ERROR    %-20s origin is %s; expected %s\n' \
      "${repository_alias}" "${origin:-unset}" "${remote_url}" >&2
    continue
  fi

  dirty_status="$("${git_bin}" -C "${destination}" status \
    --porcelain=v1 --untracked-files=all 2>/dev/null || true)"
  if [[ -n ${dirty_status} ]]; then
    errors=$((errors + 1))
    printf 'DIRTY    %-20s local changes present; left untouched: %s\n' \
      "${repository_alias}" "${destination}" >&2
    continue
  fi

  current_branch="$("${git_bin}" -C "${destination}" symbolic-ref \
    --quiet --short HEAD 2>/dev/null || true)"
  if [[ ${current_branch} != "${branch}" ]]; then
    errors=$((errors + 1))
    printf 'BRANCH   %-20s checked out %s; expected %s; left untouched\n' \
      "${repository_alias}" "${current_branch:-detached HEAD}" "${branch}" >&2
    continue
  fi

  if ! probe_repository "${destination}" "${remote_url}" "${branch}" \
    "${repository_alias}"; then
    errors=$((errors + 1))
    printf 'ERROR    %-20s cannot fetch %s branch %s (credential, network, or ref unavailable)\n' \
      "${repository_alias}" "${remote_url}" "${branch}" >&2
    continue
  fi

  probe_directory="${probe_root}/${repository_alias}"
  local_revision="$("${git_bin}" -C "${probe_directory}" rev-parse refs/heads/local)"
  remote_revision="$("${git_bin}" -C "${probe_directory}" \
    rev-parse "refs/remotes/origin/${branch}")"
  if [[ ${local_revision} == "${remote_revision}" ]]; then
    ready=$((ready + 1))
    printf 'READY    %-20s %s at %s\n' \
      "${repository_alias}" "${branch}" "${local_revision}"
    continue
  fi

  if ! "${git_bin}" -C "${probe_directory}" merge-base --is-ancestor \
    "${local_revision}" "${remote_revision}"; then
    errors=$((errors + 1))
    if "${git_bin}" -C "${probe_directory}" merge-base --is-ancestor \
      "${remote_revision}" "${local_revision}"; then
      printf 'AHEAD    %-20s local %s is ahead of origin/%s; left untouched\n' \
        "${repository_alias}" "${branch}" "${branch}" >&2
    else
      printf 'DIVERGED %-20s local %s diverged from origin/%s; left untouched\n' \
        "${repository_alias}" "${branch}" "${branch}" >&2
    fi
    continue
  fi

  planned_updates=$((planned_updates + 1))
  if [[ ${mode} == plan ]]; then
    printf 'UPDATE   %-20s fast-forward %s from %s to %s (%s)\n' \
      "${repository_alias}" "${branch}" "${local_revision}" \
      "${remote_revision}" "${update_policy}"
    continue
  fi

  if [[ $("${git_bin}" -C "${destination}" rev-parse HEAD) != "${local_revision}" \
    || $("${git_bin}" -C "${destination}" symbolic-ref --quiet --short HEAD 2>/dev/null || true) != "${branch}" \
    || -n $("${git_bin}" -C "${destination}" status --porcelain=v1 --untracked-files=all) ]]; then
    errors=$((errors + 1))
    printf 'ERROR    %-20s checkout changed during synchronization; left unmerged\n' \
      "${repository_alias}" >&2
    continue
  fi
  if ! "${git_bin}" -C "${destination}" fetch --quiet --no-tags \
    "${probe_directory}" "${remote_revision}" \
    || ! "${git_bin}" -C "${destination}" merge --quiet --ff-only --no-edit \
      "${remote_revision}"; then
    errors=$((errors + 1))
    printf 'ERROR    %-20s fast-forward failed; inspect the checkout before retrying\n' \
      "${repository_alias}" >&2
    continue
  fi
  updated=$((updated + 1))
  printf 'UPDATED  %-20s fast-forwarded %s from %s to %s\n' \
    "${repository_alias}" "${branch}" "${local_revision}" "${remote_revision}"
done <<<"${repository_aliases}"

printf '\nSummary: %d ready, %d missing, %d update(s), %d cloned, %d updated, %d unresolved.\n' \
  "${ready}" "${missing}" "${planned_updates}" "${cloned}" "${updated}" "${errors}"

if [[ ${json} == true ]]; then
  managed_paths="$(${jq_bin} -r --arg host "${host_name}" '
    . as $manifest
    | .hosts[$host].repository_sets[] as $set
    | $manifest.repository_sets[$set][] as $repository
    | $manifest.repositories[$repository].path
  ' "${manifest_path}" | sort -u)"
  present_paths=''
  while IFS= read -r git_directory; do
    checkout=${git_directory%/.git}
    relative_checkout=${checkout#"${repository_root}"/}
    present_paths+="${relative_checkout}"$'\n'
  done < <(find "${repository_root}" -type d -name .git -print)
  present_paths="$(printf '%s' "${present_paths}" | sort -u)"
  unmanaged_paths="$(comm -13 \
    <(printf '%s\n' "${managed_paths}" | sed '/^$/d') \
    <(printf '%s\n' "${present_paths}" | sed '/^$/d'))"
  state=synchronized
  ((errors == 0)) || state=unresolved
  unmanaged_json="$(printf '%s\n' "${unmanaged_paths}" \
    | "${jq_bin}" -Rsc 'split("\n") | map(select(length > 0))')"
  "${jq_bin}" -n --arg state "${state}" --argjson unmanaged "${unmanaged_json}" \
    '{protocol_version: 1, state: $state, unmanaged: $unmanaged}' >&3
fi

if ((errors > 0)); then
  exit 1
fi
