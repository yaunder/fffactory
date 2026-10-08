#!/usr/bin/env bash
# Checks a release tag against package.json and assembles the GitHub Release assets. The
# release workflow (.github/workflows/release.yml) runs both steps; nothing else publishes.
#
#   scripts/assemble-release.sh check-tag TAG
#       Exits 0 when TAG is `v` followed by package.json's version, printing
#       `version=VERSION` and `prerelease=true|false` for $GITHUB_OUTPUT.
#   scripts/assemble-release.sh check-source TAG
#       Requires TAG to name HEAD and HEAD to be reachable from fetched origin/main.
#   scripts/assemble-release.sh assemble TAG ARTIFACTS OUT
#       Checks TAG, then writes the release assets into the new directory OUT and prints
#       their paths: fffactory-darwin-arm64 and fffactory-linux-x64 from ARTIFACTS (the
#       downloaded workflow artifacts; the darwin one already signed), install.sh, and
#       SHA256SUMS over the two executables exactly as published.
#
# Spec: docs/specs/release.md §Distribution.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
readonly root
readonly EXECUTABLES=(fffactory-darwin-arm64 fffactory-linux-x64)
readonly RELEASE_VERSION='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

usage() {
  echo "Usage: $0 check-tag TAG | check-source TAG | assemble TAG ARTIFACTS OUT" >&2
  exit 2
}

fail() {
  echo "assemble-release: $*" >&2
  exit 1
}

# package.json's top-level "version", which Biome formats on its own two-space-indented line.
package_version() {
  local version
  version="$(sed -n 's/^  "version": "\([^"]*\)",\{0,1\}$/\1/p' "$root/package.json")"
  [[ $version =~ $RELEASE_VERSION ]] || fail "package.json has no release version"
  echo "$version"
}

check_tag() {
  local tag="$1" version
  version="$(package_version)"
  [[ $tag == "v$version" ]] ||
    fail "Tag '$tag' does not match package.json version $version; release it with tag v$version"
  echo "$version"
}

check_source() {
  local tag="$1" commit head main
  check_tag "$tag" >/dev/null
  commit="$(git -C "$root" rev-parse --verify "refs/tags/$tag^{commit}" 2>/dev/null)" ||
    fail "Tag '$tag' has no commit; fetch the release tag"
  head="$(git -C "$root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" ||
    fail "HEAD has no commit"
  [[ $commit == "$head" ]] || fail "Tag '$tag' does not match checked-out HEAD"
  main="$(git -C "$root" rev-parse --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null)" ||
    fail "origin/main is missing; fetch full history before checking a release"
  git -C "$root" merge-base --is-ancestor "$commit" "$main" ||
    fail "Tag '$tag' is not reachable from origin/main; merge the release before tagging"
}

# The hex of LENGTH bytes of FILE from OFFSET.
bytes() {
  od -An -tx1 -j "$2" -N "$3" "$1" | tr -d ' \n'
}

check_executables() {
  local artifacts="$1" name
  for name in "${EXECUTABLES[@]}"; do
    [[ -f $artifacts/$name && -s $artifacts/$name ]] || fail "$artifacts/$name is missing"
  done
  # Guards against publishing a swapped or wrong-architecture artifact.
  [[ "$(bytes "$artifacts/fffactory-darwin-arm64" 0 8)" == cffaedfe0c000001 ]] ||
    fail "fffactory-darwin-arm64 is not an arm64 Mach-O executable"
  [[ "$(bytes "$artifacts/fffactory-linux-x64" 0 5)$(bytes "$artifacts/fffactory-linux-x64" 18 2)" == 7f454c46023e00 ]] ||
    fail "fffactory-linux-x64 is not an x86-64 ELF executable"
}

sha256sums() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

assemble() {
  local tag="$1" artifacts="$2" out="$3" name
  check_tag "$tag" >/dev/null
  [[ ! -e $out ]] || fail "$out already exists"
  check_executables "$artifacts"
  mkdir -p "$out"
  out="$(cd "$out" && pwd)"
  for name in "${EXECUTABLES[@]}"; do
    cp "$artifacts/$name" "$out/$name"
    chmod 0755 "$out/$name"
  done
  cp "$root/install.sh" "$out/install.sh"
  chmod 0755 "$out/install.sh"
  (cd "$out" && sha256sums "${EXECUTABLES[@]}" >SHA256SUMS)
  chmod 0644 "$out/SHA256SUMS"
  for name in SHA256SUMS "${EXECUTABLES[@]}" install.sh; do echo "$out/$name"; done
}

case "${1:-}" in
check-source)
  [[ $# -eq 2 ]] || usage
  check_source "$2"
  ;;
check-tag)
  [[ $# -eq 2 ]] || usage
  version="$(check_tag "$2")"
  echo "version=$version"
  [[ $version == *-* ]] && echo "prerelease=true" || echo "prerelease=false"
  ;;
assemble)
  [[ $# -eq 4 ]] || usage
  assemble "$2" "$3" "$4"
  ;;
*) usage ;;
esac
