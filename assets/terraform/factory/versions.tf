terraform {
  # S3 native state locking (use_lockfile). The release that runs is the managed one.
  required_version = ">= 1.11.0"

  # The state bucket arrives in the backend settings; the Region in the environment.
  backend "s3" {
    key          = "factory/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
  }
}
