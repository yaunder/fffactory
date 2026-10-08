# The IAM role and instance profile every factory host runs with. Hosts only read the
# secrets factory.json references; they can mutate nothing.

data "aws_iam_policy_document" "assume_by_ec2" {
  statement {
    sid     = "AssumedByEC2"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    sid       = "ReadFactorySecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.secret_arns
  }
}

resource "aws_iam_role" "host" {
  name               = "${var.factory_id}-host"
  description        = "Factory hosts of ${var.factory_id}"
  assume_role_policy = data.aws_iam_policy_document.assume_by_ec2.json
}

resource "aws_iam_role_policy" "read_secrets" {
  name   = "${var.factory_id}-read-secrets"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.factory_id}-host"
  role = aws_iam_role.host.name
}
