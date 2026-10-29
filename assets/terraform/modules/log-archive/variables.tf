variable "factory_id" {
  description = "Permanent factory ID; the bucket name starts with it."
  type        = string
}

variable "bucket_suffix" {
  description = "The rest of the derived bucket name after the factory ID and a hyphen, ending in S3's account-regional suffix -<account>-<region>-an."
  type        = string
}
