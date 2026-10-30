# Credential delivery

A worker's three accounts, `github`, `openai` and `anthropic`
([readiness §Enrollment](readiness.md#enrollment)), can be supplied as API
credentials instead of a human's login. The operator stores each with
`fffactory secret set` ([secrets §The API credentials](secrets.md#the-api-credentials));
factory.json keeps its ARN, and each host's projection carries the references
delivered to it
([host protocol §The host projection](host-protocol.md#the-host-projection)).
On every `host apply`, the `credentials` install step reads each delivered
secret on the worker and writes it into the tool's own credential store, so
the verifier, the dispatch gate, the Paseo daemon and the agents it launches
all see the same login a human would have made. Decisions D1–D19 of
[#55](https://github.com/yaunder/fffactory/issues/55); the recipes were
characterized against gh 2.102.0 (not pinned: `packages.sh` installs whatever
cli.github.com serves, and the recipe relies on its `auth status --json hosts`
and `--active`) and the pinned Codex 0.163.0, Claude Code 2.1.302 and Paseo
0.11.4. Paseo 0.13.2, pinned since, launches both providers the same way.

Logging in by hand keeps working. An account is delivered to a host when
factory.json references its credential and the host does not list it in
`interactive_logins` (`deliveredAccounts`,
[instance configuration §API credentials](instance-configuration.md#api-credentials));
every other account stays on a human's login.

## The `credentials` step

The install step after `plugins` and before `collector` (`INSTALL_STEPS`,
[host protocol §`host apply` on the worker](host-protocol.md#host-apply-on-the-worker)):
native TypeScript (`src/host/credentials.ts`), run as root inside `host
apply`'s install lock and record, within a 10-minute budget. In order:

1. **Read** each delivered account's secret, in the order GitHub, OpenAI,
   Anthropic, as root with the worker's instance role:

   ```text
   /usr/bin/aws secretsmanager get-secret-value --region REGION --secret-id ARN --query SecretString --output json
   ```

   `REGION` is the ARN's, which factory.json's validation makes the factory
   Region. The environment is only `PATH`, `HOME=/root`, `LANG` and
   `AWS_PAGER=`. Its standard output is captured in memory, read as a JSON
   string, and kept as a `SecretMaterial`; it is never logged.
2. **Check** each: trimmed, it must be non-empty and hold no whitespace. Empty
   material would start gh's device flow, which waits about 15 minutes even
   without a terminal. Every secret is read and checked before any tool runs,
   so one bad secret changes nothing.
3. **Deliver** each, in the same order, with the material only on the
   command's standard input or in a 0600 file. Every command has a deadline:
   60 s for `gh auth login` and `codex login` (`CREDENTIAL_LOGIN_TIMEOUT_MS`),
   30 s for every other (`CREDENTIAL_COMMAND_TIMEOUT_MS`), each within what
   remains of the step's budget.
4. **Compose** Claude Code's managed settings from what fffactory needs
   ([Managed settings](#managed-settings)), and **remove** fffactory's own
   Claude Code files when Anthropic is not delivered ([Removal](#removal)).

Commands as `factory` run through
`runuser -u factory -- /usr/bin/env -i HOME=/home/factory PATH=/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 DISABLE_UPDATES=1`,
from `/home/factory`: no `GH_TOKEN`, `GITHUB_TOKEN` or API key variable can
reach them, and `gh auth login --with-token` refuses to run while `GH_TOKEN` is
set.

### Recipes

| Account | Delivery | Store |
| --- | --- | --- |
| `github` (D16) | As `factory`: the token on standard input to `gh auth login --with-token --hostname github.com --git-protocol https --insecure-storage`; `gh auth setup-git --hostname github.com`; `gh auth status --hostname github.com --json hosts`, then `gh auth logout --hostname github.com --user LOGIN` for every listed account that is not active. | `~factory/.config/gh/hosts.yml` (0600, plaintext: a worker has no keyring, and `--insecure-storage` makes the location fixed); `~factory/.gitconfig` (gh as Git's credential helper for github.com, which `git fetch` and the repository sync need). |
| `openai` | As `factory`: the key on standard input to `codex login --with-api-key`. | `~factory/.codex/auth.json` (0600), the file store `/etc/codex/requirements.toml` enforces ([host protocol §Agent pins](host-protocol.md#agent-pins)). |
| `anthropic` (D12) | As `factory`: `install -d -m 0700 ~factory/.config/fffactory`; `install -m 0600 /dev/null ~factory/.config/fffactory/anthropic-api-key.new`, then the key on standard input to `dd of=…/anthropic-api-key.new status=none` (which reads its own standard input: as `factory`, reopening root's pipe as `/dev/stdin` is refused); `mv -fT` it over `anthropic-api-key`. Then, as root, Claude Code's managed settings naming the helper ([Managed settings](#managed-settings)). | `~factory/.config/fffactory/anthropic-api-key` (0600 factory:factory, directory 0700), and `/etc/claude-code/managed-settings.json` holding `"apiKeyHelper": "cat /home/factory/.config/fffactory/anthropic-api-key"`. |

- A configured account is authoritative (D5) and reasserted on every apply.
  gh keeps a second account when a token of another user logs in, and `gh
  auth status` fails while any stored account is invalid, so every
  non-active github.com account is logged out. An account list gh cannot give,
  or a login that is not a GitHub login name (letters, digits, `-` and `_`,
  starting with a letter or digit: an Enterprise Managed User's is
  `handle_shortcode`), fails the step rather than leave a stale account; a
  login is `gh auth logout`'s argument, so none can read as an option. A
  configured API key replaces a Codex or Claude subscription login: `codex
  login --with-api-key` rewrites `auth.json` whole, and Claude Code prefers the
  helper's key to a stored subscription.
- The key file is written as `factory`, never by root in a directory `factory`
  owns. Claude Code runs the helper as `factory`. The managed settings are
  root-owned, so an agent cannot change them, and Claude Code reads them even
  under the SDK's `settingSources: []`. The key is never in an environment
  variable (D12): `env.ANTHROPIC_API_KEY` would reach every hook and tool child.
- Delivering Anthropic makes the managed settings fffactory's: whatever the
  file held before, another helper or an organisation's policy, is replaced
  whole and not kept anywhere, as the account is authoritative (D5) and the
  helper must be the one Claude Code reads (D12). A worker is fffactory's own
  machine, where nothing else places that file; a policy the agents need there
  instead keeps Anthropic on a human's login (`interactive_logins`). Enabling
  the log archive does the same, with `cleanupPeriodDays` in place of or
  beside the helper ([Managed settings](#managed-settings)).
- Each step is idempotent: a rerun issues the same commands and leaves the
  same bytes (gh replaces a same-user token in place; `setup-git` adds no
  duplicate lines).

### Managed settings

`/etc/claude-code/managed-settings.json` (root:root 0644, directory 0755) is
composed from what fffactory needs of Claude Code, as the projection says
(`claudeManagedSettingsJson`, `src/domain/installation.ts`):

| Anthropic delivered | `log_archive` in the projection | The file |
| --- | --- | --- |
| Yes | Yes | `{"apiKeyHelper": "cat /home/factory/.config/fffactory/anthropic-api-key", "cleanupPeriodDays": 3650}` |
| Yes | No | `{"apiKeyHelper": "cat /home/factory/.config/fffactory/anthropic-api-key"}` |
| No | Yes | `{"cleanupPeriodDays": 3650}` |
| No | No | None of fffactory's: removed only while it is fffactory's own ([Removal](#removal)). |

Each is two-space indented, keys in this order, with a final newline, written
whole to a private copy and renamed into place, after the key file when
Anthropic is delivered and before it is removed when it is not. A file
fffactory needs replaces whatever was there, as delivering Anthropic always
has. `cleanupPeriodDays: 3650` keeps Claude Code's session history for about
ten years while the
[log archive](instance-configuration.md#log-archive) is enabled, so evidence
stays on the worker until it is collected: Claude Code's default of 30 days
deletes older transcripts, and a managed (policy) value is honoured even under
Paseo's `--setting-sources=user,project,local`
([research](../research/worker-log-archive-collector.md)). The archive turned
off drops the key; the history Claude Code already kept is then cleaned up on
its default schedule.

The file is fffactory's own (`ownsManagedSettings`) only when it is a JSON
object holding at least one key, and only `apiKeyHelper` and
`cleanupPeriodDays`, each with fffactory's value. One more key, another value,
text that is not a JSON object, or a file that cannot be read is someone
else's policy, never removed.

### Removal

An account no longer delivered, because its reference was removed or the host
now lists it in `interactive_logins` (D4, D14):

- **GitHub and OpenAI**: untouched. Their stores are the tools' own, and a
  human may have logged in since. To end a delivered login, log out on the
  worker as `factory` (`gh auth logout --hostname github.com`, `codex logout`).
- **Anthropic**: first the managed settings lose the helper, then the key file
  goes (removed as `factory`), so the helper never names a missing file. While
  the log archive is enabled they are rewritten to keep the history alone
  ([Managed settings](#managed-settings)); otherwise they are removed, only
  while they are fffactory's own (`ownsManagedSettings`). Managed settings that
  are not, or that cannot be read, stay, untouched, and only the key file goes.
  Removing the helper is the only way back to a subscription login: `claude
  auth logout` leaves it.

### Failure

A secret that cannot be read, empty material, material holding whitespace, a
refused token (gh exits 1 on `HTTP 401`, leaving the previous login intact),
any command that fails or misses its deadline fails the step, and so the
install (D9); the later commands do not run. The step's `reason` names the
account (or `log_archive`, for managed settings that only keep the history)
and why, in fffactory's words only, never a tool's or the SDK's output,
an ARN or the material:

| Cause | Reason |
| --- | --- |
| The AWS CLI fails with an AWS error | `ACCOUNT: reading its secret failed (AccessDeniedException)` |
| The AWS CLI fails without one | `ACCOUNT: reading its secret failed (exit status 253)` |
| The read misses its deadline | `ACCOUNT: reading its secret timed out` |
| No AWS CLI | `ACCOUNT: reading its secret failed (the AWS CLI is not installed)` |
| Not a JSON string | `ACCOUNT: Secrets Manager's answer could not be read` |
| Empty, blank or no `SecretString` | `ACCOUNT: its secret is empty` |
| Holding whitespace | `ACCOUNT: its secret contains whitespace` |
| A tool exits non-zero | `github: gh auth login exited with status 1`, `openai: codex login exited with status 1`, `anthropic: writing its key file exited with status 1` |
| A tool misses its deadline | `ACCOUNT: gh auth login timed out` |
| gh's account list unreadable | `github: gh auth status gave no account list` |
| Managed settings it cannot write | `anthropic: writing Claude Code's managed settings failed (EACCES)`, or, keeping the history alone, `log_archive: ...` |

`codex login --with-api-key` accepts any string, and no check here proves a key
works against its provider (an open question,
[#64](https://github.com/yaunder/fffactory/issues/64)): a revoked key surfaces
when an agent uses it.

### Where the material never goes

Only in the AWS CLI's captured output, the delivering command's standard input
and the tool's store. Never in an argument (of `aws`, `gh`, `codex`, `install`
or anything else), an environment variable, the step's log, the install
record, `host apply`'s document or any message. No tool's output reaches the
step's log `/var/log/fffactory/credentials.log`: it holds fffactory's own
lines, `ACCOUNT: delivered` or, when Anthropic is not delivered, what became
of the managed settings: `anthropic: not delivered; Claude Code's managed
settings name no API key helper` (the history kept alone), `...; Claude Code's
managed settings removed`, `...; no managed settings of fffactory's to
remove`, `...; Claude Code's managed settings kept: they are not fffactory's`
or `...; Claude Code's managed settings kept: they could not be read (CODE)`;
while the log archive is enabled, `log_archive: Claude Code keeps its history
(cleanupPeriodDays 3650)`; then the step's last line.

### No first-launch state

The step writes no `~/.claude.json`, no onboarding flag and no trust entry
(D17): Paseo's launches (`claude` through the Agent SDK with
`--setting-sources=user,project,local`, and `codex app-server`) met no
onboarding, trust or approval prompt with these stores.

## Verify

`host verify`'s enrollment checks are the same for a delivered account as for a
human login ([readiness §Enrollment](readiness.md#enrollment)). GitHub's is
`gh auth status --hostname github.com --active` (D15), which a stale stored
account does not fail. Anthropic's also checks the key file (D15):
`claude auth status` passes on a configured helper without running it, even
with the key file missing. So while `/etc/claude-code/managed-settings.json`
names fffactory's helper (`apiKeyHelper` exactly
`cat /home/factory/.config/fffactory/anthropic-api-key`, whatever else it
holds, `namesKeyHelper`), `anthropic` is `enrolled` only when, as `factory`,
`test -r KEY -a -s KEY` also passes for the key file: a missing, unreadable or
empty key is `pending`. Every form the step composes passes: with the helper,
by the key file; with `cleanupPeriodDays` alone, by `claude auth status`.

A delivered account left `pending` or `unknown` names no login (D8): apply's
and status's next action, and the dispatch GitHub gate's, is to store a valid
credential with `fffactory secret set NAME` and run `fffactory apply`
([Renewal](#renewal)). The CLI knows an account is delivered from its own
factory.json, never from the worker's document.

## Renewal

`fffactory secret set NAME`, then `fffactory apply` (D6). The credential
reference does not change, so apply plans no Paseo maintenance and restarts no
daemon; every `host apply` reads and delivers the current value. The new value
reaches:

- **GitHub**: every later `gh` or Git call, at once.
- **OpenAI**: the next agent. Paseo starts one `codex app-server` per agent,
  and a running one keeps the key it read.
- **Anthropic**: the next agent; a running one re-runs the helper on a 401, or
  within Claude Code's 5-minute helper cache.

Keep the old key valid until the agents running at the apply have finished.
To stop delivering an account, remove its reference from `credentials` (or
list it in the host's `interactive_logins`) and apply ([Removal](#removal)).

## Evidence checklist

Completion evidence 1–6 of [#55](https://github.com/yaunder/fffactory/issues/55)
needs a published release, real credentials and a real worker, so it is checked
outside the test suite. Evidence 7 is this spec's tests.

1. **A fresh worker is ready with all three delivered.** `fffactory secret set
   github-token`, `anthropic-api-key` and `openai-api-key`; declare a host;
   `fffactory plan`, then `fffactory apply --plan-id ID`. Apply's Result shows
   `installed and verified · every account enrolled`, and `fffactory status
   --json` shows the worker ready with `github`, `openai` and `anthropic`
   `enrolled`. On the worker as `factory` (`tailscale ssh factory@HOST`): `gh
   auth status --hostname github.com --active`, `codex login status` and
   `claude auth status` exit 0, and `test -s
   ~/.config/fffactory/anthropic-api-key` passes; no login was typed.
2. **A dispatched agent uses GitHub and its provider.** Request dispatch and
   mark an epic ready ([dispatch](dispatch.md)); the Claude Code and Codex
   agents Paseo starts push a branch and call their provider without a prompt.
   As `factory`, `tr '\0' '\n' </proc/$(pgrep -u factory -f 'paseo' | head -1)/environ`
   shows no `GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY` or
   `OPENAI_API_KEY`.
3. **A replacement worker gets them unattended.** `fffactory worker terminate
   KEY --confirm KEY`, declare the host again, `plan` and `apply`; repeat 1
   and 2 on the new machine.
4. **Renewal.** Create new keys and a new token, `fffactory secret set` each,
   then `plan` and `apply`; repeat 1 and 2, and check the old values are gone
   from the stores (`gh auth token` differs; `auth.json` and the key file hold
   the new values). Revoke the old ones once earlier agents have finished.
5. **References only.** Search for each credential value (`grep -rF`) in the
   saved plan directory (`<cache>/plans/<factory ID>/`,
   [plan and apply §Saved plans](plan-apply.md#saved-plans)), the operation
   records in the state bucket
   ([plan and apply §Operation records](plan-apply.md#operation-records)),
   apply's output, and on the worker `/var/log/fffactory/` and
   `/var/lib/fffactory/`: no match, ARNs only. On the worker, `aws
   secretsmanager get-secret-value` of `tailscale.admin_client_secret`'s ARN
   is refused with `AccessDeniedException`.
6. **Interactive login still works.** With no `credentials` (or a host listing
   all three in `interactive_logins`), apply shows enrollment pending; log in
   as in [machine onboarding §8](../../MACHINE_ONBOARDING.md#8-enroll-the-workers-accounts),
   then `apply` and `status` show the worker ready and dispatch active.

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/instance.ts` | `credentials.*_secret`, `interactive_logins` and `deliveredAccounts`. Pure. |
| Domain | `src/domain/host-projection.ts` | The delivered references and the log archive in the host projection. Pure. |
| Domain | `src/domain/installation.ts` | The `credentials` step and its budget, the command deadlines, the key file, the helper, the managed settings' path, their composition (`claudeManagedSettingsJson`, `CLAUDE_CLEANUP_PERIOD_DAYS`), whether they are fffactory's own (`ownsManagedSettings`) and whether they name the helper (`namesKeyHelper`). Pure. |
| Worker | `src/host/credentials.ts` | `workerCredentials`: reading, checking, delivering, composing the managed settings and removing, over the injected process runner and the worker's root. |
| Worker | `src/host/apply.ts` | Runs the step with the projection's references, its log archive and its log. |
| Worker | `src/host/verify.ts` | GitHub's `--active` check, and the Anthropic key-file check, while the managed settings name the helper. |
| Domain | `src/domain/readiness.ts`, `src/domain/status.ts`, `src/domain/dispatch-readiness.ts` | A delivered account's next action (`enrollmentNextAction`), from the delivered accounts the CLI passes ([readiness §Enrollment](readiness.md#enrollment)). Pure. |

Tests: `tests/domain/installation.test.ts` (the four compositions,
`ownsManagedSettings`, `namesKeyHelper`),
`tests/host/credentials.test.ts` (each secret read by ARN in its Region as
root; each recipe's exact commands, as `factory`, with its deadline and the
material on standard input only; material in no argument, environment or log
line; every non-active gh account logged out, Enterprise Managed Users'
underscore logins among them, and a login that could read as an option refused;
empty, blank, null and whitespace material refused before any tool runs; every
failure naming the account and the AWS error name, exit status or deadline,
never a tool's output, an ARN or the material; the key file failing before the
helper is written; undelivered GitHub and OpenAI untouched, Claude Code's
managed settings removed only while they are fffactory's own, others' or
unreadable settings kept, the key file removed and the log saying which;
delivery replacing others' settings; with the log archive, the helper and the
history, the history alone with the key file removed, others' settings
replaced, the archive turned off dropping the history and then the file, and
settings it cannot write failing the step for the log archive; the step's
budget bounding each command; a rerun issuing the same commands and leaving
the same files), the native credentials step in `tests/host/apply.test.ts`
(inside the install lock, the projection's references and log archive, the
log, a failure failing the install), `tests/host/verify.test.ts` (GitHub
checked with `--active`; the helper configured with the key file missing or
empty is pending; without fffactory's helper `claude auth status` decides;
every composed form accepted), the delivered accounts' next actions in
the tests [readiness](readiness.md#layer-mapping) lists, and
the container cases of `tests/bootstrap/credentials.test.sh`: the real `host
apply` through the activator with a stand-in `aws` and stand-in `gh`, `codex`
and `claude` that keep their stores as the real tools do; each account enrolled
with its files' owners and modes, a stand-in `claude -p` and `codex exec` run
as `factory` sending the delivered keys without a prompt, the material found
nowhere on the filesystem but in the three stores, a rerun and a rotation,
removal, and each failure, a stale Enterprise Managed User's account logged
out, and an organisation's managed settings kept when Anthropic is not
delivered. The real agents against a provider are evidence 1–2 above.

Introduced by [#69](https://github.com/yaunder/fffactory/issues/69); GitHub's `--active`
check and delivered accounts' next actions by [#70](https://github.com/yaunder/fffactory/issues/70);
the composed managed settings and `cleanupPeriodDays` by
[#118](https://github.com/yaunder/fffactory/issues/118).
