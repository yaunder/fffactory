#!/usr/bin/env bash
# Stand-in for the `user` step: the runtime account's workspace.
set -Eeuo pipefail
echo user >>/tmp/steps.log
[[ ! -e /tmp/fail-user ]] || exit 3
install -d -o factory -g factory -m 0750 /workspace /workspace/repos /workspace/cache
