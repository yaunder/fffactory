# Status

`fffactory status [--instance PATH] [--profile NAME] [--json]` reports every
host factory.json declares as three inventories see it now: the factory's EC2
instances, the operator's Tailscale peer view, and the worker's own inspection
over SSH. Design:
[fffactory-v2.md §`status`](../designs/fffactory-v2.md#status) and
[§Machine identity and connectivity](../designs/fffactory-v2.md#machine-identity-and-connectivity).

## Read-only

Status changes nothing. It takes no factory lock, reads no lock or operation
record, writes no file and stores no result, so a worker it cannot reach has an
unknown release: there is no last-known value to show. Its only calls are STS
`GetCallerIdentity`, EC2 `DescribeInstances`, `tailscale status --json`, and
`fffactory host inspect --json` plus, for an active release, `fffactory host
repositories --json` on each reachable worker over SSH
([host protocol](host-protocol.md)).

## Order

1. Select, read and validate factory.json, as every command does
   ([instance configuration](instance-configuration.md)). With `--json` the
   `Instance:` line goes to standard error.
2. Refuse, exit 1, unless factory.json is complete: the fields `plan` needs,
   listed as `<path>: is required for status`.
3. The account check: the caller must be in `aws.account_id`, resolved in the
   factory Region, before anything reaches AWS, even though status reads only
   ([doctor §AWS account](doctor.md#aws-account)). Another account, or none, is
   refused, exit 1, with the refusal and its next action.
4. List the EC2 instances and read the peer view, once each, at the same time.
5. For each declared host, in factory.json's order and all at once, work out
   its [result](#workers).

A CLI whose release differs from factory.json's pin may run status: it
diagnoses and changes nothing (design §Release and compatibility model).

## Inventories

| Check | Ready when | Otherwise |
| --- | --- | --- |
| `ec2_instances` | `DescribeInstances` in the factory Region, filtered by the tag `fffactory:factory-id` = the factory ID and every state but `terminated`, succeeded within 15 s: "N instances carry the factory ID". | `error`, by AWS error name or network code, never AWS's message. Workers are still inspected, with machine `unknown`. |
| `tailscale` | `BackendState` is `Running`: "Logged in and running; N devices visible". | As doctor's `tailscale` check: `not_ready` for a missing client, a stopped daemon or a disconnected client, `error` for output it cannot interpret or a 10 s timeout. No worker is connected to. |

An instance counts only with an ID `i-` and 8 to 32 hexadecimal digits; its
host is its `fffactory:host-key` tag.

## Workers

Each host's namespaced hostname is `<factory ID>-<host key>`; its device must
carry that name and the factory's tag
([host protocol §Finding the worker](host-protocol.md#finding-the-worker)).
Status goes as far as it can and stops at the first thing that blocks it:

| Stage | Observation | Status | Summary and next action |
| --- | --- | --- | --- |
| Machine | No instance carries the host key | not ready | Not provisioned; provision it with `fffactory apply`. |
| Machine | More than one does | not ready | N instances, each listed; remove the one that is not the worker yourself. Status never guesses. |
| Machine | `stopped` | not ready | Start the named instance in the EC2 console. |
| Machine | `stopping` or `shutting-down` | not ready | Check the named instance in the EC2 console. |
| Tailnet | The peer view is unavailable | as the `tailscale` check | Fix the Tailscale client. |
| Tailnet | `missing` | not ready | No device with that name is visible; wait for it to join, or check the tailnet policy and the bootstrap in the EC2 console output. A failed bootstrap never reruns: terminate the instance, and once it is terminated the next `fffactory apply` creates it again ([worker bootstrap §Failed first boot](worker-bootstrap.md#failed-first-boot)). |
| Tailnet | `duplicate` | not ready | N devices share the name; remove the stale ones in the Tailscale admin console. Never connected to. |
| Tailnet | `untagged` | not ready | The one device with the name does not carry the factory's tag (`tailscale.tag`); check in the admin console that it is the worker and carries the tag, and remove it if not. Never connected to. |
| Tailnet | `offline` | not ready | Check that the instance runs and Tailscale is up. |
| Tailnet | `no_ssh` | not ready | Make sure the worker runs Tailscale SSH and the tailnet lets this device reach it. |
| SSH | `unreachable` or a 30 s timeout | not ready | SSH could not reach it; check with `tailscale ping <hostname>`. |
| SSH | `access_denied` | not ready | Ask a tailnet admin for an SSH rule with action `accept` letting you log in as `fffactory-admin` to the factory's tag; enrolling a worker's accounts also needs one for `factory`. |
| SSH | `host_key_mismatch` | not ready | Do not bypass it: check the device in the admin console. |
| SSH | `client_missing` | not ready | Install OpenSSH (`fffactory doctor` checks it). |
| Inspect | `no_release` | not ready | No release is installed; install the pinned release with `fffactory apply`. |
| Inspect | `unsupported_protocol` | error | Use the fffactory release factory.json pins. |
| Inspect | `failed` | error | If it fails again, run the inspect command with `tailscale ssh fffactory-admin@<hostname>` to see why, never plain `ssh`, which would ask to trust an unknown host key. |
| Inspect | A document | [readiness](#readiness) | |

A pending or running instance, and one the inventory could not list, go on to
the tailnet. Every next action ends ", then rerun `fffactory status`."

Each worker reports its facts whatever stopped it:

| Field | Values |
| --- | --- |
| `machine` | The EC2 state (`pending`, `running`, `stopping`, `stopped`, `shutting-down`), `absent`, `duplicate` or `unknown`, with the instance ID when there is exactly one. |
| `tailnet` | `online`, `offline`, `missing`, `duplicate`, `untagged`, `no_ssh`, `unknown` (no peer view) or `not_checked` (stopped at the machine). |
| `release` | The active release's version, `none`, `broken`, or `unknown` whenever the worker was not inspected. |
| `configuration` | The host configuration's SHA-256, `none`, `unreadable` or `unknown`. |
| `installation` | The last install's state as the worker recorded it (`running`, `succeeded`, `failed`), `none`, `unreadable`, or `unknown` whenever the worker was not inspected. |
| `repositories` | The last completed repository result: `synchronized`, `unresolved`, `none`, `unreadable`, or `unknown`; plus the unmanaged checkout paths when observed. |
| `dispatch` | The persisted and schedule-checked dispatch result: `active`, `pending`, `not_requested`, `failed`, `none`, `unreadable` or `unknown`; plus gate blockers when observed. |
| `enrollment` | Each account's enrollment as the last install's verification found it, with the next action status names for it ([readiness §Enrollment](readiness.md#enrollment)), or null. |

## Readiness

A worker's own document is judged against factory.json
(`readinessVerdict`). Each finding makes it not ready; the first is its
summary and next action, the rest its details, in this order:

| Finding | Next action |
| --- | --- |
| It reports another hostname (compared without case) | Check in the admin console that the device is this factory's worker. |
| Bootstrap has not finished | Wait for the first boot, or check the instance's console output. |
| It is not Amazon Linux 2023 (`amzn`, `2023`) on `x86_64`, or its os-release is unreadable | Check that the machine is the factory's worker. |
| Less than 2 GiB free under `/opt/fffactory/releases` | Free space or grow `hosts[].root_volume_gib`. |
| No release, a damaged one, or another release than the pin | Install the pinned release with `fffactory apply`. |
| A host configuration whose SHA-256 is not that of the [host projection](host-protocol.md#the-host-projection) apply would send it | Repair the worker with `fffactory apply`. |
| No host configuration, or one `fffactory-admin` cannot read | Repair the worker with `fffactory apply`. |
| A service not `active` | Repair the worker with `fffactory apply`. |
| With a release active: an install recorded as running: "An install of release R started at T has not finished; it may still be running" | If it started more than 72 min ago (apply's activation timeout), repair the worker with `fffactory apply`; otherwise wait for it to finish. |
| With a release active: no install record, one that cannot be read, one that failed at a step, outside its steps (naming why) or in verification (naming the failed checks), or one of another release than the active one | Repair the worker with `fffactory apply`. |
| Base software ready, but repositories are unresolved or have never synchronized | Resolve the reported checkouts or run `fffactory apply`. |
| The repository result is unreadable or cannot be observed | Repair the worker with `fffactory apply`. |
| Dispatch is requested and its checked result is pending | Resolve the reported gate blockers, then run `fffactory apply`. |
| Dispatch has not been reconciled, differs from factory.json, or its result/schedule cannot be verified | Repair dispatch with `fffactory apply`. |

The expected digest is that of the projection apply sends the host, built from
factory.json's host for the pinned release by the same `projectHost`
(`src/domain/host-projection.ts`), Paseo secret reference included.

A running record may belong to an install that is still going, since an
interrupted or timed-out `fffactory apply` stops waiting but `host apply`
runs on, or to one that was killed; status cannot tell which, and a rerun of
apply is safe either way: it skips a worker whose install still runs
([host protocol §apply](host-protocol.md#apply)).

With none, the last install's verification decides. When an account is not
enrolled, the worker is not ready, software installed and enrollment pending
([readiness](readiness.md)). Each account's steps are status's own, named for
the hostname status resolved, never text from the worker; Paseo clients are
only mentioned, and never keep a worker from being ready:

```text
  not ready  builder-1 (example-builder-1): Software ready on release 0.1.0; enrollment pending: GitHub, OpenAI Codex, Claude Code
             Machine: running (i-0000000000000000a); Tailscale: online; Release: 0.1.0
               GitHub: Authenticate GitHub as factory on example-builder-1 (tailnet SSH policy must let you log in as `factory`): run `tailscale ssh factory@example-builder-1`, then `gh auth login --hostname github.com --git-protocol https --web`, then `gh auth status`
               ...
               Paseo clients: enrollment is checked from each client, not the worker
               Enrollment as `fffactory apply` last verified it, at 2026-09-30T12:09:00.000Z
             Next: Enroll each pending account on example-builder-1 as listed (tailnet SSH policy must let you log in there as `factory`), then verify the enrollment with `fffactory apply` and rerun `fffactory status`.
```

Status reads the verification the last install recorded: it runs
unprivileged, and only root can check the runtime account's credentials. With
every account enrolled it is ready: "Ready on release <pin>".

## Statuses and exit codes

Statuses are doctor's: `ready`, `not_ready` (observed, and something is
missing, offline, drifting, unhealthy or pending) and `error` (status could not
observe it). The report's status is the worst of its inventories and workers.

| Exit | When |
| --- | --- |
| 0 | Every inventory and every worker is ready. |
| 2 | Inspection succeeded, but something is not ready, such as an offline worker. |
| 1 | Status failed: invalid arguments, a missing, invalid or incomplete factory.json, another account, or an inventory or worker it could not inspect. |

The full report is printed for exits 0, 2 and 1 alike once inspection starts,
except after an interrupt (SIGINT, SIGTERM or SIGHUP), which stops the tools it
runs: then no report is printed and `fffactory` exits with 128 plus the
signal's number ([plan and apply §Interruption](plan-apply.md#interruption)).

## Output

### Human-readable

```text
fffactory status, release 0.3.0
Factory example in AWS account 123456789012, us-east-1; factory.json pins release 0.1.0

Inventories:
  ready      EC2 instances: 2 instances carry the factory ID
  ready      Tailscale client: Logged in and running; 2 devices visible

Workers:
  not ready  builder-1 (example-builder-1): Offline in the tailnet
             Machine: running (i-0000000000000000a); Tailscale: offline; Release: unknown; Repositories: unknown
             Next: Check that the instance is running and that Tailscale is up on it, then rerun `fffactory status`.
  ready      builder-2 (example-builder-2): Ready on release 0.1.0
             Machine: running (i-0000000000000000b); Tailscale: online; Release: 0.1.0; Repositories: synchronized

Not ready: 1 of 4 entries needs attention.
```

### JSON, schema version 1

`--json` prints one document, indented by two spaces, on standard output and
nothing else. Its structure is published as
[`schemas/status-report.schema.json`](../../schemas/status-report.schema.json);
`tests/cli/fixtures/status-report.json` is the example above:

- `schema_version`, `release` (the running CLI's) and `status`;
- `factory`: `factory_id`, `account_id`, `region` and the pinned `release`;
- `inventories`: checks shaped as doctor's (`id`, `title`, `status`,
  `summary`, `details`, `next_action`);
- `workers`: `key`, `hostname`, `status`, `summary`, `details`,
  `next_action`, `machine` (`state`, `instance_id`), `tailnet`, `release`,
  `configuration`, `installation`, `repositories` (`state`, `unmanaged`),
  `dispatch` (`state`, `blockers`) and
  `enrollment`: null, or each account's
  `id`, `title`, `state` and structured `next_action` (`summary`, `login`,
  `commands`), null exactly when enrolled, for GitHub, OpenAI Codex and
  Claude Code (Paseo clients are not listed until Paseo runs on workers).

`next_action` is `null` exactly when `status` is `ready`. Adding a field, a
check or a worker state keeps `schema_version` 1; consumers ignore what they do
not know. Removing, renaming or redefining a field needs a new version.

### What status never prints

Configuration values other than the factory ID, a key that passed its format
check, `aws.account_id` and `aws.region`; the Tailscale tag is named only as
`tailscale.tag`. Tool output: not `tailscale`'s (it describes other devices),
not `ssh`'s standard error, not a worker's output that failed to parse. AWS or
SDK messages. It prints hostnames it derived, instance IDs, EC2 states, release
versions and digests the worker reported after validation.

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/status.ts` | Machines and the EC2 inventory, worker inspections, facts and verdicts; the inventory checks; `machineVerdict`, `locateWorker`, `readinessVerdict`, `inspectionVerdict`; `SUPPORTED_BASE`, `MIN_AVAILABLE_BYTES`; the report. Pure. |
| Application | `src/application/status.ts` | `factoryStatus`: completeness, the account check, the inventories, each worker. |
| Application | `src/application/inspect-dispatch.ts` | Reads dispatch through the fixed activator operation. |
| Application | `src/application/machine-inventory.ts` | The `MachineInventorySource` port. |
| Infrastructure | `src/infrastructure/ec2-inventory.ts` | `ec2MachineInventory` over `DescribeInstances` (AWS SDK for JavaScript v3), paged, within one deadline. |
| CLI adapter | `src/cli/commands/status.ts` | Arguments, the refusals, the human and JSON reports, the exit code. |

Tests: `tests/domain/status.test.ts` (every finding and its order, a drifted
configuration, every install record state, a running one that may still be
going, a failure outside the steps, enrollment pending with each account's
steps named for the resolved hostname, Paseo clients never counted, every
uninspected outcome, the machine and tailnet stages, the inventory checks, the
report's status), `tests/application/status.test.ts` (a ready factory; a
duplicate and a missing hostname, and a device without the factory's tag,
refused with the next action and never connected to; the tag read from
factory.json; each worker's configuration compared with the projection apply
would send it; enrollment pending reported with each account's state; an
offline worker and one SSH cannot reach with an unknown
release; no release; unprovisioned and stopped machines not connected to; an
unreadable EC2 inventory; Tailscale logged out; another account refused before
any inventory; an incomplete factory.json refused before AWS),
`tests/infrastructure/ec2-inventory.test.ts` (stubbed calls, and the real SDK
against `tests/support/stub-ec2-instances.ts`), `tests/cli/status.test.ts`
(exit codes 0, 2 and 1, no lock taken, no report once interrupted, the human
report, the JSON report against the fixture and the schema, and enrollment
pending in both), and `tests/cli/status-executable.test.ts`
(the spawned executable with stand-in `tailscale` and `ssh` on a private PATH,
STS and EC2 stubs: an offline worker exits 2 with an unknown release and is
never connected to; a device with the worker's name but not the factory's tag
exits 2, is never connected to and has neither tag printed; an unreachable one
exits 2; a ready one exits 0; one without a release reports `none`).

Introduced by [#100](https://github.com/yaunder/factory/issues/100); the
configuration comparison, install record and enrollment by
[#101](https://github.com/yaunder/factory/issues/101).
