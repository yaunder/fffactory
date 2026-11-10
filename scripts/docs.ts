import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";

const REPOSITORY = "https://github.com/yaunder/fffactory";
const ROOT = resolve(import.meta.dir, "..");

interface Source {
  source: string;
  slug: string;
  title: string;
  group: string;
  split?: boolean;
}

interface Heading {
  level: number;
  id: string;
  label: string;
}

interface Page {
  source: string;
  file: string;
  title: string;
  group: string;
  html: string;
  headings: Heading[];
}

function escapeHtml(value: string): string {
  return Bun.escapeHTML(value);
}

function headings(html: string): Heading[] {
  return Array.from(html.matchAll(/<h([1-6]) id="([^"]+)">([\s\S]*?)<\/h\1>/g), (match) => ({
    level: Number(match[1]),
    id: match[2] ?? "",
    // The renderer already escaped entities; retain them when removing inline tags.
    label: (match[3] ?? "").replace(/<[^>]+>/g, ""),
  }));
}

function render(source: Source, markdown: string): Page[] {
  const html = Bun.markdown.html(markdown, { headings: { ids: true } });
  const sections = source.split ? html.split(/(?=<h2 id=")/) : [html];
  return sections.map((section, index) => {
    const heading = headings(section)[0];
    const split = index > 0 && heading;
    const content = split ? section.replace(/^<h2([^>]*)>(.*?)<\/h2>/s, "<h1$1>$2</h1>") : section;
    return {
      source: source.source,
      file: `${source.slug}${split ? `-${heading.id}` : ""}.html`,
      title: split ? heading.label : escapeHtml(source.title),
      group: source.group,
      html: content,
      headings: headings(content),
    };
  });
}

function pageIndex(pages: Page[]): Map<string, string> {
  const index = new Map<string, string>();
  const filenames = new Set<string>();
  for (const page of pages) {
    if (filenames.has(page.file)) throw new Error(`Duplicate documentation page: ${page.file}`);
    filenames.add(page.file);
    if (!index.has(page.source)) index.set(page.source, page.file);
    for (const heading of page.headings) {
      index.set(`${page.source}#${heading.id}`, `${page.file}#${heading.id}`);
    }
  }
  return index;
}

async function destination(root: string, page: Page, href: string, index: Map<string, string>) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return href;
  const url = new URL(href, `https://docs.invalid/${page.source}`);
  const source = decodeURIComponent(url.pathname.slice(1));
  const fragment = decodeURIComponent(url.hash);
  const key = `${source}${fragment}`;
  const local = index.get(key);
  if (local) {
    const [file, anchor] = local.split("#");
    return `${file}${url.search}${anchor ? `#${anchor}` : ""}`;
  }
  if (index.has(source)) throw new Error(`Broken fragment in ${page.source}: ${href}`);
  const target = await stat(join(root, source)).catch(() => null);
  if (!target) throw new Error(`Broken link in ${page.source}: ${href}`);
  const kind = target.isDirectory() ? "tree" : "blob";
  return `${REPOSITORY}/${kind}/main/${url.pathname.slice(1)}${url.search}${url.hash}`;
}

async function rewriteLinks(root: string, page: Page, index: Map<string, string>): Promise<string> {
  const links = new Set<string>();
  new HTMLRewriter()
    .on("a[href]", {
      element(element) {
        links.add(element.getAttribute("href") ?? "");
      },
    })
    .transform(page.html);
  const replacements = new Map<string, string>();
  for (const href of links) replacements.set(href, await destination(root, page, href, index));
  return new HTMLRewriter()
    .on("a[href]", {
      element(element) {
        const href = element.getAttribute("href") ?? "";
        element.setAttribute("href", replacements.get(href) ?? href);
      },
    })
    .transform(page.html);
}

function navigation(pages: Page[], current: Page): string {
  const groups = [...new Set(pages.map((page) => page.group))];
  return groups
    .map(
      (group) =>
        `<section class="nav-group"><h2>${escapeHtml(group)}</h2><ul>${pages
          .filter((page) => page.group === group)
          .map(
            (page) =>
              `<li><a href="${page.file}"${page === current ? ' aria-current="page"' : ""}>${page.title}</a></li>`,
          )
          .join("")}</ul></section>`,
    )
    .join("");
}

function outline(page: Page): string {
  return `<ul>${page.headings
    .filter((heading) => heading.level === 2 || heading.level === 3)
    .map(
      (heading) =>
        `<li class="level-${heading.level}"><a href="#${heading.id}">${heading.label}</a></li>`,
    )
    .join("")}</ul>`;
}

function pagination(pages: Page[], index: number): string {
  return [
    [pages[index - 1], "Previous"],
    [pages[index + 1], "Next"],
  ]
    .map(([value, label]) => {
      const page = value as Page | undefined;
      return page
        ? `<a href="${page.file}"><span>${label}</span>${page.title}<b aria-hidden="true">${label === "Next" ? "→" : "←"}</b></a>`
        : "<span></span>";
    })
    .join("");
}

function diagrams(html: string, source: string): string {
  return html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    `<details class="diagram"><summary>Workflow diagram source</summary><pre><code>$1</code></pre><a href="${source}">View the rendered diagram on GitHub ↗</a></details>`,
  );
}

/** Render selected repository docs without loading application code or account state. */
export async function buildDocs(root = ROOT, output = join(root, "dist/docs")): Promise<number> {
  const sources: Source[] = JSON.parse(await readFile(join(root, "site/pages.json"), "utf8"));
  const pages: Page[] = [];
  for (const source of sources) {
    pages.push(...render(source, await readFile(join(root, source.source), "utf8")));
  }
  const index = pageIndex(pages);
  const template = await readFile(join(root, "site/layout.html"), "utf8");
  const rendered = [];
  for (const [position, page] of pages.entries()) {
    const source = `${REPOSITORY}/blob/main/${page.source}`;
    const values: Record<string, string> = {
      title: page.title,
      group: escapeHtml(page.group),
      content: diagrams(await rewriteLinks(root, page, index), source),
      navigation: navigation(pages, page),
      outline: outline(page),
      pagination: pagination(pages, position),
      source,
    };
    rendered.push({
      file: page.file,
      html: template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const value = values[key];
        if (value === undefined) throw new Error(`Unknown layout field: ${key}`);
        return value;
      }),
    });
  }
  // Validate all content before replacing the previous successful build.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const page of rendered) await writeFile(join(output, page.file), page.html);
  for (const asset of ["style.css", "site.js"]) {
    await copyFile(join(root, "site", asset), join(output, asset));
  }
  return pages.length;
}

if (import.meta.main) {
  const count = await buildDocs();
  console.log(`Built ${count} documentation pages in dist/docs/`);
  if (Bun.argv.includes("--serve")) {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(process.env.DOCS_PORT ?? 4321),
      async fetch(request) {
        const path = decodeURIComponent(new URL(request.url).pathname);
        const name = path === "/" ? "index.html" : path.slice(1);
        if (posix.basename(name) !== name) return new Response("Not found", { status: 404 });
        const file = Bun.file(join(ROOT, "dist/docs", name));
        return (await file.exists())
          ? new Response(file, { headers: { "Cache-Control": "no-store" } })
          : new Response("Not found", { status: 404 });
      },
    });
    console.log(`Documentation preview: ${server.url}`);
  }
}
