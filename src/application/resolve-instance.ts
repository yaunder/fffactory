import { dirname, join, resolve } from "node:path";
import type { InstanceStore } from "./instance-store";

export const INSTANCE_ENVIRONMENT_VARIABLE = "FFFACTORY_INSTANCE";
export const INSTANCE_FILE = join(".fffactory", "factory.json");

export interface InstanceSelection {
  /** Value of `--instance PATH`, if given. */
  readonly flag?: string;
  /** Value of `FFFACTORY_INSTANCE`, if set. An empty value counts as unset. */
  readonly environment?: string;
  readonly cwd: string;
  readonly home: string;
}

export type InstanceSource =
  | "--instance"
  | typeof INSTANCE_ENVIRONMENT_VARIABLE
  | "nearest"
  | "home";

export type InstanceResolution =
  | { readonly found: true; readonly path: string; readonly source: InstanceSource }
  /** `path` is set when an explicit selection named a path that is not a file. */
  | { readonly found: false; readonly message: string; readonly path?: string };

const SOURCE_DESCRIPTIONS: Readonly<Record<InstanceSource, string>> = {
  "--instance": "--instance",
  FFFACTORY_INSTANCE: INSTANCE_ENVIRONMENT_VARIABLE,
  nearest: "nearest .fffactory/factory.json",
  home: "~/.fffactory/factory.json",
};

/** How an operator would name the discovery source, such as `nearest .fffactory/factory.json`. */
export function describeSource(source: InstanceSource): string {
  return SOURCE_DESCRIPTIONS[source];
}

const NOT_FOUND =
  "No factory instance found. Run `fffactory init` to create ./.fffactory/factory.json, " +
  `or select an existing one with --instance PATH or ${INSTANCE_ENVIRONMENT_VARIABLE}.`;

async function explicit(
  store: InstanceStore,
  value: string,
  cwd: string,
  source: InstanceSource,
): Promise<InstanceResolution> {
  const path = resolve(cwd, value);
  return (await store.isFile(path))
    ? { found: true, path, source }
    : { found: false, path, message: `${source} names ${path}, which is not a file` };
}

async function nearest(store: InstanceStore, cwd: string): Promise<string | undefined> {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const candidate = join(directory, INSTANCE_FILE);
    if (await store.isFile(candidate)) return candidate;
    if (dirname(directory) === directory) return undefined;
  }
}

/**
 * Selects the instance document by precedence: `--instance PATH`, `FFFACTORY_INSTANCE`,
 * the nearest `.fffactory/factory.json` upward from `cwd`, then `~/.fffactory/factory.json`.
 * An explicitly selected path that does not exist is an error, never a fallback.
 */
export async function resolveInstance(
  store: InstanceStore,
  selection: InstanceSelection,
): Promise<InstanceResolution> {
  const { flag, environment, cwd, home } = selection;
  if (flag !== undefined) return explicit(store, flag, cwd, "--instance");
  if (environment) return explicit(store, environment, cwd, INSTANCE_ENVIRONMENT_VARIABLE);
  const found = await nearest(store, cwd);
  if (found) return { found: true, path: found, source: "nearest" };
  const homeInstance = join(home, INSTANCE_FILE);
  if (await store.isFile(homeInstance)) return { found: true, path: homeInstance, source: "home" };
  return { found: false, message: NOT_FOUND };
}
