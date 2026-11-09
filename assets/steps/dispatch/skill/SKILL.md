---
name: dispatch
description: >-
  Pull ready FFFlow epics on a factory host into top-level agents, each in a
  fresh worktree of the worker's execution backend. Use only from the declared
  dispatch directory on a scheduled host; never deploy infrastructure or
  converge hosts.
---

# Dispatch ready epics

Run `/opt/fffactory/current/bin/fffactory host dispatch run` from the host's
declared dispatch directory, as this `factory` account. `fffactory apply` installs
this skill from the active release after the readiness gates pass, and the command
is that release's own dispatcher. The command refuses root and a different working
directory. Never run it from a worktree the execution backend created, an
unmerged branch, or a laptop checkout when operating a host.
Print its JSON summary to the timeline, including considered epics, skip reasons,
agents started, and the current host agent count. When it exits non-zero, print its
one-line error instead. Do not manually start agents to work around a skip or a
failed run.

The command uses the v2 host's repository and dispatch projections, the active
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
question or permission queue the execution backend keeps. An enrolled client
can answer there. Do not silently retry or discard that worktree.

The dispatcher never merges, force-pushes, deletes branches or worktrees,
closes issues, deploys infrastructure, or runs host convergence.
