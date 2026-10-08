# The factory's state bucket, which backend bootstrap (#98) creates before the factory
# root module can keep its state there.

module "state_bucket" {
  source = "../modules/state-bucket"

  factory_id    = var.factory_id
  bucket_suffix = var.state_bucket_suffix
}
