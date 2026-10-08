output "host_keys" {
  description = "The host keys this state has provisioned: the record the stable-key check compares factory.json with."
  value       = sort(keys(module.hosts.hosts))
}

output "hosts" {
  description = "Each host's instance and Tailscale hostname, by host key."
  value       = module.hosts.hosts
}

output "network" {
  description = "The factory's network."
  value = {
    vpc_id            = module.network.vpc_id
    subnet_id         = module.network.subnet_id
    security_group_id = module.network.security_group_id
  }
}
