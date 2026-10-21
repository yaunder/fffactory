/**
 * `terraform-check.ts`'s destroy plan check: the guarded destroy plan's rule
 * (`destroyPlanRefusal`, docs/specs/provisioning.md §Destroy plan) judged against Terraform's own
 * destroy plans, not hand-written JSON.
 *
 * Each case plans the factory root in destroy mode from a synthesized state
 * (`terraform-state-fixture.ts`) of the example with one host or two, or from an empty state, as
 * teardown plans it: the recorded host keys read through the provisioner's `output`, factory.json
 * projected with `projectFactoryVariables` and those keys, `plan -destroy -detailed-exitcode
 * -out` with Terraform's state lock, and the saved plan read back through the provisioner's
 * `showPlan`. The plan must delete every managed resource the state holds and change nothing
 * else, and `destroyPlanRefusal` must pass it with EC2 listing the instances the state records,
 * and refuse it with EC2 listing none or another, and once any one change is tampered into
 * something other than a delete. An empty state's plan must change nothing, and pass. The plans
 * run with `-refresh=false`: the state is the fixture's, never AWS's. The removal check's tree,
 * state and session serve it (`RemovalCheckContext`).
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectFactoryVariables } from "../src/application/project-terraform-inputs";
import type { FactoryInstance, HostKey } from "../src/domain/instance";
import { changesSomething, type ResourceChange, resourceChanges } from "../src/domain/plan";
import { recordedHostKeys } from "../src/domain/stable-host-keys";
import type { Machine } from "../src/domain/status";
import { destroyPlanRefusal } from "../src/domain/teardown";
import {
  fixtureDocument,
  parsed,
  type RemovalCheckContext,
  recordedInstance,
  target,
} from "./terraform-removal-check";
import { type StateFixtureContext, synthesizedState } from "./terraform-state-fixture";

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MINUTES = 60 * 1000;
/** An instance EC2 could list for a host that is not the one the state holds. */
const ANOTHER_INSTANCE = "i-0fedcba9876543210";
/** What a tampered change does instead of deleting its resource. */
const TAMPERED: readonly (readonly string[])[] = [["update"], ["delete", "create"], ["forget"]];

interface DestroyCase {
  readonly title: string;
  /** The host keys of the example's fixture to keep; none for an empty state. */
  readonly hosts: readonly HostKey[];
}

const CASES: readonly DestroyCase[] = [
  { title: "one host", hosts: ["builder-1" as HostKey] },
  { title: "two hosts", hosts: ["builder-1" as HostKey, "builder-2" as HostKey] },
  { title: "an empty state", hosts: [] },
];

/** The fixture's factory.json, the removal check's several hosts but only `hosts`. */
function fixtureInstance(context: RemovalCheckContext, hosts: readonly HostKey[]): FactoryInstance {
  const document = fixtureDocument(context, "several");
  return parsed({
    ...document,
    hosts: (document.hosts as Json[]).filter((host) => hosts.includes(host.key as HostKey)),
  });
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Every managed resource of a JSON plan's state module and its child modules, by address. */
function managedAddresses(module: unknown): string[] {
  if (!isJson(module)) return [];
  const own = list(module.resources).flatMap((resource) =>
    isJson(resource) && resource.mode === "managed" ? [String(resource.address)] : [],
  );
  return [...own, ...list(module.child_modules).flatMap(managedAddresses)];
}

/** Every managed resource a JSON plan's prior state holds, by address, sorted. */
function priorResources(plan: unknown): string[] {
  const prior = isJson(plan) && isJson(plan.prior_state) ? plan.prior_state.values : undefined;
  return managedAddresses(isJson(prior) ? prior.root_module : undefined).sort();
}

/** The plan of the state as teardown makes and reads it: in destroy mode, of today's projection. */
async function destroyPlan(context: RemovalCheckContext, label: string, instance: FactoryInstance) {
  const outputs = await context.provisioner.output(target(context));
  const recorded = recordedHostKeys(outputs);
  if (recorded === undefined) throw new Error("The fixture's recorded host keys cannot be read");
  const projection = projectFactoryVariables(instance, recorded);
  if (!projection.ok)
    throw new Error(
      `The ${label} destroy fixture does not project: ${projection.issues.map((i) => i.path).join(", ")}`,
    );
  const inputs = join(context.work, `destroy-${label}.tfvars.json`);
  const planFile = join(context.work, `destroy-${label}.tfplan`);
  await writeFile(inputs, JSON.stringify(projection.variables), { mode: 0o600 });
  const { exitCode } = await context.run(
    context.session,
    [
      "plan",
      "-input=false",
      "-no-color",
      "-detailed-exitcode",
      "-destroy",
      "-refresh=false",
      `-var-file=${inputs}`,
      `-out=${planFile}`,
    ],
    { timeoutMs: 10 * MINUTES, exitCodes: [0, 2] },
  );
  const shown = await context.provisioner.showPlan({ ...target(context), planFile });
  return { shown, changes: exitCode === 2, recorded, outputs };
}

/** The plan with its `index`th resource change's actions replaced by `actions`. */
function tampered(plan: unknown, index: number, actions: readonly string[]): unknown {
  const copy = structuredClone(plan) as Json;
  const change = (copy.resource_changes as Json[])[index] as Json;
  change.change = { ...(change.change as Json), actions: [...actions] };
  return copy;
}

/** Which tampered copies of `shown`, each with one change made other than a delete, pass. */
function tamperingProblems(shown: unknown, listed: readonly Machine[]): string[] {
  const count = isJson(shown) ? list(shown.resource_changes).length : 0;
  return Array.from({ length: count }, (_, index) => index).flatMap((index) =>
    TAMPERED.filter(
      (actions) => destroyPlanRefusal(tampered(shown, index, actions), listed) === undefined,
    ).map((actions) => `allowed with change ${index} tampered into ${actions.join(", ")}`),
  );
}

/** What is wrong with the verdicts on `shown`, EC2 listing `listed`. */
function verdictProblems(shown: unknown, listed: readonly Machine[]): string[] {
  const problems: string[] = [];
  const refusal = destroyPlanRefusal(shown, listed);
  if (refusal !== undefined)
    problems.push(`refused with the state's instances listed: ${refusal.summary}`);
  if (listed.length === 0) return problems;
  if (destroyPlanRefusal(shown, []) === undefined) problems.push("allowed with no instance listed");
  const another = listed.map((machine, index) =>
    index === 0 ? { ...machine, instanceId: ANOTHER_INSTANCE } : machine,
  );
  if (destroyPlanRefusal(shown, another) === undefined)
    problems.push(`allowed with ${ANOTHER_INSTANCE} listed in place of the state's`);
  return [...problems, ...tamperingProblems(shown, listed)];
}

/**
 * What is wrong with the plan's changes: anything but a delete of every resource the state
 * holds, or an exit code that disagrees with them.
 */
function changeProblems(
  shown: unknown,
  changing: readonly ResourceChange[],
  changes: boolean,
  hosts: readonly HostKey[],
): string[] {
  const deleted = changing
    .filter(({ actions }) => actions.join() === "delete")
    .map(({ address }) => address)
    .sort();
  const prior = priorResources(shown);
  const problems: string[] = [];
  if (changes !== changing.length > 0)
    problems.push(`plan -detailed-exitcode reported ${changes ? "" : "no "}change`);
  if (hosts.length > 0 && prior.length === 0)
    problems.push("the fixture's state holds no resource");
  if (deleted.join("\n") !== prior.join("\n"))
    problems.push(`deletes [${deleted.join("; ")}], not every resource [${prior.join("; ")}]`);
  if (changing.length !== deleted.length)
    problems.push(
      `changes [${changing.map(({ address }) => address).join("; ")}] other than deletes`,
    );
  return problems;
}

/** The case's report lines and problems, its state already in place. */
async function checkCase(context: RemovalCheckContext, destroyCase: DestroyCase) {
  const { hosts, title } = destroyCase;
  const instance = fixtureInstance(context, hosts);
  const label = hosts.length === 0 ? "empty" : `${hosts.length}-hosts`;
  const { shown, changes, recorded, outputs } = await destroyPlan(context, label, instance);
  const readable = resourceChanges(shown);
  if (readable === undefined) return { report: [], problems: ["fffactory cannot read the plan"] };
  const changing = readable.filter(changesSomething);
  const problems = changeProblems(shown, changing, changes, hosts);
  if (recorded.join() !== hosts.join())
    problems.push(`the state records [${recorded.join(", ")}], not [${hosts.join(", ")}]`);
  const listed: Machine[] = recorded.map((key) => ({
    instanceId: recordedInstance(outputs, key as HostKey),
    state: "running",
    hostKey: key,
  }));
  problems.push(...verdictProblems(shown, listed));
  const what =
    changing.length === 0
      ? "no change; destroyPlanRefusal allows it"
      : `deletes all ${changing.length} resources; destroyPlanRefusal allows it and refuses every tampered copy`;
  return {
    report: [`  ${title}: ${what}`],
    problems: problems.map((problem) => `${title}: ${problem}`),
  };
}

/**
 * Every destroy case's report and problems. Each case's state is synthesized afresh into the
 * removal check's state file, or removed for an empty state.
 */
export async function destroyPlanProblems(
  context: RemovalCheckContext,
): Promise<{ report: string[]; problems: string[] }> {
  const { run, session, statePath, work } = context;
  const fixture: StateFixtureContext = { ...context.fixture, run, session, statePath, work };
  const report: string[] = ["destroy plans: plan -destroy of the factory root"];
  const problems: string[] = [];
  for (const destroyCase of CASES) {
    if (destroyCase.hosts.length === 0) await rm(statePath, { force: true });
    else {
      const projection = projectFactoryVariables(fixtureInstance(context, destroyCase.hosts), []);
      if (!projection.ok)
        throw new Error(`The ${destroyCase.title} destroy fixture does not project`);
      await synthesizedState(fixture, `destroy-fixture-${destroyCase.hosts.length}`, {
        ...projection.variables,
      });
    }
    const result = await checkCase(context, destroyCase);
    report.push(...result.report);
    problems.push(...result.problems);
  }
  return { report, problems };
}
