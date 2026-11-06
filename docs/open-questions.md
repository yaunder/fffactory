# Open questions

Questions raised during planning or work that were left open on purpose. Each
names what is known, why it waits, and the trigger to revisit it. When one is
settled, delete it here and record the outcome where it belongs: a spec, a
decision record, an issue, or the design's [explicitly deferred
improvements](designs/fffactory-v2.md#explicitly-deferred-improvements).

## Every worker process can read every secret the host role allows

**Raised by:** [#55](https://github.com/yaunder/fffactory/issues/55) planning, 2026-10-16.

One IAM role serves every host of a factory, and it may `GetSecretValue` on
the Tailscale auth key and every host's Paseo password
(`assets/terraform/factory/main.tf`, `secret_arns`). The instance metadata
service answers any local process, so anything running as `factory`,
including the agents Paseo launches, can read all of them. Credentials
delivered by #55 join that set, and a key meant for one worker is readable
from every worker.

**Why it waits:** #55's bar is that workers never receive operator-only
secrets, such as the Tailscale admin client, and that still holds. Narrowing
the role per host, or keeping agents from the instance role, is a separate
change.

**Revisit when:** a factory runs workers for different trust levels, or a
worker runs code from outside the operator's repositories.

## A rotated Paseo password has no path to a running worker

**Raised by:** #55 planning, 2026-10-16.

`fffactory secret set paseo-password --host KEY` rotates the value under the
same ARN. Plan cannot see that, since only the ARN is in factory.json and the
host projection, so no control-plane change is planned. The daemon keeps the
old password until something restarts it, while `paseo-auth.sh`'s CLI calls
fetch the new one at once and would fail to authenticate. Once #55 configures
the daemon with only the password's hash, that hash is likewise rewritten
only by a planned control-plane install.

**Why it waits:** #55 designs renewal for the GitHub and model-provider
credentials only.

**Revisit when:** a Paseo password is first rotated, or #55's renewal
mechanism lands and could be extended to it.

## Account checks do not prove a delivered key works

**Raised by:** #55 planning, 2026-10-17.

Readiness counts an account enrolled when its status command exits 0
([readiness §Enrollment](specs/readiness.md#enrollment)). `gh auth status`
asks GitHub about the token, but the others never try the key, as the #55
spikes confirmed on 2026-10-17. `codex login status` only reads
`~/.codex/auth.json`, and `codex login --with-api-key` accepts any string.
`claude auth status` does not even run the `apiKeyHelper`. A revoked,
mistyped or unfunded API key could then leave a worker reported usable and fail
only once an agent runs.

`gh auth status` has a related blind spot: offline, it reports the token
invalid and exits 1, so readiness cannot tell an outage from a bad token.

**Why it waits:** #55 keeps the existing checks, so both login paths are
judged the same way. Proving a key would cost a provider call on every
verify, and the external release verifier exercises a real agent anyway.

**Revisit when:** a worker is reported usable with a provider key that fails
in use.

## A Claude agent that fails to authenticate looks finished

**Raised by:** #55 planning, 2026-10-17.

With an invalid key, Claude Code retries about ten times with backoff, roughly
four minutes, then stops. Paseo then shows the agent `idle`, as for one that
completed, while a Codex agent that fails the same way shows `error`. Dispatch
and anything watching agent status cannot tell a failed Claude dispatch from a
finished one.

**Why it waits:** it affects interactive logins that expire as much as
delivered keys, and dispatch's outcome model is outside #55.

**Revisit when:** dispatch reports outcomes per agent, or a dispatched issue
silently stalls after a credential failure.

## A Codex dispatch schedule cannot use `bypassPermissions`

**Raised by:** #55 planning, 2026-10-17.

Paseo's Codex modes are `auto`, `auto-review` and `full-access`. A Codex
agent started with `--mode bypassPermissions`, the Claude mode dispatch's tests
use, fails at once with `Invalid mode`. Whether factory.json validation catches
a Codex provider with a Claude mode is unchecked.

**Revisit when:** a factory first dispatches with the Codex provider.

## Paseo downloads speech models and needs memory to match

**Raised by:** #55 planning, 2026-10-17.

At start, the Paseo daemon downloads about 765 MB of local speech models into
`~/.paseo/models` and used about 790 MB of memory in the spike. Two daemons in
a 2 GiB VM got Paseo 0.11.4 killed for lack of memory three times. Workers do
not use dictation or voice.

**Revisit when:** Paseo's pin moves
([#46](https://github.com/yaunder/fffactory/issues/46)), or worker instance
sizes are chosen.

## Platform binaries escape the agent CLI integrity pins

**Raised by:** #55 planning, 2026-10-17.

`assets/steps/versions.env` pins each agent CLI's npm package by version and
integrity. Codex ships its native binary as an optional dependency
(`@openai/codex@VERSION-linux-x64`) that npm resolves separately, so that
pin does not cover it. Not checked for Claude Code.

**Revisit when:** the agent CLI pins next move, or release provenance is
audited.
