# GitHub Secrets Configuration

This document lists all GitHub Secrets required for Terraform deployments via GitHub Actions.

## Required Secrets

Add these secrets in: **Settings → Secrets and variables → Actions → New repository secret**

### AWS Configuration

| Secret Name | Description | Example |
|------------|-------------|---------|
| `AWS_ROLE_ARN` | AWS IAM Role ARN for GitHub Actions OIDC | `arn:aws:iam::123456789012:role/github-actions-role` |

### Application Secrets (Sensitive)

| Secret Name | Description | Example |
|------------|-------------|---------|
| `TF_API_KEY` | API key for authenticating requests TO the vision service | Generate with: `openssl rand -base64 32` |
| `TF_OPENAI_API_KEY` | OpenAI API key for vision analysis | `sk-...` |
| `TF_GEMINI_API_KEY` | (Optional) Google Gemini API key | `...` |
| `TF_BACKEND_API_KEY` | (Optional) API key for backend authentication | `...` |

### Infrastructure Configuration

| Secret Name | Description | Example |
|------------|-------------|---------|
| `TF_VPC_CIDR` | VPC CIDR block | `10.0.0.0/16` |
| `TF_AVAILABILITY_ZONES` | Comma-separated availability zones | `us-east-1a,us-east-1b` |
| `TF_PUBLIC_SUBNETS` | Comma-separated public subnet CIDRs | `10.0.1.0/24,10.0.2.0/24` |
| `TF_PRIVATE_SUBNETS` | Comma-separated private subnet CIDRs | `10.0.11.0/24,10.0.12.0/24` |
| `TF_ALLOWED_CIDR_BLOCKS` | Comma-separated allowed CIDR blocks | `203.0.113.0/24,198.51.100.0/24` |

### ECS Configuration

| Secret Name | Description | Example |
|------------|-------------|---------|
| `TF_CLUSTER_NAME` | ECS cluster name | `forge-vision-cluster` |
| `TF_SERVICE_NAME` | ECS service name | `vision-validator` |
| `TF_CONTAINER_IMAGE` | Docker image URL | `ghcr.io/unforkableco/forge-plugins-vision:latest` |
| `TF_CONTAINER_PORT` | Container port | `8080` |
| `TF_CONTAINER_CPU` | Container CPU units (1024 = 1 vCPU) | `2048` |
| `TF_CONTAINER_MEMORY` | Container memory in MB | `8192` |

### GPU Configuration

| Secret Name | Description | Example |
|------------|-------------|---------|
| `TF_GPU_ENABLED` | Enable GPU support | `true` |
| `TF_INSTANCE_TYPE` | EC2 instance type | `g6f.xlarge` |
| `TF_DESIRED_CAPACITY` | Desired number of instances | `1` |
| `TF_MIN_SIZE` | Minimum number of instances | `1` |
| `TF_MAX_SIZE` | Maximum number of instances | `1` |

### Health Check & Auto-scaling

| Secret Name | Description | Example |
|------------|-------------|---------|
| `TF_HEALTH_CHECK_PATH` | Health check endpoint path | `/health` |
| `TF_HEALTH_CHECK_INTERVAL` | Health check interval in seconds | `30` |
| `TF_ENABLE_AUTOSCALING` | Enable auto-scaling | `true` |
| `TF_CPU_THRESHOLD` | CPU utilization threshold | `70` |
| `TF_MEMORY_THRESHOLD` | Memory utilization threshold | `80` |

## Setup Instructions

1. **Go to your GitHub repository**
2. **Navigate to**: Settings → Secrets and variables → Actions
3. **Click**: "New repository secret"
4. **Add each secret** from the table above
5. **For list values** (like availability zones), use comma-separated format: `us-east-1a,us-east-1b`
6. **For boolean values**, use: `true` or `false` (lowercase)

## AWS IAM Role Setup

For GitHub Actions to deploy to AWS, you need to set up OIDC:

1. **Create IAM Role** with trust policy allowing GitHub OIDC
2. **Attach policies** with necessary permissions (EC2, ECS, VPC, etc.)
3. **Set `AWS_ROLE_ARN` secret** to the role ARN

Example trust policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/YOUR_REPO:*"
        }
      }
    }
  ]
}
```

## Testing Locally

You can test the GitHub Secrets setup locally using the helper script:

```bash
# Set environment variables (matching GitHub Secrets names)
export TF_API_KEY="your-key"
export TF_BACKEND_URL="https://your-backend.com"
# ... etc

# Generate terraform.tfvars
./terraform/scripts/generate-tfvars-from-env.sh

# Run Terraform
cd terraform
terraform plan
```

## Security Best Practices

- ✅ **Never commit secrets** to the repository
- ✅ **Use GitHub Secrets** for all sensitive values
- ✅ **Rotate API keys** regularly
- ✅ **Use least-privilege IAM roles** for GitHub Actions
- ✅ **Restrict `TF_ALLOWED_CIDR_BLOCKS`** to specific IP ranges
- ✅ **Enable secret scanning** in GitHub repository settings

