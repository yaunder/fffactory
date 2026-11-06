# The real `harness` install step (docs/specs/host-protocol.md §apply), from this checkout's
# packed release, run as `host apply` runs it: as root, from `/`, with a clean environment.
# Stand-in `codex` and `claude` already report the release's pins, so the step installs
# nothing and needs neither the network nor npm. Each test_* function runs as root in a fresh
# container; see run-case.sh.
# shellcheck shell=bash

RELEASE=/tmp/harness-release
REQUIREMENTS=/etc/codex/requirements.toml
EXPECTED_REQUIREMENTS='cli_auth_credentials_store = "file"
check_for_update_on_startup = false
[features]
daemon_auto_start = false'

setup() {
  useradd --create-home --user-group --shell /bin/bash factory
  mkdir -p "$RELEASE"
  tar -xzf /fixtures/release.tar.gz -C "$RELEASE"
}

# agents_at_pins: stand-in Codex and Claude Code reporting the versions versions.env pins.
agents_at_pins() {
  # shellcheck disable=SC1091
  source "$RELEASE/steps/versions.env"
  printf '#!/bin/bash\necho "codex-cli %s"\n' "$CODEX_VERSION" >/usr/local/bin/codex
  printf '#!/bin/bash\necho "%s (Claude Code)"\n' "$CLAUDE_CODE_VERSION" >/usr/local/bin/claude
  chmod 0755 /usr/local/bin/codex /usr/local/bin/claude
}

harness() {
  cd / || fail "cannot enter /"
  run env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    LANG=C.UTF-8 FFFACTORY_STEPS="$RELEASE/steps" /bin/bash "$RELEASE/steps/harness.sh"
}

assert_codex_requirements() {
  assert_eq "$(cat "$REQUIREMENTS")" "$EXPECTED_REQUIREMENTS" "$REQUIREMENTS"
  assert_eq "$(tail -c 1 "$REQUIREMENTS" | od -An -c | tr -d ' ')" '\n' "its last byte"
  assert_mode "$REQUIREMENTS" 644 root:root
  assert_mode /etc/codex 755 root:root
  assert_eq "$(ls -A /etc/codex)" "requirements.toml" "/etc/codex"
}

test_harness_writes_codex_requirements_root_owned_with_exactly_the_three_settings() {
  agents_at_pins
  harness
  assert_status 0
  assert_codex_requirements
}

test_a_harness_rerun_leaves_codex_requirements_byte_identical() {
  agents_at_pins
  harness
  assert_status 0
  local first
  first="$(digest_of "$REQUIREMENTS")"
  harness
  assert_status 0
  assert_eq "$(digest_of "$REQUIREMENTS")" "$first" "digest after a rerun"
  assert_codex_requirements
}

test_harness_replaces_codex_requirements_and_a_directory_factory_could_write() {
  agents_at_pins
  install -d -o factory -g factory -m 0777 /etc/codex
  printf '[features]\ndaemon_auto_start = true\n' >"$REQUIREMENTS"
  chown factory:factory "$REQUIREMENTS"
  chmod 0666 "$REQUIREMENTS"
  harness
  assert_status 0
  assert_codex_requirements
}

test_harness_writes_codex_requirements_before_it_installs_the_agents() {
  harness
  assert_status 1
  assert_contains "$(cat "$ERR")" "harness: failed to download @openai/codex@"
  assert_codex_requirements
}
