# One EC2 instance per stable host key. A host's key never changes, so its instance is
# keyed by it; its Tailscale hostname is the factory ID and the host key.

resource "aws_instance" "host" {
  for_each = var.hosts

  ami                         = var.ami_id
  instance_type               = each.value.instance_type
  subnet_id                   = var.subnet_id
  associate_public_ip_address = true
  vpc_security_group_ids      = [var.security_group_id]
  iam_instance_profile        = var.instance_profile_name

  # First-boot bootstrap without SSM (docs/specs/worker-bootstrap.md): the accounts, Tailscale
  # under the namespaced hostname, and the root activator, embedded from the file beside it.
  user_data = templatefile("${path.module}/../../bootstrap/user-data.sh.tftpl", {
    hostname                      = "${var.factory_id}-${each.key}"
    region                        = var.region
    tailscale_auth_key_secret_arn = var.tailscale_auth_key_secret_arn
    tailscale_tag                 = var.tailscale_tag
    activator_base64              = filebase64("${path.module}/../../bootstrap/fffactory-activate")
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  root_block_device {
    encrypted             = true
    delete_on_termination = true
    volume_type           = "gp3"
    volume_size           = each.value.root_volume_gib

    tags = {
      Name                 = "${var.factory_id}-${each.key}-root"
      "fffactory:host-key" = each.key
    }
  }

  tags = {
    Name                 = "${var.factory_id}-${each.key}"
    "fffactory:host-key" = each.key
  }

  lifecycle {
    # A newer base image or bootstrap template never replaces a running host: the base
    # changes only by base migration, and bootstrap runs once, at first boot.
    ignore_changes = [ami, user_data]
  }
}
