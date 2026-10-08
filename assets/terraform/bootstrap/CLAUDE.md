# assets/terraform/bootstrap: the worker bootstrap

Not a Terraform module: the user data template `modules/hosts` renders with `templatefile`,
and the root activator it embeds. Both run only on the worker, as root. They live in the
Terraform tree because operations copy only that tree. Spec:
[docs/specs/worker-bootstrap.md](../../../docs/specs/worker-bootstrap.md).

- Bash on Amazon Linux 2023 (bash 5), `set -Eeuo pipefail`; not POSIX `sh` and not bound
  to macOS's bash 3.2, which `scripts/` targets. Keep both shellcheck-clean (CI checks the
  activator and the rendered user data).
- The template interpolates only `${name}` of a variable the hosts module passes, each into a
  single-quoted shell assignment; write every other `${` as `$${` and `%{` as `%%{`. Adding
  a variable means passing it in `modules/hosts` and projecting it from factory.json;
  `tests/assets/bootstrap/user-data.test.ts` checks the two agree.
- Never mention SSM here; a test fails on it. Never put secret material in an argument, the
  environment or a log: the Tailscale key goes only to a root-only file under `/run`.
- The rendered user data stays under EC2's 16 KB, activator included.
- The activator writes only to standard error (standard output is `host apply`'s), and
  refuses before unpacking anything unless the digest and every entry check pass.
- `fffactory-activate` stays executable (the bundle ships it 0755).
- Test with `just bootstrap-test` (Docker, AL2023 containers); `bun test` covers rendering
  and `just terraform-check` compares Terraform's rendering with the tests'.
