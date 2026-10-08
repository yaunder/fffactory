output "hosts" {
  description = "Each host's instance and Tailscale hostname, by host key."
  value = {
    for key, host in aws_instance.host : key => {
      instance_id        = host.id
      private_ip         = host.private_ip
      public_ip          = host.public_ip
      tailscale_hostname = host.tags.Name
    }
  }
}
