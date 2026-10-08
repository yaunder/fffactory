variable "factory_id" {
  description = "Permanent factory ID; every resource name starts with it."
  type        = string
}

variable "hosts" {
  description = "Stable hosts from factory.json, keyed by host key."
  type = map(object({
    instance_type   = string
    root_volume_gib = number
  }))
}

variable "ami_id" {
  description = "Amazon Linux 2023 x86-64 image new hosts start from."
  type        = string
}

variable "subnet_id" {
  description = "The public subnet hosts run in."
  type        = string
}

variable "security_group_id" {
  description = "The egress-only security group of every host."
  type        = string
}

variable "instance_profile_name" {
  description = "The instance profile every host runs with."
  type        = string
}

variable "region" {
  description = "The factory Region, where hosts read their Tailscale enrollment key."
  type        = string
}

variable "tailscale_auth_key_secret_arn" {
  description = "The factory's Tailscale enrollment key in Secrets Manager; hosts read it at first boot."
  type        = string
}

variable "tailscale_tag" {
  description = "The Tailscale tag every host advertises."
  type        = string
}
