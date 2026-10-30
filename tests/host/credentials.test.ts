/**
 * The `credentials` install step (credential delivery, host protocol §apply) over a worker laid
 * out in a temporary directory, with every command answered by a scripted runner: Secrets
 * Manager through a stand-in `aws`, and `gh`, `codex` and the file tools as `factory`. Nothing
 * runs as another user or reaches a network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCredentials, HostLogArchive } from "../../src/domain/host-projection";
import {
  ANTHROPIC_KEY_FILE,
  ANTHROPIC_KEY_HELPER,
  CLAUDE_MANAGED_SETTINGS,
  claudeManagedSettingsJson,
  CREDENTIAL_COMMAND_TIMEOUT_MS,
  CREDENTIAL_LOGIN_TIMEOUT_MS,
} from "../../src/domain/installation";
import type { SecretReference } from "../../src/domain/instance";
import { workerCredentials } from "../../src/host/credentials";
import { AS_FACTORY } from "../../src/host/runtime-account";
import type {
  ProcessOptions,
  ProcessOutcome,
  ProcessRunner,
} from "../../src/infrastructure/local-tool-probe";
import { system } from "./worker-scenarios";

const ARN = (name: string) =>
  `arn:aws:secretsmanager:eu-west-2:123456789012:secret:fff-aaaa1111/${name}-AbCdEf` as SecretReference;
const GITHUB_ARN = ARN("github-token");
const ANTHROPIC_ARN = ARN("anthropic-api-key");
const OPENAI_ARN = ARN("openai-api-key");
const ALL: HostCredentials = {
  github_token_secret: GITHUB_ARN,
  anthropic_api_key_secret: ANTHROPIC_ARN,
  openai_api_key_secret: OPENAI_ARN,
};
const GITHUB_TOKEN = "ghp_SECRETgithubTOKEN0123456789";
const ANTHROPIC_KEY = "sk-ant-api03-SECRETanthropicKEY";
const OPENAI_KEY = "sk-proj-SECRETopenaiKEY0123456789";
const MATERIAL = [GITHUB_TOKEN, ANTHROPIC_KEY, OPENAI_KEY];
const BUDGET_MS = 10 * 60_000;
const ARCHIVE: HostLogArchive = {
  bucket: "fff-aaaa1111-logs-123456789012-eu-west-2-an",
  region: "eu-west-2",
};
/** The managed settings' text for what fffactory needs. */
const composed = (keyHelper: boolean, keepHistory: boolean) =>
  claudeManagedSettingsJson({ keyHelper, keepHistory }) ?? "";
const HELPER_ONLY = composed(true, false);
const KEEPS_HISTORY = "log_archive: Claude Code keeps its history (cleanupPeriodDays 3650)";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fffactory-credentials-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exited = (exitCode: number, stdout = "", stderr = ""): ProcessOutcome => ({
  kind: "exited",
  exitCode,
  stdout,
  stderr,
});

interface Call {
  readonly argv: readonly string[];
  readonly asFactory: boolean;
  /** The command without `AS_FACTORY` and directories, as the tests name it. */
  readonly command: string;
  readonly timeoutMs: number;
  readonly options: ProcessOptions | undefined;
  readonly stdin: string | undefined;
}

/** A call as the tests see it. */
function recorded(
  argv: readonly string[],
  timeoutMs: number,
  options: ProcessOptions | undefined,
): Call {
  const asFactory = AS_FACTORY.every((token, index) => argv[index] === token);
  const command = (asFactory ? argv.slice(AS_FACTORY.length) : argv)
    .map((token) => token.split("/").at(-1))
    .join(" ");
  const stdin = options?.stdin === undefined ? undefined : new TextDecoder().decode(options.stdin);
  return { argv, asFactory, command, timeoutMs, options, stdin };
}

/** gh's account list on github.com, as `gh auth status --json hosts` prints it. */
function accounts(...logins: readonly [string, boolean][]): string {
  return JSON.stringify({
    hosts: {
      "github.com": logins.map(([login, active]) => ({
        state: "success",
        active,
        host: "github.com",
        login,
        tokenSource: "/home/factory/.config/gh/hosts.yml",
        gitProtocol: "https",
      })),
    },
  });
}

/**
 * A worker whose Secrets Manager holds the three credentials and whose tools succeed, unless
 * `answers` says otherwise for a command (by its name as the tests write it, or an ARN).
 */
function worker(answers: Record<string, ProcessOutcome> = {}) {
  const calls: Call[] = [];
  const secrets: Record<string, ProcessOutcome> = {
    [GITHUB_ARN]: exited(0, `${JSON.stringify(GITHUB_TOKEN)}\n`),
    [ANTHROPIC_ARN]: exited(0, `${JSON.stringify(ANTHROPIC_KEY)}\n`),
    [OPENAI_ARN]: exited(0, `${JSON.stringify(OPENAI_KEY)}\n`),
  };
  const defaults: Record<string, ProcessOutcome> = {
    ...secrets,
    "gh auth status --hostname github.com --json hosts": exited(0, accounts(["octocat", true])),
  };
  const run: ProcessRunner = async (argv, timeoutMs, options) => {
    const call = recorded(argv, timeoutMs, options);
    calls.push(call);
    const key =
      argv[0] === "/usr/bin/aws" ? (argv[argv.indexOf("--secret-id") + 1] ?? "") : call.command;
    return answers[key] ?? defaults[key] ?? exited(argv[0] === "/usr/bin/aws" ? 254 : 0);
  };
  const lines: string[] = [];
  const deliver = (
    credentials: HostCredentials | undefined,
    budgetMs = BUDGET_MS,
    logArchive?: HostLogArchive,
  ) =>
    workerCredentials(
      system(root, { run }),
      {
        ...(credentials === undefined ? {} : { credentials }),
        ...(logArchive === undefined ? {} : { log_archive: logArchive }),
      },
      budgetMs,
      async (line) => {
        lines.push(line);
      },
    );
  return {
    calls,
    lines,
    deliver,
    tools: () => calls.filter((call) => call.argv[0] !== "/usr/bin/aws"),
  };
}

const keyFile = () => join(root, ANTHROPIC_KEY_FILE);
const settings = () => join(root, CLAUDE_MANAGED_SETTINGS);

/** Everything a call exposes to other processes or the log: its arguments and environment. */
function exposed(calls: readonly Call[], lines: readonly string[]): string {
  return [
    ...calls.flatMap(({ argv, options }) => [...argv, ...Object.values(options?.env ?? {})]),
    ...lines,
  ].join("\n");
}

describe("delivery of every configured account (credential delivery §Recipes)", () => {
  test("reads each secret by its ARN with the instance role, in the factory Region", async () => {
    const { calls, deliver } = worker();
    expect(await deliver(ALL)).toBeUndefined();
    const reads = calls.filter(({ argv }) => argv[0] === "/usr/bin/aws");
    expect(reads.map(({ argv }) => argv)).toEqual(
      [GITHUB_ARN, OPENAI_ARN, ANTHROPIC_ARN].map((arn) => [
        "/usr/bin/aws",
        "secretsmanager",
        "get-secret-value",
        "--region",
        "eu-west-2",
        "--secret-id",
        arn,
        "--query",
        "SecretString",
        "--output",
        "json",
      ]),
    );
    for (const read of reads) {
      expect(read.asFactory).toBe(false);
      expect(read.timeoutMs).toBe(CREDENTIAL_COMMAND_TIMEOUT_MS);
      expect(read.options?.env).toEqual({
        PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/root",
        LANG: "C.UTF-8",
        AWS_PAGER: "",
      });
      expect(read.options?.output).toBeUndefined();
    }
  });

  test("logs GitHub in as factory with the token on standard input, then sets up Git", async () => {
    const { tools, deliver } = worker();
    expect(await deliver({ github_token_secret: GITHUB_ARN })).toBeUndefined();
    const calls = tools();
    expect(calls.map(({ command, asFactory }) => [command, asFactory])).toEqual([
      [
        "gh auth login --with-token --hostname github.com --git-protocol https --insecure-storage",
        true,
      ],
      ["gh auth setup-git --hostname github.com", true],
      ["gh auth status --hostname github.com --json hosts", true],
      // Anthropic is not delivered: fffactory's key file goes.
      [`rm -f -- anthropic-api-key`, true],
    ]);
    expect(calls[0]?.stdin).toBe(GITHUB_TOKEN);
    expect(calls[0]?.timeoutMs).toBe(CREDENTIAL_LOGIN_TIMEOUT_MS);
    expect(calls.slice(1).map(({ timeoutMs }) => timeoutMs)).toEqual([
      CREDENTIAL_COMMAND_TIMEOUT_MS,
      CREDENTIAL_COMMAND_TIMEOUT_MS,
      CREDENTIAL_COMMAND_TIMEOUT_MS,
    ]);
    expect(calls.slice(1).every(({ stdin }) => stdin === undefined)).toBe(true);
  });

  test("logs out every other github.com account, so the configured one alone remains", async () => {
    const { tools, deliver } = worker({
      "gh auth status --hostname github.com --json hosts": exited(
        0,
        accounts(["factory-bot", true], ["octocat", false], ["someone-else", false]),
      ),
    });
    expect(await deliver({ github_token_secret: GITHUB_ARN })).toBeUndefined();
    expect(
      tools()
        .map(({ command }) => command)
        .filter((command) => command.startsWith("gh auth logout")),
    ).toEqual([
      "gh auth logout --hostname github.com --user octocat",
      "gh auth logout --hostname github.com --user someone-else",
    ]);
  });

  test("an Enterprise Managed User's login, with its underscore, stays or is logged out", async () => {
    const logouts = async (...logins: [string, boolean][]) => {
      const { tools, deliver } = worker({
        "gh auth status --hostname github.com --json hosts": exited(0, accounts(...logins)),
      });
      expect(await deliver({ github_token_secret: GITHUB_ARN })).toBeUndefined();
      return tools()
        .map(({ command }) => command)
        .filter((command) => command.startsWith("gh auth logout"));
    };
    expect(await logouts(["factory-bot_acme", true])).toEqual([]);
    expect(await logouts(["factory-bot", true], ["octo_cat", false], ["mona_acme", false])).toEqual(
      [
        "gh auth logout --hostname github.com --user octo_cat",
        "gh auth logout --hostname github.com --user mona_acme",
      ],
    );
  });

  test("logs Codex in as factory with the key on standard input", async () => {
    const { tools, deliver } = worker();
    expect(await deliver({ openai_api_key_secret: OPENAI_ARN })).toBeUndefined();
    const login = tools().find(({ command }) => command.startsWith("codex"));
    expect(login?.command).toBe("codex login --with-api-key");
    expect(login?.asFactory).toBe(true);
    expect(login?.stdin).toBe(OPENAI_KEY);
    expect(login?.timeoutMs).toBe(CREDENTIAL_LOGIN_TIMEOUT_MS);
  });

  test("writes the Anthropic key as factory, then Claude Code's root-owned helper", async () => {
    const { tools, deliver } = worker();
    expect(await deliver({ anthropic_api_key_secret: ANTHROPIC_ARN })).toBeUndefined();
    const calls = tools();
    const staging = `${keyFile()}.new`;
    expect(calls.map(({ argv }) => argv.slice(AS_FACTORY.length))).toEqual([
      ["/usr/bin/install", "-d", "-m", "0700", join(root, "/home/factory/.config/fffactory")],
      // An empty private file first, then `dd` fills it from its own standard input: as factory,
      // reopening a root-made pipe through /dev/stdin is refused.
      ["/usr/bin/install", "-m", "0600", "/dev/null", staging],
      ["/usr/bin/dd", `of=${staging}`, "status=none"],
      ["/usr/bin/mv", "-fT", "--", staging, keyFile()],
    ]);
    expect(calls.every(({ asFactory }) => asFactory)).toBe(true);
    expect(calls.filter(({ stdin }) => stdin !== undefined).map(({ command }) => command)).toEqual([
      "dd anthropic-api-key.new status=none",
    ]);
    expect(calls[2]?.stdin).toBe(ANTHROPIC_KEY);
    expect(JSON.parse(await readFile(settings(), "utf8"))).toEqual({
      apiKeyHelper: `cat ${ANTHROPIC_KEY_FILE}`,
    });
    expect(ANTHROPIC_KEY_HELPER).toBe(`cat ${ANTHROPIC_KEY_FILE}`);
    expect((await stat(settings())).mode & 0o777).toBe(0o644);
    expect((await stat(join(root, "/etc/claude-code"))).mode & 0o777).toBe(0o755);
  });

  test("delivers GitHub, then OpenAI, then Anthropic, and logs each in its own words", async () => {
    const { tools, lines, deliver } = worker();
    expect(await deliver(ALL)).toBeUndefined();
    const order = tools().map(({ command }) => command.split(" ")[0]);
    expect(order.indexOf("codex")).toBeGreaterThan(order.lastIndexOf("gh"));
    expect(order.indexOf("install")).toBeGreaterThan(order.indexOf("codex"));
    expect(lines).toEqual(["github: delivered", "openai: delivered", "anthropic: delivered"]);
  });

  test("material reaches only the delivering commands' standard input", async () => {
    const { calls, lines, deliver } = worker();
    expect(await deliver(ALL)).toBeUndefined();
    const text = exposed(calls, lines);
    for (const material of MATERIAL) expect(text).not.toContain(material);
    expect(calls.filter(({ stdin }) => stdin !== undefined).map(({ stdin }) => stdin)).toEqual([
      GITHUB_TOKEN,
      OPENAI_KEY,
      ANTHROPIC_KEY,
    ]);
    // No tool's output goes to the step's log.
    expect(calls.every(({ options }) => options?.output === undefined)).toBe(true);
  });

  test("a rerun issues the same commands and leaves the same files", async () => {
    const first = worker();
    expect(await first.deliver(ALL)).toBeUndefined();
    const written = await readFile(settings(), "utf8");
    const second = worker();
    expect(await second.deliver(ALL)).toBeUndefined();
    expect(second.calls.map(({ argv }) => argv)).toEqual(first.calls.map(({ argv }) => argv));
    expect(await readFile(settings(), "utf8")).toBe(written);
  });
});

describe("accounts not delivered (credential delivery §Removal)", () => {
  const REMOVED = "anthropic: not delivered; Claude Code's managed settings removed";
  const KEY_FILE_REMOVAL = [["rm -f -- anthropic-api-key", true]];

  async function managedSettings(text: string): Promise<void> {
    await mkdir(join(root, "/etc/claude-code"), { recursive: true });
    await writeFile(settings(), text);
  }

  test("GitHub and OpenAI stores are untouched, and fffactory's settings and key file go", async () => {
    for (const text of [
      HELPER_ONLY,
      JSON.stringify({ apiKeyHelper: ANTHROPIC_KEY_HELPER }),
      composed(false, true),
      composed(true, true),
    ]) {
      await managedSettings(text);
      const { calls, lines, deliver } = worker();
      expect(await deliver(undefined)).toBeUndefined();
      expect(calls.map(({ command, asFactory }) => [command, asFactory])).toEqual(KEY_FILE_REMOVAL);
      expect(calls[0]?.argv.at(-1)).toBe(keyFile());
      expect(await Bun.file(settings()).exists()).toBe(false);
      expect(lines).toEqual([REMOVED]);
    }
  });

  test("managed settings that are not fffactory's are kept; its key file goes", async () => {
    for (const text of [
      JSON.stringify({ apiKeyHelper: "/usr/local/bin/org-key" }, null, 2),
      JSON.stringify({ apiKeyHelper: ANTHROPIC_KEY_HELPER, model: "org-model" }),
      JSON.stringify({ cleanupPeriodDays: 30 }),
      JSON.stringify({ permissions: { deny: ["WebFetch"] } }),
      "null",
      "not json",
    ]) {
      await managedSettings(text);
      const { calls, lines, deliver } = worker();
      expect(await deliver(undefined)).toBeUndefined();
      expect(await readFile(settings(), "utf8")).toBe(text);
      expect(calls.map(({ command, asFactory }) => [command, asFactory])).toEqual(KEY_FILE_REMOVAL);
      expect(lines).toEqual([
        "anthropic: not delivered; Claude Code's managed settings kept: they are not fffactory's",
      ]);
    }
  });

  test("managed settings it cannot read are kept", async () => {
    await mkdir(join(settings(), "inside"), { recursive: true });
    const { calls, lines, deliver } = worker();
    expect(await deliver(undefined)).toBeUndefined();
    expect((await stat(join(settings(), "inside"))).isDirectory()).toBe(true);
    expect(calls.map(({ command, asFactory }) => [command, asFactory])).toEqual(KEY_FILE_REMOVAL);
    expect(lines).toEqual([
      "anthropic: not delivered; Claude Code's managed settings kept: they could not be read (EISDIR)",
    ]);
  });

  test("removal is a no-op when nothing was ever delivered", async () => {
    const { calls, lines, deliver } = worker();
    expect(await deliver(undefined)).toBeUndefined();
    expect(await deliver(undefined)).toBeUndefined();
    expect(calls.map(({ command }) => command)).toEqual([
      "rm -f -- anthropic-api-key",
      "rm -f -- anthropic-api-key",
    ]);
    const none = "anthropic: not delivered; no managed settings of fffactory's to remove";
    expect(lines).toEqual([none, none]);
  });

  test("an account delivered alone leaves the others' tools alone", async () => {
    const { tools, deliver } = worker();
    expect(await deliver({ openai_api_key_secret: OPENAI_ARN })).toBeUndefined();
    expect(tools().some(({ command }) => command.startsWith("gh "))).toBe(false);
  });

  test("delivering Anthropic replaces managed settings that were not fffactory's (D5)", async () => {
    await managedSettings(JSON.stringify({ apiKeyHelper: "/usr/local/bin/org-key" }));
    const { deliver } = worker();
    expect(await deliver({ anthropic_api_key_secret: ANTHROPIC_ARN })).toBeUndefined();
    expect(await readFile(settings(), "utf8")).toBe(HELPER_ONLY);
  });
});

describe("Claude Code keeps its history while the log archive is enabled (credential delivery §Managed settings)", () => {
  async function managedSettings(text: string): Promise<void> {
    await mkdir(join(root, "/etc/claude-code"), { recursive: true });
    await writeFile(settings(), text);
  }

  test("with Anthropic delivered, the settings name the helper and keep the history", async () => {
    const { lines, deliver } = worker();
    expect(await deliver(ALL, BUDGET_MS, ARCHIVE)).toBeUndefined();
    expect(await readFile(settings(), "utf8")).toBe(composed(true, true));
    expect(JSON.parse(await readFile(settings(), "utf8"))).toEqual({
      apiKeyHelper: ANTHROPIC_KEY_HELPER,
      cleanupPeriodDays: 3650,
    });
    expect((await stat(settings())).mode & 0o777).toBe(0o644);
    expect(lines).toEqual([
      "github: delivered",
      "openai: delivered",
      "anthropic: delivered",
      KEEPS_HISTORY,
    ]);
  });

  test("without Anthropic, the settings keep the history alone, and the key file goes", async () => {
    await managedSettings(HELPER_ONLY);
    const { calls, lines, deliver } = worker();
    expect(await deliver(undefined, BUDGET_MS, ARCHIVE)).toBeUndefined();
    expect(await readFile(settings(), "utf8")).toBe(composed(false, true));
    expect(JSON.parse(await readFile(settings(), "utf8"))).toEqual({ cleanupPeriodDays: 3650 });
    expect(calls.map(({ command, asFactory }) => [command, asFactory])).toEqual([
      ["rm -f -- anthropic-api-key", true],
    ]);
    expect(lines).toEqual([
      "anthropic: not delivered; Claude Code's managed settings name no API key helper",
      KEEPS_HISTORY,
    ]);
  });

  test("a file fffactory needs replaces others' settings, which it keeps when it needs none", async () => {
    const foreign = JSON.stringify({ apiKeyHelper: "/usr/local/bin/org-key", model: "x" });
    await managedSettings(foreign);
    expect(await worker().deliver(undefined)).toBeUndefined();
    expect(await readFile(settings(), "utf8")).toBe(foreign);
    expect(await worker().deliver(undefined, BUDGET_MS, ARCHIVE)).toBeUndefined();
    expect(await readFile(settings(), "utf8")).toBe(composed(false, true));
  });

  test("turning the archive off drops the history, and with nothing needed removes the file", async () => {
    expect(await worker().deliver(ALL, BUDGET_MS, ARCHIVE)).toBeUndefined();
    expect(await worker().deliver(ALL)).toBeUndefined();
    expect(await readFile(settings(), "utf8")).toBe(HELPER_ONLY);
    expect(await worker().deliver(undefined, BUDGET_MS, ARCHIVE)).toBeUndefined();
    expect(await readFile(settings(), "utf8")).toBe(composed(false, true));
    const { lines, deliver } = worker();
    expect(await deliver(undefined)).toBeUndefined();
    expect(await Bun.file(settings()).exists()).toBe(false);
    expect(lines).toEqual(["anthropic: not delivered; Claude Code's managed settings removed"]);
  });

  test("a rerun leaves the same bytes", async () => {
    const first = worker();
    expect(await first.deliver(undefined, BUDGET_MS, ARCHIVE)).toBeUndefined();
    const written = await readFile(settings(), "utf8");
    const second = worker();
    expect(await second.deliver(undefined, BUDGET_MS, ARCHIVE)).toBeUndefined();
    expect(second.calls.map(({ argv }) => argv)).toEqual(first.calls.map(({ argv }) => argv));
    expect(await readFile(settings(), "utf8")).toBe(written);
  });

  test("settings it cannot write fail the step for the log archive, before the key file goes", async () => {
    await mkdir(join(settings(), "inside"), { recursive: true });
    const { calls, lines, deliver } = worker();
    expect(await deliver(undefined, BUDGET_MS, ARCHIVE)).toMatch(
      /^log_archive: writing Claude Code's managed settings failed \([A-Z]+\)$/,
    );
    expect(calls).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("refused material (credential delivery §Failure)", () => {
  for (const [what, value, reason] of [
    ["empty", "", "its secret is empty"],
    ["blank", "  \n", "its secret is empty"],
    ["null", null, "its secret is empty"],
    ["holding whitespace", "ghp_one two", "its secret contains whitespace"],
  ] as const)
    test(`${what} material fails the step before any tool runs`, async () => {
      const { tools, lines, deliver } = worker({
        [OPENAI_ARN]: exited(0, `${JSON.stringify(value)}\n`),
      });
      expect(await deliver(ALL)).toBe(`openai: ${reason}`);
      expect(tools()).toEqual([]);
      expect(lines).toEqual([]);
    });

  test("material around its whitespace is trimmed", async () => {
    const { tools, deliver } = worker({
      [GITHUB_ARN]: exited(0, `${JSON.stringify(`  ${GITHUB_TOKEN}\n`)}\n`),
    });
    expect(await deliver({ github_token_secret: GITHUB_ARN })).toBeUndefined();
    expect(tools()[0]?.stdin).toBe(GITHUB_TOKEN);
  });

  test("an answer that is not a JSON string is refused without quoting it", async () => {
    const { deliver } = worker({ [GITHUB_ARN]: exited(0, `${GITHUB_TOKEN}\n`) });
    const reason = await deliver(ALL);
    expect(reason).toBe("github: Secrets Manager's answer could not be read");
  });
});

describe("failures name the account and the reason only (credential delivery §Failure)", () => {
  test("a secret that cannot be read names the AWS error, never its message", async () => {
    const { tools, deliver } = worker({
      [ANTHROPIC_ARN]: exited(
        254,
        "",
        `\nAn error occurred (AccessDeniedException) when calling the GetSecretValue operation: User: arn:aws:sts::123456789012:assumed-role/x is not authorized to access ${ANTHROPIC_ARN}\n`,
      ),
    });
    expect(await deliver(ALL)).toBe("anthropic: reading its secret failed (AccessDeniedException)");
    expect(tools()).toEqual([]);
  });

  test("an AWS CLI failure without an error name is named by its exit status", async () => {
    const { deliver } = worker({
      [GITHUB_ARN]: exited(253, "", "Unable to locate credentials. You can configure ..."),
    });
    expect(await deliver(ALL)).toBe("github: reading its secret failed (exit status 253)");
  });

  test("a read past its deadline, or an AWS CLI that is missing, fails the step", async () => {
    expect(await worker({ [GITHUB_ARN]: { kind: "timed_out" } }).deliver(ALL)).toBe(
      "github: reading its secret timed out",
    );
    expect(await worker({ [GITHUB_ARN]: { kind: "not_found" } }).deliver(ALL)).toBe(
      "github: reading its secret failed (the AWS CLI is not installed)",
    );
  });

  test("a refused token fails the step by gh's exit status, and nothing after it runs", async () => {
    const { tools, deliver } = worker({
      "gh auth login --with-token --hostname github.com --git-protocol https --insecure-storage":
        exited(1, "", `error validating token: HTTP 401: Bad credentials (${GITHUB_TOKEN})`),
    });
    expect(await deliver(ALL)).toBe("github: gh auth login exited with status 1");
    expect(tools().map(({ command }) => command.split(" ")[0])).toEqual(["gh"]);
  });

  test("a login past its deadline fails the step", async () => {
    const { deliver } = worker({ "codex login --with-api-key": { kind: "timed_out" } });
    expect(await deliver(ALL)).toBe("openai: codex login timed out");
  });

  test("an account list gh cannot give fails the step", async () => {
    expect(
      await worker({
        "gh auth status --hostname github.com --json hosts": exited(0, "not json"),
      }).deliver(ALL),
    ).toBe("github: gh auth status gave no account list");
    expect(
      await worker({
        "gh auth status --hostname github.com --json hosts": exited(
          0,
          accounts(["factory-bot", true], ["bad name; rm", false]),
        ),
      }).deliver(ALL),
    ).toBe("github: gh auth status gave no account list");
    // A login is an argument of `gh auth logout`: never one gh could read as an option.
    for (const login of ["-octocat", "_octocat", "--all"])
      expect(
        await worker({
          "gh auth status --hostname github.com --json hosts": exited(
            0,
            accounts(["factory-bot", true], [login, false]),
          ),
        }).deliver(ALL),
      ).toBe("github: gh auth status gave no account list");
  });

  test("a key file it cannot write fails the step before Claude Code's helper is written", async () => {
    const staging = "dd anthropic-api-key.new status=none";
    const { deliver } = worker({ [staging]: exited(1) });
    expect(await deliver(ALL)).toBe("anthropic: writing its key file exited with status 1");
    expect(await Bun.file(settings()).exists()).toBe(false);
  });

  test("the step's budget bounds every command", async () => {
    const { calls, deliver } = worker();
    expect(await deliver(ALL, 45_000)).toBeUndefined();
    expect(calls.every(({ timeoutMs }) => timeoutMs <= 45_000)).toBe(true);
    expect(await worker().deliver(ALL, 0)).toBe("github: reading its secret timed out");
  });

  test("no failure quotes a tool, an ARN or material", async () => {
    const reasons = [
      await worker({
        [GITHUB_ARN]: exited(254, "", `An error occurred (Weird ${GITHUB_ARN}) when calling`),
      }).deliver(ALL),
      await worker({
        "codex login --with-api-key": exited(1, OPENAI_KEY, OPENAI_KEY),
      }).deliver(ALL),
    ];
    for (const reason of reasons) {
      expect(reason).toBeString();
      for (const secret of [...MATERIAL, GITHUB_ARN]) expect(reason).not.toContain(secret);
    }
    expect(reasons[0]).toBe("github: reading its secret failed (exit status 254)");
  });
});
