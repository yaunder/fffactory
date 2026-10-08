# Projected from factory.json by fffactory; none has a default.

variable "factory_id" {
  description = "Permanent factory ID; the bucket name starts with it."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.factory_id)) && length(var.factory_id) >= 3 && length(var.factory_id) <= 20
    error_message = "factory_id must be 3-20 lowercase letters, digits and single hyphens, starting with a letter."
  }
}

variable "account_id" {
  description = "The AWS account the factory lives in; Terraform refuses any other."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "region" {
  description = "The factory Region."
  type        = string
}

variable "state_bucket_suffix" {
  description = "factory.json's state_backend.bucket after the factory ID and a hyphen."
  type        = string
}
