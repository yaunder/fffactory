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
  /** The resource's attributes before and after that matter to a test; none by default. */
  readonly before?: Readonly<Record<string, unknown>>;
  readonly after?: Readonly<Record<string, unknown>>;
  /** What applying it does to the world. */
  readonly apply: () => void;
}

/**
 * A change's `before` and `after` as `terraform show -json` gives them: null where the
 * resource does not exist (before a create, after a delete), its attributes otherwise.
 */
function shownAttributes({ actions, before, after }: WorldChange) {
  const creates = actions.includes("create");
  const deletes = actions.includes("delete");
  return {
    before: creates && !deletes ? null : (before ?? {}),
    after: deletes && !creates ? null : (after ?? {}),
  };
}

export const NETWORK = "module.network.aws_vpc.this";
/** The VPC the world's network is, as EC2 lists it by the factory ID tag. */
export const NETWORK_VPC = "vpc-0123456789abcdef0";
export const SECRETS_POLICY = "module.host_identity.aws_iam_role_policy.read_secrets";

/**
 * The hosts' secret-reading policy document as `aws_iam_policy_document` renders it
 * (`assets/terraform/modules/host-identity`): a single resource as a string, several as a list.
 */
export function secretsPolicy(arns: readonly string[]): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadFactorySecrets",
        Effect: "Allow",
        Action: "secretsmanager:GetSecretValue",
        Resource: arns.length === 1 ? arns[0] : arns,
      },
    ],
  });
}

/**
 * The secrets the factory root lets hosts read, as `assets/terraform/factory/main.tf` builds
 * them: the Tailscale auth key, then every host's Paseo password, then the factory-wide
 * credentials, distinct.
 */
function secretArnsOf(variables: Readonly<Record<string, unknown>>): string[] {
  const passwords = (variables.paseo_password_secret_arns ?? {}) as Record<string, string>;
  const credentials = (variables.credential_secret_arns ?? {}) as Record<string, string>;
  return [
    ...new Set([
      String(variables.tailscale_auth_key_secret_arn),
      ...Object.values(passwords),
      ...Object.values(credentials),
    ]),
  ];
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((arn) => b.includes(arn));
export const hostAddress = (key: string) => `module.hosts.aws_instance.host["${key}"]`;
/** The root outputs the world's state records once applied, as the factory root declares them. */
export const ROOT_OUTPUTS = ["host_keys", "hosts", "network"] as const;
export const STATE_BUCKET_ADDRESS = "module.state_bucket.aws_s3_bucket.state";

/**
 * A factory's AWS world behind a Provisioner, so plan and apply can be tested against state
 * that changes: the state bucket (in `store`), the network and one host machine per host key.
 * The backend root plans creating the bucket. The factory root plans the network, a host per
 * declared key not yet provisioned and removing any provisioned key no longer declared,
 * `replace` forces a host's replacement and `resize` an in-place change of its instance type;
 * `output` records the provisioned keys once there is state. `showPlan` gives every change a
 * `before` and an `after`, as `terraform show -json` does: a host machine's `before` names the
 * instance its state holds (`instanceIds`, or one made up from its key). Given the resources
 * the hosts' secret-reading policy allows in the state (`secretArns`), it also plans that
 * policy's in-place update whenever the projected secrets differ, as Terraform renders it.
 * Applying a saved plan applies its changes one at a time, each written to the state (a new
 * revision in `store`), and runs `beforeChange` before each: a test can stop the apply part way
 * through by throwing there, as an interrupted Terraform does. A destroy plan
 * (`PlanRequest.destroy`) deletes the root outputs the state records (`ROOT_OUTPUTS`, in
 * `output_changes`) and every host machine and the network it holds; its network exists from
 * the start when `network` says so, as an empty factory's does once applied. Its apply deletes
 * the outputs first, before any resource, as Terraform 1.16.4 does: stopped part way, it leaves
 * resources and no output, never outputs alone; failing before its first change
 * (`beforeChange(0)` throwing), it leaves the outputs and resources as they were, as Terraform
 * does when it fails before it begins. The state records its root outputs from the start when
 * `rootOutputs` says so (by default, once the network exists), once a change other than a
 * destroy's is applied, and no longer once a destroy deleted them. A test makes a state that
 * records outputs but no resource directly, by clearing `hosts` and `network` and leaving
 * `rootOutputs`: its destroy plan deletes only those outputs.
 */
export function fakeFactoryWorld(options: {
  readonly store: { readonly buckets: Set<string>; readonly states: Map<string, string> };
  readonly bucket: string;
  readonly hosts?: readonly string[];
  /** The instance the state holds for a host key, by key. */
  readonly instanceIds?: Readonly<Record<string, string>>;
  /** The secrets the state's secret-reading policy allows; the policy is not modeled unless set. */
  readonly secretArns?: readonly string[];
  /** Whether the network exists; by default, once there are hosts. */
  readonly network?: boolean;
  /** Whether the state records the root outputs; by default, once the network exists. */
  readonly rootOutputs?: boolean;
}) {
  const hasNetwork = options.network ?? (options.hosts ?? []).length > 0;
  const world = {
    network: hasNetwork,
    /** Whether the state records the root outputs (`ROOT_OUTPUTS`). */
    rootOutputs: options.rootOutputs ?? hasNetwork,
    hosts: new Set(options.hosts ?? []),
    /** The instance the state holds for a host key; `i-<key>` unless set. */
    instanceIds: new Map(Object.entries(options.instanceIds ?? {})),
    /** The secrets the state's secret-reading policy allows, when it is modeled. */
    secretArns: options.secretArns,
    replace: new Set<string>(),
    resize: new Set<string>(),
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
  /** The root outputs each saved destroy plan deletes, by plan file; no other plan is here. */
  const destroyPlans = new Map<string, readonly string[]>();
  const calls: ProvisionerCall[] = [];

  /** Writes `change` to the state, which records the root outputs after any but a destroy's. */
  function write(change: () => void, destroying: boolean) {
    if (!destroying) world.rootOutputs = true;
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
    if (world.resize.has(key))
      return [
        {
          address,
          type: "aws_instance",
          actions: ["update"],
          before: { instance_type: "m7i.large" },
          after: { instance_type: "m7i.xlarge" },
          apply: () => world.resize.delete(key),
        },
      ];
    return [];
  }

  function policyChange(variables: Readonly<Record<string, unknown>>): WorldChange[] {
    const allowed = world.secretArns;
    if (allowed === undefined) return [];
    const projected = secretArnsOf(variables);
    if (sameSet(allowed, projected)) return [];
    const factory = String(variables.factory_id);
    const attributes = {
      id: `${factory}-host:${factory}-read-secrets`,
      name: `${factory}-read-secrets`,
      name_prefix: "",
      role: `${factory}-host`,
    };
    return [
      {
        address: SECRETS_POLICY,
        type: "aws_iam_role_policy",
        actions: ["update"],
        before: { ...attributes, policy: secretsPolicy(allowed) },
        after: { ...attributes, policy: secretsPolicy(projected) },
        apply: () => {
          world.secretArns = projected;
        },
      },
    ];
  }

  function factoryChanges(
    declared: readonly string[],
    variables: Readonly<Record<string, unknown>>,
  ): WorldChange[] {
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
      ...policyChange(variables),
      ...declared.flatMap(hostChange),
      ...removed.map((key) => ({
        address: hostAddress(key),
        type: "aws_instance",
        actions: ["delete"],
        before: { id: world.instanceIds.get(key) ?? `i-${key}`, instance_type: "t3.large" },
        apply: () => world.hosts.delete(key),
      })),
    ];
  }

  /** `plan -destroy`: every host machine and the network the state holds, deleted. */
  function destroyChanges(): WorldChange[] {
    const hosts = [...world.hosts].map((key) => ({
      address: hostAddress(key),
      type: "aws_instance",
      actions: ["delete"],
      before: { id: world.instanceIds.get(key) ?? `i-${key}`, instance_type: "t3.large" },
      apply: () => world.hosts.delete(key),
    }));
    const network = {
      address: NETWORK,
      type: "aws_vpc",
      actions: ["delete"],
      before: { id: NETWORK_VPC },
      apply: () => {
        world.network = false;
      },
    };
    return [...hosts, ...(world.network ? [network] : [])];
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

  /**
   * Saves `changes` as the plan at `planFile`, a destroy's (`destroying`) also deleting the root
   * outputs the state records. Whether it changes anything, as -detailed-exitcode reports it: a
   * root output change is a change too.
   */
  function save(planFile: string, changes: readonly WorldChange[], destroying: boolean): boolean {
    const outputs = destroying && world.rootOutputs ? ROOT_OUTPUTS : [];
    plans.set(planFile, changes);
    if (destroying) destroyPlans.set(planFile, outputs);
    else destroyPlans.delete(planFile);
    return changes.length > 0 || outputs.length > 0;
  }

  /**
   * The saved plan at `planFile`, taken to be applied: its state writes in order, a destroy's
   * root outputs deleted first, as Terraform deletes them before any resource, then its changes.
   */
  function take(planFile: string) {
    const changes = plans.get(planFile);
    if (changes === undefined) throw new Error(`no saved plan at ${planFile}`);
    const outputs = destroyPlans.get(planFile);
    plans.delete(planFile);
    destroyPlans.delete(planFile);
    const deleteOutputs = () => {
      world.rootOutputs = false;
    };
    return {
      writes: [
        ...((outputs ?? []).length > 0 ? [deleteOutputs] : []),
        ...changes.map((change) => change.apply),
      ],
      destroying: outputs !== undefined,
    };
  }

  const provisioner: Provisioner = {
    output: async (request) => {
      calls.push({ call: "output", request });
      failing("output");
      if (world.outputs !== undefined) return world.outputs;
      if (!world.rootOutputs) return {};
      return { host_keys: [...world.hosts].sort(), hosts: {} };
    },
    plan: async (request) => {
      calls.push({ call: "plan", request });
      failing("plan");
      const declared = Object.keys((request.variables.hosts ?? {}) as Record<string, unknown>);
      const changes =
        request.configuration.root === "backend"
          ? backendChanges()
          : request.destroy === true
            ? destroyChanges()
            : factoryChanges(declared, request.variables);
      const destroying = request.configuration.root === "factory" && request.destroy === true;
      return { changes: save(request.planFile, changes, destroying) };
    },
    showPlan: async (request) => {
      calls.push({ call: "showPlan", request });
      failing("showPlan");
      if (world.shown !== undefined) return world.shown;
      const outputs = destroyPlans.get(request.planFile) ?? [];
      return {
        format_version: "1.2",
        resource_changes: (plans.get(request.planFile) ?? []).map((change) => ({
          address: change.address,
          type: change.type,
          change: { actions: change.actions, ...shownAttributes(change), after_unknown: {} },
        })),
        ...(outputs.length === 0
          ? {}
          : {
              output_changes: Object.fromEntries(
                outputs.map((name) => [
                  name,
                  { actions: ["delete"], before: {}, after: null, after_unknown: false },
                ]),
              ),
            }),
      };
    },
    applyPlan: async (request) => {
      calls.push({ call: "applyPlan", request });
      failing("applyPlan");
      const { writes, destroying } = take(request.planFile);
      let applied = 0;
      for (const apply of writes) {
        world.beforeChange?.(applied);
        if (request.configuration.root === "backend") apply();
        else write(apply, destroying);
        applied += 1;
      }
    },
  };
  return { provisioner, calls, world, plans };
}
