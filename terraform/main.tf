# Vision Validation Plugin - AWS Infrastructure
# Deploys the Docker container on ECS with GPU-enabled EC2 instances (g4dn family)

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment to use S3 backend for state management
  # backend "s3" {
  #   bucket         = "your-terraform-state-bucket"
  #   key            = "forge-plugins-vision/terraform.tfstate"
  #   region         = "us-east-1"
  #   encrypt        = true
  #   dynamodb_table = "terraform-state-lock"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "forge-plugins"
      Service     = "vision-validator"
      ManagedBy   = "terraform"
      Environment = var.environment
    }
  }
}

# Data sources
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# VPC and Networking
module "networking" {
  source = "./modules/networking"

  environment     = var.environment
  vpc_cidr        = var.vpc_cidr
  azs             = var.availability_zones
  public_subnets  = var.public_subnets
  private_subnets = var.private_subnets
}

# Security Groups
module "security" {
  source = "./modules/security"

  environment         = var.environment
  vpc_id              = module.networking.vpc_id
  allowed_cidr_blocks = var.allowed_cidr_blocks
}

# ECS Cluster with GPU instances
module "ecs" {
  source = "./modules/ecs"

  environment  = var.environment
  cluster_name = var.cluster_name
  service_name = var.service_name

  # Container configuration
  container_image  = var.container_image
  container_port   = var.container_port
  container_cpu    = var.container_cpu
  container_memory = var.container_memory

  # GPU configuration
  gpu_enabled      = var.gpu_enabled
  instance_type    = var.instance_type
  desired_capacity = var.desired_capacity
  min_size         = var.min_size
  max_size         = var.max_size

  # Environment variables
  api_key         = var.api_key
  openai_api_key  = var.openai_api_key
  gemini_api_key  = var.gemini_api_key
  backend_api_key = var.backend_api_key

  # Networking
  vpc_id                = module.networking.vpc_id
  private_subnets       = module.networking.private_subnet_ids
  public_subnets        = module.networking.public_subnet_ids
  alb_security_group_id = module.security.alb_security_group_id
  ecs_security_group_id = module.security.ecs_security_group_id

  # Health check
  health_check_path     = var.health_check_path
  health_check_interval = var.health_check_interval

  # Auto-scaling
  enable_autoscaling = var.enable_autoscaling
  cpu_threshold      = var.cpu_threshold
  memory_threshold   = var.memory_threshold
}
