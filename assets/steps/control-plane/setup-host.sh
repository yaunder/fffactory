#!/usr/bin/env bash
# Install release-owned Paseo files. Lifecycle is a separate, classified host-protocol action.
set -Eeuo pipefail

readonly factory_user=factory
readonly factory_home=/home/factory
readonly paseo_home=${factory_home}/.paseo
readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly service_path=/etc/systemd/system/paseo.service
readonly secret_reference=${factory_home}/.config/fffactory/paseo-password-secret-arn
readonly factory_path=${factory_home}/.local/bin:/usr/local/bin:/usr/bin:/bin

fail() { printf 'fffactory Paseo setup: %s\n' "$*" >&2; exit 1; }
factory_command() {
  runuser -u "${factory_user}" -- env -i HOME="${factory_home}" PASEO_HOME="${paseo_home}" \
    PATH="${factory_path}" "$@"
}

((EUID == 0)) || fail 'must run as root through fffactory-activate'
[[ -r /etc/os-release ]] || fail 'cannot identify the operating system'
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == amzn && ${VERSION_ID:-} == 2023 ]] || fail 'requires Amazon Linux 2023'
id "${factory_user}" >/dev/null 2>&1 || fail 'factory account is missing'
[[ -r ${script_dir}/versions.env && -r ${script_dir}/paseo.service ]] || fail 'release inputs are missing'
# shellcheck disable=SC1091
source "${script_dir}/versions.env"
: "${PASEO_VERSION:?PASEO_VERSION is required}"
: "${PASEO_INTEGRITY:?PASEO_INTEGRITY is required}"

IFS= read -r paseo_secret_arn || true
if [[ -n ${paseo_secret_arn} ]]; then
  [[ ${paseo_secret_arn} =~ ^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$ ]] ||
    fail 'the Paseo password secret reference is invalid'
fi

install -d -o "${factory_user}" -g "${factory_user}" -m 0700 "${paseo_home}"
install -d -o "${factory_user}" -g "${factory_user}" -m 0700 "$(dirname "${secret_reference}")"
secret_tmp="$(mktemp)"
trap 'rm -f -- "${secret_tmp}"' EXIT
printf '%s\n' "${paseo_secret_arn}" >"${secret_tmp}"
install -o "${factory_user}" -g "${factory_user}" -m 0600 "${secret_tmp}" "${secret_reference}"

installed="$(factory_command paseo --version 2>/dev/null || true)"
if [[ ${installed} != "${PASEO_VERSION}" ]]; then
  package_dir="$(mktemp -d)"
  pack_result="$(mktemp)"
  trap 'rm -rf -- "${secret_tmp}" "${package_dir}" "${pack_result}"' EXIT
  chown "${factory_user}:${factory_user}" "${package_dir}"
  factory_command /usr/bin/npm-22 pack "@getpaseo/cli@${PASEO_VERSION}" \
    --pack-destination "${package_dir}" --json >"${pack_result}" || fail 'Paseo download failed'
  actual_integrity="$(jq -er '.[0].integrity' "${pack_result}")"
  [[ ${actual_integrity} == "${PASEO_INTEGRITY}" ]] || fail 'Paseo package integrity mismatch'
  package_file="${package_dir}/$(jq -er '.[0].filename' "${pack_result}")"
  factory_command /usr/bin/npm-22 install --global --no-audit --no-fund "${package_file}"
fi
[[ $(factory_command paseo --version) == "${PASEO_VERSION}" ]] || fail 'Paseo version mismatch'

tailscale_ipv4="$(tailscale ip -4 2>/dev/null | head -n 1)"
[[ -n ${tailscale_ipv4} ]] || fail 'the worker has no Tailscale IPv4 address'
# Paseo answers 403 to a Host header naming neither its listen address nor daemon.hostnames.
tailscale_dns="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty | rtrimstr(".")')" ||
  fail 'cannot read the Tailscale status'
[[ -n ${tailscale_dns} ]] || fail 'the worker has no MagicDNS name'
short_hostname="$(hostname --short)"
[[ -n ${short_hostname} ]] || fail 'the worker has no hostname'
factory_command FACTORY_PASEO_CONFIG="${paseo_home}/config.json" \
  FACTORY_PASEO_LISTEN="${tailscale_ipv4}:6767" \
  FACTORY_PASEO_HOSTNAMES="${short_hostname} ${tailscale_dns}" \
  "${script_dir}/paseo-config.sh" || fail 'the Paseo config merge failed'

install -o root -g root -m 0644 "${script_dir}/paseo.service" "${service_path}"
systemctl daemon-reload
systemctl enable paseo.service >/dev/null
