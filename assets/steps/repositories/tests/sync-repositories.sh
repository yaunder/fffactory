#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sync_script="${script_dir}/../sync-repositories.sh"
test_root="$(mktemp -d)"
cleanup() {
  rm -rf -- "${test_root}"
}
trap cleanup EXIT

fail() {
  printf 'sync-repositories test failed: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file=$1
  local expected=$2
  grep -Fq -- "${expected}" "${file}" \
    || fail "expected '${expected}' in ${file}"
}

commit_file() {
  local checkout=$1
  local content=$2
  printf '%s\n' "${content}" >"${checkout}/content.txt"
  git -C "${checkout}" add content.txt
  git -C "${checkout}" -c user.name='Factory Test' \
    -c user.email='factory@example.com' commit --quiet -m "${content}"
}

create_remote() {
  local name=$1
  local remote="${test_root}/remotes/${name}.git"
  local author="${test_root}/authors/${name}"
  git init --quiet --bare "${remote}"
  git init --quiet --initial-branch=main "${author}"
  commit_file "${author}" initial
  if [[ ${name} != unadopted ]]; then
    mkdir -p "${author}/.ffflow"
    printf 'version: 1\nffflow_version: 0.4.1\nlevel: L1\n' \
      >"${author}/.ffflow/config.yaml"
    git -C "${author}" add .ffflow/config.yaml
    git -C "${author}" -c user.name='Factory Test' \
      -c user.email='factory@example.com' commit --quiet -m 'adopt FFFlow'
  fi
  git -C "${author}" remote add origin "${remote}"
  git -C "${author}" push --quiet -u origin main
  git --git-dir="${remote}" symbolic-ref HEAD refs/heads/main
}

bin_dir="${test_root}/bin"
repository_root="${test_root}/repos"
manifest_path="${test_root}/repositories.json"
mkdir -p "${bin_dir}" "${repository_root}" \
  "${test_root}/remotes" "${test_root}/authors"

create_remote factory
create_remote example
create_remote diverged
create_remote unadopted

cat >"${manifest_path}" <<'JSON'
{
  "version": 2,
  "repositories": {
    "factory": {
      "remote": "https://github.com/yaunder/fffactory.git",
      "path": "factory",
      "branch": "main",
      "update_policy": "fast-forward-only"
    },
    "example": {
      "remote": "https://github.com/yaunder/example.git",
      "path": "services/example",
      "branch": "main",
      "update_policy": "fast-forward-only"
    }
  },
  "repository_sets": {
    "product": ["factory", "example"]
  },
  "hosts": {
    "factory-builder-1": {
      "repository_sets": ["product"]
    }
  }
}
JSON

cat >"${bin_dir}/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ $1 == repo && $2 == clone ]]
remote=$3
destination=$4
shift 5
git clone --quiet "${remote}" "${destination}" "$@"
EOF
chmod 0755 "${bin_dir}/gh"

common_env=(
  FACTORY_REPOSITORY_ROOT="${repository_root}"
  FACTORY_GH_BIN="${bin_dir}/gh"
  GIT_CONFIG_COUNT=5
  GIT_CONFIG_KEY_0="url.file://${test_root}/remotes/factory.git.insteadOf"
  GIT_CONFIG_VALUE_0="https://github.com/yaunder/fffactory.git"
  GIT_CONFIG_KEY_1="url.file://${test_root}/remotes/example.git.insteadOf"
  GIT_CONFIG_VALUE_1="https://github.com/yaunder/example.git"
  GIT_CONFIG_KEY_2="url.file://${test_root}/remotes/diverged.git.insteadOf"
  GIT_CONFIG_VALUE_2="https://github.com/yaunder/diverged.git"
  GIT_CONFIG_KEY_3="url.file://${test_root}/remotes/unavailable.git.insteadOf"
  GIT_CONFIG_VALUE_3="https://github.com/yaunder/unavailable.git"
  GIT_CONFIG_KEY_4="url.file://${test_root}/remotes/unadopted.git.insteadOf"
  GIT_CONFIG_VALUE_4="https://github.com/yaunder/unadopted.git"
)

# A host with an empty repository set and a dispatch declaration: a manifest with nothing
# to synchronize validates and plans nothing. Written here, not committed under assets/,
# because every file there ships in the release bundle.
empty_manifest_path="${test_root}/empty-repositories.json"
cat >"${empty_manifest_path}" <<'JSON'
{
  "version": 2,
  "repositories": {},
  "repository_sets": {
    "core": []
  },
  "hosts": {
    "example-builder-1": {
      "repository_sets": ["core"],
      "dispatch": {
        "enabled": false,
        "cron": "*/15 * * * *",
        "timezone": "UTC",
        "provider": "claude",
        "model": "claude-sonnet-5",
        "mode": "bypassPermissions",
        "cwd": "/home/factory"
      }
    }
  }
}
JSON

mkdir -p "${test_root}/manifest-validation"
env FACTORY_REPOSITORY_ROOT="${test_root}/manifest-validation" \
  FACTORY_GH_BIN="${bin_dir}/gh" \
  FACTORY_FFFLOW_CHECK_BIN="${script_dir}/../check-ffflow-adoption.sh" \
  "${sync_script}" --manifest "${empty_manifest_path}" \
  --host example-builder-1 --plan >"${test_root}/manifest-validation.out"
assert_contains "${test_root}/manifest-validation.out" '0 ready, 0 missing'

git clone --quiet "${test_root}/remotes/factory.git" "${repository_root}/factory"
git -C "${repository_root}/factory" remote set-url origin \
  https://github.com/yaunder/fffactory.git

before_refs="$(git -C "${repository_root}/factory" show-ref)"
env "${common_env[@]}" "${sync_script}" --manifest "${manifest_path}" \
  --host factory-builder-1 --plan >"${test_root}/initial-plan.out"
assert_contains "${test_root}/initial-plan.out" 'READY    factory'
assert_contains "${test_root}/initial-plan.out" 'MISSING  example'
[[ $(git -C "${repository_root}/factory" show-ref) == "${before_refs}" ]] \
  || fail 'plan changed an existing checkout ref'
[[ ! -e ${repository_root}/services/example ]] \
  || fail 'plan cloned a missing repository'

env "${common_env[@]}" "${sync_script}" --manifest "${manifest_path}" \
  --host factory-builder-1 --apply >"${test_root}/initial-apply.out"
assert_contains "${test_root}/initial-apply.out" 'CLONED   example'
[[ -d ${repository_root}/services/example/.git ]]
[[ $(git -C "${repository_root}/services/example" branch --show-current) == main ]]

jq '.repositories.unadopted = {
      remote: "https://github.com/yaunder/unadopted.git",
      path: "unadopted",
      branch: "main",
      update_policy: "fast-forward-only"
    }
    | .repository_sets.product += ["unadopted"]' \
  "${manifest_path}" >"${test_root}/unadopted-manifest.json"
if env "${common_env[@]}" "${sync_script}" \
  --manifest "${test_root}/unadopted-manifest.json" \
  --host factory-builder-1 --apply >"${test_root}/unadopted.out" \
  2>"${test_root}/unadopted.err"; then
  fail 'unadopted repository unexpectedly succeeded'
fi
assert_contains "${test_root}/unadopted.err" 'UNADOPTED unadopted'
[[ ! -e ${repository_root}/unadopted ]] \
  || fail 'unadopted repository was cloned'

mkdir -p "${test_root}/authors/unadopted/.ffflow"
printf 'version: 1\nffflow_version: 0.4.1\nlevel: L9\n' \
  >"${test_root}/authors/unadopted/.ffflow/config.yaml"
git -C "${test_root}/authors/unadopted" add .ffflow/config.yaml
git -C "${test_root}/authors/unadopted" -c user.name='Factory Test' \
  -c user.email='factory@example.com' commit --quiet -m 'invalid FFFlow level'
git -C "${test_root}/authors/unadopted" push --quiet origin main
if env "${common_env[@]}" "${script_dir}/../check-ffflow-adoption.sh" \
  https://github.com/yaunder/unadopted.git main >/dev/null 2>&1; then
  fail 'invalid FFFlow level unexpectedly succeeded'
fi

commit_file "${test_root}/authors/factory" remote-update
git -C "${test_root}/authors/factory" push --quiet origin main
old_revision="$(git -C "${repository_root}/factory" rev-parse HEAD)"
env "${common_env[@]}" "${sync_script}" --manifest "${manifest_path}" \
  --host factory-builder-1 --plan >"${test_root}/update-plan.out"
assert_contains "${test_root}/update-plan.out" 'UPDATE   factory'
[[ $(git -C "${repository_root}/factory" rev-parse HEAD) == "${old_revision}" ]] \
  || fail 'plan advanced the managed branch'
env "${common_env[@]}" "${sync_script}" --manifest "${manifest_path}" \
  --host factory-builder-1 --apply >"${test_root}/update-apply.out"
assert_contains "${test_root}/update-apply.out" 'UPDATED  factory'
[[ $(git -C "${repository_root}/factory" rev-parse HEAD) \
  == $(git -C "${test_root}/authors/factory" rev-parse HEAD) ]] \
  || fail 'apply did not fast-forward to the declared remote branch'

printf 'dirty\n' >>"${repository_root}/factory/content.txt"
set +e
env "${common_env[@]}" "${sync_script}" --manifest "${manifest_path}" \
  --host factory-builder-1 --plan >"${test_root}/dirty.out" \
  2>"${test_root}/dirty.err"
dirty_status=$?
set -e
((dirty_status != 0)) || fail 'dirty checkout unexpectedly succeeded'
assert_contains "${test_root}/dirty.err" 'DIRTY    factory'
git -C "${repository_root}/factory" restore content.txt

git clone --quiet "${test_root}/remotes/diverged.git" \
  "${repository_root}/diverged"
git -C "${repository_root}/diverged" remote set-url origin \
  https://github.com/yaunder/diverged.git
commit_file "${repository_root}/diverged" local-change
commit_file "${test_root}/authors/diverged" remote-change
git -C "${test_root}/authors/diverged" push --quiet origin main
diverged_revision="$(git -C "${repository_root}/diverged" rev-parse HEAD)"
jq '.repositories.diverged = {
      remote: "https://github.com/yaunder/diverged.git",
      path: "diverged",
      branch: "main",
      update_policy: "fast-forward-only"
    }
    | .repository_sets.product += ["diverged"]' \
  "${manifest_path}" >"${test_root}/diverged-manifest.json"
set +e
env "${common_env[@]}" "${sync_script}" \
  --manifest "${test_root}/diverged-manifest.json" \
  --host factory-builder-1 --apply >"${test_root}/diverged.out" \
  2>"${test_root}/diverged.err"
diverged_status=$?
set -e
((diverged_status != 0)) || fail 'diverged checkout unexpectedly succeeded'
assert_contains "${test_root}/diverged.err" 'DIVERGED diverged'
[[ $(git -C "${repository_root}/diverged" rev-parse HEAD) == "${diverged_revision}" ]] \
  || fail 'diverged checkout was changed'

git init --quiet --initial-branch=main "${repository_root}/unavailable"
commit_file "${repository_root}/unavailable" local-only
git -C "${repository_root}/unavailable" remote add origin \
  https://github.com/yaunder/unavailable.git
unavailable_revision="$(git -C "${repository_root}/unavailable" rev-parse HEAD)"
jq '.repositories.unavailable = {
      remote: "https://github.com/yaunder/unavailable.git",
      path: "unavailable",
      branch: "main",
      update_policy: "fast-forward-only"
    }
    | .repository_sets.product += ["unavailable"]' \
  "${manifest_path}" >"${test_root}/unavailable-manifest.json"
set +e
env "${common_env[@]}" "${sync_script}" \
  --manifest "${test_root}/unavailable-manifest.json" \
  --host factory-builder-1 --plan >"${test_root}/unavailable.out" \
  2>"${test_root}/unavailable.err"
unavailable_status=$?
set -e
((unavailable_status != 0)) || fail 'unavailable remote unexpectedly succeeded'
assert_contains "${test_root}/unavailable.err" 'cannot fetch'
[[ $(git -C "${repository_root}/unavailable" rev-parse HEAD) == "${unavailable_revision}" ]] \
  || fail 'checkout with an unavailable remote was changed'

mkdir -p "${repository_root}/removed/.git"
env "${common_env[@]}" "${sync_script}" --manifest "${manifest_path}" \
  --host factory-builder-1 --plan --json >"${test_root}/repositories-report.json"
[[ -d ${repository_root}/removed/.git ]] \
  || fail 'an undeclared checkout was deleted'
jq -e '. == {
  protocol_version: 1,
  state: "synchronized",
  unmanaged: ["diverged", "removed", "unavailable"]
}' "${test_root}/repositories-report.json" >/dev/null \
  || fail "repository JSON report is wrong: $(cat "${test_root}/repositories-report.json")"

git -C "${repository_root}/factory" remote set-url origin \
  https://github.com/someone-else/factory.git
set +e
env "${common_env[@]}" "${sync_script}" --manifest "${manifest_path}" \
  --host factory-builder-1 --plan >/dev/null 2>"${test_root}/remote.err"
remote_status=$?
set -e
((remote_status != 0)) || fail 'remote mismatch unexpectedly succeeded'
assert_contains "${test_root}/remote.err" 'origin is https://github.com/someone-else/factory.git'

if env "${common_env[@]}" "${sync_script}" --manifest "${manifest_path}" \
  --host unknown-host --plan >/dev/null 2>&1; then
  fail 'unknown host unexpectedly succeeded'
fi

jq '.version = 1' "${manifest_path}" >"${test_root}/invalid-manifest.json"
if env "${common_env[@]}" "${sync_script}" \
  --manifest "${test_root}/invalid-manifest.json" \
  --host factory-builder-1 --plan >/dev/null 2>&1; then
  fail 'invalid manifest unexpectedly succeeded'
fi

git -C "${test_root}/authors/example" rm --quiet .ffflow/config.yaml
git -C "${test_root}/authors/example" -c user.name='Factory Test' \
  -c user.email='factory@example.com' commit --quiet -m 'remove FFFlow adoption'
git -C "${test_root}/authors/example" push --quiet origin main
before_drift="$(git -C "${repository_root}/services/example" rev-parse HEAD)"
if env "${common_env[@]}" "${sync_script}" --manifest "${manifest_path}" \
  --host factory-builder-1 --apply >"${test_root}/drift.out" \
  2>"${test_root}/drift.err"; then
  fail 'removed FFFlow adoption unexpectedly succeeded'
fi
assert_contains "${test_root}/drift.err" 'UNADOPTED example'
[[ $(git -C "${repository_root}/services/example" rev-parse HEAD) == "${before_drift}" ]] \
  || fail 'unadopted checkout was updated'

printf 'sync-repositories tests passed\n'
