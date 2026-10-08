#!/usr/bin/env bash
# Runs the worker bootstrap tests, tests/bootstrap/*.test.sh, in Amazon Linux 2023 containers:
#
#   scripts/bootstrap-test.sh [CASE...]      # every test_* case, or only the named ones
#
# The image is amazonlinux:2023, pinned, plus the packages the AL2023 AMI has and its
# container image lacks; building it needs the network, the tests do not. Each case runs as
# root in its own fresh container with no network, with the checkout's
# assets/terraform/bootstrap read-only at /bootstrap, tests/bootstrap at /tests, and at
# /fixtures what tests/support/bootstrap-fixtures-main.ts renders: the user data and a packed
# release bundle. Needs Docker and Bun. Spec: docs/specs/worker-bootstrap.md.
set -euo pipefail

# amazonlinux:2023, pinned.
readonly BASE="amazonlinux@sha256:5b29412077a463b4a3a8fbc99a8cdf4b929f38a3ecc8dac10328d8f36b0099b8"
# On the AL2023 AMI, not in its container image: tar and gzip, flock and runuser
# (util-linux), useradd (shadow-utils), sudo and visudo, find, and cmp (diffutils).
readonly PACKAGES="tar gzip util-linux shadow-utils sudo findutils diffutils"
readonly IMAGE="fffactory-bootstrap-test:al2023"

fail() {
  echo "bootstrap test: $*" >&2
  exit 1
}

command -v docker >/dev/null || fail "docker is required"
command -v bun >/dev/null || fail "bun is required"

root="$(cd "$(dirname "$0")/.." && pwd)"
fixtures="$(mktemp -d)"
trap 'rm -rf "$fixtures"' EXIT
chmod 0755 "$fixtures"
bun "$root/tests/support/bootstrap-fixtures-main.ts" "$fixtures"

docker build --quiet --tag "$IMAGE" - >/dev/null <<DOCKERFILE
FROM $BASE
RUN dnf install -y --setopt=install_weak_deps=False $PACKAGES && dnf clean all
DOCKERFILE

selected() {
  local wanted
  [[ $# -eq 1 ]] && return 0
  for wanted in "${@:2}"; do
    [[ "$wanted" == "$1" ]] && return 0
  done
  return 1
}

ran=0
failed=0
for file in "$root"/tests/bootstrap/*.test.sh; do
  cases="$(grep -oE '^test_[A-Za-z0-9_]+' "$file")"
  for case in $cases; do
    selected "$case" "$@" || continue
    ran=$((ran + 1))
    if ! docker run --rm --network none --hostname fff-aaaa1111-builder-1 \
      --volume "$root/assets/terraform/bootstrap:/bootstrap:ro" \
      --volume "$root/tests/bootstrap:/tests:ro" \
      --volume "$fixtures:/fixtures:ro" \
      "$IMAGE" /tests/run-case.sh "/tests/$(basename "$file")" "$case" </dev/null; then
      failed=$((failed + 1))
    fi
  done
done

[[ "$ran" -gt 0 ]] || fail "no test case matched"
[[ "$failed" -eq 0 ]] || fail "$failed of $ran cases failed"
echo "bootstrap tests: $ran cases passed"
