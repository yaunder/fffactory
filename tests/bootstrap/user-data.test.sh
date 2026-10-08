# The bootstrap user data (worker-bootstrap §User data), rendered for SAMPLE_INPUTS
# (tests/support/user-data.ts) at /fixtures/user-data.sh. Each test_* function runs as root in
# a fresh container; see run-case.sh. dnf, systemctl, hostnamectl, tailscale, aws and sleep
# are stand-ins on PATH that log their arguments to /var/log/fake/<name>; everything else
# (useradd, install, visudo, sudo) is Amazon Linux's own.
# shellcheck shell=bash

USER_DATA=/fixtures/user-data.sh
HOST_NAME=fff-aaaa1111-builder-1
SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:example/tailscale-auth-key-AbCdEf
SECRET=tskey-auth-kFAKE0123-SECRETVALUE
ACTIVATOR=/usr/local/libexec/fffactory-activate
FAKE=/var/lib/fake
LOG=/var/log/fake

fake() {
  cat >"/usr/local/sbin/$1"
  chmod 0755 "/usr/local/sbin/$1"
}

setup() {
  mkdir -p "$FAKE" "$LOG" /etc/yum.repos.d
  fake dnf <<'FAKE'
#!/bin/bash
printf '%s\n' "$*" >>/var/log/fake/dnf
case "$1" in
  config-manager) touch /etc/yum.repos.d/tailscale.repo ;;
  install)
    if [[ -f /var/lib/fake/dnf-gpg-failure ]]; then
      echo "Error: GPG check FAILED" >&2
      exit 1
    fi
    locked="$(cat /var/lib/fake/dnf-lock-failures 2>/dev/null || echo 0)"
    if ((locked > 0)); then
      echo $((locked - 1)) >/var/lib/fake/dnf-lock-failures
      cat >&2 <<'LOCKED'
error: cannot create transaction lock on /var/lib/rpm/.rpm.lock (Resource temporarily unavailable)
Key import failed (code 2). Failing package is: tailscale-1.102.3-1.x86_64
Error: GPG check FAILED
LOCKED
      exit 1
    fi
    echo "Complete!"
    ;;
esac
FAKE
  fake tailscale <<'FAKE'
#!/bin/bash
printf '%s\n' "$*" >>/var/log/fake/tailscale
case "$1" in
  ip) [[ -f /var/lib/fake/tailscale-up && ! -f /var/lib/fake/tailscale-never-ready ]] &&
    echo 100.64.0.1 ;;
  up)
    for argument in "$@"; do
      case "$argument" in
        --auth-key=file:*)
          key="${argument#--auth-key=file:}"
          cp "$key" /var/lib/fake/tailscale-key
          stat -c '%a %U' "$key" >/var/lib/fake/tailscale-key-mode
          ;;
      esac
    done
    touch /var/lib/fake/tailscale-up
    ;;
esac
FAKE
  fake aws <<'FAKE'
#!/bin/bash
printf '%s\n' "$*" >>/var/log/fake/aws
echo "tskey-auth-kFAKE0123-SECRETVALUE"
FAKE
  local name
  for name in systemctl hostnamectl sleep; do
    fake "$name" <<FAKE
#!/bin/bash
printf '%s\n' "\$*" >>/var/log/fake/$name
FAKE
  done
}

bootstrap() {
  run bash "$USER_DATA"
}

logged() {
  cat "$LOG/$1" 2>/dev/null || true
}

test_creates_the_accounts_directories_and_activator() {
  bootstrap
  assert_status 0
  local account
  for account in fffactory-admin factory; do
    id "$account" >/dev/null || fail "no account $account"
    assert_eq "$(getent passwd "$account" | cut -d: -f6,7)" "/home/$account:/bin/bash" "$account"
    assert_mode "/home/$account" 700 "$account:$account"
    assert_eq "$(id -nG "$account")" "$account" "groups of $account"
  done
  cmp /bootstrap/fffactory-activate "$ACTIVATOR" || fail "the installed activator differs"
  assert_mode "$ACTIVATOR" 755 root:root
  assert_mode /opt/fffactory/releases 755 root:root
  assert_mode /var/lib/fffactory 755 root:root
  assert_eq "$(ls -A /opt/fffactory/releases)" "" "releases directory"
  [[ -f /var/lib/fffactory/bootstrap-complete ]] || fail "no completion marker"
  assert_eq "$(logged hostnamectl)" "set-hostname $HOST_NAME" "hostnamectl"
  assert_eq "$(cat /etc/cloud/cloud.cfg.d/99-fffactory-hostname.cfg)" "preserve_hostname: true"
}

test_sudoers_lets_fffactory_admin_run_only_the_activator() {
  bootstrap
  assert_status 0
  assert_mode /etc/sudoers.d/fffactory-admin 440 root:root
  visudo -c -q || fail "visudo -c rejects the sudoers configuration"
  local rules
  rules="$(sudo -l -U fffactory-admin)"
  assert_contains "$rules" "(root) NOPASSWD: $ACTIVATOR" "sudo -l"
  assert_eq "$(grep -c NOPASSWD <<<"$rules")" 1 "fffactory-admin's sudo rules"
  assert_not_contains "$(sudo -l -U factory)" "$ACTIVATOR" "factory's sudo rules"

  run runuser -u fffactory-admin -- sudo -n /bin/true
  [[ "$STATUS" != 0 ]] || fail "fffactory-admin may run /bin/true as root"
  run runuser -u fffactory-admin -- sudo -n -u factory "$ACTIVATOR"
  [[ "$STATUS" != 0 ]] || fail "fffactory-admin may run the activator as factory"
  run runuser -u factory -- sudo -n "$ACTIVATOR"
  [[ "$STATUS" != 0 ]] || fail "factory may run the activator"

  # The whole path: fffactory-admin activates a packed release through sudo.
  run runuser -u fffactory-admin -- sudo -n "$ACTIVATOR" /fixtures/release.tar.gz \
    "$(cat /fixtures/release.tar.gz.sha256)"
  assert_status 0
  local record
  record="$(cat /tmp/host-apply.record)"
  assert_contains "$record" "args=host apply" "host apply record"
  assert_contains "$record" "uid=0" "host apply record"
  assert_contains "$record" "self=/opt/fffactory/releases/$(cat /fixtures/release.version)/bin/fffactory"
  assert_eq "$(readlink /opt/fffactory/current)" \
    "releases/$(cat /fixtures/release.version)" "active release"

  # The same sole sudo command exposes only its fixed repository endpoint.
  run runuser -u fffactory-admin -- sudo -n "$ACTIVATOR" repositories
  assert_status 0
  assert_contains "$(cat /tmp/host-apply.record)" "args=host repositories --apply"

  # The same sole sudo command exposes the active release's fixed Paseo actions.
  run runuser -u fffactory-admin -- sudo -n "$ACTIVATOR" control-plane activity
  assert_status 0
  assert_contains "$(cat /tmp/host-apply.record)" "args=host control-plane activity"
  run runuser -u fffactory-admin -- sudo -n "$ACTIVATOR" control-plane arbitrary
  assert_status 64

  # Dispatch is the same narrow protocol: only three fixed active-release operations.
  run runuser -u fffactory-admin -- sudo -n "$ACTIVATOR" dispatch inspect
  assert_status 0
  assert_contains "$(cat /tmp/host-apply.record)" "args=host dispatch inspect"
  run runuser -u fffactory-admin -- sudo -n "$ACTIVATOR" dispatch arbitrary
  assert_status 64
}

test_enrolls_in_tailscale_with_the_factory_key_under_the_namespaced_hostname() {
  bootstrap
  assert_status 0
  assert_eq "$(logged aws)" \
    "secretsmanager get-secret-value --region us-east-1 --secret-id $SECRET_ARN --query SecretString --output text" \
    "aws"
  local up
  up="$(grep '^up ' "$LOG/tailscale")"
  [[ "$up" =~ ^up\ --auth-key=file:/run/fffactory-tailscale\.[A-Za-z0-9]+/auth-key\ --hostname=$HOST_NAME\ --advertise-tags=tag:software-factory\ --ssh$ ]] ||
    fail "tailscale up: $up"
  assert_eq "$(cat "$FAKE/tailscale-key")" "$SECRET" "the key tailscale read"
  assert_eq "$(cat "$FAKE/tailscale-key-mode")" "600 root" "the key file's mode"
  # The key never reaches an argument or a log, and its file is gone.
  local name
  for name in dnf tailscale aws systemctl hostnamectl sleep; do
    assert_not_contains "$(logged "$name")" "$SECRET" "$name arguments"
  done
  assert_not_contains "$(cat "$OUT" "$ERR")" "$SECRET" "user data output"
  compgen -G '/run/fffactory-tailscale.*' >/dev/null && fail "the key directory remains"
  assert_eq "$(logged systemctl)" "enable --now tailscaled" "systemctl"
  assert_eq "$(logged dnf)" \
    "config-manager --add-repo https://pkgs.tailscale.com/stable/amazon-linux/2023/tailscale.repo
install -y tailscale" "dnf"
}

test_configures_no_ssm_agent() {
  bootstrap
  assert_status 0
  local name
  for name in dnf systemctl; do
    assert_not_contains "$(logged "$name" | tr '[:upper:]' '[:lower:]')" ssm "$name arguments"
  done
}

test_an_rpm_lock_failure_is_retried_with_backoff() {
  echo 2 >"$FAKE/dnf-lock-failures"
  bootstrap
  assert_status 0
  assert_eq "$(grep -c '^install ' "$LOG/dnf")" 3 "dnf install attempts"
  assert_eq "$(logged sleep | head -n 2 | tr '\n' ' ')" "5 10 " "backoff"
  assert_contains "$(cat "$ERR")" "the RPM database is locked; retrying in 5 seconds (attempt 1 of 5)"
  [[ -f /var/lib/fffactory/bootstrap-complete ]] || fail "no completion marker"
}

test_a_persistent_rpm_lock_fails_after_five_attempts() {
  echo 99 >"$FAKE/dnf-lock-failures"
  bootstrap
  assert_status 1
  assert_eq "$(grep -c '^install ' "$LOG/dnf")" 5 "dnf install attempts"
  assert_eq "$(logged sleep | tr '\n' ' ')" "5 10 20 40 " "backoff"
  assert_contains "$(cat "$ERR")" "the RPM database was still locked after 5 attempts"
  assert_absent /var/lib/fffactory/bootstrap-complete
  assert_absent "$FAKE/tailscale-up"
}

test_any_other_dnf_failure_fails_at_once() {
  touch "$FAKE/dnf-gpg-failure"
  bootstrap
  assert_status 1
  assert_eq "$(grep -c '^install ' "$LOG/dnf")" 1 "dnf install attempts"
  assert_eq "$(logged sleep)" "" "sleeps"
  assert_contains "$(cat "$ERR")" "Error: GPG check FAILED"
  assert_absent /var/lib/fffactory/bootstrap-complete
  assert_absent "$FAKE/tailscale-up"
}

test_tailscale_that_never_comes_up_fails_the_bootstrap() {
  touch "$FAKE/tailscale-never-ready"
  bootstrap
  assert_status 1
  assert_contains "$(cat "$ERR")" "Tailscale did not come up"
  assert_eq "$(logged sleep | grep -c '^2$')" 29 "readiness waits"
  assert_absent /var/lib/fffactory/bootstrap-complete
}

test_a_rerun_is_idempotent() {
  bootstrap
  assert_status 0
  bootstrap
  assert_status 0
  assert_eq "$(grep -c '^up ' "$LOG/tailscale")" 1 "tailscale up runs"
  assert_eq "$(grep -c '^config-manager ' "$LOG/dnf")" 1 "repository additions"
  assert_contains "$(cat "$ERR")" "Tailscale is already enrolled"
  visudo -c -q || fail "visudo -c rejects the sudoers configuration"
  [[ -f /var/lib/fffactory/bootstrap-complete ]] || fail "no completion marker"
}
