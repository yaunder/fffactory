#!/usr/bin/env bash
# Install step `packages` (docs/specs/host-protocol.md §apply): the Amazon Linux packages
# workers build with, Node 22 as the default, the GitHub CLI and a verified ripgrep.
# Wrapped from v1's development-environment/scripts/setup-host.sh (deleted in #102); `host
# apply` runs it as root, in order, with its inputs in FFFACTORY_* variables, and records its
# result. Idempotent: a rerun converges.
set -Eeuo pipefail

readonly FACTORY_USER="factory"
readonly RIPGREP_VERSION="15.2.0"
readonly RIPGREP_SHA256="33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c"

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

# ripgrep is not provided by the AL2023 repositories. Install an upstream,
# statically linked release and verify the archive before placing it on PATH.
if [[ "$(/usr/local/bin/rg --version 2>/dev/null | head -n 1)" != "ripgrep ${RIPGREP_VERSION}"* ]]; then
  ripgrep_archive="ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz"
  ripgrep_tmp="$(mktemp -d)"
  temp_paths+=("${ripgrep_tmp}")
  curl --fail --location --silent --show-error \
    "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${ripgrep_archive}" \
    --output "${ripgrep_tmp}/${ripgrep_archive}"
  printf '%s  %s\n' "${RIPGREP_SHA256}" "${ripgrep_archive}" |
    (cd "${ripgrep_tmp}" && sha256sum --check --status)
  tar --extract --gzip --file "${ripgrep_tmp}/${ripgrep_archive}" \
    --directory "${ripgrep_tmp}"
  install -o root -g root -m 0755 \
    "${ripgrep_tmp}/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl/rg" \
    /usr/local/bin/rg
fi

echo "packages: the development packages are installed."
