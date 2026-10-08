/**
 * A worker's side of every `fffactory host` subcommand, over the worker `system` describes:
 * `cli/main.ts` makes this machine's from `localWorkerSystem`; tests lay one out.
 */
import { type ApplySystem, type HostApplier, workerApplier } from "./apply";
import { type HostInspector, workerInspector } from "./inspect";
import { type HostVerifier, workerVerifier } from "./verify";
import { type HostRepositories, workerRepositories } from "./repositories";
import { type HostControlPlane, workerControlPlane } from "./control-plane";
import { type HostDispatch, workerDispatch } from "./dispatch";

export interface WorkerEndpoint
  extends HostInspector,
    HostApplier,
    HostVerifier,
    HostRepositories,
    HostControlPlane,
    HostDispatch {
  /** Whether this process runs as root, as `host apply` and `host verify` need. */
  isRoot(): boolean;
}

export function workerEndpoint(system: ApplySystem): WorkerEndpoint {
  const inspector = workerInspector(system);
  const verifier = workerVerifier(system);
  const applier = workerApplier(system, verifier);
  const repositories = workerRepositories(system);
  const controlPlane = workerControlPlane(system);
  const dispatch = workerDispatch(system);
  return {
    inspect: () => inspector.inspect(),
    apply: () => applier.apply(),
    verify: () => verifier.verify(),
    inspectRepositories: () => repositories.inspectRepositories(),
    reconcileRepositories: () => repositories.reconcileRepositories(),
    activity: () => controlPlane.activity(),
    install: () => controlPlane.install(),
    reload: () => controlPlane.reload(),
    restart: () => controlPlane.restart(),
    adoption: () => dispatch.adoption(),
    reconcileDispatch: () => dispatch.reconcileDispatch(),
    inspectDispatch: () => dispatch.inspectDispatch(),
    isRoot: system.isRoot,
  };
}
