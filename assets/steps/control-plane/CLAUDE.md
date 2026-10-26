# assets/steps/control-plane: the Paseo control-plane step

The factory's control-plane programs, shipped in the release assets. The setup
program installs Paseo and its systemd unit without a lifecycle action; the CLI
drives installation, activity, reload, restart and health through the
`ControlPlane` port
(`src/application/control-plane.ts`, `src/infrastructure/paseo-control-plane.ts`).
Spec: [docs/specs/control-plane.md](../../../docs/specs/control-plane.md).

- `setup-host.sh` installs the pinned Paseo package, resolves the worker's
  Tailscale IPv4 address, MagicDNS name and short hostname, has `paseo-config.sh`
  merge the factory-owned daemon settings, and installs/enables `paseo.service`;
  it never starts or restarts the daemon. `paseo.service`
  is the daemon's systemd unit; `versions.env` pins the Paseo package and its
  registry integrity value.
- `paseo-config.sh` merges the listen address, the disabled relay,
  `daemon.hostnames`, dictation and voice mode switched off (so the daemon downloads no
  speech model) and, when given one, the password's bcrypt hash
  (`daemon.auth.password`) into `config.json`, keeping every other setting. Given none,
  which only a projection delivered by hand can lead to (every host declares a password),
  it removes `daemon.auth.password`, so the unit's `ExecStartPre` keeps the daemon from
  starting on a password fffactory does not reference. Setup runs
  it as `factory`; its inputs are `FACTORY_PASEO_*` variables, so it runs on a
  laptop. It needs no root and no worker: keep anything that does in setup.
- The password reaches setup only as its hash, made by the worker executable
  (`src/host/control-plane.ts`) and read from standard input after the secret
  reference. The hash goes to `paseo-config.sh` in its environment and to `jq` through `$ENV`,
  never as an argument (runuser's command line is world-readable), and is never echoed.
- `paseo.service` runs `paseo daemon run` directly, never through `paseo-auth.sh`: the daemon
  holds only the hash, so no agent, tool or hook inherits `PASEO_PASSWORD`. Its `ExecStartPre`
  refuses to start without a stored password. `tests/paseo/hash-only-daemon.sh`
  (`just paseo-check`) runs its commands against the pinned Paseo; rerun it when the unit,
  the merge or the pin changes.
- `paseo-auth.sh` authenticates factory-owned Paseo CLI calls only, supplying the
  password from Secrets Manager through `PASEO_PASSWORD` without it entering a
  command token, log or argument. The adapter runs it as the `factory` account.
- Inputs come from this active release and the validated host projection. Never
  reintroduce v1 marker polling, deployed input directories or a generated
  per-host secret map.
- These are not `INSTALL_STEPS`: `tests/assets/steps/steps.test.ts` lists only
  the top-level `assets/steps/*.sh`, so this subdirectory is excluded.
- `tests/test_paseo_auth.py` and `tests/test_paseo_config.py` are Python tests of
  the auth wrapper and the config merge, run in CI
  (`.github/workflows/repository-checks.yml`), never by `bun test` or `just check-all`.
  Run them from here with `python3 tests/<test>.py`, and keep them green; each
  resolves its script one directory up. `setup-host.sh` itself needs root and
  Amazon Linux 2023, so nothing runs it: `tests/assets/steps/steps.test.ts`
  checks statically that it hands its addresses and the hash to `paseo-config.sh`, and the
  unit's commands.
- A step is ported to TypeScript only when it is changed for another reason (D3).
  Until then, change a program and its test together.
