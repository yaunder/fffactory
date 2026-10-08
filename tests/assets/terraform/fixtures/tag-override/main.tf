# Resources that set the factory-ID tag to something else, at any depth, or set tags the
# guardrail cannot read.

resource "aws_instance" "host" {
  ami = "ami-0123456789abcdef0"

  root_block_device {
    tags = { Name = "${var.factory_id}-root", "fffactory:factory-id" = "shared" }
  }

  volume_tags = { "fffactory:factory-id" = "shared" }

  tags = { Name = "${var.factory_id}-host", "fffactory:factory-id" = var.factory_id }
}

resource "aws_instance" "merged" {
  ami         = "ami-0123456789abcdef0"
  volume_tags = merge(var.tags, { "fffactory:factory-id" = "shared" })

  root_block_device {
    tags = { Name = "${var.factory_id}-merged-root" }
  }

  tags = { Name = "${var.factory_id}-merged" }
}

resource "aws_instance" "templated" {
  ami         = "ami-0123456789abcdef0"
  volume_tags = { "fffactory:${local.k}" = "shared" }

  root_block_device {
    tags = { Name = "${var.factory_id}-templated-root", "fffactory:%{if true}factory-id%{endif}" = "shared" }
  }

  tags = { Name = "${var.factory_id}-templated", "$${literal}" = "kept" }
}
