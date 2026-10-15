# src/cli/presentation: human output

The text a person reads, laid out from the data use cases return
(`docs/specs/cli-output.md`). Rules:

- Lay human output out here, never in `domain/` or `application/`, and never in a
  command beyond choosing what to render. Published JSON wording stays where it is made
  (`src/CLAUDE.md` §Rules).
- Build restyled output from `blocks.ts` and `render` it (`renderInSection` for blocks streamed
  into a section, `renderNextParts` for a Next block's parts on two streams) in the `Style` its stream's writer carries (`context.out.style`,
  `context.err.style`). Never write escape sequences or call `styleText` outside `style.ts`;
  never a background color.
- Whether a stream is colored is `color.ts`'s rule alone, applied once in `cli/main.ts`.
  Nothing here reads `process`, `isTTY` or the environment.
- Never style JSON: a `--json` document is written as serialized.
- Every status keeps its glyph in plain output, plain output keeps `$ ` and backticks, and
  widths are measured with `Bun.stringWidth`, never `.length` or `padEnd` on styled text.
- Backticks in a bare string span mark inline code: only in fffactory's own words. Data
  (a configuration value, a path, a lock's holder) goes in a `verbatim` span, never read for
  backticks (`docs/specs/cli-output.md` §Layout blocks).
- A render takes at most one Next block and prints it last; a command that leaves work for the
  operator ends with one. An `fffactory` command it names, or a row names as inline code (a
  `code` span), is built with `fffactoryCommand` (`command-line.ts`), repeating the
  `--instance` and `--profile` the running command was given, never by hand.
- A report whose lines go to both streams (apply's Result and Next block) is laid out here as
  lines, each for its stream (`StreamLine`, `apply.ts`), and the command writes them in order:
  routing which line goes where is layout, never the command's (`docs/specs/cli-output.md` §Two
  streams). Each line, a Next block's step included, keeps the stream its origin always used,
  whatever the exit code; restyling never moves a line between the streams.
- Tests (`tests/cli/presentation/`) are pure: exact plain text, and escape sequences pinned
  per role under `ansiStyle`.
