#!/usr/bin/env bash
# Merge the factory-owned daemon settings into Paseo's config.json, keeping every other setting.
# setup-host.sh runs it as factory with the worker's addresses; FACTORY_PASEO_CONFIG moves the
# file for tests/test_paseo_config.py.
set -Eeuo pipefail

readonly paseo_config=${FACTORY_PASEO_CONFIG:-/home/factory/.paseo/config.json}
# host:port the daemon listens on, the worker's Tailscale IPv4 and 6767.
readonly listen=${FACTORY_PASEO_LISTEN:-}
# Whitespace-separated: the exact names Paseo accepts in a Host header besides the listen address.
readonly hostnames=${FACTORY_PASEO_HOSTNAMES:-}
# The bcrypt hash of the host's Paseo password, never the password; empty, for a host that
# declares none, removes daemon.auth.password, so paseo.service's ExecStartPre keeps the daemon
# stopped rather than running on a password fffactory no longer references. jq reads it from the
# environment ($ENV), so it is never a command argument.
readonly password_hash=${FACTORY_PASEO_PASSWORD_HASH:-}

fail() { printf 'fffactory Paseo config: %s\n' "$*" >&2; exit 1; }

[[ -n ${listen} ]] || fail 'no Paseo listen address is given'
[[ -n ${hostnames//[[:space:]]/} ]] || fail 'no Paseo hostnames are given'
# Paseo's own form (bcryptjs): $2a$, $2b$ or $2y$, a two-digit cost, 53 characters of salt and hash.
[[ -z ${password_hash} || ${password_hash} =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] ||
  fail 'the Paseo password hash is invalid' # never echoed

current='{}'
if [[ -e ${paseo_config} ]]; then
  [[ -f ${paseo_config} && -r ${paseo_config} ]] || fail 'the Paseo config is unreadable'
  current="$(<"${paseo_config}")"
fi

# Written beside the config and renamed over it, so a failed merge leaves it as it was.
config_next="$(mktemp "${paseo_config}.XXXXXX")"
trap 'rm -f -- "${config_next}"' EXIT
# daemon.hostnames is factory-owned: replaced, never merged, and never `true` (any host).
printf '%s\n' "${current}" | jq --slurp --arg listen "${listen}" --arg hostnames "${hostnames}" '
  if length != 1 then error("config must be one JSON value") else .[0] end
  | if type != "object" then error("config root must be an object") else . end
  | .["$schema"] = "https://paseo.sh/schemas/paseo.config.v1.json"
  | .version = 1
  | .daemon = (.daemon // {})
  | if (.daemon | type) != "object" then error("daemon must be an object") else . end
  | .daemon.listen = $listen
  | .daemon.relay = ((.daemon.relay // {}) + {enabled: false})
  | .daemon.hostnames = [$hostnames | splits("\\s+") | select(length > 0)]
  | if (.daemon.auth // {} | type) != "object" then error("daemon.auth must be an object")
    elif ($ENV.FACTORY_PASEO_PASSWORD_HASH // "") != "" then
      .daemon.auth = ((.daemon.auth // {}) + {password: $ENV.FACTORY_PASEO_PASSWORD_HASH})
    elif .daemon.auth == null then .
    else del(.daemon.auth.password) end
' >"${config_next}" 2>/dev/null || fail 'the existing Paseo config is invalid' # jq's message can quote the config
mv -f -- "${config_next}" "${paseo_config}"
