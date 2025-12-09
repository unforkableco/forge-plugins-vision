# Networking Outputs
output "vpc_id" {
  description = "ID of the VPC"
  value       = module.networking.vpc_id
}

output "public_subnet_ids" {
  description = "IDs of public subnets"
  value       = module.networking.public_subnet_ids
}

output "private_subnet_ids" {
  description = "IDs of private subnets"
  value       = module.networking.private_subnet_ids
}

# Load Balancer Outputs
output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = module.ecs.alb_dns_name
}

output "alb_zone_id" {
  description = "Zone ID of the Application Load Balancer"
  value       = module.ecs.alb_zone_id
}

output "alb_url" {
  description = "Full URL of the Application Load Balancer"
  value       = "http://${module.ecs.alb_dns_name}"
}

# ECS Outputs
output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = module.ecs.cluster_name
}

output "ecs_cluster_id" {
  description = "ID of the ECS cluster"
  value       = module.ecs.cluster_id
}

output "ecs_service_name" {
  description = "Name of the ECS service"
  value       = module.ecs.service_name
}

output "ecs_task_definition_arn" {
  description = "ARN of the ECS task definition"
  value       = module.ecs.task_definition_arn
}

# ECR Outputs
output "ecr_repository_url" {
  description = "URL of the ECR repository"
  value       = module.ecs.ecr_repository_url
}

# Auto Scaling Group Outputs
output "autoscaling_group_name" {
  description = "Name of the Auto Scaling Group"
  value       = module.ecs.autoscaling_group_name
}

# Connection Information
output "health_check_url" {
  description = "Health check endpoint URL"
  value       = "http://${module.ecs.alb_dns_name}/health"
}

output "validation_endpoint" {
  description = "Vision validation endpoint URL"
  value       = "http://${module.ecs.alb_dns_name}/validate"
}

# Deployment Information
output "deployment_info" {
  description = "Deployment information"
  value = {
    region              = var.aws_region
    environment         = var.environment
    cluster_name        = var.cluster_name
    service_name        = var.service_name
    instance_type       = var.instance_type
    gpu_enabled         = var.gpu_enabled
    desired_capacity    = var.desired_capacity
  }
}
