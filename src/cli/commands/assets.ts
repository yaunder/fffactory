import { parseArgs } from "node:util";
import { releaseAssetsDirectory } from "../../application/asset-bundle";
import { cacheDirectoryPath } from "../../application/cache-directory";
import type { CliContext, Command } from "../context";

async function runAssets(args: readonly string[], context: CliContext): Promise<number> {
  parseArgs({ args: [...args], options: {}, strict: true, allowPositionals: false });
  const directory = releaseAssetsDirectory(
    cacheDirectoryPath(context.env, context.home),
    context.release,
  );
  await context.assets.materialize(directory);
  context.out(directory);
  return 0;
}

export const assetsCommand: Command = {
  summary: "Materialize this release's embedded assets and print their directory",
  usage: [
    "Usage: fffactory assets",
    "",
    "Verifies the release assets embedded in this executable against their recorded",
    "SHA-256 digest, extracts them into the FFFactory cache at",
    "releases/<release>, and prints that directory. When the directory already holds",
    "this bundle, it changes nothing.",
    "",
    "Exits 0 with the directory, or 1 when the assets are missing or fail",
    "verification, or cannot be written.",
  ],
  run: runAssets,
};
