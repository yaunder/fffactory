# `fffactory host apply` on Amazon Linux 2023 (docs/specs/host-protocol.md §apply): the real
# linux-x64 worker executable, unpacked and run as root by the real activator, with the host
# projection on standard input, from a release whose install steps are the stand-ins in
# tests/bootstrap/stand-in-steps/. Each test_* function runs as root in a fresh container
# whose hostname is fff-aaaa1111-builder-1; see run-case.sh.
# shellcheck shell=bash

ACTIVATE=/usr/local/libexec/fffactory-activate
RELEASES=/opt/fffactory/releases
STATE=/var/lib/fffactory
HOST_NAME=fff-aaaa1111-builder-1
STEPS_RUN="packages
user
systemd
harness
plugins"

setup() {
  install -D -o root -g root -m 0755 /bootstrap/fffactory-activate "$ACTIVATE"
  install -d -o root -g root -m 0755 "$RELEASES" "$STATE"
  useradd --create-home --user-group --shell /bin/bash factory
  useradd --create-home --user-group --shell /bin/bash fffactory-admin
  touch "$STATE/bootstrap-complete"
  [[ "$(cat /proc/sys/kernel/hostname)" == "$HOST_NAME" ]] || fail "the container's hostname is not $HOST_NAME"
}

# activate [PROJECTION]: the activator with the worker release and, on standard input, a host
# projection: builder-1's, this worker's, unless another is named.
activate() {
  : >/tmp/steps.log
  STDIN="${1:-/fixtures/host.json}" run "$ACTIVATE" /fixtures/worker-release.tar.gz \
    "$(cat /fixtures/worker-release.tar.gz.sha256)"
}

inspect() {
  runuser -u fffactory-admin -- /opt/fffactory/current/bin/fffactory host inspect --json
}

version() {
  cat /fixtures/release.version
}

test_host_apply_runs_every_step_in_order_then_verifies_and_records_it() {
  activate
  assert_status 0
  assert_eq "$(cat /tmp/steps.log)" "$STEPS_RUN" "steps run"
  local out
  out="$(cat "$OUT")"
  assert_contains "$out" "\"hostname\": \"$HOST_NAME\""
  assert_contains "$out" '"state": "succeeded"'
  assert_contains "$out" '"id": "toolchain",
        "status": "passed"'
  assert_not_contains "$out" '"status": "failed"'
  assert_eq "$(readlink /opt/fffactory/current)" "releases/$(version)" "current"
  cmp -s "$STATE/host.json" /fixtures/host.json || fail "host.json is not the projection sent"
  assert_mode "$STATE/host.json" 644 root:root
  assert_mode "$STATE/last-apply.json" 644 root:root
  assert_contains "$(cat "$STATE/last-apply.json")" '"state": "succeeded"'
  assert_contains "$(cat /var/log/fffactory/packages.log)" "--- fffactory: step packages succeeded"
}

test_host_apply_holds_the_install_lock_its_steps_never_inherit() {
  activate
  assert_status 0
  assert_eq "$(cat /tmp/packages.lock)" "held" "the install lock during a step"
  assert_not_contains "$(cat /tmp/packages.fds)" "fffactory-host-apply.lock" "the step's open files"
  flock -n /run/fffactory-host-apply.lock true || fail "host apply left the install lock held"
}

test_an_install_still_running_refuses_a_second_and_changes_nothing() {
  exec 8>/run/fffactory-host-apply.lock
  flock -n 8 || fail "could not take the install lock"
  activate
  exec 8>&-
  assert_status 1
  assert_contains "$(cat "$OUT")" '"reason": "busy"'
  assert_eq "$(cat /tmp/steps.log)" "" "steps run"
  assert_absent /opt/fffactory/current
  assert_absent "$STATE/last-apply.json"
  activate
  assert_status 0
}

test_fffactory_admin_activates_through_sudo_with_the_projection_on_standard_input() {
  local upload=/home/fffactory-admin/fffactory-release.tar.gz
  printf 'Defaults:fffactory-admin !requiretty\nfffactory-admin ALL=(root) NOPASSWD: %s\n' \
    "$ACTIVATE" >/etc/sudoers.d/fffactory-admin
  chmod 0440 /etc/sudoers.d/fffactory-admin
  visudo -c >/dev/null || fail "the sudoers entry does not parse"
  install -o fffactory-admin -g fffactory-admin -m 0600 /fixtures/worker-release.tar.gz "$upload"
  : >/tmp/steps.log
  STDIN=/fixtures/host.json run runuser -u fffactory-admin -- sudo -n "$ACTIVATE" "$upload" \
    "$(cat /fixtures/worker-release.tar.gz.sha256)"
  assert_status 0
  assert_contains "$(cat "$OUT")" '"state": "succeeded"'
  assert_eq "$(cat /tmp/steps.log)" "$STEPS_RUN" "steps run"
  cmp -s "$STATE/host.json" /fixtures/host.json || fail "host.json is not the projection sent"
}

test_a_release_link_it_cannot_replace_fails_the_install_with_a_record() {
  mkdir -p /opt/fffactory/current
  activate
  assert_status 1
  assert_contains "$(cat "$OUT")" "\"failure\": \"host apply failed while making release $(version) active (EISDIR)\""
  assert_contains "$(cat "$STATE/last-apply.json")" '"state": "failed"'
  assert_eq "$(cat /tmp/steps.log)" "" "steps run"
}

test_verification_reports_each_account_pending_until_it_is_enrolled() {
  activate
  assert_status 0
  local out
  out="$(cat "$OUT")"
  assert_contains "$out" '"id": "github",
        "state": "pending"'
  # States only: the operator's fffactory names the steps, never the worker.
  assert_not_contains "$out" "next_action"
  assert_not_contains "$out" "paseo_client"
  touch /tmp/enrolled-github
  activate
  assert_status 0
  assert_contains "$(cat "$OUT")" '"id": "github",
        "state": "enrolled"'
}

test_host_inspect_reports_the_install_to_fffactory_admin() {
  activate
  assert_status 0
  local inspected
  inspected="$(inspect)"
  assert_contains "$inspected" "\"version\": \"$(version)\""
  assert_contains "$inspected" '"installation": {
    "state": "succeeded"'
  assert_contains "$inspected" "\"sha256\": \"$(digest_of /fixtures/host.json)\""
}

test_a_failing_step_leaves_the_release_active_and_unhealthy_until_a_rerun_repairs_it() {
  touch /tmp/fail-harness
  activate
  assert_status 1
  assert_eq "$(cat /tmp/steps.log)" "packages
user
systemd
harness" "steps run"
  assert_contains "$(cat "$OUT")" '"name": "harness",
      "status": "failed",
      "reason": "exited with status 3"'
  assert_contains "$(cat "$OUT")" '"verification": null'
  assert_eq "$(readlink /opt/fffactory/current)" "releases/$(version)" "current"
  assert_contains "$(inspect)" '"failed_step": "harness"'

  rm /tmp/fail-harness
  activate
  assert_status 0
  assert_eq "$(cat /tmp/steps.log)" "$STEPS_RUN" "steps rerun"
  assert_contains "$(inspect)" '"state": "succeeded"'
}

test_the_steps_run_as_root_with_only_their_inputs() {
  activate
  assert_status 0
  local environment
  environment="$(cat /tmp/packages.env)"
  assert_contains "$environment" "FFFACTORY_HOSTNAME=$HOST_NAME"
  assert_contains "$environment" "FFFACTORY_STEPS=$RELEASES/$(version)/steps"
  assert_contains "$environment" "FFFACTORY_STATE=$STATE"
  assert_contains "$environment" "FFFACTORY_HOST_KEY=builder-1"
  assert_contains "$environment" "HOME=/root"
  assert_not_contains "$environment" "SUDO_"
}

test_another_workers_configuration_is_refused_and_changes_nothing() {
  activate /fixtures/other-host.json
  assert_status 1
  assert_contains "$(cat "$OUT")" '"reason": "other_host"'
  assert_eq "$(cat /tmp/steps.log)" "" "steps run"
  assert_absent /opt/fffactory/current
  assert_absent "$STATE/host.json"
  assert_absent "$STATE/last-apply.json"
}

test_host_apply_refuses_before_bootstrap_has_finished() {
  rm "$STATE/bootstrap-complete"
  activate
  assert_status 1
  assert_contains "$(cat "$OUT")" '"reason": "bootstrap_incomplete"'
  assert_absent /opt/fffactory/current
}
