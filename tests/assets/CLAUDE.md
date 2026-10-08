# tests/assets: static checks of the release assets

`bun test` checks what `assets/` ships without running it: no Terraform, no install step.

- `terraform/` checks the shipped modules with `support/hcl.ts`, a structural HCL reader, and
  `support/terraform-guardrails.ts`, the D5 guardrails, against the real modules and against
  deliberately broken modules in `terraform/fixtures/`. Running the modules
  with the managed Terraform is `scripts/terraform-check.ts` (`just terraform-check`, in CI).
- `steps/` checks the install steps: one script per step in `INSTALL_STEPS`, `bash -n` and
  executable, no marker polling or v1 inputs, jq's re-evaluation markers, and the plugin
  manifest passing its own validator. It also scans the whole worker path, from the workers
  stage to the steps, for SSM. The Paseo programs in `control-plane/` it checks parse, are
  executable and name no v1 paths or markers, and that `setup-host.sh` hands the worker's
  addresses to `paseo-config.sh`, whose own Python tests sit beside it.
- `bootstrap/` renders the worker user data with `support/templatefile.ts`, the subset of
  Terraform's `templatefile` it uses, through `support/user-data.ts`.
  `base-generation.test.ts` records the bootstrap's digest for each base generation, so a
  bootstrap change forces a decision about `RELEASE_COMPATIBILITY`, and checks the shipped
  declaration against package.json's version (`RELEASE`): `base_generation_since` is never
  a later release.
- Running the bootstrap is `tests/bootstrap/`, not here.
