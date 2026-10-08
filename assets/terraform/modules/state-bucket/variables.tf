variable "factory_id" {
  description = "Permanent factory ID; the bucket name starts with it."
  type        = string
}

variable "bucket_suffix" {
  description = "The rest of factory.json's state_backend.bucket after the factory ID and a hyphen."
  type        = string
}
