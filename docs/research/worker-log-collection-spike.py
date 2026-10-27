#!/usr/bin/env python3
"""Research harness, not a production collector or a shipped factory command.

Default: synthetic experiments only; no account, factory, or home-directory reads.
Optional --local-claude-root PATH: copy existing transcript artifacts into a private
temporary archive, verify bytes, print only aggregates, and remove the archive.
Source files are never changed by the local experiment. Synthetic files exercise
mutations deterministically during streaming copies.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import zlib


CHUNK = 64 * 1024


def signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


class ScratchArchive:
    """Whole-file revisions are a correctness baseline, not a storage decision."""

    def __init__(self, root):
        self.root = root
        self.objects = root / "objects"
        self.objects.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.manifest = root / "manifest.json"
        self.revisions = json.loads(self.manifest.read_text()) if self.manifest.exists() else {}

    def capture(self, source, source_key, mutate=None, fail_at=None):
        stage = None
        pending_manifest = None
        source_fd = None
        try:
            source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            before = os.fstat(source_fd)
            if not stat.S_ISREG(before.st_mode):
                return {"status": "not_regular"}
            stage_fd, stage_name = tempfile.mkstemp(dir=self.root, prefix="pending-")
            stage = Path(stage_name)
            digest = hashlib.sha256()
            remaining = before.st_size
            with os.fdopen(stage_fd, "wb") as output:
                while remaining:
                    chunk = os.read(source_fd, min(CHUNK, remaining))
                    if not chunk:
                        return {"status": "changed"}
                    output.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
                    if mutate is not None:
                        mutation, mutate = mutate, None
                        mutation()
                output.flush()
                os.fsync(output.fileno())
            after = os.fstat(source_fd)
            current = os.stat(source, follow_symlinks=False)
            if signature(before) != signature(after) or signature(before) != signature(current):
                return {"status": "changed"}
            object_id = digest.hexdigest()
            target = self.objects / object_id
            if fail_at == "before_object":
                raise OSError("synthetic failure before object publication")
            if not target.exists():
                os.replace(stage, target)
            if fail_at == "after_object":
                raise OSError("synthetic failure after object publication")
            history = list(self.revisions.get(source_key, []))
            if history and history[-1]["sha256"] == object_id:
                return {"status": "unchanged", "bytes": before.st_size, "sha256": object_id}
            history.append({"sha256": object_id, "bytes": before.st_size})
            updated = dict(self.revisions)
            updated[source_key] = history
            fd, name = tempfile.mkstemp(dir=self.root, prefix="manifest-")
            pending_manifest = Path(name)
            with os.fdopen(fd, "w") as output:
                json.dump(updated, output)
                output.flush()
                os.fsync(output.fileno())
            if fail_at == "before_manifest":
                raise OSError("synthetic failure before manifest publication")
            os.replace(name, self.manifest)
            self.revisions = updated
            return {"status": "captured", "bytes": before.st_size, "sha256": object_id}
        except FileNotFoundError:
            return {"status": "missing"}
        finally:
            if source_fd is not None:
                os.close(source_fd)
            if stage is not None:
                stage.unlink(missing_ok=True)
            if pending_manifest is not None:
                pending_manifest.unlink(missing_ok=True)


def parse_status(path):
    """Index complete records separately from the raw byte-preserving archive."""
    counts = {"complete": 0, "invalid_complete": 0, "pending_tail_bytes": 0}
    with path.open("rb") as stream:
        for line in stream:
            if not line.endswith(b"\n"):
                counts["pending_tail_bytes"] = len(line)
                break
            try:
                json.loads(line)
                counts["complete"] += 1
            except (ValueError, UnicodeDecodeError):
                counts["invalid_complete"] += 1
    return counts


def artifact_kind(relative):
    parts = relative.parts
    if len(parts) == 2 and (relative.name.endswith(".jsonl") or ".jsonl.superseded-" in relative.name):
        return "main_transcript"
    if len(parts) >= 4 and parts[2] == "subagents" and relative.suffix in {".jsonl", ".json"}:
        return "subagent_artifact"
    if len(parts) >= 4 and parts[2] in {"tool-results", "mcp-tasks"}:
        return "saved_output"
    return None


def discover(root):
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not Path(base, d).is_symlink())
        for name in sorted(files):
            path = Path(base, name)
            relative = path.relative_to(root)
            if artifact_kind(relative) and not path.is_symlink():
                yield path, relative


def discover_claude(root):
    for source, relative in discover(root / "projects"):
        yield source, Path("projects") / relative
    for directory in ("file-history", "paste-cache"):
        base = root / directory
        if base.is_symlink():
            continue
        for current, dirs, files in os.walk(base, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not Path(current, d).is_symlink())
            for name in sorted(files):
                source = Path(current, name)
                if not source.is_symlink():
                    yield source, Path(directory) / source.relative_to(base)


def join_records(records, session_paths):
    """Minimal observed metadata join. Keep all candidates; never pick by cwd."""
    result = []
    for record in records:
        persistence = record.get("persistence") or {}
        if persistence.get("provider") != "claude":
            continue
        native_id = persistence.get("sessionId")
        labels = record.get("labels") or {}
        dispatched = labels.get("factory-dispatch") == "true"
        result.append({
            "attempt": record["id"],
            "epic": labels.get("factory-epic") if dispatched else None,
            "repository": labels.get("factory-repository") if dispatched else None,
            "session": native_id,
            "transcript_candidates": session_paths.get(native_id, []),
        })
    return result


def join_subagents(children, tool_ids_by_parent):
    result = []
    for child in children:
        metadata = child.get("metadata")
        parent = None
        matched = False
        if metadata is not None:
            parent = metadata.get("parentAgentId") or child["session"]
            matched = metadata.get("toolUseId") in tool_ids_by_parent.get(parent, set())
        result.append({"agent": child["agent"], "session": child["session"],
                       "parent": parent, "observed_parent_tool_call": matched})
    return result


def synthetic_experiments(root):
    source = root / "source"
    source.mkdir()
    archive = ScratchArchive(root / "archive")
    path = source / "session.jsonl"
    results = []

    def passed(name):
        results.append(name)

    row = b'{"type":"user","message":{"content":"synthetic"}}\n'
    original = row * 3000
    path.write_bytes(original)
    first = archive.capture(path, "session")
    assert first["status"] == "captured"
    assert (archive.objects / first["sha256"]).read_bytes() == original
    assert archive.capture(path, "session")["status"] == "unchanged"
    assert len(archive.revisions["session"]) == 1
    passed("exact bytes and unchanged-file deduplication")

    def append():
        with path.open("ab") as stream:
            stream.write(row)

    assert archive.capture(path, "session", mutate=append)["status"] == "changed"
    assert len(archive.revisions["session"]) == 1
    assert archive.capture(path, "session")["status"] == "captured"
    passed("append during copy deferred, then recovered")

    assert archive.capture(path, "session", mutate=lambda: path.write_bytes(row))["status"] == "changed"
    short = archive.capture(path, "session")
    assert short["status"] == "captured"
    assert (archive.objects / first["sha256"]).read_bytes() == original
    passed("truncation during copy rejected; prior content retained")

    path.write_bytes(original)

    def same_length_rewrite():
        path.write_bytes(original.replace(b"synthetic", b"different"))

    assert archive.capture(path, "session", mutate=same_length_rewrite)["status"] == "changed"
    assert archive.capture(path, "session")["status"] == "captured"
    passed("same-length rewrite detected")

    replacement = source / "replacement"
    replacement.write_bytes(original)
    assert archive.capture(path, "session", mutate=lambda: os.replace(replacement, path))["status"] == "changed"
    assert archive.capture(path, "session")["status"] == "captured"
    passed("atomic source replacement detected")

    path.write_bytes(row + b'{"type":"assistant"')
    partial = archive.capture(path, "partial")
    assert parse_status(archive.objects / partial["sha256"]) == {
        "complete": 1, "invalid_complete": 0, "pending_tail_bytes": 19,
    }
    with path.open("ab") as stream:
        stream.write(b'}\ninvalid\n' + row)
    complete = archive.capture(path, "partial")
    assert parse_status(archive.objects / complete["sha256"]) == {
        "complete": 3, "invalid_complete": 1, "pending_tail_bytes": 0,
    }
    passed("partial JSONL tail preserved but not indexed; malformed complete record isolated")

    for failure in ("before_object", "after_object", "before_manifest"):
        path.write_bytes(row + json.dumps({"failure": failure}).encode() + b"\n")
        try:
            archive.capture(path, failure, fail_at=failure)
            raise AssertionError("failure injection did not run")
        except OSError:
            pass
        assert failure not in archive.revisions
        archive = ScratchArchive(archive.root)
        assert failure not in archive.revisions
        assert archive.capture(path, failure)["status"] == "captured"
        archive = ScratchArchive(archive.root)
        assert archive.capture(path, failure)["status"] == "unchanged"
    passed("interrupted publication and collector restart recover idempotently")

    path.unlink()
    assert archive.capture(path, "session")["status"] == "missing"
    assert (archive.objects / first["sha256"]).exists()
    path.symlink_to(archive.objects / first["sha256"])
    try:
        archive.capture(path, "symlink")
        raise AssertionError("symlink followed")
    except OSError:
        pass
    passed("source deletion retains archive; final-component symlink is refused")

    records = [
        {"id": "attempt-a", "cwd": "/new-worktree", "labels": {
            "factory-dispatch": "true", "factory-repository": "sample", "factory-epic": "42",
        }, "persistence": {"provider": "claude", "sessionId": "conversation-a"}},
        {"id": "attempt-b", "labels": {
            "factory-dispatch": "true", "factory-repository": "sample", "factory-epic": "42",
        }, "persistence": {"provider": "claude", "sessionId": "conversation-b"}},
        {"id": "manual", "labels": {}, "persistence": {"provider": "claude", "sessionId": "missing"}},
    ]
    joined = join_records(records, {
        "conversation-a": ["old-project/conversation-a.jsonl", "another-project/conversation-a.jsonl"],
        "conversation-b": ["project/conversation-b.jsonl"],
    })
    assert [r["attempt"] for r in joined[:2]] == ["attempt-a", "attempt-b"]
    assert joined[0]["epic"] == joined[1]["epic"] == "42"
    assert len(joined[0]["transcript_candidates"]) == 2
    assert joined[2]["epic"] is None and joined[2]["transcript_candidates"] == []
    records[0]["persistence"]["sessionId"] = "conversation-c"
    rebound = join_records(records, {})
    assert joined[0]["session"] == "conversation-a" and rebound[0]["session"] == "conversation-c"
    assert joined[0]["attempt"] == rebound[0]["attempt"]
    passed("epic-to-attempt join, absent metadata, multiple paths, and observed session rebinding")

    children = [
        {"agent": "child-a", "session": "conversation-a", "metadata": {
            "toolUseId": "tool-main", "spawnDepth": 1,
        }},
        {"agent": "child-b", "session": "conversation-a", "metadata": {
            "parentAgentId": "child-a", "toolUseId": "tool-child", "spawnDepth": 2,
        }},
        {"agent": "child-c", "session": "conversation-a"},
    ]
    nesting = join_subagents(children, {
        "conversation-a": {"tool-main"}, "child-a": {"tool-child"},
    })
    assert nesting[0]["parent"] == "conversation-a" and nesting[0]["observed_parent_tool_call"]
    assert nesting[1]["parent"] == "child-a" and nesting[1]["observed_parent_tool_call"]
    assert nesting[2]["parent"] is None and nesting[2]["session"] == "conversation-a"
    passed("nested subagents use sidecar tool IDs and parentAgentId; missing ancestry stays unknown")

    expected = [
        "project/conversation.jsonl",
        "project/conversation/subagents/agent-child.jsonl",
        "project/conversation/subagents/agent-child.meta.json",
        "project/conversation/tool-results/tool.txt",
        "project/conversation/mcp-tasks/task.json",
        "project/conversation.jsonl.superseded-synthetic",
    ]
    assert all(artifact_kind(Path(value)) for value in expected)
    assert artifact_kind(Path("project/memory/MEMORY.md")) is None
    assert artifact_kind(Path("settings.json")) is None
    passed("artifact boundary includes descendants and saved outputs, excludes memory and settings")

    claude = root / "synthetic-claude"
    fixture_paths = [
        "projects/project/conversation.jsonl",
        "file-history/conversation/backup@v1",
        "paste-cache/synthetic.txt",
        "projects/project/memory/MEMORY.md",
        "sessions/synthetic.key",
        "shell-snapshots/synthetic.sh",
    ]
    for relative in fixture_paths:
        fixture = claude / relative
        fixture.parent.mkdir(parents=True, exist_ok=True)
        fixture.write_bytes(b"synthetic fixture, no real credentials\n")
    assert {str(relative) for _, relative in discover_claude(claude)} == set(fixture_paths[:3])
    passed("external file-history and paste artifacts included; transient keys and shell environment excluded")
    return {"passed": len(results), "experiments": results}


def local_experiment(claude, scratch):
    """Explicit opt-in, read-only sources; all copied private bytes are ephemeral."""
    archive = ScratchArchive(scratch / "local-archive")
    totals = {"discovered": 0, "captured": 0, "changed": 0, "missing": 0,
              "captured_bytes": 0, "verified_objects": 0, "compressed_bytes": 0}
    start = time.monotonic()
    for source, relative in discover_claude(claude):
        totals["discovered"] += 1
        result = archive.capture(source, str(relative))
        totals[result["status"]] = totals.get(result["status"], 0) + 1
        if result["status"] != "captured":
            continue
        target = archive.objects / result["sha256"]
        assert digest_file(target) == result["sha256"]
        totals["verified_objects"] += 1
        totals["captured_bytes"] += result["bytes"]
        compressor = zlib.compressobj()
        with target.open("rb") as stream:
            for chunk in iter(lambda: stream.read(CHUNK), b""):
                totals["compressed_bytes"] += len(compressor.compress(chunk))
        totals["compressed_bytes"] += len(compressor.flush())
    totals["copy_verify_compress_seconds"] = round(time.monotonic() - start, 3)
    archive = ScratchArchive(archive.root)
    repeat = {"unchanged": 0, "captured": 0, "changed": 0, "missing": 0}
    for source, relative in discover_claude(claude):
        result = archive.capture(source, str(relative))
        repeat[result["status"]] = repeat.get(result["status"], 0) + 1
    totals["second_pass_after_restart"] = repeat
    totals["stream_buffer_bytes"] = CHUNK
    totals["source_files_modified"] = False
    return totals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-claude-root", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="fffactory-log-spike-") as temporary:
        scratch = Path(temporary)
        result = {"synthetic": synthetic_experiments(scratch)}
        if args.local_claude_root:
            if not args.local_claude_root.is_dir() or args.local_claude_root.is_symlink():
                parser.error("local Claude root must be an existing directory, not a symlink")
            if not (args.local_claude_root / "projects").is_dir() or (args.local_claude_root / "projects").is_symlink():
                parser.error("local projects must be an existing directory, not a symlink")
            result["local"] = local_experiment(args.local_claude_root, scratch)
    result["temporary_archive_removed"] = True
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
