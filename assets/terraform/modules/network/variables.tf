variable "factory_id" {
  description = "Permanent factory ID; every resource name starts with it."
  type        = string
}

variable "vpc_cidr" {
  description = "IPv4 CIDR block of the factory VPC."
  type        = string
}

variable "public_subnet_cidr" {
  description = "IPv4 CIDR block of the public subnet, inside vpc_cidr."
  type        = string
}

variable "availability_zone" {
  description = "Availability zone of the public subnet and every host."
  type        = string
}
