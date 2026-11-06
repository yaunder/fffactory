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
import { type HostWork, workerWork } from "./work";
import type { HostCollector } from "./collection";

export interface WorkerEndpoint
  extends HostInspector,
    HostApplier,
    HostVerifier,
    HostRepositories,
    HostControlPlane,
    HostDispatch,
    HostWork,
    HostCollector {
  /** Whether this process runs as root, as `host apply` and `host verify` need. */
  isRoot(): boolean;
}

/** `collector` is the log archive's (`collection.ts`), over a system of its own. */
export function workerEndpoint(system: ApplySystem, collector: HostCollector): WorkerEndpoint {
  const inspector = workerInspector(system);
  const verifier = workerVerifier(system);
  const applier = workerApplier(system, verifier);
  const repositories = workerRepositories(system);
  const controlPlane = workerControlPlane(system);
  const dispatch = workerDispatch(system);
  const work = workerWork(system);
  return {
    inspect: () => inspector.inspect(),
    apply: () => applier.apply(),
    verify: () => verifier.verify(),
    inspectRepositories: () => repositories.inspectRepositories(),
    reconcileRepositories: () => repositories.reconcileRepositories(),
    activity: () => controlPlane.activity(),
    agents: () => controlPlane.agents(),
    install: () => controlPlane.install(),
    reload: () => controlPlane.reload(),
    restart: () => controlPlane.restart(),
    adoption: () => dispatch.adoption(),
    reconcileDispatch: () => dispatch.reconcileDispatch(),
    inspectDispatch: () => dispatch.inspectDispatch(),
    inspectWork: () => work.inspectWork(),
    collect: () => collector.collect(),
    isRoot: system.isRoot,
  };
}
