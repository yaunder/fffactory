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
| `plan` | `plan -input=false -no-color -detailed-exitcode [-destroy] [-lock=false] -var-file=<inputs.tfvars.json> -out=<plan file>` | 30 min | `changes`: exit 2 is true, exit 0 false. |
| `showPlan` | `show -json -no-color <plan file>` | 5 min | The parsed JSON plan. |
| `applyPlan` | `apply -input=false -no-color <plan file>` | 60 min | Applies exactly the saved plan. |
| `output` | `output -json -no-color` | 5 min | Each output's value by name. |

`init` has a 10-minute deadline. `plan` adds `-lock=false` when its request
says `stateLock: false`, which a plan made outside the factory-wide lock does
([plan-apply §Plan](plan-apply.md#plan)); otherwise Terraform takes its own
state lock as usual. It adds `-destroy` when its request says `destroy: true`,
which only teardown's guarded destroy plan does ([Destroy plan](#destroy-plan));
otherwise it plans as usual. `show`, `apply` of a saved plan file and `output` take the
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
| `modules/host-identity` | The hosts' IAM role, assumable only by EC2, its instance profile, and one inline policy allowing `secretsmanager:GetSecretValue` on exactly the workers' secret references factory.json declares (`tailscale.auth_key_secret`, `hosts[].paseo_password_secret`, `credentials.*_secret`), never the operator's Tailscale admin client. One role serves every host, so each may read every host's Paseo password and every credential reference, whichever hosts keep an account on a human's login; narrowing it is an open question ([#64](https://github.com/yaunder/fffactory/issues/64)). Hosts can mutate nothing. |
| `modules/hosts` | One EC2 instance per stable host key, none for a factory that declares no host: `hosts[].instance_type`, an encrypted gp3 root volume of `hosts[].root_volume_gib` deleted with the instance, a public IP, IMDSv2 only with a hop limit of 1 and instance tags in metadata, the security group and instance profile above. Its user data is the worker bootstrap, `bootstrap/user-data.sh.tftpl` rendered with the host's namespaced hostname, the Region, the Tailscale reference and tag, and the activator ([worker bootstrap](worker-bootstrap.md)). It changes neither `ami` nor `user_data` of a running host: a newer image or bootstrap template never replaces a host. |
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
| Secrets `fffactory secret set` creates | `<id>/tailscale-auth-key`, `<id>/tailscale-admin-client`, `<id>/<host key>/paseo-password`, `<id>/github-token`, `<id>/anthropic-api-key`, `<id>/openai-api-key`: Secrets Manager names are paths, as in `examples/factory.json` ([secrets](secrets.md)) |

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
[worker bootstrap tests](worker-bootstrap.md#tests) run for the same inputs.
Last, it plans the factory root for `fff-aaaa1111` from the example without
hosts, an empty factory ([plan-apply §An empty factory](plan-apply.md#an-empty-factory)):
the plan must hold no instance, keep the VPC, the hosts' role and instance
profile, and its secret-reading policy must allow exactly the Tailscale
enrollment key. Then it checks terminate's scoped removal rule against
Terraform's real removal plans
([worker lifecycle §Terminate (remove)](worker-lifecycle.md#terminate-remove)):
from local states synthesized from its own plans of the example with several
hosts and with one, it plans each removal with `-refresh=false` and judges
the JSON plan with `removalPlanRefusal`. Last, from such states with one host
and with two, and from an empty state, it plans the `factory` root with
`-destroy -refresh=false` and judges each plan with `destroyPlanRefusal`
([Destroy plan](#destroy-plan)). The plans reach no AWS account: an override file in the script's copy only keeps
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
| `paseo_password_secret_arns` | `hosts[].paseo_password_secret`, by host key: every host declares one |
| `credential_secret_arns` | `credentials.github_token_secret`, `credentials.anthropic_api_key_secret`, `credentials.openai_api_key_secret`, by field name, for each one set; empty for none. Factory-wide: `interactive_logins` does not narrow it |
| `hosts` | `hosts[]` by host key: `instance_type` and `root_volume_gib`; empty for a factory that declares no host |

`tailscale.admin_client_secret` is projected into no variable: no worker may
read the operator's Tailscale admin client ([secrets](secrets.md#the-tailscale-admin-client)).

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
validations; none requires a host, so an empty factory's projection plans its
shared infrastructure alone, and its hosts' policy allows only the Tailscale
enrollment key and any credential references. The hosts' policy allows the
`distinct` union of the enrollment key, `paseo_password_secret_arns`' values
and `credential_secret_arns`' values; each ARN must be a Secrets Manager
secret in the factory Region and account, and `credential_secret_arns`' keys
only the three field names. A test checks that each projection supplies exactly its root
module's variables.

### Stable host keys

A host key, once provisioned, is never renamed, and only `fffactory worker
terminate KEY` removes one from factory.json, its machine with it
([worker lifecycle §Terminate (remove)](worker-lifecycle.md#terminate-remove)).
The factory root module's `host_keys` output records the keys its state has
provisioned. The factory projection takes that recorded set (empty before the
first apply) and refuses factory.json when it no longer declares one of them:

```text
hosts: host key "builder-1" is provisioned but no longer declared: host keys cannot be renamed, and only `fffactory worker terminate builder-1` removes a host. Restore it, and declare any new host under a new key beside it
```

A rename is indistinguishable from removing one key and adding another, so the
check rejects both; the recorded key is quoted only when it is a well-formed
host key (otherwise the command reads `fffactory worker terminate KEY`). Adding
keys is always accepted. The plan use case reads the recorded set with
`Provisioner.output` before planning (`recordedHostKeys`), and refuses removing
a host key by hand as a D11 refusal naming the command
([plan and apply §Refusals](plan-apply.md#refusals-until-lifecycle-work-lands-d11)).
Terraform backs this up: instances are keyed by host key, so a rename would
plan destroying the old host, which the refusal of host destroys and
replacements catches.

`worker terminate`'s removal reads the recorded set the same way, projects
factory.json without the host against the set less that one key, and plans and
applies it; the apply drops the key from the `host_keys` output, which it then
reads again to check. Once factory.json is written without the host, neither
records it, and the next plan has no change for it. That holds for the last
host too: the recorded set and the declared hosts are then both empty. A key
removed this way is no longer recorded, so declaring it again later is a plain
create, as is any new key.

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
   | 403 | Refused: `The state bucket B is not accessible in account A: it belongs to another account, or these credentials may not reach it (S3 answered 403)`. Bucket names are global, so the name may be taken. The refusal is typed (`StateBucketUnreachable`), so teardown can say what it may mean after an earlier teardown ([teardown §Rerun](teardown.md#rerun)). |
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
   operation is refused before any plan or lock, changing nothing. Laid out
   as [plan and apply](plan-apply.md#how-refusals-are-shown) lays out its
   refusals, on standard error:

   ```text
   ✖ The state bucket fff-abcd1234-state exists, but backend bootstrap did not finish it. It lacks:
     versioning (never enabled)
     TLS-only bucket policy

   ── Next ─────────────────────────────────────────────
     If another first apply is still bootstrapping it, wait for that to finish, then retry.

     Otherwise complete the bucket with these AWS CLI commands, using credentials for account 123456789012, then retry:
       $ aws s3api put-bucket-versioning --region eu-west-2 --bucket fff-abcd1234-state --expected-bucket-owner 123456789012 --versioning-configuration Status=Enabled
       $ aws s3api put-bucket-policy --region eu-west-2 --bucket fff-abcd1234-state --expected-bucket-owner 123456789012 --policy '{"Version":"2012-10-17","Statement":[{"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*","Action":"s3:*","Resource":["arn:aws:s3:::fff-abcd1234-state","arn:aws:s3:::fff-abcd1234-state/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}'
     put-bucket-policy replaces the whole bucket policy: add any statements it already has.
   ```

   Each lacking setting is listed (versioning with its state, `never
   enabled` or `Suspended`; `public access block`; `default encryption`;
   `TLS-only bucket policy`) with the one command that applies it as the
   `state-bucket` module does, in the module's order, and a muted warning that
   the policy command replaces any existing bucket policy. fffactory cannot finish
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
   (`src/application/approval.ts`), which takes it as a backend bootstrap
   `PlanReview` that the CLI lays out
   (`src/cli/presentation/plan.ts`):

   ```text
   ── Plan: backend bootstrap ──────────────────────────
     Factory   Test factory (fff-abcd1234)
     Account   123456789012 · eu-west-2
     Release   0.3.0

     State bucket     fff-abcd1234-state, which does not exist yet
     Infrastructure   1 to add, 0 to change, 0 to destroy
       + module.state_bucket.aws_s3_bucket.state
   ```

   It names the factory, account, Region and release as the factory's `Plan`
   section does ([plan and apply §Plan](plan-apply.md#plan)), and each
   resource Terraform creates under the tally. Declining applies nothing, and
   takes no lock;
6. the approved plan, exactly that saved plan, is applied;
7. the factory-wide lock is acquired in the bucket (next section) for the
   operation, and held by it from then on. The operation then builds the
   complete factory plan and asks for the normal approval
   ([plan and apply §Apply](plan-apply.md#apply)); a saved bootstrap plan's
   apply records the bootstrap and stops instead (below).

An existing, ready bucket skips steps 3 to 6, so bootstrap is safe to repeat:
every later operation goes from the bucket and readiness checks straight to
the lock. The backend root module keeps no state of its own (it has no
backend block, and an operation's local state is removed with it): the
bucket is created once and, with `prevent_destroy`, never destroyed by
Terraform. It is deleted only by removing the whole factory, with S3 calls
([Deleting the state bucket](#deleting-the-state-bucket)).

Bootstrap necessarily runs before the lock exists: the lock lives in the
bucket, so nothing can be locked until the bucket is created. The lock is taken
right after it is. Two first applies racing
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

A saved bootstrap plan narrows that window. Its apply checks that the bucket
is missing before it reads the plan file back, and again right before it
applies it: a bucket another apply created by then makes the plan stale, and
nothing is applied. Only an apply that passes its last check while another's
`CreateBucket` is in flight still races as above, and one of them takes the
lock. Its plan, made while the bucket was missing, is never applied once the
bucket exists, ready or not: a new plan is made from what exists.

`fffactory apply` calls `beginFactoryOperation`, and implements `Approval` by
showing each plan and asking at the terminal
([plan and apply §Apply](plan-apply.md#apply)). Applying a saved factory plan passes
`mayBootstrap: false`: a missing bucket is then only reported, never created.
A saved bootstrap plan is the exception: `applySavedBootstrap` plans nothing,
takes naming the plan's ID as its approval, applies exactly its
`backend.tfplan` after the checks above, takes the lock, and the apply records
the bootstrap and stops
([plan and apply §Applying a saved bootstrap plan](plan-apply.md#applying-a-saved-bootstrap-plan)).
`fffactory plan` plans a missing bucket's bootstrap with
`planBackendBootstrap`, applying nothing, and saves it as that bootstrap plan
([plan and apply §Plan](plan-apply.md#plan)).

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
  ✖ The factory is locked by another operation:
    Lock jjjjjjjj: apply by arn:aws:iam::123456789012:user/other on desk
    Acquired 2026-09-30T11:55:00.000Z (5 min ago) by fffactory 0.3.0

  ── Next ─────────────────────────────────────────────
    Wait for it to finish. If its holder is no longer running, break the lock:
      $ fffactory lock break --profile factory
  ```

  That is `plan`'s, `apply`'s and `upgrade`'s refusal, laid out as their other
  refusals ([plan and apply §How refusals are shown](plan-apply.md#how-refusals-are-shown)):
  the `fffactory lock break` it names repeats the `--instance` and `--profile`
  the refused command was given. `worker stop|start|terminate` still print it
  unstyled: `The factory is locked by another operation:`, the holder's lines
  indented, then `Wait for it to finish. If its holder is no longer running,
  break the lock with `fffactory lock break`.` A lock that was released
  between the refusal and the read is retried, up to three attempts in all;
  after that the operation is refused with `✖ The factory lock kept changing
  hands while fffactory tried to take it` and a Next block, `Try again.` (the
  worker commands: `The factory lock kept changing hands while fffactory tried
  to take it; try again.`).
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

## Destroy plan

Removing a whole factory ([#56](https://github.com/yaunder/fffactory/issues/56))
destroys its `factory` root first (D6), with a destroy plan guarded before it
is shown or confirmed (D13). The teardown use case plans it under the factory
lock, after its inventory and before its confirmation, and applies exactly that
plan once its gates pass ([teardown §Order](teardown.md#order)), as
`fffactory teardown` runs it ([teardown §Command](teardown.md#command)). `plan`
and `apply` keep the D11 refusals of host destroys
([plan and apply §Refusals](plan-apply.md#refusals-until-lifecycle-work-lands-d11)),
and the state bucket, outside the `factory` root, is never Terraform's to
destroy ([Deleting the state bucket](#deleting-the-state-bucket)).

The destroy plan is `plan -destroy` of the `factory` root (`PlanRequest.destroy`,
[Operations](#operations)) with today's projection: factory.json projected by
`projectFactoryVariables` with the host keys the state records, read with
`Provisioner.output` as a plan reads them
([Stable host keys](#stable-host-keys)). Destroy mode destroys whatever the
state holds, but Terraform still evaluates the configuration, so its variables
must be supplied and valid. The saved plan is read back with `showPlan`
(`show -json`) and judged by `destroyPlanRefusal` (`src/domain/teardown.ts`),
over the factory's instances EC2 lists by the factory ID tag
([status §Inventories](status.md#inventories)):

- A plan that cannot be read is refused: not a JSON object, `resource_changes`
  not a list, or a change without a printable address or a non-empty list of
  printable actions ([plan and apply](plan-apply.md), `resourceChanges`); and
  `output_changes`, when present, not an object, or a root output change
  without a printable name or a non-empty list of printable actions
  (`outputChanges` in `src/domain/plan.ts`), failing closed.
- Every resource change's actions must be exactly `["delete"]`, `["no-op"]` or
  `["read"]`. Anything else is refused, `create`, `update`, a replacement
  (`["delete", "create"]` or `["create", "delete"]`), `forget` and any action
  fffactory does not know among them, and so is a list mixing the allowed ones.
- Every root output change's actions must be exactly `["delete"]` or
  `["no-op"]`. An output has no side effect, but a destroy plan that creates
  or updates one is not a destroy: anything else, `read` among it, is refused
  like a resource change, listed as `output.NAME (ACTIONS)` after the
  resource changes.
- Each `delete` of a managed `aws_instance` (by type and mode, or by address
  when the plan names neither, as [D11](plan-apply.md#refusals-until-lifecycle-work-lands-d11)
  judges one) must destroy the instance EC2 lists for that host: the `id` its
  change's `before` names must be an instance EC2 lists for the factory, whose
  `fffactory:host-key` tag is a well-formed host key `KEY`, and the change's
  address must be `module.hosts.aws_instance.host["KEY"]`. This is the check
  `worker terminate` makes of the one host it removes
  ([worker lifecycle §Terminate (remove)](worker-lifecycle.md#terminate-remove)),
  made of every host. An empty inventory lists no instance, so every instance
  delete is refused.
- A plan with no change, an empty state's, passes: the `factory` root is
  already absent, as on a rerun after it was destroyed. So does a plan that
  deletes only root outputs, of a state that records root outputs but no
  resource: it is applied, so the state records no output
  ([teardown §Rerun](teardown.md#rerun)).

Terraform's `-detailed-exitcode` and the JSON plan must agree, as defence in
depth (`destroyPlanMismatch`, [teardown §Refusals](teardown.md#refusals)):
exit 2 needs a resource change or a root output change that is not `no-op`
or `read`, and exit 0 needs neither. Exit 2 is a "non-empty diff (changes
present)", and root output changes are part of that diff: in the PR #89
review, Terraform 1.16.4 exited 2 for a `-refresh=false` destroy plan of a
state with no resource and only `host_keys = []`,
`output_changes.host_keys.actions` `["delete"]` and no `resource_changes`.
`just terraform-check` reproduces that behaviour with a state recording no
resource and the root's three outputs (`host_keys = []`, `hosts = {}` and
`network`), each deleted. Counting only resource changes would refuse that
plan on every rerun.

| Refused | Summary | Details | Next action |
| --- | --- | --- | --- |
| Unreadable | `Terraform's destroy plan could not be read` | None | ``Rerun `fffactory teardown`.`` |
| A change other than a delete, no-op or read, or a root output change other than a delete or no-op | `Terraform's destroy plan does more than destroy the factory's resources` | Each offending resource change, in the plan's order, as `ADDRESS (ACTIONS)`, such as `module.network.aws_vpc.this (update)`, then each offending output change, in the plan's order, as `output.NAME (ACTIONS)`, such as `output.hosts (update)` | ``Check the factory's Terraform state with `fffactory plan`, then rerun `fffactory teardown`.`` |
| An instance delete EC2 does not back | `Terraform's destroy plan destroys an instance EC2 does not list for the factory` | Each such delete as `ADDRESS (delete): ` and why: `the plan does not name the instance it destroys`; `instance ID, which EC2 does not list with the factory's tags`; `instance ID, which EC2 lists without a well-formed host key tag`; `instance ID, which EC2 lists for host KEY` | ``Check the factory's instances in the EC2 console, then rerun `fffactory teardown`.`` |

The first refusal that applies is the one given, in the table's order. A host
key tag that is not a well-formed host key is never echoed.

The rule relies on Terraform's documented JSON plan format and plan modes
(checked 2026-10-21 for the pinned 1.16):

- `plan -destroy` "creates a plan whose goal is to destroy all remote objects
  that currently exist, leaving an empty Terraform state";
  `-detailed-exitcode` exits 0 for "empty diff (no changes)" and 2 for a
  "non-empty diff (changes present)"
  (<https://developer.hashicorp.com/terraform/cli/commands/plan>). Root output
  changes count among them: observed, not documented (Terraform 1.16.4, in the
  PR #89 review and by `just terraform-check`, above).
- `resource_changes` describes "the individual change actions that Terraform
  plans", each with `change.actions`, one of `["no-op"]`, `["create"]`,
  `["read"]`, `["update"]`, `["delete", "create"]`, `["create", "delete"]` and
  `["delete"]`; "for `["create"]` and `["delete"]` actions, either `before` or
  `after` is unset (respectively)", so a delete's `before` holds the object as
  the state knew it, an instance's `id` among it. `forget`, which a `removed`
  block with `destroy = false` plans ("remove the resource from state without
  destroying the actual resource"), is not in that list; it is refused like any
  other action, and the modules hold no `removed` block ([Guardrails](#guardrails)).
- `output_changes` "describes the planned changes to the output values of the
  root module", each a change representation with the same `actions`
  (<https://developer.hashicorp.com/terraform/internals/json-format>); a
  destroy plan deletes every output the state records.
- `resource_drift` reports what refreshing found, not what the plan does, and
  is not read.

`just terraform-check` checks the rule against Terraform's own destroy plans
([Guardrails](#guardrails)): from local states synthesized from its plans of
the example with one host and with two, from an empty state, and from a state
holding only the root outputs (the one-host state stripped of its resources,
`host_keys` `[]` and `hosts` `{}`, `network` kept), each planned with
`-destroy`, as teardown plans it, and `-refresh=false`, since the offline
check has no AWS to refresh against (teardown refreshes). Each plan must delete
every managed resource and every root output its prior state holds and change
nothing else (the empty state's changes nothing, the outputs-only state's
deletes only its outputs and exits 2), and `destroyPlanMismatch` must agree
with its exit code; `destroyPlanRefusal` must pass it with EC2 listing the
instances the state records, and refuse it with EC2 listing none, with another
instance listed in place of one, with any one resource change tampered into
`update`, a replacement or `forget`, and with any one output change tampered
into `update` or `create`.

### Tagged VPCs

Teardown also lists the VPCs carrying the factory ID tag: after the destroy,
any left is a leftover outside Terraform state that stops the run before
devices, secrets and the bucket (D12, [teardown §Order](teardown.md#order)),
and without a state bucket, any found refuses the cleanup (D10,
[teardown §No state bucket](teardown.md#no-state-bucket)). `MachineInventorySource.listVpcs`
(`ec2MachineInventory`) calls EC2 `DescribeVpcs` in the factory Region with
the filter `tag:fffactory:factory-id` = the factory ID, 1000 per page,
following `NextToken`, every page within one 15 s deadline
(`EC2_INVENTORY_TIMEOUT_MS`), and answers each VPC's ID (`VpcInventory`). The
listing proves absence, so it never skips: a VPC without a well-formed ID
(`vpc-` and 8 to 32 hexadecimal digits) makes it `unavailable`, `EC2
DescribeVpcs listed a VPC without a well-formed ID`, as do a failure, by error
name or network code (`EC2 DescribeVpcs failed: REASON`), and the deadline. It
needs `ec2:DescribeVpcs`, which EC2 does not scope to resources.

## Deleting the state bucket

Removing a whole factory ([#56](https://github.com/yaunder/fffactory/issues/56))
deletes its state bucket last (D6): the lock lives in it. The teardown use case
runs this last, under the factory lock it deletes, and on `absent` neither
releases the lock nor writes its record
([teardown §Operation record](teardown.md#operation-record)). Terraform never destroys the bucket
(`prevent_destroy`); `LockStore.deleteBucket` empties and deletes it with S3
calls, every one with `ExpectedBucketOwner` set to the factory's account:

1. `ListObjectVersions`, 1000 per page, following `NextKeyMarker` and
   `NextVersionIdMarker` while a page is truncated: every object version and
   every delete marker of every key, the Terraform state and its lock file,
   the operation records, the break log and the factory lock among them, each
   with whether it is its key's current one (`IsLatest`) and when it was
   written (`LastModified`). A version without an ID is the `null` version. A
   truncated page that names no next key, or a listed version without a key or
   without `LastModified`, fails the listing; none is looped on, skipped or
   guessed.
2. Each page is deleted before the next is listed: `DeleteObjects` in quiet
   mode, each object named by its key and version ID, at most 1000 per call
   (`DELETE_OBJECTS_LIMIT`), in listing order, every key but the lock's
   (`<factory ID>-lock.json` exactly; the break log's keys, under
   `<factory ID>-lock-log/`, are not the lock's). The lock's versions are set
   aside (`deletionBatches`). Deleting by version ID removes that version, or
   that delete marker, permanently, and writes no delete marker. The next page
   is asked for from the markers the last named, though the versions they name
   are gone by then: S3 resumes after the place they name. Were S3 ever to
   refuse such a marker, the listing fails and the bucket remains; a rerun
   lists from the start, the pages before already deleted.
3. Once the last page is done, the lock's versions and delete markers, in
   calls of their own (`lockBatches`): first every one no longer current,
   oldest first by `LastModified`, then the current one (`IsLatest`) alone, in
   the last call. The SDK returns a page's versions and its delete markers in
   two lists, each newest first, so listing order alone does not say whether a
   delete marker is older than a version; those written in the same instant go
   in reverse listing order. Deleting one no longer current never changes
   which is current. Deleting the current one makes the newest left current,
   so deleting it while an older one is left would revive an earlier holder's
   lock; and S3 promises no order within one call, so the current one never
   shares a call. The lock key seldom holds more than the lock in place: each
   release deletes its own version.
4. The lock's versions are deleted only once every other version is gone.
   When `DeleteObjects` reports a version it did not delete, the rest of the
   pages are still listed and their other keys deleted, but not the lock's
   versions, nor the bucket. The lock's calls stop at the first that reports a
   version it did not delete, or fails: the current one is deleted only once
   every other one of the lock's is gone.
5. `DeleteBucket`.

| S3 answers | Result | The lock (`lock`) |
| --- | --- | --- |
| `DeleteBucket` succeeds | `absent` | Gone with the bucket |
| 404 (`NoSuchBucket`) to any call | `absent`: the bucket is already gone, as on a rerun after it was deleted | Gone with the bucket |
| `DeleteObjects` reports versions it did not delete | `remains`: the listed versions not deleted, the lock's among them (those of its calls never made too), and S3's error code for them, each code once (`Unknown` for one that is not a plain name) | `held` for another key's version; `unknown` for one of the lock's |
| A call fails: an S3 error such as `AccessDenied`, the credential provider, the network, its deadline | `remains`: the failure, `S3 OPERATION on the state bucket failed: REASON` ([S3 failures](#s3-failures)), and the listed versions not yet deleted, unknown until the listing reached its last page. A call past its deadline may still have reached S3, so what is left is at most the count | `held` before the lock's calls; `unknown` in them |
| `DeleteBucket` refuses with `BucketNotEmpty` | `remains`, with the count unknown: a version was written since the listing | `deleted` |
| `DeleteBucket` fails otherwise | `remains`, empty: no version left | `deleted` |

A bucket another account owns answers 403 to the listing: it `remains`,
nothing is deleted, and it is never taken for absent. A failed call stops the
deletion at once; the next run lists again and resumes from what is left.

An interrupt (`interrupted`, [teardown §Interruption](teardown.md#interruption))
starts no further call: no listing, no `DeleteObjects` and no `DeleteBucket`.
A call already made finishes and is counted. The bucket `remains`, its failure
`Interrupted: no further S3 call was started` (`DELETION_INTERRUPTED`), with
the lock `held` until the call for its current version was made, since that
version goes alone in the last call of all, and `deleted` once every one of its
versions is gone.
Each listing page, each `DeleteObjects` call and `DeleteBucket` has a 30 s
deadline of its own (`S3_TIMEOUT_MS`), so a bucket too large to list within
one still loses a page of versions to every run.

The caller holds the factory lock, and deleting the bucket deletes it:

- `absent`: the lock is gone with the bucket. The caller neither releases it
  nor writes an operation record into the bucket.
- `remains` with `lock` `held`: it stopped before the lock's versions, so the
  lock stays held, and the factory locked, until the caller releases it.
- `remains` with `lock` `unknown`: a call for the lock's versions failed or
  refused one, so the lock may still be held, or be gone. Never an earlier
  version of it current: the current one is deleted alone, last, and only once
  every other one of the lock's is gone.
- `remains` with `lock` `deleted`: every version of the lock is gone, so the
  factory is unlocked, and another operation may lock it (`DeleteBucket` then
  refuses with `BucketNotEmpty`).

Releasing the lock by its version while the bucket still exists is harmless in
every case: it deletes that version only, and a version already gone is
deleted again without error.

Why, per the Amazon S3 API Reference and User Guide (checked 2026-10-21):

- `DeleteBucket`: "All objects (including all object versions and delete
  markers) in the bucket must be deleted before the bucket itself can be
  deleted." S3 refuses a bucket that is not empty with `BucketNotEmpty`.
- `DeleteObjects` takes "up to 1,000 keys" and, optionally, a version ID for
  each, and answers 200 with each key's result, "success or failure": a
  per-key failure is an `Error` entry with its `Code`, never a failed call.
  In quiet mode "the response includes only keys where the delete operation
  encountered an error". Naming a delete marker's version ID deletes the
  marker. "If the object specified in the request isn't found, Amazon S3
  confirms the deletion by returning the result as deleted", so a rerun
  deleting versions already gone succeeds.
- `ListObjectVersions` returns at most 1,000 entries per answer, versions as
  `Version` and delete markers as `DeleteMarker`, each with `IsLatest`
  (whether it is its key's current one) and `LastModified`, a key's newest
  first; a truncated answer (`IsTruncated`) names where the next starts
  (`NextKeyMarker`, `NextVersionIdMarker`). The SDK gathers them into two
  lists, `Versions` and `DeleteMarkers`.
- Deleting a key's current version, or its current delete marker, by version
  ID makes the newest left current: a delete marker deleted that way brings
  the version under it back. Deleting one no longer current changes nothing
  else.
- `ExpectedBucketOwner`: "If the account ID that you provide does not match
  the actual owner of the bucket, the request fails with the HTTP status code
  `403 Forbidden`."
- Consistency: object writes, deletes and listings are strongly consistent, so
  a version deleted is never listed again. "Bucket configurations have an
  eventual consistency model": "if you delete a bucket and immediately list
  all buckets, the deleted bucket might still appear". `DeleteBucket`'s success
  is therefore the proof of absence, never a later `HeadBucket`, which may
  still find the bucket for a while. A run in that window lists an empty
  bucket and deletes it again, or finds it gone: `absent` either way.

Backend bootstrap enables neither Object Lock nor MFA delete, so neither is
handled. Incomplete multipart uploads are neither listed nor aborted:
fffactory starts none. If anything else kept the bucket, `DeleteBucket` would
fail and the bucket `remains`, never `absent`.

The operator's credentials need, beyond the lock's:

| Permission | Resource | For |
| --- | --- | --- |
| `s3:ListBucketVersions` | `arn:aws:s3:::BUCKET` | The listing. |
| `s3:DeleteObject`, `s3:DeleteObjectVersion` | `arn:aws:s3:::BUCKET/*` | `DeleteObjects` by version ID. |
| `s3:DeleteBucket` | `arn:aws:s3:::BUCKET` | The bucket. |

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/managed-terraform.ts` | `SUPPORTED_TERRAFORM`, the one pin; `ManagedTerraformState` and the `terraform` doctor check. Pure. |
| Application | `src/application/provisioner.ts` | The `Provisioner` port: `plan` (in destroy mode when asked), `showPlan`, `applyPlan`, `output`; `ProvisioningFailed` and `diagnosticsFileOf`. |
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
| Domain | `src/domain/backend-bootstrap.ts` | The create-only rule (`bootstrapPlanVerdict`, each offending change as a `ResourceChange`) and `BootstrapContext`; the state bucket's readiness rule, its TLS-only policy and its check, and `UnreadyBucket` (where the bucket is, what S3 reports and each setting it lacks). Pure; no text layout. |
| Domain | `src/domain/factory-lock.ts` | The lock record, its key and break-log key, parsing, staleness (`isStale`, `lockAge`, `formatDuration`), and the break confirmation rule (`confirmsBreak`). Pure; no text layout. |
| Domain | `src/domain/teardown.ts` | The guarded destroy plan's rule (`destroyPlanRefusal`, each refusal a summary, details and next action) and `VpcInventory`; the rest of teardown's rules are [teardown](teardown.md)'s. Pure. |
| Infrastructure | `src/infrastructure/ec2-inventory.ts` | `ec2MachineInventory`'s `listVpcs`: the factory's tagged VPCs from `DescribeVpcs`, paged, within one deadline, a VPC without a well-formed ID or a failure `unavailable`. |
| Domain | `src/domain/state-bucket-deletion.ts` | `DELETE_OBJECTS_LIMIT`, the order the bucket is emptied in, page by page with the lock's versions set aside (`deletionBatches`), then the lock's, in batches of their own, those no longer current oldest first and the current one alone and last (`lockBatches`), and how deleting it ended (`BucketDeletion`, and what became of the lock, `LockAfterDeletion`). Pure. |
| CLI adapter | `src/cli/presentation/lock.ts` | The holder lines (`describeHeldLock`) and the lock refusal: `lockRefusalReport` in blocks for plan, apply and upgrade, and the unstyled `lockRefusal` the worker commands still print. |
| Application | `src/application/bootstrap-backend.ts` | `bootstrapBackend` and `beginFactoryOperation`: the bootstrap plan approved as a `PlanReview`, an unready bucket returned as its `UnreadyBucket`; and `applySavedBootstrap`, a saved bootstrap plan's exact apply, its review shown as the same `PlanReview`. |
| CLI adapter | `src/cli/presentation/plan.ts` | The bootstrap plan as shown (`bootstrapSection`), and as `plan` saves it (`savedBootstrapPlanReport`), and the unready bucket's refusal (`planRefusalReport`): what it lacks, the AWS CLI commands that complete it, and the warning that `put-bucket-policy` replaces the whole policy. |
| Application | `src/application/factory-lock.ts` | `stateBucketOf`, `lockHolder`, `acquireFactoryLock`, `releaseFactoryLock`, `settleFactoryLock`, `withFactoryLock`, `breakFactoryLock`. |
| Application | `src/application/lock-store.ts`, `src/application/approval.ts`, `src/application/operator-prompt.ts` | The `LockStore`, `Approval` and `OperatorPrompt` ports. |
| Infrastructure | `src/infrastructure/aws-s3-lock-store.ts` | `s3LockStore`: HeadBucket, the bucket's versioning, public access block, encryption and policy, conditional PutObject, GetObject and DeleteObject by version, PutObject of [operation records](plan-apply.md#operation-records), their ListObjectsV2 and GetObject for teardown ([teardown §Devices](teardown.md#devices)), and HeadObject of the Terraform state; and the bucket's deletion, ListObjectVersions page by page, each page's DeleteObjects by version before the next, then the lock's, and DeleteBucket, each failure `remains` by name and a 404 `absent`; always with `ExpectedBucketOwner`. |
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
and `-destroy` only when asked, a failed command's standard error kept in a private diagnostics
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
projected, the factory's own Tailscale reference and tag, an empty factory
projecting no hosts, incomplete instances and renamed host keys refused),
`tests/infrastructure/terraform/resource-names.test.ts` (names collected from
JSON plans, unprefixed and unknown names and unclassified types reported, two
factory IDs sharing no name) and `tests/assets/terraform/guardrails.test.ts`
(the modules pass, each fixture fails with its violations, the lockfiles pin
the required provider version, each projection matches its root module's
variables, and no validation of the `hosts` variable requires a host).
`scripts/terraform-check.ts` runs the modules' `fmt`, `validate`, namespacing
plans, the empty factory's plan, the removal plans and the destroy plans
(`scripts/terraform-destroy-check.ts`) with the managed Terraform in CI.
Destroy plan: `tests/domain/teardown.test.ts` (hand-written plans: deletes,
reads and no-ops passed; an update, a create, a replacement either way,
`forget`, an unknown action and a mixed list refused, each as `ADDRESS
(ACTIONS)` in the plan's order; root outputs deleted or left passed, a plan
deleting only outputs passed, an output created, updated, read, replaced or
changed by an unknown action refused as `output.NAME (ACTIONS)` after the
resource changes, unreadable `output_changes` refused; an instance delete EC2 does not list, one
listed for another host or without a well-formed host key tag (never echoed),
one that names no instance, and every one with an empty inventory refused; an
unreadable plan refused; an empty plan passed), `tests/domain/plan.test.ts`
(`outputChanges`: by name in the plan's order, none without `output_changes`,
an unreadable shape undefined), and
`tests/infrastructure/ec2-inventory.test.ts` (the tagged VPC listing over
stubbed calls: its filter, pages and session, none listed, a VPC without a
well-formed ID, a failure by name and the deadline; and over the real SDK
against `tests/support/stub-ec2-instances.ts`, which applies `DescribeVpcs`'
tag filters, another factory's and an untagged VPC left out).
First apply and lock: `tests/domain/backend-bootstrap.test.ts` (resource
changes read, unreadable plans, the create-only rule; the readiness rule, the
TLS-only policy check and policy, the unready bucket's location, readiness and
missing settings in bootstrap's order),
`tests/cli/presentation/plan.test.ts` (the bootstrap plan as shown, refused
plans with each reason; the unready bucket's guidance, its commands in
bootstrap's order and the whole-policy warning),
`tests/domain/factory-lock.test.ts` (keys, record round trip, unreadable
records, holder and breaker recorded in printable ASCII, age and staleness,
confirmation by token only, the break entry),
`tests/domain/state-bucket-deletion.test.ts` (a page's lock versions and
delete markers set aside; the break log and another factory's lock not the
lock; batches of at most 1000; the lock's versions and delete markers, listed
apart, no longer current oldest first by when written, those written in the
same instant in reverse listing order, then the current one alone, last), `tests/cli/presentation/lock.test.ts`
(holder lines, a stale and an unreadable lock, the refusal), `tests/application/bootstrap-backend.test.ts` (an
existing bucket skipped, a half-bootstrapped one refused before any plan or
lock, a missing one planned, shown, approved and applied, a
declined, non-create, unreadable or empty plan never applied, refusals before
AWS, another account refused, the lock acquired after bootstrap, a concurrent
operation refused with its holder), `tests/application/factory-lock.test.ts`
(against `tests/support/memory-lock-store.ts`, a versioned in-memory lock
store: a concurrent apply refused with the holder's record, racing acquisitions,
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
closed port; deleting the bucket: each page deleted before the next is listed, the lock's
versions after every other's, oldest first and the current one alone and last, a current
delete marker the SDK lists apart deleted after the version under it, then the bucket, a
version S3 would not delete keeping the lock held and the bucket while every other page is
still listed and deleted, the lock's own versions refused or their call failing (`unknown`),
the lock's calls stopping at the first refusal, its current version and the bucket never sent,
unprintable codes, a failed or timed-out call stopping at once, its count unknown before the
last page, a failed listing on the first page or a later one, a markerless listing, a keyless
version or one without `LastModified`, `BucketNotEmpty` and
other `DeleteBucket` refusals (`deleted`), a 404 at each step, a deadline per page and per call;
and against the stub a used bucket with records, a break log, state versions, delete markers
and the lock emptied and deleted, `ExpectedBucketOwner` on every request, another account's
bucket untouched, 1500 versions deleted page by page, the lock's versions oldest first and
the current one alone and last, a lock released by a delete marker and taken again deleted
in that order, a refused version leaving the lock held, a version written after the listing,
and a bucket already gone; and the stub itself, as S3, resuming a listing after a deleted
version, refusing a version marker it never gave, and making the version under a current
delete marker current once that marker is deleted), `tests/infrastructure/terminal-prompt.test.ts` and
`tests/cli/lock.test.ts` (confirmation by `--lock-id` or typed ID only, the
log entry, a lock replaced while confirming, the account refusal before S3).

No test downloads Terraform or reads AWS.

Introduced by [#95](https://github.com/yaunder/factory/issues/95); resources
and namespacing by [#96](https://github.com/yaunder/factory/issues/96); host
user data by [#97](https://github.com/yaunder/factory/issues/97); first apply
and the factory-wide lock by [#98](https://github.com/yaunder/factory/issues/98); the lock's
interruption rule, operation records and the state revision by
[#99](https://github.com/yaunder/factory/issues/99); the hosts' read of the
credential references by [#68](https://github.com/yaunder/fffactory/issues/68);
deleting the state bucket by [#82](https://github.com/yaunder/fffactory/issues/82); the
destroy plan and the tagged VPC listing by [#83](https://github.com/yaunder/fffactory/issues/83).
