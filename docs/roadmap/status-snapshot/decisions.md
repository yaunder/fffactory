# Decisions: status-snapshot

✓ Fate of #151 and #152
   Chose: close both as not planned, pointing at this plan.
   Rationale: a registry and Paseo plugin are a lot of surface for a read-only view. A snapshot rendered
   from `status --json` gets the same picture with no second source of truth. The configuration chat
   (#152) can come back later on top of the snapshot.
   Rejected alternatives:
     - keep #151 and build the Paseo browser: second registry, plugin packaging, daemon-side directory browsing
     - close #151, rewrite #152 to bind to one --instance path: still Paseo plugin work, not needed now

✓ Target UI
   Chose: #154's self-contained HTML page rendered by the CLI, with `status --json` as the contract behind it.
   Rationale: one renderer we own and test against fixtures. An external UI can read the same JSON later at no extra cost.
   Rejected alternatives:
     - JSON contract only, UI built elsewhere: no UI ships, and the contract goes untested by a real consumer

✓ Snapshot time
   Chose: add a top-level `observed_at` (ISO 8601 UTC) to the status report. Additive; schema version 2 stays.
   Rationale: the "as of" time must come from the CLI so JSON and HTML agree. The renderer must not invent it.
   Rejected alternatives:
     - renderer stamps its own time: JSON consumers can't tell when the report was taken

✓ Scope: factories per snapshot
   Chose: one factory per snapshot, selected with --instance as today.
   Rationale: no registry needed. Several factories means several runs.
   Rejected alternatives:
     - multi-factory page: brings back a registry like #151's

✓ Issues
   Chose: reuse #153 (agent work) and #154 (HTML), tightened into dispatch-ready specs at capture. `observed_at` gets
   its own small issue that can ship alongside #153.
   Re-examined 2026-11-18: it shares the schema, fixture and status spec with #153, so it runs one after the other
   with #153, not in parallel. User confirmed a separate issue anyway.
   Rejected alternatives:
     - fold observed_at into #153: widens #153's scope beyond agent labels
     - fold observed_at into #154: one PR would touch both the contract and the renderer
     - capture fresh issues: duplicates #153 and #154

✓ observed_at semantics
   Chose: the start of inspection: the moment status begins reading the inventories (Order step 4), after
   validation and the account check.
   Rationale (user's call): "as of" marks when observation began. Every fact in the report was observed at or after it.
   Rejected alternatives:
     - when the report is assembled, after every observation

✓ Human layout for named agents (#153)
   Chose: keep the `Agents:` count line. Below it, one line per agent that is working, needs input or failed, in that
   state order, e.g. `api #212 working, dispatched 3h 04m ago`. Agents not launched by dispatch are named by ID.
   Finished and stopped agents are counts only.
   Rejected alternatives:
     - name every agent: finished agents pile up on long-lived workers

✓ Which agents the page lists (#154)
   Chose: the same rule as the human report. List working, then needs input, then failed. Finished and stopped are
   a count per worker.
   Rationale: one rule, so the terminal and the page never disagree.
   Rejected alternatives:
     - also list finished agents dispatched within 24h of observed_at: a second rule to spec and test

✓ --html with --json
   Chose: one output format at a time. Both together is an invalid argument and exits 1.
   Rejected alternatives:
     - one silently wins

✓ Links from the page
   Chose: no links in this plan. The page will link to a different target once that exists (user's call), not GitHub.
   Marker: `TODO(re-evaluate when <link target> is up): link agents and epics` in status-page.ts.
   Rejected alternatives:
     - GitHub epic URLs: need repository owner and name, which status never prints

✓ UI prototype
   Chose: the user's "Factory Floor.html" artifact (exported 2026-11-18) is the visual prototype for #154.
   Committed as docs/roadmap/status-snapshot/prototype.html. Design reference only, not code to reuse (see differences in plan.md).

✓ Fonts
   Chose: drop the Google Fonts request and use the fallback faces in the stack ("Helvetica Neue", Arial, sans-serif;
   ui-monospace for mono).
   Rationale: the page makes no network requests and stays small. The look stays close to the prototype.
   Rejected alternatives:
     - embed IBM Plex (base64 woff2): about 150 KB more per page, and the fonts' licence ships with every page
     - keep the Google Fonts link: breaks offline reading and the no-network rule

✓ Where the prototype lives
   Chose: at plan-capture, commit it to docs/roadmap/status-snapshot/prototype.html and link it from #154.
   Rationale: the plan directory in /tmp doesn't last. The agent implementing #154 needs the file in the repo.
   Rejected alternatives:
     - attach to #154: GitHub doesn't accept .html attachments, so it would need a zip or a gist
