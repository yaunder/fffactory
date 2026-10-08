# Dynamic blocks, whose content the guardrail cannot read, fail wherever they appear.

resource "aws_iam_role" "host" {
  name               = "${var.factory_id}-host"
  assume_role_policy = data.aws_iam_policy_document.trust.json

  dynamic "inline_policy" {
    for_each = [1]
    content {
      name   = "${var.factory_id}-admin"
      policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "*", Resource = "*" }] })
    }
  }
}

data "aws_iam_policy_document" "trust" {
  statement {
    sid     = "TrustAnyone"
    actions = ["sts:AssumeRole"]

    dynamic "principals" {
      for_each = [1]
      content {
        type        = "AWS"
        identifiers = ["*"]
      }
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/fffactory:factory-id"
      values   = [var.factory_id]
    }
  }

  statement {
    sid     = "TrustEveryoneElse"
    actions = ["sts:AssumeRole"]

    dynamic "not_principals" {
      for_each = [1]
      content {
        type        = "Service"
        identifiers = ["ec2.amazonaws.com"]
      }
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/fffactory:factory-id"
      values   = [var.factory_id]
    }
  }
}
