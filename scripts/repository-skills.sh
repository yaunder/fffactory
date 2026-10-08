#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  printf 'repository skill test failed: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file=$1
  local expected=$2
  grep -Fq -- "${expected}" "${file}" \
    || fail "expected '${expected}' in ${file}"
}

# The dispatch skill, program and schedule reconciler, shipped in the release assets.
dispatch_assets="${repository_root}/assets/steps/dispatch"
dispatch_skill="${dispatch_assets}/skill/SKILL.md"

# Removed with v1's infrastructure and host CLIs (#102): their directories must stay gone,
# and AGENTS.md's routing table must say they were removed.
removed_skills=(
  deploy-factory-infrastructure
  operate-factory-host
)

# Repository conformance covers source-controlled content present in the working tree: that
# is what this change and a clean CI checkout contain. Untracked skill installations are
# outside the repository's declared artifact set and neither satisfy nor invalidate this gate.
tracked_checkout_skill_files="$(
  git -C "${repository_root}" ls-files -- .agents/skills .claude/skills \
    | while IFS= read -r tracked_file; do
        if [[ -e ${repository_root}/${tracked_file} || -L ${repository_root}/${tracked_file} ]]; then
          printf '%s\n' "${tracked_file}"
        fi
      done \
    | paste -sd ' ' -
)"
[[ -z ${tracked_checkout_skill_files} ]] \
  || fail "unexpected checkout-local skill files tracked in git: ${tracked_checkout_skill_files}"

# The dispatch skill ships in the release assets, not as a canonical repo skill. Verify it
# and its programs where they now live, so the gate still proves they are present and sound.
[[ -f ${dispatch_skill} ]] || fail "shipped dispatch skill is missing: ${dispatch_skill}"
[[ $(sed -n '1p' "${dispatch_skill}") == '---' ]] \
  || fail 'shipped dispatch skill frontmatter does not start on line 1'
[[ $(sed -n '2p' "${dispatch_skill}") == 'name: dispatch' ]] \
  || fail 'shipped dispatch skill must be named dispatch'
assert_contains "${dispatch_skill}" 'never merges, force-pushes'
assert_contains "${dispatch_skill}" '/usr/local/bin/factory-dispatch'
[[ -x ${dispatch_assets}/factory-dispatch ]] \
  || fail 'shipped dispatch program is missing or not executable'
[[ -x ${dispatch_assets}/dispatch-schedule.sh ]] \
  || fail 'shipped dispatch schedule reconciler is missing or not executable'
# AGENTS.md must not leave a dangling link to the relocated dispatch skill.
if grep -Fq '.agents/skills/dispatch/' "${repository_root}/AGENTS.md"; then
  fail 'AGENTS.md still links the relocated dispatch skill under .agents/skills/'
fi
assert_contains "${repository_root}/AGENTS.md" 'assets/steps/dispatch'

if grep -Fq 'propose-factory-change' "${repository_root}/AGENTS.md"; then
  fail 'AGENTS.md still routes through the premature propose-factory-change skill'
fi
for skill in "${removed_skills[@]}"; do
  assert_contains "${repository_root}/AGENTS.md" "\`${skill}\` (removed)"
  if grep -Fq ".agents/skills/${skill}/" "${repository_root}/AGENTS.md"; then
    fail "AGENTS.md links the removed skill ${skill}"
  fi
done

printf 'repository skill tests passed\n'
