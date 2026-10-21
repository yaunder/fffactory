# scripts: build, sign, smoke-test and release the fffactory executables; check its Terraform and shipped skills

- `build.ts` is the single build entry point; CI and the justfile (`just build`,
  `build-all`, `smoke`) call it and nothing else builds executables. It compiles the
  linux-x64 worker executable first, without a bundle, packs it into the bundle as
  `bin/fffactory`, then compiles each target with that bundle
  ([docs/specs/release.md](../docs/specs/release.md) §Worker executable).
- `terraform-check.ts` (`just terraform-check`, CI's Terraform job) checks `assets/terraform`
  with the managed Terraform only: `fmt`, `validate` against the shipped lockfiles, and plans
  of both root modules for two factory IDs whose JSON must keep every name in its own
  namespace. Its plans reach no AWS: an override in its private copy gives the provider
  example keys and points every endpoint at a local stand-in, and Terraform runs with
  `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` at `/dev/null` and
  `AWS_EC2_METADATA_DISABLED=true`, so no local AWS profile or credential can be read. It
  downloads Terraform and the provider, so `check-all` does not run it.
- `terraform-check.ts` also compares each planned host's `user_data` with the rendering the
  bootstrap tests use (`tests/support/user-data.ts`), and plans the factory root without
  hosts, an empty factory: no instance, the shared infrastructure kept, the hosts' policy
  allowing only the Tailscale enrollment key; and with every credential reference set, the
  hosts' policy allowing exactly the enrollment key, the Paseo password and those references.
- `terraform-check.ts` last checks `worker terminate`'s scoped removal rule against real
  Terraform removal plans (`terraform-removal-check.ts`): states for several hosts and for
  one, synthesized offline by `terraform-state-fixture.ts` (each `-refresh=false` plan's
  resources written into a local state, unknown values filled with fake but well-formed IDs,
  until Terraform plans no resource change; that last plan, changing only outputs, applied
  with no API call), each removal planned as fffactory plans it but with `-refresh=false`,
  its JSON judged by `removalPlanRefusal`. Its provisioner calls (`showPlan`, `output`) run in the
  FFFactory cache, as fffactory's do. Add a case there whenever the rule or the modules
  change what a removal plans.
- `terraform-check.ts` then checks teardown's guarded destroy plan rule against real
  `plan -destroy` plans (`terraform-destroy-check.ts`), in the removal check's tree and state
  file: states with one host and with two, synthesized the same way, and an empty state, each
  plan deleting every managed resource of its prior state and nothing else, passed by
  `destroyPlanRefusal` with the state's instances listed and refused with none, another, or any
  one change tampered into a non-delete
  ([docs/specs/provisioning.md](../docs/specs/provisioning.md) §Destroy plan).
- `repository-skills.sh` (`just repository-skills`, part of `check-all`, and CI's
  "Factory code validation" job in `.github/workflows/repository-checks.yml`) checks the
  absence of checkout-local repository skills, AGENTS.md's capability routing and the
  shipped dispatch skill. It resolves the repository root one level up.
- `bootstrap-test.sh` (`just bootstrap-test`, CI's bootstrap job) runs each case of
  `tests/bootstrap/*.test.sh` in its own pinned `amazonlinux:2023` container with no network
  and the hostname `fff-aaaa1111-builder-1`, which `host apply`'s cases need.
  It needs Docker, so `check-all` does not run it. Spec:
  [docs/specs/worker-bootstrap.md](../docs/specs/worker-bootstrap.md).
- Shell scripts run on macOS's bash 3.2: no `mapfile`, `${x,,}` or associative arrays.
- `smoke-test.sh` runs with no Bun, Node or checkout, AWS sealed off and no network.
- `sign-macos.sh` runs after the build and changes the file: digest a darwin
  executable only after signing.
- `assemble-release.sh` is the release workflow's only logic: `check-tag` (tag is
  `v` + package.json version) and `assemble` (the four assets and `SHA256SUMS`, digested
  from the files as published). Keep workflow YAML to wiring; put checks here, tested by
  `tests/scripts/assemble-release.test.ts`.
- `install.sh` at the repository root is POSIX `sh`, not bash: no `local`, arrays,
  `[[`, `pipefail` or `$'…'`. It runs as `curl | sh` under dash and macOS bash 3.2,
  keeps all work in `main` called on the last line, never passes the token as an
  argument (curl reads headers from `--config -`), starts every curl call with `-q` so
  no `.curlrc` can print or forward the token, never uses sudo, and needs no jq.
  Check it with `shellcheck -s sh`.
- Keep every script shellcheck-clean.
- Spec: [docs/specs/release.md](../docs/specs/release.md).
