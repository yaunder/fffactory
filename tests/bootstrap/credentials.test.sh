# The `credentials` install step (docs/specs/credential-delivery.md), run by the real linux-x64
# worker executable's `host apply` through the real activator, as host-apply.test.sh runs it,
# with builder-1's projection referencing all three API credentials. The network-less container
# has no AWS and no real agents: a stand-in /usr/bin/aws answers from /tmp/secrets, and
# stand-in gh, codex and claude first on factory's PATH keep their stores as the real tools do
# (gh's hosts file, ~/.codex/auth.json) and play the parts the spikes characterized: gh refuses
# a token that is not `ghp_...` with exit 1, keeping the previous login; `claude auth status`
# passes on fffactory's helper without running it; `claude -p` and `codex exec` read the key
# they would send, as factory, and record its digest as a provider would see it. Material is
# random per case, so this file holds none. Each test_* function runs as root in a fresh
# container whose hostname is fff-aaaa1111-builder-1; see run-case.sh.
# shellcheck shell=bash

ACTIVATE=/usr/local/libexec/fffactory-activate
RELEASES=/opt/fffactory/releases
STATE=/var/lib/fffactory
FACTORY_HOME=/home/factory
STAND_INS="$FACTORY_HOME/.local/bin"
KEY_FILE="$FACTORY_HOME/.config/fffactory/anthropic-api-key"
SETTINGS=/etc/claude-code/managed-settings.json
EXPECTED_SETTINGS='{
  "apiKeyHelper": "cat /home/factory/.config/fffactory/anthropic-api-key"
}'

setup() {
  install -D -o root -g root -m 0755 /bootstrap/fffactory-activate "$ACTIVATE"
  install -d -o root -g root -m 0755 "$RELEASES" "$STATE"
  useradd --create-home --user-group --shell /bin/bash factory
  useradd --create-home --user-group --shell /bin/bash fffactory-admin
  touch "$STATE/bootstrap-complete"
  install -d -o root -g root -m 0700 /tmp/secrets
  secret github-token "ghp_$(random)"
  secret openai-api-key "sk-proj-$(random)"
  secret anthropic-api-key "sk-ant-api03-$(random)"
  stand_in_aws
  stand_in_agents
  # A stale second account, which the configured one replaces (D5): an Enterprise Managed
  # User's, whose login holds an underscore.
  install -d -o factory -g factory -m 0700 "$FACTORY_HOME/.config" "$FACTORY_HOME/.config/gh"
  printf 'octocat_acme ghp_stale\n' >"$FACTORY_HOME/.config/gh/hosts.yml"
  printf 'octocat_acme\n' >"$FACTORY_HOME/.config/gh/active"
  chown factory:factory "$FACTORY_HOME/.config/gh/hosts.yml" "$FACTORY_HOME/.config/gh/active"
  chmod 0600 "$FACTORY_HOME/.config/gh/hosts.yml"
}

random() {
  od -An -tx1 -N16 /dev/urandom | tr -d ' \n'
}

# secret NAME VALUE: what Secrets Manager holds for NAME.
secret() {
  printf '%s' "$2" >"/tmp/secrets/$1"
}

material() {
  cat "/tmp/secrets/$1"
}

# The AWS CLI as the instance role would answer it: the secret named by the ARN's last part,
# as JSON, or AccessDeniedException while /tmp/aws-fail-NAME exists. Records its arguments and
# environment.
stand_in_aws() {
  cat >/usr/bin/aws <<'AWS'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >>/tmp/aws.args
env | LC_ALL=C sort >>/tmp/aws.env
arn=""
while [[ $# -gt 0 ]]; do
  if [[ $1 == --secret-id ]]; then arn="$2"; fi
  shift
done
name="${arn##*/}"
name="${name%-AbCdEf}"
if [[ -e "/tmp/aws-fail-$name" || ! -e "/tmp/secrets/$name" ]]; then
  echo "An error occurred (AccessDeniedException) when calling the GetSecretValue operation: $arn" >&2
  exit 254
fi
printf '"%s"\n' "$(cat "/tmp/secrets/$name")"
AWS
  chmod 0755 /usr/bin/aws
}

stand_in_agents() {
  install -d -o factory -g factory -m 0755 "$FACTORY_HOME/.local"
  install -d -o root -g root -m 0755 "$STAND_INS"
  cat >"$STAND_INS/gh" <<'GH'
#!/bin/bash
# gh's account store as `--insecure-storage` keeps it: one "LOGIN TOKEN" line per account.
set -euo pipefail
printf '%s\n' "$*" >>/tmp/gh.args
store="$HOME/.config/gh/hosts.yml"
active="$HOME/.config/gh/active"
case "$*" in
  "auth login --with-token --hostname github.com --git-protocol https --insecure-storage")
    token="$(cat)"
    [[ -n $token ]] || { echo "waiting for the device flow" >&2; exit 1; }
    [[ $token == ghp_* ]] || { echo "error validating token: HTTP 401: Bad credentials" >&2; exit 1; }
    mkdir -p "${store%/*}"
    touch "$store"
    chmod 0600 "$store"
    grep -v '^factory-bot ' "$store" >"$store.new" || true
    printf 'factory-bot %s\n' "$token" >>"$store.new"
    mv -f "$store.new" "$store"
    printf 'factory-bot\n' >"$active" ;;
  "auth setup-git --hostname github.com")
    printf '[credential "https://github.com"]\n\thelper =\n\thelper = !/usr/bin/gh auth git-credential\n' >"$HOME/.gitconfig" ;;
  "auth status --hostname github.com --json hosts")
    current="$(cat "$active" 2>/dev/null || true)"
    entries=""
    while read -r login _; do
      [[ -n $login ]] || continue
      flag=false
      [[ $login == "$current" ]] && flag=true
      entries+="${entries:+,}{\"state\":\"success\",\"active\":$flag,\"host\":\"github.com\",\"login\":\"$login\"}"
    done <"$store"
    printf '{"hosts":{"github.com":[%s]}}\n' "$entries" ;;
  "auth logout --hostname github.com --user "*)
    user="${!#}"
    grep -v "^$user " "$store" >"$store.new" || true
    mv -f "$store.new" "$store" ;;
  "auth status --hostname github.com")
    current="$(cat "$active" 2>/dev/null || true)"
    [[ -n $current ]] && grep -q "^$current ghp_" "$store" ;;
  *) exec /usr/local/bin/gh "$@" ;;
esac
GH
  cat >"$STAND_INS/codex" <<'CODEX'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >>/tmp/codex.args
auth="$HOME/.codex/auth.json"
case "${1:-} ${2:-}" in
  "login --with-api-key")
    key="$(cat)"
    [[ -n $key ]] || { echo "No API key provided via stdin." >&2; exit 1; }
    mkdir -p -m 0700 "$HOME/.codex"
    (umask 077 && printf '{"auth_mode":"apikey","OPENAI_API_KEY":"%s"}' "$key" >"$auth") ;;
  "login status") [[ -s $auth ]] ;;
  "exec "*)
    # What the provider receives: the key from the file store, never a prompt.
    key="$(sed -n 's/.*"OPENAI_API_KEY":"\([^"]*\)".*/\1/p' "$auth")"
    printf '%s' "$key" | sha256sum | cut -d' ' -f1 >/tmp/openai-provider.seen ;;
  *) exec /usr/local/bin/codex "$@" ;;
esac
CODEX
  cat >"$STAND_INS/claude" <<'CLAUDE'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >>/tmp/claude.args
settings=/etc/claude-code/managed-settings.json
helper="$(sed -n 's/.*"apiKeyHelper": "\(.*\)".*/\1/p' "$settings" 2>/dev/null || true)"
case "${1:-} ${2:-}" in
  # As Claude Code 2.1.302 does: a configured helper passes, and it is not run.
  "auth status") [[ -n $helper ]] ;;
  "-p "*)
    [[ -n $helper ]] || { echo "Not logged in" >&2; exit 1; }
    key="$(/bin/sh -c "$helper")"
    [[ -n $key ]] || { echo "Invalid API key" >&2; exit 1; }
    printf '%s' "$key" | sha256sum | cut -d' ' -f1 >/tmp/anthropic-provider.seen ;;
  *) exec /usr/local/bin/claude "$@" ;;
esac
CLAUDE
  chmod 0755 "$STAND_INS/gh" "$STAND_INS/codex" "$STAND_INS/claude"
}

# activate [PROJECTION]: the activator with the worker release and a host projection on
# standard input: builder-1's with all three credentials, unless another is named.
activate() {
  STDIN="${1:-/fixtures/credentials-host.json}" run "$ACTIVATE" /fixtures/worker-release.tar.gz \
    "$(cat /fixtures/worker-release.tar.gz.sha256)"
}

as_factory() {
  runuser -u factory -- env -i HOME="$FACTORY_HOME" \
    PATH="$STAND_INS:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 "$@" </dev/null
}

assert_enrolled() {
  local out
  out="$(cat "$OUT")"
  for account in github openai anthropic; do
    assert_contains "$out" "\"id\": \"$account\",
        \"state\": \"$1\"" "the $account enrollment"
  done
}

test_host_apply_delivers_every_account_and_verify_reports_each_enrolled() {
  activate
  assert_status 0
  assert_contains "$(cat "$OUT")" '"name": "credentials",
      "status": "succeeded"'
  assert_enrolled enrolled
  assert_eq "$(cut -d' ' -f1 "$FACTORY_HOME/.config/gh/hosts.yml")" "factory-bot" "gh's accounts"
  assert_eq "$(cut -d' ' -f2 "$FACTORY_HOME/.config/gh/hosts.yml")" "$(material github-token)" \
    "gh's token"
  assert_contains "$(cat "$FACTORY_HOME/.gitconfig")" "gh auth git-credential"
  assert_mode "$FACTORY_HOME/.codex/auth.json" 600 factory:factory
  assert_eq "$(cat "$KEY_FILE")" "$(material anthropic-api-key)" "the Anthropic key file"
  assert_mode "$KEY_FILE" 600 factory:factory
  assert_mode "${KEY_FILE%/*}" 700 factory:factory
  assert_eq "$(cat "$SETTINGS")" "$EXPECTED_SETTINGS" "$SETTINGS"
  assert_mode "$SETTINGS" 644 root:root
  assert_mode /etc/claude-code 755 root:root
  assert_eq "$(cat /var/log/fffactory/credentials.log)" "github: delivered
openai: delivered
anthropic: delivered
--- fffactory: step credentials succeeded" "the step's log"
  # The instance role, in the secret's Region; the CLI's pager off.
  assert_contains "$(cat /tmp/aws.args)" \
    "secretsmanager get-secret-value --region us-east-1 --secret-id arn:aws:secretsmanager:us-east-1:123456789012:secret:fff-aaaa1111/github-token-AbCdEf --query SecretString --output json"
  assert_contains "$(cat /tmp/aws.env)" "AWS_PAGER="
  # No first-launch state is written (D17).
  assert_absent "$FACTORY_HOME/.claude.json"
}

test_an_agent_launched_as_factory_sends_the_delivered_keys_without_a_prompt() {
  activate
  assert_status 0
  as_factory claude -p "say hi" || fail "claude -p did not run"
  as_factory codex exec --skip-git-repo-check "say hi" || fail "codex exec did not run"
  assert_eq "$(cat /tmp/anthropic-provider.seen)" "$(digest_text "$(material anthropic-api-key)")" \
    "the key Claude Code sent"
  assert_eq "$(cat /tmp/openai-provider.seen)" "$(digest_text "$(material openai-api-key)")" \
    "the key Codex sent"
}

test_material_is_only_in_the_tools_stores() {
  activate
  assert_status 0
  local name value found expected
  for name in github-token openai-api-key anthropic-api-key; do
    value="$(material "$name")"
    found="$(grep -rlsF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -- "$value" / |
      LC_ALL=C sort)"
    case "$name" in
      github-token) expected="$FACTORY_HOME/.config/gh/hosts.yml" ;;
      openai-api-key) expected="$FACTORY_HOME/.codex/auth.json" ;;
      anthropic-api-key) expected="$KEY_FILE" ;;
    esac
    assert_eq "$found" "$(printf '%s\n%s\n' "$expected" "/tmp/secrets/$name" | LC_ALL=C sort)" \
      "the files holding $name"
    # So never in an argument, the step's log, the record, or host apply's output.
    for file in /tmp/aws.args /tmp/gh.args /tmp/codex.args /tmp/claude.args "$OUT" "$ERR"; do
      assert_not_contains "$(cat "$file" 2>/dev/null)" "$value" "$file"
    done
  done
}

test_a_rerun_reasserts_the_same_stores() {
  activate
  assert_status 0
  local settings key gitconfig
  settings="$(digest_of "$SETTINGS")"
  key="$(digest_of "$KEY_FILE")"
  gitconfig="$(digest_of "$FACTORY_HOME/.gitconfig")"
  activate
  assert_status 0
  assert_enrolled enrolled
  assert_eq "$(digest_of "$SETTINGS")" "$settings" "$SETTINGS after a rerun"
  assert_eq "$(digest_of "$KEY_FILE")" "$key" "the key file after a rerun"
  assert_eq "$(digest_of "$FACTORY_HOME/.gitconfig")" "$gitconfig" ".gitconfig after a rerun"
}

test_a_rotated_key_replaces_the_old_one_on_the_next_apply() {
  activate
  assert_status 0
  secret anthropic-api-key "sk-ant-api03-$(random)"
  secret openai-api-key "sk-proj-$(random)"
  activate
  assert_status 0
  assert_eq "$(cat "$KEY_FILE")" "$(material anthropic-api-key)" "the rotated key file"
  as_factory codex exec --skip-git-repo-check "say hi" || fail "codex exec did not run"
  assert_eq "$(cat /tmp/openai-provider.seen)" "$(digest_text "$(material openai-api-key)")" \
    "the rotated key Codex sent"
}

test_undelivered_accounts_keep_their_logins_and_the_claude_helper_goes() {
  activate
  assert_status 0
  local gh codex
  gh="$(digest_of "$FACTORY_HOME/.config/gh/hosts.yml")"
  codex="$(digest_of "$FACTORY_HOME/.codex/auth.json")"
  activate /fixtures/host.json
  assert_status 0
  assert_eq "$(digest_of "$FACTORY_HOME/.config/gh/hosts.yml")" "$gh" "gh's store"
  assert_eq "$(digest_of "$FACTORY_HOME/.codex/auth.json")" "$codex" "Codex's store"
  assert_absent "$SETTINGS"
  assert_absent "$KEY_FILE"
  assert_contains "$(cat /var/log/fffactory/credentials.log)" \
    "anthropic: not delivered; Claude Code's API key helper removed"
  local out
  out="$(cat "$OUT")"
  assert_contains "$out" '"id": "github",
        "state": "enrolled"'
  assert_contains "$out" '"id": "anthropic",
        "state": "pending"'
}

test_managed_settings_not_fffactorys_are_kept_when_anthropic_is_not_delivered() {
  local policy='{
  "permissions": {
    "deny": ["WebFetch"]
  }
}'
  install -d -o root -g root -m 0755 /etc/claude-code
  printf '%s\n' "$policy" >"$SETTINGS"
  activate /fixtures/host.json
  assert_status 0
  assert_eq "$(cat "$SETTINGS")" "$policy" "$SETTINGS"
  assert_contains "$(cat /var/log/fffactory/credentials.log)" \
    "anthropic: not delivered; Claude Code's managed settings kept: they do not name fffactory's helper"
}

test_a_secret_it_cannot_read_fails_the_install_naming_the_account_only() {
  touch /tmp/aws-fail-openai-api-key
  activate
  assert_status 1
  local out
  out="$(cat "$OUT")"
  assert_contains "$out" '"name": "credentials",
      "status": "failed",
      "reason": "openai: reading its secret failed (AccessDeniedException)"'
  assert_not_contains "$out" "arn:aws"
  # Every secret is read before any tool runs.
  assert_not_contains "$(cat /tmp/gh.args 2>/dev/null)" "auth login"
  assert_contains "$(cat /var/log/fffactory/credentials.log)" \
    "--- fffactory: step credentials failed: openai: reading its secret failed (AccessDeniedException)"
}

test_a_refused_token_fails_the_install_and_keeps_the_previous_login() {
  activate
  assert_status 0
  local before
  before="$(digest_of "$FACTORY_HOME/.config/gh/hosts.yml")"
  secret github-token "gho_$(random)"
  activate
  assert_status 1
  assert_contains "$(cat "$OUT")" '"reason": "github: gh auth login exited with status 1"'
  assert_eq "$(digest_of "$FACTORY_HOME/.config/gh/hosts.yml")" "$before" "gh's store"
}

test_empty_material_is_refused_before_gh_starts_its_device_flow() {
  secret github-token ""
  activate
  assert_status 1
  assert_contains "$(cat "$OUT")" '"reason": "github: its secret is empty"'
  assert_not_contains "$(cat /tmp/gh.args 2>/dev/null)" "auth login"
}

test_verify_reports_anthropic_pending_while_its_key_file_is_empty() {
  activate
  assert_status 0
  : >"$KEY_FILE"
  run /opt/fffactory/current/bin/fffactory host verify --json
  assert_status 0
  assert_contains "$(cat "$OUT")" '"id": "anthropic",
      "state": "pending"'
  rm "$KEY_FILE"
  run /opt/fffactory/current/bin/fffactory host verify --json
  assert_status 0
  assert_contains "$(cat "$OUT")" '"id": "anthropic",
      "state": "pending"'
}
