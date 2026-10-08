# assets/terraform: the factory's Terraform modules

Shipped in the release bundle and run only by the managed Terraform through the
`Provisioner` port. Spec: [docs/specs/provisioning.md](../../docs/specs/provisioning.md)
§"Resources and namespacing".

- Root modules (`factory/`, `backend/`) hold a `.terraform.lock.hcl`; the provisioner
  refuses a root without one and inits with `-lockfile=readonly`. After changing a provider
  version, regenerate it with the managed Terraform:
  `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`.
- Root variables are exactly what `src/application/project-terraform-inputs.ts` projects
  from factory.json, and have no defaults. `tests/assets/terraform/guardrails.test.ts`
  checks both.
- Every name is a template starting with `${var.factory_id}-`, and every resource type is
  classified in `NAMED_RESOURCES` (`src/infrastructure/terraform/resource-names.ts`).
- Every root module, and only a root module, configures the AWS provider; its
  `default_tags` put `fffactory:factory-id` on every resource. Resources never override
  that tag, in `tags` or any nested block's tags.
- Configuration is HCL only (no `*.tf.json`), with no override files (`override.tf`,
  `*_override.tf`). The only provider is `hashicorp/aws`; the only backend is `s3`, in a root
  module; no `cloud` block. A module call has a local `../modules/…`
  source and passes `factory_id = var.factory_id`.
- IAM policies are `aws_iam_policy_document` data sources with literal actions. A statement
  allowing anything but Get/List/Describe/BatchGet carries a `StringEquals` condition on
  `aws:ResourceTag/fffactory:factory-id` (or `ec2:ResourceTag/…`) with `[var.factory_id]`.
  Trust statements allow only `sts:AssumeRole` to named `Service` principals. No attached,
  managed or inline policies (`policy_arn`, `policy_arns`, `managed_policy_arns`,
  `inline_policy`).
- No `dynamic` blocks in resources or policy documents: the guardrails cannot read them.
  Tag keys are plain literals, never templates. No symbolic links.
- Top-level blocks are only `terraform`, `provider`, `variable`, `output`, `locals`,
  `module`, `resource`, `data` (no `import`, `moved`, `removed`, `check`); data sources only
  `aws_iam_policy_document` and `aws_ssm_parameter`; no `provisioner` or `connection` blocks.
  Widening an allowlist is a guardrail change: update the spec and fixtures with it.
- Host instances are keyed by stable host key and ignore `ami` and `user_data` changes.
- `bootstrap/` is not a module: the worker bootstrap user data template and root activator
  that `modules/hosts` reads. Its own CLAUDE.md has the rules.
- Check with `just terraform-check` (fmt, validate, namespacing plans); `bun test` runs the
  static guardrails.
