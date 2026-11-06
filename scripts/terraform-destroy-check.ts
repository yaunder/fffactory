/**
 * `terraform-check.ts`'s destroy plan check: the guarded destroy plan's rule
 * (`destroyPlanRefusal`, docs/specs/provisioning.md §Destroy plan) judged against Terraform's own
 * destroy plans, not hand-written JSON.
 *
 * Each case plans the factory root in destroy mode from a synthesized state
 * (`terraform-state-fixture.ts`) of the example with one host or two, from an empty state, or
 * from a state that records root outputs but no resource (the one-host state stripped of its
 * resources, as the PR #89 review reproduced it), as teardown plans it: the recorded host keys
 * read through the provisioner's `output`, factory.json projected with
 * `projectFactoryVariables` and those keys, `plan -destroy -detailed-exitcode -out` with
 * Terraform's state lock, and the saved plan read back through the provisioner's `showPlan`.
 * The plan must delete every managed resource and every root output the state holds and change
 * nothing else, its exit code agreeing (`destroyPlanMismatch`), and `destroyPlanRefusal` must
 * pass it with EC2 listing the instances the state records, and refuse it with EC2 listing none
 * or another, and once any one resource change is tampered into something other than a delete,
 * or any one output change into something other than a delete. An empty state's plan must
 * change nothing, and pass; the outputs-only state's must exit 2 deleting only its outputs, and
 * pass. The plans run with `-refresh=false`: the state is the fixture's, never AWS's. The
 * removal check's tree, state and session serve it (`RemovalCheckContext`).
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectFactoryVariables } from "../src/application/project-terraform-inputs";
import type { FactoryInstance, HostKey } from "../src/domain/instance";
import {
  changesSomething,
  type OutputChange,
  outputChanges,
  type ResourceChange,
  resourceChanges,
} from "../src/domain/plan";
import { recordedHostKeys } from "../src/domain/stable-host-keys";
import type { Machine } from "../src/domain/status";
import { destroyPlanMismatch, destroyPlanRefusal } from "../src/domain/teardown";
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
/** What a tampered root output change does instead of deleting the output. */
const TAMPERED_OUTPUTS: readonly (readonly string[])[] = [["update"], ["create"]];

interface DestroyCase {
  readonly title: string;
  /** Names the case's input and plan files. */
  readonly label: string;
  /** The host keys of the example's fixture to keep; none for an empty state. */
  readonly hosts: readonly HostKey[];
  /** The state holds the root outputs, as with `ONE_HOST`, and no resource. */
  readonly outputsOnly?: true;
}

const ONE_HOST = ["builder-1" as HostKey];

const CASES: readonly DestroyCase[] = [
  { title: "one host", label: "1-hosts", hosts: ONE_HOST },
  {
    title: "two hosts",
    label: "2-hosts",
    hosts: ["builder-1" as HostKey, "builder-2" as HostKey],
  },
  { title: "an empty state", label: "empty", hosts: [] },
  { title: "a state with only root outputs", label: "outputs-only", hosts: [], outputsOnly: true },
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

/** A JSON plan's prior state values, when it has a prior state. */
function priorValues(plan: unknown): Json | undefined {
  const prior = isJson(plan) && isJson(plan.prior_state) ? plan.prior_state.values : undefined;
  return isJson(prior) ? prior : undefined;
}

/** Every managed resource a JSON plan's prior state holds, by address, sorted. */
function priorResources(plan: unknown): string[] {
  return managedAddresses(priorValues(plan)?.root_module).sort();
}

/** Every root output a JSON plan's prior state holds, by name, sorted. */
function priorOutputs(plan: unknown): string[] {
  const outputs = priorValues(plan)?.outputs;
  return isJson(outputs) ? Object.keys(outputs).sort() : [];
}

/**
 * `state` stripped of its resources: a state that records root outputs but no resource, the
 * outputs as they would be with no host, no host key among them.
 */
function outputsOnlyState(state: string): string {
  const document = JSON.parse(state) as Json;
  const outputs = isJson(document.outputs) ? document.outputs : {};
  if (!isJson(outputs.host_keys) || !isJson(outputs.hosts))
    throw new Error(
      "The outputs-only destroy fixture's state records no host_keys or hosts output",
    );
  const hostsType = outputs.hosts.type;
  return JSON.stringify({
    ...document,
    serial: Number(document.serial) + 1,
    outputs: {
      ...outputs,
      host_keys: { ...outputs.host_keys, value: [] },
      // An object with an attribute per host, as `module.hosts.hosts` is, holds none.
      hosts: {
        ...outputs.hosts,
        value: {},
        type: Array.isArray(hostsType) && hostsType[0] === "object" ? ["object", {}] : hostsType,
      },
    },
    resources: [],
  });
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

/** The plan with its root output `name`'s change's actions replaced by `actions`. */
function tamperedOutput(plan: unknown, name: string, actions: readonly string[]): unknown {
  const copy = structuredClone(plan) as Json;
  const changes = copy.output_changes as Json;
  changes[name] = { ...(changes[name] as Json), actions: [...actions] };
  return copy;
}

/** Which tampered copies of `shown`, each with one root output change made other than a delete, pass. */
function outputTamperingProblems(
  shown: unknown,
  outputs: readonly OutputChange[],
  listed: readonly Machine[],
): string[] {
  return outputs.flatMap(({ name }) =>
    TAMPERED_OUTPUTS.filter(
      (actions) => destroyPlanRefusal(tamperedOutput(shown, name, actions), listed) === undefined,
    ).map((actions) => `allowed with output ${name} tampered into ${actions.join(", ")}`),
  );
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
 * What is wrong with the changes to one kind of thing (`what`, resources or root outputs), each
 * named by `name`: anything but a delete of every one the prior state holds (`prior`).
 */
function deletionProblems(
  what: string,
  changes: readonly { readonly name: string; readonly actions: readonly string[] }[],
  prior: readonly string[],
): string[] {
  const deleted = changes
    .filter(({ actions }) => actions.join() === "delete")
    .map(({ name }) => name)
    .sort();
  const problems: string[] = [];
  if (deleted.join("\n") !== prior.join("\n"))
    problems.push(`deletes ${what} [${deleted.join("; ")}], not every one [${prior.join("; ")}]`);
  if (changes.length !== deleted.length)
    problems.push(
      `changes ${what} [${changes.map(({ name, actions }) => `${name} (${actions.join(", ")})`).join("; ")}] other than deletes`,
    );
  return problems;
}

/**
 * What is wrong with the plan's changes: anything but a delete of every resource and every root
 * output the state holds, or an exit code that disagrees with them (`destroyPlanMismatch`) or
 * with the case: changes for any state but an empty one.
 */
function changeProblems(
  shown: unknown,
  changing: readonly ResourceChange[],
  outputs: readonly OutputChange[],
  changes: boolean,
  destroyCase: DestroyCase,
): string[] {
  const { hosts, outputsOnly } = destroyCase;
  const prior = priorResources(shown);
  const recordedOutputs = priorOutputs(shown);
  const problems: string[] = [];
  const mismatch = destroyPlanMismatch(changes, changing, outputs);
  if (mismatch !== undefined) problems.push(`the exit code check refuses it: ${mismatch.summary}`);
  if (changes !== (hosts.length > 0 || outputsOnly === true))
    problems.push(`plan -detailed-exitcode reported ${changes ? "" : "no "}change`);
  if (hosts.length > 0 && prior.length === 0)
    problems.push("the fixture's state holds no resource");
  if (outputsOnly && (prior.length > 0 || recordedOutputs.length === 0))
    problems.push("the fixture's state does not hold only root outputs");
  const resources = changing.map(({ address, actions }) => ({ name: address, actions }));
  return [
    ...problems,
    ...deletionProblems("resources", resources, prior),
    ...deletionProblems("outputs", outputs, recordedOutputs),
  ];
}

/** The case's report lines and problems, its state already in place. */
async function checkCase(context: RemovalCheckContext, destroyCase: DestroyCase) {
  const { hosts, title, label } = destroyCase;
  const instance = fixtureInstance(context, hosts);
  const { shown, changes, recorded, outputs } = await destroyPlan(context, label, instance);
  const readable = resourceChanges(shown);
  const outputChanging = outputChanges(shown);
  if (readable === undefined || outputChanging === undefined)
    return { report: [], problems: [`${title}: fffactory cannot read the plan`] };
  const changing = readable.filter(changesSomething);
  const problems = changeProblems(shown, changing, outputChanging, changes, destroyCase);
  if (recorded.join() !== hosts.join())
    problems.push(`the state records [${recorded.join(", ")}], not [${hosts.join(", ")}]`);
  const listed: Machine[] = recorded.map((key) => ({
    instanceId: recordedInstance(outputs, key as HostKey),
    state: "running",
    hostKey: key,
  }));
  problems.push(...verdictProblems(shown, listed));
  problems.push(...outputTamperingProblems(shown, outputChanging, listed));
  const deletedOutputs = outputChanging.filter(changesSomething).length;
  const what =
    changing.length === 0 && deletedOutputs === 0
      ? "no change; destroyPlanRefusal allows it"
      : changing.length === 0
        ? `deletes only its ${deletedOutputs} root outputs, exit 2; destroyPlanRefusal and the exit code check allow it, destroyPlanRefusal refusing every tampered copy`
        : `deletes all ${changing.length} resources and ${deletedOutputs} root outputs; destroyPlanRefusal allows it and refuses every tampered copy`;
  return {
    report: [`  ${title}: ${what}`],
    problems: problems.map((problem) => `${title}: ${problem}`),
  };
}

/**
 * The case's state, in the removal check's state file: synthesized afresh, then stripped of its
 * resources for the outputs-only case, or removed for an empty state.
 */
async function placeState(
  context: RemovalCheckContext,
  fixture: StateFixtureContext,
  destroyCase: DestroyCase,
): Promise<void> {
  const { statePath } = context;
  const synthesized = destroyCase.outputsOnly === true ? ONE_HOST : destroyCase.hosts;
  if (synthesized.length === 0) {
    await rm(statePath, { force: true });
    return;
  }
  const projection = projectFactoryVariables(fixtureInstance(context, synthesized), []);
  if (!projection.ok) throw new Error(`The ${destroyCase.title} destroy fixture does not project`);
  const state = await synthesizedState(fixture, `destroy-fixture-${synthesized.length}`, {
    ...projection.variables,
  });
  if (destroyCase.outputsOnly === true) await writeFile(statePath, outputsOnlyState(state));
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
    await placeState(context, fixture, destroyCase);
    const result = await checkCase(context, destroyCase);
    report.push(...result.report);
    problems.push(...result.problems);
  }
  return { report, problems };
}
