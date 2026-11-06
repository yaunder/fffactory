#!/usr/bin/env python3

"""Run the dispatcher against a local Git remote and mocked GitHub, Paseo and fffactory CLIs."""

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
# The activity document the worker's `fffactory host agents --json` prints, shared with the CLI;
# so this test runs only from a checkout.
ACTIVITY_AGENTS = (Path(__file__).resolve().parents[4] / "tests" / "host" / "fixtures"
                   / "activity-agents.json")

MOCK_GH = r'''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
with open(os.environ["MOCK_GH_CALLS"], "a") as calls:
    calls.write(json.dumps(a) + "\n")
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

# The worker's agents live in MOCK_AGENTS as `host agents` prints them. Paseo's list answers the
# dispatched ones, ignoring the other labels, with no status: the dispatcher reads none.
MOCK_PASEO = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
state = Path(os.environ["MOCK_AGENTS"])
a = sys.argv[1:]
if a[0] == "ls":
    with open(os.environ["MOCK_PASEO_LS_ARGS"], "a") as calls:
        calls.write(json.dumps(a) + "\n")
    agents = json.loads(state.read_text())["agents"]
    print(json.dumps([{"id": agent["id"]} for agent in agents if agent["dispatched"]]))
elif a[0] == "run":
    Path(os.environ["MOCK_PASEO_RUN_ARGS"]).write_text(json.dumps({
      "args": a, "parent": os.environ.get("PASEO_AGENT_ID")}))
    document = json.loads(state.read_text())
    document["agents"].append({"id": "agent-1", "state": "working", "dispatched": True})
    state.write_text(json.dumps(document))
    print(json.dumps({"agentId":"agent-1","status":"running"}))
else: raise SystemExit("unexpected paseo command: " + str(a))
'''

# The worker's fffactory: only `host agents --json`, which prints MOCK_AGENTS, or with
# MOCK_AGENTS_EXIT set, as the real one does, the unknown document indented on standard
# output, its reason on one line on standard error, and that status.
MOCK_FFFACTORY = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
if sys.argv[1:] != ["host", "agents", "--json"]:
    raise SystemExit("unexpected fffactory command: " + str(sys.argv[1:]))
with open(os.environ["MOCK_FFFACTORY_CALLS"], "a") as calls:
    calls.write("host agents\n")
status = int(os.environ.get("MOCK_AGENTS_EXIT", "0"))
if status:
    reason = "Paseo activity could not be read"
    print(json.dumps({"protocol_version": 1, "agents": None,
                      "activity": {"kind": "unknown", "reason": reason}}, indent=2))
    print("fffactory host agents: " + reason, file=sys.stderr)
    raise SystemExit(status)
print(Path(os.environ["MOCK_AGENTS"]).read_text())
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
        self.agents_state = self.root / "agents.json"
        self.paseo_args = self.root / "run-args.json"
        self.paseo_ls_args = self.root / "ls-args.jsonl"
        self.fffactory_calls = self.root / "fffactory-calls"
        self.sync_calls = self.root / "sync-calls"
        self.gh_calls = self.root / "gh-calls.jsonl"
        self.agents()
        self.gitconfig = self.root / "gitconfig"
        self.gitconfig.write_text(f'[url "file://{self.remote}"]\n\tinsteadOf = https://github.com/acme/product.git\n')
        self.env = os.environ.copy()
        self.env.update({"GIT_CONFIG_GLOBAL": str(self.gitconfig),
                         "PATH": str(self.bin) + os.pathsep + self.env["PATH"],
                         "MOCK_AGENTS": str(self.agents_state),
                         "MOCK_PASEO_RUN_ARGS": str(self.paseo_args),
                         "MOCK_PASEO_LS_ARGS": str(self.paseo_ls_args),
                         "MOCK_FFFACTORY_CALLS": str(self.fffactory_calls),
                         "MOCK_SYNC_CALLS": str(self.sync_calls),
                         "MOCK_GH_CALLS": str(self.gh_calls),
                         "FACTORY_REPOSITORY_ROOT": str(self.root / "repos"),
                         "PASEO_HOME": str(self.root / "paseo"),
                         "FACTORY_FFFLOW_CHECK_BIN": str(ADOPTION),
                         "FACTORY_PASEO_BIN": str(self.bin / "paseo-auth"),
                         "FACTORY_FFFACTORY_BIN": str(self.bin / "fffactory")})
        for name, content in (("gh", MOCK_GH), ("paseo-auth", MOCK_PASEO),
                              ("fffactory", MOCK_FFFACTORY)):
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

    def agents(self, *agents):
        """The worker's agents, as `host agents` prints them: (id, state, dispatched) each."""
        busy = sum(state in ("working", "needs_input") for _, state, _ in agents)
        self.agents_state.write_text(json.dumps({
            "protocol_version": 1,
            "activity": {"kind": "active", "count": busy} if busy else {"kind": "idle"},
            "agents": [{"id": id, "state": state, "dispatched": dispatched}
                       for id, state, dispatched in agents]}))

    def dispatcher(self, mode="ready", **env):
        environment = {**self.env, "MOCK_READINESS": mode, "PASEO_AGENT_ID": "scheduled-agent",
                       **env}
        return subprocess.run((str(DISPATCHER), "--manifest", str(self.manifest),
                               "--projection", str(self.projection),
                               "--repository-root", str(self.root / "repos"), "--host", "test-host"),
                              cwd=self.cwd, env=environment, text=True, capture_output=True)

    def invoke(self, mode="ready"):
        result = self.dispatcher(mode)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def ls_calls(self):
        if not self.paseo_ls_args.exists():
            return []
        return [json.loads(line) for line in self.paseo_ls_args.read_text().splitlines()]

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

    def test_launches_without_waiting_by_the_current_flag(self):
        # --background is Paseo's deprecated alias of --no-wait, removed after 2027-04-01.
        self.invoke()
        args = json.loads(self.paseo_args.read_text())["args"]
        self.assertIn("--no-wait", args)
        self.assertNotIn("--background", args)

    def test_the_duplicate_check_includes_background_workspaces(self):
        # Paseo 0.12+ hides agents in background workspaces from ls unless asked.
        self.agents(("agent-old", "finished", True))
        self.invoke()
        calls = self.ls_calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("--global", calls[0])
        self.assertIn("--background", calls[0])
        self.assertIn("factory-epic=101", calls[0])

    def test_capacity_asks_the_workers_fffactory_not_paseo(self):
        # The worker's own fffactory translates Paseo's agents (D7): the capacity check lists
        # nothing itself, so no Paseo status reaches the dispatcher.
        self.agents(("agent-busy", "working", True))
        result = self.invoke()
        self.assertEqual(self.fffactory_calls.read_text().splitlines(), ["host agents"])
        self.assertEqual(self.ls_calls(), [])
        self.assertEqual(result["skipped"][0]["reason"], "host cap reached")

    def test_capacity_counts_only_dispatched_agents_working_or_needing_input(self):
        # With a slot free the epic launches, unless a dispatched agent already worked it.
        cap = ([], ["host cap reached"])
        for agents, running, outcome in (
            ([("a", "working", True)], 1, cap),
            ([("a", "needs_input", True)], 1, cap),
            ([("a", "working", False), ("b", "needs_input", False)], 0, (["agent-1"], [])),
            ([("a", "finished", True), ("b", "failed", True), ("c", "stopped", True)], 0,
             ([], ["existing dispatched agent"])),
        ):
            with self.subTest(agents=agents):
                self.agents(*agents)
                result = self.invoke()
                self.assertEqual(result["running"], running)
                self.assertEqual(([started["agent_id"] for started in result["started"]],
                                  [skipped["reason"] for skipped in result["skipped"]]), outcome)

    def test_capacity_reads_the_document_host_agents_prints(self):
        # One dispatched agent needs input; the other busy one was not dispatched, and the other
        # dispatched one finished.
        self.agents_state.write_text(ACTIVITY_AGENTS.read_text())
        result = self.invoke()
        self.assertEqual(result["running"], 1)
        self.assertEqual(result["skipped"][0]["reason"], "host cap reached")

    def test_agents_it_cannot_read_fail_the_tick_before_anything_launches(self):
        for name, env, document in (
            ("host agents fails", {"MOCK_AGENTS_EXIT": "1"}, None),
            ("no agent list", {}, {"protocol_version": 1, "activity": {"kind": "idle"}}),
            ("unknown agents", {}, {"protocol_version": 1, "agents": None,
                                    "activity": {"kind": "unknown", "reason": "unreadable"}}),
            ("another major version", {}, {"protocol_version": 2, "agents": [],
                                           "activity": {"kind": "idle"}}),
            ("not a document", {}, [{"id": "a", "state": "working", "dispatched": True}]),
            ("a malformed agent", {}, {"protocol_version": 1, "activity": {"kind": "idle"},
                                       "agents": ["a"]}),
        ):
            with self.subTest(name):
                if document is not None:
                    self.agents_state.write_text(json.dumps(document))
                result = self.dispatcher(**env)
                self.assertEqual(result.returncode, 1)
                self.assertTrue(result.stderr.startswith("factory dispatch: "), result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertFalse(self.gh_calls.exists())
                self.assertFalse(self.paseo_args.exists())
                self.assertEqual(self.ls_calls(), [])

    def test_a_malformed_agent_fails_the_tick_never_frees_a_slot(self):
        # Each answer is unreadable, not idle: an agent `host agents` would never print, or a
        # document the CLI's own parser refuses, fails the tick before any epic is read.
        busy = {"id": "busy", "state": "working", "dispatched": True}
        idle = {"kind": "idle"}
        for name, document in (
            ("an empty agent", {"protocol_version": 1, "activity": idle, "agents": [{}]}),
            ("an unknown state", {"protocol_version": 1, "activity": idle,
                                  "agents": [{**busy, "state": "unexpected"}]}),
            ("no state", {"protocol_version": 1, "activity": idle,
                          "agents": [{"id": "busy", "dispatched": True}]}),
            ("dispatched as a string", {"protocol_version": 1, "activity": idle,
                                        "agents": [{**busy, "dispatched": "true"}]}),
            ("dispatched as a number", {"protocol_version": 1, "activity": idle,
                                        "agents": [{**busy, "dispatched": 1}]}),
            ("no dispatched", {"protocol_version": 1, "activity": idle,
                               "agents": [{"id": "busy", "state": "working"}]}),
            ("no ID", {"protocol_version": 1, "activity": idle,
                       "agents": [{"state": "working", "dispatched": True}]}),
            ("an ID read as an option", {"protocol_version": 1, "activity": idle,
                                         "agents": [{**busy, "id": "-busy"}]}),
            ("an ID with a newline", {"protocol_version": 1, "activity": idle,
                                      "agents": [{**busy, "id": "busy\n"}]}),
            ("an ID that is not a string", {"protocol_version": 1, "activity": idle,
                                            "agents": [{**busy, "id": 7}]}),
            ("a boolean version", {"protocol_version": True, "activity": idle, "agents": []}),
            ("no activity", {"protocol_version": 1, "agents": []}),
            ("an unknown activity", {"protocol_version": 1, "activity": {"kind": "busy"},
                                     "agents": []}),
            ("an active count of zero", {"protocol_version": 1,
                                         "activity": {"kind": "active", "count": 0},
                                         "agents": []}),
            ("agents beside an unknown activity", {"protocol_version": 1, "agents": [],
                "activity": {"kind": "unknown", "reason": "unreadable"}}),
        ):
            with self.subTest(name):
                self.agents_state.write_text(json.dumps(document))
                result = self.dispatcher()
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertEqual(result.stderr,
                                 "factory dispatch: fffactory returned an invalid agent list\n")
                self.assertEqual(result.stdout, "")
                self.assertFalse(self.gh_calls.exists())
                self.assertFalse(self.paseo_args.exists())
                self.assertEqual(self.ls_calls(), [])

    def test_capacity_ignores_fields_it_does_not_know(self):
        # The host protocol adds fields within a major version; readers ignore them.
        self.agents_state.write_text(json.dumps({
            "protocol_version": 1, "activity": {"kind": "active", "count": 1, "since": "now"},
            "runtime": "paseo",
            "agents": [{"id": "busy", "state": "working", "dispatched": True, "title": "x"}]}))
        result = self.invoke()
        self.assertEqual(result["running"], 1)
        self.assertEqual(result["skipped"][0]["reason"], "host cap reached")

    def test_a_failing_host_agents_names_its_reason_on_one_line(self):
        # host agents prints the unknown document on standard output and its reason on standard
        # error; the tick's error carries the reason, never the multi-line document.
        result = self.dispatcher(MOCK_AGENTS_EXIT="1")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(result.stderr.splitlines()), 1, result.stderr)
        self.assertIn("fffactory host agents: Paseo activity could not be read", result.stderr)
        self.assertNotIn("protocol_version", result.stderr)

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

    def test_finished_agent_prevents_duplicate_without_using_host_cap(self):
        self.agents(("agent-old", "finished", True))
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
