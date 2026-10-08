output "bucket" {
  description = "The state bucket's name."
  value       = aws_s3_bucket.state.id
}
