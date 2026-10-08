/**
 * Small, dependency-free rule combinators for validating untyped JSON documents.
 * Rules collect every issue with its field path. Messages never echo the value,
 * so a secret pasted into the wrong field cannot leak through validation output.
 */

export interface Issue {
  readonly path: string;
  readonly message: string;
}

export type Rule = (value: unknown, path: string, issues: Issue[]) => void;

export const ROOT = "(root)";

export function fieldPath(parent: string, name: string): string {
  return parent === ROOT ? name : `${parent}.${name}`;
}

export function itemPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(predicate: (value: string) => boolean, message: string): Rule {
  return (value, path, issues) => {
    if (typeof value !== "string") issues.push({ path, message: "must be a string" });
    else if (!predicate(value)) issues.push({ path, message });
  };
}

export function pattern(expression: RegExp, message: string): Rule {
  return text((value) => expression.test(value), message);
}

export const nonEmptyText: Rule = text((value) => value.trim().length > 0, "must not be empty");

export const boolean: Rule = (value, path, issues) => {
  if (typeof value !== "boolean") issues.push({ path, message: "must be a boolean" });
};

export function integer(min: number, max: number): Rule {
  return (value, path, issues) => {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      issues.push({ path, message: `must be an integer from ${min} to ${max}` });
    }
  };
}

export function literal(expected: number): Rule {
  return (value, path, issues) => {
    if (value !== expected) issues.push({ path, message: `must be ${expected}` });
  };
}

export function arrayOf(item: Rule): Rule {
  return (value, path, issues) => {
    if (!Array.isArray(value)) {
      issues.push({ path, message: "must be an array" });
      return;
    }
    value.forEach((element, index) => {
      item(element, itemPath(path, index), issues);
    });
  };
}

/** An object with known fields only; `required` names fields that must be present. */
export function object(fields: Record<string, Rule>, required: readonly string[] = []): Rule {
  return (value, path, issues) => {
    if (!isRecord(value)) {
      issues.push({ path, message: "must be an object" });
      return;
    }
    const unknown = Object.keys(value).filter((name) => !Object.hasOwn(fields, name));
    for (const name of unknown) {
      issues.push({ path: fieldPath(path, name), message: "is not a recognized field" });
    }
    for (const [name, rule] of Object.entries(fields)) {
      checkField(value[name], fieldPath(path, name), rule, required.includes(name), issues);
    }
  };
}

function checkField(value: unknown, path: string, rule: Rule, required: boolean, issues: Issue[]) {
  if (value !== undefined) rule(value, path, issues);
  else if (required) issues.push({ path, message: "is required" });
}

/** Reports every entry whose key repeats an earlier entry's key. */
export function duplicateKeys(
  entries: readonly { readonly key: string; readonly path: string }[],
  describe: (key: string) => string,
  issues: Issue[],
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) issues.push({ path: entry.path, message: describe(entry.key) });
    seen.add(entry.key);
  }
}
