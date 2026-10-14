# src/cli/presentation: human output

The text a person reads, laid out from the data use cases return
(`docs/specs/cli-output.md`). Rules:

- Lay human output out here, never in `domain/` or `application/`, and never in a
  command beyond choosing what to render. Published JSON wording stays where it is made
  (`src/CLAUDE.md` §Rules).
- Build restyled output from `blocks.ts` and `render` it (`renderInSection` for blocks streamed
  into a section) in the `Style` its stream's writer carries (`context.out.style`,
  `context.err.style`). Never write escape sequences or call `styleText` outside `style.ts`;
  never a background color.
- Whether a stream is colored is `color.ts`'s rule alone, applied once in `cli/main.ts`.
  Nothing here reads `process`, `isTTY` or the environment.
- Never style JSON: a `--json` document is written as serialized.
- Every status keeps its glyph in plain output, plain output keeps `$ ` and backticks, and
  widths are measured with `Bun.stringWidth`, never `.length` or `padEnd` on styled text.
- A render takes at most one Next block and prints it last; a command that leaves work for the
  operator ends with one.
- Tests (`tests/cli/presentation/`) are pure: exact plain text, and escape sequences pinned
  per role under `ansiStyle`.
