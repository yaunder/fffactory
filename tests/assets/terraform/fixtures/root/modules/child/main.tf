provider "aws" {
  default_tags {
    tags = { "fffactory:factory-id" = var.factory_id }
  }
}
