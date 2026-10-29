# Documentation site

The user documentation is a static website built from repository Markdown with
Bun 1.4.2's built-in Markdown converter. It adds no package dependencies. Bun's
Markdown API is unstable; check the generated site when updating the Bun pin.

## Build and preview

`just docs-build` (or `bun run docs:build`) writes `dist/docs/`. The build reads
only repository files, requires no network or factory state, and fails for broken
links or fragments between published pages. `just docs-serve` builds the site and
serves it on `http://127.0.0.1:4321` (`DOCS_PORT` overrides the port). Rebuild
after editing content, then refresh.

`site/pages.json` explicitly selects and orders content. Markdown remains the
canonical source; pages marked `split` become one page per level-two section plus
an introduction. Heading IDs are generated before splitting, so repeated headings
retain distinct anchors. Fragment links, including links across split sections,
resolve to their destination page. Files outside the selection link to GitHub.

All site URLs are relative so the output works at `/` or a GitHub Pages project
path such as `/fffactory/`. Only the generated directory is a deployment artifact;
building does not publish it or enable GitHub Pages. The CLI validation workflow
builds the docs to catch navigation regressions before merge.

## Reading experience

The shared HTML layout has left navigation, central content, and a right-hand
outline derived from level-two and level-three headings. On small screens the
outline is hidden and navigation is a collapsible native details element. Content
and navigation work without JavaScript. The optional browser script collapses
the mobile menu initially, highlights the current section, and adds copy buttons
to code samples. Copy failures report failure rather than success.

Markdown tables, code fences, inline formatting and heading anchors are preserved.
Mermaid diagrams remain available as expandable source with a link to GitHub's
rendered version; the site does not load a diagram runtime. Repository authors
control the Markdown, including any embedded HTML. This is not an untrusted-content
publishing service.

## Maintenance boundary

Keep the build limited to source selection, conversion, link resolution, a shared
template, and static assets. Search, versioned documentation, and localization
are outside the initial scope; reconsider an existing site generator if those
become requirements.

Behavior is checked by `tests/scripts/docs.test.ts`, including split-page links,
duplicate headings, project-path portability, and broken-link failures. Visual
changes also need a desktop and narrow-screen preview.
