# Paseo 0.13.2 → 0.15.0 against fffactory's contracts

Date: 2026-11-03. Re-checks every contract of
[control-plane §The Paseo pin](../specs/control-plane.md#the-paseo-pin) and
[§Agent states](../specs/control-plane.md#agent-states) before moving the pin from
0.13.2 to 0.15.0.

Sources:

- `npm pack @getpaseo/{cli,server,client,protocol}` at 0.13.2, 0.14.0 and 0.15.0,
  unpacked and diffed. `S` below is `@getpaseo/server`'s `dist/server/server/`.
- Release notes: `gh release view v0.14.0-beta.1|v0.14.0-beta.2|v0.14.0|v0.15.0-beta.1|v0.15.0 -R getpaseo/paseo`.
- `just paseo-check` against 0.15.0 on Linux (Node.js 22, in Docker with
  unprivileged user namespaces), which passed every step.

## Verdict

Every contract fffactory relies on holds in 0.15.0, and no persisted state needs
migrating from 0.13.2.

- `@getpaseo/cli`'s `dist` is byte-identical from 0.13.2 to 0.14.0. In 0.15.0 only
  `commands/daemon/{stop,restart,status}.js` change, which add terminal keep and
  kill flags. So `ls`, `run`, `agent inspect` and `schedule` are unchanged.
- In the server, `auth.js`, `session-admission-auth.js`, `local-credential.js`,
  `config-environment.js`, `hostnames.js`, `agent/directory.js`,
  `schedule/{service,store,cron}.js` and `protocol/agent-lifecycle.js` are
  byte-identical. So are the password rule, the `Host` rule, `/api/health`'s
  exemption, the five statuses and the schedule records.
- The persisted-config schema keeps `daemon.listen`, `daemon.relay.enabled`,
  `daemon.hostnames`, `daemon.auth.password`, `$schema` and `version: 1`.
- Dictation and voice mode switched off still request no speech model
  (`S/speech/providers/local/runtime.js:17-32`). Dictation is still on by
  default, so the merge stays needed.
- Providers are launched the same way. `paseo-env.js`'s external-process
  environment and `agent/provider-launch-config.js` are unchanged. Claude's launch
  no longer overlays `run --env` values, which dispatch does not use. Codex
  changes only how it reads its standard output.
- No `engines` field. The new dependencies (`undici` ^7, `https-proxy-agent`) run
  on Node.js 22.

## Behaviour changes

- **Idle runtime cleanup (0.14).** `agents.idleRuntimeCleanup` defaults to true.
  After an hour `idle`, an agent's runtime is closed and stored `closed`
  (`S/agent/idle-runtime-cleanup/`). It stays listed and is not archived, so a
  `finished` agent turns `stopped`. Both are non-busy, and dispatch's duplicate
  check counts any listed agent.
- **Restart recovery (0.15).** The startup rewrite of `running` and
  `initializing` to `closed` moved into `restartRecovery.prepareStartup()`
  (`S/agent/restart-recovery/index.js`), which still runs before the server
  accepts connections. Resuming those agents is opt-in through
  `agents.resumeOnStartup`, which defaults to false. 0.15.0-beta.1 shipped it on
  by default. #8619 made it opt-in, two hours before 0.15.0 was published.
- **Downgrade.** The config's `agents` and `daemon` objects are strict. A
  `config.json` holding `agents.idleRuntimeCleanup`, `agents.resumeOnStartup`,
  `agents.resumePrompt` or `daemon.usage` stops a pre-0.14 daemon from starting.
  The release writes none of them. Only a Paseo client's settings do.
- **Terminal worker (0.15).** Every start spawns a detached
  `terminal-worker.mjs` from the Paseo home. It stays in the unit's cgroup, so
  `KillMode=control-group` stops it with the daemon.
- **Agent records** gain the optional `resumeOnStartup` and `launchEnv`, which
  older releases ignore.
- **Proxies.** 0.15.0 honours `HTTP(S)_PROXY`. `paseo.service` sets neither.

## Open upstream issues worth watching

- #8449: resuming parses the whole transcript, so long sessions time out.
- #8629: an unbounded parallel scan of agent records at startup can drop
  records with `EMFILE`. It is filed for Windows, and the same code is in 0.13.2.
  It matters because nothing archives agents.
- #8681, #8696, #8697: restart-recovery bugs, for the Pi and OpenCode providers
  only.
