#!/usr/bin/env bash
# Ad-hoc signs a darwin-arm64 fffactory executable with the JavaScript engine entitlements
# Bun documents (scripts/entitlements.plist), then verifies the signature. Needs macOS.
#
#   scripts/sign-macos.sh BINARY
#
# The signature is ad-hoc (`--sign -`): Apple Silicon requires one to run a native binary,
# and it asserts no publisher identity. No notarization (D10).
set -euo pipefail

[[ $# -eq 1 ]] || { echo "usage: $0 BINARY" >&2; exit 1; }
binary="$1"
entitlements="$(cd "$(dirname "$0")" && pwd)/entitlements.plist"

codesign --force --sign - --entitlements "$entitlements" "$binary"
codesign --verify --strict --verbose=2 "$binary"
codesign --display --verbose=2 "$binary" 2>&1 | grep -E '^(Identifier|Format|Signature)='
codesign --display --entitlements - --xml "$binary" | grep -q com.apple.security.cs.allow-jit || {
  echo "$binary is missing its entitlements" >&2
  exit 1
}
echo "Ad-hoc signed $binary"
