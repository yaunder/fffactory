output "bucket" {
  description = "The log archive bucket's name."
  value       = aws_s3_bucket.archive.id
}
