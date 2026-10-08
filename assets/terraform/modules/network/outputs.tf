output "vpc_id" {
  description = "The factory VPC."
  value       = aws_vpc.factory.id
}

output "subnet_id" {
  description = "The public subnet every host runs in."
  value       = aws_subnet.public.id
}

output "security_group_id" {
  description = "The egress-only security group of every host."
  value       = aws_security_group.hosts.id
}
