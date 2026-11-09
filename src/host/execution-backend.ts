/**
 * The worker's execution backend (CONTEXT.md: the selected mechanism for hosting and supervising
 * runs on a worker), as far as fffactory asks it anything: making the placed checkouts available
 * for supervision in its own terms (`docs/specs/execution-backend.md` §The `ExecutionBackend`
 * contract). A worker-side seam, not an `application/` port: nothing on the operator side calls
 * it.
 */
import type { RepositoryRegistration } from "../domain/repository-registration";
import type { PaseoCommand } from "./control-plane";
import { paseoBackend } from "./paseo-backend";

export interface ExecutionBackend {
  /**
   * Makes each checkout (the absolute path of a placed checkout present on disk) available for
   * supervision. Only adds: never deletes, renames or archives anything the backend holds, and
   * never reloads or restarts it.
   */
  registerRepositories(checkouts: readonly string[]): Promise<RepositoryRegistration>;
}

/** The worker's execution backend: the one place it is chosen. */
// TODO(re-evaluate when a second execution backend adapter is built): select the backend from factory.json's hosts[].execution_backend
export function executionBackend(paseo: PaseoCommand): ExecutionBackend {
  return paseoBackend(paseo);
}
