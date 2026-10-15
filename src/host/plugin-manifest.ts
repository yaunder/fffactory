/** Release-owned plugin pins (host protocol §Plugin installation). */
export interface PluginPin {
  readonly id: string;
  readonly version: string;
  readonly marketplace: string;
  readonly path: string;
  readonly source: {
    readonly type: "github";
    readonly repository: string;
    readonly revision: string;
  };
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid plugin metadata");
  return value as Record<string, unknown>;
}

function keys(value: unknown, expected: string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).sort().join() !== expected.sort().join())
    throw new Error("Invalid plugin manifest");
  return record;
}

export function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Invalid plugin metadata");
  return value.map(object);
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function pin(value: unknown): PluginPin {
  const row = keys(value, ["id", "version", "marketplace", "path", "source"]);
  const source = keys(row.source, ["type", "repository", "revision"]);
  if (
    !matches(row.id, /^[a-z][a-z0-9-]*@[a-z][a-z0-9-]*$/) ||
    !matches(row.version, /^[0-9]+\.[0-9]+\.[0-9]+$/) ||
    !matches(row.marketplace, /^[a-z][a-z0-9-]*$/) ||
    !matches(row.path, /^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/)
  )
    throw new Error("Invalid plugin manifest");
  if (
    !row.id.endsWith(`@${row.marketplace}`) ||
    source.type !== "github" ||
    !matches(source.repository, /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/) ||
    !matches(source.revision, /^[0-9a-f]{40}$/)
  )
    throw new Error("Invalid plugin manifest");
  return {
    id: row.id,
    version: row.version,
    marketplace: row.marketplace,
    path: row.path,
    source: { type: "github", repository: source.repository, revision: source.revision },
  };
}

export function pluginPins(value: unknown): PluginPin[] {
  const manifest = keys(value, ["schema", "providers"]);
  const providers = keys(manifest.providers, ["claude", "codex"]);
  const claude = keys(providers.claude, ["plugins"]);
  const codex = keys(providers.codex, ["plugins"]);
  if (manifest.schema !== 1 || records(codex.plugins).length !== 0)
    throw new Error("Invalid plugin manifest");
  const pins = records(claude.plugins).map(pin);
  if (
    new Set(pins.map((row) => row.id)).size !== pins.length ||
    new Set(pins.map((row) => row.marketplace)).size !== pins.length
  )
    throw new Error("Invalid plugin manifest");
  return pins;
}

/** Catalog entries identify a plugin's location; only plugin.json owns its version. */
export function pluginMetadataMatches(
  pin: PluginPin,
  catalog: unknown,
  manifest: unknown,
): boolean {
  const marketplace = object(catalog);
  const plugin = object(manifest);
  const entries = records(marketplace.plugins).filter((row) => row.name === pin.id.split("@")[0]);
  return (
    marketplace.name === pin.marketplace &&
    entries.length === 1 &&
    entries[0]?.source === `./${pin.path}` &&
    plugin.name === pin.id.split("@")[0] &&
    plugin.version === pin.version
  );
}
