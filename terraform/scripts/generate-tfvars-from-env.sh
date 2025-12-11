#!/bin/bash
# Generate terraform.tfvars from environment variables
# Useful for local development or CI/CD
#
# Usage:
#   export TF_API_KEY="your-key"
#   export TF_BACKEND_URL="https://..."
#   ./scripts/generate-tfvars-from-env.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_FILE="$TERRAFORM_DIR/terraform.tfvars"

# Default values (can be overridden by environment variables)
TF_ENVIRONMENT="${TF_ENVIRONMENT:-production}"
TF_AWS_REGION="${TF_AWS_REGION:-us-east-1}"
TF_VPC_CIDR="${TF_VPC_CIDR:-10.0.0.0/16}"
TF_AVAILABILITY_ZONES="${TF_AVAILABILITY_ZONES:-us-east-1a,us-east-1b}"
TF_PUBLIC_SUBNETS="${TF_PUBLIC_SUBNETS:-10.0.1.0/24,10.0.2.0/24}"
TF_PRIVATE_SUBNETS="${TF_PRIVATE_SUBNETS:-10.0.11.0/24,10.0.12.0/24}"
TF_ALLOWED_CIDR_BLOCKS="${TF_ALLOWED_CIDR_BLOCKS:-0.0.0.0/0}"
TF_CLUSTER_NAME="${TF_CLUSTER_NAME:-forge-vision-cluster}"
TF_SERVICE_NAME="${TF_SERVICE_NAME:-vision-validator}"
TF_CONTAINER_IMAGE="${TF_CONTAINER_IMAGE:-ghcr.io/unforkableco/forge-plugins-vision:latest}"
TF_CONTAINER_PORT="${TF_CONTAINER_PORT:-8080}"
TF_CONTAINER_CPU="${TF_CONTAINER_CPU:-2048}"
TF_CONTAINER_MEMORY="${TF_CONTAINER_MEMORY:-8192}"
TF_GPU_ENABLED="${TF_GPU_ENABLED:-true}"
TF_INSTANCE_TYPE="${TF_INSTANCE_TYPE:-g6f.xlarge}"
TF_DESIRED_CAPACITY="${TF_DESIRED_CAPACITY:-1}"
TF_MIN_SIZE="${TF_MIN_SIZE:-1}"
TF_MAX_SIZE="${TF_MAX_SIZE:-1}"
TF_HEALTH_CHECK_PATH="${TF_HEALTH_CHECK_PATH:-/health}"
TF_HEALTH_CHECK_INTERVAL="${TF_HEALTH_CHECK_INTERVAL:-30}"
TF_ENABLE_AUTOSCALING="${TF_ENABLE_AUTOSCALING:-true}"
TF_CPU_THRESHOLD="${TF_CPU_THRESHOLD:-70}"
TF_MEMORY_THRESHOLD="${TF_MEMORY_THRESHOLD:-80}"

# Required variables (will error if not set)
REQUIRED_VARS=("TF_API_KEY")
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var}" ]; then
    echo "Error: $var is required but not set"
    exit 1
  fi
done

# Convert comma-separated lists to Terraform list format
convert_list() {
  local input="$1"
  echo "$input" | sed "s/,/\", \"/g" | sed "s/^/\"/" | sed "s/$/\"/"
}

AVAILABILITY_ZONES=$(convert_list "$TF_AVAILABILITY_ZONES")
PUBLIC_SUBNETS=$(convert_list "$TF_PUBLIC_SUBNETS")
PRIVATE_SUBNETS=$(convert_list "$TF_PRIVATE_SUBNETS")
ALLOWED_CIDR_BLOCKS=$(convert_list "$TF_ALLOWED_CIDR_BLOCKS")

# Generate terraform.tfvars
cat > "$OUTPUT_FILE" <<EOF
# Auto-generated from environment variables - DO NOT COMMIT
# Generated on: $(date)

# General Configuration
environment = "$TF_ENVIRONMENT"
aws_region  = "$TF_AWS_REGION"

# Networking Configuration
vpc_cidr            = "$TF_VPC_CIDR"
availability_zones  = [$AVAILABILITY_ZONES]
public_subnets      = [$PUBLIC_SUBNETS]
private_subnets     = [$PRIVATE_SUBNETS]
allowed_cidr_blocks = [$ALLOWED_CIDR_BLOCKS]

# ECS Cluster Configuration
cluster_name = "$TF_CLUSTER_NAME"
service_name = "$TF_SERVICE_NAME"

# Container Configuration
container_image  = "$TF_CONTAINER_IMAGE"
container_port   = $TF_CONTAINER_PORT
container_cpu    = $TF_CONTAINER_CPU
container_memory = $TF_CONTAINER_MEMORY

# GPU Configuration
gpu_enabled      = $TF_GPU_ENABLED
instance_type    = "$TF_INSTANCE_TYPE"
desired_capacity = $TF_DESIRED_CAPACITY
min_size         = $TF_MIN_SIZE
max_size         = $TF_MAX_SIZE

# Application Environment Variables (Sensitive)
api_key        = "$TF_API_KEY"
openai_api_key = "${TF_OPENAI_API_KEY:-}"
gemini_api_key = "${TF_GEMINI_API_KEY:-}"
backend_api_key = "${TF_BACKEND_API_KEY:-}"

# Health Check Configuration
health_check_path     = "$TF_HEALTH_CHECK_PATH"
health_check_interval = $TF_HEALTH_CHECK_INTERVAL

# Auto-scaling Configuration
enable_autoscaling = $TF_ENABLE_AUTOSCALING
cpu_threshold      = $TF_CPU_THRESHOLD
memory_threshold   = $TF_MEMORY_THRESHOLD
EOF

echo "✅ Generated $OUTPUT_FILE"
echo "⚠️  Remember: terraform.tfvars is gitignored and should not be committed"

