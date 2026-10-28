provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  # Every taggable resource carries the factory ID, the tag IAM conditions and inventory
  # select a factory's resources by.
  default_tags {
    tags = {
      "fffactory:factory-id" = var.factory_id
      "fffactory:managed-by" = "fffactory"
    }
  }
}
