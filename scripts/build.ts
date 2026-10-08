#!/usr/bin/env bun
/**
 * Builds the worker executable, then the release asset bundle holding it, then one
 * `fffactory` executable per target, each embedding that same bundle and its SHA-256 digest.
 *
 *   bun scripts/build.ts [--outdir DIR] [TARGET ...]
 *
 * TARGET is `darwin-arm64` or `linux-x64`; without one, the host's own platform. Writes
 * `DIR/fffactory-worker-linux-x64`, `DIR/fffactory-assets.tar.gz`,
 * `DIR/fffactory-assets.tar.gz.sha256` and `DIR/fffactory-<TARGET>` for each target. DIR
 * defaults to `dist`. The worker executable is linux-x64 without an embedded bundle: on a
 * worker, the release directory it runs from holds the assets, and the bundle holds it as
 * `bin/fffactory`. The darwin-arm64 executable carries only the linker's ad-hoc signature;
 * `scripts/sign-macos.sh` re-signs it with Bun's entitlements on macOS.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RELEASE } from "../src/cli/release";
import { EMBEDDED_BUNDLE_NAME, packAssetsDirectory } from "../src/infrastructure/asset-bundle";
import { sha256Hex } from "../src/infrastructure/release-tarball";

const ROOT = resolve(import.meta.dir, "..");
const TARGETS = { "darwin-arm64": "bun-darwin-arm64", "linux-x64": "bun-linux-x64" } as const;
type Target = keyof typeof TARGETS;

function isTarget(name: string): name is Target {
  return Object.hasOwn(TARGETS, name);
}

function hostTarget(): Target {
  const host = `${process.platform}-${process.arch}`;
  if (isTarget(host)) return host;
  throw new Error(
    `No fffactory target for ${host}; name one of ${Object.keys(TARGETS).join(", ")}`,
  );
}

/** The executable workers run: the same CLI, with no bundle and so no recorded digest. */
async function compileWorker(outdir: string): Promise<Uint8Array> {
  const outfile = join(outdir, "fffactory-worker-linux-x64");
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/cli/main.ts")],
    compile: { target: TARGETS["linux-x64"], outfile },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Building fffactory-worker-linux-x64 failed");
  }
  console.log(`Built ${outfile}`);
  return new Uint8Array(await readFile(outfile));
}

async function compile(target: Target, bundle: string, sha256: string, outdir: string) {
  const outfile = join(outdir, `fffactory-${target}`);
  const result = await Bun.build({
    // The bundle is a second entry point, so Bun embeds it; `Bun.embeddedFiles` finds it by name.
    entrypoints: [join(ROOT, "src/cli/main.ts"), bundle],
    compile: { target: TARGETS[target], outfile },
    define: { FFFACTORY_ASSETS_SHA256: JSON.stringify(sha256) },
    naming: { asset: "[name].[ext]" },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Building fffactory-${target} failed`);
  }
  console.log(`Built ${outfile}`);
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { outdir: { type: "string", default: "dist" } },
  allowPositionals: true,
});
const unknown = positionals.filter((name) => !isTarget(name));
if (unknown.length > 0) throw new Error(`Unknown target: ${unknown.join(", ")}`);
const targets = positionals.length > 0 ? (positionals as Target[]) : [hostTarget()];

const outdir = resolve(values.outdir);
await mkdir(outdir, { recursive: true });
const worker = await compileWorker(outdir);
const tarball = await packAssetsDirectory(join(ROOT, "assets"), RELEASE, worker);
const sha256 = sha256Hex(tarball);
const bundle = join(outdir, EMBEDDED_BUNDLE_NAME);
await rm(bundle, { force: true });
await writeFile(bundle, tarball);
await writeFile(`${bundle}.sha256`, `${sha256}  ${EMBEDDED_BUNDLE_NAME}\n`);
console.log(`Packed ${bundle} for release ${RELEASE}: sha256 ${sha256}`);
for (const target of targets) await compile(target, bundle, sha256, outdir);
