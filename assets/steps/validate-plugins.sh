#!/usr/bin/env bash
# Checks the plugin manifest's shape before the `plugins` step acts on it.
#
#   bash validate-plugins.sh MANIFEST
#
# Copied from v1's agent-harness/scripts/validate-plugins.sh (deleted in #102).
# TODO(re-evaluate when the plugins step is next changed, which D3 makes the time to port it
# to TypeScript): validate the manifest without jq.
set -Eeuo pipefail

manifest=${1:?usage: validate-plugins.sh MANIFEST}

jq -e '
  def keys_are($expected): (keys | sort) == ($expected | sort);
  keys_are(["schema", "providers"])
  and .schema == 1
  and (.providers | keys_are(["claude", "codex"]))
  and ([.providers[] | keys_are(["plugins"]) and (.plugins | type == "array")] | all)
  and ([.providers.codex.plugins[]] | length == 0)
  and ([.providers.claude.plugins[] |
    keys_are(["id", "version", "marketplace", "path", "source"])
    and (.id | test("^[a-z][a-z0-9-]*@[a-z][a-z0-9-]*$"))
    and (.version | test("^[0-9]+[.][0-9]+[.][0-9]+$"))
    and (.marketplace | test("^[a-z][a-z0-9-]*$"))
    and (.path | test("^[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*$"))
    and (. as $plugin | .id | endswith("@" + $plugin.marketplace))
    and (.source | keys_are(["type", "repository", "revision"])
      and .type == "github"
      and (.repository | test("^[a-zA-Z0-9][a-zA-Z0-9-]*/[a-zA-Z0-9][a-zA-Z0-9_.-]*$"))
      and (.revision | test("^[0-9a-f]{40}$")))
  ] | all)
  and ([.providers.claude.plugins[].id] | length == (unique | length))
  and ([.providers.claude.plugins[].marketplace] | length == (unique | length))
' "${manifest}" >/dev/null || {
  echo "Invalid plugin manifest: ${manifest}" >&2
  exit 1
}
