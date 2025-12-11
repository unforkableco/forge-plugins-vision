# Vision Validation Plugin - AWS Terraform Infrastructure

This Terraform configuration deploys the Vision Validation Docker container on AWS ECS with GPU-enabled EC2 instances.

## Architecture

```
Internet
    │
    ▼
Application Load Balancer (ALB)
    │
    ▼
ECS Service (on EC2 with NVIDIA L4 GPU - g6f.xlarge)
    │
    └─ Task: vision-validator container
```

### Components

- **VPC**: Isolated network with public/private subnets across 2 AZs
- **Application Load Balancer**: Distributes traffic to ECS tasks
- **ECS Cluster**: Managed container orchestration
- **EC2 Auto Scaling Group**: GPU-enabled instances (g6f family - fractional NVIDIA L4)
- **ECS Capacity Provider**: Auto-scales instances based on task demand
- **CloudWatch**: Logging and monitoring

## Prerequisites

1. **AWS Account** with appropriate permissions
2. **Terraform** >= 1.0
3. **AWS CLI** configured with credentials
4. **Docker image** pushed to GitHub Container Registry

## Configuration Methods

### Method 1: Local Development (Recommended for Testing)

Use a local `terraform.tfvars` file (already gitignored):

1. **Copy the example file:**
   ```bash
   cd terraform
   cp terraform.tfvars.example terraform.tfvars
   ```

2. **Edit `terraform.tfvars` with your values:**
   ```hcl
   api_key        = "your-secure-api-key-here"
   openai_api_key = "sk-..."
   # ... etc
   ```

3. **Run Terraform:**
   ```bash
   terraform init
   terraform plan
   terraform apply
   ```

**Note**: `terraform.tfvars` is already in `.gitignore` and will not be committed.

### Method 2: Environment Variables (Alternative for Local)

Use the helper script to generate `terraform.tfvars` from environment variables:

1. **Set required environment variables:**
   ```bash
   export TF_API_KEY="your-api-key"
   export TF_BACKEND_URL="https://your-backend-url.com"
   export TF_OPENAI_API_KEY="sk-..."
   # ... set other variables as needed
   ```

2. **Generate terraform.tfvars:**
   ```bash
   chmod +x scripts/generate-tfvars-from-env.sh
   ./scripts/generate-tfvars-from-env.sh
   ```

3. **Run Terraform:**
   ```bash
   terraform init
   terraform plan
   terraform apply
   ```

### Method 3: GitHub Actions (CI/CD)

Use GitHub Secrets for automated deployments:

1. **Set up GitHub Secrets** in your repository:
   - Go to: Settings → Secrets and variables → Actions
   - Add the following secrets (prefix with `TF_`):
     - `TF_API_KEY` - API key for vision service
     - `TF_OPENAI_API_KEY` - OpenAI API key
     - `TF_GEMINI_API_KEY` - (Optional) Gemini API key
     - `TF_BACKEND_API_KEY` - (Optional) Backend API key
     - `TF_VPC_CIDR` - VPC CIDR block
     - `TF_AVAILABILITY_ZONES` - Comma-separated AZs (e.g., "us-east-1a,us-east-1b")
     - `TF_PUBLIC_SUBNETS` - Comma-separated public subnets
     - `TF_PRIVATE_SUBNETS` - Comma-separated private subnets
     - `TF_ALLOWED_CIDR_BLOCKS` - Comma-separated allowed CIDR blocks
     - `TF_CLUSTER_NAME` - ECS cluster name
     - `TF_SERVICE_NAME` - ECS service name
     - `TF_CONTAINER_IMAGE` - Docker image URL
     - `TF_INSTANCE_TYPE` - EC2 instance type (default: g6f.xlarge)
     - `AWS_ROLE_ARN` - AWS IAM role ARN for GitHub Actions
     - And other configuration values as needed

2. **Deploy via GitHub Actions:**
   - Go to: Actions → Terraform Deploy → Run workflow
   - Select environment (production/staging)
   - Click "Run workflow"

The workflow will:
- Generate `terraform.tfvars` from secrets
- Run `terraform plan`
- If triggered manually, run `terraform apply`

## Required Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `api_key` | **Yes** | API key for authenticating requests TO the vision service |
| `openai_api_key` or `gemini_api_key` | **Yes*** | Vision AI API key (one required) |
| `backend_api_key` | No | API key for authenticating requests FROM vision service TO backend |

**Note**: `backend_url` is NOT needed. The artifacts URL is provided by the Fabrikator backend in each request's `context.artifactsUrl` field.

*One of `openai_api_key` or `gemini_api_key` is required.

## GPU Instance Types

| Instance Type | GPUs | GPU Type | vCPUs | RAM | Price/hr (us-east-1) |
|--------------|------|----------|-------|-----|----------------------|
| **g6f.xlarge** (default) | 1/8 | NVIDIA L4 | 4 | 16 GB | ~$0.30-0.35 |
| g6f.2xlarge | 1/4 | NVIDIA L4 | 8 | 32 GB | ~$0.60-0.70 |
| g6f.4xlarge | 1/2 | NVIDIA L4 | 16 | 64 GB | ~$1.20-1.40 |
| g4ad.xlarge | 1 | AMD Radeon Pro V520 | 4 | 16 GB | ~$0.378 |
| g4dn.xlarge | 1 | NVIDIA T4 | 4 | 16 GB | ~$0.526 |

## Quick Start

### 1. Configure Variables

**For local development:**
```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values
```

**Important variables:**
- `api_key`: **REQUIRED** - API key for authenticating requests (generate with `openssl rand -base64 32`)
- `openai_api_key` or `gemini_api_key`: Required for AI analysis
- `backend_url`: Your Fabrikator backend URL
- `allowed_cidr_blocks`: Restrict access to your IP ranges
- `instance_type`: Choose GPU instance size (default: g6f.xlarge)

### 2. Initialize Terraform

```bash
terraform init
```

### 3. Plan Deployment

```bash
terraform plan
```

### 4. Apply Configuration

```bash
terraform apply
```

## Outputs

After deployment, Terraform will output:

- `alb_url` - Application Load Balancer URL
- `health_check_url` - Health check endpoint
- `validation_endpoint` - Vision validation endpoint
- `ecs_cluster_name` - ECS cluster name
- `deployment_info` - Deployment configuration details

## Security Notes

- **Never commit `terraform.tfvars`** - It's already in `.gitignore`
- **Use GitHub Secrets** for CI/CD deployments
- **Restrict `allowed_cidr_blocks`** in production (don't use `0.0.0.0/0`)
- **Generate strong API keys** using `openssl rand -base64 32`
- **Rotate API keys** regularly

## Troubleshooting

### Terraform can't find variables

- Ensure `terraform.tfvars` exists in the `terraform/` directory
- Check that all required variables are set
- Verify variable names match exactly (case-sensitive)

### GitHub Actions fails

- Verify all required secrets are set in GitHub
- Check AWS credentials/role ARN is correct
- Review workflow logs for specific errors

### Container can't access GPU

- Verify instance type supports GPU (g6f, g4dn, g4ad families)
- Check CloudWatch logs for GPU detection messages
- Ensure ECS GPU AMI is being used

## Cost Optimization

- **Current setup**: Single `g6f.xlarge` instance (~$216-252/month)
- **No auto-scaling**: Fixed at 1 instance to minimize costs
- **Fractional GPU**: Uses 1/8 NVIDIA L4 GPU (sufficient for Blender rendering)

## Cleanup

To destroy all resources:

```bash
terraform destroy
```

**Warning**: This will delete all infrastructure including the ECS cluster, ALB, and VPC.
