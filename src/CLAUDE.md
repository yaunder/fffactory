# src: fffactory CLI

TypeScript for the v2 `fffactory` executable, run and compiled with Bun. Specs
live in `docs/specs/`, tests in `tests/` mirroring this tree.

## Layers

| Directory | Holds | May import |
| --- | --- | --- |
| `domain/` | Pure types and rules: `FactoryInstance`, `FactoryId`, `HostKey`, `Release`, validation, completeness, the accounts whose API credential reaches a host (`deliveredAccounts`), factory ID generation, gap-filling merge; doctor's `CheckResult`, capability grouping, exit-code rule, and tool, cache and release asset readiness rules; the AWS account-match rule, credential selection and caller observations; the VPC quota headroom rule; the resource namespacing rule, factory-ID tags and the stable host key check; release bundle entry-path rules and the materialization marker; `SUPPORTED_TERRAFORM`, the one Terraform pin, and its cache state; the backend bootstrap plan rules and the state bucket's readiness rule (`UnreadyBucket`: where it is, what S3 reports and what it lacks); the factory-wide lock's lease rules; the order the state bucket is emptied in, page by page, the lock's versions set aside (`deletionBatches`) and deleted last, oldest first by when written and the current one alone and last of all (`lockBatches`), and how deleting it ended (`BucketDeletion`, with what became of the lock, `LockAfterDeletion`, `state-bucket-deletion.ts`); `SecretMaterial`, secret names and their factory.json targets, and which secrets a factory owns (`ownsSecret`, `classifySecrets`, which alone makes an `OwnedSecret`), the Region a secret's ARN names, the only one it is asked about in (`secretRegion`), and how deleting one ended (`SecretDeletion`); plans (`plan.ts`: plan IDs, the CLI/pin match guard, resource changes, root output changes (`outputChanges`), `ChangeKind` and `changeTally`, `PlanReview` (the plan an operator approves, as data: a factory plan's target, changes, workers, repositories, control plane, dispatch, stopped workers and an upgrade's pin move, or backend bootstrap's), `UnexpectedPlan`, the workers whose machine a plan creates, the D11 refusals (a host removed by hand names `fffactory worker terminate KEY`), the refusal to resize a stopped or stopping worker, or any while the EC2 inventory cannot be read, the saved plan record, in two kinds (a factory plan, and a bootstrap plan with `"kind": "bootstrap"`), and their freshness rules, each reason a `StaleReason`) and operation records (`operation.ts`, with the host keys a teardown remembers in its own, `withHostKeys`, read back by `rememberedHostKeys`, and the inspections terminate's and teardown's carry, `InspectionRecord`: `forced` beside the inspection document, `withInspection`, `withInspections`); release compatibility (`release-compatibility.ts`: `RELEASE_COMPATIBILITY`, release precedence, upgrade's pin assessment and its D11 refusals, and the `PinMove` an upgrade shows, never carrying a pin that is not a plain release); the host protocol (`protocol-fields.ts`: its version and shared field readers; `host-protocol.ts`: worker paths, the inspect document, its serializer and parser, `RemoteCommand` and the inspect, upload and activate commands; `host-projection.ts`: the canonical non-secret host projection with the credential references delivered to the host, `projectHost` (one factory.json host) and `projectHosts` (every host of the instance), the accounts a projection delivers (`projectedAccounts`), the one projection every stage sends, plans and checks, its control-plane part (`controlPlaneProjection`: all but `credentials`, which the control-plane plan alone digests), and `Sha256`; `dispatch-projection.ts`: canonical desired and observed dispatch documents, the not-requested projection that stops dispatch on one host (`notRequestedDispatchProjection`) and how stopping ended (`DispatchStop`); `installation.ts`: the install steps, step results, the apply document and record, reading the activator's answer, and the `credentials` step's command deadlines, Anthropic key file, key helper and Claude Code managed settings, and whether settings name that helper (`namesKeyHelper`); `readiness.ts`: the verify document, enrollment states, GitHub's `--active` check, the next actions the CLI names for them (a login, or for an account factory.json delivers, `secret set` then `apply`) and `WorkerEnrollment` (a worker's enrollment grouped: one login, its requirement, each account still to enroll there, and apart the delivered accounts still to enroll), which human output renders from; `rollout.ts`: a worker's outcome (an installed one carries the accounts its projection delivered), the rollout rule, and the first boot wait's deadline and rules); the tailnet peer view and the hostname-match rule and tag check that alone make a `WorkerAddress`, and the devices `worker terminate` deletes (`selectWorkerDevices`: the reported hostname exactly, never the MagicDNS label, and the factory's tag) (`tailnet.ts`); status's inventories, worker verdicts (`stopped` among them) and readiness rule (`status.ts`); repository placement and the per-host repository manifest, the repository readiness that gates dispatch, the unmanaged-checkout rule and `RepositoryObservation` (`repository-placement.ts`); the work inspection's document, its parser, the printable path and branch rules, and what counts as unresolved work (`workFindings`, `work-inspection.ts`); the control-plane change classification table and the maintenance-deferral rule that never interrupts busy agents, decided from the worker's activity, and the words every deferral is reported in, for busy, unknown and outdated activity (`maintenanceDeferral`, `preActivationDeferral`, `change-classification.ts`); fffactory's agent states (`AgentState`: `working`, `needs_input`, `finished`, `failed`, `stopped`), naming no Paseo status, a worker's agents as the CLI read them (`AgentsObservation`: listed, unknown, or `outdated`, an answer without them from a release before agent states), the busy rule every gate and deferral judges by (`workerActivity`: busy while any agent is `working` or `needs_input`, idle when none is, unknown when unreadable) and its words (`busyAgents`), the one object status and `worker inspect` report it as (`agentActivity`: state, reason and each agent), and the control-plane activity and action documents with their parsers, the activity parser refusing an answer without `agents` (`control-plane.ts`); the dispatch readiness gates, the requested-versus-active dispatch state and the dispatch readiness progression (`dispatch-readiness.ts`); `fffactory worker stop|start|terminate`'s rules: the one target machine, what each EC2 state means for an action, the gates of stop and terminate (terminate's also read the current work and the repository result, and pass a stopped machine uninspected), the confirmation rules (y/N, `--yes`, terminate's typed key and `--confirm`), the admin client's refusals, the tailnet device removal's outcome, the bounded waits and their words, and `WorkerCommand`, the command as run that every next action reruns (`terminate` or `terminate-keep`), terminate's own next actions for its gates (`terminateGateActions`), and how a worker on a release from before agent states is replaced (`replaceOutdatedWorker`, after the check by hand `outdatedReplacement`, which inspect's gate actions name as `RemovalGateActions.outdated`) (`worker-lifecycle.ts`); `fffactory worker inspect`'s verdict (removable, refused, or not inspected and why) and the inspection document it prints and terminate's and teardown's records carry, free of next actions and of any command's flags, built from terminate's inspection, or what its machine decides, judged by `removalGate`, with a refusal's next action beside it for the judging command's actions, and inspect's next actions and exit code (`RemovalInspection`, `WorkerRemovability`, `workerRemovability`, `inspectGateActions`, `removalExitCode`, `worker-removability.ts`); terminate's removal of a host: factory.json without it by own entries (the last host leaving `hosts` empty, a complete factory with no worker), the scoped removal rule over Terraform's JSON plan and the words of its failures (`host-removal.ts`); teardown's guarded destroy plan rule over `plan -destroy`'s JSON plan (`destroyPlanRefusal`: only deletes, reads and no-ops, root outputs only deleted or left, each instance deleted the one EC2 lists for its host) and its agreement with Terraform's exit code, root output changes counted (`destroyPlanMismatch`), what listing the factory's tagged VPCs showed (`VpcInventory`), the devices it deletes and lists (`selectFactoryDevices`, D9: `<id>-<key>` for every known key, any other tagged `<id>-*` only under a generated ID, `isGeneratedFactoryId` in `initialization.ts`), the secrets it keeps (`keptSecrets`: tagged, and referenced not owned, those already absent left out), the references under `<id>/` to look up (`unlistedReferences`) and the refusal of one that cannot be (`secretUnresolved`, worded for why: `UnresolvedSecret`), the typed factory-ID confirmation, its gates' next actions (`teardownGateActions`, over `removalGate` and `RemovalGateActions` in `worker-lifecycle.ts`), the review invalidated by EC2 instances changed since it (`machinesChanged`), the review and report, carrying only printable fields (`ShownMachine`, `ShownDevice`, `ShownSecret`: no tag, no malformed host key), where a partial teardown stopped and what remains of each kind (`TeardownStop`, `remainingAt`, `stoppedPartWay`), the devices listed but kept carried past the devices step (`ListedDevices`), an interruption's words (`interruptedTeardown`), the state bucket's outcome (`TeardownBucket`: `deleted`, or `not_found` without one), why it runs without the lock when there is no state bucket, claiming only what EC2 showed (`ranWithoutLock`), and the IAM outside EC2 it leaves to the operator then (`checkOutsideEc2`), and the words of its refusals (`taggedWithoutBucket` among them) (`teardown.ts`; `TEARDOWN_OPERATION` and its stage statuses in `operation.ts`). No layout of a plan, its review or its refusals, a held lock or apply's worker lines as text: that is `cli/presentation/`'s. | Nothing outside `domain/`. No `node:*`, no Bun APIs, no I/O. |
| `application/` | Use cases (`resolveInstance`, `validateInstance`, `initInstance`, `doctor`, `requireExpectedAccount`, `bootstrapBackend`, `beginFactoryOperation`, `applySavedBootstrap`, the factory lock's `acquireFactoryLock`, `withFactoryLock`, `settleFactoryLock` and `breakFactoryLock`, `setSecret`, `deleteOwnedSecret`, `planFactory`, `applyFactory`, `applyWorkers`, `applyRepositories`, `applyControlPlane`, `applyDispatch`, `verifyFactory`, `upgradeFactory`, `factoryStatus`, `inspectWorker`, `inspectRepositories`, `inspectWork`, `inspectDispatch`, `stopDispatch`, `stopWorker`, `startWorker`, `terminateWorker`, `inspectRemovability` (`worker inspect`, lock-free), `teardownFactory`; and what removing a worker needs, shared by terminate and teardown: `inspectForRemoval`, `openTailnetAdmin`, `deleteDevices` in `worker-removal.ts`; and `readAgents`, a worker's agents through the `ControlPlane` port, unknown without one, beside it in `control-plane.ts`) and the ports they call (`InstanceStore`, `ToolProbe`, `CacheDirectoryProbe`, `AssetBundle`, `CallerIdentity`, `VpcQuotaProbe`, `ManagedTerraformProbe`, `Provisioner`, `LockStore`, `SecretStore`, `Approval`, `OperatorPrompt`, `PlanStore`, `HostTransport`, `TailnetPeers`, `MachineInventorySource`, `MachineControl`, `TailnetAdmin`, `ControlPlane`, `WorkflowQueue`), each port in its own file beside the use cases (`Approval` takes a `PlanReview`, never lines to show); the Terraform input projection (`projectFactoryVariables`, `projectBackendVariables`); `describeSource`, the discovery source's published words; `releaseAssetsDirectory`, `managedTerraformPaths` and `planStoreDirectory`, the cache layouts. | `domain/`, and pure `node:path`. |
| `infrastructure/` | Adapters implementing application ports (`filesystemInstanceStore`, `localToolProbe`, `filesystemCacheDirectory`, `releaseAssetBundle`, `stsCallerIdentity`, `awsVpcQuotaProbe`, `s3LockStore`, `secretsManagerStore`, `ec2MachineInventory` (the factory's tagged instances and VPCs) and `ec2MachineControl` over the shared `aws-session.ts`, `terminalPrompt`, `filesystemPlanStore`, `sshTransport`, `tailscalePeers`, `tailscaleApiAdmin` (the `TailnetAdmin` over Tailscale's API, at `tailscaleApiBase`: the loopback stand-in `FFFACTORY_TAILSCALE_API` names, for tests, read only run from source), `paseoControlPlane` (the `ControlPlane` over the host protocol), `ffflowGithubWorkflowQueue` (the `WorkflowQueue` over the host protocol), and managed Terraform in `terraform/`, with `NAMED_RESOURCES` and the namespacing check over a JSON plan), and the release tarball codec. | `application/`, `domain/`, Node and Bun APIs. |
| `host/` | The worker side of the host protocol (`docs/specs/host-protocol.md`): what `fffactory host` subcommands do on a worker, `workerInspector`, `workerApplier`, `workerVerifier`, the repository reconciler, `workerControlPlane` and `paseoAgents`, the only code that knows Paseo's agent statuses and translates them into fffactory's agent states, for `host control-plane activity` and for `host agents`, which the worker's dispatcher runs as `factory` for its capacity check, and `workerWork`, the work inspection (`workerEndpoint` together), over a `WorkerSystem` (root directory, process runner, hostname, machine, free space; for apply also the clock, privilege, standard input, release and install lock) that tests replace. An adapter layer beside `infrastructure/`, run only on workers. | `domain/`, `infrastructure/`, Node and Bun APIs. Never `application/`'s operator use cases or `cli/`. |
| `cli/` | Driving adapter and composition root: argument parsing, output, exit codes; `cli/descriptor-lines.ts`, both streams' raw line writers and shared queue, never `console` (`docs/specs/cli-output.md` §Plain output); `cli/release.ts` is the single source of the running release version; `cli/presentation/`, the human layout of what use cases return as data (`presentation/plan.ts`: every plan review, plan refusal and `StaleReason` in blocks, `plan`'s Next block, the unready state bucket's guidance, and the still unstyled removal plan; `presentation/lock.ts`: a held lock and the lock refusal; `presentation/instance-source.ts`: the `Instance:` line and the restyled commands' header; `presentation/command-line.ts`: the `fffactory` commands a Next block names, with the instance and profile given, shell-quoted, and those fffactory's own words name, as code spans (`withCommands`); `presentation/apply.ts`: apply's and upgrade's run, its Applying rows, its Result and its one Next block from the complete `FactoryApply` (a saved bootstrap plan's too), each line for its stream; `presentation/workers.ts`: a worker's Result row across its stages, and its enrollment's Next steps rendered from a `WorkerEnrollment`; `presentation/teardown.ts`: teardown's review, its steps under the Removing section, and each outcome as one report on one stream, the commands fffactory's own words name as code spans (`withCommands`); `presentation/worker-inspection.ts`: `worker inspect`'s report and its refusal of a KEY, and `presentation/agents.ts`: a worker's agents in one line (status's `Agents:` line too) and by state, in the same words for each state; `presentation/style.ts`, `color.ts` and `blocks.ts`: the style roles, the color rule and the layout blocks, with their own rules in [`cli/presentation/CLAUDE.md`](cli/presentation/CLAUDE.md)). | Everything. Only `cli/main.ts` touches `process`, the random source, and wires concrete adapters. |

Dependencies point inward: `domain <- application <- infrastructure, cli`, and
`domain <- host <- cli`.

## Rules

- Define a port in `application/` only when a use case calls it. No speculative ports.
- Human-only layout lives in `cli/presentation/`; `domain/` and `application/` return data.
  Published wording, the words a JSON report carries (`summary`, `next_action`, `details`),
  stays where it is made, and human output reuses it rather than restating it. The exceptions
  so far: `describeSource` (`application/resolve-instance.ts`), which doctor's `instance`
  summary embeds; `describeNextAction` and `pendingEnrollmentLines` (`domain/readiness.ts`),
  status's enrollment `details`, with `NextAction.summary` its `next_action`; and the
  `details` builders of `domain/aws-account.ts`, `vpc-quota.ts` and `status.ts`. Changing one
  changes a published report. Never import `cli/` from `domain/` or `application/`, and never
  map the same thing twice in different words.
- Color policy is wired only in `cli/main.ts`, which reads each stream's `isTTY` and the
  environment once (`streamStyles`); every other module takes the `Style` that `CliContext.out`
  or `err` carries, and JSON is never styled (`docs/specs/cli-output.md`).
- A mutating use case takes the account check's `AllowedAccount` as proof, or runs
  `requireExpectedAccount` itself, before any AWS call that could change anything.
- Every stage of a mutating factory operation runs under the one factory-wide lock
  (`application/factory-lock.ts`, `docs/specs/provisioning.md` §Lock). Nothing takes it
  over or expires it; only `fffactory lock break`, confirmed by the lock ID, removes it,
  and logs the break first. An interrupted operation never releases it
  (`settleFactoryLock`), and records each step in its operation record.
- Apply applies only the exact plan approved: a fresh plan approved at the terminal, or a saved
  plan named by its ID, whose freshness (factory.json's text, release and assets, account,
  Terraform state revision, age) is checked first (`docs/specs/plan-apply.md`). A saved
  bootstrap plan is bound to the state bucket's absence in place of a state revision, and to
  `backend.tfplan`: `applySavedBootstrap` plans nothing, rechecks the bucket missing and the
  file's SHA-256 right before applying exactly that file, reads it back as its record's
  create-only changes, spends the plan right before its apply starts (`PlanStore.spend`: its
  record durably removed, never loadable again, its file kept for Terraform), takes the lock
  right after the bucket exists, and apply records `plan_id` with the `backend` stage alone and
  stops: the factory is planned next, never in the same apply. `planFactory` saves that bootstrap plan
  while the bucket is missing, and a factory plan once it exists; a plan refused or failing
  saves nothing and leaves no plan directory. The workers
  stage (`application/apply-workers.ts`) is the second step under the same lock and record, and
  its changes, each declared worker's install, are in the one plan approved. The repositories
  stage (`application/apply-repositories.ts`) follows it under that lock and record, and its
  per-worker manifest projection is also shown in the approved plan; a new stage follows the
  same rule. The dispatch stage never fails a worker the workers stage skipped (its maintenance
  deferred, offline, ...): it sends it nothing and reports it `skipped`, which exits 2, not 1
  (`docs/specs/dispatch.md` §Skipped workers). Only a deferred worker also bypasses the
  control-plane stage; one skipped for another reason that the tailnet still locates is
  reconciled there, and may fail. A worker whose machine is stopped is no skip: apply reads the
  EC2 inventory once under its lock (`declaredMachines`), the plan shows the worker skipped, a
  saved plan records it (`stopped_workers`, stale once it changes), and every stage sends it
  nothing and reports it `stopped`, which never makes the operation partial. A plan that changes
  the instance type of a worker stopped or stopping, or of any while the inventory cannot be
  read, is refused (`resizeRefusal`): the pinned AWS provider starts an instance to resize it
  (`docs/specs/plan-apply.md` §Stopped workers). The workers stage waits, within
  `FIRST_BOOT_DEADLINE_MS`, only for the workers whose machine the approved plan created
  (`createdWorkers`), never for one missing for another reason, and the match rule's refusals
  still apply at every look (`docs/specs/plan-apply.md` §Waiting for a new worker). Waiting goes
  through the injected `sleep` (`CliContext.sleep`) and checks `interrupted` after every sleep.
- Only the release factory.json pins may change the factory: `plan`, `apply`, `secret set`,
  `worker stop|start|terminate` and `teardown` refuse otherwise (`pinRefusal`). `upgrade` moves the pin forward,
  writing it under the lock once its plan is approved; `init` and `lock break` are not guarded
  (`docs/specs/plan-apply.md` §CLI/pin match guard). What a release declares about the
  factories it can operate is `RELEASE_COMPATIBILITY`, never the bundle's `release.json`,
  which the activator on existing workers reads.
- Secret material is a `SecretMaterial` from a hidden prompt, standard input or
  `SecretStore.read`, never a command argument; only a `SecretStore` adapter calls `reveal`,
  `tailscaleApiAdmin`, for the admin client's token requests (one renewal per call
  refused with HTTP 401), the worker's `credentials` step (`host/credentials.ts`), onto a
  delivering command's standard input (`docs/specs/credential-delivery.md`), and the worker's
  control-plane install (`host/control-plane.ts`), only into the Paseo password's bcrypt hash
  (`docs/specs/control-plane.md` §The daemon password). factory.json keeps only
  the ARN (`docs/specs/secrets.md`). Arguments of `secret` are never echoed.
  `tailscale.admin_client_secret`, the operator's admin-tier Tailscale OAuth client, never
  reaches a worker: neither the host projection nor the Terraform inputs carry it, so the
  hosts' IAM policy cannot read it.
- A secret is deleted only as an `OwnedSecret`, through `deleteOwnedSecret`: its name under
  `<factory ID>/` and both fffactory tags exact, never a referenced source such as `fffv/*`.
  It is `absent` only once `DescribeSecret` no longer finds it; a forced deletion that
  succeeded, a timeout or a denial is never proof (`docs/specs/secrets.md` §Deleting a
  factory's secrets). ListSecrets lags, so a factory.json reference under `<factory ID>/` it
  did not list is described (`SecretStore.describe`) and judged by the same `classifySecrets`;
  one whose ownership cannot be told is never taken for kept or absent (§Listing).
- The state bucket is deleted only by `LockStore.deleteBucket`, never by Terraform
  (`prevent_destroy`): every version and delete marker by version ID, each listed page before
  the next, the lock's only once every other is gone, oldest first and the current one alone
  and last, stopping at the first refusal, so a failure before them leaves the factory locked
  and none revives an earlier holder's lock; then DeleteBucket, whose success, or S3's 404,
  alone makes it `absent`. The lock goes with the bucket: on `absent` its caller neither releases it nor
  writes an operation record, and `remains` says whether it is still held (`lock`)
  (`docs/specs/provisioning.md` §Deleting the state bucket).
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
  `application/provisioner.ts`); commands print that file's path (`cli/diagnostics.ts`, or
  apply's Result), never its text, and it never reaches an operation record or the state bucket.
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
  Likewise only a run from source reads `FFFACTORY_TAILSCALE_API`, a loopback
  stand-in for tests: the compiled executable sends the Tailscale admin
  client's secret only to Tailscale (`docs/specs/worker-lifecycle.md`).
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
  `cli/main.ts`, which passes `process.stdin` and the shared descriptor output queue to
  `terminalPrompt`. Questions flush prior output before entering raw mode or reading an
  answer; interruption cancels that wait without accepting input.
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
  with `waitsOnInterrupt` (`apply`, `upgrade`, `doctor`, `status`, `worker`, `teardown`) is first waited for, at most
  `RETURN_GRACE_MS`, so it can report what the interrupt left; it must return promptly: a use
  case that holds the lock takes `interrupted` and, once it is set, starts nothing more and
  writes no more of its operation record, and a read-only report (`doctor`, `status`, `worker
  inspect`) is not printed, since its tools were stopped. Never set `waitsOnInterrupt` on a command that does
  not check `interrupted` (`host apply`, `secret set`, `lock break`): waited for, it would go
  on mutating after the signal. Normal exit flushes `descriptorOutput` while handlers stay
  installed; interrupted reporting and flushing share the return grace, then pending output
  is discarded so an undrained pipe cannot prevent exit.
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
  projection (`domain/host-projection.ts`): non-secret (secret references at most), canonical,
  streamed on standard input, never an argument. Both go through `HostTransport`'s `stdin`.
  The workers stage's caller builds the projections with `projectHosts` from the instance; a
  stage that projects one host passes `projectHost` the instance and the `Host` it took from
  factory.json's `hosts`, never a narrower shape, so what apply sends is what plan and status
  digest. The control-plane plan digests only its control-plane part, so a credential
  reference never plans Paseo maintenance. The
  compiler does not enforce this (`Host` requires only `key`); the pipeline test
  (`tests/application/apply-factory-pipeline.test.ts`) does: `host apply` and the Paseo install
  must get the same projection, and the plan and `status` after the apply must find it current.
- The host protocol is versioned JSON (`HOST_PROTOCOL_VERSION`). Additions keep the
  version and readers ignore unknown fields; removals, renames and new state values bump
  it, and the CLI rejects any other major version. The worker side and the CLI side share
  `tests/host/fixtures/`; change a fixture only with both sides. A worker's document carries
  states and fffactory's words, never instructions: whatever the CLI prints as a command to
  run it builds itself, from the hostname it resolved and its own factory.json (which accounts
  it delivers), and it trusts an answer only for the
  worker and release it asked about.
- `worker stop|start|terminate` (`application/worker-lifecycle.ts`,
  `docs/specs/worker-lifecycle.md`) acts on the one EC2 instance carrying the factory ID and
  host key tags, never a guessed one, under the lock and its record, and only after
  confirmation (y/N at a terminal, or `--yes`; terminate: the host key typed, or `--confirm
  KEY`, never `--yes`). EC2's state is the truth: factory.json keeps no power field. The gates
  of stop (busy agents by the busy rule, `workerActivity`, so finished, failed and stopped ones
  never refuse; a running worker it cannot inspect) and terminate (also work not
  pushed to any remote in any checkout or worktree, read fresh with `inspectWork` once the
  activity is read and only when it does not already refuse, and unresolved or unmanaged
  checkouts in the last repository result; a stopped machine passes uninspected) are skipped
  only by `--force`, never the account check, pin guard, lock or confirmation. Work that cannot
  be inspected, including on a worker whose activator predates `work inspect`, and a checkout
  factory.json places there that the inspection does not report, refuse terminate; neither
  ever reads as no work. A worker the tailnet does not
  locate refuses terminate with its own next action (`--force` once the EC2 console output
  shows a failed bootstrap), never status's recovery, which is terminate itself. Terminate opens its tailnet admin
  session before EC2 is asked anything, and deletes no device and removes no host before its
  typed-key confirmation, even for a machine EC2 is already terminating or one already gone
  (with `--keep`, asked before the wait for `terminated`); a tailnet device it could not delete makes it partial,
  exit 2, never undone. With `--keep` it keeps the host in factory.json and never runs
  Terraform. Without it, it removes the host (`docs/specs/worker-lifecycle.md` §Terminate
  (remove)): the only path that may destroy one host machine or drop a recorded host key (teardown's
  guarded destroy plan destroys the whole factory, `destroyPlanRefusal`). Its
  plan is factory.json without the host, planned under the lock (and Terraform's state lock)
  into a plan file of its own, and refused unless `removalPlanRefusal` passes it: only that
  host's machine destroyed (when EC2 lists one, that very instance, and never when it lists
  none) and, for a host with its own Paseo password, the hosts' policy dropping exactly that
  ARN. The plan is shown, approved with the typed key, applied exactly, and the recorded keys
  read again; only then is factory.json written (`InstanceStore.write`), and only while it is
  still the text read, then the devices deleted. Every partial state names its next action, and
  a rerun finishes it: a host whose machine is already gone is removed without gates, and with
  `--keep` only has its devices deleted (an unreadable EC2 inventory is refused, never taken for
  a machine gone). The last declared host is removed like any other, leaving an empty factory:
  `hosts: []` is complete, and plan, apply and status say no worker is declared and exit 0
  (status once its inventories are ready). Next actions rerun the command as given
  (`WorkerCommand`), never with `--keep` added or dropped. Waits for a machine state or the
  tailnet go through the injected `sleep` and check `interrupted` after every sleep.
- Only teardown asks the `Provisioner` for a destroy plan (`PlanRequest.destroy`), and its JSON
  plan is judged by `destroyPlanRefusal` before it is shown or confirmed: only deletes, reads and
  no-ops, root outputs only deleted or left, each instance deleted the one EC2 lists for its host
  (`docs/specs/provisioning.md` §Destroy plan). A plan deleting only root outputs, of a state
  recording outputs but no resource, agrees with exit 2 and is applied, reported `absent`. `plan` and `apply` never
  plan in destroy mode and keep the D11 refusals.
- Teardown (`application/teardown-factory.ts`, `docs/specs/teardown.md`) removes the factory
  under the lock and its record, in D6's order, the state bucket last. A listing that fails
  (EC2 instances or VPCs, secrets, devices) refuses it, never read as an empty one, and so
  does a reference under `<id>/` the secrets listing left out that DescribeSecret cannot look
  up (`resolvedSecrets`), so no run ends `done` with one unresolved. It stops
  dispatch on every running worker, lists EC2's instances again and refuses unless they are as
  reviewed, then inspects each running worker once, freshly, by terminate's gates, with no
  `--force`. It deletes no namespace device the review did not show deleted. It remembers every
  known host key in its record with the `applying` step alone, so only a teardown whose destroy
  may have begun remembers any, and reads back those earlier teardowns remembered
  (`LockStore.readOperations`, the only records read to decide anything), passing over those an
  apply or upgrade that may have changed the factory started after, so a rerun deletes the
  devices of a host the state and EC2 no longer name; a record it cannot read refuses it
  (§Devices). Once `LockStore.deleteBucket` answers `absent` the lock and record are gone with
  the bucket: nothing is written into it and the lock is not released (`settleFactoryLock` is
  skipped); a bucket that remains with its lock's versions touched gets no more writes. From
  the destroy on, whatever stops it is `partial`, saying where it stopped and what remains of
  each kind (`docs/specs/teardown.md` §Partial failure); a rerun inventories afresh and
  finishes from every partial state. It goes on without the admin client only when its secret
  is gone as only teardown leaves it (under `<id>/`, `DescribeSecret` no longer finding it) and
  nothing it removes before the devices remains, reporting the devices not checked, never
  remaining (§Rerun). An interrupt keeps the lock and is reported `interrupted` whatever the
  run returned, unless the bucket is gone; `fffactory lock break` is named only for the
  teardown once fffactory has exited (§Interruption). Without a state bucket (S3's 404) there is
  no lock to take: it writes no record, never creates a bucket or runs Terraform, refuses while
  EC2 lists any instance or VPC tagged with the factory ID, and, once confirmed, checks again
  that the bucket is still missing and nothing tagged appeared before it removes the devices and
  owned secrets in the same steps as under the lock (§No state bucket). `fffactory teardown`
  (`cli/commands/teardown.ts`, §Command) takes only `--confirm FACTORY_ID`, `--instance` and
  `--profile`, refusing anything else before anything is read and never echoing it, and exits
  0 once nothing owned remains, 2 part way, 1 otherwise (§Output and exit codes); it has no
  `--json` yet (`TODO(re-evaluate when a caller must parse teardown's result)`).
- The Tailscale API is reached only through `TailnetAdmin` (`infrastructure/tailscale-api-admin.ts`),
  as the factory's admin client (`tailscale.admin_client_secret`): each request within its
  deadline and following no redirect, failures named by HTTP status or network code, no answer
  body, token or secret ever printed, recorded or in an argument, and the token, and the
  secret it is renewed from once per call refused with 401, kept only in its session. It sends the secret with a placeholder client ID, as Tailscale's own CLI does:
  undocumented behavior, recorded in `docs/specs/worker-lifecycle.md` §Tailnet device removal.
  A device is deleted only when `selectWorkerDevices` finds its reported hostname is the
  worker's, exactly but for case, and it carries the factory's tag; never by its MagicDNS label,
  which can be another worker's (`builder`'s second device labelled `builder-1`). One without
  the tag is reported by its ID, never deleted.
- `status` is read-only: no lock, no record, no stored result. A stopped machine is a worker's own
  verdict, `stopped`, which counts as ready (`WorkerState`). It reads each reached worker's
  agents through the activity call alone, once dispatch has been (both hold the activator), and
  never the work inspection; activity is reported, never judged. `schemas/status-report.schema.json`
  mirrors `statusJson` in `cli/commands/status.ts`, versioned as doctor's report is, except that
  a new worker state is an addition, keeping the version (`docs/specs/status.md` §JSON).
- `worker inspect` (`application/worker-removability.ts`, `docs/specs/worker-lifecycle.md`
  §Inspect) is read-only like status: no lock, no record, no confirmation, and no pin guard, but
  the account check first. It runs terminate's own code, never a copy: `selectMachine` and
  `powerStep` for the machine, `inspectForRemoval` for a running worker, `removalGate` for the
  verdict, with its own next actions (`inspectGateActions`). Its per-worker document,
  `RemovalInspection`, is the domain's and names no next action, which is the judging
  command's: `--json` prints it as each worker's `inspection`, its next action beside it
  (`WorkerRemovability`), so terminate's and teardown's records carry the same object as it is,
  built by the same `workerRemovability`, never a copy, `forced` beside it (`InspectionRecord`,
  `docs/specs/worker-lifecycle.md` §Operation record). Its words name no command's flags, as
  teardown, which has no `--force`, records it too.
  `schemas/worker-inspection.schema.json` mirrors `inspectionJson` in
  `cli/commands/worker-inspect.ts`, versioned as status's report is; its `activity` and `agent`
  definitions are status's, and `tests/cli/worker.test.ts` checks both the output and that.
- Run `just check-all` before committing.
