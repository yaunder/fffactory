# Assertions and helpers for the worker bootstrap container tests (docs/specs/worker-bootstrap.md).
# Sourced by run-case.sh inside a disposable Amazon Linux 2023 container, as root.
# shellcheck shell=bash

fail() {
  printf 'FAIL %s: %s\n' "$CASE" "$*" >&2
  exit 1
}

# run CMD...: runs CMD with standard input from $STDIN (default /dev/null), keeping its
# status in $STATUS and its output in $OUT and $ERR (files).
run() {
  set +e
  "$@" <"${STDIN:-/dev/null}" >"$OUT" 2>"$ERR"
  STATUS=$?
  set -e
}

assert_status() {
  [[ "$STATUS" == "$1" ]] || fail "expected exit $1, got $STATUS; stderr: $(cat "$ERR")"
}

assert_eq() {
  [[ "$1" == "$2" ]] || fail "${3:-values differ}: expected [$2], got [$1]"
}

assert_contains() {
  [[ "$1" == *"$2"* ]] || fail "${3:-text} does not contain [$2]: [$1]"
}

assert_not_contains() {
  [[ "$1" != *"$2"* ]] || fail "${3:-text} contains [$2]: [$1]"
}

assert_absent() {
  [[ ! -e "$1" && ! -L "$1" ]] || fail "$1 exists"
}

# assert_mode PATH MODE OWNER: octal mode and owner:group of PATH.
assert_mode() {
  assert_eq "$(stat -c '%a %U:%G' "$1")" "$2 $3" "mode and owner of $1"
}

digest_of() {
  local line
  line="$(sha256sum "$1")"
  printf '%s\n' "${line%% *}"
}

# pack DIR OUT: a release-shaped bundle of DIR, as the fffactory packer makes one: gzipped
# ustar, regular files only, sorted, owner 0.
pack() {
  (cd "$1" && find . -type f -printf '%P\n' | LC_ALL=C sort |
    tar --format=ustar --owner=0 --group=0 --numeric-owner --no-recursion -czf "$2" -T -)
}

# stub_release DIR VERSION: a release tree whose bin/fffactory records how it ran and, on a
# successful `host apply`, makes itself current as the real worker executable does.
stub_release() {
  local dir="$1" version="$2"
  mkdir -p "$dir/bin" "$dir/terraform"
  printf '{\n  "release": "%s"\n}\n' "$version" >"$dir/release.json"
  cat >"$dir/bin/fffactory" <<'STUB'
#!/bin/bash
set -euo pipefail
{
  printf 'args=%s\n' "$*"
  printf 'uid=%s\n' "$(id -u)"
  printf 'cwd=%s\n' "$PWD"
  printf 'self=%s\n' "$0"
  env | LC_ALL=C sort | sed 's/^/env:/'
} >>/tmp/host-apply.record
cat >/tmp/host-apply.stdin
status="$(cat /tmp/host-apply.exit 2>/dev/null || echo 0)"
if [[ "$*" == "host apply" && "$status" == 0 ]]; then
  version="${0%/bin/fffactory}"
  version="${version##*/}"
  current=/opt/fffactory/current
  temporary="${current}.$$.tmp"
  trap 'rm -f -- "$temporary"' EXIT
  ln -s "releases/$version" "$temporary"
  mv -Tf -- "$temporary" "$current"
  trap - EXIT
fi
printf '{"host_apply":"ran"}\n'
exit "$status"
STUB
  printf 'terraform {}\n' >"$dir/terraform/main.tf"
  chmod 0755 "$dir/bin/fffactory"
  chmod 0644 "$dir/release.json" "$dir/terraform/main.tf"
}
