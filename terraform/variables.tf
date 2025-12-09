# General Configuration
variable "environment" {
  description = "Environment name (e.g., production, staging)"
  type        = string
  default     = "production"
}

variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-east-1"
}

# Networking Configuration
variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of availability zones"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "public_subnets" {
  description = "List of public subnet CIDR blocks"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnets" {
  description = "List of private subnet CIDR blocks"
  type        = list(string)
  default     = ["10.0.11.0/24", "10.0.12.0/24"]
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to access the ALB"
  type        = list(string)
  default     = ["0.0.0.0/0"]  # Restrict this in production
}

# ECS Cluster Configuration
variable "cluster_name" {
  description = "Name of the ECS cluster"
  type        = string
  default     = "forge-vision-cluster"
}

variable "service_name" {
  description = "Name of the ECS service"
  type        = string
  default     = "vision-validator"
}

# Container Configuration
variable "container_image" {
  description = "Docker image for the vision validator"
  type        = string
  default     = "ghcr.io/unforkableco/forge-plugins-vision:latest"
}

variable "container_port" {
  description = "Port the container listens on"
  type        = number
  default     = 8080
}

variable "container_cpu" {
  description = "CPU units for the container (1024 = 1 vCPU)"
  type        = number
  default     = 2048  # 2 vCPUs
}

variable "container_memory" {
  description = "Memory for the container in MB"
  type        = number
  default     = 8192  # 8 GB
}

# GPU Configuration
variable "gpu_enabled" {
  description = "Enable GPU support"
  type        = bool
  default     = true
}

variable "instance_type" {
  description = "EC2 instance type (use g4dn family for NVIDIA T4 GPUs)"
  type        = string
  default     = "g4dn.xlarge"  # 1x NVIDIA T4, 4 vCPU, 16GB RAM
  # Other options:
  # g4dn.2xlarge  - 1x T4, 8 vCPU, 32GB RAM
  # g4dn.4xlarge  - 1x T4, 16 vCPU, 64GB RAM
  # g4dn.12xlarge - 4x T4, 48 vCPU, 192GB RAM
}

variable "desired_capacity" {
  description = "Desired number of EC2 instances"
  type        = number
  default     = 1
}

variable "min_size" {
  description = "Minimum number of EC2 instances"
  type        = number
  default     = 1
}

variable "max_size" {
  description = "Maximum number of EC2 instances"
  type        = number
  default     = 3
}

# Application Environment Variables
variable "api_key" {
  description = "API key for authenticating requests to the vision service"
  type        = string
  sensitive   = true
}

variable "openai_api_key" {
  description = "OpenAI API key for vision analysis"
  type        = string
  sensitive   = true
  default     = ""
}

variable "gemini_api_key" {
  description = "Google Gemini API key (alternative to OpenAI)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "backend_url" {
  description = "Fabrikator backend URL for artifact fetching"
  type        = string
}

# Health Check Configuration
variable "health_check_path" {
  description = "Health check endpoint path"
  type        = string
  default     = "/health"
}

variable "health_check_interval" {
  description = "Health check interval in seconds"
  type        = number
  default     = 30
}

# Auto-scaling Configuration
variable "enable_autoscaling" {
  description = "Enable auto-scaling for ECS service"
  type        = bool
  default     = true
}

variable "cpu_threshold" {
  description = "CPU utilization threshold for auto-scaling"
  type        = number
  default     = 70
}

variable "memory_threshold" {
  description = "Memory utilization threshold for auto-scaling"
  type        = number
  default     = 80
}
