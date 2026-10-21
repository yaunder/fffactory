#!/usr/bin/env python3

"""Exercise schedule reconciliation with the pinned CLI's (Paseo 0.11.4) JSON contract."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "dispatch-schedule.sh"
# The projection fffactory sends to stop dispatch on a worker, shared with the CLI side's
# contract test (tests/host/protocol-contract.test.ts), which builds it byte for byte.
STOP_PROJECTION = (Path(__file__).resolve().parents[4] / "tests" / "host" / "fixtures"
                   / "dispatch-not-requested.json")

MOCK_PASEO = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
state = Path(os.environ["MOCK_SCHEDULE_STATE"])
calls = Path(os.environ["MOCK_SCHEDULE_CALLS"])
args = sys.argv[1:]
with calls.open("a") as output: output.write(" ".join(args) + "\n")
record = json.loads(state.read_text())
def flag(name, default=None):
    return args[args.index(name)+1] if name in args else default
def save(value): state.write_text(json.dumps(value))
if args[:2] == ["schedule", "ls"]:
    rows = [] if record is None else [{"id":record["id"],"name":record["name"]}]
    if os.environ.get("MOCK_DUPLICATE") == "1":
        rows.append({"id":"sched-extra","name":"factory-dispatch-extra"})
    print(json.dumps(rows))
elif args[:2] == ["schedule", "inspect"]:
    print(json.dumps(record))
elif args[:2] == ["schedule", "delete"]:
    save(None); print("{}")
elif args[:2] in (["schedule", "create"], ["schedule", "update"]):
    # Paseo 0.11.4 refuses to update anything but a new-agent schedule, and has no
    # update flag for the thinking option. It keeps the status; resume reactivates.
    if args[1] == "update" and record["target"]["type"] != "new-agent":
        raise SystemExit("Schedule not found: " + args[2])
    provider, model = flag("--provider").split("/", 1)
    value = record or {"id":"sched-1"}
    config = dict(value.get("target", {}).get("config", {}))
    config.update({"provider":provider,"model":model,"modeId":flag("--mode"),"cwd":flag("--cwd")})
    value.update({
      "name":flag("--name"),
      "prompt":flag("--prompt") if args[1] == "update" else args[-2],
      "cadence":{"type":"cron","expression":flag("--cron"),"timezone":flag("--timezone")},
      "target":{"type":"new-agent","config":config},
      "status":value.get("status", "active"), "maxRuns":value.get("maxRuns"),
      "expiresAt":value.get("expiresAt")
    })
    # Paseo 0.11.4 clears limits with the negated flags (0.9.1 misread them as values).
    if "--no-max-runs" in args: value["maxRuns"] = None
    if "--no-expires-in" in args: value["expiresAt"] = None
    save(value); print(json.dumps(value))
elif args[:2] == ["schedule", "resume"]:
    if record["status"] == "completed":
        raise SystemExit("Schedule " + args[2] + " is already completed")
    record["status"] = "active"; save(record); print("{}")
else:
    raise SystemExit("unexpected paseo command: " + str(args))
'''


class DispatchScheduleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.checkout = self.root / "home" / "factory"
        self.checkout.mkdir(parents=True)
        self.projection = self.root / "dispatch.json"
        self.state = self.root / "schedule.json"
        self.calls = self.root / "calls"
        self.state.write_text("null")
        self.mock = self.root / "paseo"
        self.mock.write_text(MOCK_PASEO)
        self.mock.chmod(0o755)
        self.dispatch = {"cron": "*/15 * * * *", "timezone": "UTC",
                         "provider": "claude", "model": "claude-sonnet-5", "mode": "default",
                         "cwd": str(self.checkout)}
        self.active = False
        self.requested = False
        self.write_projection()

    def write_projection(self):
        self.projection.write_text(json.dumps({"protocol_version": 1, "hostname": "test-host",
            "requested": self.requested, "active": self.active, "blockers": [],
            "schedule": self.dispatch if self.requested else None}))

    def invoke(self, mode, duplicate=False):
        env = os.environ.copy()
        env.update({"FACTORY_PASEO_BIN": str(self.mock), "MOCK_SCHEDULE_STATE": str(self.state),
                    "MOCK_SCHEDULE_CALLS": str(self.calls),
                    "MOCK_DUPLICATE": "1" if duplicate else "0"})
        return subprocess.run((str(SCRIPT), mode, "--projection", str(self.projection)),
                              env=env, text=True, capture_output=True)

    def test_off_create_idempotent_update_and_remove(self):
        self.assertEqual(json.loads(self.invoke("--apply").stdout)["status"], "absent")
        self.assertIsNone(json.loads(self.state.read_text()))
        self.requested = True
        self.active = True
        self.write_projection()
        first = self.invoke("--apply")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(json.loads(first.stdout)["status"], "active")
        self.assertEqual(json.loads(self.state.read_text())["prompt"], "/dispatch")
        writes = sum("schedule create" in line for line in self.calls.read_text().splitlines())
        self.assertEqual(writes, 1)
        self.assertEqual(self.invoke("--apply").returncode, 0)
        self.assertEqual(sum("schedule create" in line for line in self.calls.read_text().splitlines()), 1)
        self.dispatch["cron"] = "*/30 * * * *"
        self.write_projection()
        self.assertEqual(self.invoke("--check").returncode, 1)
        self.assertEqual(self.invoke("--apply").returncode, 0)
        self.assertEqual(json.loads(self.state.read_text())["cadence"]["expression"], "*/30 * * * *")
        self.requested = False
        self.active = False
        self.write_projection()
        self.assertEqual(self.invoke("--apply").returncode, 0)
        self.assertIsNone(json.loads(self.state.read_text()))
        self.assertEqual(sum("schedule delete" in line for line in
                             self.calls.read_text().splitlines()), 1)

    def test_stop_projection_removes_the_schedule(self):
        self.requested = True
        self.active = True
        self.write_projection()
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNotNone(json.loads(self.state.read_text()))

        self.projection.write_text(STOP_PROJECTION.read_text())
        self.assertEqual(self.invoke("--check").returncode, 1)
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "absent")
        self.assertIsNone(json.loads(self.state.read_text()))
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls.read_text().splitlines()
        self.assertEqual(sum(line.startswith("schedule delete ") for line in calls), 1)

    def test_creates_bypass_schedule(self):
        self.requested = True
        self.active = True
        self.dispatch.update(mode="bypassPermissions")
        self.write_projection()
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        schedule = json.loads(self.state.read_text())
        self.assertEqual(schedule["target"]["config"]["modeId"], "bypassPermissions")
        self.assertEqual(self.invoke("--check").returncode, 0)

    def test_updates_default_schedule_to_bypass_and_repairs_mode_drift(self):
        self.requested = True
        self.active = True
        self.write_projection()
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        original = json.loads(self.state.read_text())
        self.assertEqual(original["target"]["config"]["modeId"], "default")
        original["runs"] = [{"id": "previous-run", "status": "succeeded"}]
        self.state.write_text(json.dumps(original))

        self.dispatch["mode"] = "bypassPermissions"
        self.write_projection()
        self.assertEqual(self.invoke("--check").returncode, 1)
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        updated = json.loads(self.state.read_text())
        self.assertEqual(updated["id"], original["id"])
        self.assertEqual(updated["runs"], original["runs"])
        self.assertEqual(updated["target"]["config"]["modeId"], "bypassPermissions")
        calls = self.calls.read_text().splitlines()
        self.assertEqual(sum("schedule create" in line for line in calls), 1)
        self.assertEqual(sum("schedule update" in line for line in calls), 1)
        self.assertFalse(any("schedule delete" in line for line in calls))
        self.assertFalse(any("--no-" in line for line in calls))

        self.assertEqual(self.invoke("--apply").returncode, 0)
        self.assertEqual(sum("schedule update" in line for line in
                             self.calls.read_text().splitlines()), 1)

        updated["target"]["config"]["modeId"] = "default"
        self.state.write_text(json.dumps(updated))
        self.assertEqual(self.invoke("--check").returncode, 1)
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.state.read_text())["target"]["config"]["modeId"],
                         "bypassPermissions")

    def test_large_run_history_checks_and_reconciles_without_losing_history(self):
        self.requested = True
        self.active = True
        self.write_projection()
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        original = json.loads(self.state.read_text())
        # Exceed both Linux's per-argument limit and macOS's total argv limit.
        original["runs"] = [{"id": f"run-{i}", "status": "succeeded", "summary": "x" * 1024}
                            for i in range(1024)]
        encoded = json.dumps(original)
        self.assertGreater(len(encoded.encode()), 1024 * 1024)
        self.state.write_text(encoded)
        self.calls.write_text("")

        for mode in ("--check", "--apply"):
            with self.subTest(mode=mode):
                result = self.invoke(mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["status"], "active")
                self.assertEqual(json.loads(self.state.read_text()), original)
        calls = self.calls.read_text().splitlines()
        self.assertTrue(all(line.startswith(("schedule ls ", "schedule inspect "))
                            for line in calls))

        self.dispatch["cron"] = "*/30 * * * *"
        self.write_projection()
        result = self.invoke("--check")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "drift")
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "active")
        updated = json.loads(self.state.read_text())
        self.assertEqual(updated["id"], original["id"])
        self.assertEqual(updated["runs"], original["runs"])
        self.assertEqual(updated["cadence"]["expression"], self.dispatch["cron"])
        calls = self.calls.read_text().splitlines()
        self.assertEqual(sum(line.startswith("schedule update ") for line in calls), 1)
        self.assertFalse(any(line.startswith(("schedule create ", "schedule delete "))
                             for line in calls))

    def test_clears_limits_in_place_keeping_identity_and_history(self):
        self.requested = True
        self.active = True
        self.dispatch.update(mode="bypassPermissions")
        self.write_projection()
        for limits in ({"maxRuns": 5}, {"expiresAt": "2099-01-01T00:00:00Z"},
                       {"maxRuns": 5, "expiresAt": "2099-01-01T00:00:00Z"}):
            with self.subTest(limits=limits):
                self.state.write_text("null")
                self.calls.write_text("")
                result = self.invoke("--apply")
                self.assertEqual(result.returncode, 0, result.stderr)
                current = json.loads(self.state.read_text())
                current.update(limits, runs=[{"id": "previous-run", "status": "succeeded"}])
                self.state.write_text(json.dumps(current))
                self.assertEqual(self.invoke("--check").returncode, 1)
                result = self.invoke("--apply")
                self.assertEqual(result.returncode, 0, result.stderr)
                updated = json.loads(self.state.read_text())
                self.assertEqual(updated["id"], current["id"])
                self.assertEqual(updated["runs"], current["runs"])
                self.assertIsNone(updated["maxRuns"])
                self.assertIsNone(updated["expiresAt"])
                self.assertEqual(updated["target"]["config"]["modeId"], "bypassPermissions")
                calls = self.calls.read_text().splitlines()
                self.assertEqual(sum("schedule create" in line for line in calls), 1)
                self.assertFalse(any("schedule delete" in line for line in calls))
                updates = [line for line in calls if line.startswith("schedule update ")]
                self.assertEqual(len(updates), 1)
                # Only a limit that is set is cleared, so an ordinary update sends neither flag.
                self.assertEqual("--no-max-runs" in updates[0], "maxRuns" in limits)
                self.assertEqual("--no-expires-in" in updates[0], "expiresAt" in limits)
                self.assertEqual(self.invoke("--check").returncode, 0)

    def test_recreates_schedule_an_update_cannot_reach(self):
        self.requested = True
        self.active = True
        self.write_projection()
        unreachable = (
            ("completed", lambda schedule: schedule.update(status="completed")),
            ("thinking option", lambda schedule:
                schedule["target"]["config"].update(thinkingOptionId="high")),
            ("existing-agent target", lambda schedule: schedule.update(
                target={"type": "agent", "agentId": "agent-1"})),
        )
        for name, change in unreachable:
            with self.subTest(name):
                self.state.write_text("null")
                self.calls.write_text("")
                result = self.invoke("--apply")
                self.assertEqual(result.returncode, 0, result.stderr)
                current = json.loads(self.state.read_text())
                change(current)
                self.state.write_text(json.dumps(current))
                self.assertEqual(self.invoke("--check").returncode, 1)
                result = self.invoke("--apply")
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = self.calls.read_text().splitlines()
                self.assertEqual(sum("schedule create" in line for line in calls), 2)
                self.assertEqual(sum("schedule delete" in line for line in calls), 1)
                self.assertFalse(any("schedule update" in line for line in calls))
                self.assertEqual(self.invoke("--check").returncode, 0)

    def test_duplicate_schedule_fails_verification(self):
        self.state.write_text(json.dumps({"id": "sched-1", "name": "factory-dispatch"}))
        result = self.invoke("--check", duplicate=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("factory dispatch schedules exist", result.stderr)


if __name__ == "__main__":
    unittest.main()
