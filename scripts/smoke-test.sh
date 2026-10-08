#!/usr/bin/env bash
# Smoke-tests a packaged fffactory executable where there is no checkout, Bun or Node.
#
#   scripts/smoke-test.sh BINARY                  # linux-x64: in a clean container (Docker)
#   scripts/smoke-test.sh --no-container BINARY   # the host's own binary, e.g. on macOS
#
# From an empty directory it runs `--version`, `init`, `assets` twice and `doctor --json`,
# then checks the results on the host with jq. In the container it also runs a copy of
# BINARY whose embedded bundle has one byte flipped, which must refuse to materialize,
# `host inspect --json`, the worker side of the host protocol, on a machine that is no worker,
# and the worker executable the bundle carries as `bin/fffactory`.
# The bundle is BINARY's sibling fffactory-assets.tar.gz, as scripts/build.ts writes it.
#
# AWS is sealed off: no AWS variables, empty config and credentials files, instance
# metadata disabled and every endpoint a closed local port; the container has no network.
set -euo pipefail

# debian:stable-slim, pinned: glibc, bash, perl and tar, but no Bun, Node, ssh or tailscale.
readonly IMAGE="debian@sha256:5bc3287b25407c965a30f38e32603dc253a3869e1b12a21ac09bfc27fd8b13ce"
readonly TAMPER_MESSAGE="do not match their recorded SHA-256 digest"

# Runs inside the clean environment. Records each command's output and exit code in $1.
inside() {
  local out="$1" fffactory="$2" tampered="${3:-}"
  local work
  work="$(mktemp -d)"
  mkdir -p "$HOME" "$(dirname "$AWS_CONFIG_FILE")"
  : >"$AWS_CONFIG_FILE"
  : >"$AWS_SHARED_CREDENTIALS_FILE"
  cd "$work"
  record() {
    local name="$1"
    shift
    set +e
    "$@" >"$out/$name.out" 2>"$out/$name.err"
    echo "$?" >"$out/$name.code"
    set -e
  }
  { command -v bun node || true; } >"$out/runtimes"
  record version "$fffactory" --version
  record init "$fffactory" init
  record assets-first "$fffactory" assets
  if [[ "$(cat "$out/assets-first.code")" == 0 ]]; then
    # Edit the materialized copy: a rerun that re-extracted would undo the edit.
    local assets
    assets="$(cat "$out/assets-first.out")"
    cp "$assets/release.json" "$out/release.json"
    echo edited >>"$assets/release.json"
    record assets-rerun "$fffactory" assets
    tail -n 1 "$assets/release.json" >"$out/rerun-kept"
  fi
  record doctor "$fffactory" doctor --json
  if [[ -n "$tampered" ]]; then
    record host-inspect "$fffactory" host inspect --json
    record worker-version "$(cat "$out/assets-first.out")/bin/fffactory" --version
    XDG_CACHE_HOME="$work/tampered-cache" record tampered "$tampered" assets
    [[ -e "$work/tampered-cache" ]] && echo present >"$out/tampered-cache" || echo absent >"$out/tampered-cache"
  fi
}

if [[ "${1:-}" == "--inside" ]]; then
  shift
  inside "$@"
  exit 0
fi

fail() {
  echo "smoke test failed: $*" >&2
  exit 1
}

container=true
if [[ "${1:-}" == "--no-container" ]]; then
  container=false
  shift
fi
[[ $# -eq 1 ]] || fail "usage: $0 [--no-container] BINARY"
binary="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
bundle="$(dirname "$binary")/fffactory-assets.tar.gz"
[[ -x "$binary" ]] || fail "$binary is not an executable"
[[ -f "$bundle" ]] || fail "$bundle is missing; build with scripts/build.ts"
command -v jq >/dev/null || fail "jq is required"

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(jq -r .version "$root/package.json")"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
out="$scratch/out"
mkdir -p "$out"
docker_env=()
SEALED_AWS=(
  AWS_EC2_METADATA_DISABLED=true
  AWS_EC2_METADATA_SERVICE_ENDPOINT=http://127.0.0.1:1
  AWS_ENDPOINT_URL=http://127.0.0.1:1
)

if $container; then
  # A copy whose embedded bundle has one byte flipped; the rest of the executable is intact.
  perl -e '
    local $/; open(my $b, "<:raw", $ARGV[0]) or die; my $bin = <$b>;
    open(my $t, "<:raw", $ARGV[1]) or die; my $tar = <$t>;
    my $at = index($bin, $tar); die "bundle not found in executable\n" if $at < 0;
    $at += int(length($tar) / 2);
    substr($bin, $at, 1) = chr(ord(substr($bin, $at, 1)) ^ 1);
    open(my $o, ">:raw", $ARGV[2]) or die; print $o $bin;
  ' "$binary" "$bundle" "$scratch/fffactory-tampered"
  chmod +x "$scratch/fffactory-tampered"
  environment=(HOME=/tmp/home XDG_CACHE_HOME=/tmp/cache
    AWS_CONFIG_FILE=/tmp/aws/config AWS_SHARED_CREDENTIALS_FILE=/tmp/aws/credentials
    "${SEALED_AWS[@]}")
  for variable in "${environment[@]}"; do docker_env+=(-e "$variable"); done
  docker run --rm --network none --user "$(id -u):$(id -g)" \
    --read-only --tmpfs /tmp:exec \
    -v "$binary:/usr/local/bin/fffactory:ro" \
    -v "$scratch/fffactory-tampered:/usr/local/bin/fffactory-tampered:ro" \
    -v "$root/scripts/smoke-test.sh:/smoke-test.sh:ro" \
    -v "$out:/out" \
    "${docker_env[@]}" \
    "$IMAGE" bash /smoke-test.sh --inside /out fffactory fffactory-tampered
  cache=/tmp/cache
else
  cache="$scratch/cache"
  env -i PATH=/usr/bin:/bin HOME="$scratch/home" XDG_CACHE_HOME="$cache" \
    AWS_CONFIG_FILE="$scratch/aws/config" AWS_SHARED_CREDENTIALS_FILE="$scratch/aws/credentials" \
    "${SEALED_AWS[@]}" \
    bash "$root/scripts/smoke-test.sh" --inside "$out" "$binary"
fi

expect_code() {
  [[ "$(cat "$out/$1.code")" == "$2" ]] ||
    fail "$1 exited $(cat "$out/$1.code"), expected $2: $(cat "$out/$1.err")"
}

if $container; then
  [[ ! -s "$out/runtimes" ]] || fail "the container has a JavaScript runtime: $(cat "$out/runtimes")"
fi

expect_code version 0
[[ "$(cat "$out/version.out")" == "$version" ]] || fail "--version printed $(cat "$out/version.out")"

expect_code init 0
grep -q '^Created ' "$out/init.out" || fail "init did not create an instance: $(cat "$out/init.out")"

directory="$cache/fffactory/releases/$version"
expect_code assets-first 0
expect_code assets-rerun 0
[[ "$(cat "$out/assets-first.out")" == "$directory" ]] || fail "assets printed $(cat "$out/assets-first.out")"
[[ "$(cat "$out/assets-rerun.out")" == "$directory" ]] || fail "the assets rerun printed another directory"
[[ "$(jq -r .release "$out/release.json")" == "$version" ]] || fail "materialized release.json is wrong"
[[ "$(cat "$out/rerun-kept")" == edited ]] || fail "rerunning assets re-extracted instead of doing nothing"

# ssh, tailscale and AWS credentials are missing, so doctor is not ready: it exits 2. With no
# account match, vpc_quota is not inspected.
expect_code doctor 2
doctor="$out/doctor.out"
jq -e --arg version "$version" '.schema_version == 1 and .release == $version' "$doctor" >/dev/null ||
  fail "doctor --json has the wrong schema version or release"
status() { jq -r --arg id "$1" '.capabilities[].checks[] | select(.id == $id) | .status' "$doctor"; }
expected=(instance=not_ready aws_account=not_ready vpc_quota=not_ready cache_directory=ready release_assets=ready terraform=ready)
if $container; then expected+=(openssh=not_ready tailscale=not_ready); fi
for pair in "${expected[@]}"; do
  [[ "$(status "${pair%=*}")" == "${pair#*=}" ]] || fail "doctor check ${pair%=*} is $(status "${pair%=*}")"
done
jq -e '.capabilities[].checks[] | select(.id == "release_assets") | .summary | test("are materialized at")' \
  "$doctor" >/dev/null || fail "doctor does not report the materialized assets"

if $container; then
  expect_code tampered 1
  grep -q "$TAMPER_MESSAGE" "$out/tampered.err" || fail "tampered bundle: $(cat "$out/tampered.err")"
  [[ "$(cat "$out/tampered-cache")" == absent ]] || fail "a tampered bundle wrote into the cache"
  # No release, configuration or bootstrap here, and no systemd: the explicit empty state.
  expect_code host-inspect 0
  jq -e '.protocol_version == 1 and .release.state == "none" and .configuration.state == "none"
    and .evidence.bootstrap_complete == false and .evidence.architecture == "x86_64"
    and .evidence.os.id == "debian" and (.evidence.available_bytes | type) == "number"
    and .installation.state == "none"
    and .services == [{"name": "tailscaled", "state": "unknown"}]' "$out/host-inspect.out" \
    >/dev/null || fail "host inspect --json: $(cat "$out/host-inspect.out" "$out/host-inspect.err")"
  # The bundle carries the worker executable, the same release, runnable with no Bun either.
  expect_code worker-version 0
  [[ "$(cat "$out/worker-version.out")" == "$version" ]] ||
    fail "the bundled worker executable reports $(cat "$out/worker-version.out")"
fi

echo "smoke test passed: fffactory $version ($([[ $container == true ]] && echo "clean container" || echo "host"))"
