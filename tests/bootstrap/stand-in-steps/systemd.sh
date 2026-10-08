#!/usr/bin/env bash
# Stand-in for the `systemd` step: the container has no systemd, so it installs a systemctl
# that reports every service active.
set -Eeuo pipefail
echo systemd >>/tmp/steps.log
[[ ! -e /tmp/fail-systemd ]] || exit 3
printf '#!/bin/bash\necho active\n' >/usr/bin/systemctl
chmod 0755 /usr/bin/systemctl
