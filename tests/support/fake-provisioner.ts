import type {
  PlanRequest,
  PlanResult,
  Provisioner,
  ProvisioningTarget,
  SavedPlanRequest,
} from "../../src/application/provisioner";

export type ProvisionerCall =
  | { readonly call: "plan"; readonly request: PlanRequest }
  | { readonly call: "showPlan" | "applyPlan"; readonly request: SavedPlanRequest }
  | { readonly call: "output"; readonly request: ProvisioningTarget };

/**
 * Provisioner that records every call and answers from a script: the plan result, the
 * JSON plan `showPlan` returns, and an optional hook run by `applyPlan`. Runs no Terraform.
 */
export function fakeProvisioner(
  script: {
    plan?: PlanResult;
    shown?: unknown;
    onApply?: (request: SavedPlanRequest) => void;
  } = {},
) {
  const calls: ProvisionerCall[] = [];
  const provisioner: Provisioner = {
    plan: async (request) => {
      calls.push({ call: "plan", request });
      return script.plan ?? { changes: true };
    },
    showPlan: async (request) => {
      calls.push({ call: "showPlan", request });
      return script.shown ?? { resource_changes: [] };
    },
    applyPlan: async (request) => {
      calls.push({ call: "applyPlan", request });
      script.onApply?.(request);
    },
    output: async (request) => {
      calls.push({ call: "output", request });
      return {};
    },
  };
  return { provisioner, calls };
}

/** A planned change as the world plans it, and as `showPlan` reports it. */
interface WorldChange {
  readonly address: string;
  readonly type: string;
  readonly actions: readonly string[];
  /** What applying it does to the world. */
  readonly apply: () => void;
}

export const NETWORK = "module.network.aws_vpc.this";
export const hostAddress = (key: string) => `module.hosts.aws_instance.host["${key}"]`;
export const STATE_BUCKET_ADDRESS = "module.state_bucket.aws_s3_bucket.state";

/**
 * A factory's AWS world behind a Provisioner, so plan and apply can be tested against state
 * that changes: the state bucket (in `store`), the network and one host machine per host key.
 * The backend root plans creating the bucket. The factory root plans the network, a host per
 * declared key not yet provisioned and removing any provisioned key no longer declared, and
 * `replace` forces a host's replacement; `output` records the provisioned keys once there is
 * state. Applying a saved plan applies its changes one at a time, each written to the state
 * (a new revision in `store`), and runs `beforeChange` before each: a test can stop the apply
 * part way through by throwing there, as an interrupted Terraform does.
 */
export function fakeFactoryWorld(options: {
  readonly store: { readonly buckets: Set<string>; readonly states: Map<string, string> };
  readonly bucket: string;
  readonly hosts?: readonly string[];
}) {
  const world = {
    network: (options.hosts ?? []).length > 0,
    hosts: new Set(options.hosts ?? []),
    replace: new Set<string>(),
    revisions: 0,
    /** Answers `output` with this instead of the world's outputs when set. */
    outputs: undefined as Readonly<Record<string, unknown>> | undefined,
    /** Answers `showPlan` with this instead of the saved plan when set. */
    shown: undefined as unknown,
    /** Runs before each change an apply makes, with how many it made so far. */
    beforeChange: undefined as ((applied: number) => void) | undefined,
    /** Rejects the next call to this port method, as a failing Terraform command does. */
    failNext: undefined as keyof Provisioner | undefined,
  };
  const plans = new Map<string, readonly WorldChange[]>();
  const calls: ProvisionerCall[] = [];

  function write(change: () => void) {
    change();
    world.revisions += 1;
    options.store.states.set(options.bucket, `revision-${world.revisions}`);
  }

  function failing(method: keyof Provisioner) {
    if (world.failNext !== method) return;
    world.failNext = undefined;
    throw new Error(
      `\`terraform ${method === "applyPlan" ? "apply" : method}\` exited with status 1`,
    );
  }

  function hostChange(key: string): WorldChange[] {
    const address = hostAddress(key);
    const add = () => world.hosts.add(key);
    if (!world.hosts.has(key))
      return [{ address, type: "aws_instance", actions: ["create"], apply: add }];
    if (world.replace.has(key))
      return [{ address, type: "aws_instance", actions: ["delete", "create"], apply: add }];
    return [];
  }

  function factoryChanges(declared: readonly string[]): WorldChange[] {
    const network: WorldChange = {
      address: NETWORK,
      type: "aws_vpc",
      actions: ["create"],
      apply: () => {
        world.network = true;
      },
    };
    const removed = [...world.hosts].filter((key) => !declared.includes(key));
    return [
      ...(world.network ? [] : [network]),
      ...declared.flatMap(hostChange),
      ...removed.map((key) => ({
        address: hostAddress(key),
        type: "aws_instance",
        actions: ["delete"],
        apply: () => world.hosts.delete(key),
      })),
    ];
  }

  function backendChanges(): WorldChange[] {
    return [
      {
        address: STATE_BUCKET_ADDRESS,
        type: "aws_s3_bucket",
        actions: ["create"],
        apply: () => options.store.buckets.add(options.bucket),
      },
    ];
  }

  const provisioner: Provisioner = {
    output: async (request) => {
      calls.push({ call: "output", request });
      failing("output");
      if (world.outputs !== undefined) return world.outputs;
      if (world.revisions === 0 && !world.network) return {};
      return { host_keys: [...world.hosts].sort(), hosts: {} };
    },
    plan: async (request) => {
      calls.push({ call: "plan", request });
      failing("plan");
      const declared = Object.keys((request.variables.hosts ?? {}) as Record<string, unknown>);
      const changes =
        request.configuration.root === "backend" ? backendChanges() : factoryChanges(declared);
      plans.set(request.planFile, changes);
      return { changes: changes.length > 0 };
    },
    showPlan: async (request) => {
      calls.push({ call: "showPlan", request });
      failing("showPlan");
      if (world.shown !== undefined) return world.shown;
      return {
        format_version: "1.2",
        resource_changes: (plans.get(request.planFile) ?? []).map(({ address, type, actions }) => ({
          address,
          type,
          change: { actions },
        })),
      };
    },
    applyPlan: async (request) => {
      calls.push({ call: "applyPlan", request });
      failing("applyPlan");
      const changes = plans.get(request.planFile);
      if (changes === undefined) throw new Error(`no saved plan at ${request.planFile}`);
      plans.delete(request.planFile);
      let applied = 0;
      for (const change of changes) {
        world.beforeChange?.(applied);
        if (request.configuration.root === "backend") change.apply();
        else write(change.apply);
        applied += 1;
      }
    },
  };
  return { provisioner, calls, world, plans };
}
