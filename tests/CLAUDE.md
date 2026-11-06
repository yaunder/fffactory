# tests

`bun test` suites mirroring `src/`, plus `assets/` for the release assets:
`domain/` (pure, no fakes), `application/` (use cases against in-memory ports
from `support/`), `infrastructure/` (real temporary directories), `cli/`
(in-process `run` through `support/cli-harness.ts`, whose streams are plain unless a test
colors one with `styles`, and which keeps both streams' lines in the order written
(`written`), and the spawned `main.ts`; `cli/presentation/` checks the text laid
out from domain data, pure like `domain/`, while `application/` tests assert that data, never
its text).
Each test maps to a section of a spec in `docs/specs/`.
`domain/fixtures/archive/` holds archive format v1's documents and the collector's checkpoint
(`docs/specs/collector.md`), each its serializer's output byte for byte; the collection run
and the archive's reader read the same fixtures. The collection run (`host/collect.test.ts`)
writes to `support/memory-archive.ts`, an in-memory `ArchiveWriter` with failures and crashes
injected per put, and reads it back by the reader's rules with `support/archive-reassembly.ts`.
Areas with their own rules:

- [`host/`](host/CLAUDE.md): the worker side of the host protocol, and its shared contract
  fixtures.
- [`assets/`](assets/CLAUDE.md): static checks of the Terraform modules, install steps and
  bootstrap.
- [`bootstrap/`](bootstrap/CLAUDE.md): the worker bootstrap's shell tests, run as root in
  Amazon Linux 2023 containers by `just bootstrap-test`, never by `bun test`.
- [`paseo/`](paseo/CLAUDE.md): the pinned Paseo daemon against the password hash fffactory
  writes, in a loopback-only namespace, by `just paseo-check`, never by `bun test`.

Tests read no AWS account or factory state and never depend on the operator's own
`.fffactory/`. `support/aws-isolation-preload.ts`, preloaded by `bunfig.toml`, strips
every `AWS_*` variable from the test process, disables instance metadata and points it
and every AWS endpoint at a closed local port; `infrastructure/aws-isolation.test.ts`
proves it. A spawned `fffactory` gets an explicit environment built on
`isolatedAwsEnvironment` from `support/aws-isolation.ts`, never the inherited one. Test
AWS through a fake `CallerIdentity` or `VpcQuotaProbe` (`support/doctor-fakes.ts`), the
versioned in-memory `support/memory-lock-store.ts` (whose bucket deletion removes only that
bucket's records and break log, and can stop before the lock, or after it with the bucket left,
`deletionLeaves`, or at an interrupt set by `beforeLock`, and whose `unreachable` buckets answer
`bucketExists` with S3's 403, and which reads back its operation records, with any text `store` put
under their prefix, through `readOperations`; a log archive is one of its buckets, ready as the
archive root leaves it, `READY_ARCHIVE`, unless `archives` says otherwise) and
`support/memory-plan-store.ts` (whose `swap` of `"archive"` changes a plan's `archive.tfplan`),
the fakes in `support/fake-secrets.ts` (Secrets Manager, whose listing, restore, deletion,
descriptions and looks answer as scripted and are recorded in `calls`; `fakeSecretsManager`, a
world of secrets those calls change, so a rerun sees what the run before deleted, with failures
a test sets and clears between runs, secrets the listing leaves out though they are there
(`unlisted`, as ListSecrets lags), deletions left lingering until `finishDeletion`, and
descriptions and looks (`describe`, `exists`) that find a secret by its full or partial ARN,
only in the Region its ARN names; and the operator prompt) and
`support/fake-provisioner.ts` (a scripted `fakeProvisioner`, and `fakeFactoryWorld`, a
factory whose Terraform state changes as plans apply and whose apply can be stopped part
way, whose `archive` root creates the log archive its variables name (`ARCHIVE_ADDRESSES`,
shown as `archiveShown` when set), which can replace a host or change its instance type in place (`resize`), and whose
`showPlan` gives every change a `before` and an `after` as `terraform show -json` does;
`support/factory-world.ts` builds the plan and apply fixtures on it, `archiving` enabling the
log archive, `ARCHIVE`), stubbed SDK calls,
or the real SDK pointed at `support/stub-sts.ts` (whose caller's `UserId` a test may give, and
which records each request's session token), `support/loopback-imds.ts` (a loopback IMDSv2:
token, role credentials with a known session token, and identity document, refusing a request
without its token; the SDK reads its endpoint only from `AWS_EC2_METADATA_SERVICE_ENDPOINT`, which
`withMetadataEndpoint` sets in the test process for one call and restores), `support/stub-vpc-quota.ts` (EC2 and
Service Quotas), `support/stub-s3.ts` (a versioned, never-versioned or suspended bucket
with conditional writes and bootstrap's settings, and the log archive's ownership controls and
ABAC status, some of them lackable, older versions and
delete markers (`addVersions`), a current delete marker, written as a DeleteObject without a
version ID writes one (`markDeleted`), whose deletion makes the version under it current again,
ListObjectVersions with `IsLatest` and `LastModified`, in pages resumed after their markers even
once those versions are deleted, and refusing with `InvalidArgument` a version marker it never
gave, DeleteObjects with per-key
failures (`undeletable`) recorded in `deleteBatches`, DeleteBucket refused while
anything is left, ListObjectsV2 under a prefix in pages of `listPageSize`, a PutObject without
`If-None-Match: *` refused as the archive's hosts policy does (`requireIfNoneMatch`), any request
refused with an error a test chooses (`refuse`), and each request's session token, `forcePathStyle`) or `support/stub-secrets-manager.ts` (which also answers `GetSecretValue`, and ListSecrets,
RestoreSecret, DeleteSecret and DescribeSecret (name, ARN, tags and deleted date) as AWS documents them: tag filters by prefix,
scheduled secrets, pages of `pageSize`, a forced deletion of a scheduled secret refused and one
still described for `lingering` looks), with AWS's documentation example
keys and account `123456789012`. The terminal prompt runs over a `PassThrough` stand-in
terminal, never the test's own. A secret-handling test searches every output line, file
and argument for the value it used. Spawn a CLI that talks to a stub in the test process
with the asynchronous `support/spawn-cli.ts`, which can also feed its standard input: a
synchronous spawn blocks the stub.

Tests never run the host's `ssh` or `tailscale`, or reach a worker or tailnet: use the
fakes in `support/doctor-fakes.ts` and `support/fake-workers.ts` (the EC2 inventory and its tagged VPCs, the
peer view, an SSH transport scripted per worker hostname, this machine as a worker), an
injected `ProcessRunner`, or stand-in scripts on a private `PATH` holding only the real
tools they need (`cli/main.test.ts`, `cli/status-executable.test.ts`, which also points
EC2 at `support/stub-ec2-instances.ts`, which also answers `StopInstances`,
`StartInstances` and `TerminateInstances`, and `DescribeVpcs`, applying its tag filters, and
whose answers a function may give afresh at each request). `cli/teardown-executable.test.ts`
spawns `main.ts` against every stand-in at once: STS, S3, Secrets Manager, EC2 (listing the
factory's instance and VPC until the stand-in Terraform, the managed one's cache hit, has
applied), and Tailscale's API through `FFFACTORY_TAILSCALE_API`, with stand-in `tailscale` and
`ssh` on its private PATH, and checks every endpoint it was given is on 127.0.0.1 before it
runs, and that no secret value reaches Terraform's arguments or environment. Only `main.ts`
run from source reads `FFFACTORY_TAILSCALE_API`, and only a loopback `http://` origin.
`worker stop|start|terminate` run against
`fake-workers.ts`'s `fakeMachineControl`, whose state reads follow a script and which
records every call, so a test can assert EC2 was never asked to change anything
(`mutations`), and terminate against its `fakeTailnetAdmin`, a tailnet of `tailnetDevice`s
recording every call and the secret each `open` got, and `fake-secrets.ts`'s
`fakeSecretStore` reading the admin client by its ARN. Terminate's work inspection answers
through the same scripted transport: `statusAnswers` answers it, by default with no work, or
with `workAnswer`'s document (without the log archive's backlog, as an older worker answers,
unless a test gives one) or any outcome a test gives. `worker inspect` runs terminate's
inspection over the same fakes, and a test asserts it took no lock and asked EC2 and the admin
client nothing. Terminate's and teardown's records are compared with `worker inspect`'s
documents (`printedBy`), each run in its own world built with the same options, so neither
asks the other's fakes anything. The CLI harness wires no `controlPlane` unless a test gives one: status then
reports every worker's activity unknown, and its tests give `fakeControlPlane` for agents. Terminate removing the host plans and
applies against `fakeFactoryWorld` (whose network exists once it is given hosts or applied,
and stays when its last host is removed, as an empty factory's does; which plans deleting a
provisioned key no longer declared,
its `before` naming the instance the state holds (`instanceIds`), records it no longer once
applied, and, given the secrets the hosts' policy allows (`secretArns`), plans that policy's
in-place update as Terraform renders it) and writes factory.json to `MemoryInstanceStore`.
Teardown (`application/teardown-factory.test.ts`) runs against the same world, whose destroy
plan (`PlanRequest.destroy`) deletes the root outputs its state records (`rootOutputs`, in
`output_changes`, counted as changes as `-detailed-exitcode` counts them) and every host machine
and its network (`network`, also for a factory without hosts), applying the outputs' deletion
first, as Terraform does, so a destroy stopped part way leaves resources and no output, and one
failing before its first change (`beforeChange(0)` throwing) leaves outputs and resources as
they were, as Terraform does when it fails before it begins; a test
makes a state recording outputs and no resource by clearing `hosts` and `network`, and its plan
deletes only the outputs; an EC2 inventory the test derives from that world so instances and
`NETWORK_VPC` vanish once it is destroyed, `fakeWorkflowQueue` and `fakeControlPlane` wrapped
to order dispatch stops before inspections, `fakeSecretsManager`, and `MemoryPlanStore`'s
`removeAll`; a rerun runs teardown again over the same world.
Tests never reach Tailscale's API: `infrastructure/tailscale-api-admin.test.ts` sends real
HTTP to
`support/stub-tailscale-api.ts`, a local stand-in for the token exchange, the device list
and deletion that echoes refused requests back, so a test can assert no body, token or
secret reaches a reason; its `expireTokens` expires the tokens granted so far, and
`redirectTo` answers every request with a redirect. The workers stage
runs against `support/fake-workers.ts`'s scripted transport, whose `installableWorker`
answers the upload and the activator, and `support/factory-world.ts`'s `workerFleet`,
whose EC2 inventory lists no machine until a test sets `machines.inventory` (a stopped
worker, or an inventory that cannot be read) and counts its reads. Digests there are
real: the fleet digests projections as the CLI does, and an `installableWorker` keeps the
projection its activator was streamed (`projections`) and from then on reports that
text's SHA-256 as its configuration (and, as `host inspect` does for one carrying credential
references, its control-plane part's SHA-256 apart), so a plan or `status` after an apply sees exactly
the drift, or the clean rerun, a real worker would. `status`'s unit tests
(`application/status.test.ts`) do not: they still digest with `FAKE_SHA256`, which gives
every text the same constant, so they cannot see a projection that drifted. `declaring`
gives every host a Paseo password reference, as completeness requires: its own
(`paseoPasswordArn`, builder-1's `PASEO_PASSWORD_ARN`) unless given another,
`requestingDispatch` places a repository and requests dispatch on the host, and
`currentWorker` is a worker already current for the plan, holding that reference unless
given another, or `null` for none. The control-plane and dispatch stages run against
`support/fake-control-plane.ts`: a `ControlPlane` answering health and the worker's agents as
given (`agentsIn` lists one agent in each state named, `{ kind: "outdated" }` stands for a
worker on a release from before agent states), and a `WorkflowQueue` that counts adoption checks and records every projection
reconciled, so a test can assert a skipped worker was sent nothing. Stopping dispatch runs
the real `WorkflowQueue` adapter over `fakeTransport`, the worker answering with
`dispatchAnswer`. Nothing sleeps for
real: a new worker's first boot is waited out with `fakeTailnet`'s view changing read by
read, and `fakeTime`'s clock, which moves only when the stage sleeps (or `workerFleet`'s
recorded sleeps); the CLI harness's `sleep` returns at once. The one real sleep is
`support/apply-first-boot-main.ts`'s, an apply over the in-memory factory with
`cli/interrupts.ts` wired to its own process, which `cli/apply-interrupted.test.ts` cuts
short with SIGINT once apply says it waits: `main.ts` run from source has no worker
executable, so it never reaches the wait. `cli/interrupts.ts` itself is tested over a
stand-in process (`cli/interrupts.test.ts`). Expected JSON output lives in
`cli/fixtures/` and is compared byte for byte; biome leaves `**/fixtures/**/*.json`
alone, since its formatting would not be `JSON.stringify`'s.

Tests that spawn processes wait
with the deadline-bounded polling in `support/processes.ts`, never a fixed
sleep, and kill any survivor in `afterEach`. Hostile or broken release
tarballs are built with `support/raw-tarball.ts`, which bypasses the packer's
checks; `unpackWithin` there unpacks one in a worker it terminates at a
deadline, for input that could make the parser loop. The compiled executables are not run by `bun test`: `scripts/smoke-test.sh`
tests them in a clean container with AWS sealed off the same way, and
`--network none`. `install/` runs `install.sh` against
`support/fake-github-releases.ts`, a local stand-in for the GitHub Releases API, with a
private `PATH` of stand-ins (`uname`, `gh`, `sysctl`, `sudo`, a logging `curl`), links to
the few real tools it needs, and its own `HOME` and `TMPDIR`; it never reaches GitHub or uses
the host's `gh`, and asserts the token appears in no output or `curl` argument. `scripts/`
runs release scripts in a stand-in repository.

No test downloads or runs real Terraform:
the installer runs against `support/fake-hashicorp-releases.ts`, a local stand-in for
releases.hashicorp.com serving archives built by `support/zip.ts`, and the runner and
provisioner run `support/fake-terraform.ts`, a stand-in that records its arguments,
working directory, environment and any SIGINT; `cli/apply-interrupted.test.ts` installs it
as the managed Terraform's cache hit and interrupts a spawned `apply`, and
`cli/plan-apply.test.ts` runs the real provisioner over it in process to check where a failed
command's diagnostics go. `stopRunningTools`
refuses every later command in its process, so it is tested only in a child process,
`support/stop-tools-main.ts`. `descriptorOutput` is tested over a real pipe in
`support/descriptor-lines-main.ts`, read by a deliberately slow reader (`sleep` before `wc`)
so the pipe fills: a delay in the reader, not a wait for the process. The undrained-pipe
regression (`cli/descriptor-interrupted.test.ts`) keeps both pipes open without reading,
waits for a real EAGAIN marker, then verifies first-signal stopping and bounded exit,
including during normal output flushing and a prompt waiting to show its review, and
second-signal killing. The merged-pipe prompt case verifies its question, echo and
newline follow the full review. `infrastructure/terminal-prompt.test.ts` verifies a
cancelled review flush never enters raw mode or reads an answer.
