# The IAM role and instance profile every factory host runs with. Hosts read the secrets
# factory.json references and, with the log archive enabled, write new objects under their
# own prefix of it; they can mutate nothing else, and can neither read, overwrite nor delete
# the archive.

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

# A worker incarnation writes only under its own prefix: for an instance role `aws:userid` is
# `<role ID>:<instance ID>`, so a replaced host or a recreated role starts a new one. The Allow
# needs the factory-ID tag, which S3 evaluates because the archive enables ABAC; the Deny
# refuses a write without If-None-Match, so no write replaces an object. No read, list, delete,
# ACL or lifecycle action: anything on a host, its agents included, can reach these credentials.
data "aws_iam_policy_document" "write_archive" {
  count = var.archive_bucket == null ? 0 : 1

  statement {
    sid       = "WriteOwnArchivePrefix"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.archive_bucket}/archive/1/${var.factory_id}/workers/$${aws:userid}/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/fffactory:factory-id"
      values   = [var.factory_id]
    }
  }

  statement {
    sid       = "DenyWritesWithoutIfNoneMatch"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.archive_bucket}/*"]

    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["true"]
    }
  }
}

resource "aws_iam_role_policy" "write_archive" {
  count = var.archive_bucket == null ? 0 : 1

  name   = "${var.factory_id}-write-archive"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.write_archive[0].json
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.factory_id}-host"
  role = aws_iam_role.host.name
}
