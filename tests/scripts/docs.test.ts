// docs/specs/documentation-site.md §Build and preview.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDocs } from "../../scripts/docs";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fffactory-docs-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fixture(markdown: string) {
  const root = await mkdtemp(join(scratch, "repo-"));
  await cp(join(import.meta.dir, "../../site"), join(root, "site"), { recursive: true });
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "README.md"), markdown);
  await writeFile(
    join(root, "docs/guide.md"),
    "# Guide\n\n## Install\n\n[Continue](#install-1)\n\n## Install\n\n[Back](../README.md#home)\n\n### Details & choices\n\n```sh\necho hi\n```\n",
  );
  await writeFile(join(root, "example.json"), "{}");
  await writeFile(
    join(root, "site/pages.json"),
    JSON.stringify([
      { source: "README.md", slug: "index", title: "Home", group: "Guide" },
      { source: "docs/guide.md", slug: "guide", title: "Guide", group: "Guide", split: true },
    ]),
  );
  return { root, output: join(root, "dist/docs") };
}

test("renders Markdown, resolves split sections and keeps URLs relative to the deployed directory", async () => {
  const paths = await fixture(
    "# Home\n\n[Install](docs/guide.md#install-1)\n\n[Example](example.json)\n\n## Next\n\n| A | B |\n| - | - |\n| 1 | 2 |\n",
  );
  await buildDocs(paths.root, paths.output);
  const home = await readFile(join(paths.output, "index.html"), "utf8");
  expect(home).toContain('href="guide-install-1.html#install-1"');
  expect(home).toContain('href="https://github.com/yaunder/fffactory/blob/main/example.json"');
  expect(home).toContain("<table>");
  expect(home).toContain('aria-current="page"');
  expect(home).not.toMatch(/(?:href|src)="\//);
  const first = await readFile(join(paths.output, "guide-install.html"), "utf8");
  expect(first).toContain('href="guide-install-1.html#install-1"');
  const second = await readFile(join(paths.output, "guide-install-1.html"), "utf8");
  expect(second).toContain('<h1 id="install-1">Install</h1>');
  expect(second).toContain('href="index.html#home"');
  expect(second).toContain('href="#details-choices"');
  expect(second).toContain("Details &amp; choices");
  expect(second).not.toContain("&amp;amp;");
  expect(second).toContain('class="language-sh"');
});

test.each(["docs/guide.md#missing", "missing.md"])(
  "rejects a broken destination: %s",
  async (destination) => {
    const paths = await fixture(`# Home\n\n[Broken](${destination})`);
    await expect(buildDocs(paths.root, paths.output)).rejects.toThrow(/Broken/);
  },
);
