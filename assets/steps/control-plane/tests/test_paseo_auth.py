#!/usr/bin/env python3

"""Check secret-backed Paseo CLI authentication without exposing the password."""

import json

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "paseo-auth.sh"
ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-paseo-password"

MOCK_AWS = '''#!/usr/bin/env python3
import os, sys
assert sys.argv[1:] == ["secretsmanager", "get-secret-value", "--region", "us-east-1",
                         "--secret-id", os.environ["EXPECTED_ARN"], "--query", "SecretString",
                         "--output", "text"]
print("test-password")
'''

MOCK_PASEO = '''#!/usr/bin/env python3
import json, os, sys
assert os.environ.get("PASEO_PASSWORD") == "test-password"
print(json.dumps({"args":sys.argv[1:]}))
'''


class PaseoAuthTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.reference = self.root / "secret-arn"
        self.reference.write_text(ARN + "\n")
        self.aws = self.root / "aws"
        self.aws.write_text(MOCK_AWS)
        self.aws.chmod(0o755)
        self.paseo = self.root / "paseo"
        self.paseo.write_text(MOCK_PASEO)
        self.paseo.chmod(0o755)
        self.env = os.environ.copy()
        self.env.update({"FACTORY_PASEO_SECRET_REFERENCE": str(self.reference),
                         "FACTORY_PASEO_AWS_BIN": str(self.aws),
                         "FACTORY_PASEO_INNER_BIN": str(self.paseo),
                         "EXPECTED_ARN": ARN})

    def invoke(self):
        return subprocess.run((str(SCRIPT), "schedule", "ls", "--json"), env=self.env,
                              text=True, capture_output=True)

    def test_reads_secret_and_authenticates_cli(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["args"], ["schedule", "ls", "--json"])
        self.assertNotIn("test-password", result.stdout + result.stderr)

    def test_missing_host_secret_fails_without_running_cli(self):
        self.reference.write_text("")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no Paseo password secret", result.stderr)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
