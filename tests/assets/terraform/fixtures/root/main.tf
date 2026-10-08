# A root module (it holds a lockfile) whose provider does not tag with the factory ID and
# whose variable has a default, beside a child module that configures a provider.

provider "aws" {
  region = var.region

  default_tags {
    tags = { Project = "factory" }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}
