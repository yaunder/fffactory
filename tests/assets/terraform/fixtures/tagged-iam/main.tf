# Mutating statements conditioned on the factory-ID resource tag, read-only statements,
# trust statements and denials: none is flagged.

data "aws_iam_policy_document" "hosts" {
  statement {
    sid       = "ReadSecrets"
    actions   = ["secretsmanager:GetSecretValue", "ec2:Describe*"]
    resources = ["*"]
  }

  statement {
    sid       = "ManageOwnInstances"
    effect    = "Allow"
    actions   = ["ec2:StopInstances", "ec2:StartInstances"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/fffactory:factory-id"
      values   = [var.factory_id]
    }
  }

  statement {
    sid       = "ManageOwnTags"
    actions   = ["ec2:CreateTags"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/fffactory:factory-id"
      values   = [var.factory_id]
    }
  }

  statement {
    sid     = "Trust"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }

  statement {
    sid       = "DenyEverythingElse"
    effect    = "Deny"
    actions   = ["*"]
    resources = ["*"]
  }
}

# A conditional document is read like any other: its one instance, `[0]`, is the block above.
data "aws_iam_policy_document" "optional" {
  count = var.enabled ? 1 : 0

  statement {
    sid       = "WriteOwnObjects"
    actions   = ["s3:PutObject"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/fffactory:factory-id"
      values   = [var.factory_id]
    }
  }
}

resource "aws_iam_role_policy" "optional" {
  count = var.enabled ? 1 : 0

  name   = "${var.factory_id}-optional"
  role   = "${var.factory_id}-host"
  policy = data.aws_iam_policy_document.optional[0].json
}
