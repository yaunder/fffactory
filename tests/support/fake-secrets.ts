import type { OperatorPrompt } from "../../src/application/operator-prompt";
import type {
  SecretChange,
  SecretDescription,
  SecretListing,
  SecretListRequest,
  SecretLookup,
  SecretPresence,
  SecretRemoval,
  SecretStore,
  SecretWrite,
} from "../../src/application/secret-store";
import type { SecretReference } from "../../src/domain/instance";
import {
  type ListedSecret,
  refersTo,
  SecretMaterial,
  secretRegion,
} from "../../src/domain/secrets";

/**
 * SecretStore keeping secrets in memory by name, as Secrets Manager would: the first write
 * creates the secret and its ARN, later writes add a value to it. Records each write with
 * the revealed value, so tests can prove the material reached the store and nowhere else.
 * `read` answers a reference with its value in `values`, and rejects for any other, or with
 * `readFailsWith`; each read is recorded. `list` answers `listing` (none by default), `restore`
 * answers `restored` (`done` by default), `describe` answers `described` (`absent` by default),
 * and `remove` and `exists` answer `removed` and `presence` in order, the last answer repeating
 * (`done` and `absent` by default); each of these calls is recorded in `calls`, as
 * `OPERATION ARN-or-factory-ID`.
 */
export function fakeSecretStore(
  options: {
    failWith?: Error;
    values?: Readonly<Record<string, string>>;
    readFailsWith?: Error;
    listing?: SecretListing;
    restored?: SecretChange;
    removed?: SecretRemoval | readonly SecretRemoval[];
    presence?: readonly SecretPresence[];
    described?: SecretDescription;
  } = {},
) {
  const writes: (Omit<SecretWrite, "material"> & { value: string })[] = [];
  const reads: SecretLookup[] = [];
  const calls: string[] = [];
  const lookups: (SecretLookup | SecretListRequest)[] = [];
  const arns = new Map<string, SecretReference>();
  const presence = [...(options.presence ?? [{ kind: "absent" }])];
  const removals: SecretRemoval[] =
    options.removed === undefined
      ? [{ kind: "done" }]
      : "kind" in options.removed
        ? [options.removed]
        : [...options.removed];
  const next = <T>(answers: T[]): T | undefined =>
    answers.length > 1 ? answers.shift() : answers[0];
  const record = (operation: string, request: SecretLookup | SecretListRequest) => {
    calls.push(`${operation} ${"reference" in request ? request.reference : request.factoryId}`);
    lookups.push(request);
  };
  const store: SecretStore = {
    list: async (request) => {
      record("list", request);
      return options.listing ?? { kind: "listed", secrets: [] };
    },
    restore: async (request) => {
      record("restore", request);
      return options.restored ?? { kind: "done" };
    },
    remove: async (request) => {
      record("remove", request);
      return next(removals) ?? { kind: "done" };
    },
    describe: async (request) => {
      record("describe", request);
      return options.described ?? { kind: "absent" };
    },
    exists: async (request) => {
      record("exists", request);
      return next(presence) ?? { kind: "absent" };
    },
    read: async (request) => {
      reads.push(request);
      if (options.readFailsWith) throw options.readFailsWith;
      const value = options.values?.[request.reference];
      if (value === undefined)
        throw new Error(
          "Reading the secret from Secrets Manager failed: ResourceNotFoundException",
        );
      return new SecretMaterial(value);
    },
    write: async ({ material, ...request }) => {
      if (options.failWith) throw options.failWith;
      writes.push({ ...request, value: material.reveal() });
      const existing = arns.get(request.name);
      if (existing) return { arn: existing, created: false };
      const arn =
        `arn:aws:secretsmanager:${request.region}:123456789012:secret:${request.name}-AbCdEf` as SecretReference;
      arns.set(request.name, arn);
      return { arn, created: true };
    },
  };
  return { store, writes, reads, arns, calls, lookups };
}

/**
 * OperatorPrompt answering from a script and recording every question. `answers` feed
 * `ask` and `askHidden` in order (undefined: input ended); `input` is standard input.
 */
export function fakePrompt(
  options: { interactive?: boolean; answers?: (string | undefined)[]; input?: string } = {},
) {
  const asked: string[] = [];
  const hidden: string[] = [];
  const limits: number[] = [];
  const answers = [...(options.answers ?? [])];
  const prompt: OperatorPrompt = {
    interactive: options.interactive ?? false,
    ask: async (question) => {
      asked.push(question);
      return answers.shift();
    },
    askHidden: async (question) => {
      hidden.push(question);
      return answers.shift();
    },
    readInput: async (limit) => {
      limits.push(limit);
      const input = options.input ?? "";
      return new TextEncoder().encode(input).length > limit ? undefined : input;
    },
  };
  return { prompt, asked, hidden, limits };
}

/**
 * Secrets Manager as a world that teardown's calls change, so a rerun sees what the run before
 * it left: `list` answers the secrets still there (or `listing`'s failure), `read` the value in
 * `values` of one there and not pending deletion, `restore` cancels a pending deletion, `remove`
 * deletes one (a pending one is refused as invalid, a missing one succeeds, as a forced deletion
 * does), and `describe` and `exists` find one still there, by its full or partial ARN, only when
 * asked in the Region its ARN names: asked anywhere else, Secrets Manager finds nothing, which
 * proves nothing. A test changes the world between runs through the mutable `removeFails`
 * (`remove`'s answer by ARN), `restoreFails` (`restore`'s), `describeFails` (`describe`'s),
 * `unlisted` (ARNs `list` leaves out though they are there, as ListSecrets may for a while after
 * a change) and `lingering` (ARNs a deletion leaves pending, still found, as a deletion not yet
 * done), and `finishDeletion`, which ends one such deletion. Every call is recorded in `calls`,
 * as `fakeSecretStore` records them.
 */
export function fakeSecretsManager(
  options: {
    secrets?: readonly ListedSecret[];
    values?: Readonly<Record<string, string>>;
    listing?: Extract<SecretListing, { kind: "failed" }>;
  } = {},
) {
  let secrets = [...(options.secrets ?? [])];
  const calls: string[] = [];
  const removeFails = new Map<string, SecretRemoval>();
  const restoreFails = new Map<string, SecretChange>();
  const describeFails = new Map<string, Extract<SecretDescription, { kind: "failed" }>>();
  const unlisted = new Set<string>();
  const lingering = new Set<string>();
  // By its full ARN, or a partial one without the six characters Secrets Manager adds.
  const find = (reference: string) =>
    secrets.find(({ arn }) => refersTo(reference as SecretReference, arn));
  const record = (operation: string, reference: string) => calls.push(`${operation} ${reference}`);
  const replace = (reference: string, change: (secret: ListedSecret) => ListedSecret[]) => {
    secrets = secrets.flatMap((secret) => (secret.arn === reference ? change(secret) : [secret]));
  };
  const store: SecretStore = {
    list: async (request) => {
      calls.push(`list ${request.factoryId}`);
      return (
        options.listing ?? {
          kind: "listed",
          secrets: secrets.filter(({ arn }) => !unlisted.has(arn)),
        }
      );
    },
    read: async ({ reference }) => {
      const secret = find(reference);
      const value = options.values?.[reference];
      const failed = (name: string) =>
        new Error(`Reading the secret from Secrets Manager failed: ${name}`);
      if (secret === undefined || value === undefined) throw failed("ResourceNotFoundException");
      if (secret.pendingDeletion) throw failed("InvalidRequestException");
      return new SecretMaterial(value);
    },
    restore: async ({ reference }) => {
      record("restore", reference);
      const failure = restoreFails.get(reference);
      if (failure !== undefined) return failure;
      if (find(reference) === undefined) return { kind: "absent" };
      replace(reference, (secret) => [{ ...secret, pendingDeletion: false }]);
      return { kind: "done" };
    },
    remove: async ({ reference }) => {
      record("remove", reference);
      const failure = removeFails.get(reference);
      if (failure !== undefined) return failure;
      if (find(reference)?.pendingDeletion)
        return {
          kind: "invalid",
          reason: "Secrets Manager DeleteSecret failed: InvalidRequestException",
        };
      replace(reference, (secret) =>
        lingering.has(reference) ? [{ ...secret, pendingDeletion: true }] : [],
      );
      return { kind: "done" };
    },
    describe: async ({ reference, region }) => {
      record("describe", reference);
      const failure = describeFails.get(reference);
      if (failure !== undefined) return failure;
      const secret = region === secretRegion(reference) ? find(reference) : undefined;
      return secret === undefined ? { kind: "absent" } : { kind: "found", secret };
    },
    exists: async ({ reference, region }) => {
      record("exists", reference);
      const found = region === secretRegion(reference) && find(reference) !== undefined;
      return found ? { kind: "present" } : { kind: "absent" };
    },
    write: async () => {
      throw new Error("teardown never writes a secret");
    },
  };
  /** Secrets Manager finishes deleting a secret a deletion left lingering: it is gone. */
  const finishDeletion = (reference: string) => {
    lingering.delete(reference);
    replace(reference, (secret) => (secret.pendingDeletion ? [] : [secret]));
  };
  return {
    store,
    calls,
    removeFails,
    restoreFails,
    describeFails,
    unlisted,
    lingering,
    finishDeletion,
    secrets: () => secrets,
  };
}
