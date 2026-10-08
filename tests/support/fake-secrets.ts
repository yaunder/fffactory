import type { OperatorPrompt } from "../../src/application/operator-prompt";
import type { SecretStore, SecretWrite } from "../../src/application/secret-store";
import type { SecretReference } from "../../src/domain/instance";

/**
 * SecretStore keeping secrets in memory by name, as Secrets Manager would: the first write
 * creates the secret and its ARN, later writes add a value to it. Records each write with
 * the revealed value, so tests can prove the material reached the store and nowhere else.
 */
export function fakeSecretStore(options: { failWith?: Error } = {}) {
  const writes: (Omit<SecretWrite, "material"> & { value: string })[] = [];
  const arns = new Map<string, SecretReference>();
  const store: SecretStore = {
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
  return { store, writes, arns };
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
