# A root module (it holds a lockfile) configuring a provider other than AWS, a backend other
# than S3 and HCP Terraform, and requiring providers other than hashicorp/aws, beside a child
# module with a backend of its own.

terraform {
  backend "local" {}

  cloud {
    organization = "elsewhere"
  }

  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
    null = {
      source = "hashicorp/null"
    }
  }
}

terraform {
  required_providers {
    aws = {
      source = "example/aws"
    }
  }
}

provider "aws" {
  default_tags {
    tags = { "fffactory:factory-id" = var.factory_id }
  }
}

provider "null" {}
