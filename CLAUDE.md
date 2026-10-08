@AGENTS.md

<!-- ffflow:beliefs v0.4.0 — managed by /fff:upgrade-ffflow. Edits inside this block are overwritten. -->
## FFFlow beliefs

This project runs [FFFlow](https://github.com/bryonjacob/ffflow-plugin). These are the non-negotiables — the rules you should not have to discover.

- **Hierarchical CLAUDE.md.** Every significant module carries its own CLAUDE.md — a tree mirroring the module tree, not this root file alone. Adding one to a module that lacks it is *never* a new precedent; it is catching up to the norm. The root file stays a map; module-specific rules live with the module. A 2-line CLAUDE.md beats none. → `/fff:audit --type claude-md`
- **Specs and tests move together.** A spec entry without a test is documentation; a test without a spec entry is opaque. Spec updates ship in the same PR as the implementation. → `/fff:work-issue`, `/fff:audit --type spec`
- **Tech debt is marked or fixed, never deferred silently.** Fix nits in flight, or write `# TODO(re-evaluate when <trigger>): <action>`. "We'll get to it" without a code-level marker is not a plan. → `/fff:audit --type tech-debt`
- **Red, then green — wherever it's practical.** Write the failing test first and drive it to green. The artifacts scale with the level; the loop doesn't. Some edges genuinely resist it (exploratory spikes, config/scaffolding, hard-to-harness I/O, a bug you can't reproduce yet). At those edges, say so out loud and note what you did instead — an acknowledged exception is fine, a silent one is how the discipline erodes. → `/fff:tdd-loop`
- **Plans are transient, specs are evergreen, issues are transactional.** Three artifacts, three lifespans, three locations. Don't mix them.

Level and stack are declared in `.ffflow/config.yaml`. Run `/fff:upgrade-ffflow` after updating the plugin.
<!-- ffflow:beliefs end -->
