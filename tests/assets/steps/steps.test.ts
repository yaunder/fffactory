/**
 * The wrapped install steps in `assets/steps/` (host protocol §apply), checked statically:
 * `bun test` never runs them, since they install packages from the network as root. CI
 * shellchecks them; `tests/bootstrap/host-apply.test.sh` runs `host apply` over stand-ins.
 */
import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pluginPins } from "../../../src/host/plugin-manifest";
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
  "src/application/stop-dispatch.ts",
  "src/application/verify-factory.ts",
  "src/application/workflow-queue.ts",
  "src/infrastructure/ffflow-github-workflow-queue.ts",
  "src/domain/dispatch-readiness.ts",
  "src/domain/dispatch-projection.ts",
  ...code(await readdir(join(ROOT, "src/host"))).map((name) => `src/host/${name}`),
  // The steps directory, including the wrapped repository scripts in `repositories/`.
  ...(await readdir(STEPS, { recursive: true }))
    .filter((name) => name.endsWith(".sh"))
    .map((name) => `assets/steps/${name}`),
];

describe("the install steps", () => {
  test("are one script per shell install step, in the release's steps directory", () => {
    expect(SCRIPTS).toEqual(
      INSTALL_STEPS.filter((step) => !("implementation" in step))
        .map(({ name }) => `${name}.sh`)
        .sort(),
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

/**
 * `packages.sh`'s upstream build tools (host protocol §apply, the `packages` row): each is
 * downloaded only from its pinned URL, checked against its pinned sha256 before anything is
 * extracted or installed, installed into /usr/local/bin, and skipped when it already reports
 * its pin. The real download needs network and root, so it is checked statically.
 */
describe("packages.sh's pinned tools", async () => {
  const text = await readFile(join(STEPS, "packages.sh"), "utf8");
  const joined = text.replace(/ *\\\n\s*/g, " ");
  const pin = (name: string) => text.match(new RegExp(`^readonly ${name}="([^"]*)"$`, "m"))?.[1];
  const installer = joined.match(/^install_verified_binary\(\) \{\n[\s\S]*?\n\}\n/m)?.[0] ?? "";
  const calls = joined
    .split("\n")
    .filter((line) => line.startsWith("install_verified_binary "))
    .map((line) => line.trim());
  const position = (pattern: RegExp) => installer.search(pattern);

  test("pins just and pnpm, as ripgrep, to an exact version and a sha256", () => {
    for (const tool of ["RIPGREP", "JUST", "PNPM"]) {
      expect({ tool, version: pin(`${tool}_VERSION`) }).toEqual({
        tool,
        version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      });
      expect({ tool, sha256: pin(`${tool}_SHA256`) }).toEqual({
        tool,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }
  });

  test("installs ripgrep, just and pnpm into /usr/local/bin through the one checked installer, from their pinned upstream URLs", () => {
    expect(calls).toEqual([
      'install_verified_binary rg "ripgrep ${RIPGREP_VERSION}" "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz" "${RIPGREP_SHA256}" "ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl/rg"',
      'install_verified_binary just "just ${JUST_VERSION}" "https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-x86_64-unknown-linux-musl.tar.gz" "${JUST_SHA256}" just',
      'install_verified_binary pnpm "${PNPM_VERSION}" "https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-${PNPM_VERSION}.tgz" "${PNPM_SHA256}" package/pnpm',
    ]);
    expect(installer).toContain('local destination="/usr/local/bin/${name}"');
    expect(installer).toMatch(
      /\n\s*install -o root -g root -m 0755 "\$\{work\}\/\$\{member\}" "\$\{destination\}"\n/,
    );
  });

  test("downloads nothing else, and installs nothing it has not checked", () => {
    expect(
      text.match(/https:\/\/[^\s"]+/g)?.filter((url) => !calls.join("\n").includes(url)),
    ).toEqual(["https://cli.github.com/packages/rpm/gh-cli.repo"]);
    expect(text.match(/\bcurl\b/g)).toHaveLength(1);
    expect(text.match(/\binstall -o\b/g)).toHaveLength(1);
    expect(installer).toMatch(
      /\bcurl --fail [^\n]*"\$\{url\}" --output "\$\{work\}\/\$\{archive\}"/,
    );
    const checked = position(
      /\|\s*\(cd "\$\{work\}" && sha256sum --check --status\)\s*\|\|\s*fail /,
    );
    expect(installer).toMatch(/printf '%s {2}%s\\n' "\$\{sha256\}" "\$\{archive\}"/);
    expect(position(/\bcurl\b/)).toBeGreaterThan(-1);
    expect(checked).toBeGreaterThan(position(/\bcurl\b/));
    expect(position(/\btar --extract\b/)).toBeGreaterThan(checked);
    expect(position(/\binstall -o\b/)).toBeGreaterThan(checked);
  });

  test("skips a tool whose --version already reports its pin", () => {
    const skip = position(
      /current="\$\("\$\{destination\}" --version 2>\/dev\/null \| head -n 1\)"[^\n]*\n\s*if \[\[ \$\{current\} == "\$\{reported\}" \|\| \$\{current\} == "\$\{reported\} "\* \]\]; then/,
    );
    expect(skip).toBeGreaterThan(-1);
    expect(position(/\n\s*return 0\n/)).toBeGreaterThan(skip);
    expect(position(/\bcurl\b/)).toBeGreaterThan(position(/\n\s*return 0\n/));
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
  });

  /**
   * The daemon authenticates against the bcrypt hash setup merged into config.json, so it never
   * holds `PASEO_PASSWORD`, which every agent, tool and hook it launches would inherit.
   */
  test("the unit starts the daemon directly, without the password, and only with a stored hash", async () => {
    const service = await readFile(join(CONTROL_PLANE, "paseo.service"), "utf8");
    const exec = service.split("\n").filter((line) => line.startsWith("ExecStart"));
    expect(exec).toEqual([
      'ExecStartPre=/usr/bin/jq --exit-status ".daemon.auth.password | strings | length > 0" /home/factory/.paseo/config.json',
      "ExecStart=/home/factory/.local/bin/paseo daemon run --home /home/factory/.paseo",
    ]);
    const settings = service.split("\n").filter((line) => !line.startsWith("#"));
    expect(settings.join("\n")).not.toMatch(
      /paseo-auth|PASEO_PASSWORD|EnvironmentFile|PassEnvironment/,
    );
  });

  test("setup hands paseo-config.sh the hash it reads after the reference, never as an argument", async () => {
    const setup = await readFile(join(CONTROL_PLANE, "setup-host.sh"), "utf8");
    expect(setup).toMatch(
      /IFS= read -r paseo_secret_arn \|\| true\nIFS= read -r paseo_password_hash \|\| true\n/,
    );
    const merge =
      setup.match(/\n[^\n]*factory_command (?:[^\n]*\\\n)*[^\n]*paseo-config\.sh[^\n]*/)?.[0] ?? "";
    expect(merge).toMatch(/^\nprintf '%s\\n' "\$\{paseo_password_hash\}" \| factory_command /);
    expect(merge).toContain("IFS= read -r FACTORY_PASEO_PASSWORD_HASH");
    expect(merge).not.toMatch(/FACTORY_PASEO_PASSWORD_HASH=/);
    expect(setup.match(/password_hash/g)?.length).toBe(
      setup.match(/\$\{paseo_password_hash\}|read -r paseo_password_hash/g)?.length,
    );
    expect(setup).not.toMatch(/PASEO_PASSWORD\b|get-secret-value/);
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
  test("the manifest passes the plugins step's own validator", async () => {
    expect(
      pluginPins(JSON.parse(await readFile(join(STEPS, "plugins.json"), "utf8"))),
    ).toHaveLength(1);
  });
});
