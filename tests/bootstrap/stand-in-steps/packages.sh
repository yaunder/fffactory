#!/usr/bin/env bash
# The stand-ins' own expressions expand when they run, not now.
# shellcheck disable=SC2016
# Stand-in for the `packages` step (tests/bootstrap/host-apply.test.sh): records that it ran
# and its environment, its open files and whether the install lock is held, fails when
# /tmp/fail-packages exists, and installs stand-ins for the
# tools the verifiers run. `gh auth status` succeeds once /tmp/enrolled-github exists.
set -Eeuo pipefail
echo packages >>/tmp/steps.log
env | LC_ALL=C sort >/tmp/packages.env
# The install lock: host apply holds it while steps run, and no step inherits it.
ls -l "/proc/$$/fd" >/tmp/packages.fds
if flock -n /run/fffactory-host-apply.lock true; then echo free; else echo held; fi >/tmp/packages.lock
[[ ! -e /tmp/fail-packages ]] || exit 3

tool() {
  printf '#!/bin/bash\n%s\n' "$2" >"/usr/local/bin/$1"
  chmod 0755 "/usr/local/bin/$1"
}
tool git 'echo "git version 2.47.1"'
tool gh 'if [[ "${1:-} ${2:-}" == "auth status" ]]; then [[ -e /tmp/enrolled-github ]]; else echo "gh version 2.63.0"; fi'
tool rg 'echo "ripgrep 15.2.0"'
tool jq 'echo "jq-1.7.1"'
tool node 'echo "v22.12.0"'
tool npm 'echo "10.9.0"'
tool python3.11 'echo "Python 3.11.10"'
tool make 'echo "GNU Make 4.3"'
tool gcc 'echo "gcc (GCC) 11.4.1"'
