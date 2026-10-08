# The root activator, /usr/local/libexec/fffactory-activate (worker-bootstrap §Activator).
# Each test_* function runs as root in a fresh container; see run-case.sh.
# shellcheck shell=bash

ACTIVATE=/usr/local/libexec/fffactory-activate
RELEASES=/opt/fffactory/releases
WORK=/tmp/activator-test

setup() {
  install -D -o root -g root -m 0755 /bootstrap/fffactory-activate "$ACTIVATE"
  install -d -o root -g root -m 0755 "$RELEASES"
  mkdir -p "$WORK"
  stub_release "$WORK/release" 1.2.3
  pack "$WORK/release" "$WORK/release.tar.gz"
}

releases_listing() {
  ls -A "$RELEASES"
}

assert_nothing_unpacked() {
  assert_eq "$(releases_listing)" "" "releases directory"
  assert_absent /tmp/host-apply.record
}

test_no_arguments_is_a_usage_error() {
  run "$ACTIVATE"
  assert_status 64
  assert_contains "$(cat "$ERR")" "usage: fffactory-activate TARBALL SHA256 | repositories | control-plane ACTION | dispatch ACTION"
  assert_nothing_unpacked
}

test_one_or_three_arguments_are_a_usage_error() {
  local digest
  digest="$(digest_of "$WORK/release.tar.gz")"
  run "$ACTIVATE" "$WORK/release.tar.gz"
  assert_status 64
  run "$ACTIVATE" "$WORK/release.tar.gz" "$digest" extra
  assert_status 64
  assert_nothing_unpacked
}

test_a_malformed_digest_is_a_usage_error() {
  local digest bad
  digest="$(digest_of "$WORK/release.tar.gz")"
  for bad in "" "${digest:1}" "${digest}0" "${digest^^}" "sha256:${digest}" "${digest:0:63}g"; do
    run "$ACTIVATE" "$WORK/release.tar.gz" "$bad"
    assert_status 64
  done
  assert_nothing_unpacked
}

test_a_relative_tarball_path_is_a_usage_error() {
  cd "$WORK" || fail "cannot enter $WORK"
  run "$ACTIVATE" release.tar.gz "$(digest_of release.tar.gz)"
  assert_status 64
  assert_nothing_unpacked
}

test_a_missing_directory_or_symlinked_tarball_is_refused() {
  local digest
  digest="$(digest_of "$WORK/release.tar.gz")"
  ln -s "$WORK/release.tar.gz" "$WORK/link.tar.gz"
  for path in "$WORK/missing.tar.gz" "$WORK" "$WORK/link.tar.gz"; do
    run "$ACTIVATE" "$path" "$digest"
    assert_status 65
    assert_contains "$(cat "$ERR")" "is not a regular file"
  done
  assert_nothing_unpacked
}

test_a_digest_mismatch_unpacks_nothing() {
  local actual expected
  actual="$(digest_of "$WORK/release.tar.gz")"
  expected="$(printf 'another build' | sha256sum)"
  expected="${expected%% *}"
  run "$ACTIVATE" "$WORK/release.tar.gz" "$expected"
  assert_status 65
  assert_contains "$(cat "$ERR")" "does not match the expected SHA-256; nothing was unpacked"
  # The digest of whatever root read is never printed.
  assert_not_contains "$(cat "$ERR")" "$actual" "stderr"
  assert_eq "$(cat "$OUT")" "" "stdout"
  assert_nothing_unpacked
}

test_unpacks_into_the_versioned_release_directory() {
  local digest target="$RELEASES/1.2.3"
  digest="$(digest_of "$WORK/release.tar.gz")"
  run "$ACTIVATE" "$WORK/release.tar.gz" "$digest"
  assert_status 0
  assert_eq "$(releases_listing)" "1.2.3" "releases directory"
  assert_mode "$target" 755 root:root
  assert_mode "$target/bin" 755 root:root
  assert_mode "$target/bin/fffactory" 755 root:root
  assert_mode "$target/terraform/main.tf" 644 root:root
  cmp "$WORK/release/terraform/main.tf" "$target/terraform/main.tf" || fail "main.tf differs"
  assert_eq "$(cat "$target/.fffactory-assets.json")" \
    "$(printf '{\n  "release": "1.2.3",\n  "sha256": "%s"\n}' "$digest")" "marker"
  assert_mode "$target/.fffactory-assets.json" 644 root:root
}

test_runs_that_releases_host_apply_as_root() {
  local digest
  digest="$(digest_of "$WORK/release.tar.gz")"
  printf '{"projection":1}\n' >"$WORK/stdin"
  STDIN="$WORK/stdin" run env CALLER_SECRET=leak "$ACTIVATE" "$WORK/release.tar.gz" "$digest"
  assert_status 0
  local record
  record="$(cat /tmp/host-apply.record)"
  assert_contains "$record" "args=host apply" "host apply record"
  assert_contains "$record" "uid=0" "host apply record"
  assert_contains "$record" "cwd=/"$'\n' "host apply record"
  assert_contains "$record" "self=$RELEASES/1.2.3/bin/fffactory" "host apply record"
  assert_not_contains "$record" "CALLER_SECRET" "host apply environment"
  # Standard input reaches host apply; standard output is host apply's alone.
  assert_eq "$(cat /tmp/host-apply.stdin)" '{"projection":1}' "host apply stdin"
  assert_eq "$(cat "$OUT")" '{"host_apply":"ran"}' "stdout"
  assert_eq "$(readlink /opt/fffactory/current)" "releases/1.2.3" "active release"
  assert_contains "$(cat "$ERR")" "unpacked release 1.2.3 into $RELEASES/1.2.3"
}

test_runs_only_the_active_releases_repository_endpoint_as_root() {
  run "$ACTIVATE" "$WORK/release.tar.gz" "$(digest_of "$WORK/release.tar.gz")"
  assert_status 0
  rm -f /tmp/host-apply.record
  printf '{"repositories":1}\n' >"$WORK/stdin"
  STDIN="$WORK/stdin" run env CALLER_SECRET=leak "$ACTIVATE" repositories
  assert_status 0
  local record
  record="$(cat /tmp/host-apply.record)"
  assert_contains "$record" "args=host repositories --apply" "repository endpoint record"
  assert_contains "$record" "uid=0" "repository endpoint record"
  assert_contains "$record" "self=/opt/fffactory/current/bin/fffactory" "repository endpoint record"
  assert_not_contains "$record" "CALLER_SECRET" "repository endpoint environment"
  assert_eq "$(cat /tmp/host-apply.stdin)" '{"repositories":1}' "repository endpoint stdin"
}

test_runs_only_fixed_control_plane_actions_through_the_active_release() {
  run "$ACTIVATE" "$WORK/release.tar.gz" "$(digest_of "$WORK/release.tar.gz")"
  assert_status 0
  rm -f /tmp/host-apply.record
  printf '{"projection":1}\n' >"$WORK/stdin"
  STDIN="$WORK/stdin" run env CALLER_SECRET=leak "$ACTIVATE" control-plane install
  assert_status 0
  local record
  record="$(cat /tmp/host-apply.record)"
  assert_contains "$record" "args=host control-plane install" "control-plane endpoint record"
  assert_contains "$record" "uid=0" "control-plane endpoint record"
  assert_contains "$record" "self=/opt/fffactory/current/bin/fffactory" "control-plane endpoint record"
  assert_not_contains "$record" "CALLER_SECRET" "control-plane endpoint environment"
  assert_eq "$(cat /tmp/host-apply.stdin)" '{"projection":1}' "control-plane endpoint stdin"

  for action in arbitrary 'restart paseo.service' ''; do
    run "$ACTIVATE" control-plane "$action"
    assert_status 64
  done
}

test_runs_only_fixed_dispatch_actions_through_the_active_release() {
  run "$ACTIVATE" "$WORK/release.tar.gz" "$(digest_of "$WORK/release.tar.gz")"
  assert_status 0
  rm -f /tmp/host-apply.record
  printf '{"dispatch":1}\n' >"$WORK/stdin"
  STDIN="$WORK/stdin" run env CALLER_SECRET=leak "$ACTIVATE" dispatch reconcile
  assert_status 0
  local record
  record="$(cat /tmp/host-apply.record)"
  assert_contains "$record" "args=host dispatch reconcile" "dispatch endpoint record"
  assert_contains "$record" "uid=0" "dispatch endpoint record"
  assert_contains "$record" "self=/opt/fffactory/current/bin/fffactory" "dispatch endpoint record"
  assert_not_contains "$record" "CALLER_SECRET" "dispatch endpoint environment"
  assert_eq "$(cat /tmp/host-apply.stdin)" '{"dispatch":1}' "dispatch endpoint stdin"

  for action in arbitrary 'inspect schedule' ''; do
    run "$ACTIVATE" dispatch "$action"
    assert_status 64
  done
}

test_staging_left_by_a_killed_activation_is_removed() {
  mkdir -p "$RELEASES/.activate.killed/release/bin"
  echo partial >"$RELEASES/.activate.killed/release/bin/fffactory"
  run "$ACTIVATE" "$WORK/release.tar.gz" "$(digest_of "$WORK/release.tar.gz")"
  assert_status 0
  assert_eq "$(releases_listing)" "1.2.3" "releases directory"
}

test_host_apply_exit_status_is_the_activators() {
  echo 3 >/tmp/host-apply.exit
  run "$ACTIVATE" "$WORK/release.tar.gz" "$(digest_of "$WORK/release.tar.gz")"
  assert_status 3
}

test_the_packed_release_bundle_activates() {
  # Packed from the repository's assets/ by the fffactory packer, with a stub bin/fffactory.
  local version
  version="$(cat /fixtures/release.version)"
  run "$ACTIVATE" /fixtures/release.tar.gz "$(cat /fixtures/release.tar.gz.sha256)"
  assert_status 0
  assert_eq "$(releases_listing)" "$version" "releases directory"
  [[ -f "$RELEASES/$version/terraform/factory/main.tf" ]] || fail "terraform modules missing"
  assert_contains "$(cat /tmp/host-apply.record)" "self=$RELEASES/$version/bin/fffactory"
}

test_rerunning_the_same_bundle_keeps_the_unpacked_release() {
  local digest
  digest="$(digest_of "$WORK/release.tar.gz")"
  run "$ACTIVATE" "$WORK/release.tar.gz" "$digest"
  assert_status 0
  echo edited >>"$RELEASES/1.2.3/terraform/main.tf"
  run "$ACTIVATE" "$WORK/release.tar.gz" "$digest"
  assert_status 0
  assert_eq "$(tail -n 1 "$RELEASES/1.2.3/terraform/main.tf")" edited "rerun kept the release"
  assert_contains "$(cat "$ERR")" "release 1.2.3 is already unpacked"
  assert_eq "$(grep -c '^args=host apply$' /tmp/host-apply.record)" 2 "host apply runs"
}

test_another_build_of_the_same_version_replaces_it() {
  run "$ACTIVATE" "$WORK/release.tar.gz" "$(digest_of "$WORK/release.tar.gz")"
  assert_status 0
  printf 'terraform { required_version = ">= 1.11.0" }\n' >"$WORK/release/terraform/main.tf"
  pack "$WORK/release" "$WORK/rebuilt.tar.gz"
  local digest
  digest="$(digest_of "$WORK/rebuilt.tar.gz")"
  run "$ACTIVATE" "$WORK/rebuilt.tar.gz" "$digest"
  assert_status 0
  cmp "$WORK/release/terraform/main.tf" "$RELEASES/1.2.3/terraform/main.tf" || fail "not replaced"
  assert_contains "$(cat "$RELEASES/1.2.3/.fffactory-assets.json")" "$digest" "marker"
  assert_eq "$(releases_listing)" "1.2.3" "releases directory"
}

# hostile NAME: builds $WORK/NAME.tar.gz from a variation of the stub release.
hostile() {
  local name="$1" dir="$WORK/$1" out="$WORK/$1.tar.gz"
  stub_release "$dir" 1.2.3
  local -a extra=()
  case "$name" in
    traversal)
      echo escaped >"$WORK/escape"
      extra=(../escape)
      ;;
    absolute)
      echo escaped >"$WORK/absolute-escape"
      extra=("$WORK/absolute-escape")
      ;;
    symlink) ln -s /etc/shadow "$dir/link" ;;
    hardlink) ln "$dir/release.json" "$dir/hard" ;;
    setuid) chmod 4755 "$dir/bin/fffactory" ;;
    writable) chmod 0666 "$dir/terraform/main.tf" ;;
    marker) printf '{}\n' >"$dir/.fffactory-assets.json" ;;
    backslash) echo x >"$dir/terraform/back\\slash" ;;
    no-metadata) rm "$dir/release.json" ;;
    bad-version) printf '{\n  "release": "../../../etc"\n}\n' >"$dir/release.json" ;;
    extra-key) printf '{\n  "release": "1.2.3",\n  "run": "sh"\n}\n' >"$dir/release.json" ;;
    no-executable) rm "$dir/bin/fffactory" ;;
    file-and-directory) echo x >"$dir/bin-file" ;;
  esac
  case "$name" in
    directory)
      (cd "$dir" && tar --format=ustar -czf "$out" --no-recursion release.json bin bin/fffactory)
      ;;
    duplicate)
      # Without --hard-dereference, tar would store the second copy as a hard link.
      (cd "$dir" && tar --format=ustar --hard-dereference -czf "$out" \
        release.json bin/fffactory release.json)
      ;;
    symlink | hardlink)
      (cd "$dir" && find . \( -type f -o -type l \) -printf '%P\n' | LC_ALL=C sort |
        tar --format=ustar --no-recursion -czf "$out" -T -)
      ;;
    file-and-directory)
      # Every entry passes the checks, but tar cannot unpack a file bin and bin/fffactory.
      (cd "$dir" && tar --format=ustar --transform='s,^bin-file$,bin,' -czf "$out" \
        release.json bin-file bin/fffactory)
      ;;
    not-gzip) printf 'not a tarball\n' >"$out" ;;
    *)
      local -a files
      mapfile -t files < <(cd "$dir" && find . -type f -printf '%P\n' | LC_ALL=C sort)
      # -P keeps absolute and ../ names as given, as a hostile packer would.
      (cd "$dir" && tar --format=ustar -czPf "$out" --no-recursion "${files[@]}" "${extra[@]}")
      ;;
  esac
}

test_unsafe_bundles_are_refused_before_anything_is_unpacked() {
  local entry name reason
  for entry in \
    "traversal:is not a safe relative path" \
    "absolute:is not a safe relative path" \
    "backslash:is not printable ASCII without backslashes" \
    "symlink:is not a regular file with mode 0644 or 0755" \
    "hardlink:is not a regular file with mode 0644 or 0755" \
    "directory:is not a regular file with mode 0644 or 0755" \
    "setuid:is not a regular file with mode 0644 or 0755" \
    "writable:is not a regular file with mode 0644 or 0755" \
    "duplicate:appears twice" \
    "marker:is reserved for the activator's marker" \
    "no-metadata:has no release.json" \
    "bad-version:release.json does not name a release version" \
    "extra-key:release.json does not name a release version" \
    "not-gzip:is not a gzipped tar archive" \
    "no-executable:has no executable bin/fffactory" \
    "file-and-directory:could not be unpacked; nothing was unpacked"; do
    name="${entry%%:*}"
    reason="${entry#*:}"
    hostile "$name"
    run "$ACTIVATE" "$WORK/$name.tar.gz" "$(digest_of "$WORK/$name.tar.gz")"
    [[ "$STATUS" == 65 ]] || fail "$name: expected exit 65, got $STATUS: $(cat "$ERR")"
    assert_contains "$(cat "$ERR")" "$reason" "$name: stderr"
    [[ -z "$(releases_listing)" ]] || fail "$name: releases directory holds $(releases_listing)"
    assert_absent /tmp/host-apply.record
  done
  assert_absent "$RELEASES/escape"
  assert_absent /opt/fffactory/escape
  assert_absent /opt/escape
}

test_only_root_may_activate() {
  chmod 0755 "$WORK"
  chmod 0644 "$WORK/release.tar.gz"
  run runuser -u nobody -- "$ACTIVATE" "$WORK/release.tar.gz" "$(digest_of "$WORK/release.tar.gz")"
  assert_status 77
  assert_contains "$(cat "$ERR")" "must run as root"
  assert_nothing_unpacked
}

test_a_concurrent_activation_is_refused() {
  flock /run/fffactory-activate.lock sleep 60 &
  local holder=$!
  # Wait, at most five seconds, until the holder has the lock.
  local _
  for _ in $(seq 1 50); do
    flock -n /run/fffactory-activate.lock true || break
    sleep 0.1
  done
  run "$ACTIVATE" "$WORK/release.tar.gz" "$(digest_of "$WORK/release.tar.gz")"
  kill "$holder"
  assert_status 75
  assert_contains "$(cat "$ERR")" "another activation is running"
  assert_nothing_unpacked
}
