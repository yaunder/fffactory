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
