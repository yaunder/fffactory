#!/usr/bin/env bash
# Install step `systemd` (docs/specs/host-protocol.md §apply): the services a worker runs,
# enabled and started. Bootstrap starts tailscaled; this step restarts it when it has
# stopped, so apply repairs a worker whose service `fffactory status` reports as not active.
# Idempotent: a rerun converges.
set -Eeuo pipefail

readonly SERVICES=(tailscaled.service)

[[ ${EUID} -eq 0 ]] || {
  echo "systemd: must run as root" >&2
  exit 1
}

for service in "${SERVICES[@]}"; do
  systemctl enable --now "${service}"
  systemctl is-active --quiet "${service}" || {
    echo "systemd: ${service} is not active" >&2
    exit 1
  }
done

echo "systemd: ${SERVICES[*]} enabled and active."
