/**
 * `terraform-check.ts`'s removal plan check: the scoped removal rule (`removalPlanRefusal`,
 * docs/specs/worker-lifecycle.md §Terminate (remove)) judged against Terraform's own removal
 * plans, not hand-written JSON.
 *
 * Each case plans the factory root from a synthesized state (`terraform-state-fixture.ts`),
 * as `fffactory worker terminate` plans it: the recorded host keys read through the
 * provisioner's `output`, factory.json without the host (`withoutHost`) projected with
 * `projectFactoryVariables` and the recorded keys less the removed one, `plan
 * -detailed-exitcode -out` with Terraform's state lock, and the saved plan read back through
 * the provisioner's `showPlan`. The plan's changing resources must be exactly the case's, the
 * secret-reading policy must allow what the remaining hosts need, and `removalPlanRefusal`
 * must allow or refuse it as the case says. The plans run with `-refresh=false`: the state is
 * the fixture's, never AWS's.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provisioner, ProvisioningTarget } from "../src/application/provisioner";
import { projectFactoryVariables } from "../src/application/project-terraform-inputs";
import { HOST_SECRETS_POLICY, removalPlanRefusal, withoutHost } from "../src/domain/host-removal";
import {
  type FactoryId,
  type FactoryInstance,
  type HostKey,
  parseFactoryInstance,
} from "../src/domain/instance";
import { changesSomething, hostMachineAddress, resourceChanges } from "../src/domain/plan";
import { recordedHostKeys } from "../src/domain/stable-host-keys";
import type { TerraformRunner, TerraformSession } from "../src/infrastructure/terraform/runner";
import { type StateFixtureContext, synthesizedState } from "./terraform-state-fixture";

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MINUTES = 60 * 1000;
/** An instance EC2 could list for the host that is not the one the state holds. */
const ANOTHER_INSTANCE = "i-0fedcba9876543210";

export interface RemovalCheckContext {
  readonly run: TerraformRunner;
  readonly provisioner: Provisioner;
  /** The Terraform tree whose factory root keeps its state locally at `statePath`. */
  readonly tree: string;
  readonly statePath: string;
  /** An initialized session in the tree's factory root. */
  readonly session: TerraformSession;
  readonly work: string;
  readonly fixture: Omit<StateFixtureContext, "run" | "session" | "statePath" | "work">;
  /** examples/factory.json as JSON, the fixtures' base. */
  readonly example: Json;
  readonly factoryId: FactoryId;
}

/** Which instance EC2 lists for the removed host, and whether the rule must allow the plan. */
interface Verdict {
  readonly listed: "the state's" | "another" | "none";
  /** The refusal's summary must match; undefined when the plan must be allowed. */
  readonly refused?: RegExp;
}

interface RemovalCase {
  readonly title: string;
  readonly hosts: "several" | "one";
  readonly key: HostKey;
  /** Another edit of factory.json, besides the removal, that the plan would carry. */
  readonly edit?: (document: Json) => Json;
  /** The plan's changing resources, `ADDRESS: ACTIONS`, sorted; undefined to leave them. */
  readonly changes?: readonly string[];
  /** Whether the hosts' policy must stop allowing the removed host's password. */
  readonly dropsSecret?: boolean;
  readonly verdicts: readonly Verdict[];
}

const POLICY_UPDATE = `${HOST_SECRETS_POLICY}: update`;
const deletes = (key: HostKey) => `${hostMachineAddress(key)}: delete`;
const moreThan = (key: HostKey) =>
  new RegExp(`^The removal plan changes more than host ${key}'s machine`);
const ALLOWED: readonly Verdict[] = [{ listed: "the state's" }];

const CASES: readonly RemovalCase[] = [
  {
    title: "one of several hosts, with its own Paseo password",
    hosts: "several",
    key: "builder-1" as HostKey,
    changes: [POLICY_UPDATE, deletes("builder-1" as HostKey)],
    dropsSecret: true,
    verdicts: [
      ...ALLOWED,
      {
        listed: "another",
        refused:
          /^Terraform's plan destroys instance i-\w+ for host builder-1, not i-0fedcba9876543210/,
      },
      {
        listed: "none",
        refused: /^Terraform's state holds a machine for host builder-1 that EC2 does not list/,
      },
    ],
  },
  {
    title: "a host without a Paseo password",
    hosts: "several",
    key: "builder-3" as HostKey,
    changes: [deletes("builder-3" as HostKey)],
    verdicts: ALLOWED,
  },
  {
    title: "a host sharing another host's Paseo password",
    hosts: "several",
    key: "builder-4" as HostKey,
    changes: [deletes("builder-4" as HostKey)],
    verdicts: ALLOWED,
  },
  {
    title: "the last host, with its own Paseo password",
    hosts: "one",
    key: "builder-1" as HostKey,
    changes: [POLICY_UPDATE, deletes("builder-1" as HostKey)],
    dropsSecret: true,
    verdicts: ALLOWED,
  },
  {
    title: "a host, with another host's instance type changed too",
    hosts: "several",
    key: "builder-1" as HostKey,
    edit: (document) => ({
      ...document,
      hosts: (document.hosts as Json[]).map((host) =>
        host.key === "builder-2" ? { ...host, instance_type: "m7i.2xlarge" } : host,
      ),
    }),
    verdicts: [{ listed: "the state's", refused: moreThan("builder-1" as HostKey) }],
  },
  {
    title: "a host, with the subnet's CIDR block changed too",
    hosts: "several",
    key: "builder-1" as HostKey,
    edit: (document) => ({
      ...document,
      network: { ...(document.network as Json), public_subnet_cidr: "10.78.2.0/24" },
    }),
    verdicts: [{ listed: "the state's", refused: moreThan("builder-1" as HostKey) }],
  },
  {
    title: "a host without a Paseo password, with another host's password changed too",
    hosts: "several",
    key: "builder-3" as HostKey,
    edit: (document) => ({
      ...document,
      hosts: (document.hosts as Json[]).map((host) =>
        host.key === "builder-1"
          ? {
              ...host,
              paseo_password_secret: String(host.paseo_password_secret).replace(
                "/builder-1/",
                "/builder-1-rotated/",
              ),
            }
          : host,
      ),
    }),
    changes: [POLICY_UPDATE, deletes("builder-3" as HostKey)],
    verdicts: [{ listed: "the state's", refused: moreThan("builder-3" as HostKey) }],
  },
];

/** A Paseo password reference of the factory's own Region and account. */
function passwordSecret(example: Json, factoryId: FactoryId, name: string): string {
  const { region, account_id } = example.aws as Json;
  return `arn:aws:secretsmanager:${region}:${account_id}:secret:${factoryId}/${name}/paseo-password-AbCdEf`;
}

/**
 * The fixture's factory.json: the example's, for `factoryId`, with several hosts (two with
 * their own Paseo passwords, one without, one sharing another's) or one with its own.
 */
function fixtureDocument(context: RemovalCheckContext, hosts: RemovalCase["hosts"]): Json {
  const { example, factoryId } = context;
  const [template] = example.hosts as [Json];
  const { paseo_password_secret: _, ...bare } = template;
  const host = (key: string, secret?: string) => ({
    ...bare,
    key,
    ...(secret === undefined
      ? {}
      : { paseo_password_secret: passwordSecret(example, factoryId, secret) }),
  });
  const bucket = `${factoryId}-${String((example.state_backend as Json).bucket).slice(String(example.factory_id).length + 1)}`;
  return {
    ...example,
    factory_id: factoryId,
    state_backend: { bucket },
    hosts:
      hosts === "one"
        ? [host("builder-1", "builder-1")]
        : [
            host("builder-1", "builder-1"),
            host("builder-2", "builder-2"),
            host("builder-3"),
            host("builder-4", "builder-2"),
          ],
  };
}

function parsed(document: Json): FactoryInstance {
  const result = parseFactoryInstance(document);
  if (!result.valid)
    throw new Error(
      `A removal fixture is not a valid instance: ${result.issues.map((issue) => issue.path).join(", ")}`,
    );
  return result.instance;
}

/** The resources a policy document allows, sorted. */
function allowed(policy: unknown): string[] {
  if (typeof policy !== "string") return [];
  const statements = [JSON.parse(policy).Statement].flat() as Json[];
  return statements.flatMap((statement) => [statement.Resource].flat().map(String)).sort();
}

/** The secrets the hosts' policy must allow for `instance`: the enrollment key and passwords. */
function neededSecrets(instance: FactoryInstance): string[] {
  const passwords = (instance.hosts ?? []).flatMap((host) =>
    host.paseo_password_secret === undefined ? [] : [host.paseo_password_secret],
  );
  return [...new Set([instance.tailscale?.auth_key_secret ?? "", ...passwords])].sort();
}

/** What is wrong with the secret-reading policy's change in `plan`. */
function policyProblems(plan: unknown, remaining: FactoryInstance, secret: string): string[] {
  const raws = isJson(plan) && Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  const policy = raws.find((raw) => isJson(raw) && raw.address === HOST_SECRETS_POLICY);
  const change = isJson(policy) && isJson(policy.change) ? policy.change : {};
  const before = allowed(isJson(change.before) ? change.before.policy : undefined);
  const after = allowed(isJson(change.after) ? change.after.policy : undefined);
  const problems: string[] = [];
  if (before.filter((arn) => arn !== secret).join() !== after.join() || !before.includes(secret))
    problems.push(
      `the policy goes from [${before.join(", ")}] to [${after.join(", ")}], not without ${secret}`,
    );
  if (after.join() !== neededSecrets(remaining).join())
    problems.push(
      `the policy allows [${after.join(", ")}], not [${neededSecrets(remaining).join(", ")}]`,
    );
  return problems;
}

/** The instance ID the state's `hosts` output records for `key`. */
function recordedInstance(outputs: Readonly<Record<string, unknown>>, key: HostKey): string {
  const hosts = outputs.hosts;
  const host = isJson(hosts) ? hosts[key] : undefined;
  const id = isJson(host) ? host.instance_id : undefined;
  if (typeof id !== "string") throw new Error(`The fixture's state records no instance for ${key}`);
  return id;
}

/** The plan of `instance` without the case's host, as `worker terminate` makes and reads it. */
async function removalPlan(
  context: RemovalCheckContext,
  removalCase: RemovalCase,
  instance: FactoryInstance,
  outputs: Readonly<Record<string, unknown>>,
) {
  const { key, edit } = removalCase;
  const recorded = recordedHostKeys(outputs);
  if (recorded === undefined) throw new Error("The fixture's recorded host keys cannot be read");
  const remaining = withoutHost(instance, key);
  const planned =
    edit === undefined ? remaining : parsed(edit(structuredClone(remaining) as unknown as Json));
  const projection = projectFactoryVariables(
    planned,
    recorded.filter((other) => other !== key),
  );
  if (!projection.ok)
    throw new Error(
      `factory.json without ${key} does not project: ${projection.issues.map((i) => i.path).join(", ")}`,
    );
  const label = `remove-${removalCase.hosts}-${key}${edit === undefined ? "" : "-edited"}`;
  const inputs = join(context.work, `${label}.tfvars.json`);
  const planFile = join(context.work, `${label}.tfplan`);
  await writeFile(inputs, JSON.stringify(projection.variables), { mode: 0o600 });
  const { exitCode } = await context.run(
    context.session,
    [
      "plan",
      "-input=false",
      "-no-color",
      "-detailed-exitcode",
      "-refresh=false",
      `-var-file=${inputs}`,
      `-out=${planFile}`,
    ],
    { timeoutMs: 10 * MINUTES, exitCodes: [0, 2] },
  );
  const shown = await context.provisioner.showPlan({ ...target(context), planFile });
  return { shown, changes: exitCode === 2, remaining };
}

function target(context: RemovalCheckContext): ProvisioningTarget {
  return {
    configuration: { directory: context.tree, root: "factory" },
    credentials: { source: "chain" },
    region: context.fixture.region,
    backend: {},
  };
}

/** The listed instance a verdict puts to the rule. */
function listedInstance(verdict: Verdict, recorded: string): string | undefined {
  if (verdict.listed === "the state's") return recorded;
  return verdict.listed === "another" ? ANOTHER_INSTANCE : undefined;
}

/** What is wrong with the rule's verdict on `shown`, or the verdict as reported. */
function judged(
  shown: unknown,
  removal: Parameters<typeof removalPlanRefusal>[1],
  verdict: Verdict,
) {
  const refusal = removalPlanRefusal(shown, removal);
  const said = refusal === undefined ? "allowed" : `refused: ${refusal.summary}`;
  const report = `EC2 listing ${verdict.listed === "none" ? "no instance" : `${verdict.listed} instance`}, ${said}`;
  const right =
    verdict.refused === undefined
      ? refusal === undefined
      : verdict.refused.test(refusal?.summary ?? "");
  const detail = refusal === undefined ? [] : refusal.details.map((line) => `      ${line}`);
  return right
    ? { report: [`    ${report}`, ...detail], problems: [] }
    : {
        report: [],
        problems: [
          `EC2 listing ${verdict.listed}: expected ${verdict.refused ?? "allowed"}, ${said}`,
        ],
      };
}

/** The case's report lines and problems. */
async function checkCase(
  context: RemovalCheckContext,
  removalCase: RemovalCase,
  instance: FactoryInstance,
  outputs: Readonly<Record<string, unknown>>,
) {
  const { key } = removalCase;
  const { shown, changes, remaining } = await removalPlan(context, removalCase, instance, outputs);
  const readable = resourceChanges(shown);
  if (readable === undefined) return { report: [], problems: ["fffactory cannot read the plan"] };
  const changing = readable
    .filter(changesSomething)
    .map(({ address, actions }) => `${address}: ${actions.join(", ")}`)
    .sort();
  const problems: string[] = [];
  if (!changes) problems.push("plan -detailed-exitcode reported no change");
  if (removalCase.changes !== undefined && changing.join("\n") !== removalCase.changes.join("\n"))
    problems.push(`changes [${changing.join("; ")}], expected [${removalCase.changes.join("; ")}]`);
  const secret = instance.hosts?.find((host) => host.key === key)?.paseo_password_secret;
  if (removalCase.dropsSecret && secret !== undefined)
    problems.push(...policyProblems(shown, remaining, secret));
  const recorded = recordedInstance(outputs, key);
  const report = [`  ${removalCase.title} (${key}): ${changing.join("; ")}`];
  for (const verdict of removalCase.verdicts) {
    const instanceId = listedInstance(verdict, recorded);
    const result = judged(shown, { key, instanceId, secret }, verdict);
    report.push(...result.report);
    problems.push(...result.problems);
  }
  return { report, problems: problems.map((problem) => `${removalCase.title}: ${problem}`) };
}

/**
 * Every removal case's report and problems. Each fixture's state is synthesized once, then
 * written back before each of its cases, so no case sees another's plan.
 */
export async function removalPlanProblems(
  context: RemovalCheckContext,
): Promise<{ report: string[]; problems: string[] }> {
  const { run, session, statePath, work } = context;
  const fixture: StateFixtureContext = { ...context.fixture, run, session, statePath, work };
  const report: string[] = [];
  const problems: string[] = [];
  for (const hosts of ["several", "one"] as const) {
    const instance = parsed(fixtureDocument(context, hosts));
    const projection = projectFactoryVariables(instance, []);
    if (!projection.ok) throw new Error(`The ${hosts}-host removal fixture does not project`);
    const state = await synthesizedState(fixture, `fixture-${hosts}`, { ...projection.variables });
    const outputs = await context.provisioner.output(target(context));
    report.push(
      `removal fixture: ${hosts === "one" ? "one host" : "several hosts"} (${String(recordedHostKeys(outputs))}), a state Terraform plans no change for`,
    );
    for (const removalCase of CASES.filter((each) => each.hosts === hosts)) {
      await writeFile(context.statePath, state, { mode: 0o600 });
      const result = await checkCase(context, removalCase, instance, outputs);
      report.push(...result.report);
      problems.push(...result.problems);
    }
  }
  return { report, problems };
}
