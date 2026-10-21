import type { OperatorPrompt } from "../../src/application/operator-prompt";
import type {
  SecretChange,
  SecretListing,
  SecretListRequest,
  SecretLookup,
  SecretPresence,
  SecretRemoval,
  SecretStore,
  SecretWrite,
} from "../../src/application/secret-store";
import type { SecretReference } from "../../src/domain/instance";
import { SecretMaterial } from "../../src/domain/secrets";

/**
 * SecretStore keeping secrets in memory by name, as Secrets Manager would: the first write
 * creates the secret and its ARN, later writes add a value to it. Records each write with
 * the revealed value, so tests can prove the material reached the store and nowhere else.
 * `read` answers a reference with its value in `values`, and rejects for any other, or with
 * `readFailsWith`; each read is recorded. `list` answers `listing` (none by default), `restore`
 * answers `restored` (`done` by default), and `remove` and `exists` answer `removed` and
 * `presence` in order, the last answer repeating (`done` and `absent` by default); each of
 * these calls is recorded in `calls`, as `OPERATION ARN-or-factory-ID`.
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
