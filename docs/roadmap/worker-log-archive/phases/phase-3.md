# Phase 3: fffactory logs reader

**Status:** not-started
**Roadmap:** docs/roadmap/worker-log-archive/roadmap.md

**Kind:** design-slice
**Scope:** `fffactory logs --instance PATH --profile NAME`: reads `log_archive.bucket` from factory.json (works after teardown, no state bucket or Terraform), account check, ExpectedBucketOwner; loopback server on 127.0.0.1 with Host/Origin/Sec-Fetch checks and a per-run token exchanged for a cookie; prebuilt plain TS+DOM UI embedded as file imports, rendered as text under a CSP. Builds its index from journal records (StartAfter), cached per factory. Shows workers with heartbeat freshness and failures; sessions by worker and conversation; windowed conversation rendering, lazy tool output over ~8 KiB and saved outputs; subagent navigation; unassociated sessions; raw archived files; refresh of ongoing runs.
**Out of scope:** Repository/epic/attempt grouping (Phase 4); worker controls; cost dashboards; masking (D8).
**Success:** From a released binary, an operator opens the Acceptance factory's archive, sees each worker's collection freshness, follows a live run as it refreshes, navigates nested subagents and a large tool output, and reads a session whose worker is gone; a wrong account and a non-loopback or tokenless request are refused; specs and tests cover the command, access rules and rendering safety.
**Depends on:** Phase 2.
**Estimated tasks:** ~7

## Handoff
When ready to execute this phase:
  /plan-chat

The handoff skill will read this file as its starting point.
