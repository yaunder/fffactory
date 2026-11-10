# Worker log archive: reader validation

Date: 2026-10-26. Phase 0 of the worker-log-archive roadmap. Answers the
reader items of the
[design's validation list](../designs/worker-log-archive.md#validation-required-before-implementation)
(item 5) for `fffactory logs`.

Sources:

- Local experiments with Bun 1.4.2 and headless Chrome on the operator's Mac.
- Synthetic transcripts.
- A read-only, aggregate-only inventory of the operator's local `~/.claude`.
- Desk review of this repository.

No conversation text or identifier values are recorded here. The archive
layout the reader consumes is in the
[collector findings](worker-log-archive-collector.md#3-storage-layout-and-permissions-item-4).

## Verdict

Embed a prebuilt plain TypeScript + DOM UI in the release binary as file
imports, and serve it from memory through one guarded `fetch` handler on
127.0.0.1. Then:

- Render conversations as windowed lists.
- Fetch tool output over a size threshold lazily.
- Build grouping from journal records, caching the index locally per factory.

## 1. Bundling the UI in the release (established)

**Embedding:**

- `import page from "./ui/index.html" with { type: "file" }` and similar
  imports, with the UI prebuilt by `Bun.build`, survive `bun build --compile`.
- `Bun.embeddedFiles` lists the embedded files.
- The size cost is linear and small: a 2 KB UI added 0 bytes (it fit within
  existing page padding), and a 1 MiB embed added 1,056,768 bytes.

**Don't use Bun HTML imports in `routes`.** They compile, but their static
routes bypass the request guard and cannot carry a Content-Security-Policy. In
the experiment, a wrong `Host` with no token still got 200.

**Framework:**

- Plain TS + DOM: 2.1 KB (1.1 KB gzipped). Recommended.
- Preact + htm: 14.7 KB (6.3 KB gzipped). The fallback if views grow.

**Packaging:** no Node, Bun or checkout is needed on the operator's machine.
How the UI build fits `scripts/build.ts` and the existing embedded asset
bundle is a Phase 2 design choice.

## 2. Local server access (established, 14 of 14 cases)

The guard:

- The `Host` header must be exactly `127.0.0.1:<port>`. This defeats DNS
  rebinding, and `localhost` is refused.
- `Origin` and `Sec-Fetch-Site` are checked.
- A per-run random token in the opened URL is exchanged for an `HttpOnly`,
  `SameSite=Strict` cookie.
- Only GET is served.

It refused:

- no token, or a wrong token;
- a wrong or rebinding `Host`;
- `localhost`;
- a foreign `Origin`;
- a same-site fetch;
- a POST.

Captured text is rendered as text nodes under a restrictive CSP, never as
HTML. The AWS credentials stay in the server process.

## 3. Rendering load (established on the local sample)

| Measure | Value |
| --- | --- |
| Transcripts / records / record types | 157 / 39,052 / 17 |
| Records per main transcript | p50 268, p95 883, max 1,229 |
| Largest transcript | 26.3 MB in 1,025 records; 95% of bytes are tool output stored twice |
| Largest single record | 1.26 MB |
| Tool-result block size | p50 1.3 KB, p99 37 KB, max 629 KB |
| Subagents | 15 of 63 sessions; p50 3, max 26 per session; depth ≤ 2 |
| Parse 26 MB transcript | 11 ms whole-file and 16 ms line-streamed in Bun; 30–60 ms streamed in Chrome |
| Full render, no windowing | 468 ms, ~1.6M px page |
| Tool output truncated at 8 KiB | 159 ms |
| Windowed list | ~56 DOM rows, < 1 ms per render |

The worker's own history is smaller per file (largest 3.75 MB) but larger in
total: 207 main and 365 subagent transcripts. Collection health and
attempt-level views must therefore scale with session count rather than file
size.

**Reading growing transcripts.** With append-delta capture, a long transcript
is a base blob plus many small chunks: about 480 over an 8-hour run at
one-minute cycles. Reconstruction details:

- Fetch chunks in parallel.
- Cut records only at newlines; an incomplete tail stays raw until the next
  chunk arrives.
- Refresh by listing new journal keys with `StartAfter`.

S3 latency for a 480-chunk transcript is **unverified**. Whether chunks need
consolidating for reading is a Phase 2 measurement.

## 4. Requirements carried into Phase 2

- **Formats to tolerate:** keep unknown record types and malformed lines as
  raw, viewable evidence; the format is internal to Claude and changes by
  version. Do not count usage once per JSONL row; the earlier spike found
  repeated `message.id` values.
- **Lazy loading:** render tool output above a threshold (about 8 KiB) on
  demand, including saved outputs linked by `persistedOutputPath`.
- **Collection health:** show each worker's latest heartbeat, its age and its
  last failure class, separately from execution state (decision D4: in the
  reader only). Also show sessions whose worker is offline or gone.
- **Account check:** `fffactory logs` reads `log_archive.bucket` from
  factory.json and runs the account check. It must work after teardown, with no
  state bucket, lock or Terraform output.
- **Open for Phase 2:** whether it applies the CLI/pin match guard (reading is
  not a mutation).
