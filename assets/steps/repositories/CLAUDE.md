# assets/steps/repositories: the repository-sync step

The factory's repository synchronization and FFFlow adoption check, shipped as
shell steps in the release assets (D3; reimplemented in TypeScript only when next
touched for another reason). Apply's repository stage runs them on a worker over
Tailscale SSH, not as an install step. Spec:
[docs/specs/repositories.md](../../../docs/specs/repositories.md).

- `sync-repositories.sh` reads a version-2 manifest the CLI projects per host
  (`src/domain/repository-placement.ts`), clones missing repositories,
  fast-forwards clean primary checkouts, and refuses and reports resets, dirty
  trees, divergence and unadopted branches; it never deletes a checkout. It
  refuses to run as root.
- `check-ffflow-adoption.sh` is the adoption check `sync-repositories.sh` calls
  per repository.
- These are not `INSTALL_STEPS`: `tests/assets/steps/steps.test.ts` lists only
  the top-level `assets/steps/*.sh`, so the subdirectory is excluded.
- `tests/sync-repositories.sh` is a bash test of the sync program, run in CI
  (`.github/workflows/repository-checks.yml`), never by `bun test`. Keep it green
  from here; it writes every manifest it needs into a temporary directory. Commit no
  fixture under `assets/`: every file there ships in the release bundle.
- A step is ported to TypeScript only when it is changed for another reason
  (D3). Until then, change the programs and their shell test together.
