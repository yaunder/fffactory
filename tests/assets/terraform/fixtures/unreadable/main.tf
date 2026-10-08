# Policies the guardrail cannot read are flagged rather than trusted.

resource "aws_iam_role" "host" {
  name = "${var.factory_id}-host"
  assume_role_policy = jsonencode({
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "inline" {
  name   = "${var.factory_id}-inline"
  role   = aws_iam_role.host.id
  policy = <<-EOT
    {"Statement": [{"Effect": "Allow", "Action": "ec2:*", "Resource": "*"}]}
  EOT
}

data "aws_iam_policy_document" "merged" {
  source_policy_documents = [var.other]

  dynamic "statement" {
    for_each = var.statements
    content {
      actions = statement.value
    }
  }

  statement {
    effect  = var.effect
    actions = ["ec2:TerminateInstances"]
  }
}

resource "aws_iam_role_policy_attachment" "admin" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
