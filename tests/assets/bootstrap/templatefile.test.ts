// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Terraform template syntax, deliberately
import { describe, expect, test } from "bun:test";
import { renderTemplate, templateVariables } from "../../support/templatefile";

describe("the templatefile subset the bootstrap template is rendered with (worker-bootstrap §User data)", () => {
  test("interpolates passed variables and keeps every other character", () => {
    expect(renderTemplate("a='${a}' $b %c $ { % {", { a: "1" })).toBe("a='1' $b %c $ { % {");
  });

  test("$${ and %%{ are the literal ${ and %{", () => {
    expect(renderTemplate("$${HOME} %%{x} ${a}", { a: "1" })).toBe("${HOME} %{x} 1");
  });

  test("a variable that is not passed is an error, as in Terraform", () => {
    expect(() => renderTemplate("${missing}", {})).toThrow("${missing}, which is not passed");
  });

  test("directives, strip markers and expressions are refused rather than misrendered", () => {
    for (const template of ["%{ if a }x%{ endif }", "${~a}", "${a~}", "${a.b}", "${ a }", "${a"])
      expect(() => renderTemplate(template, { a: "1" })).toThrow("Unsupported template");
  });

  test("lists the variables a template uses, once each, in order", () => {
    expect(templateVariables("${b} $${c} ${a} ${b}")).toEqual(["b", "a"]);
  });
});
