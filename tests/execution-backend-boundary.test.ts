/**
 * The execution-backend boundary (`docs/specs/execution-backend.md` §The boundary): only the
 * allow-listed adapter files name Paseo's behavior. A repository check beside the SSM ban in
 * `assets/steps/steps.test.ts`, not a layer: it reads `src/`, `assets/` and `scripts/` as text
 * and runs nothing. CLAUDE.md files are documentation that never ships, so it skips them.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const SCANNED = ["src", "assets", "scripts"] as const;

interface Token {
  readonly name: string;
  readonly pattern: RegExp;
}

/** The top-level commands of the pinned Paseo, 0.15.0, as its `createCli` registers them. */
const COMMANDS = [
  "agent",
  "archive",
  "attach",
  "clone",
  "daemon",
  "delete",
  "heartbeat",
  "hooks",
  "host",
  "hub",
  "import",
  "inspect",
  "logs",
  "ls",
  "onboard",
  "pair",
  "permit",
  "plugin",
  "project",
  "provider",
  "reload",
  "restart",
  "run",
  "schedule",
  "script",
  "send",
  "speech",
  "start",
  "status",
  "stop",
  "terminal",
  "usage",
  "wait",
  "workspace",
  "worktree",
].join("|");

/**
 * Root options before the command, each with an optional value: `--json`, `-o json`, `--host=h`.
 * A value never starts with a dash, so a run of options parses one way, in linear time.
 */
const OPTIONS = String.raw`(?:\s+-[-\w]+(?:[= ][^\s-]\S*)?)*`;

/** The same, as quoted argument-list elements: `"--json", `, `"-o", "json", `. */
const OPTION_ELEMENTS = String.raw`(?:["']-[^"']*["']\s*,\s*(?:["'][^"'-][^"']*["']\s*,\s*)?)*`;

/**
 * The Paseo CLI run with one of its commands, after any root options: on a command line
 * (`paseo ls`, `paseo -o json ls`, `"$paseo" ls`, `"${PASEO}" ls`), as an argument list whose
 * program is `paseo` by name, path or a variable so named (`["paseo", "ls"]`,
 * `["paseo", "--json", "ls"]`, `execFile("/…/paseo", ["ls"])`, `command_json(PASEO, "ls")`),
 * as an argument list given to a function named `paseo` (`paseo(["project", "ls"])`), or
 * through a TypeScript handle that runs it. The backend's name alone (`["paseo"]`,
 * `("paseo", [])`) is none of these, nor is it followed by a quoted key that is also a command
 * (`"runtime": "paseo", "status": "ok"`).
 */
const CLI = new RegExp(
  [
    String.raw`\b(?:paseo|PASEO)\}?["']?${OPTIONS}\s+(?:${COMMANDS})\b`,
    String.raw`(?:["'](?:[^"'\s]*\/)?paseo["']|\b(?:paseo|PASEO)\b)\s*,\s*\[?\s*${OPTION_ELEMENTS}["'](?:${COMMANDS})["'](?!\s*:)`,
    String.raw`\bpaseo\s*\(\s*\[\s*${OPTION_ELEMENTS}["'](?:${COMMANDS})["']`,
    String.raw`\b(?:PaseoCommand|paseoCli|paseoRuns)\b`,
  ].join("|"),
);

/** Paseo's behavior, by what it names. The bare word "Paseo" in prose is not behavior. */
const BEHAVIOR: readonly Token[] = [
  { name: "the Paseo CLI", pattern: CLI },
  { name: "Paseo's paths", pattern: /\.paseo\b|\bpaseoWorktrees\b/ },
  { name: "Paseo's environment", pattern: /PASEO_[A-Z]/ },
  { name: "Paseo's port", pattern: /\b6767\b/ },
  { name: "Paseo's unit", pattern: /\bpaseo\.service\b/ },
  { name: "Paseo's package", pattern: /@getpaseo\b/ },
  { name: "Paseo's auth wrapper", pattern: /\bpaseo-auth\.sh\b/ },
];

/**
 * The files that may name Paseo's behavior, as globs over repository paths: the tracked
 * inventory of `docs/specs/execution-backend.md` §The boundary. The adapters stay; every other
 * entry leaves with the epic #136 task that moves its Paseo calls behind a seam.
 */
const ALLOW_LIST: readonly string[] = [
  // The adapters and their shipped assets.
  "src/host/paseo-backend.ts",
  "src/host/paseo-trigger.ts",
  "src/infrastructure/paseo-control-plane.ts",
  "assets/steps/control-plane/**",
  "assets/steps/dispatch/dispatch-schedule.sh",
  "assets/steps/dispatch/tests/test_dispatch_schedule.py",
  // Until #144: the backend's layout as data.
  "src/host/work.ts",
  "src/domain/work-inspection.ts",
  "src/domain/collector-installation.ts",
];

interface Quarantined extends Token {
  /** The files outside the allow-list that still use the name. */
  readonly files: readonly string[];
}

/**
 * Names #93 owns, tolerated outside the allow-list only in the files that use them today: a
 * quarantined name is blanked out there before the behavior scan, and fails anywhere else.
 */
// TODO(re-evaluate when #93 lands): remove
const QUARANTINE: readonly Quarantined[] = [
  {
    name: "paseo-password",
    pattern: /\bpaseo-password\b/,
    files: [
      "scripts/terraform-removal-check.ts",
      "src/cli/commands/init.ts",
      "src/cli/commands/secret.ts",
      "src/domain/instance.ts",
      "src/domain/secrets.ts",
    ],
  },
  {
    name: "paseo_password_secret",
    pattern: /\bpaseo_password_secret\w*/,
    files: [
      "assets/terraform/factory/main.tf",
      "assets/terraform/factory/variables.tf",
      "scripts/terraform-check.ts",
      "scripts/terraform-removal-check.ts",
      "src/application/project-terraform-inputs.ts",
      "src/application/worker-lifecycle.ts",
      "src/cli/commands/secret.ts",
      "src/domain/host-projection.ts",
      "src/domain/host-removal.ts",
      "src/domain/instance.ts",
      "src/domain/secrets.ts",
      "src/host/control-plane.ts",
    ],
  },
  {
    name: "paseo-package",
    pattern: /\bpaseo-package\b/,
    files: ["src/application/plan-control-plane.ts", "src/domain/change-classification.ts"],
  },
  {
    name: "paseo-configuration",
    pattern: /\bpaseo-configuration\b/,
    files: ["src/domain/change-classification.ts"],
  },
  {
    name: "paseo_health",
    pattern: /\bpaseo_health\b/,
    files: ["src/cli/presentation/apply.ts", "src/domain/dispatch-readiness.ts"],
  },
  {
    name: "paseo_changed",
    pattern: /\bpaseo_changed\b/,
    files: [
      "src/application/apply-factory.ts",
      "src/cli/presentation/plan.ts",
      "src/domain/plan.ts",
    ],
  },
  {
    // With apply's note that carries it.
    name: "PASEO_CLIENTS",
    pattern: /\bPASEO_(?:CLIENTS|NOTE)\b/,
    files: ["src/cli/presentation/apply.ts", "src/domain/readiness.ts"],
  },
  {
    // Where operator text names Paseo's unit or worktrees; the word alone is not scanned.
    name: "Paseo in human output",
    pattern: /systemctl status paseo\.service|~\/\.paseo\/worktrees/,
    files: [
      "src/application/apply-control-plane.ts",
      "src/application/apply-dispatch.ts",
      "src/application/apply-factory.ts",
      "src/domain/dispatch-readiness.ts",
      "src/domain/worker-lifecycle.ts",
    ],
  },
];

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

interface Boundary {
  readonly allowList: readonly string[];
  readonly quarantine: readonly Quarantined[];
}

/** One file outside the allow-list and what it names that it may not. */
interface Violation {
  readonly path: string;
  readonly names: readonly string[];
}

const allowed = (boundary: Boundary, path: string) =>
  boundary.allowList.some((entry) => new Glob(entry).match(path));

const global = (pattern: RegExp) => new RegExp(pattern.source, "g");

const behaviorIn = (text: string) =>
  BEHAVIOR.filter((token) => token.pattern.test(text)).map((token) => token.name);

/**
 * What `file` names that it may not: a quarantined name outside the files it is quarantined
 * to, then any behavior its text names once the quarantined names it may use are blanked out.
 */
function namedIn(boundary: Boundary, file: SourceFile): readonly string[] {
  let text = file.text;
  const spread: string[] = [];
  for (const entry of boundary.quarantine) {
    if (!entry.pattern.test(text)) continue;
    if (entry.files.includes(file.path)) text = text.replace(global(entry.pattern), " ");
    else spread.push(`${entry.name} (quarantined for #93)`);
  }
  return [...spread, ...behaviorIn(text)];
}

/** Every file outside the allow-list naming Paseo's behavior, or a quarantined name it may not. */
function violations(boundary: Boundary, files: readonly SourceFile[]): readonly Violation[] {
  return files
    .filter((file) => !allowed(boundary, file.path))
    .map((file) => ({ path: file.path, names: namedIn(boundary, file) }))
    .filter((violation) => violation.names.length > 0);
}

/**
 * Entries no longer needed: an allow-list entry matching no file that names Paseo's behavior,
 * a quarantined name a listed file no longer uses, and a quarantined file that is allow-listed.
 */
function stale(boundary: Boundary, files: readonly SourceFile[]): readonly string[] {
  const naming = files.filter((file) => behaviorIn(file.text).length > 0);
  const text = new Map(files.map((file) => [file.path, file.text]));
  return [
    ...boundary.allowList
      .filter((entry) => !naming.some((file) => new Glob(entry).match(file.path)))
      .map((entry) => `allow-list: ${entry} names no Paseo behavior`),
    ...boundary.quarantine.flatMap((entry) =>
      entry.files
        .filter((path) => allowed(boundary, path) || !entry.pattern.test(text.get(path) ?? ""))
        .map((path) => `quarantine: ${path} no longer needs ${entry.name}`),
    ),
  ];
}

/** Every file under the scanned roots but CLAUDE.md, by its repository path. */
async function scanned(): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  for (const root of SCANNED)
    for await (const name of new Glob("**/*").scan({ cwd: join(ROOT, root), dot: true }))
      if (!name.endsWith("CLAUDE.md"))
        files.push({
          path: `${root}/${name}`,
          text: await readFile(join(ROOT, root, name), "utf8"),
        });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const REPOSITORY: Boundary = { allowList: ALLOW_LIST, quarantine: QUARANTINE };

describe("the execution-backend boundary in this repository", () => {
  test("only the allow-listed files name Paseo's behavior", async () => {
    expect(violations(REPOSITORY, await scanned())).toEqual([]);
  });

  test("every allow-list and quarantine entry is still needed", async () => {
    expect(stale(REPOSITORY, await scanned())).toEqual([]);
  });
});

const FIXTURE: Boundary = {
  allowList: ["src/host/paseo-backend.ts", "assets/steps/control-plane/**"],
  quarantine: [
    { name: "PASEO_CLIENTS", pattern: /\bPASEO_CLIENTS\b/, files: ["src/domain/readiness.ts"] },
  ],
};
const file = (path: string, text: string): SourceFile => ({ path, text });

describe("the boundary's rules", () => {
  test.each([
    ["the Paseo CLI", '"$paseo" schedule ls --json'],
    ["the Paseo CLI", "ExecStart=/home/factory/.local/bin/paseo daemon run"],
    ["the Paseo CLI", 'import type { PaseoCommand } from "./control-plane";'],
    ["the Paseo CLI", "readonly paseo: PaseoCommand;"],
    ["the Paseo CLI", 'const argv = ["paseo", "run", "--no-wait"];'],
    ["the Paseo CLI", 'execFile("paseo", ["ls"]);'],
    ["the Paseo CLI", 'spawn(["/home/factory/.local/bin/paseo", "ls"]);'],
    ["the Paseo CLI", 'rows = command_json(PASEO, "ls", "--global")'],
    ["the Paseo CLI", "paseo send agent-1 'carry on'"],
    ["the Paseo CLI", 'spawn("paseo", ["permit", "allow", "agent-1"]);'],
    ["the Paseo CLI", "const runs = await paseoRuns(paseo, work);"],
    ["the Paseo CLI", "const cli = paseoCli(system);"],
    ["the Paseo CLI", "paseo --json ls"],
    ["the Paseo CLI", "paseo -o json ls"],
    ["the Paseo CLI", "paseo --host=worker:6000 -q agent ls"],
    ["the Paseo CLI", 'const argv = ["paseo", "--json", "ls"];'],
    ["the Paseo CLI", 'const argv = ["paseo", "-o", "json", "ls"];'],
    ["the Paseo CLI", 'execFile("paseo", ["--host", "worker", "--no-color", "ls"]);'],
    ["the Paseo CLI", '"$PASEO" ls'],
    ["the Paseo CLI", "$PASEO ls"],
    ["the Paseo CLI", '"${PASEO}" schedule ls'],
    ["the Paseo CLI", '"$PASEO" --format json ls'],
    ["the Paseo CLI", 'await paseo(["project", "ls", "--json"]);'],
    ["Paseo's paths", 'const ROOT = "/home/factory/.paseo/worktrees";'],
    ["Paseo's environment", 'env.pop("PASEO_AGENT_ID", None)'],
    ["Paseo's port", "curl http://worker:6767/api/health"],
    ["Paseo's unit", '["/usr/bin/systemctl", "restart", "paseo.service"]'],
    ["Paseo's package", "npm install --global @getpaseo/cli@0.15.0"],
    ["Paseo's auth wrapper", '"steps/control-plane/paseo-auth.sh"'],
  ])("%s outside the allow-list fails, naming it: %s", (name, text) => {
    expect(violations(FIXTURE, [file("src/host/new-backend.ts", text)])).toEqual([
      { path: "src/host/new-backend.ts", names: [name] },
    ]);
  });

  test("an allow-listed file may name any of it, by path or glob", () => {
    const text = 'paseo run --no-wait; PASEO_HOME=~/.paseo; ":6767"; paseo.service';
    expect(
      violations(FIXTURE, [
        file("src/host/paseo-backend.ts", text),
        file("assets/steps/control-plane/tests/test_paseo_auth.py", text),
      ]),
    ).toEqual([]);
  });

  test("the word Paseo in prose and the backend's name are not behavior", () => {
    const text = [
      'reason: "Paseo reload failed"; export const EXECUTION_BACKENDS = ["paseo"];',
      'return repositoryRegistration("paseo", []);',
      'repositoryRegistration("paseo", checkouts.map(failed));',
      '{ "runtime": "paseo",\n  "status": "ok" }',
      "{'backend': 'paseo', 'logs': []}",
    ].join("\n");
    expect(violations(FIXTURE, [file("src/domain/repository-registration.ts", text)])).toEqual([]);
  });

  test("a long run of root options with no command is not a run, and the run after it is", () => {
    // Read in linear time: a backtracking pattern hits the engine's limit and misses the run.
    const options = `paseo${" -x".repeat(40)}`;
    expect(violations(FIXTURE, [file("src/domain/options.ts", options)])).toEqual([]);
    expect(violations(FIXTURE, [file("src/domain/options.ts", `${options}\npaseo ls`)])).toEqual([
      { path: "src/domain/options.ts", names: ["the Paseo CLI"] },
    ]);
  });

  test("a quarantined name passes in its own files, and behavior beside it still fails", () => {
    expect(
      violations(FIXTURE, [
        file("src/domain/readiness.ts", "export const PASEO_CLIENTS = 1;"),
        file("src/cli/presentation/apply.ts", "import { PASEO_CLIENTS } from 'x'; PASEO_HOME"),
      ]),
    ).toEqual([
      {
        path: "src/cli/presentation/apply.ts",
        names: ["PASEO_CLIENTS (quarantined for #93)", "Paseo's environment"],
      },
    ]);
    expect(
      violations(FIXTURE, [file("src/domain/readiness.ts", "PASEO_CLIENTS; PASEO_HOME")]),
    ).toEqual([{ path: "src/domain/readiness.ts", names: ["Paseo's environment"] }]);
  });

  test("an entry no longer needed is stale", () => {
    expect(
      stale(FIXTURE, [
        file("src/host/paseo-backend.ts", "nothing of Paseo's"),
        file("assets/steps/control-plane/setup-host.sh", "PASEO_VERSION=0.15.0"),
        file("src/domain/readiness.ts", "export const CLIENTS = 1;"),
      ]),
    ).toEqual([
      "allow-list: src/host/paseo-backend.ts names no Paseo behavior",
      "quarantine: src/domain/readiness.ts no longer needs PASEO_CLIENTS",
    ]);
    expect(
      stale({ ...FIXTURE, allowList: [...FIXTURE.allowList, "src/domain/readiness.ts"] }, [
        file("src/host/paseo-backend.ts", "PaseoCommand"),
        file("assets/steps/control-plane/setup-host.sh", "PASEO_VERSION=0.15.0"),
        file("src/domain/readiness.ts", "PASEO_CLIENTS; PASEO_HOME"),
      ]),
    ).toEqual(["quarantine: src/domain/readiness.ts no longer needs PASEO_CLIENTS"]);
  });
});
