# 0001 — Factory instance configuration

Status: superseded by [0002](0002-fffactory-v2.md). See
[issue #64](https://github.com/yaunder/factory/issues/64).

## Decision

The factory repository contains reusable code, tests, and an example. A factory
instance is a directory containing `config.json`, `infrastructure.tfvars`,
`backend.s3.tfbackend`, and `repositories.json`. Future dispatch settings belong
in `dispatch.json` in the same directory. Select an instance with `--instance
PATH`, `FACTORY_INSTANCE`, or an ignored `.fffactory/` directory in the checkout,
in that order. Keep the default instance files in that directory.
The default ignore rule protects this repository's local instance. A separate
factory repository may force-add its non-secret instance files and manage them
as reviewed desired state.
There is no implicit production fallback. Missing or inconsistent files are
errors before any state or deployment operation. `config.json` uses schema
version 1 and declares the name, canonical factory repository, AWS account and
Region, optional default profile, and deployment record prefix. The loader
checks the backend account and Region and tfvars Region against this identity.

`origin/main` supplies the deployed code. The selected instance supplies the
backend, Terraform inputs, repository inventory, and deployment identity.
`check`, `plan`, `deploy`, `status`, and host operations require an instance.
A deployment still checks that the caller is a clean merged ancestor of
`origin/main`, creates a fresh checkout and plan, and requires exact commit
approval before apply. Deployment provenance records the instance name. The
instance directory is intentionally not hashed or inspected as a Git checkout.
One instance per AWS account and Region is the current constraint because
resource and SSM document names remain shared defaults.

Terraform reads `${var.instance_dir}/repositories.json` and embeds it in the
Layer 2 SSM document. Hosts use the deployed document version and never fetch
instance files at run time. Future dispatch settings follow the same pattern.

CI runs shell tests and `factory-infrastructure validate --instance
environments/example`. Validation uses backend-disabled Terraform init and
reads no cloud state or credentials. The former production speculative plan and
its plan-only OIDC role are retired. Operators use `status` against their own
instance for live state and drift. Existing cloud plan-role and OIDC resources
require separate manual cleanup; this change does not delete them.

Secret values remain in external stores. An instance may contain secret
identifiers, never raw secret values.

## Instance data inventory

| Deployment-specific value | Former location | Instance target or disposition |
| --- | --- | --- |
| Region, CIDRs, availability zone, AMI, Tailscale secret ARN and tag, hosts, tags | `environments/production/infrastructure.tfvars` | `infrastructure.tfvars` |
| State bucket, key, Region, allowed account | `environments/production/backend.s3.tfbackend` | `backend.s3.tfbackend` |
| Repository inventory, sets, placement, future FFFlow levels | `development-environment/repositories.json` | `repositories.json` |
| Instance name, canonical repository, account, Region, profile default, deployment record prefix | `bin/factory-infrastructure`, `bin/factory-host` | `config.json` |
| Region default for AMI lookup | `resolve-al2023-ami.sh` | `config.json` |
| Account, Region, bucket, and key for state scripts | `bootstrap-terraform-state.sh`, `verify-terraform-state.sh` | `config.json` and backend file |
| Future per-host dispatch settings | Layer 4 design | `dispatch.json` |
| GitHub plan role, workflow ARN, account and Region | PR workflow and state scripts | Removed from CI and state bootstrap |
| Account, Region, bucket, key, and deployment prefix in IAM policy templates | `infrastructure/iam/` | Rendered from the selected instance when policies are configured |
| Account, profile, host, and path examples in operator prose | READMEs, playbooks, skills | Neutral instance and `HOST` instructions |

Resource names, SSM document names, layer scripts, and runtime version pins
remain factory code defaults. Adding two instances to one account will require
an explicit resource-name prefix and a reviewed resource migration.

## Migration

The former tracked production tfvars, backend, and repository inventory are
removed from the code repository. Copy them to a private directory and add a
`config.json` following `environments/example`. An operator may expose that
directory as `.fffactory/` in a checkout or pass its path explicitly. Confirm
`factory-infrastructure instance show` and `validate` before using `status` or
planning. Preserve host keys and the state bucket and key to avoid replacing
hosts or selecting a different state. The implementation worktree retains a
local ignored `.fffactory/` with the prior values for this operator. No cloud
state is moved by this repository change.
