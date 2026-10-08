#!/usr/bin/env bash
# Stand-in for the `plugins` step: installing records itself; `verify` passes.
set -Eeuo pipefail
if [[ "${1:-install}" == verify ]]; then exit 0; fi
echo plugins >>/tmp/steps.log
[[ ! -e /tmp/fail-plugins ]] || exit 3
