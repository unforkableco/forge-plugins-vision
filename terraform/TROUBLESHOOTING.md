# Troubleshooting 503 Error from ALB

A 503 error from the ALB means the load balancer can't route traffic to healthy targets. Here's how to diagnose and fix it.

## Quick Diagnosis Steps

### 1. Check ECS Service Status

```bash
aws ecs describe-services \
  --cluster forge-vision-cluster \
  --services vision-validator \
  --region us-east-1 \
  --query 'services[0].{status:status,running:runningCount,desired:desiredCount,events:events[0:5]}' \
  --output json
```

**What to look for:**
- `runningCount` should equal `desiredCount` (should be 1)
- `status` should be "ACTIVE"
- Check `events` for error messages

### 2. Check Running Tasks

```bash
# List tasks
aws ecs list-tasks \
  --cluster forge-vision-cluster \
  --service-name vision-validator \
  --region us-east-1

# If tasks exist, get details
TASK_ARN=$(aws ecs list-tasks --cluster forge-vision-cluster --service-name vision-validator --region us-east-1 --query 'taskArns[0]' --output text)

aws ecs describe-tasks \
  --cluster forge-vision-cluster \
  --tasks $TASK_ARN \
  --region us-east-1 \
  --query 'tasks[0].{status:lastStatus,health:healthStatus,containers:containers[0].{name:name,status:lastStatus,reason:reason}}' \
  --output json
```

**What to look for:**
- Task `status` should be "RUNNING"
- Container `status` should be "RUNNING"
- If `reason` is present, it indicates why the task/container failed

### 3. Check Container Logs

```bash
# Get log group name
LOG_GROUP="/ecs/production/vision-validator"

# View recent logs
aws logs tail $LOG_GROUP --follow --region us-east-1

# Or view last 50 lines
aws logs get-log-events \
  --log-group-name $LOG_GROUP \
  --log-stream-name $(aws logs describe-log-streams --log-group-name $LOG_GROUP --order-by LastEventTime --descending --max-items 1 --query 'logStreams[0].logStreamName' --output text) \
  --limit 50 \
  --region us-east-1 \
  --query 'events[*].message' \
  --output text
```

**What to look for:**
- Container startup errors
- API key configuration errors
- GPU detection messages
- Health check failures

### 4. Check Target Group Health

```bash
# Get target group ARN
TG_ARN=$(aws elbv2 describe-target-groups \
  --names production-forge-vision-tg \
  --region us-east-1 \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text)

# Check target health
aws elbv2 describe-target-health \
  --target-group-arn $TG_ARN \
  --region us-east-1
```

**What to look for:**
- Targets should be "healthy"
- If "unhealthy", check the reason
- If no targets, tasks aren't registering with the target group

### 5. Check Security Groups

```bash
# Verify ALB can reach ECS tasks
# ALB security group should allow outbound to ECS security group
# ECS security group should allow inbound from ALB security group on port 8080
```

## Common Issues and Solutions

### Issue 1: No Tasks Running

**Symptoms:**
- `runningCount = 0`
- Events show "was unable to place a task"

**Possible Causes:**
- Instance not registered with cluster
- Insufficient resources (CPU/memory/GPU)
- Task definition errors

**Solutions:**
```bash
# Check if instance is in cluster
aws ecs list-container-instances \
  --cluster forge-vision-cluster \
  --region us-east-1

# Check instance status
INSTANCE_ARN=$(aws ecs list-container-instances --cluster forge-vision-cluster --query 'containerInstanceArns[0]' --output text)
aws ecs describe-container-instances \
  --cluster forge-vision-cluster \
  --container-instances $INSTANCE_ARN \
  --region us-east-1 \
  --query 'containerInstances[0].{status:status,agentConnected:agentConnected,remainingResources:remainingResources}'
```

### Issue 2: Tasks Failing to Start

**Symptoms:**
- Tasks show "STOPPED" status
- Container has `reason` field with error

**Common Reasons:**
- Image pull failure (wrong image name/tag)
- Missing environment variables (API_KEY, etc.)
- Container exits immediately

**Solutions:**
- Check container logs (step 3 above)
- Verify image exists: `docker pull ghcr.io/unforkableco/forge-plugins-vision:latest`
- Check task definition has all required environment variables

### Issue 3: Health Checks Failing

**Symptoms:**
- Tasks running but target group shows "unhealthy"
- Health check path returns non-200

**Solutions:**
```bash
# Test health endpoint directly on instance
# SSH into EC2 instance (if possible) or check logs

# Verify health check path is correct
# Default: /health
# Should return: {"status":"healthy",...}
```

### Issue 4: Target Group Has No Targets

**Symptoms:**
- Tasks running but target group shows no targets
- ALB can't route traffic

**Possible Causes:**
- Tasks not registering with target group
- Port mismatch (container port vs target group port)
- Network mode issues

**Solutions:**
- Verify task definition has correct `containerPort` (8080)
- Verify target group port matches (8080)
- Check load balancer configuration in task definition

### Issue 5: Security Group Issues

**Symptoms:**
- Tasks running, targets registered, but still unhealthy

**Solutions:**
- ALB security group must allow outbound to ECS security group
- ECS security group must allow inbound from ALB security group on port 8080
- Check security group rules in AWS Console

## Quick Fixes

### Restart the Service

```bash
aws ecs update-service \
  --cluster forge-vision-cluster \
  --service vision-validator \
  --force-new-deployment \
  --region us-east-1
```

### Check Recent Events

```bash
aws ecs describe-services \
  --cluster forge-vision-cluster \
  --services vision-validator \
  --region us-east-1 \
  --query 'services[0].events[0:10]' \
  --output table
```

### View Full Task Definition

```bash
aws ecs describe-task-definition \
  --task-definition production-vision-validator \
  --region us-east-1 \
  --query 'taskDefinition.containerDefinitions[0]' \
  --output json
```

## Expected Timeline

After `terraform apply`:
- **0-2 min**: EC2 instance booting
- **2-3 min**: ECS agent registering, task starting
- **3-4 min**: Container starting, health checks beginning
- **4-5 min**: Health checks passing, service healthy
- **5+ min**: ALB routing traffic, `/health` returns 200

If it's been more than 10 minutes, something is wrong.

## Still Having Issues?

1. Check CloudWatch Logs for container errors
2. Check ECS service events for deployment issues
3. Verify all required environment variables are set
4. Check that the Docker image exists and is accessible
5. Verify GPU instance is properly configured (if using GPU)




