# Quick Fix for 503 Error

## Problem
- Task started but not running (0 running, 1 desired)
- No targets in target group
- Container likely crashed on startup

## Check in AWS Console

1. **Go to ECS Console** → Clusters → `forge-vision-cluster` → Services → `vision-validator`

2. **Check the "Deployments" tab:**
   - Look for failed deployments
   - Check the status

3. **Check the "Tasks" tab:**
   - Find the stopped task (task ID: `7905c214567347cb876583ee124623da`)
   - Click on it to see details
   - **Look for "Stopped reason"** - this tells you why it failed

4. **Check CloudWatch Logs:**
   - Go to CloudWatch → Log groups → `/ecs/production/vision-validator`
   - Find the latest log stream
   - Look for error messages

## Common Causes & Fixes

### 1. Missing Environment Variables
**Symptom**: Container exits immediately, logs show "API_KEY not set" or similar

**Fix**: Verify in Terraform that all required variables are set:
- `api_key` (REQUIRED)
- `openai_api_key` or `gemini_api_key` (one required)
- Check `terraform.tfvars` has all values

### 2. Image Pull Failure
**Symptom**: Task shows "CannotPullContainerError"

**Fix**: 
- Verify image exists: `ghcr.io/unforkableco/forge-plugins-vision:latest`
- Check ECS execution role has permissions to pull from GHCR
- May need to make image public or add authentication

### 3. Container Exits with Error Code
**Symptom**: Exit code 1 or 2, logs show Node.js errors

**Fix**: Check logs for:
- Missing dependencies
- Port binding issues
- File permission errors

### 4. GPU/Resource Issues
**Symptom**: Task can't be placed due to insufficient resources

**Fix**: 
- Verify instance has enough CPU/memory
- Check GPU is available (if using GPU)
- Verify task definition resource requirements match instance capacity

## Quick Commands (if AWS CLI is configured)

```bash
# Get task details
aws ecs describe-tasks \
  --cluster forge-vision-cluster \
  --tasks 7905c214567347cb876583ee124623da \
  --region us-east-1 \
  --query 'tasks[0].{status:lastStatus,stoppedReason:stoppedReason,containers:containers[0].{reason:reason,exitCode:exitCode}}'

# Get logs
aws logs get-log-events \
  --log-group-name /ecs/production/vision-validator \
  --log-stream-name $(aws logs describe-log-streams \
    --log-group-name /ecs/production/vision-validator \
    --order-by LastEventTime --descending --max-items 1 \
    --query 'logStreams[0].logStreamName' --output text) \
  --limit 100 \
  --region us-east-1 \
  --query 'events[*].message' \
  --output text
```

## Most Likely Issue

Based on the symptoms, the container is probably **exiting immediately** due to:
1. **Missing API_KEY** - Check your `terraform.tfvars` has `api_key` set
2. **Missing OpenAI/Gemini key** - Check one of these is set
3. **Image doesn't exist** - Verify the Docker image was built and pushed

## Next Steps

1. Check AWS Console for the stopped task's "Stopped reason"
2. Check CloudWatch logs for error messages
3. Verify all environment variables in `terraform.tfvars`
4. If image doesn't exist, build and push it first




