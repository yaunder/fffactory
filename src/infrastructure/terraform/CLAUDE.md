# infrastructure/terraform: managed Terraform

Spec: [docs/specs/provisioning.md](../../../docs/specs/provisioning.md) §"Managed Terraform".

- `installer.ts` is the only way to a Terraform executable: the pinned release from
  `domain/managed-terraform.ts`, verified against HashiCorp's SHA256SUMS (itself pinned),
  installed atomically in the cache. A mismatch deletes the download and refuses.
- `runner.ts` builds Terraform's whole environment from an allowlist; never pass the
  operator's environment through. A selected profile passes no environment credentials.
  Terraform is stopped with SIGINT and `TERRAFORM_STOP_GRACE_MS` before any SIGKILL, so
  it can persist state and release its lock.
- `provisioner.ts` gives every call its own `mkdtemp` operation directory and removes it;
  one an interrupted fffactory left is removed once older than `STALE_OPERATION_MS`.
  Inputs and backend settings go in private files, never command arguments. Backend
  setting names must be HCL identifiers; values are written as literal HCL strings.
- A failed Terraform command's standard error goes only to a private file in
  `<cache>/terraform/diagnostics/` (0700/0600), named by the `ProvisioningFailed` it
  rejects with, and pruned after `DIAGNOSTICS_KEPT_MS`. Never put it in a message, the
  operation record or the state bucket; print only the file's path.
- `plan` passes `-lock=false` when its request says `stateLock: false`: a plan made outside
  the factory lock takes no Terraform state lock, so a killed `fffactory plan` strands none.
- Tests use `tests/support/fake-terraform.ts` and `fake-hashicorp-releases.ts`; none
  downloads Terraform or reads AWS.
