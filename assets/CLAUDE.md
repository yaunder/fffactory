# assets: the release asset bundle

Everything here ships inside the `fffactory` executable as one gzipped tarball
whose SHA-256 the executable records. `scripts/build.ts` packs it with
`packAssetsDirectory` (`src/infrastructure/asset-bundle.ts`); the executable
materializes it into `<cache>/releases/<release>` and never reads this
directory. Spec: [docs/specs/release.md](../docs/specs/release.md) §"Executable
and assets".

- Every regular file is bundled at its path here, 0755 if executable, else 0644.
  Symbolic links and other special files are refused.
- `CLAUDE.md` files are repository documentation and are never bundled.
- `release.json` is generated from the release version, and a built bundle's `bin/fffactory`
  is the worker executable `scripts/build.ts` compiles; do not add either.
- Paths use printable ASCII without backslashes, and no segment is `.` or `..`.
- `terraform/` holds the Terraform modules and their provider lockfiles, and in
  `terraform/bootstrap/` the worker bootstrap; `steps/` holds the worker's install steps,
  pins and plugin manifest. Their own CLAUDE.md files have the rules.
