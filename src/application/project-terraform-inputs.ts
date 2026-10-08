/**
 * Projects factory.json into the input variables of the shipped Terraform root modules
 * (`assets/terraform/factory` and `assets/terraform/backend`). The projection exists only in
 * memory and in the operation's private inputs file: it is never written where anyone could
 * edit it, so factory.json stays the only editable desired state. Secrets appear only as the
 * references factory.json holds.
 */
import {
  assessCompleteness,
  type FactoryId,
  type FactoryInstance,
  type Issue,
} from "../domain/instance";
import { stateBucketSuffix } from "../domain/resource-naming";
import { checkStableHostKeys } from "../domain/stable-host-keys";

/** A host's machine declaration, as the `hosts` variable of the factory root module takes it. */
export interface HostMachine {
  readonly instance_type: string;
  readonly root_volume_gib: number;
}

/** The variables of the factory root module, `assets/terraform/factory/variables.tf`. */
export interface FactoryVariables {
  readonly factory_id: string;
  readonly account_id: string;
  readonly region: string;
  readonly availability_zone: string;
  readonly vpc_cidr: string;
  readonly public_subnet_cidr: string;
  readonly tailscale_auth_key_secret_arn: string;
  /** The tag every host advertises when it enrolls in Tailscale. */
  readonly tailscale_tag: string;
  /** By host key, for hosts that declare a Paseo password reference. */
  readonly paseo_password_secret_arns: Readonly<Record<string, string>>;
  readonly hosts: Readonly<Record<string, HostMachine>>;
}

/** The variables of the backend root module, `assets/terraform/backend/variables.tf`. */
export interface BackendVariables {
  readonly factory_id: string;
  readonly account_id: string;
  readonly region: string;
  /** `state_backend.bucket` after the factory ID and a hyphen. */
  readonly state_bucket_suffix: string;
}

export type Projection<T> =
  | { readonly ok: true; readonly variables: T }
  | { readonly ok: false; readonly issues: readonly Issue[] };

function required(paths: readonly string[]): Issue[] {
  return paths.map((path) => ({ path, message: "is required to plan" }));
}

const BUCKET_ISSUE: Issue = {
  path: "state_backend.bucket",
  message: "must start with the factory ID and a hyphen, so its name carries the factory ID",
};

/**
 * The factory root module's variables. Refused, with every issue, unless the instance is
 * complete and still declares every host key the factory's state records (`recordedHostKeys`,
 * the state's `host_keys` output; empty before the first apply), which the plan use case reads
 * with `Provisioner.output` (`planInfrastructure`).
 */
export function projectFactoryVariables(
  instance: FactoryInstance,
  recordedHostKeys: readonly string[],
): Projection<FactoryVariables> {
  const issues = [
    ...required(assessCompleteness(instance).missing),
    ...checkStableHostKeys(recordedHostKeys, instance),
  ];
  if (issues.length > 0) return { ok: false, issues };
  const complete = instance as Required<FactoryInstance>;
  const hosts = complete.hosts;
  return {
    ok: true,
    variables: {
      factory_id: complete.factory_id,
      account_id: complete.aws.account_id as string,
      region: complete.aws.region as string,
      availability_zone: complete.network.availability_zone as string,
      vpc_cidr: complete.network.vpc_cidr as string,
      public_subnet_cidr: complete.network.public_subnet_cidr as string,
      tailscale_auth_key_secret_arn: complete.tailscale.auth_key_secret as string,
      tailscale_tag: complete.tailscale.tag as string,
      paseo_password_secret_arns: Object.fromEntries(
        hosts.flatMap((host) =>
          host.paseo_password_secret === undefined ? [] : [[host.key, host.paseo_password_secret]],
        ),
      ),
      hosts: Object.fromEntries(
        hosts.map((host) => [
          host.key,
          {
            instance_type: host.instance_type as string,
            root_volume_gib: host.root_volume_gib as number,
          },
        ]),
      ),
    },
  };
}

const BACKEND_FIELDS: readonly (readonly [string, (instance: FactoryInstance) => unknown])[] = [
  ["factory_id", (instance) => instance.factory_id],
  ["aws.account_id", (instance) => instance.aws?.account_id],
  ["aws.region", (instance) => instance.aws?.region],
  ["state_backend.bucket", (instance) => instance.state_backend?.bucket],
];

/**
 * The backend root module's variables: the state bucket's definition. Refused unless the
 * instance declares its factory ID, account, Region and a bucket carrying the factory ID.
 */
export function projectBackendVariables(instance: FactoryInstance): Projection<BackendVariables> {
  const missing = BACKEND_FIELDS.filter(([, read]) => read(instance) === undefined);
  if (missing.length > 0) return { ok: false, issues: required(missing.map(([path]) => path)) };
  const factoryId = instance.factory_id as FactoryId;
  const suffix = stateBucketSuffix(factoryId, instance.state_backend?.bucket as string);
  if (suffix === undefined) return { ok: false, issues: [BUCKET_ISSUE] };
  return {
    ok: true,
    variables: {
      factory_id: factoryId,
      account_id: instance.aws?.account_id as string,
      region: instance.aws?.region as string,
      state_bucket_suffix: suffix,
    },
  };
}
