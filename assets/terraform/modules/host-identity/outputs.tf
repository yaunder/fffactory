output "instance_profile_name" {
  description = "The instance profile every host runs with."
  value       = aws_iam_instance_profile.host.name
}

output "role_name" {
  description = "The role behind the instance profile."
  value       = aws_iam_role.host.name
}
