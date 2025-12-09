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
ECS Service (on EC2 with NVIDIA T4 GPUs)
    │
    ├─ Task 1: vision-validator container
    ├─ Task 2: vision-validator container
    └─ Task N: vision-validator container
```

### Components

- **VPC**: Isolated network with public/private subnets across 2 AZs
- **Application Load Balancer**: Distributes traffic to ECS tasks
- **ECS Cluster**: Managed container orchestration
- **EC2 Auto Scaling Group**: GPU-enabled instances (g4dn family)
- **ECS Capacity Provider**: Auto-scales instances based on task demand
- **CloudWatch**: Logging and monitoring

## Prerequisites

1. **AWS Account** with appropriate permissions
2. **Terraform** >= 1.0
3. **AWS CLI** configured with credentials
4. **Docker image** pushed to GitHub Container Registry

## GPU Instance Types

| Instance Type | GPUs | GPU Type | vCPUs | RAM | Price/hr (us-east-1) |
|--------------|------|----------|-------|-----|----------------------|
| g4dn.xlarge | 1 | NVIDIA T4 | 4 | 16 GB | ~$0.526 |
| g4dn.2xlarge | 1 | NVIDIA T4 | 8 | 32 GB | ~$0.752 |
| g4dn.4xlarge | 1 | NVIDIA T4 | 16 | 64 GB | ~$1.204 |
| g4dn.12xlarge | 4 | NVIDIA T4 | 48 | 192 GB | ~$3.912 |

## Quick Start

### 1. Configure Variables

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
- `instance_type`: Choose GPU instance size
- `desired_capacity`: Number of instances to run

### 2. Initialize Terraform

```bash
terraform init
```

### 3. Plan Deployment

```bash
terraform plan
```

Review the resources that will be created.

### 4. Deploy

```bash
terraform apply
```

Type `yes` to confirm.

### 5. Get Outputs

```bash
terraform output
```

You'll see:
- `alb_url`: Load balancer URL
- `health_check_url`: Health check endpoint
- `validation_endpoint`: Vision validation endpoint

## Usage

### Test Health Check

```bash
curl http://<alb_dns_name>/health
```

### Test Vision Validation

```bash
# Note: Include your API key in the request
curl -X POST http://<alb_dns_name>/validate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "context": {
      "sessionId": "test-123",
      "artifactsUrl": "https://...",
      "step": 1
    },
    "args": {
      "part": "base",
      "partDescription": "A cylindrical base"
    }
  }'
```

**Authentication:**
- All requests (except `/health`) require an API key
- Pass via `X-API-Key` header or `Authorization: Bearer <key>`
- The API key is set via the `api_key` Terraform variable

## Cost Estimation

**Monthly costs** (approximate, us-east-1):

| Component | Configuration | Monthly Cost |
|-----------|--------------|--------------|
| EC2 (g4dn.xlarge) | 1 instance, 24/7 | ~$380 |
| ALB | Standard | ~$20 |
| Data Transfer | 100 GB/month | ~$9 |
| CloudWatch Logs | 10 GB/month | ~$5 |
| **Total** | | **~$414/month** |

**Cost optimization tips:**
- Use spot instances (50-90% discount) - add to launch template
- Stop instances during off-hours
- Use smaller instance types for dev/staging
- Enable auto-scaling to scale down during low usage

## Monitoring

### CloudWatch Logs

Logs are available at:
```
/ecs/production/vision-validator
```

View in AWS Console:
```bash
aws logs tail /ecs/production/vision-validator --follow
```

### ECS Metrics

Monitor in CloudWatch:
- CPU utilization
- Memory utilization
- Task count
- GPU utilization (via CloudWatch Agent)

## Auto-Scaling

The service auto-scales based on:
- **CPU threshold**: 70% (adjustable)
- **Memory threshold**: 80% (adjustable)

Scaling behavior:
- **Scale out**: When metrics exceed threshold for 1 minute
- **Scale in**: When metrics drop below threshold for 5 minutes

## Updating the Deployment

### Update Container Image

```bash
# Update image tag in terraform.tfvars
container_image = "ghcr.io/unforkableco/forge-plugins-vision:v1.1.0"

# Apply changes
terraform apply
```

ECS will perform a rolling update with zero downtime.

### Update Infrastructure

```bash
# Modify terraform files or variables
terraform apply
```

## State Management

For production, use S3 backend for state management:

```hcl
# Uncomment in main.tf
terraform {
  backend "s3" {
    bucket         = "your-terraform-state-bucket"
    key            = "forge-plugins-vision/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-state-lock"
  }
}
```

Then initialize:
```bash
terraform init -migrate-state
```

## Troubleshooting

### ECS Tasks Not Starting

Check:
1. Task logs in CloudWatch
2. Container health check is passing
3. Security groups allow traffic
4. Task has enough CPU/memory
5. GPU is available on instance

### GPU Not Detected

Check:
1. Instance type is g4dn family
2. ECS-optimized GPU AMI is being used
3. User data script enables GPU support
4. NVIDIA drivers are installed (pre-installed in GPU AMI)

### High Costs

1. Check instance count: `terraform show | grep desired_capacity`
2. Verify auto-scaling isn't scaling out unnecessarily
3. Consider using spot instances
4. Scale down instance size if underutilized

## Cleanup

To destroy all resources:

```bash
terraform destroy
```

**Warning**: This will delete:
- All EC2 instances
- Load balancer
- ECS cluster
- VPC and networking
- All data and logs

## Security Best Practices

1. **Restrict ALB access**: Update `allowed_cidr_blocks` to your IP ranges
2. **Use HTTPS**: Add ACM certificate and HTTPS listener to ALB
3. **Enable encryption**: EBS volumes are encrypted by default
4. **Secrets management**: Store API keys in AWS Secrets Manager
5. **VPC endpoints**: Add VPC endpoints for ECR, CloudWatch to avoid NAT costs

## CI/CD Integration

See `.github/workflows/deploy-aws.yml` for automated deployment on release.

## Support

For issues with:
- **Terraform**: Check AWS CloudFormation events
- **ECS**: Check ECS task logs and events
- **Container**: Check CloudWatch logs
- **GPU**: Check nvidia-smi output in container logs

## License

MIT License - see [LICENSE](../LICENSE) for details.
