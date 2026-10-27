# tests/paseo: the pinned Paseo against what fffactory writes

`hash-only-daemon.sh` (`just paseo-check`) runs the real Paseo pinned in
`assets/steps/control-plane/versions.env` against the password hash fffactory writes, the
merged speech switches, `factory-dispatch`'s `run` and `ls` flags, and the `ls` rows and
`agent inspect` fields the worker's agent adapter reads (`docs/specs/control-plane.md` §The
Paseo pin, §Agent states). It downloads the package, so neither `bun test` nor
`just check-all` runs it; run it whenever the pin, the unit, the config merge, the hashing, the
dispatcher's Paseo flags or what the agent adapter (`paseoAgents`) reads change. Never by
`bun test`: `hash-main.ts` is its helper, not a test.

- Use the real programs: the hash from `workerControlPlane`'s install (`hash-main.ts`), the merge
  by `paseo-config.sh` handed the hash as `setup-host.sh` hands it, the daemon started by
  `paseo.service`'s own `ExecStartPre` and `ExecStart`, and CLI calls through `paseo-auth.sh`.
  Stand in only for AWS (`aws-right`, `aws-wrong`) and the provider (`claude`).
- Never touch this machine's Paseo: npm runs with a private `HOME`, cache and prefix and
  `--ignore-scripts`; the daemon runs in `unshare --user --net --pid`, loopback only, every
  process under `env -i`, so a worker's own `PASEO_PASSWORD` or `PASEO_HOME` never reaches it
  and no daemon or agent outlives the check, even when it fails.
- Shellcheck-clean (CI checks it).
