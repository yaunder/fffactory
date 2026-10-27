# CLI output

How `fffactory` lays out and styles what it prints for a person: when each
output stream is colored, the style roles, and the layout blocks commands build
their human output from. JSON documents are data and follow none of it. Commands
adopt the blocks one by one (the plan review, apply and upgrade first, and
teardown and `worker inspect` from the start; epic #18 the rest), so a command
not yet restyled still prints its own lines, unstyled.

## Color

Each output stream, standard output and standard error, is colored or plain on
its own, decided once when `fffactory` starts, from the environment and that
stream's terminal status, in this order:

1. JSON serialization never uses styling, whatever the environment or stream:
   see [JSON](#json).
2. A non-empty `NO_COLOR`, or `TERM=dumb`, makes human output plain.
3. Otherwise `FORCE_COLOR=0` makes it plain.
4. Otherwise any other non-empty `FORCE_COLOR` colors it, even redirected.
5. Otherwise the stream is colored only when it is a terminal (TTY). An absent
   or empty variable never overrides this.

So **redirected human output is plain unless explicitly forced**: a pipe or a
file gets no escape sequences unless `FORCE_COLOR` asks for them. Standard
output redirected while standard error is a terminal colors only standard
error, and the reverse. There is no `--color` flag.

A stream's style travels with it: a command that sends its human lines to
standard error, as `status --json` does with its `Instance:` line, styles them
as standard error is styled.

## Plain output

Plain output has the same glyphs and words as colored output and no escape
sequence (`\x1b`) at all. It keeps the `$ ` before every command line and the
backticks around inline code, which color drops, so an agent reads it as
Markdown. Color is added on top and is never the only signal: every status has
its glyph in both modes.

Both streams' lines are written raw to their file descriptors through one ordered
queue, never through the runtime's console, whose own coloring would wrap them.
When a pipe fills, retries yield so signals and timers can run. Normal exit flushes
the queue with signal handlers still installed, preserving all output and its order,
even when both streams share a pipe. For commands that wait on interruption, reporting
and its output flush share the existing return grace; a second signal exits immediately.
Pending output is discarded at an interrupted exit, so an open pipe that never drains cannot
prevent tools from stopping or keep the CLI alive. Tested in `tests/cli/main.test.ts`,
`tests/cli/descriptor-lines.test.ts` and `tests/cli/descriptor-interrupted.test.ts`.

Prompt questions, typed echoes and newlines use the same ordered queue as report
lines. Before asking or reading an answer, the prompt flushes the complete preceding
review while input remains out of raw mode, so an undrained pipe remains interruptible.
If interrupted during that wait, the prompt accepts no answer and does not enter raw
mode. Tested by the real merged-pipe prompt in `tests/cli/descriptor-lines.test.ts`,
the undrained-pipe interruption cases and `tests/infrastructure/terminal-prompt.test.ts`.

## Style roles

| Role | Plain | Color |
| --- | --- | --- |
| Heading (a section's title) | as is | bold |
| Section rule | as is | dim |
| Label (a row's label or key) | as is | bold |
| Muted (notes) | as is | dim |
| Status `ready` | `✔` | green |
| Status `attention` | `!` | yellow |
| Status `error` | `✖` | red |
| Status `skipped` (for a known reason, a rerun completes it) | `↷` | yellow |
| Status `not_attempted` (after a failure) | `◌` | dim |
| Status `stopped` (an operator's intentional state, never an error) | `◼` | dim |
| Change `create`, `update`, `delete` | `+`, `~`, `-` | green, yellow, red |
| Command line | `$ COMMAND` | `$ ` dim, the command bold cyan |
| Inline code | `` `CODE` `` | cyan, without the backticks |
| Verdict | glyph and text | glyph and text bold, in the status's color |

A status colors its glyph, and any text the layout marks with it. Every glyph
takes one terminal column, even where a terminal treats a character's width as
ambiguous. No role uses a background color: backgrounds depend on the terminal's
theme and are ragged when a line wraps.

## Layout blocks

A command's human output is a sequence of blocks, separated by one blank line;
blocks nested in a section are separated the same way. Widths are measured in
terminal columns, ignoring escape sequences, so columns align in both modes.
Lines never end in spaces.

Text in any block may mark inline code with backticks: a matched pair is inline
code; an unmatched backtick is printed as it is. A command line is printed as it
is, backticks included.

Inline code marks only fffactory's own words, such as a command to run. Data,
such as a configuration value, a path or a lock's holder, is shown verbatim
(a `verbatim` span): its backticks are printed as they are in both modes, never
read as inline code, in the role of the text around it. An `fffactory` command
the presentation layer lays out as inline code is a code span built with
`fffactoryCommand`, so the instance path it repeats is never read for
backticks either. Tested in
`tests/cli/presentation/blocks.test.ts`, and for the data each lays out in the
`plan`, `lock`, `instance-source`, `workers`, `apply`, `teardown` and
`worker-inspection` tests beside it.

### Text

Lines printed as they are, each of which may mark spans as heading, label,
muted, inline code or a status.

```text
fffactory apply · release 0.0.0
Instance  ~/test-factory/.fffactory/factory.json (nearest .fffactory/factory.json)
```

### Section

A rule line with the section's title, 53 columns wide (`── `, the title, a
space, then `─` to the width, at least two), then its blocks indented two
spaces.

```text
── Plan ─────────────────────────────────────────────
  Factory   Test factory (fff-aaaa1111)
  Account   123456789012 · us-east-1
  Release   0.0.0
```

### Rows

Aligned label/value rows: each label is padded to the widest label in the
block, then three spaces, then its value. A block whose rows may be rendered
one at a time, such as progress, can fix the label width. When any row has a
status, every row has a status column: the glyph and a space, or as many
spaces, so labels still align. Both are fixed, never tuned per command: three
spaces keep the gap visible after a label that has spaces of its own, such as
`Operation record`, and reserving the status column keeps every label in one
column whether or not its row has a glyph. Where an example elsewhere spaces
rows differently, this rule governs.

```text
  Infrastructure   no changes
  Workers          one at a time
    ~ test-builder-1   install release 0.0.0 and host configuration, then verify
```

Rows streamed into a section, such as apply's progress, are printed one at a
time under its rule: the section rendered with no blocks prints the rule alone,
then each row block is rendered in the section (`renderInSection`), indented as
the section's own blocks are, with a fixed label width and either every row or
none with a status, or the status column reserved (`statusColumn`) for every
row, so the rows align. The lines are then those of the whole section rendered
at once.

```text
── Applying ─────────────────────────────────────────
  test-builder-1   uploading 35.3 MiB
  test-builder-1   installing and verifying (can take many minutes)
```

### Details

A row or a verdict may carry details: blocks indented two spaces under it, such
as the reasons of a refusal or the changes under a stage.

### Verdict

A statement of the outcome: its status's glyph, then its text, then any
details.

```text
✖ Refusing to apply: the saved plan is stale
  factory.json changed since the plan was made
```

### Next

What the operator does next, in the order to do it, under a section rule titled
`Next` or `Next: TITLE`. Its body is paragraphs separated by blank lines, each
of steps, numbered groups and notes:

- A step: its text, then its command lines indented two more spaces. A shared
  preamble, such as the one login every group needs, is a step said once.
- Numbered groups: `1.`, `2.`, … and a title, each group's command lines
  aligned under its title.
- A closing step, such as the command that confirms the result.
- A note: muted text.

```text
── Next: enroll 3 accounts on test-builder-1 ────────
  Log in as factory (tailnet SSH policy must allow it):
    $ tailscale ssh factory@fff-aaaa1111-test-builder-1

  1. GitHub
     $ gh auth login --hostname github.com --git-protocol https --web
     $ gh auth status --hostname github.com --active
  2. OpenAI Codex
     $ codex login --device-auth
     $ codex login status
  3. Claude Code
     $ claude auth login
     $ claude auth status

  Return to your workstation:
    $ exit
  Refresh enrollment verification, reviewing the new plan:
    $ fffactory apply
  Then confirm:
    $ fffactory status
  Paseo clients: enrollment is checked from each client, not the worker
```

#### The Next-block contract

A command restyled with these blocks that leaves work for the operator ends with
exactly one Next block, after its results and any operation-record or diagnostic
information. A render takes at most one Next block and always prints it last.
It collects what every part of the outcome leaves, each instruction once.

### Two streams

A report may write some lines on standard output and others on standard error,
as apply's Result does with a failed worker's row and its next action
([plan and apply §What apply prints](plan-apply.md#what-apply-prints)). It is
laid out as one report, each line for its stream, in its stream's style, and
written in order, so a terminal showing both reads it whole. Each line keeps
the stream its origin always used, whatever the exit status: restyling moves
no line between the streams. A section's rule goes to the stream of its first
block, the blank line before a block to that block's stream, and rows of one
block split between the streams keep one label width and status column. Its
one Next block is still last, and is laid out the same way: each step on its
origin's stream (`renderNextParts` renders it), a step several origins share
on standard error when any of them is, so it never leaves the stream an error
used, the Next rule on its first step's, and the blank line before a paragraph
on that paragraph's first step's. Tested in `tests/cli/presentation/apply.test.ts`,
`tests/cli/apply-stages.test.ts` and `tests/cli/plan-apply.test.ts`, each
stream alone and both in the order written.

## JSON

A `--json` document is never styled: it is written as it is serialized, the same
bytes whether its stream is a terminal, redirected or forced into color. Styles
apply only to human lines laid out by `src/cli/presentation/`.

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| CLI adapter | `src/cli/presentation/color.ts` | `colorEnabled` ([Color](#color)) and `streamStyles`, each stream's style. Pure: it is given the terminal status and environment. |
| CLI adapter | `src/cli/presentation/style.ts` | `Style` and its roles, `plainStyle`, `ansiStyle` (over `node:util` `styleText` with `validateStream: false`, so only [Color](#color) decides), the statuses and their glyphs, and `writer`, an output stream's line writer carrying its style. |
| CLI adapter | `src/cli/presentation/blocks.ts` | The layout blocks, `verbatim` (data in a line, never read for inline code), `step` and `nextSteps` (a Next block's parts), `Report` (an outcome's blocks and at most one Next block), `render`, which lays blocks and at most one Next block out as lines in a style, measuring widths with `Bun.stringWidth`, `renderInSection`, blocks streamed into a section, and `renderNextParts`, a Next block's parts rendered under its rule, for a Next block on two streams; a rows block's fixed `labelWidth` and reserved `statusColumn`. |
| CLI adapter | `src/cli/presentation/apply.ts` | A report on [two streams](#two-streams): apply's Result and Next block as lines, each for its stream (`StreamLine`), written by the command in order. |
| CLI adapter | `src/cli/presentation/teardown.ts` | Teardown's review, its steps streamed under a section, and each outcome as one report on one stream ([teardown §Output and exit codes](teardown.md#output-and-exit-codes)). |
| CLI adapter | `src/cli/presentation/worker-inspection.ts`, `src/cli/presentation/agents.ts` | `worker inspect`'s report: each worker's verdict and findings, its agents by state, a tally and one Next block, and its refusal of a `KEY` (`keyRefusalReport`) ([worker lifecycle §Inspect](worker-lifecycle.md#inspect)); a worker's agents in one line, also status's `Agents:` line, each state in the same words. |
| CLI adapter | `src/cli/presentation/command-line.ts` | `fffactoryCommand`: an `fffactory` command a Next block names, repeating the `--instance` and `--profile` the running command was given, each word quoted for a POSIX shell (`shellWord`) where needed; `withCommands`, the `fffactory` commands fffactory's own words name, as code spans built with it. |
| CLI adapter | `src/cli/context.ts` | `CliContext.out` and `err`, each a `Writer` carrying its stream's style. |
| CLI adapter | `src/cli/descriptor-lines.ts` | `descriptorOutput`, both streams' raw line writers and shared queue ([Plain output](#plain-output)). |
| CLI adapter | `src/cli/main.ts` | The one place reading each stream's `isTTY` and the environment to pick the styles. |
