#!/usr/bin/env python3

"""Run the dispatcher against a local Git remote and mocked GitHub/Paseo CLIs."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

DISPATCH_DIR = Path(__file__).resolve().parents[1]
DISPATCHER = DISPATCH_DIR / "factory-dispatch"
# The wrapped repository sync and FFFlow adoption check ship beside dispatch in the release.
SYNC = DISPATCH_DIR.parent / "repositories" / "sync-repositories.sh"
ADOPTION = DISPATCH_DIR.parent / "repositories" / "check-ffflow-adoption.sh"

MOCK_GH = r'''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
mode = os.environ.get("MOCK_READINESS", "ready")
if a[:2] == ["issue", "list"]:
    if "ready" in a:
        value = [{"number":101,"title":"Epic: Test","state":"OPEN"}]
    else:
        value = [{"number":102,"title":"T1: Test","state":"OPEN","body":"Acceptance criteria"}]
elif a[:2] == ["issue", "view"]:
    if a[2] == "300": value = {"number":300,"state":"OPEN" if mode == "dependency" else "CLOSED"}
    else: value = {"number":102,"state":"OPEN","body":"- Depends on: #300" if mode == "dependency" else "Acceptance criteria","comments":[]}
elif a[:2] == ["pr", "list"]:
    value = [{"number":8,"title":"Fix #102","body":"","headRefName":"task/test"}] if mode == "pr" else []
else:
    raise SystemExit("unexpected gh command: " + str(a))
print(json.dumps(value))
'''

MOCK_PASEO = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
state = Path(os.environ["MOCK_PASEO_STATE"])
a = sys.argv[1:]
if a[0] == "ls":
    print(state.read_text())
elif a[0] == "run":
    Path(os.environ["MOCK_PASEO_RUN_ARGS"]).write_text(json.dumps({
      "args": a, "parent": os.environ.get("PASEO_AGENT_ID")}))
    state.write_text(json.dumps([{"id":"agent-1","status":"running"}]))
    print(json.dumps({"agentId":"agent-1","status":"running"}))
else: raise SystemExit("unexpected paseo command: " + str(a))
'''


class FactoryDispatchTest(unittest.TestCase):
    def git(self, *args, cwd=None):
        return subprocess.run(("git", *args), cwd=cwd, env=self.env, text=True,
                              capture_output=True, check=True).stdout.strip()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.remote = self.root / "remote.git"
        self.checkout = self.root / "repos" / "product"
        self.cwd = self.root / "home" / "factory"
        self.cwd.mkdir(parents=True)
        self.manifest = self.root / "repositories.json"
        self.projection = self.root / "dispatch.json"
        self.paseo_state = self.root / "agents.json"
        self.paseo_args = self.root / "run-args.json"
        self.sync_calls = self.root / "sync-calls"
        self.paseo_state.write_text("[]")
        self.gitconfig = self.root / "gitconfig"
        self.gitconfig.write_text(f'[url "file://{self.remote}"]\n\tinsteadOf = https://github.com/acme/product.git\n')
        self.env = os.environ.copy()
        self.env.update({"GIT_CONFIG_GLOBAL": str(self.gitconfig),
                         "PATH": str(self.bin) + os.pathsep + self.env["PATH"],
                         "MOCK_PASEO_STATE": str(self.paseo_state),
                         "MOCK_PASEO_RUN_ARGS": str(self.paseo_args),
                         "MOCK_SYNC_CALLS": str(self.sync_calls),
                         "FACTORY_REPOSITORY_ROOT": str(self.root / "repos"),
                         "PASEO_HOME": str(self.root / "paseo"),
                         "FACTORY_FFFLOW_CHECK_BIN": str(ADOPTION),
                         "FACTORY_PASEO_BIN": str(self.bin / "paseo-auth")})
        for name, content in (("gh", MOCK_GH), ("paseo-auth", MOCK_PASEO)):
            path = self.bin / name
            path.write_text(content)
            path.chmod(0o755)
        sync_wrapper = self.bin / "sync-factory-repositories"
        sync_wrapper.write_text(f'#!/bin/sh\nprintf "%s\\n" "$1" >> "$MOCK_SYNC_CALLS"\nexec "{SYNC}" "$@"\n')
        sync_wrapper.chmod(0o755)
        self.env["FACTORY_REPOSITORY_SYNC_BIN"] = str(sync_wrapper)
        self.git("init", "--bare", "--initial-branch=main", str(self.remote))
        self.git("clone", str(self.remote), str(self.checkout))
        self.git("config", "user.name", "Test", cwd=self.checkout)
        self.git("config", "user.email", "test@example.invalid", cwd=self.checkout)
        config = self.checkout / ".ffflow" / "config.yaml"
        config.parent.mkdir()
        config.write_text("version: 1\nlevel: L1\nffflow_version: 0.4.1\n")
        self.git("add", ".ffflow/config.yaml", cwd=self.checkout)
        self.git("commit", "-m", "Adopt FFFlow", cwd=self.checkout)
        self.git("push", "origin", "main", cwd=self.checkout)
        self.git("remote", "set-url", "origin", "https://github.com/acme/product.git", cwd=self.checkout)
        self.manifest.write_text(json.dumps({
          "version":2, "repositories":{"product":{"remote":"https://github.com/acme/product.git",
              "path":"product","branch":"main","update_policy":"fast-forward-only"}},
          "repository_sets":{"core":["product"]},
          "hosts":{"test-host":{"repository_sets":["core"]}}
        }))
        self.schedule = {"cron": "*/17 * * * *", "timezone": "America/Chicago",
                         "provider": "codex", "model": "configured-model",
                         "mode": "default", "cwd": str(self.cwd)}
        self.write_projection()

    def write_projection(self):
        self.projection.write_text(json.dumps({"protocol_version": 1, "hostname": "test-host",
            "requested": True, "active": True, "blockers": [], "schedule": self.schedule}))

    def invoke(self, mode="ready"):
        env = self.env.copy()
        env["MOCK_READINESS"] = mode
        env["PASEO_AGENT_ID"] = "scheduled-agent"
        result = subprocess.run((str(DISPATCHER), "--manifest", str(self.manifest),
                                 "--projection", str(self.projection),
                                 "--repository-root", str(self.root / "repos"), "--host", "test-host"),
                                cwd=self.cwd, env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_starts_one_top_level_agent_then_respects_cap(self):
        first = self.invoke()
        self.assertEqual(first["started"][0]["agent_id"], "agent-1")
        call = json.loads(self.paseo_args.read_text())
        self.assertIsNone(call["parent"])
        self.assertEqual(call["args"][call["args"].index("--provider") + 1],
                         "codex/configured-model")
        self.assertEqual(call["args"][call["args"].index("--mode") + 1], "default")
        self.assertIn("--new-workspace", call["args"])
        self.assertIn("factory-epic=101", call["args"])
        self.assertTrue(call["args"][-1].startswith("/fff:work-epic 101\n"))
        self.assertNotIn("epic:<id>", call["args"][-1])
        self.assertIn("create epic/101 from origin/main", call["args"][-1])
        second = self.invoke()
        self.assertEqual(second["started"], [])
        self.assertEqual(second["skipped"][0]["reason"], "host cap reached")

    def test_readiness_reasons(self):
        for mode, reason in (("pr", "open PR #8"), ("dependency", "open external dependency #300")):
            with self.subTest(mode=mode):
                result = self.invoke(mode)
                self.assertEqual(result["started"], [])
                self.assertIn(reason, result["skipped"][0]["reason"])
        self.git("update-ref", "refs/heads/epic/101", "HEAD", cwd=self.checkout)
        self.git("push", "origin", "epic/101", cwd=self.checkout)
        result = self.invoke()
        self.assertIn("remote branch epic/101", result["skipped"][0]["reason"])

    def test_dirty_checkout_is_skipped(self):
        (self.checkout / "dirty.txt").write_text("local change")
        result = self.invoke()
        self.assertEqual(result["started"], [])
        self.assertIn("dirty", result["skipped"][0]["reason"])

    def test_non_main_branch_and_configured_executor_are_honored(self):
        self.git("branch", "-m", "develop", cwd=self.checkout)
        self.git("push", "origin", "develop", cwd=self.checkout)
        manifest = json.loads(self.manifest.read_text())
        manifest["repositories"]["product"]["branch"] = "develop"
        self.manifest.write_text(json.dumps(manifest))
        result = self.invoke()
        self.assertEqual(result["started"][0]["agent_id"], "agent-1")
        call = json.loads(self.paseo_args.read_text())
        self.assertEqual(call["args"][call["args"].index("--base") + 1], "origin/develop")
        self.assertIn("from origin/develop", call["args"][-1])

    def test_adoption_only_never_launches_work(self):
        result = subprocess.run((str(DISPATCHER), "--adoption-only", "--manifest",
                                 str(self.manifest), "--host", "test-host"), env=self.env,
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["adoption"], "passed")
        self.assertFalse(self.paseo_args.exists())

    def test_idle_agent_prevents_duplicate_without_using_host_cap(self):
        self.paseo_state.write_text(json.dumps([{"id":"agent-old","status":"idle"}]))
        result = self.invoke()
        self.assertEqual(result["running"], 0)
        self.assertEqual(result["started"], [])
        self.assertEqual(result["skipped"][0]["reason"], "existing dispatched agent")

    def test_wrong_remote_is_skipped(self):
        self.git("remote", "set-url", "origin", "https://github.com/acme/other.git", cwd=self.checkout)
        result = self.invoke()
        self.assertEqual(result["started"], [])
        self.assertIn("wrong origin remote", result["skipped"][0]["reason"])

    def test_diverged_checkout_is_skipped(self):
        other = self.root / "other"
        self.git("clone", str(self.remote), str(other))
        self.git("config", "user.name", "Test", cwd=other)
        self.git("config", "user.email", "test@example.invalid", cwd=other)
        (other / "remote.txt").write_text("remote")
        self.git("add", "remote.txt", cwd=other)
        self.git("commit", "-m", "Remote work", cwd=other)
        self.git("push", "origin", "main", cwd=other)
        (self.checkout / "local.txt").write_text("local")
        self.git("add", "local.txt", cwd=self.checkout)
        self.git("commit", "-m", "Local work", cwd=self.checkout)
        result = self.invoke()
        self.assertEqual(result["started"], [])
        self.assertIn("DIVERGED", result["skipped"][0]["reason"])
        self.assertEqual(self.sync_calls.read_text().splitlines(), ["--plan"])


if __name__ == "__main__":
    unittest.main()
