# The factory's log archive: a bucket in S3's account-regional namespace, so no other account
# can ever take its name; private, versioned, encrypted and reachable only over TLS. It never
# expires anything: no lifecycle rule, no Object Lock (which could never be turned off) and no
# KMS key (whose deletion would make the archive unreadable).

resource "aws_s3_bucket" "archive" {
  bucket           = "${var.factory_id}-${var.bucket_suffix}"
  bucket_namespace = "account-regional"

  lifecycle {
    prevent_destroy = true
  }
}

# Attribute-based access control: S3 evaluates `aws:ResourceTag` conditions only once it is on,
# so a grant conditioned on the factory-ID tag, as every mutating Allow is, matches nothing
# without it: it fails closed.
resource "aws_s3_bucket_abac" "archive" {
  bucket = aws_s3_bucket.archive.id

  abac_status {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket                  = aws_s3_bucket.archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Only the TLS-only Deny (D6): hosts hold no delete, and S3 refuses to delete a bucket that is
# not empty. The policy names no role, so a role recreated by a later apply needs no change here.
data "aws_iam_policy_document" "tls_only" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "archive" {
  bucket = aws_s3_bucket.archive.id
  policy = data.aws_iam_policy_document.tls_only.json

  depends_on = [aws_s3_bucket_public_access_block.archive]
}
