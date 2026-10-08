# tests

`bun test` suites mirroring `src/`, plus `assets/` for the release assets:
`domain/` (pure, no fakes), `application/` (use cases against in-memory ports
from `support/`), `infrastructure/` (real temporary directories), `cli/`
(in-process `run` through `support/cli-harness.ts`, and the spawned `main.ts`).
Each test maps to a section of a spec in `docs/specs/`. Areas with their own rules:

- [`host/`](host/CLAUDE.md): the worker side of the host protocol, and its shared contract
  fixtures.
- [`assets/`](assets/CLAUDE.md): static checks of the Terraform modules, install steps and
  bootstrap.
- [`bootstrap/`](bootstrap/CLAUDE.md): the worker bootstrap's shell tests, run as root in
  Amazon Linux 2023 containers by `just bootstrap-test`, never by `bun test`.

Tests read no AWS account or factory state and never depend on the operator's
own `.fffactory/`. `support/aws-isolation-preload.ts`, preloaded by
`bunfig.toml`, strips every `AWS_*` variable from the test process, disables
instance metadata and points it and every AWS endpoint at a closed local port;
`infrastructure/aws-isolation.test.ts` proves it. A spawned `fffactory` gets an
explicit environment built on `isolatedAwsEnvironment` from
`support/aws-isolation.ts`, never the inherited one. Test AWS through a fake
`CallerIdentity` or `VpcQuotaProbe` (`support/doctor-fakes.ts`), the versioned
in-memory `support/memory-lock-store.ts` and `support/memory-plan-store.ts`, the fakes in
`support/fake-secrets.ts` (Secrets Manager and the operator prompt) and
`support/fake-provisioner.ts` (a scripted `fakeProvisioner`, and `fakeFactoryWorld`, a
factory whose Terraform state changes as plans apply and whose apply can be stopped part
way; `support/factory-world.ts` builds the plan and apply fixtures on it), stubbed SDK
calls, or the real SDK pointed at `support/stub-sts.ts`, `support/stub-vpc-quota.ts`
(EC2 and Service Quotas), `support/stub-s3.ts` (a versioned, never-versioned or suspended
bucket with conditional writes and bootstrap's settings, some of them lackable, `forcePathStyle`) or `support/stub-secrets-manager.ts`, with AWS's documentation
example keys and account `123456789012`. The terminal prompt runs over a `PassThrough`
stand-in terminal, never the test's own. A secret-handling test searches every output
line, file and argument for the value it used. Spawn a CLI that talks to a stub in the
test process with the asynchronous `support/spawn-cli.ts`, which can also feed its
standard input: a synchronous spawn blocks the stub.

Tests never run the host's `ssh` or `tailscale`, or reach a worker or tailnet: use the
fakes in `support/doctor-fakes.ts` and `support/fake-workers.ts` (the EC2 inventory, the
peer view, an SSH transport scripted per worker hostname, this machine as a worker), an
injected `ProcessRunner`, or stand-in scripts on a private `PATH` holding only the real
tools they need (`cli/main.test.ts`, `cli/status-executable.test.ts`, which also points EC2
at `support/stub-ec2-instances.ts`). The workers stage runs
against `support/fake-workers.ts`'s scripted transport, whose `installableWorker` answers the
upload and the activator, and `support/factory-world.ts`'s `workerFleet`. Digests there are
real: the fleet digests projections as the CLI does, and an `installableWorker` keeps the
projection its activator was streamed (`projections`) and from then on reports that text's
SHA-256 as its configuration, so a plan or `status` after an apply sees exactly the drift, or
the clean rerun, a real worker would. `status`'s unit tests (`application/status.test.ts`) do
not: they still digest with `FAKE_SHA256`, which gives every text the same constant, so they
cannot see a projection that drifted. `declaring` takes a host with a Paseo password reference
(`PASEO_PASSWORD_ARN`), `requestingDispatch` places a repository and requests dispatch on the
host, and `currentWorker` is a worker already current for the plan. The control-plane and
dispatch stages run against `support/fake-control-plane.ts`: a `ControlPlane` answering health
and agent activity as given, and a `WorkflowQueue` that counts adoption checks and records every
projection reconciled, so a test can assert a skipped worker was sent nothing.
Nothing sleeps for real: a new worker's first boot is waited out with `fakeTailnet`'s view
changing read by read, and `fakeTime`'s clock, which moves only when the stage sleeps (or `workerFleet`'s recorded
sleeps); the CLI harness's `sleep` returns at once. The one real sleep is
`support/apply-first-boot-main.ts`'s, an apply over the in-memory factory with
`cli/interrupts.ts` wired to its own process, which `cli/apply-interrupted.test.ts` cuts short
with SIGINT once apply says it waits: `main.ts` run from source has no worker executable,
so it never reaches the wait. `cli/interrupts.ts` itself is tested over a stand-in process
(`cli/interrupts.test.ts`). Expected JSON output lives in
`cli/fixtures/` and is compared byte for byte; biome leaves `**/fixtures/**/*.json` alone,
since its formatting would not be `JSON.stringify`'s.

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
`support/stop-tools-main.ts`.
