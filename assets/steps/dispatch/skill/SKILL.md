---
name: dispatch
description: >-
  Pull ready FFFlow epics on a factory host into top-level Paseo agents and
  worktrees. Use only from the declared dispatch directory on a scheduled
  host; never deploy infrastructure or converge hosts.
---

# Dispatch ready epics

Run `/usr/local/bin/factory-dispatch` from the host's declared dispatch
directory. `fffactory apply` installs this stable, root-owned entrypoint and this
skill from the active release after the readiness gates pass. The program refuses a
different working directory. Never run it from a Paseo worktree, an unmerged
branch, or a laptop checkout when operating a host.
Print its JSON summary to the timeline, including considered epics, skip reasons,
agents started, and the current host agent count. Do not manually start agents
to work around a skip or a failed run.

The program uses the v2 host's repository and dispatch projections, the active
release's FFFlow adoption and repository synchronization programs, and GitHub
issue state. A repository that fails adoption is not eligible.

The executor provider, model and permission mode come from the host's reviewed
`factory.json` dispatch declaration. FFFlow's implement and review subagents
inherit that mode.
The launched prompt is `/fff:work-epic <id>`. The pinned FFFlow (0.4.2+)
resolves tasks by the capture cartridge's `ffflow-task` and `epic-<id>` labels
itself. The prompt also tells the agent to create the `epic/<id>` branch inside
its new worktree, starting from the repository's declared remote branch.
Unexpected `work-epic` stops, including an existing branch, missing acceptance
criteria, or review cap reached, remain visible in the agent timeline and any
Paseo question or permission queue. An enrolled client can answer there. Do
not silently retry or discard that worktree.

The dispatcher never merges, force-pushes, deletes branches or worktrees,
closes issues, deploys infrastructure, or runs host convergence.
