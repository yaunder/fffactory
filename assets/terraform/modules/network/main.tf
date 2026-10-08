# The factory's own VPC: one public subnet with an internet route, and an egress-only
# security group for its hosts. Hosts are reached over Tailscale, so nothing is inbound.

resource "aws_vpc" "factory" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.factory_id}-vpc" }
}

resource "aws_internet_gateway" "factory" {
  vpc_id = aws_vpc.factory.id

  tags = { Name = "${var.factory_id}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.factory.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = false

  tags = { Name = "${var.factory_id}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.factory.id

  tags = { Name = "${var.factory_id}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.factory.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "hosts" {
  name_prefix = "${var.factory_id}-hosts-"
  description = "Factory hosts: outbound only; operators reach them over Tailscale"
  vpc_id      = aws_vpc.factory.id

  egress {
    description      = "AWS APIs, package repositories, model providers and Tailscale"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = { Name = "${var.factory_id}-hosts" }

  lifecycle {
    create_before_destroy = true
  }
}
