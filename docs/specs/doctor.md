# Doctor

`fffactory doctor [--instance PATH] [--profile NAME] [--json]` reports whether
this workstation and the selected instance are ready to operate a factory.
Design: [fffactory-v2.md §`doctor`](../designs/fffactory-v2.md#doctor).

`doctor` is read-only. It writes no files, creates no directories and changes
no tool state. Its only network use is asking the local Tailscale client for
its own status, one AWS STS `GetCallerIdentity` call, and, only after that call
matched the factory's account, the read-only Service Quotas `GetServiceQuota`
(and `GetAWSDefaultServiceQuota`) and EC2 `DescribeVpcs` calls of the
[VPC quota](#vpc-quota) check, together with whatever the selected AWS
credential source itself contacts to produce credentials (such as instance
metadata or AWS SSO).

## Capabilities and checks

Results are grouped by capability, in this order. Each capability holds one or
more checks.

| Capability | Check | Ready when |
| --- | --- | --- |
| `local_tooling` | `openssh` | `ssh -V` reports OpenSSH. |
| `local_tooling` | `tailscale` | `tailscale status --json --peers=false` reports `BackendState` `Running`. |
| `configuration` | `instance` | An instance is found, is a valid factory.json and is complete. |
| `aws` | `aws_account` | STS resolves the selected credentials to a caller in factory.json's `aws.account_id`. |
| `aws` | `vpc_quota` | The factory Region has room under its "VPCs per Region" quota for the factory's VPC, or that VPC already exists. |
| `cache` | `cache_directory` | The FFFactory cache directory is absent or is a writable directory. |
| `cache` | `release_assets` | The executable's embedded release assets match their recorded digest. |
| `cache` | `terraform` | FFFactory can download the managed Terraform for this platform. |

A capability's status is the worst status of its checks, and the report's
status is the worst status of its capabilities.

## Statuses and exit codes

Every check has exactly one status. A check that is not `ready` always carries
an exact next action.

| Status | Meaning | Exit code |
| --- | --- | --- |
| `ready` | Inspected, and in the required state. | 0 |
| `not_ready` | Inspected, and something is missing, logged out, stopped, invalid, incomplete or not writable. | 2 |
| `error` | Doctor could not inspect it: an unexpected process failure, a timeout, output it cannot interpret, or an I/O error other than absence. | 1 |

Severity is `error` over `not_ready` over `ready`. `doctor` exits with the
code of the report's status: 0 only when every check is ready; 1 if any check
is `error`, because the inspection itself did not succeed; otherwise 2 if any
check is `not_ready`. The full report is printed in every case.

`doctor` also exits 1, printing only the reason to standard error, when its
arguments are invalid or it fails outside any check.

The rule is: "not ready" is an observed state an operator can fix with the
next action; "error" is the absence of an observation. So a missing binary, a
missing or invalid instance, an explicit `--instance PATH` that is not a
file, missing AWS credentials and an AWS account mismatch are all
`not_ready`; an instance file that exists but cannot be read, and an STS that
cannot be reached, are `error`. A check that depends on another that is not
ready, such as `vpc_quota` on `aws_account`, is `not_ready` and names that
check in its next action.

## Local tooling

Each tool is run directly, never through a shell, with standard input closed
and a 5-second timeout. The tool runs in its own session and process group; at
the timeout doctor kills the whole group with SIGKILL and stops reading its
output, so a wrapper script and any command it starts die together and doctor
returns promptly.

Because the tool's session is out of reach of the terminal, doctor relays
interruption itself: on SIGINT (such as Ctrl-C), SIGTERM, or SIGHUP it prints
`Interrupted: stopping running tools.` on standard error, kills the group of
every tool still running with SIGKILL at once, prints no report (what it saw
was cut short) and exits with 128 plus the signal number (130, 143, or 129).
No tool outlives an interrupted doctor. Doctor's tools have no graceful stop,
so, unlike an interrupt while Terraform runs
([provisioning §Environment and credentials](provisioning.md#environment-and-credentials)),
the notice offers no second interrupt.

The limit: a descendant that starts its own session or process group leaves the
tool's group and is killed neither at the timeout nor on interruption, though
doctor still returns or exits. Sessions and process groups are POSIX; the
targets are Linux and macOS.

### `openssh`

| Observation | Status | Summary / next action |
| --- | --- | --- |
| `ssh -V` exits 0 and its output starts with `OpenSSH_` | `ready` | The OpenSSH version, such as `OpenSSH_9.9p1`. |
| `ssh` is not on `PATH` | `not_ready` | Install the system OpenSSH client (`openssh-client` or `openssh-clients` on Linux; built into macOS) and make sure `ssh` is on `PATH`. |
| `ssh` runs but is not OpenSSH | `not_ready` | Put the system OpenSSH client first on `PATH`. |
| Non-zero exit, timeout, or failure to start | `error` | Run `ssh -V` to see why it fails. |

### `tailscale`

`--peers=false` keeps other devices out of the output doctor reads. Doctor
reads only `BackendState`.

| Observation | Status | Next action |
| --- | --- | --- |
| `BackendState` `Running` | `ready` | |
| `tailscale` is not on `PATH` | `not_ready` | Install the Tailscale client from https://tailscale.com/download and make sure `tailscale` is on `PATH`. |
| Exits non-zero saying it failed to connect to the local Tailscale daemon or service | `not_ready` | Start Tailscale: open the Tailscale app, or run `sudo systemctl start tailscaled`. |
| `NeedsLogin` (logged out) | `not_ready` | Log in with `tailscale login`. |
| `Stopped` (logged in, disconnected) | `not_ready` | Connect with `tailscale up`. |
| `NeedsMachineAuth` | `not_ready` | Ask a tailnet admin to approve this device at https://login.tailscale.com/admin/machines. |
| `Starting` or `NoState` | `not_ready` | Wait for Tailscale to finish starting. |
| `InUseOtherUser` | `not_ready` | Log in to this computer as the user running Tailscale, or have that user log out of it. |
| Any other `BackendState`, output that is not JSON or has no `BackendState`, any other non-zero exit, timeout, or failure to start | `error` | Run `tailscale status` to see the error. |

Every next action ends by asking the operator to rerun `fffactory doctor`.

## Configuration

The `instance` check selects the instance exactly as
[instance discovery](instance-configuration.md#instance-discovery) specifies,
then validates it and assesses its
[completeness](instance-configuration.md#completeness).

| Observation | Status | Details / next action |
| --- | --- | --- |
| Valid and complete | `ready` | |
| No instance found | `not_ready` | Run `fffactory init`, or select one with `--instance PATH` or `FFFACTORY_INSTANCE`. |
| The explicit `--instance` or `FFFACTORY_INSTANCE` path is not a file | `not_ready` | Select an existing factory.json, or create this one with `fffactory init PATH`. |
| Invalid | `not_ready` | Details list every issue as `path: message`; fix them and run `fffactory validate`. |
| Valid but incomplete | `not_ready` | Details list the missing field paths in completeness order; fill them in and run `fffactory validate`. |
| The file cannot be read, or discovery fails | `error` | Make the file readable. |

The summary names the resolved path and its discovery source.

## AWS account

The `aws_account` check is the account check every later plan and mutating
command runs first:
[`requireExpectedAccount`](../../src/application/require-expected-account.ts).
Doctor reports its verdict; those commands refuse unless it is a match.

### Credentials, Region and the call

Credentials are selected as
[instance configuration §Credentials](instance-configuration.md#credentials)
specifies: `--profile NAME`, then `AWS_PROFILE`, then the standard AWS
credential chain. An empty `--profile` is an invalid argument (exit 1).

Doctor calls STS `GetCallerIdentity` once, in the factory Region, which is
`aws.region` from factory.json. The operator's own configured Region
(`AWS_REGION`, `AWS_DEFAULT_REGION`, a profile's `region`) is never used, so
there is no Region mismatch to report: Region is a property of the factory,
not of the credentials. A call in the factory Region does prove that the
credentials work there; an opt-in Region that is not enabled for the account
shows up as rejected credentials, and a Region where STS is deactivated shows
up as such. When there is no valid factory.json, or it sets no `aws.region`,
doctor asks STS in `us-east-1` only to identify the caller, and says so.

The call, including producing the credentials, has a 5-second deadline, the
same as the local tool checks. At the deadline doctor abandons it and reports
STS as unreachable. The AWS SDK is loaded only when the check runs, so other
commands never load it.

### Comparison

The account-match rule is exact: the caller's 12-digit account must equal
factory.json's `aws.account_id`. A missing expected account is never a match.

| Observation | Status | Summary / next action |
| --- | --- | --- |
| Caller's account equals `aws.account_id` | `ready` | `Account <account> matches factory.json`. |
| Caller in another account | `not_ready` | Shows both account IDs. Select credentials for the expected account with `--profile NAME` or `AWS_PROFILE`, or correct `aws.account_id`. |
| Caller resolved, but no valid factory.json | `not_ready` | Reports the caller; make the `instance` check ready so doctor can compare. |
| Caller resolved, but factory.json sets no `aws.account_id` | `not_ready` | Reports the caller; set `aws.account_id` and check it with `fffactory validate`. |

Whenever STS resolves a caller, details list the principal ARN
(`Principal: …`), the Region and where it came from, and the credential
source (`standard AWS credential chain`, or `profile NAME (--profile)` or
`profile NAME (AWS_PROFILE)`). When it does not, details list the Region and
the credential source.

### Unresolved caller

| Observation | Status | Next action |
| --- | --- | --- |
| No provider in the standard chain has credentials | `not_ready` | Configure AWS credentials, for example with `aws configure sso`, and select them with `--profile NAME` or `AWS_PROFILE`. |
| The selected profile does not exist, or configures no credentials | `not_ready` | Configure it, for example with `aws configure sso --profile NAME`, or select another profile. |
| The SSO session has expired, was revoked, or was never started | `not_ready` | Log in with `aws sso login`, with `--profile NAME` when a profile is selected. |
| STS answers that the credentials have expired (`ExpiredToken`, `ExpiredTokenException`, `RequestExpired`) | `not_ready` | Renew the credentials, or select current ones. |
| STS rejects the credentials (`InvalidClientTokenId`, `SignatureDoesNotMatch`, `UnrecognizedClientException`) | `not_ready` | Replace the credentials; if the Region is an opt-in Region, enable it for the account. |
| STS denies the call (`AccessDenied`, `AccessDeniedException`) | `not_ready` | Use credentials whose policies do not deny `sts:GetCallerIdentity`. |
| STS is not activated in the Region (`RegionDisabledException`) | `not_ready` | Activate STS for the Region in the IAM console's account settings. |
| A network failure (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `EAI_AGAIN`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, `EPIPE`) or the deadline | `error` | Check the network connection and any proxy settings. |
| Any other failure, or an answer without a 12-digit account and an ARN | `error` | Run `aws sts get-caller-identity --region REGION`, with `--profile NAME` when one is selected, to see the error. |

Doctor classifies a failure by the SDK's error name and network error code,
and recognizes credential-provider failures by the SDK's own wording, which
the adapter tests pin. Every SSO failure the SDK says `aws sso login` fixes,
and SSO refusing a revoked session (`UnauthorizedException`), is an SSO login. Doctor never prints an SDK or AWS error message.

### VPC quota

v2 creates its own VPC, so the first apply needs room for one more VPC in the
factory Region unless the factory's VPC already exists
([D5](../roadmap/fffactory-v2-roadmap/decisions.md)). The `vpc_quota` check
runs after `aws_account` and reads AWS only when that check's verdict is a
match: doctor never reads the VPCs of an account that is not the factory's.
It needs factory.json's `factory_id` and `aws.region`.

With the same credentials, in the factory Region, doctor reads:

- the limit: Service Quotas `GetServiceQuota` for service code `vpc`, quota
  code `L-F678F1CE` ("VPCs per Region"); when the account has no applied value
  (`NoSuchResourceException`), `GetAWSDefaultServiceQuota` for the same quota.
  A fractional value is rounded down;
- the VPCs in use: every VPC EC2 `DescribeVpcs` lists in the Region, in any
  state, page by page;
- the factory's VPC: whether one of them carries the tag
  `fffactory:factory-id` with the factory ID, which the Terraform modules put
  on every factory resource.

Every call, credentials and pages included, shares one 10-second deadline:
twice the STS deadline, because it is up to three calls in sequence. At the
deadline doctor abandons them all and reports them as unreachable. The AWS
SDK clients are loaded only when the check reads AWS.

| Observation | Status | Summary / next action |
| --- | --- | --- |
| The factory's VPC exists | `ready` | `The factory's VPC already exists in REGION; no VPC quota headroom is needed`; details give the VPCs in use. |
| Fewer VPCs in use than the limit | `ready` | `N of M VPCs in use in REGION; the factory's VPC fits`. |
| As many VPCs in use as the limit, or more | `not_ready` | Request a higher 'VPCs per Region' quota in Service Quotas for REGION, or delete an unused VPC. |
| The `aws_account` check is not a match, or could not be inspected | `not_ready` | Not inspected; make the `aws_account` check ready. |
| factory.json sets no `factory_id` or no `aws.region` | `not_ready` | Not inspected; details list the missing field paths; fill them in and run `fffactory validate`. |
| AWS denies a call (`AccessDenied`, `AccessDeniedException`, `UnauthorizedOperation`) | `not_ready` | Use credentials allowed `ec2:DescribeVpcs`, `servicequotas:GetServiceQuota` and `servicequotas:GetAWSDefaultServiceQuota`. |
| A network failure (the codes listed for STS) or the deadline | `error` | Check the network connection and any proxy settings. |
| Any other failure, including a credential provider failure, or a quota answer without a non-negative value | `error` | Run `aws ec2 describe-vpcs` and `aws service-quotas get-service-quota --service-code vpc --quota-code L-F678F1CE`, with `--region REGION` and any `--profile NAME`, to see the error. |

Whenever doctor reads AWS, details list the Region and the credential source,
as for `aws_account`. Failures are classified by error name and network error
code, and an AWS error is named with its service (`EC2 answered NAME`,
`Service Quotas answered NAME`); no SDK or AWS message is printed. The factory
ID itself is never printed.

## Cache

FFFactory keeps materialized release assets and managed Terraform in a
private cache directory: `$XDG_CACHE_HOME/fffactory` when
`XDG_CACHE_HOME` is an absolute path, otherwise `~/.cache/fffactory`. Release
assets are materialized into `releases/<release>` inside it, as
[release §Materialization](release.md#materialization) specifies.

The `cache_directory` check inspects only the directory itself:

| Observation | Status | Next action |
| --- | --- | --- |
| Absent | `ready` | None: FFFactory creates it when first needed. |
| A directory the current user can write and enter | `ready` | |
| A directory the current user cannot write or enter | `not_ready` | Make it writable, for example `chmod u+rwx PATH`. |
| Exists but is not a directory | `not_ready` | Move or remove PATH so FFFactory can create its cache directory there. |
| Any other I/O error | `error` | Check that the directory can be inspected. |

The `release_assets` check verifies the running executable's embedded bundle
against its recorded SHA-256 digest, then reads the marker of
`<cache>/releases/<release>`. It never materializes or repairs anything:
materialization replaces a stale directory by itself, so only the bundle can
need the operator.

| Observation | Status | Summary / next action |
| --- | --- | --- |
| The directory's marker names this release and bundle | `ready` | `Release <release> assets are materialized at PATH`. |
| The directory is absent | `ready` | Says FFFactory materializes them into PATH when first needed. |
| Something else is at PATH: no marker, or a marker for another bundle of this release | `ready` | Says FFFactory replaces them when next needed. |
| The embedded tarball does not match its recorded digest | `not_ready` | Reinstall fffactory from its GitHub Release. |
| The executable embeds no release assets | `not_ready` | Reinstall fffactory from its GitHub Release. |
| The marker cannot be read for another reason | `error` | Check that PATH can be read. |

Run from source, the bundle is packed from the checkout's `assets/`, so the
check behaves as it does for an intact executable.

The `terraform` check inspects `<cache>/terraform/<version>/terraform` for the
supported Terraform release, as
[provisioning §Managed Terraform](provisioning.md#managed-terraform)
specifies. It never downloads, verifies or repairs anything: FFFactory
downloads and replaces the executable by itself when next needed.

| Observation | Status | Summary / next action |
| --- | --- | --- |
| An executable regular file | `ready` | `Terraform <version> is installed at PATH`. |
| Absent | `ready` | Says FFFactory downloads it into PATH from releases.hashicorp.com when first needed. |
| Anything else at PATH or in its version directory | `ready` | Says PATH is not a usable Terraform and FFFactory downloads it again when next needed. |
| A platform FFFactory has no Terraform build for | `not_ready` | Run fffactory on macOS or Linux, on x86-64 or arm64. |
| Any other I/O error | `error` | Check that `<cache>/terraform` can be read. |

## Output

### Human-readable

The default output goes to standard output. It names the running release, then
prints each capability with its status, then each check with its status,
title and summary, its details indented beneath it, and `Next:` with its next
action. A final line gives the overall result and how many checks need
attention.

### JSON, schema version 1

`--json` prints one JSON document, indented by two spaces, to standard output
and nothing else. Its structure is published as
[`schemas/doctor-report.schema.json`](../../schemas/doctor-report.schema.json):

```json
{
  "schema_version": 1,
  "release": "0.3.0",
  "status": "not_ready",
  "capabilities": [
    {
      "id": "local_tooling",
      "title": "Local tooling",
      "status": "not_ready",
      "checks": [
        {
          "id": "tailscale",
          "title": "Tailscale client",
          "status": "not_ready",
          "summary": "Logged out",
          "details": [],
          "next_action": "Log in with `tailscale login`, then rerun `fffactory doctor`."
        }
      ]
    }
  ]
}
```

- `schema_version` is the version of this output format, independent of the
  release and of the factory.json schema version.
- `release` is the running CLI's release.
- Every check has every field. `details` is a possibly empty list of strings;
  `next_action` is `null` exactly when `status` is `ready`.
- Keys are `snake_case`. Capabilities and checks keep the order above.

Adding a capability, a check or a field is compatible and keeps
`schema_version` 1; consumers must ignore capability and check IDs they do not
know. Removing or renaming a field, or changing a field's meaning or the set of
statuses, requires a new `schema_version`.

## Secrets

Doctor never prints configuration values, tool output or error text from a
tool or the AWS SDK. Summaries and details hold only values doctor derives
itself: statuses, the OpenSSH version token, paths, field paths, validation
messages (which never echo values), process exit codes, I/O error codes, AWS
error names and network error codes, and the message of an unexpected error,
which FFFactory's own code never builds from configuration values.

The AWS check prints the caller's account ID and principal ARN as STS returns
them, the selected profile name, and factory.json's `aws.account_id` and
`aws.region`. Those two configuration values are printed only after
validation has proved them a 12-digit account ID and a Region name, which
cannot hold a pasted secret. The VPC quota check adds only counts it derived
and the quota's value; it never prints the factory ID or any tag. Access keys,
secret keys and session tokens never appear in output.

## Extension

A capability is one inspection in `src/application/doctor.ts` that returns a
`Capability`. Adding one, as the AWS capability did, means adding its checks
and its port, and listing it in the order above. The status rule, exit codes
and JSON shape do not change. Doctor resolves and validates the instance once
per run and shares it with every capability that needs it.

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/check-result.ts` | `CheckResult`, `Capability`, `DoctorReport`, severity and the exit-code rule. Pure. |
| Domain | `src/domain/local-tooling.ts`, `src/domain/cache.ts`, `src/domain/release-assets.ts`, `src/domain/managed-terraform.ts` | Tool, cache, release asset and managed Terraform observations, and the rules that turn them into checks with next actions. Pure. |
| Domain | `src/domain/aws-account.ts` | Caller observations, credential selection, the account-match rule, the STS Region, and the `aws_account` check. Pure. |
| Domain | `src/domain/vpc-quota.ts` | VPC quota observations, the quota and tag identifiers, the factory Region and ID to look for, and the `vpc_quota` check. Pure. |
| Application | `src/application/doctor.ts`, `src/application/tool-probe.ts`, `src/application/cache-directory.ts`, `src/application/asset-bundle.ts`, `src/application/managed-terraform.ts` | The doctor use case, the `configuration` check, the cache location and the release assets and Terraform layouts in it, and the `ToolProbe`, `CacheDirectoryProbe`, `AssetBundle` and `ManagedTerraformProbe` ports. |
| Application | `src/application/caller-identity.ts`, `src/application/require-expected-account.ts` | The `CallerIdentity` port, credential-selection precedence, and the `requireExpectedAccount` guard. |
| Application | `src/application/vpc-quota-probe.ts` | The `VpcQuotaProbe` port; `doctor.ts` calls it only after an account match. |
| Infrastructure | `src/infrastructure/local-tool-probe.ts`, `src/infrastructure/filesystem-cache-directory.ts`, `src/infrastructure/asset-bundle.ts`, `src/infrastructure/terraform/installer.ts` | Process-based `ToolProbe` over an injected process runner with a timeout, and `killRunningTools`; filesystem `CacheDirectoryProbe`; `AssetBundle` over the embedded bundle; `managedTerraform().inspect` for the `terraform` check. |
| Infrastructure | `src/infrastructure/aws-sts-caller-identity.ts` | `CallerIdentity` over one STS call (AWS SDK for JavaScript v3) with a deadline, and the error classification. |
| Infrastructure | `src/infrastructure/aws-vpc-quota-probe.ts` | `VpcQuotaProbe` over Service Quotas and EC2 (AWS SDK for JavaScript v3) with one deadline, the default-quota fallback, paging, and the error classification. |
| CLI adapter | `src/cli/commands/doctor.ts`, `src/cli/main.ts`, `src/cli/interrupts.ts` | Arguments, human and JSON rendering, exit code, no report once interrupted; signal handling that kills running tools. |

Tests: `tests/domain/check-result.test.ts`, `tests/domain/local-tooling.test.ts`,
`tests/domain/cache.test.ts`, `tests/domain/release-assets.test.ts`,
`tests/domain/aws-account.test.ts`, `tests/domain/vpc-quota.test.ts`,
`tests/application/doctor.test.ts` (fake probes, a fake `AssetBundle`, a
fake `CallerIdentity` and a fake `VpcQuotaProbe`),
`tests/application/cache-directory.test.ts`,
`tests/application/caller-identity.test.ts`,
`tests/application/require-expected-account.test.ts` (fake `CallerIdentity`),
`tests/infrastructure/local-tool-probe.test.ts` (injected process runner, and
the Bun runner against the Bun executable and shell wrappers),
`tests/infrastructure/filesystem-cache-directory.test.ts`,
`tests/infrastructure/asset-bundle.test.ts`,
`tests/infrastructure/terraform/installer.test.ts` (`inspect` states),
`tests/infrastructure/aws-sts-caller-identity.test.ts` (a stubbed STS call,
and the real SDK against a local stub STS),
`tests/infrastructure/aws-vpc-quota-probe.test.ts` (stubbed calls, and the real
SDK against a local stub of EC2 and Service Quotas),
`tests/infrastructure/aws-isolation.test.ts` (proves tests cannot reach AWS),
`tests/cli/doctor.test.ts` (exit codes, no report once interrupted, human
output, and the JSON output against the checked-in
`tests/cli/fixtures/doctor-report.json` and the schema), and
`tests/cli/main.test.ts` (the spawned executable with stand-in `ssh` and
`tailscale` on a private `PATH`, including doctor interrupted by
SIGINT, SIGTERM and SIGHUP while a stand-in `ssh` runs, and the AWS check
against a local stub STS: a match, a mismatch, `--profile`, a missing profile
that must not fall through to a stand-in instance metadata service, an expired
SSO session and missing credentials; and the VPC quota against a local stub of
EC2 and Service Quotas, read after a match and never after a mismatch). No test runs the host's real `ssh` or
`tailscale`, and no test reads a real AWS account: the test process and every
spawned `fffactory` run with no AWS credentials, instance metadata disabled
and every AWS endpoint pointed at a closed local port
(`tests/support/aws-isolation.ts`).

Introduced by [#91](https://github.com/yaunder/factory/issues/91); the AWS
account check by [#92](https://github.com/yaunder/factory/issues/92); the
`release_assets` check by [#93](https://github.com/yaunder/factory/issues/93); the
`terraform` check by [#95](https://github.com/yaunder/factory/issues/95); the
`vpc_quota` check by [#96](https://github.com/yaunder/factory/issues/96).
