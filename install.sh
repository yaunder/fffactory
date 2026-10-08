#!/bin/sh
# Installs the fffactory executable from a GitHub Release of yaunder/fffactory.
#
#   gh release download --repo yaunder/fffactory --pattern install.sh --output - | sh
#
# Spec: docs/specs/release.md §Distribution. POSIX sh: `curl | sh` runs dash on Debian and
# Ubuntu and bash 3.2 on macOS. Everything runs from `main` at the end, so a truncated
# download executes nothing.
set -eu

REPOSITORY=yaunder/fffactory
PLATFORMS="darwin-arm64 and linux-x64"

usage() {
  cat <<'EOF'
Usage: install.sh

Installs fffactory from a GitHub Release of yaunder/fffactory, verified against the
release's SHA256SUMS. Takes no arguments; set these variables instead:

  FFFACTORY_VERSION      Release to install, such as 0.0.2 (default: the latest release)
  FFFACTORY_INSTALL_DIR  Absolute directory to install into (default: ~/.local/bin)
  GITHUB_TOKEN           Token for GitHub while the repository is private; without it,
                         install.sh uses `gh auth token`, and otherwise downloads anonymously
  FFFACTORY_GITHUB_API   GitHub API base URL (default: https://api.github.com); install.sh
                         sends the token to the host it names
EOF
}

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

# The release platform name for this machine, or a refusal naming it.
detect_platform() {
  detect_os=$(uname -s)
  detect_arch=$(uname -m)
  case "$detect_os/$detect_arch" in
  Darwin/arm64) platform=darwin-arm64 ;;
  Darwin/x86_64)
    # A shell under Rosetta on Apple Silicon reports x86_64.
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
      platform=darwin-arm64
    else
      unsupported darwin-x64
    fi
    ;;
  Linux/x86_64 | Linux/amd64) platform=linux-x64 ;;
  Linux/aarch64 | Linux/arm64) unsupported linux-arm64 ;;
  *) unsupported "$(printf '%s-%s' "$detect_os" "$detect_arch" | tr '[:upper:]' '[:lower:]')" ;;
  esac
}

unsupported() {
  fail "fffactory has no executable for $1; releases support $PLATFORMS"
}

check_tools() {
  command -v curl >/dev/null 2>&1 || fail "install.sh needs curl to download the release"
  if command -v sha256sum >/dev/null 2>&1; then
    digest_tool=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    digest_tool=shasum
  else
    fail "install.sh needs sha256sum or shasum to verify the download"
  fi
}

sha256_of() {
  if [ "$digest_tool" = sha256sum ]; then
    sha256_line=$(sha256sum <"$1")
  else
    sha256_line=$(shasum -a 256 <"$1")
  fi
  printf '%s\n' "${sha256_line%% *}"
}

# The release tag to request: `latest`, or `v` and a validated FFFACTORY_VERSION.
select_release() {
  requested=${FFFACTORY_VERSION:-latest}
  if [ "$requested" = latest ]; then
    release_label=latest
    release_path=releases/latest
    return
  fi
  requested=${requested#v}
  case "$requested" in
  *[!0-9A-Za-z.-]* | *..*) fail "FFFACTORY_VERSION must be a release version like 1.2.3" ;;
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "FFFACTORY_VERSION must be a release version like 1.2.3" ;;
  esac
  release_label=v$requested
  release_path=releases/tags/v$requested
}

select_install_dir() {
  install_dir=${FFFACTORY_INSTALL_DIR:-}
  if [ -z "$install_dir" ]; then
    [ -n "${HOME:-}" ] || fail "HOME is not set; set FFFACTORY_INSTALL_DIR"
    install_dir=$HOME/.local/bin
  fi
  case "$install_dir" in
  /*) ;;
  *) fail "FFFACTORY_INSTALL_DIR must be an absolute path" ;;
  esac
  install_target=$install_dir/fffactory
  [ ! -d "$install_target" ] || fail "$install_target is a directory"
}

# GITHUB_TOKEN, else `gh auth token`, else none. The token never reaches output or a
# command line: curl reads it from its standard input.
select_credentials() {
  token=""
  credentials=""
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    token=$GITHUB_TOKEN
    credentials=GITHUB_TOKEN
  elif command -v gh >/dev/null 2>&1 &&
    token=$(gh auth token --hostname github.com 2>/dev/null </dev/null) && [ -n "$token" ]; then
    credentials="gh auth token"
  else
    token=""
  fi
  case "$token" in
  *[!A-Za-z0-9_.-]*) fail "$credentials does not look like a GitHub token" ;;
  esac
}

# Writes curl's configuration: the headers, and HTTPS only when the API is HTTPS.
curl_config() {
  printf 'header = "Accept: %s"\n' "$1"
  printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
  if [ -n "$token" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$token"
  fi
  case "$api" in
  https://*) printf 'proto = "=https"\nproto-redir = "=https"\n' ;;
  esac
}

# fetch URL ACCEPT OUTPUT: downloads URL into OUTPUT and sets `status` to the HTTP status.
# curl drops the Authorization header when a redirect leaves the API host. `-q` must come
# first: it stops curl reading ~/.curlrc, where `verbose` would print the token and
# `location-trusted` would send it past the redirect.
fetch() {
  status=$(curl_config "$2" | curl -q --config - --silent --show-error --location \
    --connect-timeout 15 --max-time 600 --retry 2 \
    --user-agent fffactory-install --output "$3" --write-out '%{http_code}' "$1") ||
    fail "Could not download $1"
}

refused_credentials() {
  if [ -n "$token" ]; then
    fail "GitHub refused the credentials from $credentials (HTTP $status)"
  fi
  fail "GitHub refused the request (HTTP $status)"
}

fetch_release() {
  fetch "$api/repos/$REPOSITORY/$release_path" application/vnd.github+json "$work/release.json"
  case "$status" in
  200) ;;
  401) refused_credentials ;;
  404)
    if [ -n "$token" ]; then
      fail "No release $release_label in $REPOSITORY that the credentials from $credentials can read"
    fi
    fail "No release $release_label in $REPOSITORY. While the repository is private, sign in with \`gh auth login\` or set GITHUB_TOKEN."
    ;;
  *) fail "GitHub answered HTTP $status for release $release_label" ;;
  esac
}

# Prints `PATH<TAB>VALUE` for every scalar in the JSON document on standard input, where
# PATH is its location such as /assets/0/name. String values keep their escapes.
json_scalars() {
  awk '
    function path(   p, d) {
      p = ""
      for (d = 1; d <= depth; d++) p = p "/" (kind[d] == "o" ? key[d] : index_[d])
      return p
    }
    function scalar(value) {
      if (depth > 0 && kind[depth] == "o" && want_key[depth]) { key[depth] = value; return }
      print path() "\t" value
    }
    function flush() {
      if (bare != "") { scalar(bare); bare = "" }
    }
    {
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (in_string) {
          if (escaped) { text = text c; escaped = 0 }
          else if (c == "\\") { text = text c; escaped = 1 }
          else if (c == "\"") { in_string = 0; scalar(text) }
          else text = text c
        } else if (c == "\"") { in_string = 1; text = "" }
        else if (c == "{" || c == "[") {
          depth++; kind[depth] = (c == "{" ? "o" : "a"); index_[depth] = 0; want_key[depth] = 1
        } else if (c == "}" || c == "]") { flush(); depth-- }
        else if (c == ":") want_key[depth] = 0
        else if (c == ",") {
          flush()
          if (kind[depth] == "a") index_[depth]++; else want_key[depth] = 1
        } else if (c != " " && c != "\t" && c != "\r") bare = bare c
      }
    }
  '
}

# The value at PATH in the JSON document FILE, or nothing.
json_value() {
  json_scalars <"$2" | awk -F '\t' -v path="$1" '$1 == path { print $2; exit }'
}

# The id of the release asset NAME, or nothing.
asset_id() {
  json_scalars <"$work/release.json" | awk -F '\t' -v name="$1" '
    $1 ~ /^\/assets\/[0-9]+\/name$/ && $2 == name { split($1, p, "/"); found = p[3] }
    $1 ~ /^\/assets\/[0-9]+\/id$/ { split($1, p, "/"); id[p[3]] = $2 }
    END { if (found != "" && (found in id)) print id[found] }
  '
}

download_asset() {
  download_id=$(asset_id "$1")
  case "$download_id" in
  "" | *[!0-9]*) fail "Release $release_tag of $REPOSITORY has no asset $1" ;;
  esac
  fetch "$api/repos/$REPOSITORY/releases/assets/$download_id" application/octet-stream "$2"
  case "$status" in
  200) ;;
  401) refused_credentials ;;
  *) fail "GitHub answered HTTP $status for $1 of release $release_tag" ;;
  esac
}

verify() {
  expected=$(awk -v name="$1" '$2 == name || $2 == "*" name { print $1; exit }' "$work/SHA256SUMS")
  case "$expected" in
  *[!0-9a-f]* | "") fail "SHA256SUMS has no valid SHA-256 for $1" ;;
  esac
  [ "${#expected}" -eq 64 ] || fail "SHA256SUMS has no valid SHA-256 for $1"
  [ "$(sha256_of "$2")" = "$expected" ] ||
    fail "The SHA-256 of $1 does not match SHA256SUMS; nothing was installed"
}

# Copies the verified executable beside the target, then renames it into place, so the
# target is always either the previous executable or the complete new one.
install_executable() {
  mkdir -p "$install_dir" 2>/dev/null || fail "Cannot create $install_dir"
  staged=$(mktemp "$install_dir/.fffactory.XXXXXX" 2>/dev/null) || fail "Cannot write to $install_dir"
  cp "$1" "$staged"
  chmod 0755 "$staged"
  mv -f "$staged" "$install_target"
  staged=""
}

cleanup() {
  if [ -n "${work:-}" ]; then rm -rf "$work"; fi
  if [ -n "${staged:-}" ]; then rm -f "$staged"; fi
}

main() {
  if [ "$#" -gt 0 ]; then
    case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
    esac
  fi
  api=${FFFACTORY_GITHUB_API:-https://api.github.com}
  api=${api%/}
  detect_platform
  check_tools
  select_release
  select_install_dir
  select_credentials

  work=""
  staged=""
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  work=$(mktemp -d "${TMPDIR:-/tmp}/fffactory-install.XXXXXX")

  if [ -n "$token" ]; then
    say "Authenticating to GitHub with $credentials"
  else
    say "Downloading anonymously; no GITHUB_TOKEN or gh credentials"
  fi
  fetch_release
  release_tag=$(json_value /tag_name "$work/release.json")
  case "$release_tag" in
  v[0-9]*) ;;
  *) fail "GitHub answered release $release_label without a version tag" ;;
  esac
  executable=fffactory-$platform
  say "Downloading $executable from release $release_tag of $REPOSITORY"
  download_asset SHA256SUMS "$work/SHA256SUMS"
  download_asset "$executable" "$work/$executable"
  verify "$executable" "$work/$executable"
  install_executable "$work/$executable"

  say "Installed fffactory ${release_tag#v} ($platform) at $install_target"
  case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) say "Warning: $install_dir is not on PATH; add it, for example: export PATH=\"$install_dir:\$PATH\"" ;;
  esac
}

main "$@"
