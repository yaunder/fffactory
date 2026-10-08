#!/usr/bin/env bash

# Authenticate factory-owned Paseo CLI calls without persisting the raw password.
set -euo pipefail

readonly secret_reference=${FACTORY_PASEO_SECRET_REFERENCE:-/home/factory/.config/fffactory/paseo-password-secret-arn}
readonly aws_bin=${FACTORY_PASEO_AWS_BIN:-aws}
readonly paseo_bin=${FACTORY_PASEO_INNER_BIN:-paseo}

fail() {
  printf 'factory Paseo authentication: %s\n' "$*" >&2
  exit 1
}

[[ -r ${secret_reference} ]] || fail 'Paseo password secret reference is unreadable'
command -v "${aws_bin}" >/dev/null || fail 'AWS CLI is unavailable'
command -v "${paseo_bin}" >/dev/null || fail 'Paseo is unavailable'

IFS= read -r secret_arn <"${secret_reference}" || true
[[ -n ${secret_arn} ]] || fail 'no Paseo password secret is declared'
IFS=: read -r arn_prefix partition service region account resource <<<"${secret_arn}"
[[ ${arn_prefix} == arn && ${service} == secretsmanager && -n ${region} ]] \
  || fail 'invalid Paseo password secret ARN'

# Secrets Manager holds the same password as the daemon's stored bcrypt hash.
# Command substitution keeps its value out of logs and argv; do not trace this
# script or print the environment.
password=$("${aws_bin}" secretsmanager get-secret-value \
  --region "${region}" --secret-id "${secret_arn}" \
  --query SecretString --output text) \
  || fail 'could not read the Paseo password from Secrets Manager'
[[ -n ${password} && ${password} != None ]] || fail 'Paseo password secret is empty'
export PASEO_PASSWORD="${password}"
unset password

exec "${paseo_bin}" "$@"
