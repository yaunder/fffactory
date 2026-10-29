variable "factory_id" {
  description = "Permanent factory ID; every resource name starts with it."
  type        = string
}

variable "secret_arns" {
  description = "Secrets Manager ARNs, from factory.json, that hosts may read."
  type        = list(string)

  validation {
    condition     = length(var.secret_arns) > 0
    error_message = "Hosts read at least the Tailscale enrollment key."
  }
}

variable "archive_bucket" {
  description = "The log archive bucket every host may write its own prefix of, or null for none."
  type        = string
}
