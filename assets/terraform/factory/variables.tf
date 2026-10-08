# Every input is projected from factory.json by fffactory (src/application/
# project-terraform-inputs.ts); none has a default, so factory.json stays the only source.
# The validations repeat factory.json's rules as a second line of defence.

variable "factory_id" {
  description = "Permanent factory ID; every resource name starts with it."
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

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+$", var.region))
    error_message = "region must be an AWS Region like us-east-1."
  }
}

variable "availability_zone" {
  description = "Availability zone of the subnet and every host, in the factory Region."
  type        = string

  validation {
    condition     = can(regex("^${var.region}[a-z]$", var.availability_zone))
    error_message = "availability_zone must be a zone of the factory Region."
  }
}

variable "vpc_cidr" {
  description = "IPv4 CIDR block of the factory VPC."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be an IPv4 CIDR block."
  }
}

variable "public_subnet_cidr" {
  description = "IPv4 CIDR block of the public subnet, inside vpc_cidr."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.public_subnet_cidr))
    error_message = "public_subnet_cidr must be an IPv4 CIDR block."
  }
}

variable "tailscale_auth_key_secret_arn" {
  description = "factory.json's tailscale.auth_key_secret: this factory's own Tailscale enrollment key."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", var.tailscale_auth_key_secret_arn))
    error_message = "tailscale_auth_key_secret_arn must be a Secrets Manager secret ARN."
  }

  validation {
    condition     = can(regex("^arn:[a-z-]+:secretsmanager:${var.region}:${var.account_id}:secret:", var.tailscale_auth_key_secret_arn))
    error_message = "tailscale_auth_key_secret_arn must be a secret in the factory Region and account."
  }
}

variable "tailscale_tag" {
  description = "factory.json's tailscale.tag: the tag every host advertises when it enrolls."
  type        = string

  validation {
    condition     = can(regex("^tag:[A-Za-z][A-Za-z0-9-]*$", var.tailscale_tag))
    error_message = "tailscale_tag must be a Tailscale tag like tag:factory."
  }
}

variable "paseo_password_secret_arns" {
  description = "factory.json's hosts[].paseo_password_secret, by host key, for hosts that declare one."
  type        = map(string)

  validation {
    condition = alltrue([
      for arn in values(var.paseo_password_secret_arns) :
      can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", arn))
    ])
    error_message = "paseo_password_secret_arns values must be Secrets Manager secret ARNs."
  }

  validation {
    condition = alltrue([
      for arn in values(var.paseo_password_secret_arns) :
      can(regex("^arn:[a-z-]+:secretsmanager:${var.region}:${var.account_id}:secret:", arn))
    ])
    error_message = "paseo_password_secret_arns values must be secrets in the factory Region and account."
  }
}

variable "hosts" {
  description = "Stable hosts from factory.json, keyed by host key."
  type = map(object({
    instance_type   = string
    root_volume_gib = number
  }))

  validation {
    condition     = length(var.hosts) > 0
    error_message = "Declare at least one host."
  }

  validation {
    condition     = alltrue([for key in keys(var.hosts) : can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", key)) && length(key) <= 32])
    error_message = "Host keys must be 1-32 lowercase letters, digits and single hyphens, starting with a letter."
  }
}
