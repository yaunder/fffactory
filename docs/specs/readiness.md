# Readiness

Infrastructure success, software success and usability are different
outcomes. Once a release is installed on a worker, fixed verifiers say
whether its software works, and enrollment checks say which human steps it
still waits for. fffactory checks enrollment and names its exact next steps;
it never performs a human enrollment. Design:
[fffactory-v2.md §Human enrollment and readiness](../designs/fffactory-v2.md#human-enrollment-and-readiness).

```text
provisioned -> software ready -> enrollment pending or usable -> dispatch pending or active
```

A failed check leaves a worker unhealthy. With every check passed, it is
usable once every account is enrolled, and enrollment is pending until then
(`workerReadiness`, `domain/readiness.ts`). Enrollment pending does not fail
an install: the managed setup succeeded.

## Verification

`host verify` ([host protocol §verify](host-protocol.md#verify)) runs as root
on the worker: `host apply` runs it after its steps, so every install ends
with a verification, and its record keeps the result. Each check is `passed`
or `failed` with a summary in fffactory's own words; tool output is never
included. Every command has a 30 s deadline, except the plugins step's own
verifier, which reads every plugin checkout and has 2 minutes; the checks run
at once. Within `host apply`, verification as a whole must end within
`VERIFY_TIMEOUT_MS` (5 minutes, part of the CLI's wait for the activation), or
the install fails.

| Check | Passes when |
| --- | --- |
| `factory_account` | `id -u factory` names the runtime account. |
| `toolchain` | As `factory`, Git, Git LFS, the GitHub CLI, ripgrep, jq, npm, Python 3.11, GNU Make and GCC run, and `node --version` is 22.x. Otherwise the summary names each one that does not. |
| `workspace` | `/workspace/repos` and `/workspace/cache` are directories owned by `factory`. |
| `agents` | As `factory`, `codex --version` and `claude --version` report the versions the release's `steps/versions.env` pins. |
| `plugins` | The `plugins` step's own `verify` passes: the pinned plugins, at their revisions and contents, and nothing undeclared. |
| `tailscaled` | `systemctl is-active tailscaled.service` prints `active`. |

A command runs as `factory` through
`runuser -u factory -- /usr/bin/env -i HOME=/home/factory PATH=/home/factory/.local/bin:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 DISABLE_UPDATES=1 ...`:
exactly the environment its agents get, and nothing of root's.

## Enrollment

Each account's `state`: `enrolled` when its check passes, `pending` when it ran
and found no credential, `unknown` when it could not run (the tool is missing,
`env` exits 126 or 127, or it timed out).

| `id` | Title | Checked with, as `factory` | Next action |
| --- | --- | --- | --- |
| `github` | GitHub | `gh auth status --hostname github.com` | Authenticate GitHub as factory on HOST: `tailscale ssh factory@HOST`, then `gh auth login --hostname github.com --git-protocol https --web`, then `gh auth status` |
| `openai` | OpenAI Codex | `codex login status` | Log in to OpenAI Codex as factory on HOST: `tailscale ssh factory@HOST`, then `codex login --device-auth`, then `codex login status` |
| `anthropic` | Claude Code | `claude auth status` | Log in to Claude Code as factory on HOST: `tailscale ssh factory@HOST`, then `claude auth login`, then `claude auth status` |

Each summary ends "(tailnet SSH policy must let you log in as `factory`)". A
next action is structured (`enrollmentNextAction`): a `summary`, the `login`
that reaches the runtime account on that worker, and the `commands` to run
there, in order. Credentials belong to `factory`, where agents use them, so
the login is Tailscale SSH as `factory`: the tailnet vouches for the host key,
and tailnet SSH policy must let the operator log in as `factory`, an
administrator's step outside fffactory. `fffactory-admin`'s only sudo rule is
the activator, so it cannot switch to `factory`.

The worker reports each account's state and nothing else. The CLI names every
next action itself (`enrollmentReport`), from the account's `id` and the
hostname the CLI resolved for the worker, never from the worker's document: a
compromised worker could otherwise put any command in front of the operator.
An account the worker did not report is `unknown`, and an `id` the CLI does
not know makes the document malformed.

**Paseo clients** are not a worker account. Paseo is installed on workers, but
a client's enrollment can be observed only from that client, so worker verify
does not check it and it does not count toward worker readiness. Apply and
status mention: "Paseo clients: enrollment is checked from each client, not the
worker", with no worker-side next action. Reporting a fourth account would be
a new state value for this document's readers.

### Where it is reported

- `fffactory apply` lists each installed worker's pending accounts with their
  exact steps ([plan and apply §The workers stage](plan-apply.md#the-workers-stage)).
- `fffactory status` shows a software-ready worker with enrollment pending as
  not ready (exit 2), each pending account's steps as details, and the
  structured next actions in `--json`
  ([status §Readiness](status.md#readiness)). It reads the verification the
  last install recorded, since `status` runs unprivileged and only root can
  check `factory`'s credentials: after enrolling, rerun `fffactory apply`,
  which verifies again.

## Dispatch

Once a worker is usable, readiness continues to dispatch, when factory.json
requests it on the host (`hosts[].dispatch.enabled`). Requested dispatch and
active dispatch are distinct: apply keeps dispatch inactive until every dispatch
gate passes — the worker release is healthy, the GitHub credential is enrolled,
every placed repository synchronized, FFFlow adoption passes, and Paseo is
healthy — then activates it automatically on a later apply
([dispatch §Gate matrix](dispatch.md#gate-matrix)). So the progression's last
step is **dispatch pending** while a gate blocks it and **dispatch active** once
they all pass; a worker whose host does not request dispatch stops at usable.

The dispatch gates reuse this document's enrollment: the GitHub credential gate
reads the worker's GitHub enrollment state, and a pending or unknown credential
keeps dispatch pending and surfaces the same GitHub next action named above.

- `fffactory apply` drives dispatch and reports each worker's outcome
  (`not_requested`, `active`, `pending` with the blocking gates and their next
  actions, `failed`, or `skipped` with the reason and next action of the stage
  that skipped it, [dispatch §Skipped workers](dispatch.md#skipped-workers)) and
  ends with the end-to-end verification
  ([dispatch §End-to-end verification](dispatch.md#end-to-end-verification)); a
  factory that installed but has not reached its requested end state exits 2.
- `fffactory status` invokes the fixed root activator's read-only dispatch
  inspection. The worker reads the persisted gate blockers and verifies that the
  actual Paseo schedule still matches the projection before reporting `active`.
  Status therefore shows the observed `active`, `pending`, `not_requested`,
  failed or unreadable state, never an inferred state from `enabled` alone.

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/readiness.ts` | `ENROLLMENTS`, `PASEO_CLIENTS`, enrollment states, `enrollmentNextAction`, `enrollmentReport`, `describeNextAction`, `workerReadiness`, the verify document and its parser. Pure. |
| Worker | `src/host/verify.ts` | `workerVerifier`: the checks and enrollment checks, over the injected process runner. |
| Domain | `src/domain/status.ts` | The enrollment verdict status shows. |
| Domain | `src/domain/dispatch-readiness.ts` | The dispatch gates and the dispatch progression ([dispatch](dispatch.md)). Pure. |

Tests: `tests/domain/readiness.test.ts` (each next action, named for the
resolved hostname and never the worker's; an unreported account unknown;
Paseo clients mentioned, never counted; the readiness progression, the
document's round trip, every malformed field, instructions a worker sends
never read, additions ignored), `tests/host/verify.test.ts` (including a worker
the real verifier finds healthy and fully enrolled judged ready by status), `tests/domain/status.test.ts` and
`tests/cli/status.test.ts` (enrollment pending with exact steps, in text and
JSON), and the container cases of `tests/bootstrap/host-apply.test.sh`
(pending, then enrolled once the stand-in `gh` is).

Introduced by [#101](https://github.com/yaunder/factory/issues/101).
