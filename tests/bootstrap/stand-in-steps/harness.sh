#!/usr/bin/env bash
# The stand-ins' own expressions expand when they run, not now.
# shellcheck disable=SC2016
# Stand-in for the `harness` step: Codex and Claude Code that report the release's pins and
# no login.
set -Eeuo pipefail
echo harness >>/tmp/steps.log
[[ ! -e /tmp/fail-harness ]] || exit 3
# shellcheck disable=SC1091
source "${FFFACTORY_STEPS}/versions.env"
printf '#!/bin/bash\nif [[ "${1:-}" == --version ]]; then echo "codex-cli %s"; else exit 1; fi\n' \
  "${CODEX_VERSION}" >/usr/local/bin/codex
printf '#!/bin/bash\nif [[ "${1:-}" == --version ]]; then echo "%s (Claude Code)"; else exit 1; fi\n' \
  "${CLAUDE_CODE_VERSION}" >/usr/local/bin/claude
chmod 0755 /usr/local/bin/codex /usr/local/bin/claude
