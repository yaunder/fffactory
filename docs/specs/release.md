# Release

A `fffactory` release is one version, taken from `package.json`, delivered as
self-contained executables that carry their own release assets. Design:
[fffactory-v2.md §Distribution and trust](../designs/fffactory-v2.md#distribution-and-trust).

## Executable and assets

### Version

`fffactory --version` prints the running release and nothing else, such as
`0.3.0`, and exits 0. Any argument after `--version` is an error (exit 1).
The release is `package.json` `version`, inlined at build time by
[`src/cli/release.ts`](../../src/cli/release.ts); it is the same release that
`init` pins and `doctor` reports.

### Targets

`scripts/build.ts` compiles `src/cli/main.ts` with `bun build --compile` for:

| Target | Output |
| --- | --- |
| `bun-darwin-arm64` | `dist/fffactory-darwin-arm64` |
| `bun-linux-x64` | `dist/fffactory-linux-x64` |

`just build [TARGET...]` builds the host's target or the named ones
(`darwin-arm64`, `linux-x64`); `just build-all` builds both. Every build first
compiles the [worker executable](#worker-executable),
`dist/fffactory-worker-linux-x64`, which the bundle carries. Both targets are
compiled in one run from one asset bundle, so they embed byte-identical
bundles with the same digest. Each executable carries the Bun runtime and runs
with no checkout, Node or Bun installed. `linux-x64` needs glibc.

The darwin-arm64 executable is ad-hoc code-signed on macOS by
`scripts/sign-macos.sh` (`codesign --force --sign -`) with the JavaScript
engine entitlements Bun documents, in `scripts/entitlements.plist`:
`com.apple.security.cs.allow-jit`,
`com.apple.security.cs.allow-unsigned-executable-memory` and
`com.apple.security.cs.disable-executable-page-protection`. Apple Silicon
requires a signature to run a native binary; an ad-hoc one asserts no publisher
identity. There is no notarization (D10). Signing happens after the build and
changes the file, so any digest of the published darwin executable is taken
after signing.

### Asset bundle

The release assets are one gzipped POSIX ustar tarball,
`fffactory-assets.tar.gz`, identified by its SHA-256 digest alone (D4). There
is no per-file manifest.

- Contents: every regular file under the repository's `assets/`, at its path
  there, except `CLAUDE.md` files, plus a generated `release.json`,
  `{"release": "<version>"}`. `assets/` may not hold its own `release.json`.
  It names the release and nothing else, for good: the activator on every
  worker, part of its base, refuses any other `release.json`. What a release
  declares about the factories it can operate, its factory.json schema version
  and base generation, is in the executable
  ([plan and apply §Compatibility refusals](plan-apply.md#compatibility-refusals-d11)).
  The bundle holds the Terraform modules and their provider lockfiles under
  `terraform/` ([provisioning §Resources and namespacing](provisioning.md#resources-and-namespacing)),
  with the worker bootstrap's user data template and root activator under
  `terraform/bootstrap/` ([worker bootstrap](worker-bootstrap.md)), and the
  install steps, pins and plugin manifest under `steps/`
  ([host protocol §apply](host-protocol.md#apply)). A built bundle also holds
  the worker executable as `bin/fffactory`; `assets/` may not hold one.
- Entries are regular files only: a symbolic link or other special file under
  `assets/` fails the build. Modes are 0755 for a file with any execute bit,
  otherwise 0644.
- Entry paths are relative, use printable ASCII without backslashes, and have
  no empty, `.` or `..` segment. `.fffactory-assets.json` at the root is
  reserved for the materialization marker.
- Packing is deterministic: entries sorted by path, owner 0, mtime 0, gzip
  without a timestamp. The same `assets/` and release always give the same
  bytes and digest.
- Any standard `tar` extracts it, which the worker's activator relies on
  ([worker bootstrap §Activator](worker-bootstrap.md#activator)).

The build writes the bundle and `fffactory-assets.tar.gz.sha256` beside the
executables, embeds the bundle in each executable as a file, and records its
digest in the executable's code. The executable reads assets only from that
embedded bundle, never from a checkout or the current directory.

Run from source (`bun src/cli/main.ts`, as the tests do), there is no embedded
bundle; the CLI packs the checkout's `assets/` in memory the same way the
build does and uses that. A compiled executable never does this: without its
embedded bundle it reports the assets as missing.

### Worker executable

A worker runs the same program as the operator: the linux-x64 build of
`src/cli/main.ts`, compiled without an embedded bundle, since on a worker the
release directory it runs from, `/opt/fffactory/releases/<version>`, holds the
assets. `scripts/build.ts` compiles it first and packs it into the bundle as
`bin/fffactory` (0755), then compiles each target embedding that bundle. The
bundle is therefore exactly what a worker receives: the activator verifies it
against the digest, unpacks it and runs its `bin/fffactory host apply`
([worker bootstrap §Activator](worker-bootstrap.md#activator)).

How a release reaches a worker, and why its digest is trusted: the operator's
installed executable, checked against `SHA256SUMS` when `install.sh` installed
it, embeds the bundle and its SHA-256. The CLI/pin match guard makes the
running release the one factory.json pins, so apply uploads the running
executable's own embedded bundle (`AssetBundle.workerRelease`, after checking
it against the embedded digest) and passes that embedded digest to the
activator, which refuses a copy that does not match
([host protocol §apply](host-protocol.md#apply)). Nothing is downloaded, and no
digest comes from the worker or from configuration. Run from source there is
no worker executable: the checkout's bundle lacks `bin/fffactory`, and apply
skips every worker, saying so.

The worker executable makes the operator executables larger by its compressed
size (about 35 MiB), and materializing a release's assets writes it to the
cache.

### Materialization

Release assets are materialized into the FFFactory cache, which
[doctor §Cache](doctor.md#cache) locates, one directory per release version:
`<cache>/releases/<release>`, for example
`~/.cache/fffactory/releases/0.3.0`. The directory holds the bundle's entries
and, written last, `.fffactory-assets.json`, which records the release and the
bundle digest.

`fffactory assets` materializes the running release's assets, if they are not
already there, and prints the directory. It takes no arguments. `fffactory
plan` and `apply` materialize the same way before they run Terraform, and bind
a saved plan to the bundle's digest, which materialization reports
([plan and apply §Freshness](plan-apply.md#freshness)).

| Condition | Result |
| --- | --- |
| The directory's marker names this release and this bundle's digest | Nothing is read or written; prints the directory (exit 0). |
| The directory is absent | Materialized; prints the directory (exit 0). |
| Something else is there: no marker, a marker for another digest (another build of the same version), or a file | Replaced by a fresh copy; prints the directory (exit 0). |
| The embedded tarball does not match its recorded digest | Refused, nothing written: `The embedded release assets do not match their recorded SHA-256 digest; reinstall fffactory from its GitHub Release` (exit 1). |
| The executable embeds no bundle | Refused: `This fffactory executable embeds no release assets; reinstall fffactory from its GitHub Release` (exit 1). |
| An entry is not a regular file, has an unsafe path or appears twice, or a header is corrupt (a bad checksum, not ustar, or a mode, size or checksum field that is not octal digits) or the tarball truncated | Refused, nothing written (exit 1). |
| An I/O error | Exit 1 with the error; the directory is as it was. |

How it is made safe:

- **Integrity.** The digest is checked before anything is extracted. The
  tarball is read in-process; no `tar` is needed on the operator's machine.
- **Path traversal.** Every entry path is checked before any is written, and
  only regular files are created, so nothing lands outside the directory.
- **Partial writes.** Entries are extracted into a private staging directory
  beside the target (`.<release>.staging-*`), each flushed to disk, then the
  marker; one atomic rename moves the complete directory into place. The
  target is never partly written, and a failed run leaves an existing
  directory untouched.
- **Concurrency.** Concurrent runs each stage their own copy. The first rename
  wins; a later run that finds a current copy discards its own. Replacing a
  stale directory renames it aside, retries the rename, and removes what it
  moved aside; runs replacing the same stale directory can clear each other's
  way, so each retries, up to 10 times, until a current copy stands. Every
  move aside is followed by another rename, and the final attempt moves
  nothing aside, so a run that gives up ("Could not replace") leaves whatever
  last stood and never removes a copy another run installed after its last
  check. Every run that succeeds ends with one complete, current directory.
  The limit: a run that replaces a stale directory at the moment another run
  installs a current one may move that copy aside and swap in its identical
  copy, so a reader holding the directory's path during that instant can see
  it briefly absent.
- **Leftovers.** A run killed mid-extraction leaves its staging directory (or a
  copy it moved aside, `.<release>.replaced-*`) behind. Each run first removes
  those of its release older than an hour (`STALE_STAGING_MS`), longer than any
  run takes, so a concurrent run's are left alone.

Idempotence is decided by the marker alone. Materialized files are not
re-verified, so an edit inside the directory persists until the release's
bundle changes.

### Doctor

`doctor`'s `release_assets` check reports, read-only, whether the embedded
bundle is intact and what this release's directory holds; see
[doctor §Cache](doctor.md#cache). `doctor` never materializes.

### Smoke test

`scripts/smoke-test.sh BINARY` (`just smoke` builds linux-x64 first) runs the
linux-x64 executable in a pinned `debian:stable-slim` container with no Bun,
Node, checkout or network, as a non-root user, with no AWS variables, empty
AWS config and credentials files, instance metadata disabled and AWS endpoints
pointed at a closed local port. From an empty directory it runs `--version`,
`init`, `assets` twice and `doctor --json`, and checks on the host with `jq`:

- `--version` prints the `package.json` version;
- `init` creates an instance;
- both `assets` runs print `<cache>/releases/<version>`, which holds
  `release.json` for that version, and the rerun is a no-op (an edit made in
  between survives);
- the materialized `bin/fffactory`, the worker executable, runs `--version`
  and prints the version (container only);
- `doctor --json` exits 2, because ssh, tailscale and AWS credentials are
  missing: `schema_version` is 1, `release` is the version, `openssh`,
  `tailscale`, `instance` and `aws_account` are `not_ready`, and
  `cache_directory`, `release_assets` and `terraform` are `ready`, the
  second reporting the materialized directory;
- a copy of the executable with one byte of its embedded bundle flipped
  refuses `assets` with the digest message and writes nothing.

`scripts/smoke-test.sh --no-container BINARY` runs the same steps on the host
under `env -i` with the same AWS isolation, without the container-only checks
(no runtimes, the tool statuses, the tampered copy). CI uses it on macOS.

### CI

`.github/workflows/executables.yml` runs on pull requests and pushes to `main`,
and is callable (`workflow_call`) by the release workflow:

1. On `ubuntu-latest`: build both targets, run the container smoke test, and
   upload `fffactory-linux-x64`, `fffactory-darwin-arm64-unsigned` and
   `fffactory-assets` (the tarball and its `.sha256`).
2. On `macos-latest` (Apple Silicon): download the darwin executable, ad-hoc
   sign it with the entitlements and verify the signature
   (`codesign --verify --strict`), run `--version`, run the host smoke test,
   and upload the signed `fffactory-darwin-arm64`.

Artifacts lose their file modes; a consumer restores the execute bit.

### Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/release-assets.ts` | Entry path rules, the marker, `ReleaseAssetsState`, and the `release_assets` check. Pure. |
| Application | `src/application/asset-bundle.ts` | The `AssetBundle` port (`inspect`, `materialize`) and `releaseAssetsDirectory`, the version-keyed layout. |
| Infrastructure | `src/infrastructure/release-tarball.ts` | Deterministic ustar packing and strict unpacking, and SHA-256. |
| Infrastructure | `src/infrastructure/asset-bundle.ts` | `releaseAssetBundle`: verification, staged extraction and atomic install; `packAssetsDirectory`; the embedded and checkout bundle sources. |
| CLI adapter | `src/cli/run.ts`, `src/cli/commands/assets.ts`, `src/cli/main.ts` | `--version`, the `assets` command, and choosing the embedded or checkout bundle. |
| Build | `scripts/build.ts`, `scripts/sign-macos.sh`, `scripts/entitlements.plist`, `scripts/smoke-test.sh` | The worker executable, packing, compiling, signing and the packaged smoke test. |

Tests: `tests/domain/release-assets.test.ts`,
`tests/application/asset-bundle.test.ts`,
`tests/infrastructure/release-tarball.test.ts` (round trip, determinism,
system `tar` interoperability, and refusal of traversing and absolute paths,
links, directories, duplicates, bad checksums and truncation),
`tests/infrastructure/asset-bundle.test.ts` (materialization in real temporary
directories: modes and marker, no-op rerun, version keying, replacement of
stale directories, digest mismatch, missing bundle, path traversal, a failed
write, and concurrent runs; `inspect` states; packing `assets/`, with the
worker executable; the worker release and its absence),
`tests/cli/assets.test.ts`, `tests/cli/run.test.ts` (`--version`) and
`tests/cli/main.test.ts` (the spawned CLI: `--version`, `assets` twice from a
directory outside the checkout, then `doctor`). The compiled executables are
tested by the smoke test, locally and in CI, not by `bun test`.

Introduced by [#93](https://github.com/yaunder/factory/issues/93).

## Distribution

A release reaches an operator as a GitHub Release of `yaunder/fffactory`, installed
with `install.sh` (D10: no Homebrew, notarization or native installer). The
CLI never updates itself; installing is always explicit.

### Tags

A release is published by pushing the tag `v<version>`, where `<version>` is
`package.json` `version`: `v0.1.0` for `0.1.0`, `v0.2.0-rc.1` for
`0.2.0-rc.1`. The workflow refuses any other `v*` tag, including `0.1.0`
without the `v`, before it builds anything:
`Tag 'v0.1.1' does not match package.json version 0.1.0; release it with tag v0.1.0`.
To release, bump `version`, merge, then tag that commit. A version with a
`-prerelease` part is published as a GitHub prerelease, which
`/releases/latest` and therefore install.sh's default skip; install one by
naming it with `FFFACTORY_VERSION`. Before building, the workflow requires the
tag's commit to equal checked-out HEAD and to be reachable from fetched
`origin/main`. Missing refs fail closed. This permits a release of an older
merged commit after main advances, but refuses an unmerged branch.

The repository must also activate the two checked-in release tag rulesets:
only repository admins may create `v*` tags, and no actor may update or delete
them. The creation bypass applies only to the creation rule, not to the
separate immutability rule. The workflow guard supplements these server-side
permissions; someone able to push arbitrary workflow code could remove a
guard in that code. See [public repository setup](../public-repository.md).

### Release workflow

`.github/workflows/release.yml` runs on a pushed `v*` tag:

1. `tag` (`contents: read`): checks out full history and runs
   `scripts/assemble-release.sh check-source` to verify the release commit
   against the tag and `origin/main`. `check-tag` checks the tag against
   `package.json` and outputs the version and whether it is a prerelease.
2. `executables`: calls `.github/workflows/executables.yml` (see [CI](#ci)),
   so both targets are built from one asset bundle, the linux-x64 executable
   passes the container smoke test, and the darwin-arm64 executable is ad-hoc
   signed and passes the host smoke test on Apple Silicon. A failure there
   publishes nothing.
3. `publish` (the only job with `contents: write`): downloads the
   `fffactory-linux-x64` and signed `fffactory-darwin-arm64` artifacts by exact
   name (`fffactory-darwin-arm64-unsigned` holds a file of the same name), then
   `scripts/assemble-release.sh assemble` writes the release directory, and
   `gh release create --verify-tag` publishes it with the built-in
   `GITHUB_TOKEN`. There is no third-party release action.

`assemble` checks the tag again, refuses an output directory that exists, a
missing or empty executable, a `fffactory-darwin-arm64` that is not an arm64
Mach-O and a `fffactory-linux-x64` that is not an x86-64 ELF, then copies both
executables and `install.sh` with mode 0755 (artifacts lose their modes) and
writes `SHA256SUMS`. It digests the copies it publishes, after signing, in
`sha256sum` format:

```text
<sha256>  fffactory-darwin-arm64
<sha256>  fffactory-linux-x64
```

The release has exactly four assets:

| Asset | Content |
| --- | --- |
| `fffactory-darwin-arm64` | The ad-hoc signed Apple Silicon executable. |
| `fffactory-linux-x64` | The x86-64 Linux (glibc) executable. |
| `SHA256SUMS` | The SHA-256 of both executables. |
| `install.sh` | The installer below. |

The asset bundle is not an asset: each executable embeds it. A tag's release
is created once; rerunning the workflow for a published tag fails, and a
changed release needs a new version.

### install.sh

`install.sh` is POSIX `sh`, because `curl … | sh` runs `dash` on Debian and
Ubuntu and bash 3.2 on macOS. Its body runs from one `main` call on the last
line, so a truncated download runs nothing. It needs `curl`, `awk`, `mktemp`
and `sha256sum` or `shasum`; not `jq`, and `gh` only as one way to
authenticate. It takes no arguments except `--help`; any other argument is a
usage error (exit 2).

The public repository supports anonymous installation once its first release
is published:

```sh
curl -fsSL https://github.com/yaunder/fffactory/releases/latest/download/install.sh | sh
```

GitHub CLI is an alternative; authentication remains supported for private
mirrors and API rate limits:

```sh
gh release download --repo yaunder/fffactory --pattern install.sh --output - | sh
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `FFFACTORY_VERSION` | Release to install: `0.1.0`, `v0.1.0` or `latest`. | `latest` |
| `FFFACTORY_INSTALL_DIR` | Absolute directory to install `fffactory` into. | `$HOME/.local/bin` |
| `GITHUB_TOKEN` | Token that can read the repository's releases. | unset |
| `FFFACTORY_GITHUB_API` | GitHub API base URL, for tests and mirrors. install.sh sends the token to the host it names. | `https://api.github.com` |

In order, it:

1. **Detects the platform** from `uname -s` and `uname -m`: `Darwin arm64` is
   `darwin-arm64`; `Darwin x86_64` is too when `sysctl -n sysctl.proc_translated`
   is 1 (a shell under Rosetta); `Linux x86_64` or `amd64` is `linux-x64`.
   Anything else is refused before any download:
   `fffactory has no executable for darwin-x64; releases support darwin-arm64 and linux-x64`
   (also `linux-arm64`, or the lowercased `uname` pair).
2. **Checks its inputs**: `curl` and a SHA-256 tool are present, `FFFACTORY_VERSION` is a
   release version, and `FFFACTORY_INSTALL_DIR` is absolute.
3. **Chooses credentials**: `GITHUB_TOKEN` if set, else
   `gh auth token --hostname github.com` if `gh` is installed and signed in,
   else none, which works for this public repository. It prints which
   source it uses, never the token.
4. **Finds the release** with `GET /repos/yaunder/fffactory/releases/latest` or
   `/releases/tags/v<version>`, and in its JSON the asset IDs of `SHA256SUMS`
   and `fffactory-<platform>`. The JSON is read by a small structural parser
   in `awk`, which tracks each value's path (`/assets/0/name`), so a name in
   the release body or an uploader object is not mistaken for an asset.
5. **Downloads** both assets with
   `GET /repos/yaunder/fffactory/releases/assets/<id>` and
   `Accept: application/octet-stream`, the one download that works with a
   token for a private repository and anonymously for a public one; a
   release's `browser_download_url` does not accept a token.
6. **Verifies** the executable's SHA-256 against its `SHA256SUMS` line.
7. **Installs** atomically: it copies the verified file to a temporary file
   in the install directory, sets mode 0755 and renames it over
   `fffactory`, so the target is always the previous executable or the whole
   new one. It never uses `sudo`.
8. **Reports** `Installed fffactory <version> (<platform>) at <path>`, and a
   warning with an `export PATH=…` line when the directory is not on `PATH`.

| Condition | Result |
| --- | --- |
| Unsupported platform | Refused before any download (exit 1). |
| No `curl`, or no `sha256sum` or `shasum` | Refused before any download (exit 1). |
| `FFFACTORY_VERSION` not a release version, or a relative `FFFACTORY_INSTALL_DIR` | Refused before any download (exit 1). |
| A token with characters no GitHub token has | Refused without echoing it (exit 1). |
| No release visible, without credentials | `No release … in yaunder/fffactory.`, with how to authenticate (exit 1). |
| No release visible with credentials, or GitHub answers 401 | Refused, naming the credential source (exit 1). |
| The release lacks `SHA256SUMS` or the platform's executable | `Release v… of yaunder/fffactory has no asset …` (exit 1). |
| `SHA256SUMS` has no valid line for the executable | Refused; nothing installed (exit 1). |
| The digest differs | `The SHA-256 of fffactory-<platform> does not match SHA256SUMS; nothing was installed` (exit 1). |
| The install directory cannot be created or written | Refused; nothing installed, no `sudo` (exit 1). |

Every failure leaves an existing `fffactory` as it was and removes the
script's temporary files.

How it keeps credentials safe:

- The token never appears in output or on a command line, where `ps` would
  show it: `curl` reads its headers from standard input (`--config -`),
  written by the shell's built-in `printf`.
- `-q` is the first argument of every `curl` call, so `curl` reads no
  `.curlrc` (`$CURL_HOME/.curlrc`, `$XDG_CONFIG_HOME/curlrc` or
  `~/.curlrc`), where `verbose` would print the token and `location-trusted`
  would send it past the redirect.
- `curl` drops the `Authorization` header when an asset download redirects to
  GitHub's storage host; the token reaches only the API.
- With the default HTTPS API, `curl` accepts HTTPS only, for redirects too.
- The token goes only to `FFFACTORY_GITHUB_API`'s host, `api.github.com`
  by default; point that variable only at a host trusted with the token.
- GitHub credentials are needed only to install, never to run the CLI.

Installing changes no instance: the script reads no `factory.json` and writes
only `fffactory` in the install directory and its own temporary files. It
never touches `.fffactory/` or `~/.fffactory/`.

### Modules and tests

Infrastructure only; no domain or application code changes.

| Module | Responsibility |
| --- | --- |
| `.github/workflows/release.yml` | Tag check, the executables workflow, and publishing. |
| `scripts/assemble-release.sh` | `check-tag`, and `assemble`: the release directory and `SHA256SUMS`. |
| `install.sh` | Platform detection, credentials, download, verification and atomic install. |

Tests: `tests/install/install.test.ts` runs `install.sh` with `/bin/sh`
against `tests/support/fake-github-releases.ts`, a local stand-in for the
Releases API that answers like a private repository (404 without the token,
401 with a wrong one) or a public one, and redirects asset downloads to a
second host that refuses any request carrying a token. Each run has a
private `PATH` of stand-in `uname`, `gh`, `sysctl` and `sudo` and a `curl`
wrapper that logs its arguments, and its own `HOME` and `TMPDIR`. They cover
the `GITHUB_TOKEN`-only, `gh`-only and anonymous paths, the token appearing in
no output or `curl` argument and not past the redirect, `-q` first on every
`curl` call and a hostile `.curlrc` in each location `curl` reads being
ignored, platform detection and refusal, checksum mismatch and missing sums,
missing assets, an empty `TMPDIR` after success and failures, indented JSON,
version selection, the install directory and `PATH` warning, an unwritable
directory, and an unchanged `HOME` and instance. `tests/scripts/assemble-release.test.ts` covers
`check-tag` and `assemble` in a stand-in repository, plus `check-source` with
local Git repositories (lightweight and annotated tags, a main ancestor,
unmerged code, a mismatched checkout, and missing refs). Workflow changes are
checked with `actionlint` by hand (no CI job runs it); publishing is exercised
only by pushing a tag.

Introduced by [#94](https://github.com/yaunder/factory/issues/94).
