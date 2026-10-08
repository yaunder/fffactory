/**
 * Terraform's `templatefile` for the subset of the template language the bootstrap template
 * uses, so tests can render it without Terraform: `${name}` interpolates a string variable,
 * `$${` and `%%{` are the literal `${` and `%{`, and every other character is literal.
 * Anything else, a directive (`%{`), a strip marker (`~`), an expression other than a bare
 * variable name, or a variable that is not passed, throws rather than render differently from
 * Terraform. `scripts/terraform-check.ts` compares this rendering with Terraform's own.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every variable name the template interpolates, in order of first use. */
export function templateVariables(template: string): string[] {
  const names: string[] = [];
  renderTemplate(template, (name) => {
    if (!names.includes(name)) names.push(name);
    return "";
  });
  return names;
}

/** An escape, an interpolation (perhaps unterminated) or a directive's opening. */
const TOKEN = /\$\$\{|%%\{|\$\{([^}]*)\}?|%\{/g;

function passed(variables: Readonly<Record<string, string>>): (name: string) => string {
  return (name) => {
    if (!Object.hasOwn(variables, name))
      throw new Error(`The template uses \${${name}}, which is not passed`);
    return variables[name] as string;
  };
}

/** Renders `template` with `variables`, as `templatefile(path, variables)` would. */
export function renderTemplate(
  template: string,
  variables: Readonly<Record<string, string>> | ((name: string) => string),
): string {
  const lookup = typeof variables === "function" ? variables : passed(variables);
  return template.replace(TOKEN, (token: string, inner: string | undefined, offset: number) => {
    if (token === "$${" || token === "%%{") return `${token[0]}{`;
    if (token.endsWith("}") && inner !== undefined && NAME.test(inner)) return lookup(inner);
    const kind = token.startsWith("%") ? "directive" : "interpolation";
    throw new Error(`Unsupported template ${kind} at offset ${offset}`);
  });
}
