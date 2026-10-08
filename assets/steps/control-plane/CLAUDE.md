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
- `paseo-config.sh` merges the listen address, the disabled relay and
  `daemon.hostnames` into `config.json`, keeping every other setting. Setup runs
  it as `factory`; its inputs are `FACTORY_PASEO_*` variables, so it runs on a
  laptop. It needs no root and no worker: keep anything that does in setup.
- `paseo-auth.sh` authenticates factory-owned Paseo CLI calls, supplying the
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
  checks statically that it hands its addresses to `paseo-config.sh`.
- A step is ported to TypeScript only when it is changed for another reason (D3).
  Until then, change a program and its test together.
