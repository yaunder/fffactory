# Instance configuration

A v2 factory instance is one user-owned, non-secret document,
`.fffactory/factory.json`. It is the only editable desired state; generated
Terraform files and host projections are never a second source. Design:
[fffactory-v2.md §Instance configuration](../designs/fffactory-v2.md#instance-configuration).

## Instance discovery

A command selects exactly one instance document, in this order:

1. `--instance PATH`;
2. `FFFACTORY_INSTANCE`, when set and non-empty;
3. the nearest `.fffactory/factory.json`, searching upward from the current
   directory to the filesystem root;
4. `~/.fffactory/factory.json`;
5. otherwise the command fails and tells the operator to run `fffactory init`
   or select an instance with `--instance PATH` or `FFFACTORY_INSTANCE`.

Rules:

- `PATH` and `FFFACTORY_INSTANCE` name the document file itself. A relative
  path resolves against the current directory.
- An explicitly selected path that is not a regular file is an error. It never
  falls back to a lower-precedence source.
- The upward search matches only a regular file named `factory.json`. A v1
  `.fffactory/` directory holding `config.json` and Terraform inputs, or a
  directory named `factory.json`, is skipped and the search continues upward.
- Discovery only checks for files; it reads no document contents.
- There is no implicit default instance.

## Document, schema version 1

Field names are `snake_case`. Unknown fields are rejected at every level, so a
release that does not know a field refuses a document that sets it. An
optional field whose absence leaves every existing document valid and meaning
what it did, such as `tailscale.admin_client_secret`, keeps the version: an
earlier release refuses a document that sets it rather than ignore it. A field
that changes what an existing document means, or that existing documents would
have to gain because it is required, arrives with a new schema version, which
needs schema migration
([plan and apply §Compatibility refusals](plan-apply.md#compatibility-refusals-d11)).
An editor-only `$schema` string is allowed at the root. The published JSON
Schema is [`schemas/factory.schema.json`](../../schemas/factory.schema.json), and
[`examples/factory.json`](../../examples/factory.json) is a complete example.

| Field | Rule |
| --- | --- |
| `schema_version` | Required. Exactly `1`. |
| `release` | Pinned factory release, `MAJOR.MINOR.PATCH` with an optional `-prerelease`. |
| `factory_id` | Permanent factory ID. See below. |
| `name` | Human-readable name; not blank. |
| `aws.account_id` | Expected AWS account, 12 digits. |
| `aws.region` | Expected AWS Region, such as `us-east-1`. |
| `state_backend.bucket` | State bucket name (S3 bucket name rules: 3-63 of `a-z`, `0-9`, `.`, `-`), starting with the factory ID and a hyphen. See below. |
| `log_archive.enabled` | Optional; whether the factory has a worker log archive (required inside `log_archive`). Its bucket name is derived. See [Log archive](#log-archive). |
| `network.vpc_cidr`, `network.public_subnet_cidr` | IPv4 CIDR blocks. |
| `network.availability_zone` | Availability zone, such as `us-east-1a`. |
| `tailscale.tag` | Tailscale tag, such as `tag:software-factory`. |
| `tailscale.auth_key_secret` | Secret reference to the factory's Tailscale enrollment key. |
| `tailscale.admin_client_secret` | Secret reference to the client secret of the operator's Tailscale OAuth client with the `devices:core` scope, the factory's admin client ([secrets](secrets.md#the-tailscale-admin-client)). Workers never receive it. |
| `credentials.github_token_secret`, `credentials.anthropic_api_key_secret`, `credentials.openai_api_key_secret` | Optional secret references to the factory's GitHub token, Anthropic API key and OpenAI API key, for the `github`, `anthropic` and `openai` accounts. See [API credentials](#api-credentials). |
| `repositories[]` | Repository inventory. Each entry requires `key`, `remote` (`https://github.com/OWNER/NAME`), `path` (relative checkout path; no empty, `.` or `..` segments) and `branch`. |
| `hosts[]` | Stable hosts, possibly none. Each entry requires `key`. |
| `hosts[].instance_type`, `hosts[].root_volume_gib` | Machine declaration: EC2 instance type; root volume of 8-16384 GiB. |
| `hosts[].paseo_password_secret` | Secret reference to the host's Paseo password, which every host needs ([control plane §The daemon password](control-plane.md#the-daemon-password)). |
| `hosts[].repositories[]` | Repository placement: keys of declared repositories. |
| `hosts[].interactive_logins[]` | Accounts kept on a human's login on this host, each at most once: `github`, `openai`, `anthropic`. See [API credentials](#api-credentials). |
| `hosts[].dispatch` | Desired dispatch settings: `enabled` (boolean), `cron`, `timezone`, `provider`, `model`, `mode` (non-blank strings), and `cwd` (absolute path). When enabled, every schedule field is required; no runtime default is applied. |

### Factory ID

3-20 characters of lowercase letters, digits and single hyphens, starting with
a letter and not ending with a hyphen (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`). The ID
namespaces AWS resource names and Tailscale hostnames, so it is restricted to
what both accept and short enough to prefix them.

### Host keys

1-32 characters with the same character rules as the factory ID, so a
namespaced hostname `<factory_id>-<host key>` is at most 53 characters and fits
in a DNS label. Host keys are unique within the document and are never
renamed: replacing a host means declaring a new key. Planning rejects a
document that no longer declares a key the factory has provisioned
([provisioning §Stable host keys](provisioning.md#stable-host-keys)); only
[`fffactory worker terminate KEY`](worker-lifecycle.md#terminate-remove)
removes a host, and Terraform's record of its key with it, after which the key
may be declared again as a new host.

### State bucket

Every name a factory gives an AWS resource carries its factory ID
([provisioning §Names](provisioning.md#names)). The state bucket's name is
chosen in factory.json, since S3 bucket names are global, so validation
requires it to start with the factory ID and a hyphen, such as
`fff-k3x9q2ab-state-123456789012` for factory `fff-k3x9q2ab`. The rule
applies once both `factory_id` and `state_backend.bucket` are set and well
formed; the JSON Schema cannot express it.

The state bucket is never the log archive's bucket: validation refuses
`state_backend.bucket` equal to the archive's derived name
([Log archive](#log-archive)), once `factory_id`, `aws.account_id` and
`aws.region` are well formed, whether `log_archive.enabled` is true, false or
absent, with a message naming the rule, never a configured value. An archive
kept after teardown already passes as a ready state bucket, so `apply` would
adopt it as one, and teardown, which deletes the state bucket, would then
delete the archive it says it keeps. Reserving the name while the archive is
disabled keeps evidence archived before it was disabled safe the same way.
The JSON Schema cannot express this rule.

### Log archive

`log_archive.enabled: true` gives the factory a worker log archive, an S3
bucket meant to keep workers' logs after the workers, and the factory, are
gone. Absent or `false`, the factory has none. `log_archive` holds only
`enabled`, and requires it. The field is optional, so schema version 1 is
kept, and `fffactory init` never writes it: init fills only what fffactory
generates, never an operator's choice. Enabling it makes `fffactory plan` and
`apply` create the archive when it is missing, in the factory's reviewed plan
([plan and apply §The infrastructure stage](plan-apply.md#the-infrastructure-stage)),
and lets each host's role write new objects under its own prefix of the bucket
([provisioning §Log archive access](provisioning.md#log-archive-access)).
Each host's projection then carries the archive's bucket and Region
([host protocol §The host projection](host-protocol.md#the-host-projection)),
and its `credentials` step keeps Claude Code's session history
(`cleanupPeriodDays: 3650`,
[credential delivery §Managed settings](credential-delivery.md#managed-settings))
so nothing is cleaned up before it is collected. Enabling or disabling the
archive therefore changes every worker's projection digest: `status` reads it
as a configuration `fffactory apply` has not delivered yet, and the next
apply's workers stage installs it, with no Paseo change
([control plane §Planned state](control-plane.md#planned-state)).
fffactory itself writes nothing in the archive yet, and never removes it:
[teardown](teardown.md) keeps it and says so. What workers collect into it,
and the archive's format, are in [collector](collector.md).

The archive's bucket name is derived, never configured:
`<factory_id>-logs-<aws.account_id>-<aws.region>-an`, such as
`fff-k3x9q2ab-logs-123456789012-us-east-1-an`. The `-an` suffix puts it in S3's
account-regional namespace, where no other account can ever take the name, and
it carries the factory ID as every factory resource name does
([provisioning §Names](provisioning.md#names)). Deriving it does not keep the
factory's own configurable state bucket from that name; validation does
([State bucket](#state-bucket)). `archiveBucketName` in
`src/domain/resource-naming.ts` is the one statement of this rule; it gives no
name while the archive is not enabled or `factory_id`, `aws.account_id` or
`aws.region` is absent.

The name must fit S3's 63 characters. A factory ID has at most 20, which leaves
21 for the Region; every AWS Region name today is shorter, but the Region
format has no length bound. Validation therefore refuses
`log_archive.enabled: true` whose derived name would exceed 63 characters,
once `factory_id`, `aws.account_id` and `aws.region` are well formed, with a
message naming the rule and the name's length, never a configured value.

The account-regional namespace is unavailable in `me-south-1` and
`me-central-1`, so validation refuses `log_archive.enabled: true` in either,
once `aws.region` names it, with a message naming the Region; `false` is
accepted anywhere. The JSON Schema cannot express this rule.

### Secret references

A secret field (`tailscale.auth_key_secret`, `tailscale.admin_client_secret`,
`credentials.github_token_secret`, `credentials.anthropic_api_key_secret`,
`credentials.openai_api_key_secret`, `hosts[].paseo_password_secret`) holds
only a Secrets Manager secret ARN,
`arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME`. Any other string, such as
a pasted key or password, is rejected as a raw secret value. `fffactory secret
set` stores a secret in Secrets Manager and sets its field to the ARN
([secrets](secrets.md)).

Every secret lives in the factory's own Region and account: a worker's first
boot reads its Tailscale key in `aws.region`, and its role has no access to
another account, so a secret elsewhere would pass planning and fail on the
worker. The admin client, which only the operator reads, follows the same rule,
so every secret is the factory's own. Validation requires each secret ARN's
Region to be `aws.region` and its account `aws.account_id`, each check once
that field is set and well formed; the JSON Schema cannot express it.

### API credentials

A worker's three accounts, the readiness enrollments `github`, `openai` and
`anthropic` ([readiness](readiness.md)), are satisfied either by a human's
login on the worker or by an API credential the factory delivers. The
`credentials` object holds the factory-wide references, one per account:

| Account | Reference |
| --- | --- |
| `github` | `credentials.github_token_secret` |
| `openai` | `credentials.openai_api_key_secret` |
| `anthropic` | `credentials.anthropic_api_key_secret` |

A host's `interactive_logins` lists the accounts it keeps on a human's login.

An account is *delivered* to a host when its reference is set and the host does
not list it in `interactive_logins`. Listing an account without a reference
changes nothing: it is on a human's login either way. A host factory.json does
not declare is delivered nothing. `deliveredAccounts` in
`src/domain/instance.ts` is the one statement of this rule, and gives each
delivered account with its reference in `ENROLLMENTS`' order (`github`,
`openai`, `anthropic`).

All of these fields are optional. A document without them is valid, complete
and means what it did before: every account stays on a human's login.
The host projection carries each host's delivered references
([host protocol §The host projection](host-protocol.md#the-host-projection)),
and the hosts' role may read every reference set
([provisioning §Terraform inputs](provisioning.md#terraform-inputs)). Each
host's `credentials` install step delivers them
([credential delivery](credential-delivery.md)).

Validation rejects an unknown field under `credentials`, a raw secret value in
any of them, an `interactive_logins` entry that is not one of the three account
IDs, and an account listed twice on one host. Messages name the field, never
the value; a duplicate names the account, which has passed its format check.

## Validation

Validation reports every issue, each with a field path such as `factory_id`,
`tailscale.auth_key_secret` or `hosts[2].key`. It rejects:

- a document that is not a JSON object, or is not valid JSON;
- a missing or unsupported `schema_version`;
- unknown fields and values of the wrong type or format;
- an invalid factory ID or host key;
- a raw secret value in a secret field;
- duplicate host keys, repository keys or repository checkout paths;
- a state bucket whose name does not start with the factory ID and a hyphen,
  or is the log archive's derived bucket name, whether or not the archive is
  enabled;
- `log_archive` without `enabled`, and `log_archive.enabled: true` in
  `me-south-1` or `me-central-1`, or with a derived bucket name over 63
  characters;
- a secret reference in another Region than `aws.region` or another account
  than `aws.account_id`;
- placement of a repository that is not declared in `repositories`;
- an `interactive_logins` entry that is not an account ID, or that repeats one.

Messages never echo field values, except keys and `aws.region` that already
passed their format check, so a secret pasted into any field cannot leak
through validation output.

## Completeness

A valid document may be partial; only `schema_version` is required.
Completeness is reported separately from validity. A valid document is complete
when it has `release`, `factory_id`, `name`, `aws.account_id`, `aws.region`,
`state_backend.bucket`, `network.vpc_cidr`, `network.public_subnet_cidr`,
`network.availability_zone`, `tailscale.tag`, `tailscale.auth_key_secret`,
`hosts`, and `instance_type`, `root_volume_gib` and `paseo_password_secret` for
every host. The report lists missing fields by path in that order. A worker is
ready only once its Paseo daemon runs, and the daemon never starts without a
password ([control plane §The daemon password](control-plane.md#the-daemon-password)),
so a host without one could be created but never made ready; the report names
the command that stores it, `fffactory secret set paseo-password --host KEY`
for that host's key. `hosts` may be an empty list: a factory may declare no
worker, as [`fffactory worker terminate KEY`](worker-lifecycle.md#terminate-remove)
leaves it after removing the last host, and its plan is then its shared
infrastructure alone
([plan-apply §An empty factory](plan-apply.md#an-empty-factory)). An absent
`hosts` is still reported missing, so a new document is not taken for a factory
deliberately without workers. Repositories, dispatch settings,
`tailscale.admin_client_secret`, `credentials`, `interactive_logins` and
`log_archive` are optional for completeness. `plan`, `apply`, `upgrade`,
`status`, `teardown` and the `worker` commands refuse an incomplete document;
`secret set` does not, as it is how a secret reference is filled in.

## `fffactory validate`

`fffactory validate [--instance PATH]` resolves the instance, then prints the
resolved path and its discovery source.

- Valid: prints the schema version and either `Complete` or the list of fields
  still needed, and exits 0. An incomplete document still exits 0. A field
  that a command fills is listed with it, as
  ``hosts[0].paseo_password_secret: store it with `fffactory secret set paseo-password --host builder-1` ``.
- Invalid: prints `path: message` for every issue to standard error and exits 1.
- No instance found, or the selected file cannot be read: prints the reason to
  standard error and exits 1.

## Initialization

`fffactory init [PATH]` creates or fills in a partial instance document. It
writes `./.fffactory/factory.json` under the current directory, or `PATH`.

- `PATH` names the document file itself, exactly as `--instance PATH` does, and
  a relative path resolves against the current directory. Missing parent
  directories are created. `init` does not search upward and ignores
  `FFFACTORY_INSTANCE`: without `PATH` it always targets the current directory.
- A new document holds `schema_version`, `release` and `factory_id`, and is a
  valid partial document.
- `release` is the running CLI's release version. Its single source is the
  `version` in `package.json`, which `src/cli/release.ts` imports so that
  `bun build --compile` inlines it into the executable. A version that is not a
  valid release fails the test suite.
- `factory_id` is generated once: `fff-` followed by eight random lowercase
  letters or digits, such as `fff-k3x9q2ab` (12 characters, about 41 bits of
  randomness). Randomness comes from the platform's cryptographic source and is
  sampled without bias. The ID is permanent; `init` never regenerates it.
- Rerunning on a valid document keeps every value already set, including the
  factory ID and a release pin that differs from the running CLI, and fills
  only fields that are absent. Nested objects are filled field by field;
  arrays and scalar values that are present are never changed. Existing field
  order is kept and filled fields are appended.
- If nothing is missing, the file is not rewritten.
- An existing document that is not valid JSON or not a valid schema v1
  document is refused: `init` prints every issue by field path to standard
  error, exits 1 and leaves the file as it is.
- Writes are atomic: the document is written to a temporary file in the same
  directory, flushed and renamed over the target, so a failure never truncates
  an existing document. A symbolic link is followed and the file it names is
  replaced, leaving the link intact. Each relative link target resolves against
  its link's directory and chains are followed. A dangling link's target is
  created, with any missing parent directories. A link loop, or a chain of more
  than 40 links, is refused with an error and nothing is written. An existing
  file keeps its permissions.
- `init` never contacts AWS or any other network service and provisions
  nothing. Its only capabilities are the `InstanceStore` and a random byte
  source.

Output, on standard output, exit 0:

- `Created PATH.`, `Updated PATH.` or `Unchanged PATH: nothing to fill.`;
- `New factory ID: …` and `Release pin: …` for whichever of those `init` just
  wrote. Values that were already in the file are never echoed;
- the completeness report, as `fffactory validate` prints it;
- while `hosts` is still missing, ``Every host needs a Paseo password before
  apply: `fffactory secret set paseo-password --host KEY`.``: a declared host
  without one is already listed with that command.

## Credentials

AWS credentials are operator-local and never desired state: factory.json
holds no profile name, key or token, and no command writes one into it. A
command that talks to AWS selects credentials in this order:

1. `--profile NAME` (accepted by `fffactory doctor`, `secret set` and
   `lock break`, and by every later command that talks to AWS; commands that
   never call AWS, such as `init` and `validate`, reject it as an unknown
   option);
2. `AWS_PROFILE`, when set and non-empty;
3. otherwise the standard AWS credential chain of the AWS SDK for JavaScript
   v3: environment keys, the `default` profile of the shared config and
   credentials files (including SSO and `credential_process`), web identity,
   and container or EC2 instance metadata.

A selected profile, whether from `--profile` or `AWS_PROFILE`, is resolved from
the shared config and credentials files only (`AWS_CONFIG_FILE` and
`AWS_SHARED_CREDENTIALS_FILE` locate them). It never falls through to
environment keys or instance metadata: a profile that does not exist, or
configures no credentials, is reported as such, never silently replaced by an
EC2 host's instance role. Refreshing an expired SSO session is left to
`aws sso login`; fffactory runs no login flow of its own.

Before any plan or mutation of AWS or factory infrastructure (local-only
writes such as `init` and `assets` excluded), the command resolves the caller with STS
`GetCallerIdentity` in the factory Region (`aws.region`) and refuses to
continue unless the caller's account is exactly `aws.account_id`
([doctor §AWS account](doctor.md#aws-account)). A missing `aws.account_id`, a
missing or invalid instance, or credentials that cannot be resolved are
refusals too, never a default. The operator's own configured Region never
selects the factory Region. Commands that later hand credentials to Terraform
pass the same selection and the factory Region.

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/instance.ts`, `src/domain/validation.ts`, `src/domain/initialization.ts`, `src/domain/resource-naming.ts` | `FactoryInstance`, `FactoryId`, `HostKey`, `Release`, secret references, validation rules, the delivered-account rule (`deliveredAccounts`), completeness report, factory ID generation from injected random bytes, the gap-filling merge, and the log archive's derived bucket name (`archiveBucketName`). Pure. |
| Application | `src/application/resolve-instance.ts`, `src/application/validate-instance.ts`, `src/application/init-instance.ts`, `src/application/instance-store.ts` | Discovery precedence, reading and validating a document, initialization, the `InstanceStore` port. `describeSource`, each discovery source's words, is published wording: doctor's JSON `summary` embeds it, so it stays here. |
| CLI adapter | `src/cli/presentation/instance-source.ts` | `instanceLine`, the `Instance: PATH (SOURCE)` line commands print, and `instanceHeader`, the restyled commands' header (`fffactory COMMAND · release R`, then `Instance  PATH (SOURCE)`, a path under home shown from `~`; [plan and apply §Before anything reaches AWS](plan-apply.md#before-anything-reaches-aws)), both in `describeSource`'s words. |
| Infrastructure | `src/infrastructure/filesystem-instance-store.ts` | Filesystem `InstanceStore`, including the atomic write. |
| CLI adapter | `src/cli/` | Argument parsing, output and exit codes; `src/cli/release.ts` holds the release version. |

Tests: `tests/domain/instance.test.ts`, `tests/domain/instance-schema.test.ts`
(JSON Schema agrees with the domain), `tests/domain/initialization.test.ts`,
`tests/domain/resource-naming.test.ts` (the log archive's bucket name),
`tests/cli/teardown.test.ts` (a state bucket named as the log archive refused
before teardown reads anything of AWS, the archive left in place),
`tests/application/resolve-instance.test.ts`,
`tests/application/doctor.test.ts` (each source's words in doctor's summary),
`tests/cli/presentation/instance-source.test.ts` (the instance line for each
source), `tests/application/validate-instance.test.ts`,
`tests/application/init-instance.test.ts`,
`tests/infrastructure/filesystem-instance-store.test.ts`, `tests/cli/`.
`tests/cli/init-offline.test.ts` proves `init` is offline two ways: it runs
`init` while `fetch` is replaced by a fake that fails on use, and it walks the
import graph of the init command and the filesystem store, failing on any
non-relative import outside a local-only allowlist or any network global.

Credential selection and the account check live in `src/domain/aws-account.ts`,
`src/application/caller-identity.ts`,
`src/application/require-expected-account.ts` and
`src/infrastructure/aws-sts-caller-identity.ts`; the layer mapping and tests
are in [doctor §Layer mapping](doctor.md#layer-mapping).

The Terraform input projection and the stable host key check are specified
in [provisioning §Resources and namespacing](provisioning.md#resources-and-namespacing).

Introduced by [#89](https://github.com/yaunder/factory/issues/89);
initialization by [#90](https://github.com/yaunder/factory/issues/90);
credentials by [#92](https://github.com/yaunder/factory/issues/92); the state
bucket rule by [#96](https://github.com/yaunder/factory/issues/96); API
credential references and interactive logins by
[#66](https://github.com/yaunder/fffactory/issues/66); the log archive, and the
state bucket's refusal of its name, by
[#110](https://github.com/yaunder/fffactory/issues/110).
