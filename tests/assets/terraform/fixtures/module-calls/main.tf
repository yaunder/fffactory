# Module calls the guardrail cannot follow, or that do not pass the factory ID through.

module "registry" {
  source     = "terraform-aws-modules/vpc/aws"
  factory_id = var.factory_id
}

module "git" {
  source     = "git::https://example.com/module.git"
  factory_id = var.factory_id
}

module "outside" {
  source     = "../root"
  factory_id = var.factory_id
}

module "missing" {
  source     = "./modules/missing"
  factory_id = var.factory_id
}

module "no_factory_id" {
  source = "./modules/child"
}

module "other_factory_id" {
  source     = "./modules/child"
  factory_id = "shared"
}

module "passes" {
  source     = "./modules/child"
  factory_id = var.factory_id
}
