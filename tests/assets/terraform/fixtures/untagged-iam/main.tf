# Deliberately untagged: every mutating statement here must be flagged.

data "aws_iam_policy_document" "hosts" {
  statement {
    sid       = "Terminate"
    actions   = ["ec2:TerminateInstances", "ec2:DescribeInstances"]
    resources = ["*"]
  }

  statement {
    sid       = "WrongTag"
    effect    = "Allow"
    actions   = ["ec2:StopInstances"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [var.factory_id]
    }
  }

  statement {
    sid       = "WrongValue"
    actions   = ["ec2:RebootInstances"]
    resources = ["*"]

    condition {
      test     = "StringLike"
      variable = "aws:ResourceTag/fffactory:factory-id"
      values   = ["*"]
    }
  }

  statement {
    sid       = "Everything"
    actions   = ["*"]
    resources = ["*"]
  }

  statement {
    sid         = "Trust"
    actions     = ["sts:AssumeRole", "iam:PassRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }

  statement {
    sid         = "NotActions"
    not_actions = ["ec2:DescribeInstances"]
    resources   = ["*"]
  }

  statement {
    sid       = "Computed"
    actions   = var.actions
    resources = ["*"]
  }

  statement {
    sid     = "TrustAnyone"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
  }

  statement {
    sid     = "TrustAnyService"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com", "*"]
    }
  }

  statement {
    sid     = "TrustEveryoneElse"
    actions = ["sts:AssumeRole"]

    not_principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/fffactory:factory-id"
      values   = [var.factory_id]
    }
  }
}
