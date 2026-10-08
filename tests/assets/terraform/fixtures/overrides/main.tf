# Terraform merges override files into the blocks they name after reading every other file,
# so each would change what the guardrail read here. `notoverride.tf` is an ordinary file.

resource "aws_iam_role" "host" {
  name               = "${var.factory_id}-host"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}
