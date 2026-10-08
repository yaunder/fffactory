/**
 * The wrapped install steps in `assets/steps/` (host protocol §apply), checked statically:
 * `bun test` never runs them, since they install packages from the network as root. CI
 * shellchecks them; `tests/bootstrap/host-apply.test.sh` runs `host apply` over stand-ins.
 */
import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { INSTALL_STEPS } from "../../../src/domain/installation";

const ROOT = join(import.meta.dir, "../../..");
const STEPS = join(ROOT, "assets/steps");
const SCRIPTS = (await readdir(STEPS)).filter((name) => name.endsWith(".sh")).sort();
const CONTROL_PLANE = join(STEPS, "control-plane");
const CONTROL_PLANE_SCRIPTS = ["paseo-auth.sh", "paseo-config.sh", "setup-host.sh"];
const DISPATCH_RUNTIME = [
  "assets/steps/dispatch/factory-dispatch",
  "assets/steps/dispatch/dispatch-schedule.sh",
  "assets/steps/repositories/sync-repositories.sh",
];

/**
 * Everything on the worker path, from the CLI's workers stage to the steps: none of it may
 * use, or so much as name, SSM. CLAUDE.md files are documentation that never ships.
 */
const code = (names: string[]) => names.filter((name) => name !== "CLAUDE.md");
const WORKER_PATH = [
  "src/application/apply-workers.ts",
  "src/application/host-transport.ts",
  "src/infrastructure/ssh-transport.ts",
  "src/domain/host-protocol.ts",
  "src/domain/host-projection.ts",
  "src/domain/installation.ts",
  "src/domain/readiness.ts",
  "src/domain/rollout.ts",
  "src/application/apply-repositories.ts",
  "src/domain/repository-placement.ts",
  "src/application/apply-control-plane.ts",
  "src/application/control-plane.ts",
  "src/infrastructure/paseo-control-plane.ts",
  "src/domain/change-classification.ts",
  "src/application/apply-dispatch.ts",
  "src/application/verify-factory.ts",
  "src/application/workflow-queue.ts",
  "src/infrastructure/ffflow-github-workflow-queue.ts",
  "src/domain/dispatch-readiness.ts",
  ...code(await readdir(join(ROOT, "src/host"))).map((name) => `src/host/${name}`),
  // The steps directory, including the wrapped repository scripts in `repositories/`.
  ...(await readdir(STEPS, { recursive: true }))
    .filter((name) => name.endsWith(".sh"))
    .map((name) => `assets/steps/${name}`),
];

describe("the install steps", () => {
  test("are one script per install step, in the release's steps directory, plus the validator", () => {
    expect(SCRIPTS).toEqual(
      [...INSTALL_STEPS.map(({ name }) => `${name}.sh`), "validate-plugins.sh"].sort(),
    );
  });

  test("are bash that parses, and executable", async () => {
    for (const script of SCRIPTS) {
      const path = join(STEPS, script);
      const parsed = Bun.spawnSync(["bash", "-n", path], { stderr: "pipe" });
      expect({ script, exitCode: parsed.exitCode }).toEqual({ script, exitCode: 0 });
      expect((await stat(path)).mode & 0o111).toBe(0o111);
      expect(await readFile(path, "utf8")).toStartWith("#!/usr/bin/env bash\n");
    }
  });

  test("never poll for a marker file or read v1's deployed inputs", async () => {
    for (const script of SCRIPTS) {
      const text = await readFile(join(STEPS, script), "utf8");
      expect({ script, sleeps: /\bsleep\b/.test(text) }).toEqual({ script, sleeps: false });
      expect({ script, markers: /-complete\b/.test(text) }).toEqual({ script, markers: false });
      expect({
        script,
        v1: /software-factory\/agent-harness|\/var\/lib\/factory\b/.test(text),
      }).toEqual({
        script,
        v1: false,
      });
    }
  });

  test("steps that still need jq say when that is re-evaluated", async () => {
    for (const script of SCRIPTS) {
      const text = await readFile(join(STEPS, script), "utf8");
      if (/\bjq\b/.test(text.replace(/dnf install[^\n]*(\n {2}[^\n]*)*/g, "")))
        expect({
          script,
          marked: /TODO\(re-evaluate when [^)]+\): [^\n]*without jq/.test(text),
        }).toEqual({
          script,
          marked: true,
        });
    }
  });
});

describe("the release-owned Paseo programs", () => {
  test("are executable bash and carry no v1 deployment or marker assumptions", async () => {
    for (const script of CONTROL_PLANE_SCRIPTS) {
      const path = join(CONTROL_PLANE, script);
      const text = await readFile(path, "utf8");
      expect(Bun.spawnSync(["bash", "-n", path]).exitCode).toBe(0);
      expect((await stat(path)).mode & 0o111).toBe(0o111);
      expect(text).not.toMatch(/\/var\/lib\/factory\b|\/usr\/local\/share\/software-factory/);
      expect(text).not.toMatch(/agent-harness-complete|control-plane-complete/);
    }
  });

  test("installs from the active release and leaves daemon lifecycle to the classified action", async () => {
    const setup = await readFile(join(CONTROL_PLANE, "setup-host.sh"), "utf8");
    expect(setup).toMatch(/\$\{script_dir\}\/versions\.env/);
    expect(setup).toMatch(/\$\{script_dir\}\/paseo\.service/);
    expect(setup).not.toContain("/usr/local/libexec/paseo-auth");
    expect(setup).not.toMatch(/systemctl (start|restart)/);
    expect(setup).not.toContain("factory-dispatch");
    const service = await readFile(join(CONTROL_PLANE, "paseo.service"), "utf8");
    expect(service).toContain(
      "ExecStart=/opt/fffactory/current/steps/control-plane/paseo-auth.sh daemon run",
    );
  });

  /**
   * `tests/test_paseo_config.py` runs the config merge itself; this checks only that setup
   * resolves its inputs on the worker and hands them to it, as `factory`, without merging itself.
   */
  test("setup resolves the worker's addresses and leaves the config merge to paseo-config.sh", async () => {
    const setup = await readFile(join(CONTROL_PLANE, "setup-host.sh"), "utf8");
    expect(setup).toContain("tailscale ip -4");
    expect(setup).toMatch(/tailscale status --json[^\n]*\.Self\.DNSName[^\n]*rtrimstr\("\."\)/);
    expect(setup).toContain("hostname --short");
    expect(setup).toMatch(/\[\[ -n \$\{tailscale_dns\} \]\] \|\| fail/);
    const merge =
      setup.match(/factory_command (?:[^\n]*\\\n)*[^\n]*paseo-config\.sh[^\n]*/)?.[0] ?? "";
    expect(merge).toContain('FACTORY_PASEO_LISTEN="${tailscale_ipv4}:6767"');
    expect(merge).toContain('FACTORY_PASEO_HOSTNAMES="${short_hostname} ${tailscale_dns}"');
    expect(merge).toContain('"${script_dir}/paseo-config.sh"');
    expect(setup).not.toMatch(/\.daemon\.(listen|relay|hostnames)/);
  });
});

describe("the release-owned dispatch path", () => {
  test("uses v2 state and active-release programs, never removed v1 paths or global wrappers", async () => {
    for (const path of DISPATCH_RUNTIME) {
      const text = await readFile(join(ROOT, path), "utf8");
      expect(text).not.toMatch(/\/usr\/local\/share\/software-factory|\/var\/lib\/factory\b/);
      expect(text).not.toMatch(/\b(check-factory-ffflow-adoption|factory-paseo)\b/);
    }
    const dispatcher = await readFile(join(ROOT, "assets/steps/dispatch/factory-dispatch"), "utf8");
    expect(dispatcher).not.toMatch(/\bsync-factory-repositories\b/);
    expect(dispatcher).not.toContain("origin/main");
  });
});

describe("no SSM in the worker path", () => {
  test("nothing from the workers stage to the steps names SSM or Session Manager", async () => {
    for (const path of WORKER_PATH) {
      const text = await readFile(join(ROOT, path), "utf8");
      expect({ path, ssm: /\bssm\b|state manager|session manager/i.test(text) }).toEqual({
        path,
        ssm: false,
      });
    }
  });
});

describe("the pins and the plugin manifest", () => {
  test("the manifest passes the plugins step's own validator", () => {
    const validated = Bun.spawnSync(
      ["bash", join(STEPS, "validate-plugins.sh"), join(STEPS, "plugins.json")],
      { stderr: "pipe" },
    );
    expect(validated.exitCode).toBe(0);
  });
});
