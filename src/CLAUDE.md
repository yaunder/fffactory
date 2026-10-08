# src: fffactory CLI

TypeScript for the v2 `fffactory` executable, run and compiled with Bun. Specs
live in `docs/specs/`, tests in `tests/` mirroring this tree.

## Layers

| Directory | Holds | May import |
| --- | --- | --- |
| `domain/` | Pure types and rules: `FactoryInstance`, `FactoryId`, `HostKey`, `Release`, validation, completeness, factory ID generation, gap-filling merge; doctor's `CheckResult`, capability grouping, exit-code rule, and tool, cache and release asset readiness rules; the AWS account-match rule, credential selection and caller observations; the VPC quota headroom rule; the resource namespacing rule, factory-ID tags and the stable host key check; release bundle entry-path rules and the materialization marker; `SUPPORTED_TERRAFORM`, the one Terraform pin, and its cache state; the backend bootstrap plan rules and the state bucket's readiness rule; the factory-wide lock's lease rules; `SecretMaterial`, secret names and their factory.json targets; plans (`plan.ts`: plan IDs, the CLI/pin match guard, resource changes and their presentation, the workers whose machine a plan creates, the D11 refusals, the saved plan record and its freshness rule) and operation records (`operation.ts`); release compatibility (`release-compatibility.ts`: `RELEASE_COMPATIBILITY`, release precedence, upgrade's pin assessment and its D11 refusals); the host protocol (`protocol-fields.ts`: its version and shared field readers; `host-protocol.ts`: worker paths, the inspect document, its serializer and parser, `RemoteCommand` and the inspect, upload and activate commands; `host-projection.ts`: the canonical non-secret host projection, `projectHost` (one factory.json host) and `projectHosts` (every host of the instance), the one projection every stage sends, plans and checks, and `Sha256`; `dispatch-projection.ts`: canonical desired and observed dispatch documents; `installation.ts`: the install steps, step results, the apply document and record, reading the activator's answer; `readiness.ts`: the verify document, enrollment states and the next actions the CLI names for them; `rollout.ts`: a worker's outcome, the rollout rule, and the first boot wait's deadline and rules); the tailnet peer view and the hostname-match rule and tag check that alone make a `WorkerAddress` (`tailnet.ts`); status's inventories, worker verdicts and readiness rule (`status.ts`); repository placement and the per-host repository manifest, the repository readiness that gates dispatch and the unmanaged-checkout rule (`repository-placement.ts`); the control-plane change classification table and the maintenance-deferral rule that never interrupts active agents, and the words every deferral is reported in (`maintenanceDeferral`, `change-classification.ts`); the dispatch readiness gates, the requested-versus-active dispatch state and the dispatch readiness progression (`dispatch-readiness.ts`). | Nothing outside `domain/`. No `node:*`, no Bun APIs, no I/O. |
| `application/` | Use cases (`resolveInstance`, `validateInstance`, `initInstance`, `doctor`, `requireExpectedAccount`, `bootstrapBackend`, `beginFactoryOperation`, the factory lock's `acquireFactoryLock`, `withFactoryLock`, `settleFactoryLock` and `breakFactoryLock`, `setSecret`, `planFactory`, `applyFactory`, `applyWorkers`, `applyRepositories`, `applyControlPlane`, `applyDispatch`, `verifyFactory`, `upgradeFactory`, `factoryStatus`, `inspectWorker`, `inspectRepositories`, `inspectDispatch`) and the ports they call (`InstanceStore`, `ToolProbe`, `CacheDirectoryProbe`, `AssetBundle`, `CallerIdentity`, `VpcQuotaProbe`, `ManagedTerraformProbe`, `Provisioner`, `LockStore`, `SecretStore`, `Approval`, `OperatorPrompt`, `PlanStore`, `HostTransport`, `TailnetPeers`, `MachineInventorySource`, `ControlPlane`, `WorkflowQueue`), each port in its own file beside the use cases; the Terraform input projection (`projectFactoryVariables`, `projectBackendVariables`); `releaseAssetsDirectory`, `managedTerraformPaths` and `planStoreDirectory`, the cache layouts. | `domain/`, and pure `node:path`. |
| `infrastructure/` | Adapters implementing application ports (`filesystemInstanceStore`, `localToolProbe`, `filesystemCacheDirectory`, `releaseAssetBundle`, `stsCallerIdentity`, `awsVpcQuotaProbe`, `s3LockStore`, `secretsManagerStore` and `ec2MachineInventory` over the shared `aws-session.ts`, `terminalPrompt`, `filesystemPlanStore`, `sshTransport`, `tailscalePeers`, `paseoControlPlane` (the `ControlPlane` over the host protocol), `ffflowGithubWorkflowQueue` (the `WorkflowQueue` over the host protocol), and managed Terraform in `terraform/`, with `NAMED_RESOURCES` and the namespacing check over a JSON plan), and the release tarball codec. | `application/`, `domain/`, Node and Bun APIs. |
| `host/` | The worker side of the host protocol (`docs/specs/host-protocol.md`): what `fffactory host` subcommands do on a worker, `workerInspector`, `workerApplier`, `workerVerifier` and the repository reconciler (`workerEndpoint` together), over a `WorkerSystem` (root directory, process runner, hostname, machine, free space; for apply also the clock, privilege, standard input, release and install lock) that tests replace. An adapter layer beside `infrastructure/`, run only on workers. | `domain/`, `infrastructure/`, Node and Bun APIs. Never `application/`'s operator use cases or `cli/`. |
| `cli/` | Driving adapter and composition root: argument parsing, output, exit codes; `cli/release.ts` is the single source of the running release version. | Everything. Only `cli/main.ts` touches `process`, the random source, and wires concrete adapters. |

Dependencies point inward: `domain <- application <- infrastructure, cli`, and
`domain <- host <- cli`.

## Rules

- Define a port in `application/` only when a use case calls it. No speculative ports.
- A mutating use case takes the account check's `AllowedAccount` as proof, or runs
  `requireExpectedAccount` itself, before any AWS call that could change anything.
- Every stage of a mutating factory operation runs under the one factory-wide lock
  (`application/factory-lock.ts`, `docs/specs/provisioning.md` §Lock). Nothing takes it
  over or expires it; only `fffactory lock break`, confirmed by the lock ID, removes it,
  and logs the break first. An interrupted operation never releases it
  (`settleFactoryLock`), and records each step in its operation record.
- Apply applies only the exact plan approved: a fresh plan approved at the terminal, or a
  saved plan named by its ID, whose freshness (factory.json's text, release and assets,
  account, Terraform state revision, age) is checked first (`docs/specs/plan-apply.md`).
  The workers stage (`application/apply-workers.ts`) is the second step under the same lock
  and record, and its changes, each declared worker's install, are in the one plan approved.
  The repositories stage (`application/apply-repositories.ts`) follows it under that lock and
  record, and its per-worker manifest projection is also shown in the approved plan; a new
  stage follows the same rule. The dispatch stage never fails a worker the workers stage skipped
  (its maintenance deferred, offline, ...): it sends it nothing and reports it `skipped`, which
  exits 2, not 1 (`docs/specs/dispatch.md` §Skipped workers). Only a deferred worker also bypasses
  the control-plane stage; one skipped for another reason that the tailnet still locates is
  reconciled there, and may fail. The workers stage waits, within `FIRST_BOOT_DEADLINE_MS`, only for the
  workers whose machine the approved plan created (`createdWorkers`), never for one missing
  for another reason, and the match rule's refusals still apply at every look
  (`docs/specs/plan-apply.md` §Waiting for a new worker). Waiting goes through the injected
  `sleep` (`CliContext.sleep`) and checks `interrupted` after every sleep.
- Only the release factory.json pins may change the factory: `plan`, `apply` and `secret set`
  refuse otherwise (`pinRefusal`). `upgrade` moves the pin forward, writing it under the lock
  once its plan is approved; `init` and `lock break` are not guarded
  (`docs/specs/plan-apply.md` §CLI/pin match guard). What a release declares about the
  factories it can operate is `RELEASE_COMPATIBILITY`, never the bundle's `release.json`,
  which the activator on existing workers reads.
- Secret material is a `SecretMaterial` from a hidden prompt or standard input, never a
  command argument; only a `SecretStore` adapter calls `reveal`, and factory.json keeps
  only the ARN (`docs/specs/secrets.md`). Arguments of `secret` are never echoed.
- A command is a `Command` in `cli/commands/<name>.ts`, registered in `cli/run.ts`.
  Commands receive a `CliContext`; they never read `process` directly.
- Commands return exit codes; `run` maps unexpected errors to exit 1.
- Never echo configuration values in messages or logs: they may hold a pasted secret.
  A command may echo a value it generated itself, such as a new factory ID, and a
  value whose validated format cannot hold a secret: a key that passed its format
  check, `aws.account_id`, `aws.region`, and a release pin that is a plain
  `MAJOR.MINOR.PATCH` (never one with a prerelease part).
- Never print credential material: no access key, secret key or session token, and
  no AWS SDK or AWS error message. Report AWS failures by error name or network
  error code. The caller's account ID and principal ARN may be printed.
- Never print or record Terraform's output. A failed Terraform command's standard error
  is kept only in a private local diagnostics file (`ProvisioningFailed` in
  `application/provisioner.ts`); commands print that file's path (`cli/diagnostics.ts`),
  never its text, and it never reaches an operation record or the state bucket.
- Randomness reaches the domain only as an injected `RandomBytes` function.
- Merge or copy documents by own entries into new objects (`Object.fromEntries`);
  never `Object.assign` or spread input that has not been validated.
- `init` is offline: `tests/cli/init-offline.test.ts` allowlists every
  non-relative import it can reach. Adding one is a deliberate review decision.
- Keep code compatible with `bun build --compile`: no runtime reads of files
  relative to the source tree. Import JSON assets (for example `schemas/`) instead,
  with named imports where possible so the bundle inlines only what is used. The
  one exception is `cli/main.ts` packing `assets/` from the checkout when
  `Bun.isStandaloneExecutable` is false; a compiled executable uses only its
  embedded bundle (`infrastructure/asset-bundle.ts`, `docs/specs/release.md`).
- Release assets live in `assets/` and reach code only through the `AssetBundle`
  port, materialized under `<cache>/releases/<release>`. Never read them from a
  checkout path, and never write into a materialized directory.
- `scripts/build.ts` builds the executables (`just build`, `just build-all`);
  `just smoke` runs the packaged linux-x64 smoke test in Docker.
- `schemas/factory.schema.json` mirrors `domain/instance.ts`; change both
  together. `tests/domain/instance-schema.test.ts` checks they agree.
- `schemas/doctor-report.schema.json` mirrors `doctorJson` in
  `cli/commands/doctor.ts`; `tests/cli/doctor.test.ts` checks output against it.
  Additions keep `DOCTOR_JSON_SCHEMA_VERSION`; removals and renames bump it.
- Doctor inspections never throw and never echo tool output: an observation
  becomes a `ready` or `not_ready` check, and anything doctor cannot observe
  becomes an `error` check. A new capability is one more entry in
  `CAPABILITIES` in `application/doctor.ts`.
- Every command that plans or mutates AWS or factory infrastructure calls
  `requireExpectedAccount` before anything else and refuses unless it allows.
  Local-only writes (`init`, `assets`) do not. A missing expected account is a refusal, never a default.
- AWS access goes through AWS SDK for JavaScript v3 in `infrastructure/`, imported
  dynamically at first use so commands that never call AWS never load it. Every AWS
  call has a deadline. A selected profile resolves with `fromIni` only, never the
  default chain, which would fall through to instance metadata on an EC2 host. Pin
  SDK packages to exact versions.
- Adapters that run processes take an injected `ProcessRunner`, never a shell,
  and always a timeout. Pass an explicit `env` when the child must not inherit
  the operator's environment. `bunProcessRunner` spawns each command in its own process
  group and tracks the groups still running. At its timeout, or when `stopRunningTools`
  is called, a group is stopped: sent the command's `stop` signal with a grace period
  when it has one (Terraform's is SIGINT), then SIGKILLed; `killRunningTools` SIGKILLs
  at once. Its `process.kill` of those groups is the one use of `process` outside
  `cli/main.ts`, which passes `process.stdin` and `process.stderr` to `terminalPrompt`.
  After `stopRunningTools` no command starts, so only an exiting caller calls it; test
  it in its own process (`tests/support/stop-tools-main.ts`).
- factory.json reaches Terraform only through `application/project-terraform-inputs.ts`,
  in memory and the operation's private inputs file; the projection is never written where
  it could be edited. The shipped modules and their rules are in
  `assets/terraform/CLAUDE.md`.
- Terraform is only ever the managed one (`infrastructure/terraform/`,
  `docs/specs/provisioning.md`): never `terraform` from PATH, never the operator's
  Terraform CLI configuration or `TF_*` variables. Its version is pinned in
  `domain/managed-terraform.ts` alone.
- `cli/interrupts.ts` owns signal handling, over the process `cli/main.ts` passes it: while a
  command runs, the first SIGINT, SIGTERM or SIGHUP prints the interrupt notice on standard
  error (offering a second interrupt only while a tool stops gracefully, `stopsGracefully`),
  sets `CliContext.interrupted`, wakes every pending `CliContext.sleep`, which it makes, and
  calls `stopRunningTools`. Once the tools have stopped it exits with 128 + the signal number
  whatever the command returned; a second signal calls `killRunningTools` and exits at once.
  A tool in its own session would otherwise outlive an interrupted `fffactory`. Only a command
  with `waitsOnInterrupt` (`apply`, `upgrade`, `doctor`, `status`) is first waited for, at most
  `RETURN_GRACE_MS`, so it can report what the interrupt left; it must return promptly: a use
  case that holds the lock takes `interrupted` and, once it is set, starts nothing more and
  writes no more of its operation record, and a read-only report (`doctor`, `status`) is not
  printed, since its tools were stopped. Never set `waitsOnInterrupt` on a command that does
  not check `interrupted` (`host apply`, `secret set`, `lock break`): waited for, it would go
  on mutating after the signal.
- Workers are reached only through `HostTransport` (`docs/specs/host-protocol.md`), with a
  `WorkerAddress` that only the hostname-match rule in `domain/tailnet.ts` makes: a missing
  or duplicate hostname is refused, never guessed, and so is a device without the factory's
  `tailscale.tag` (never echoed: its format could hold a pasted secret). `sshTransport` runs
  the system `ssh` with `-F /dev/null` and every option on the command line, verifies the
  host key strictly against the keys the tailnet lists for that device (a private
  known_hosts file, removed after each command), passes only `PATH` and `HOME`, and never
  prints ssh's standard error or `tailscale`'s output. A remote command is a `RemoteCommand` of fixed shell-safe tokens;
  nothing from configuration or the peer view becomes one.
- A worker receives the running executable's own embedded bundle, checked against its
  embedded digest (`AssetBundle.workerRelease`), and the activator gets that digest; nothing
  else supplies a release or a digest. What a worker gets of factory.json is only the host
  projection (`domain/host-projection.ts`): non-secret (a secret reference at most), canonical,
  streamed on standard input, never an argument. Both go through `HostTransport`'s `stdin`.
  The workers stage's caller builds the projections with `projectHosts` from the instance; a
  stage that projects one host passes `projectHost` the `Host` it took from factory.json's
  `hosts`, never a narrower shape, so what apply sends is what plan and status digest. The
  compiler does not enforce this (`Host` requires only `key`); the pipeline test
  (`tests/application/apply-factory-pipeline.test.ts`) does: `host apply` and the Paseo install
  must get the same projection, and the plan and `status` after the apply must find it current.
- The host protocol is versioned JSON (`HOST_PROTOCOL_VERSION`). Additions keep the
  version and readers ignore unknown fields; removals, renames and new state values bump
  it, and the CLI rejects any other major version. The worker side and the CLI side share
  `tests/host/fixtures/`; change a fixture only with both sides. A worker's document carries
  states and fffactory's words, never instructions: whatever the CLI prints as a command to
  run it builds itself, from the hostname it resolved, and it trusts an answer only for the
  worker and release it asked about.
- `status` is read-only: no lock, no record, no stored result. `schemas/status-report.schema.json`
  mirrors `statusJson` in `cli/commands/status.ts`, versioned as doctor's report is.
- Run `just check-all` before committing.
