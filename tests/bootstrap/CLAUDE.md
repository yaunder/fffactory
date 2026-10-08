# tests/bootstrap: the worker bootstrap's shell tests

Shell tests of what runs as root on a new worker (`docs/specs/worker-bootstrap.md`,
`docs/specs/host-protocol.md` §apply). Run with `just bootstrap-test [CASE...]`
(`scripts/bootstrap-test.sh`; needs Docker and Bun), and in CI. Never by `bun test`.

- `*.test.sh` files hold `test_*` functions and an optional `setup`. Each case runs as root in
  its own fresh, network-less Amazon Linux 2023 container with hostname
  `fff-aaaa1111-builder-1`, `assets/terraform/bootstrap` at `/bootstrap`, this directory at
  `/tests` and, at `/fixtures`, what `tests/support/bootstrap-fixtures-main.ts` renders (the
  user data and a packed release).
- `run-case.sh FILE CASE` sources `lib.sh` and the test file, runs `setup`, then the case.
  `lib.sh` holds the assertions (`run` into `$STATUS`, `$OUT`, `$ERR`; `assert_*`) and release
  builders (`pack`, `stub_release`). Add helpers there, not per file.
- `user-data.test.sh` runs the user data with stand-in `dnf`, `tailscale`, `aws`, `systemctl`,
  `hostnamectl` and `sleep` on `PATH`; `activator.test.sh` tests the root activator;
  `host-apply.test.sh` runs the real compiled worker executable's `host apply` over the
  stand-in install steps in `stand-in-steps/`, one per step in `INSTALL_STEPS`.
- Only AL2023's own tools are real; never reach the network. Everything here is shellchecked
  in CI (`.github/workflows/cli.yml`).
