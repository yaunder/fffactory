import { RUNTIME_ACCOUNT } from "../domain/readiness";

/** The runtime account's home: its commands' HOME, and their working directory. */
export const FACTORY_HOME = `/home/${RUNTIME_ACCOUNT}`;

/**
 * How a command runs as the runtime account: `runuser`, then `env -i` so it gets exactly the
 * environment its agents get (its own tools first) and nothing of root's.
 */
export const AS_FACTORY = [
  "/usr/sbin/runuser",
  "-u",
  RUNTIME_ACCOUNT,
  "--",
  "/usr/bin/env",
  "-i",
  `HOME=${FACTORY_HOME}`,
  `PATH=${FACTORY_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
  "LANG=C.UTF-8",
  "DISABLE_UPDATES=1",
] as const;
