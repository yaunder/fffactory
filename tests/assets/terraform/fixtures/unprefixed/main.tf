# Deliberately unprefixed: every name here must be flagged.

resource "aws_iam_role" "host" {
  name               = "factory-host"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_vpc" "factory" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = "${var.factory_id}vpc" }
}

resource "aws_security_group" "hosts" {
  name_prefix = "hosts-${var.factory_id}-"
  tags        = { Name = var.name }
}

resource "aws_instance" "host" {
  for_each = var.hosts
  ami      = "ami-0123456789abcdef0"

  root_block_device {
    tags = { Name = "${each.key}-root" }
  }

  tags = { Name = "${var.factory_id}-${each.key}", "fffactory:factory-id" = "shared" }
}

resource "aws_s3_bucket" "state" {
  bucket = local.bucket
}

resource "aws_subnet" "public" {
  vpc_id = aws_vpc.factory.id
}

resource "aws_eip" "host" {
  tags = { Name = "${var.factory_id}-eip" }
}
