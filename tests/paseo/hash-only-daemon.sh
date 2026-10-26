#!/usr/bin/env bash
# Proves, against the pinned Paseo, that the daemon a worker runs authenticates with only the
# bcrypt hash fffactory writes, that nothing it launches sees PASEO_PASSWORD, that it downloads
# no speech model with the merged config, and that it accepts factory-dispatch's launch and list
# flags (docs/specs/control-plane.md §The Paseo pin):
#
#   tests/paseo/hash-only-daemon.sh            # just paseo-check
#
# It downloads the package pinned in assets/steps/control-plane/versions.env, checks its
# integrity and installs it, without its install scripts, into a private prefix. The hash is the
# one the real control-plane install hands setup (hash-main.ts), merged by the real
# paseo-config.sh as setup hands it over, and the daemon is started by paseo.service's own
# ExecStartPre and ExecStart, their paths moved into a temporary home. It runs in a user, network
# and PID namespace with only loopback, with an environment holding only what the unit sets, so
# it never meets this machine's own Paseo, network or credentials, and the daemon and its agents
# die with the namespace however the check ends. A stand-in `claude` on the daemon's PATH records
# the environment an agent is launched with.
#
# Needs Linux with unprivileged user namespaces (unshare), Node.js 22 with npm, jq, curl,
# python3, Bun, and the network to download the package.
set -Eeuo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
readonly root
readonly control_plane="${root}/assets/steps/control-plane"
readonly port=6767

fail() {
  echo "paseo check: $*" >&2
  exit 1
}
pass() { echo "paseo check: $*"; }

# Inside the namespace: start the daemon as the unit does, then probe it.
sandboxed() {
  local work=$1 home=$1/home paseo_home=$1/home/.paseo bin=$1/home/.local/bin
  local unit_env=(HOME="${home}" PASEO_HOME="${paseo_home}" PATH="${bin}:/usr/local/bin:/usr/bin:/bin")
  local pre start daemon status out
  python3 - <<'PYTHON'
import fcntl, socket, struct
# Bring loopback up: the namespace's only interface, and down until then.
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
flags = struct.unpack("16sH14x", fcntl.ioctl(s, 0x8913, struct.pack("16sH14x", b"lo", 0)))[1]
fcntl.ioctl(s, 0x8914, struct.pack("16sH14x", b"lo", flags | 1))
PYTHON

  pre="$(sed -n 's/^ExecStartPre=//p' "${control_plane}/paseo.service")"
  start="$(sed -n 's/^ExecStart=//p' "${control_plane}/paseo.service")"
  pre=${pre//\/home\/factory/${home}}
  start=${start//\/home\/factory/${home}}
  [[ -n ${pre} && -n ${start} ]] || fail 'paseo.service lacks its ExecStartPre or ExecStart'

  # ExecStartPre refuses the config merged without a hash, as for a host with no reference or
  # one removed, so no daemon ever starts open or on a password fffactory no longer references.
  if eval "env -i ${unit_env[*]@Q} ${pre/"${paseo_home}/config.json"/"${work}/no-password/config.json"}" >/dev/null 2>&1; then
    fail 'ExecStartPre accepted a config merged without a password'
  fi
  pass 'ExecStartPre refuses a config merged without a password'
  eval "env -i ${unit_env[*]@Q} ${pre}" >/dev/null || fail 'ExecStartPre refused the merged config'

  # exec, so $! is the daemon itself: this shell, unshare's child, inherits SIGTERM ignored and
  # cannot reset it, so a shell left between would outlive the kill below.
  eval "exec env -i ${unit_env[*]@Q} ${start}" >"${work}/daemon.log" 2>&1 &
  daemon=$!
  for _ in $(seq 120); do
    curl -fsS -o /dev/null "http://127.0.0.1:${port}/api/health" 2>/dev/null && break
    kill -0 "${daemon}" 2>/dev/null || fail 'the daemon exited at start'
    sleep 0.5
  done
  curl -fsS -o /dev/null "http://127.0.0.1:${port}/api/health" || fail 'the daemon never became healthy'
  # shellcheck disable=SC1091
  source "${control_plane}/versions.env"
  [[ $("${bin}/paseo" --version) == "${PASEO_VERSION}" ]] || fail "paseo --version is not ${PASEO_VERSION}"
  pass "Paseo ${PASEO_VERSION} is healthy"

  # /proc holds only this namespace's processes: the daemon's whole tree (CLI, supervisor,
  # daemon, workers) and this check.
  local environ
  [[ -r /proc/${daemon}/environ ]] || fail "the daemon is not in this namespace's /proc"
  for environ in /proc/[0-9]*/environ; do
    if { tr '\0' '\n' <"${environ}" 2>/dev/null || true; } | grep -q '^PASEO_PASSWORD='; then
      fail "process ${environ//[^0-9]/} has PASEO_PASSWORD in its environment"
    fi
  done
  pass 'no daemon process has PASEO_PASSWORD in its environment'

  status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/status")"
  [[ ${status} == 401 ]] || fail "an unauthenticated request was answered ${status}, not 401"
  pass 'an unauthenticated request is refused'

  # fffactory's own CLI calls: paseo-auth.sh as the adapter runs it, a stand-in aws answering the
  # password (aws-right) or another (aws-wrong), from a home that has no local credential.
  as_factory() {
    local aws=$1
    shift
    env -i HOME="${work}/cli" PATH="${bin}:/usr/bin:/bin" \
      FACTORY_PASEO_SECRET_REFERENCE="${work}/secret-arn" FACTORY_PASEO_AWS_BIN="${work}/${aws}" \
      "${control_plane}/paseo-auth.sh" "$@" --host "127.0.0.1:${port}"
  }
  mkdir -p "${work}/cli"
  # Health answers before the daemon accepts clients, which it refuses (503) until it has started.
  for _ in $(seq 120); do
    out="$(as_factory aws-right agent ls --json 2>&1)" && break
    [[ ${out} == *'Unexpected server response: 503'* ]] || break
    sleep 0.5
  done
  out="$(as_factory aws-right agent ls --json 2>&1)" || fail "the right password was refused: ${out}"
  [[ $(jq -r 'type' <<<"${out}") == array ]] || fail 'agent ls printed no array'
  pass 'the right password connects (paseo-auth.sh)'
  if out="$(as_factory aws-wrong agent ls --json 2>&1)"; then
    fail 'a wrong password connected'
  fi
  [[ ${out} == *AUTH_FAILED* ]] || fail "a wrong password failed for another reason: ${out}"
  pass 'a wrong password is refused (AUTH_FAILED)'
  if out="$(env -i HOME="${work}/cli" PATH="${bin}:/usr/bin:/bin" "${bin}/paseo" agent ls --json \
    --host "127.0.0.1:${port}" 2>&1)"; then
    fail 'no password connected'
  fi
  pass 'no password is refused'

  # Launched and listed with the flags factory-dispatch uses; like it, read only standard output
  # (0.12+ notes a created workspace on standard error).
  out="$(as_factory aws-right run --provider claude --cwd "${home}" --no-wait --json \
    --label factory-dispatch=true 'Report your environment.' 2>"${work}/run.err")" ||
    fail "the agent could not be started: $(<"${work}/run.err")"
  local agent_id
  agent_id="$(jq -er '.agentId' <<<"${out}")" || fail "the agent's launch printed no agentId: ${out}"
  out="$(as_factory aws-right ls --global --background --label factory-dispatch=true --json 2>&1)" ||
    fail "the dispatcher's agent list failed: ${out}"
  [[ $(jq -r '[.[].id] | join(" ")' <<<"${out}") == "${agent_id}" ]] ||
    fail "the dispatcher's agent list does not show exactly the launched agent: ${out}"
  pass "an agent launched with --no-wait is listed with ls --global --background"
  local launched=""
  for _ in $(seq 60); do
    launched="$(grep -l '^PASEO_AGENT_ID=' "${work}"/claude-env.* 2>/dev/null | head -n 1 || true)"
    [[ -n ${launched} ]] && break
    sleep 0.5
  done
  [[ -n ${launched} ]] || fail 'no agent was launched'
  if grep -q '^PASEO_PASSWORD=' "${work}"/claude-env.*; then
    fail "an agent's environment has PASEO_PASSWORD"
  fi
  pass "an agent's environment has no PASEO_PASSWORD"

  # The merged speech switches: the daemon, healthy for a while now, has started no download of
  # its local speech models.
  if grep -rqs 'download for missing local speech models' "${work}/daemon.log" "${paseo_home}"/*.log ||
    [[ -n $(ls -A "${paseo_home}/models/local-speech" 2>/dev/null) ]]; then
    fail 'the daemon started downloading its speech models'
  fi
  pass 'the daemon downloads no speech model'

  kill "${daemon}"
  wait "${daemon}" 2>/dev/null || true
}

if [[ ${1:-} == --sandboxed ]]; then
  sandboxed "$2"
  exit 0
fi

for tool in unshare node npm jq curl python3 bun; do
  command -v "${tool}" >/dev/null || fail "${tool} is required"
done
work="$(mktemp -d)"
readonly work
trap 'rm -rf -- "${work}"' EXIT
mkdir -p "${work}/home/.paseo" "${work}/home/.local/bin" "${work}/npm-home"
chmod 0700 "${work}/home/.paseo"

# shellcheck disable=SC1091
source "${control_plane}/versions.env"
# Private HOME and cache, so no npm configuration or cache of this machine is read or written.
npm_private=(env HOME="${work}/npm-home" npm_config_cache="${work}/npm-cache" npm_config_userconfig=/dev/null)
"${npm_private[@]}" npm pack "@getpaseo/cli@${PASEO_VERSION}" --pack-destination "${work}" --json \
  >"${work}/pack.json" 2>/dev/null || fail 'the Paseo download failed'
[[ $(jq -er '.[0].integrity' "${work}/pack.json") == "${PASEO_INTEGRITY}" ]] ||
  fail 'Paseo package integrity mismatch'
"${npm_private[@]}" npm install --global --prefix "${work}/prefix" --ignore-scripts --no-audit \
  --no-fund "${work}/$(jq -er '.[0].filename' "${work}/pack.json")" >/dev/null 2>&1 ||
  fail 'the Paseo install failed'
ln -s "${work}/prefix/bin/paseo" "${work}/home/.local/bin/paseo"
# The provider stand-in: it records its environment and exits.
cat >"${work}/home/.local/bin/claude" <<STANDIN
#!/bin/sh
env >"${work}/claude-env.\$\$"
[ "\$1" = --version ] && echo '2.1.302 (Claude Code)'
exit 0
STANDIN
chmod 0755 "${work}/home/.local/bin/claude"
# Secrets Manager stand-ins for paseo-auth.sh: the value as `--output text` prints it.
echo 'arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-aaaa1111/paseo-AbCdEf' >"${work}/secret-arn"
printf '#!/bin/sh\ncat %q; echo\n' "${work}/password" >"${work}/aws-right"
printf '#!/bin/sh\necho wrong-password\n' >"${work}/aws-wrong"
chmod 0755 "${work}/aws-right" "${work}/aws-wrong"

head -c 18 /dev/urandom | base64 | tr -d '\n' >"${work}/password"
hash="$(bun "${root}/tests/paseo/hash-main.ts" <"${work}/password")"
# The merge as setup-host.sh hands it the hash (empty for a host with no reference) and the config.
merge() {
  # shellcheck disable=SC2016 # expanded by that shell
  printf '%s\n' "$1" | env -i PATH=/usr/bin:/bin FACTORY_PASEO_CONFIG="$2" \
    FACTORY_PASEO_LISTEN="127.0.0.1:${port}" FACTORY_PASEO_HOSTNAMES=localhost \
    /bin/bash -c 'IFS= read -r FACTORY_PASEO_PASSWORD_HASH || true; export FACTORY_PASEO_PASSWORD_HASH; exec "$1"' \
    paseo-config "${control_plane}/paseo-config.sh"
}
merge "${hash}" "${work}/home/.paseo/config.json" || fail 'the config merge failed'
jq -e '.features.dictation.enabled == false and .features.voiceMode.enabled == false' \
  "${work}/home/.paseo/config.json" >/dev/null || fail 'config.json leaves speech switched on'
[[ $(jq -r '.daemon.auth.password' "${work}/home/.paseo/config.json") == "${hash}" ]] ||
  fail 'config.json does not hold the hash'
if grep -qF -- "$(<"${work}/password")" "${work}/home/.paseo/config.json"; then
  fail 'config.json holds the password'
fi
pass 'config.json holds only the hash'
# A host whose reference was removed: its next install merges no hash over the old config.
mkdir -m 0700 "${work}/no-password"
cp -- "${work}/home/.paseo/config.json" "${work}/no-password/config.json"
merge '' "${work}/no-password/config.json" || fail 'the config merge without a hash failed'
jq -e '.daemon.auth | has("password") | not' "${work}/no-password/config.json" >/dev/null ||
  fail 'the config merged without a hash still holds a password'
pass 'a config merged without a hash holds no password'

# --pid --fork makes the sandboxed check PID 1 of its namespace, so every process it starts
# dies with it, even when a check fails; --mount-proc lets it read those processes' /proc.
env -i PATH=/usr/bin:/bin unshare --user --map-root-user --net --pid --fork --kill-child \
  --mount-proc "$0" --sandboxed "${work}"
echo "paseo check: passed"
