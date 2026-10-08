# A root module with no AWS provider, so nothing tags its resources with the factory ID.

variable "factory_id" {
  type = string
}
