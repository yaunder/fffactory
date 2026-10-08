#!/bin/bash
# run-case.sh FILE CASE: runs one test case of a bootstrap test file, inside its own
# disposable container (scripts/bootstrap-test.sh starts one per case).
set -euo pipefail

FILE="$1"
CASE="$2"
OUT="$(mktemp)"
ERR="$(mktemp)"
STDIN=/dev/null
STATUS=0
export CASE OUT ERR STDIN STATUS

# shellcheck source=tests/bootstrap/lib.sh
source "$(dirname "$0")/lib.sh"
# shellcheck disable=SC1090
source "$FILE"

if declare -F setup >/dev/null; then setup; fi
"$CASE"
printf 'ok   %s %s\n' "$(basename "$FILE" .test.sh)" "$CASE"
