#!/usr/bin/env python3

"""Check the merge of the factory-owned daemon settings into Paseo's config.json."""

import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "paseo-config.sh"
LISTEN = "100.106.58.123:6767"
SHORT_HOSTNAME = "fff-r29c2un6-builder-1"
DNS_NAME = "fff-r29c2un6-builder-1.taila910dc.ts.net"
SCHEMA = "https://paseo.sh/schemas/paseo.config.v1.json"


class PaseoConfigTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "config.json"
        self.env = os.environ.copy()
        self.env.update({"FACTORY_PASEO_CONFIG": str(self.config),
                         "FACTORY_PASEO_LISTEN": LISTEN,
                         "FACTORY_PASEO_HOSTNAMES": f"{SHORT_HOSTNAME} {DNS_NAME}"})

    def merge(self):
        return subprocess.run((str(SCRIPT),), env=self.env, text=True, capture_output=True)

    def merged(self):
        result = self.merge()
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(self.config.read_text())

    def test_a_new_config_carries_the_listen_address_relay_off_and_both_names(self):
        self.assertEqual(self.merged(), {
            "$schema": SCHEMA,
            "version": 1,
            "daemon": {"listen": LISTEN, "relay": {"enabled": False},
                       "hostnames": [SHORT_HOSTNAME, DNS_NAME]},
        })
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        self.assertEqual([path.name for path in self.root.iterdir()], ["config.json"])

    def test_a_rerun_leaves_the_config_unchanged(self):
        self.merged()
        first = self.config.read_bytes()
        self.merged()
        self.assertEqual(self.config.read_bytes(), first)

    def test_the_hostnames_replace_any_existing_value(self):
        for existing in (True, ["old.example.com"], [DNS_NAME, SHORT_HOSTNAME, "extra"]):
            with self.subTest(existing=existing):
                self.config.write_text(json.dumps({"daemon": {"hostnames": existing}}))
                self.assertEqual(self.merged()["daemon"]["hostnames"], [SHORT_HOSTNAME, DNS_NAME])

    def test_the_names_are_split_on_any_whitespace_in_order(self):
        self.env["FACTORY_PASEO_HOSTNAMES"] = f" {SHORT_HOSTNAME}\n\t{DNS_NAME}  "
        self.assertEqual(self.merged()["daemon"]["hostnames"], [SHORT_HOSTNAME, DNS_NAME])

    def test_settings_the_factory_does_not_own_are_kept(self):
        self.config.write_text(json.dumps({
            "providers": {"claude": {"enabled": True}},
            "daemon": {"listen": "127.0.0.1:6767", "logLevel": "debug",
                       "relay": {"enabled": True, "endpoint": "relay.example.com"}},
        }))
        self.assertEqual(self.merged(), {
            "$schema": SCHEMA,
            "version": 1,
            "providers": {"claude": {"enabled": True}},
            "daemon": {"listen": LISTEN, "logLevel": "debug",
                       "relay": {"enabled": False, "endpoint": "relay.example.com"},
                       "hostnames": [SHORT_HOSTNAME, DNS_NAME]},
        })

    def test_an_invalid_config_fails_and_is_left_as_it_was(self):
        for text in ("[]", '{"daemon": []}', "", "not json", "{} {}"):
            with self.subTest(config=text):
                self.config.write_text(text)
                result = self.merge()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("the existing Paseo config is invalid", result.stderr)
                self.assertEqual(self.config.read_text(), text)
                self.assertEqual([path.name for path in self.root.iterdir()], ["config.json"])

    def test_missing_names_fail_without_writing_a_config(self):
        for hostnames in ("", "  "):
            with self.subTest(hostnames=hostnames):
                self.env["FACTORY_PASEO_HOSTNAMES"] = hostnames
                result = self.merge()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("no Paseo hostnames", result.stderr)
                self.assertFalse(self.config.exists())

    def test_a_missing_listen_address_fails_without_writing_a_config(self):
        self.env["FACTORY_PASEO_LISTEN"] = ""
        result = self.merge()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no Paseo listen address", result.stderr)
        self.assertFalse(self.config.exists())


if __name__ == "__main__":
    unittest.main()
