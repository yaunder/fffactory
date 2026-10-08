/**
 * bun tests/support/bootstrap-fixtures-main.ts OUTDIR
 *
 * Writes what the worker bootstrap container tests (scripts/bootstrap-test.sh) need from the
 * repository into OUTDIR:
 *
 * - `user-data.sh`: the bootstrap user data rendered for SAMPLE_INPUTS, as the hosts module
 *   renders it;
 * - `release.tar.gz`, its `.sha256` and `release.version`: this checkout's release bundle,
 *   packed by the fffactory packer from `assets/` plus a stand-in `bin/fffactory` that
 *   records how it ran, as the activator will receive a real release;
 * - `worker-release.tar.gz` and its `.sha256`: the release bundle as a worker receives it,
 *   with the real linux-x64 worker executable compiled from this checkout as
 *   `bin/fffactory`, and `tests/bootstrap/stand-in-steps/` in place of its install steps;
 * - `host.json` and `other-host.json`: the host projections apply sends
 *   fff-aaaa1111-builder-1, the container's hostname, and builder-2.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../../package.json";
import { hostProjection, hostProjectionJson } from "../../src/domain/host-projection";
import type { FactoryId, HostKey, Release } from "../../src/domain/instance";
import { packAssetsDirectory } from "../../src/infrastructure/asset-bundle";
import { sha256Hex } from "../../src/infrastructure/release-tarball";
import { renderUserData, SAMPLE_INPUTS } from "./user-data";

const STAND_IN = `#!/bin/bash
set -euo pipefail
{
  printf 'args=%s\\n' "$*"
  printf 'uid=%s\\n' "$(id -u)"
  printf 'self=%s\\n' "$0"
} >>/tmp/host-apply.record
if [[ "$*" == "host apply" ]]; then
  version="\${0%/bin/fffactory}"
  version="\${version##*/}"
  current=/opt/fffactory/current
  temporary="\${current}.$$.tmp"
  trap 'rm -f -- "$temporary"' EXIT
  ln -s "releases/$version" "$temporary"
  mv -Tf -- "$temporary" "$current"
  trap - EXIT
fi
`;

const [out] = process.argv.slice(2);
if (out === undefined) {
  console.error("usage: bun tests/support/bootstrap-fixtures-main.ts OUTDIR");
  process.exit(2);
}

await writeFile(join(out, "user-data.sh"), renderUserData(SAMPLE_INPUTS), { mode: 0o644 });

const release = packageJson.version as Release;
const tree = await mkdtemp(join(tmpdir(), "fffactory-bootstrap-release-"));
try {
  await cp(join(import.meta.dir, "../../assets"), tree, { recursive: true });
  await mkdir(join(tree, "bin"));
  await writeFile(join(tree, "bin/fffactory"), STAND_IN, { mode: 0o755 });
  const tarball = await packAssetsDirectory(tree, release);
  await writeFile(join(out, "release.tar.gz"), tarball, { mode: 0o644 });
  await writeFile(join(out, "release.tar.gz.sha256"), `${sha256Hex(tarball)}\n`, { mode: 0o644 });
  await writeFile(join(out, "release.version"), `${release}\n`, { mode: 0o644 });
} finally {
  await rm(tree, { recursive: true, force: true });
}

/** The worker executable, built as `scripts/build.ts` builds it. */
async function compiledWorker(directory: string): Promise<Uint8Array> {
  const outfile = join(directory, "fffactory");
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../src/cli/main.ts")],
    compile: { target: "bun-linux-x64", outfile },
  });
  if (!result.success) throw new Error("Building the worker executable failed");
  return new Uint8Array(await readFile(outfile));
}

const build = await mkdtemp(join(tmpdir(), "fffactory-bootstrap-worker-"));
try {
  const worker = await compiledWorker(build);
  const assets = join(build, "assets");
  await cp(join(import.meta.dir, "../../assets"), assets, { recursive: true });
  await cp(join(import.meta.dir, "../bootstrap/stand-in-steps"), join(assets, "steps"), {
    recursive: true,
    force: true,
  });
  const tarball = await packAssetsDirectory(assets, release, worker);
  await writeFile(join(out, "worker-release.tar.gz"), tarball, { mode: 0o644 });
  await writeFile(join(out, "worker-release.tar.gz.sha256"), `${sha256Hex(tarball)}\n`, {
    mode: 0o644,
  });
  for (const [file, key] of [
    ["host.json", "builder-1"],
    ["other-host.json", "builder-2"],
  ] as const)
    await writeFile(
      join(out, file),
      hostProjectionJson(hostProjection("fff-aaaa1111" as FactoryId, key as HostKey, release)),
      { mode: 0o644 },
    );
} finally {
  await rm(build, { recursive: true, force: true });
}
