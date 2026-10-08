resource "aws_iam_role" "host" {
  managed_policy_arns = ["arn:aws:iam::aws:policy/AdministratorAccess"]
}
