# Documentation website

Keep content in the existing repository Markdown; `pages.json` selects and orders
the published sources. The build splits onboarding at level-two headings and
preserves heading IDs across pages. Layout and browser enhancements live here;
the Bun-only builder lives in `scripts/docs.ts`.

Run `just docs-build` after content or navigation changes: it checks links between
generated pages. Preview with `just docs-serve`. Generated files stay in
`dist/docs/`. See `docs/specs/documentation-site.md` before changing build behavior.
