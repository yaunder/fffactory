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
 * them: the Tailscale auth key, then every host's Paseo password, distinct.
 */
function secretArnsOf(variables: Readonly<Record<string, unknown>>): string[] {
  const passwords = (variables.paseo_password_secret_arns ?? {}) as Record<string, string>;
  return [
    ...new Set([String(variables.tailscale_auth_key_secret_arn), ...Object.values(passwords)]),
  ];
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((arn) => b.includes(arn));
export const hostAddress = (key: string) => `module.hosts.aws_instance.host["${key}"]`;
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
 * policy's in-place update whenever the projected secrets differ, as Terraform renders it. Applying a saved plan applies its
 * changes one at a time, each written to the state (a new revision in `store`), and runs
 * `beforeChange` before each: a test can stop the apply part way through by throwing there,
 * as an interrupted Terraform does.
 */
export function fakeFactoryWorld(options: {
  readonly store: { readonly buckets: Set<string>; readonly states: Map<string, string> };
  readonly bucket: string;
  readonly hosts?: readonly string[];
  /** The instance the state holds for a host key, by key. */
  readonly instanceIds?: Readonly<Record<string, string>>;
  /** The secrets the state's secret-reading policy allows; the policy is not modeled unless set. */
  readonly secretArns?: readonly string[];
}) {
  const world = {
    network: (options.hosts ?? []).length > 0,
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
        request.configuration.root === "backend"
          ? backendChanges()
          : factoryChanges(declared, request.variables);
      plans.set(request.planFile, changes);
      return { changes: changes.length > 0 };
    },
    showPlan: async (request) => {
      calls.push({ call: "showPlan", request });
      failing("showPlan");
      if (world.shown !== undefined) return world.shown;
      return {
        format_version: "1.2",
        resource_changes: (plans.get(request.planFile) ?? []).map((change) => ({
          address: change.address,
          type: change.type,
          change: { actions: change.actions, ...shownAttributes(change), after_unknown: {} },
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
