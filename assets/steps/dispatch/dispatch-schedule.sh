#!/usr/bin/env bash

# Reconcile or verify the one factory-owned Paseo schedule on this host.
set -euo pipefail

readonly DEFAULT_PROJECTION=/var/lib/fffactory/dispatch.json
readonly SCHEDULE_NAME=factory-dispatch

mode=check
projection=${FACTORY_DISPATCH_PROJECTION:-${DEFAULT_PROJECTION}}
paseo=${FACTORY_PASEO_BIN:-/opt/fffactory/current/steps/control-plane/paseo-auth.sh}

usage() {
  echo 'Usage: dispatch-schedule.sh [--check | --apply] [--projection PATH]'
}

fail() {
  printf 'factory dispatch schedule: %s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case $1 in
    --check | --apply) mode=${1#--} ;;
    --projection) (($# >= 2)) || fail '--projection requires a path'; projection=$2; shift ;;
    -h | --help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

[[ ${EUID} -ne 0 ]] || fail 'run as the factory user'
[[ -r ${projection} ]] || fail "projection is unreadable: ${projection}"
command -v jq >/dev/null || fail 'jq is required'
command -v "${paseo}" >/dev/null || fail "Paseo is unavailable: ${paseo}"

desired=$(jq -ec '
  if .protocol_version != 1
    or (.hostname | type) != "string"
    or (.requested | type) != "boolean"
    or (.active | type) != "boolean"
    or (.blockers | type) != "array"
  then error("invalid projection") else . end
  | if .active != true then {enabled: false}
    else
      if .requested != true or (.blockers | length) != 0 or (.schedule | type) != "object"
      then error("active dispatch is not requested and unblocked") else . end
      | {
          enabled: true,
          name: "factory-dispatch",
          cron: .schedule.cron,
          timezone: .schedule.timezone,
          provider: .schedule.provider,
          model: .schedule.model,
          mode: .schedule.mode,
          cwd: .schedule.cwd,
          prompt: "/dispatch"
        }
    end
' "${projection}") || fail 'invalid dispatch projection'
host=$(jq -er '.hostname' "${projection}") || fail 'invalid dispatch hostname'

enabled=$(jq -r .enabled <<<"${desired}")
if [[ ${enabled} == true ]]; then
  cwd=$(jq -r .cwd <<<"${desired}")
  [[ -d ${cwd} && ! -L ${cwd} ]] || fail "dispatch working directory is unavailable: ${cwd}"
fi

schedule_rows=$("${paseo}" schedule ls --json) || fail 'could not list Paseo schedules'
jq -e 'type == "array"' <<<"${schedule_rows}" >/dev/null || fail 'Paseo returned invalid schedule list'
ids=$(jq -r --arg name "${SCHEDULE_NAME}" '.[] | select((.name // "") | startswith($name)) | .id' <<<"${schedule_rows}")
count=$(jq -r --arg name "${SCHEDULE_NAME}" '[.[] | select((.name // "") | startswith($name))] | length' <<<"${schedule_rows}")
((count <= 1)) || fail "${count} factory dispatch schedules exist"

current='null'
if ((count == 1)); then
  current=$("${paseo}" schedule inspect "${ids}" --json) || fail 'could not inspect factory dispatch schedule'
  jq -e 'type == "object"' <<<"${current}" >/dev/null \
    || fail 'factory dispatch schedule is malformed'
fi

matches=false
if [[ ${enabled} == false ]]; then
  [[ ${current} == null ]] && matches=true
else
  # Inspection includes unbounded run history; feed it on stdin, never in argv.
  if jq -e --argjson desired "${desired}" '
    . as $current
    | $current != null
    and $current.name == $desired.name
    and $current.prompt == $desired.prompt
    and $current.cadence == {type:"cron", expression:$desired.cron, timezone:$desired.timezone}
    and $current.target.type == "new-agent"
    and $current.target.config.provider == $desired.provider
    and $current.target.config.model == $desired.model
    and $current.target.config.modeId == $desired.mode
    and $current.target.config.cwd == $desired.cwd
    and $current.target.config.thinkingOptionId == null
    and $current.maxRuns == null
    and $current.expiresAt == null
    and $current.status == "active"
  ' <<<"${current}" >/dev/null; then
    matches=true
  fi
fi

if [[ ${matches} == false && ${mode} == apply ]]; then
  if [[ ${enabled} == false ]]; then
    "${paseo}" schedule delete "${ids}" --json >/dev/null
    current=null
  elif [[ ${current} == null ]]; then
    "${paseo}" schedule create --cron "$(jq -r .cron <<<"${desired}")" \
      --timezone "$(jq -r .timezone <<<"${desired}")" \
      --name "${SCHEDULE_NAME}" \
      --provider "$(jq -r '.provider + "/" + .model' <<<"${desired}")" \
      --mode "$(jq -r .mode <<<"${desired}")" \
      --cwd "${cwd}" "$(jq -r .prompt <<<"${desired}")" --json >/dev/null
  elif [[ $(jq -r '
    .target.type != "new-agent" or .target.config.thinkingOptionId != null
    or .status == "completed"
  ' <<<"${current}") == true ]]; then
    # Paseo's update reaches only new-agent schedules, has no thinking option flag, and
    # cannot reopen a completed schedule. Recreate only when an in-place update cannot
    # reach the declared state: recreating drops the schedule's identity and run history.
    "${paseo}" schedule delete "${ids}" --json >/dev/null
    "${paseo}" schedule create --cron "$(jq -r .cron <<<"${desired}")" \
      --timezone "$(jq -r .timezone <<<"${desired}")" \
      --name "${SCHEDULE_NAME}" \
      --provider "$(jq -r '.provider + "/" + .model' <<<"${desired}")" \
      --mode "$(jq -r .mode <<<"${desired}")" \
      --cwd "${cwd}" "$(jq -r .prompt <<<"${desired}")" --json >/dev/null
  else
    # Paseo 0.11.4 clears limits in place (0.9.1 misread its negated flags as values).
    # Only a limit that is set is cleared, so an ordinary update sends neither flag.
    clear_limits=()
    [[ $(jq -r '.maxRuns != null' <<<"${current}") == true ]] && clear_limits+=(--no-max-runs)
    [[ $(jq -r '.expiresAt != null' <<<"${current}") == true ]] && clear_limits+=(--no-expires-in)
    "${paseo}" schedule update "${ids}" \
      --cron "$(jq -r .cron <<<"${desired}")" \
      --timezone "$(jq -r .timezone <<<"${desired}")" \
      --name "${SCHEDULE_NAME}" --prompt "$(jq -r .prompt <<<"${desired}")" \
      --provider "$(jq -r '.provider + "/" + .model' <<<"${desired}")" \
      --mode "$(jq -r .mode <<<"${desired}")" --cwd "${cwd}" \
      ${clear_limits[@]+"${clear_limits[@]}"} --json >/dev/null
    if [[ $(jq -r .status <<<"${current}") != active ]]; then
      "${paseo}" schedule resume "${ids}" --json >/dev/null
    fi
  fi
  exec "$0" --check --projection "${projection}"
fi

status=absent
[[ ${enabled} == true ]] && status=active
[[ ${matches} == true ]] || status=drift
jq -nc --arg host "${host}" --arg status "${status}" \
  --arg id "${ids}" --argjson desired "${desired}" \
  '{host:$host, status:$status, schedule_id:(if $id == "" then null else $id end), desired:$desired}'
[[ ${matches} == true ]] || fail 'schedule differs from declared state'
