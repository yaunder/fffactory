# Provisioning

FFFactory provisions a factory's AWS infrastructure with Terraform that it
manages itself, behind the application's `Provisioner` port. Design:
[fffactory-v2.md §Managed and external tools](../designs/fffactory-v2.md#managed-and-external-tools)
and [§Provisioning and bootstrap](../designs/fffactory-v2.md#provisioning-and-bootstrap).

## Managed Terraform

### Supported release

FFFactory runs exactly one Terraform release, pinned in one place:
`SUPPORTED_TERRAFORM` in
[`src/domain/managed-terraform.ts`](../../src/domain/managed-terraform.ts).
The pin is the version (`1.16.4`) and the SHA-256 of HashiCorp's
`terraform_<version>_SHA256SUMS` file for it. That file lists the SHA-256 of
every platform's zip archive, so the one digest pins every download. Changing
the release means changing both values together.

A `terraform` on `PATH`, and any other Terraform the operator installed, is
never used. Neither is the operator's Terraform CLI configuration
(`~/.terraformrc`, `TF_CLI_CONFIG_FILE`) or any other `TF_*` variable.

### Platforms

| Node platform | HashiCorp platform |
| --- | --- |
| `darwin` `arm64` | `darwin_arm64` |
| `darwin` `x64` | `darwin_amd64` |
| `linux` `x64` | `linux_amd64` |
| `linux` `arm64` | `linux_arm64` |

On any other platform, installing Terraform is refused and names the platform.

### Cache layout

Managed Terraform lives in the FFFactory cache directory
([doctor §Cache](doctor.md#cache)), all of it FFFactory's own:

| Path | Holds |
| --- | --- |
| `<cache>/terraform/<version>/terraform` | The verified executable, mode 0755. |
| `<cache>/terraform/plugins/` | The provider cache (`TF_PLUGIN_CACHE_DIR`), shared by every operation. |
| `<cache>/terraform/operations/` | One private directory per operation, removed when it ends. |
| `<cache>/terraform/diagnostics/` | Failed Terraform commands' standard error, one private file each ([Diagnostics](#diagnostics)). |
| `<cache>/terraform/.download-*` | The staging directory of an install in progress. |

### Download and verification

On first use, and whenever the executable is not installed, FFFactory:

1. downloads `https://releases.hashicorp.com/terraform/<version>/terraform_<version>_SHA256SUMS`
   and refuses, installing nothing, unless its SHA-256 is the pinned digest;
2. looks up `terraform_<version>_<platform>.zip` in it, refusing if it is not
   listed;
3. downloads the archive into a fresh staging directory under
   `<cache>/terraform/` and computes its SHA-256;
4. on a mismatch with the listed digest, **deletes the download** and refuses
   with `<archive> does not match its SHA-256 in HashiCorp's SHA256SUMS for
   Terraform <version>; the download was deleted`;
5. otherwise extracts `terraform` from the archive (FFFactory reads the zip
   itself; no `unzip` is needed), sets its mode to exactly 0755 whatever the
   umask, and renames the staged `<version>` directory into place.

The staging directory is removed however the install ends, so a failed or
refused install leaves nothing behind. An install killed by a signal cannot
remove its own: each install first removes every staging directory older than
an hour (`STALE_STAGING_MS`). No running install's is that old, since each of
its two downloads has a deadline, so a concurrent install's is left alone.

Each download has a 5-minute deadline; a failure names the URL and the HTTP
status, the deadline, or the network error code, never an error message.

A cache hit makes no request: an executable regular file at
`<cache>/terraform/<version>/terraform` is used as is. Because the version
directory appears only by a rename after verification, its presence means the
download was verified. Anything else there (a missing or non-executable file,
a link) is damaged and is replaced by a fresh download. Concurrent installs
each stage their own copy; the first rename wins and the others use it.

### Operations

Every `Provisioner` call is one operation. It installs Terraform if needed,
then creates its own directory with `mkdtemp` under
`<cache>/terraform/operations/`, so two operations, concurrent or not, never
share one. The directory holds:

| Entry | Purpose |
| --- | --- |
| `configuration/` | A copy of the shipped Terraform tree, so sibling modules resolve. Terraform runs in its root module. |
| `data/` | The operation's own `TF_DATA_DIR`, created by `terraform init`. |
| `terraformrc` | `TF_CLI_CONFIG_FILE`, so no operator CLI configuration applies (mode 0600). |
| `inputs.tfvars.json` | The plan's input variables (mode 0600). |
| `backend.tfbackend` | The backend settings, when there are any (mode 0600). |

`terraformrc` holds only a comment and
`provider_installation { direct {} }`: providers come from the registry
through the shared provider cache, never from the implied local mirror
directories under the operator's HOME (`~/.terraform.d/plugins`,
`~/.local/share/terraform/plugins`).

`backend.tfbackend` holds one attribute per setting, in name order, such as
`bucket = "fff-abcd1234-state"`. A setting name must match
`^[A-Za-z_][A-Za-z0-9_-]*$`; otherwise the operation is refused before it
starts, with `A backend setting name is not a valid Terraform attribute name`,
which does not echo the name. Each value is a literal HCL string: `"`, `\`
and control characters are escaped, and the template sequences `${` and `%{`
are written `$${` and `%%{`, so Terraform never interprets them.

The directory is removed when the call settles, whether it succeeds or fails.
The shipped configuration in the materialized release assets is copied and
never written. The root module is a relative path inside the Terraform tree;
an absolute path or one with `..` is refused. It must hold the shipped
provider lockfile, `.terraform.lock.hcl`; without one the operation is
refused before Terraform runs.

Each operation first runs
`terraform init -input=false -no-color -lockfile=readonly`, adding
`-backend-config=<backend.tfbackend>` when the backend has settings, so
providers come from the shared provider cache or the registry and must match
the shipped lockfile, which init may not change. Then:

| Port call | Terraform command | Deadline | Result |
| --- | --- | --- | --- |
| `plan` | `plan -input=false -no-color -detailed-exitcode [-lock=false] -var-file=<inputs.tfvars.json> -out=<plan file>` | 30 min | `changes`: exit 2 is true, exit 0 false. |
| `showPlan` | `show -json -no-color <plan file>` | 5 min | The parsed JSON plan. |
| `applyPlan` | `apply -input=false -no-color <plan file>` | 60 min | Applies exactly the saved plan. |
| `output` | `output -json -no-color` | 5 min | Each output's value by name. |

`init` has a 10-minute deadline. `plan` adds `-lock=false` when its request
says `stateLock: false`, which a plan made outside the factory-wide lock does
([plan-apply §Plan](plan-apply.md#plan)); otherwise Terraform takes its own
state lock as usual. `show`, `apply` of a saved plan file and `output` take the
state lock or not as Terraform does. The plan file is an absolute path the caller
owns; a relative one is refused. Input variables and backend settings reach
Terraform only through the operation's private files, never as command
arguments. Terraform state lives in the configured backend: local state
written inside an operation is removed with it.

An operation interrupted by a signal leaves its directory behind; each
operation first removes operation directories older than any operation runs,
3 hours (`STALE_OPERATION_MS`), so a running operation's is left alone. Known
limit: Terraform does not promise that its shared provider cache is safe for
concurrent `init`s; marked for re-evaluation in the code.

### Environment and credentials

Terraform runs by absolute path with standard input closed, in its own
session and process group.

At its deadline, or when `fffactory` is interrupted (SIGINT, SIGTERM or
SIGHUP), Terraform is stopped gracefully: its process group gets SIGINT,
Terraform's own interrupt, on which it finishes or cancels what it is doing,
persists state and releases the backend's state lock. Whatever of the group
still runs 2 minutes later (`TERRAFORM_STOP_GRACE_MS`) is killed with
SIGKILL, which can lose state for resources just created and leave the lock
held. Terraform's output is captured, so the first signal prints `Interrupted:
stopping running tools. Interrupt again to kill them at once (Terraform may lose
state).` on standard error at once; the second sentence only while a tool that
stops gracefully, such as Terraform, runs (`stopsGracefully`), since any other is
killed at once. A second signal to `fffactory` while tools
stop kills them at once. Once an interrupt starts stopping tools, no new
command starts. When they have stopped, an interrupted `apply` or `upgrade`,
which starts nothing more, has up to 5 seconds (`RETURN_GRACE_MS`) to return
and report what the interrupt left, such as the lock it keeps, and `fffactory`
then exits with 128 plus the first signal's number; any other command, which
does not report it, exits as soon as they have stopped
([plan and apply §Interruption](plan-apply.md#interruption)).

Its environment is built, not inherited:

- from the operator's environment, only `PATH`, `HOME`, `USER`, `LOGNAME`,
  `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, the proxy variables
  (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, in either case), `SSL_CERT_FILE`
  and `SSL_CERT_DIR`, and the `AWS_*` variables the credential selection
  permits;
- the credential selection the account check resolved
  ([doctor §AWS account](doctor.md#aws-account)):
  - a selected profile (`--profile` or `AWS_PROFILE`) is passed as
    `AWS_PROFILE`, with `AWS_EC2_METADATA_DISABLED=true`. No environment
    credential source is passed (`AWS_ACCESS_KEY_ID`,
    `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_SECURITY_TOKEN`,
    `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`,
    `AWS_CONTAINER_*`, `AWS_EC2_METADATA_*`): Terraform's AWS SDK prefers
    them to a profile, and a profile must never fall through to instance
    metadata;
  - the standard credential chain passes the operator's `AWS_*` variables;
  - in both, other `AWS_*` variables such as `AWS_CONFIG_FILE`,
    `AWS_SHARED_CREDENTIALS_FILE` and `AWS_CA_BUNDLE` pass, while
    `AWS_PROFILE` and `AWS_DEFAULT_PROFILE` pass only as selected;
- `AWS_REGION` and `AWS_DEFAULT_REGION` set to the factory Region; the
  operator's own Region is never used;
- `TF_DATA_DIR`, `TF_PLUGIN_CACHE_DIR`, `TF_CLI_CONFIG_FILE`,
  `TF_IN_AUTOMATION=1`, `TF_INPUT=0` and `CHECKPOINT_DISABLE=1`, which stops
  Terraform contacting HashiCorp's version-check service.

A command that exits with a status the call does not accept rejects with
`` `terraform <subcommand>` exited with status N ``; Terraform's standard
error is never in the message (see Diagnostics). Output that is not the
expected JSON is refused. A missing executable, one that cannot be started,
and a missed deadline each reject with their own message, and keep no
diagnostics.

### Diagnostics

Terraform's standard error is the only account of why a command failed, but it
may quote configuration and input values, so it is never printed, put in a
message, written to an [operation record](plan-apply.md#operation-records) or
sent to the state bucket. When a command exits with a status the call does not
accept, the provisioner writes its standard error to a new file,
`<cache>/terraform/diagnostics/<UTC time>-<subcommand>-<operation suffix>.log`
(such as `20260930T120000Z-apply-Ab12Cd.log`; directory 0700, file 0600,
created exclusively), and rejects with `ProvisioningFailed`, whose message is
the one above and which names the file. Commands print the path, never the text:

```text
Terraform's diagnostics: /home/operator/.cache/fffactory/terraform/diagnostics/20260930T120000Z-apply-Ab12Cd.log
```

A private local file is acceptable because what Terraform can quote is
factory.json's [projection](#terraform-inputs), which carries no secret values,
only references such as ARNs; the shipped modules read no secret value either;
and the operator's own cache is theirs alone. Each
operation first removes diagnostics files older than 7 days
(`DIAGNOSTICS_KEPT_MS`), as it does stale operation directories. Diagnostics
never block an operation: a directory that cannot be swept is left as it is,
and a failure whose file cannot be written is reported without a path.

### Doctor

`doctor`'s `terraform` check reports the cache state read-only, without
downloading or repairing anything; see [doctor §Cache](doctor.md#cache).

## Resources and namespacing

The release ships the factory's Terraform under `terraform/` in the release
assets ([`assets/terraform/`](../../assets/terraform)), reusing the v1
resource definitions where they fit. Several factories may share an AWS
account, Region and tailnet (D5), so every factory keeps to its own namespace.

### Modules

| Module | Holds |
| --- | --- |
| `factory/` (root) | The factory: `network`, `host-identity` and `hosts`, and the current Amazon Linux 2023 x86-64 image from the public SSM parameter `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64`. Its state lives in the S3 backend: the bucket comes from the backend settings, the key is `factory/terraform.tfstate`, encrypted, with S3 native locking (`use_lockfile`). |
| `backend/` (root) | The state bucket's definition, `state-bucket`, planned and applied only by [backend bootstrap](#backend-bootstrap). It has no backend of its own. |
| `modules/network` | The factory VPC (DNS support and hostnames on), its internet gateway, one public subnet in `network.availability_zone` that assigns no public IPs by default, a route table with a default route to the gateway, and the hosts' security group: no ingress, all egress (hosts are reached over Tailscale). |
| `modules/host-identity` | The hosts' IAM role, assumable only by EC2, its instance profile, and one inline policy allowing `secretsmanager:GetSecretValue` on exactly the secret references factory.json declares. Hosts can mutate nothing. |
| `modules/hosts` | One EC2 instance per stable host key: `hosts[].instance_type`, an encrypted gp3 root volume of `hosts[].root_volume_gib` deleted with the instance, a public IP, IMDSv2 only with a hop limit of 1 and instance tags in metadata, the security group and instance profile above. Its user data is the worker bootstrap, `bootstrap/user-data.sh.tftpl` rendered with the host's namespaced hostname, the Region, the Tailscale reference and tag, and the activator ([worker bootstrap](worker-bootstrap.md)). It changes neither `ami` nor `user_data` of a running host: a newer image or bootstrap template never replaces a host. |
| `bootstrap/` | Not a module: the worker bootstrap's user data template and root activator, which `modules/hosts` reads ([worker bootstrap](worker-bootstrap.md)). |
| `modules/state-bucket` | The state bucket: public access blocked, bucket-owner-enforced ownership, SSE-S3 encryption, versioning, a policy denying any request without TLS, and `prevent_destroy`. |

Each root module ships its `.terraform.lock.hcl`, generated with the managed
Terraform for `linux_amd64` and `darwin_arm64` (the release targets); it also
records the registry's digests for every platform. The AWS provider is pinned
to one exact version. `required_version` is only the floor these modules need
(`>= 1.11.0`, for S3 native locking); the release that runs is the managed one.

The provider refuses any account but `aws.account_id`
(`allowed_account_ids`), in addition to the account check every command runs
first, and runs in `aws.region`.

### Names

Every name a factory gives a resource is its factory ID, a hyphen and the
resource's own name (`src/domain/resource-naming.ts`):

| Resource | Name |
| --- | --- |
| VPC, internet gateway, subnet, route table | `Name` tag `<id>-vpc`, `<id>-igw`, `<id>-public`, `<id>-public` |
| Security group | name prefix `<id>-hosts-` (AWS appends a unique suffix), `Name` tag `<id>-hosts` |
| IAM role, instance profile | `<id>-host` |
| The role's inline policy | `<id>-read-secrets` |
| Host instance, and its Tailscale hostname | `Name` tag `<id>-<host key>` |
| Host root volume | `Name` tag `<id>-<host key>-root` |
| State bucket | `state_backend.bucket`, which must start with `<id>-` ([instance configuration](instance-configuration.md#state-bucket)) |
| Factory-wide lock, its break log | Objects `<id>-lock.json` and `<id>-lock-log/…` in the state bucket ([Lock](#lock)) |
| Secrets `fffactory secret set` creates | `<id>/tailscale-auth-key`, `<id>/<host key>/paseo-password`: Secrets Manager names are paths, as in `examples/factory.json` ([secrets](secrets.md)) |

The AWS provider's default tags put `fffactory:factory-id = <id>` and
`fffactory:managed-by = fffactory` on every taggable resource; a host's
instance and root volume also carry `fffactory:host-key = <host key>`.

Two factories' names never collide when neither factory ID is the other
followed by a hyphen and more: generated IDs (`fff-` and eight letters or
digits) never are. Two factories whose IDs are, such as `acme` and
`acme-lab`, could name hosts alike (`acme` host `lab-x` and `acme-lab` host
`x` are both `acme-lab-x`); do not give factories sharing an account or tailnet such IDs. IAM tag
conditions compare the whole factory ID, so they are unaffected.

### Guardrails

The modules are held to D5 by static checks that run in `bun test` without
Terraform, `tests/assets/terraform/guardrails.test.ts` over
`tests/support/terraform-guardrails.ts`:

- every resource type is classified in `NAMED_RESOURCES`
  (`src/infrastructure/terraform/resource-names.ts`) by the attributes that
  name it, or as having no name of its own (routes, associations, a bucket's
  settings); each of those names is a template beginning `${var.factory_id}-`.
  An unclassified type fails;
- every IAM policy is an `aws_iam_policy_document` with literal actions.
  An allowed statement whose actions are not all reads (`Get`, `List`,
  `Describe`, `BatchGet`) must carry a `StringEquals` condition on
  `aws:ResourceTag/fffactory:factory-id` or
  `ec2:ResourceTag/fffactory:factory-id` with the values `[var.factory_id]`;
  a trust statement may allow only `sts:AssumeRole`, and only to `Service`
  principals named without a wildcard. A `jsonencode` or heredoc policy, an
  attached or managed policy (any `policy_arn`, `policy_arns`,
  `managed_policy_arns` or `inline_policy`, whatever the resource type),
  `not_actions`, `not_resources`, `not_principals` and merged documents fail
  because the check cannot read them;
- no resource or `aws_iam_policy_document` holds a `dynamic` block, at any
  depth of nested blocks: the check cannot read its content, so a dynamic
  `inline_policy`, `principals` or `statement` would otherwise slip past it;
- every root module (a directory holding `.terraform.lock.hcl`), and only a
  root module, configures the AWS provider, always with the
  `fffactory:factory-id` default tag, and no resource sets that tag to anything
  but `var.factory_id` in `tags`, `tags_all` or `volume_tags`, at any depth of
  nested blocks. Such an attribute that is not an object constructor fails, and
  so does one with a key that is not a plain literal: a templated key
  (`"fffactory:${local.k}"`) could name the factory-ID tag. `$${` and `%%{` are
  escaped literals;
- every `module` call has a literal local source (`./` or `../`) that is a
  module in the checked tree, and passes `factory_id = var.factory_id`;
- Terraform JSON configuration (`*.tf.json`) fails: the check reads only HCL.
  So does any symbolic link in the checked tree, file or directory: Terraform
  follows it, the check does not. So does any override file (`override.tf`,
  `*_override.tf` and their `.tf.json` forms): Terraform merges it into the
  blocks it names, the check does not;
- the only provider is `hashicorp/aws`: a `provider` block other than `aws`, or
  a `required_providers` entry other than `aws` with source `hashicorp/aws`,
  fails. The only backend is `s3`, and only in a root module (`factory/`
  configures a partial one); any other backend and any `cloud` block fail;
- only the top-level blocks the modules use appear: `terraform`, `provider`,
  `variable`, `output`, `locals`, `module`, `resource` and `data`. `import`,
  `moved`, `removed`, `check` and any other fail: they act on resources the
  other checks do not read. The modules use no `moved` or `removed` block;
- data sources are only `aws_iam_policy_document` and `aws_ssm_parameter`, the
  types the modules use; any other type fails;
- no resource holds a `provisioner` or `connection` block, at any depth: they
  run commands outside the plan;
- root module variables have no defaults: factory.json, through the
  projection below, is their only source. The Tailscale enrollment key is
  therefore always the factory's own reference, `tailscale.auth_key_secret`.

The same test runs the check over deliberately broken fixtures
(`tests/assets/terraform/fixtures/`): unprefixed names, mutating statements
without the tag condition, trust statements open to any principal, unreadable
policies (an attached managed policy and a `.tf.json` file among them),
dynamic blocks in a resource and in a trust statement's principals, tag
overrides in nested blocks and behind templated keys, remote or untagged
module calls, blocks and data sources outside the allowlists, provisioners,
override files, providers other than AWS, backends other than a root module's
S3 one, a `cloud` block, and an untagged provider, a root module without one and a variable default
each fail with their own violation. Symbolic links are tested in a temporary
directory, not committed as fixtures.

Known limits, each marked in the code with a `TODO(re-evaluate when …)`:

- allowed resources can point at resources the factory does not own by ID or
  name (`aws_instance.iam_instance_profile`, `aws_iam_instance_profile.role`,
  `aws_route.route_table_id`, `aws_s3_bucket_policy.bucket`); in the modules
  each traces back to a resource they create, never a literal, a root variable
  or a data source. A plan-JSON rule that such an attribute is unknown at plan
  time or carries the factory ID would close it;
- `ebs_block_device.tags.Name` has no naming rule; the modules attach no extra
  EBS volumes;
- every `Get` action counts as a read, `sts:GetFederationToken` included; the
  modules allow only `secretsmanager:GetSecretValue`.

`bun scripts/terraform-check.ts` (`just terraform-check`, and CI's
`Terraform modules` job) runs the managed Terraform over a copy of the
modules: `fmt -check`, then `init -backend=false -lockfile=readonly` and
`validate` in each root module, then the namespacing plans. It plans both
root modules, `factory` and `backend`, for two factory IDs, `fff-aaaa1111`
and `fff-bbbb2222`, with `examples/factory.json` projected for each, and reads
each plan with `terraform show -json`. Every name `NAMED_RESOURCES` lists in
each plan's planned values must be known when planning and carry that plan's
factory ID, and no name of one factory's plans may appear in the other's; a
plan with no names fails too. Each planned host's `user_data`, rendered by
Terraform, must equal the rendering the
[worker bootstrap tests](worker-bootstrap.md#tests) run for the same inputs. The
plans reach no AWS account: an override file in the script's copy only keeps
state local, gives the provider AWS's documentation example keys, skips its
account and credential checks, and points every endpoint at a local
stand-in that answers only the image parameter lookup.

### Terraform inputs

`src/application/project-terraform-inputs.ts` projects factory.json into
each root module's variables. The projection lives only in memory and in an
operation's private inputs file ([Operations](#operations)); it is never
written where it could be edited, so factory.json stays the only desired
state. Secrets appear only as the references factory.json holds.

| Variable (`factory`) | From |
| --- | --- |
| `factory_id`, `account_id`, `region` | `factory_id`, `aws.account_id`, `aws.region` |
| `availability_zone`, `vpc_cidr`, `public_subnet_cidr` | `network.*` |
| `tailscale_auth_key_secret_arn` | `tailscale.auth_key_secret` |
| `tailscale_tag` | `tailscale.tag` |
| `paseo_password_secret_arns` | `hosts[].paseo_password_secret`, by host key, for hosts that declare one |
| `hosts` | `hosts[]` by host key: `instance_type` and `root_volume_gib` |

| Variable (`backend`) | From |
| --- | --- |
| `factory_id`, `account_id`, `region` | `factory_id`, `aws.account_id`, `aws.region` |
| `state_bucket_suffix` | `state_backend.bucket` after the factory ID and a hyphen |

The factory projection is refused, listing each issue by field path with
`is required to plan`, unless the instance is
[complete](instance-configuration.md#completeness). The backend projection
needs only `factory_id`, `aws.account_id`, `aws.region` and
`state_backend.bucket`, and refuses a bucket that does not carry the factory
ID. The root modules repeat factory.json's format rules as variable
validations. A test checks that each projection supplies exactly its root
module's variables.

### Stable host keys

A host key, once provisioned, is never renamed. The factory root module's
`host_keys` output records the keys its state has provisioned. The factory
projection takes that recorded set (empty before the first apply) and refuses
factory.json when it no longer declares one of them:

```text
hosts: host key "builder-1" is provisioned but no longer declared: host keys cannot be renamed or removed. Restore it, and declare any new host under a new key beside it
```

A rename is indistinguishable from removing one key and adding another, so the
check rejects both; the recorded key is quoted only when it is a well-formed
host key. Adding keys is always accepted. The plan use case reads the recorded
set with `Provisioner.output` before planning (`recordedHostKeys`), and refuses
removing a host key as a D11 refusal until retirement lands in M3
([plan and apply §Refusals](plan-apply.md#refusals-until-lifecycle-work-lands-d11)).
Terraform backs this up: instances are keyed by host key, so a rename would
plan destroying the old host, which the refusal of host destroys and
replacements catches.

## First apply

The state bucket holds the factory's Terraform state and the factory-wide
lock, so it must exist before either. On a factory's first apply it does not.
Design: [fffactory-v2.md §apply](../designs/fffactory-v2.md#apply).

### Backend bootstrap

`beginFactoryOperation` (`src/application/bootstrap-backend.ts`) starts every
mutating factory operation. Its caller has already run the account check
([instance configuration §Credentials](instance-configuration.md#credentials)):
the use case takes the allowed verdict as proof and refuses one for any other
account than `aws.account_id`. Then:

1. factory.json must declare `factory_id`, `aws.account_id`, `aws.region` and
   `state_backend.bucket` (each missing field is listed, `is required to reach
   the state bucket`), and the bucket must carry the factory ID
   ([Terraform inputs](#terraform-inputs));
2. S3 `HeadBucket`, with `ExpectedBucketOwner` set to the factory's account,
   decides whether the bucket exists:

   | S3 answers | Means |
   | --- | --- |
   | 200 | The bucket exists: no bootstrap, if it is ready (below). |
   | 404 | It does not: bootstrap it. |
   | 403 | Refused: `The state bucket B is not accessible in account A: it belongs to another account, or these credentials may not reach it (S3 answered 403)`. Bucket names are global, so the name may be taken. |
   | 301 | Refused: `The state bucket B exists outside the factory Region R (S3 answered 301)`. |

   An existing bucket must carry every setting backend bootstrap applies,
   read with `GetBucketVersioning`, `GetPublicAccessBlock`,
   `GetBucketEncryption` and `GetBucketPolicy` (each with
   `ExpectedBucketOwner`): versioning `Enabled`, all four public access
   block settings on, a default encryption rule, and a policy statement that
   denies `s3:*` on the bucket and its objects to every principal when
   `aws:SecureTransport` is `false`. S3's answer that a setting was never made
   counts as lacking it; any other failure fails the operation. A bucket
   lacking any of them was left by an interrupted bootstrap, and the
   operation is refused before any plan or lock, changing nothing:

   ```text
   The state bucket fff-abcd1234-state exists, but backend bootstrap did not finish it. It lacks:
     versioning (never enabled)
     TLS-only bucket policy
   If another first apply is still bootstrapping it, wait for that to finish, then retry.
   Otherwise complete the bucket with these AWS CLI commands, using credentials for account 123456789012, then retry:
     aws s3api put-bucket-versioning --region eu-west-2 --bucket fff-abcd1234-state --expected-bucket-owner 123456789012 --versioning-configuration Status=Enabled
     aws s3api put-bucket-policy --region eu-west-2 --bucket fff-abcd1234-state --expected-bucket-owner 123456789012 --policy '{"Version":"2012-10-17","Statement":[...]}'
   put-bucket-policy replaces the whole bucket policy: add any statements it already has.
   ```

   Each lacking setting is listed (versioning with its state, `never
   enabled` or `Suspended`; `public access block`; `default encryption`;
   `TLS-only bucket policy`) with the one command that applies it as the
   `state-bucket` module does, in the module's order, and a warning that the
   policy command replaces any existing bucket policy. fffactory cannot finish
   the bucket itself: the backend root keeps no state, and its plan would
   create a bucket that exists. Marked `TODO(re-evaluate when the
   state-bucket module's hardening changes, or when apply can import
   existing resources into the backend root)` in
   `src/domain/backend-bootstrap.ts`. Object ownership
   (`BucketOwnerEnforced`) is not checked: it is S3's default for new
   buckets;
3. when it does not exist, the `backend` root module is planned through the
   `Provisioner` with the [backend projection](#terraform-inputs), no backend
   settings, and a plan file the caller owns; the saved plan is read back with
   `showPlan`;
4. the plan may only create. Any other action (update, delete, replace), a
   plan that cannot be read, and a plan that creates nothing are refused
   before approval, listing each offending resource as `ADDRESS (ACTIONS)`,
   and nothing is applied;
5. the plan is shown for its own approval, through the `Approval` port
   (`src/application/approval.ts`):

   ```text
   Backend bootstrap: the state bucket fff-abcd1234-state does not exist yet.
     Configuration: /work/.fffactory/factory.json
     Factory: Test factory (fff-abcd1234)
     AWS account: 123456789012, Region: eu-west-2
     Release: 0.3.0
   Terraform will create:
     + module.state_bucket.aws_s3_bucket.state
     ...
   ```

   Declining applies nothing, and takes no lock;
6. the approved plan, exactly that saved plan, is applied;
7. the factory-wide lock is acquired in the bucket (next section) for the
   operation, and held by it from then on. The operation then builds the
   complete factory plan and asks for the normal approval
   ([plan and apply §Apply](plan-apply.md#apply)).

An existing, ready bucket skips steps 3 to 6, so bootstrap is safe to repeat:
every later operation goes from the bucket and readiness checks straight to
the lock. The backend root module keeps no state of its own (it has no
backend block, and an operation's local state is removed with it): the
bucket is created once and, with `prevent_destroy`, never destroyed by
fffactory.

Bootstrap necessarily runs before the lock exists. Two first applies racing
past the bucket check both plan and apply the bucket. Outside us-east-1, S3
refuses the second `CreateBucket` (`BucketAlreadyOwnedByYou`), so its apply
fails in Terraform; in us-east-1, `CreateBucket` on a bucket the account
already owns answers 200, so the second apply can succeed too, writing the
same settings, and both go on to the lock, which exactly one takes. A rerun of the failed apply that
lands while the first is still applying finds a bucket without all its
settings and is refused as above, naming the wait; once the first finishes,
a rerun finds the bucket ready and goes on to the lock. S3's versioning can
take a while to come into effect after it is enabled; the lock refuses to be
taken until it has (next section).

`fffactory apply` calls `beginFactoryOperation`, and implements `Approval` by
showing each plan and asking at the terminal
([plan and apply §Apply](plan-apply.md#apply)). Applying a saved plan passes
`mayBootstrap: false`: a missing bucket is then only reported, never created.
`fffactory plan` shows a missing bucket's bootstrap plan with
`planBackendBootstrap`, applying nothing.

## Lock

One factory-wide lock covers every stage of a mutating operation, not just
Terraform; Terraform keeps its own S3 state lock (`use_lockfile`) as an extra
safeguard. Design:
[fffactory-v2.md §apply](../designs/fffactory-v2.md#apply) and
§Failure behavior. The lease rules are in `src/domain/factory-lock.ts`.

### The lock object

The lock is one object in the state bucket, `<factory ID>-lock.json`, so its
name carries the factory ID (D5):

```json
{
  "schema_version": 1,
  "lock_id": "k3x9q2ab",
  "factory_id": "fff-abcd1234",
  "operation": "apply",
  "holder": {
    "principal": "arn:aws:sts::123456789012:assumed-role/Admin/operator",
    "host": "operator-laptop"
  },
  "acquired_at": "2026-09-30T10:00:00.000Z",
  "release": "0.3.0"
}
```

`lock_id` is eight random lowercase letters or digits, drawn like a factory
ID; the holder is the principal the account check resolved and the machine's
host name, each recorded so the lock always reads back: every character
outside printable ASCII becomes `?`, the value is cut to 2048 characters, and
an empty one is `unknown`. The break log records its breaker the same way.
Every request for the lock carries `ExpectedBucketOwner` with the factory's
account.

### Acquiring and releasing

- The lock is created with a conditional write, S3 `PutObject` with
  `If-None-Match: *`: it succeeds only when no lock object exists, so two
  operations can never both hold it. S3's `412 PreconditionFailed` (a lock
  exists) and `409 ConditionalRequestConflict` (another write is in flight)
  both refuse the acquisition.
- A refused acquisition reads the lock and refuses the operation, showing
  its holder:

  ```text
  The factory is locked by another operation:
    Lock k3x9q2ab: apply by arn:aws:sts::123456789012:assumed-role/Admin/operator on operator-laptop
    Acquired 2026-09-30T10:00:00.000Z (12 min ago) by fffactory 0.3.0
  Wait for it to finish. If its holder is no longer running, break the lock with `fffactory lock break`.
  ```

  A lock that was released between the refusal and the read is retried, up to
  three attempts in all; after that the operation is refused with `The factory
  lock kept changing hands while fffactory tried to take it; try again.`
- An object at the key that is not a valid lock record for this factory (not
  JSON, another schema version or factory, a malformed field, or any
  character outside printable ASCII in a shown field) is an **unreadable
  lock**: still held, never treated as absent. It is shown and confirmed by
  its S3 object version: `Lock VERSION: unreadable, so its holder and
  operation are unknown`.
- The lock is held from before the operation's first stage until after its
  last (`withFactoryLock`, or `beginFactoryOperation` then
  `releaseFactoryLock`). It is released when the operation's work settles,
  whether it succeeded or failed.
- Release deletes exactly the object version the holder created (S3
  `DeleteObject` with `VersionId`), so a holder whose lock was broken and
  replaced never removes the new one. Deleting the only version leaves no
  delete marker, so the key is free again.
- The lock therefore needs the bucket's versioning, which backend bootstrap
  enables and the readiness check requires. S3 can still store an object
  unversioned for a while after versioning is enabled. A lock written
  unversioned (S3 answers without a version ID, or with the `null` version of
  a suspended bucket) is removed again at once, by `DeleteObject` with
  `VersionId` `null`, which removes it from a never-versioned or a suspended
  bucket and leaves no delete marker, and the operation is refused: `Versioning
  is not in effect yet on the state bucket B, so the lock was not taken
  (fffactory removed the unversioned lock it wrote); retry in a few minutes`.
  A retried write that finds its own unversioned lock does the same. If that
  removal fails, the refusal says so, ``... and fffactory could not remove the
  unversioned lock it wrote (REASON): break it with `fffactory lock break`,
  then retry in a few minutes``. A version S3 answers that is not printable
  ASCII is refused, `The state bucket B returned an unreadable object version`.
- A lock object read back without a version ID, or with the `null` version,
  is such a leftover: it is held like any other lock, shown and broken as
  usual, and removed by the `null` version. Every unversioned lock shares
  that version, so a break also requires the lock's token to be unchanged
  since it was shown.
- An acquisition refused (412) by a lock whose `lock_id` is its own, as when
  the SDK retries a `PutObject` whose first attempt succeeded but lost its
  answer, has taken the lock, at the version it reads back.
- A process that exits or is killed while holding the lock leaves it in
  place, with its record showing the interrupted operation. A lock is never
  taken over or expired: only a confirmed break removes it.
- An interrupted operation never releases its lock (`settleFactoryLock`):
  from the first SIGINT, SIGTERM or SIGHUP, `cli/interrupts.ts` marks the
  command interrupted, and whether its work then fails or finishes, the lock
  stays.
  So an interrupted operation deterministically leaves its lock, even when
  `fffactory` exits at the grace's end, before the operation returns
  ([plan and apply §Interruption](plan-apply.md#interruption)).

A lock older than 3 hours (`LOCK_STALE_AFTER_MS`) is shown as probably
stale (`older than any operation runs, so it is probably stale`): an
infrastructure apply's Terraform deadlines alone add up to 100 minutes.
Staleness is only shown; it never lets an operation take the lock.

### `fffactory lock break`

```text
fffactory lock break [--instance PATH] [--profile NAME] [--lock-id ID]
```

1. Resolves and validates the instance and prints `Instance: PATH (SOURCE)`;
   refuses, listing the fields, when factory.json cannot locate the state
   bucket. It breaks the lock whatever release factory.json pins: the
   [CLI/pin match guard](plan-apply.md#clipin-match-guard) does not apply, so a
   lock an interrupted `fffactory upgrade` left before moving the pin can be
   broken by the release that took it.
2. Runs the account check, and refuses before reaching S3 unless the caller
   is in `aws.account_id`, with doctor's summary, details and next action.
3. Reads the lock. With none, prints `The factory is not locked: there is
   nothing to break.` and exits 0.
4. Prints `The factory is locked:` and the holder lines above.
5. Needs confirmation by the lock's token, its lock ID (or its object version
   when unreadable): `--lock-id ID`, or, at a terminal, typed at `Type the lock
   ID shown above to break the lock: `. Anything else, including `yes` and an
   empty answer, is refused with `That is not the lock ID shown above; the
   lock is unchanged.` Without a terminal and without `--lock-id` it prints
   `Breaking the lock needs confirmation: rerun at a terminal, or pass
   --lock-id ID with the lock ID shown above.` Each refusal exits 1.
6. Reads the lock again. If its version or token is no longer the one
   shown, nothing is broken: ``The lock changed after it was shown, so nothing was broken.
   Rerun `fffactory lock break` to see the lock now in place.``, exit 1.
7. Logs the break in the state bucket, then removes exactly that version, and
   prints `Broke the lock. The break is logged in the state bucket at KEY.`,
   exit 0. A failed log write leaves the lock in place.

The log entry is written with `If-None-Match: *` at
`<factory ID>-lock-log/<broken_at>-broken-<token>.json` and never replaced:

```json
{
  "schema_version": 1,
  "event": "broken",
  "lock_version": "3HL4kqtJlcpXroDTDmJ",
  "lock": { "lock_id": "k3x9q2ab", "...": "the broken record, or null when unreadable" },
  "broken_by": { "principal": "arn:aws:iam::123456789012:user/other", "host": "desk" },
  "broken_at": "2026-09-30T14:00:00.000Z",
  "release": "0.3.0"
}
```

Break a lock only when its holder is no longer running; AGENTS.md forbids
breaking it to make progress.

### S3 failures

Each lock store call has a 30-second deadline (`S3_TIMEOUT_MS`), after which
its requests are aborted. Failures are reported as `S3 OPERATION on the
state bucket failed: REASON`, where the reason is the S3 error code, `the
credential provider failed (NAME)`, `network error (CODE)` or `timed out after
N s`, never an AWS or SDK message.

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/managed-terraform.ts` | `SUPPORTED_TERRAFORM`, the one pin; `ManagedTerraformState` and the `terraform` doctor check. Pure. |
| Application | `src/application/provisioner.ts` | The `Provisioner` port: `plan`, `showPlan`, `applyPlan`, `output`; `ProvisioningFailed` and `diagnosticsFileOf`. |
| Application | `src/application/managed-terraform.ts` | The read-only `ManagedTerraformProbe` port and `managedTerraformPaths`, the cache layout. |
| Infrastructure | `src/infrastructure/terraform/installer.ts` | `managedTerraform`: platform names, download, SHA256SUMS and archive verification, atomic install, `inspect`. |
| Infrastructure | `src/infrastructure/terraform/zip.ts` | Extracting one entry from a zip archive. |
| Infrastructure | `src/infrastructure/terraform/runner.ts` | `terraformEnvironment` and `terraformRunner` over an injected `ProcessRunner`, stopping Terraform with SIGINT and a grace period. |
| Infrastructure | `src/infrastructure/local-tool-probe.ts` | `bunProcessRunner` with its graceful stop, `stopsGracefully`, `stopRunningTools` and `killRunningTools`. |
| Infrastructure | `src/infrastructure/terraform/provisioner.ts` | `terraformProvisioner`: per-operation directories, the Terraform commands, and failed commands' diagnostics files. |
| Domain | `src/domain/resource-naming.ts`, `src/domain/stable-host-keys.ts` | The namespacing rule, the factory-ID and host-key tags, the state bucket's suffix; the stable host key check. Pure. |
| Application | `src/application/project-terraform-inputs.ts` | factory.json projected into each root module's variables. |
| Infrastructure | `src/infrastructure/terraform/resource-names.ts` | `NAMED_RESOURCES`, and the namespacing check over a Terraform JSON plan. |
| Infrastructure | `assets/terraform/` | The Terraform modules and their provider lockfiles. |
| Domain | `src/domain/backend-bootstrap.ts` | Reading a JSON plan's resource changes, the create-only rule and the bootstrap plan's presentation; the state bucket's readiness rule, its TLS-only policy check and the unready bucket's refusal. Pure. |
| Domain | `src/domain/factory-lock.ts` | The lock record, its key and break-log key, parsing, staleness, the holder presentation and refusal, and the break confirmation rule. Pure. |
| Application | `src/application/bootstrap-backend.ts` | `bootstrapBackend` and `beginFactoryOperation`. |
| Application | `src/application/factory-lock.ts` | `stateBucketOf`, `lockHolder`, `acquireFactoryLock`, `releaseFactoryLock`, `settleFactoryLock`, `withFactoryLock`, `breakFactoryLock`. |
| Application | `src/application/lock-store.ts`, `src/application/approval.ts`, `src/application/operator-prompt.ts` | The `LockStore`, `Approval` and `OperatorPrompt` ports. |
| Infrastructure | `src/infrastructure/aws-s3-lock-store.ts` | `s3LockStore`: HeadBucket, the bucket's versioning, public access block, encryption and policy, conditional PutObject, GetObject and DeleteObject by version, PutObject of [operation records](plan-apply.md#operation-records) and HeadObject of the Terraform state, always with `ExpectedBucketOwner`. |
| Infrastructure | `src/infrastructure/aws-session.ts` | One deadline per port call, and AWS failures described by name and code. |
| Infrastructure | `src/infrastructure/terminal-prompt.ts` | `terminalPrompt`: echoed and hidden questions on standard error, standard input; at a terminal both are read in raw mode, so Ctrl-C cancels a question rather than interrupting `fffactory`, and an echoed answer is echoed by the prompt. |
| CLI adapter | `src/cli/main.ts` | Wires `managedTerraform()` as doctor's probe and the provisioner's installer, `terraformProvisioner`, `s3LockStore()`, `terminalPrompt(process.stdin, process.stderr)`, the host name and the clock, and `interruptible` (`src/cli/interrupts.ts`): on interrupt, says so on standard error, marks the command interrupted and stops running tools, waits up to `RETURN_GRACE_MS` for a command that waits on an interrupt (`waitsOnInterrupt`) to return, and kills them on a second signal. |
| CLI adapter | `src/cli/commands/lock.ts` | `fffactory lock break`. |

`bootstrapBackend` calls the `Provisioner` port's `plan`, `showPlan` and
`applyPlan`; the [plan and apply](plan-apply.md) use cases call all four,
`output` among them, and `beginFactoryOperation`.

Tests: `tests/domain/managed-terraform.test.ts`,
`tests/application/managed-terraform.test.ts`,
`tests/application/doctor.test.ts` (a fake `ManagedTerraformProbe`),
`tests/infrastructure/terraform/installer.test.ts` (against
`tests/support/fake-hashicorp-releases.ts`, a local stand-in for
releases.hashicorp.com: install and cache hit, an archive that does not match
SHA256SUMS refused and deleted, a SHA256SUMS that does not match the pin, a
platform not listed, an unsupported platform, HTTP errors, a stalled and an
unreachable server, a damaged copy replaced, concurrent installs, mode 0755
under a restrictive umask, stale staging directories removed; `inspect`
states), `tests/infrastructure/terraform/zip.test.ts` (archives built by
`tests/support/zip.ts`),
`tests/infrastructure/terraform/runner.test.ts` and
`tests/infrastructure/terraform/provisioner.test.ts` (a stand-in `terraform`,
`tests/support/fake-terraform.ts`, that records its arguments, working
directory, environment, data directory and any SIGINT: exact commands, the
environment for a profile and for the chain, SIGINT at the deadline, the
exact text and mode of the private inputs, CLI configuration and backend
files, literal backend values and refused setting names, the lockfile
refusal, operation cleanup, stale operation directories removed, `-lock=false`
only when asked, a failed command's standard error kept in a private diagnostics
file it names and never in its message, old diagnostics removed, diagnostics that
cannot be kept blocking nothing, a decoy
`terraform` on `PATH` that must never
run, and two concurrent operations that never share a data directory), and
`tests/infrastructure/local-tool-probe.test.ts` (the graceful stop at a
timeout, with shell stand-ins that exit on SIGINT or ignore it; `stopsGracefully`
only while such a tool runs; and
`stopRunningTools`, run in its own process by
`tests/support/stop-tools-main.ts`: tools with and without a graceful stop, a
forced kill while stopping, one stop signal only, and new commands refused).
Resources and namespacing: `tests/domain/resource-naming.test.ts`,
`tests/domain/stable-host-keys.test.ts` (renaming or removing a recorded key
rejected, adding accepted, malformed keys never echoed),
`tests/domain/instance.test.ts` (the state bucket rule),
`tests/application/project-terraform-inputs.test.ts` (every variable
projected, the factory's own Tailscale reference and tag, incomplete instances and
renamed host keys refused),
`tests/infrastructure/terraform/resource-names.test.ts` (names collected from
JSON plans, unprefixed and unknown names and unclassified types reported, two
factory IDs sharing no name) and `tests/assets/terraform/guardrails.test.ts`
(the modules pass, each fixture fails with its violations, the lockfiles pin
the required provider version, and each projection matches its root module's
variables). `scripts/terraform-check.ts` runs the modules' `fmt`, `validate`
and namespacing plans with the managed Terraform in CI.
First apply and lock: `tests/domain/backend-bootstrap.test.ts` (resource
changes read, unreadable plans, the create-only rule, the presentation; the
readiness rule, the TLS-only policy check, the unready bucket's refusal and
its commands),
`tests/domain/factory-lock.test.ts` (keys, record round trip, unreadable
records, holder and breaker recorded in printable ASCII, age and staleness,
holder lines, refusal, confirmation by token only, the break entry), `tests/application/bootstrap-backend.test.ts` (an
existing bucket skipped, a half-bootstrapped one refused before any plan or
lock, a missing one planned, shown, approved and applied, a
declined, non-create, unreadable or empty plan never applied, refusals before
AWS, another account refused, the lock acquired after bootstrap, a concurrent
operation refused with its holder), `tests/application/factory-lock.test.ts`
(against `tests/support/memory-lock-store.ts`, a versioned in-memory lock
store: a concurrent apply refused with the holder shown, racing acquisitions,
unreadable and vanishing locks, a retried write finding its own lock, an
unprintable host name, one lock across every stage, release after
failure, an interrupted operation keeping the lock, an unconfirmed break changing and logging nothing, a confirmed break
logged before removal, a changed lock never broken, also under the same
version, a failed log write),
`tests/infrastructure/aws-s3-lock-store.test.ts` (stubbed calls, and the real
SDK against `tests/support/stub-s3.ts`, a local S3 stand-in with versioned,
never-versioned and suspended buckets: HeadBucket by status, the readiness
settings, conditional writes, reads, deletes by version, the break log, a
never-versioned or suspended bucket refusing the lock and keeping nothing, a
leftover `null`-version lock held and broken, error names, a missing profile, a deadline and a
closed port), `tests/infrastructure/terminal-prompt.test.ts` and
`tests/cli/lock.test.ts` (confirmation by `--lock-id` or typed ID only, the
log entry, a lock replaced while confirming, the account refusal before S3).

No test downloads Terraform or reads AWS.

Introduced by [#95](https://github.com/yaunder/factory/issues/95); resources
and namespacing by [#96](https://github.com/yaunder/factory/issues/96); host
user data by [#97](https://github.com/yaunder/factory/issues/97); first apply
and the factory-wide lock by [#98](https://github.com/yaunder/factory/issues/98); the lock's
interruption rule, operation records and the state revision by
[#99](https://github.com/yaunder/factory/issues/99).
