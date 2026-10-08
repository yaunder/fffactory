# The factory: its network, the identity its hosts run with, and one instance per stable
# host key. Every name starts with the factory ID (docs/specs/provisioning.md
# §Resources and namespacing).

# New hosts start from the current Amazon Linux 2023 x86-64 image; running hosts keep theirs.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

module "network" {
  source = "../modules/network"

  factory_id         = var.factory_id
  vpc_cidr           = var.vpc_cidr
  public_subnet_cidr = var.public_subnet_cidr
  availability_zone  = var.availability_zone
}

module "host_identity" {
  source = "../modules/host-identity"

  factory_id  = var.factory_id
  secret_arns = distinct(concat([var.tailscale_auth_key_secret_arn], values(var.paseo_password_secret_arns)))
}

module "hosts" {
  source = "../modules/hosts"

  factory_id            = var.factory_id
  hosts                 = var.hosts
  ami_id                = data.aws_ssm_parameter.al2023.insecure_value
  subnet_id             = module.network.subnet_id
  security_group_id     = module.network.security_group_id
  instance_profile_name = module.host_identity.instance_profile_name

  region                        = var.region
  tailscale_auth_key_secret_arn = var.tailscale_auth_key_secret_arn
  tailscale_tag                 = var.tailscale_tag

  # A host boots with internet access and can already read its secrets.
  depends_on = [module.network, module.host_identity]
}
