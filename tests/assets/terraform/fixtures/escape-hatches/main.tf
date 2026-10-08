# Blocks outside the guardrail's allowlist: top-level blocks Terraform acts on without a
# resource the check reads, data sources the modules do not use, and provisioners.

import {
  to = aws_s3_bucket.adopted
  id = "someone-elses-bucket"
}

moved {
  from = aws_s3_bucket.state
  to   = aws_s3_bucket.adopted
}

removed {
  from = aws_s3_bucket.state
}

check "reachable" {
  assert {
    condition     = true
    error_message = "unreachable"
  }
}

data "aws_ssm_parameter" "ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_iam_role" "admin" {
  name = "OrganizationAccountAccessRole"
}

resource "aws_instance" "host" {
  ami = data.aws_ssm_parameter.ami.value

  root_block_device {
    tags = { Name = "${var.factory_id}-host-root" }
  }

  provisioner "local-exec" {
    command = "aws iam attach-role-policy --role-name admin"

    connection {
      host = self.public_ip
    }
  }

  connection {
    host = self.public_ip
  }

  tags = { Name = "${var.factory_id}-host" }
}
