#!/usr/bin/env bash
# Install step `packages` (docs/specs/host-protocol.md §apply): the Amazon Linux packages
# workers build with, Node 22 as the default, the GitHub CLI, and the upstream build tools
# ripgrep, just and pnpm, each pinned here and checked against its sha256 before it is installed.
# Wrapped from v1's development-environment/scripts/setup-host.sh (deleted in #102); `host
# apply` runs it as root, in order, with its inputs in FFFACTORY_* variables, and records its
# result. Idempotent: a rerun converges.
set -Eeuo pipefail

readonly FACTORY_USER="factory"
readonly RIPGREP_VERSION="15.2.0"
readonly RIPGREP_SHA256="33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c"
readonly JUST_VERSION="1.59.0"
readonly JUST_SHA256="409044617b6f06517c1035e55ca38c8c856ff8b650e41bc2aa1ef82d5903a23e"
# pnpm's native binary: from pnpm 12 the `pnpm` package is a launcher that fetches it itself.
readonly PNPM_VERSION="12.14.0"
readonly PNPM_SHA256="1de98ed2e9621113b0887b06322b461efb9df73d913fc1d151039b10b7117a41"

temp_paths=()
cleanup() {
  local path
  for path in "${temp_paths[@]}"; do
    rm -rf -- "${path}"
  done
}
trap cleanup EXIT

fail() {
  echo "packages: $1" >&2
  exit 1
}

# Installs a pinned upstream binary as /usr/local/bin/<name>, root-owned and 0755, unless its
# `--version` already reports the pin: its first line is <reported>, or <reported> and a space.
# Otherwise downloads the archive only from <url>, checks it against <sha256> before extracting
# anything, and installs its <member>.
install_verified_binary() {
  local name="$1" reported="$2" url="$3" sha256="$4" member="$5"
  local destination="/usr/local/bin/${name}" archive="${url##*/}" current work
  current="$("${destination}" --version 2>/dev/null | head -n 1)" || true
  if [[ ${current} == "${reported}" || ${current} == "${reported} "* ]]; then
    return 0
  fi
  work="$(mktemp -d)"
  temp_paths+=("${work}")
  curl --fail --location --silent --show-error "${url}" --output "${work}/${archive}"
  printf '%s  %s\n' "${sha256}" "${archive}" |
    (cd "${work}" && sha256sum --check --status) ||
    fail "${archive} does not match its pinned sha256"
  tar --extract --gzip --file "${work}/${archive}" --directory "${work}" "${member}"
  install -o root -g root -m 0755 "${work}/${member}" "${destination}"
}

[[ ${EUID} -eq 0 ]] || fail "must run as root"

# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == "amzn" && ${VERSION_ID:-} == "2023" ]] || fail "workers run Amazon Linux 2023 only"
id "${FACTORY_USER}" >/dev/null 2>&1 || fail "bootstrap must create the ${FACTORY_USER} account first"

dnf install -y \
  dnf-plugins-core \
  gcc \
  gcc-c++ \
  git \
  git-lfs \
  gzip \
  jq \
  make \
  nodejs22 \
  nodejs22-npm \
  python3.11 \
  python3.11-devel \
  python3.11-pip \
  rsync \
  tar \
  tmux \
  unzip \
  zip

# Amazon Linux installs versioned Node binaries side by side. Make Node 22 the
# host default so agent subprocesses and scripts get a predictable runtime.
alternatives --set node /usr/bin/node-22

if ! rpm --quiet --query gh; then
  if [[ ! -f /etc/yum.repos.d/gh-cli.repo ]]; then
    dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
  fi
  dnf install -y gh
fi

# None of these is in the AL2023 repositories: install upstream's statically linked or
# self-contained release builds.
install_verified_binary rg "ripgrep ${RIPGREP_VERSION}" \
  "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
  "${RIPGREP_SHA256}" "ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl/rg"
install_verified_binary just "just ${JUST_VERSION}" \
  "https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
  "${JUST_SHA256}" just
install_verified_binary pnpm "${PNPM_VERSION}" \
  "https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-${PNPM_VERSION}.tgz" \
  "${PNPM_SHA256}" package/pnpm

echo "packages: the development packages are installed."
