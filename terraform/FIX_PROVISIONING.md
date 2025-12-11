# Fix: Task Stuck in "Provisioning" State

## Problem
Task is stuck in "Provisioning" - it hasn't been placed on an EC2 instance yet.

## Root Causes

### 1. No EC2 Instances Available (Most Likely)
The Auto Scaling Group may not have launched an instance, or the instance isn't registered with the ECS cluster.

**Check:**
```bash
# Check if instances exist in the cluster
aws ecs list-container-instances \
  --cluster forge-vision-cluster \
  --region us-east-1

# Check Auto Scaling Group
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names production-forge-vision-asg \
  --region us-east-1 \
  --query 'AutoScalingGroups[0].{desired:DesiredCapacity,min:MinSize,max:MaxSize,instances:Instances[*].{id:InstanceId,state:LifecycleState}}'
```

**Fix:**
- If no instances: Check Auto Scaling Group in EC2 Console
- If instances exist but not registered: Check ECS agent is running
- Verify instance is in "InService" state

### 2. Instance Doesn't Have Required Resources
The task requires:
- 2 vCPU
- 8 GB memory
- 1 GPU (if gpu_enabled = true)

g6f.xlarge has: 4 vCPU, 16 GB, 1/8 GPU - should be enough.

**Check:**
```bash
# Check instance resources
aws ecs describe-container-instances \
  --cluster forge-vision-cluster \
  --container-instances <instance-arn> \
  --region us-east-1 \
  --query 'containerInstances[0].{remainingResources:remainingResources,registeredResources:registeredResources}'
```

### 3. Instance Not Registered with Cluster
The EC2 instance may be running but the ECS agent hasn't registered it.

**Check:**
- EC2 Console → Instances → Find your instance
- Check if it's running
- Check user-data executed correctly
- Check ECS agent logs on the instance

### 4. Capacity Provider Issues
The capacity provider may not be working correctly.

**Check:**
```bash
aws ecs describe-capacity-providers \
  --capacity-providers production-forge-vision-capacity-provider \
  --region us-east-1
```

## Quick Fixes

### Fix 1: Check Auto Scaling Group

In AWS Console:
1. Go to **EC2 → Auto Scaling Groups**
2. Find `production-forge-vision-asg`
3. Check:
   - **Desired capacity** = 1
   - **Min size** = 1
   - **Instances** tab shows 1 instance
   - Instance state is "InService"

If no instance:
- Check Launch Template
- Check IAM roles
- Check security groups
- Check subnet availability

### Fix 2: Check EC2 Instance Status

1. Go to **EC2 → Instances**
2. Find instance with tag `Name = production-forge-vision-ecs-instance`
3. Check:
   - **State** = running
   - **Status checks** = 2/2 passed
   - **Instance type** = g6f.xlarge

### Fix 3: Check ECS Agent

1. Go to **ECS → Clusters → forge-vision-cluster → ECS Instances**
2. Check if instance is registered
3. If not registered:
   - Check user-data executed
   - Check ECS agent is running
   - Check IAM instance profile

### Fix 4: Check Service Events

In ECS Console → Services → vision-validator → **Events** tab:
- Look for messages like:
  - "was unable to place a task"
  - "has no available container instances"
  - Resource constraint errors

## Most Likely Issue

Based on "Provisioning" status, the most likely issue is:
- **No EC2 instance running** in the Auto Scaling Group
- **Instance not registered** with the ECS cluster

## Verification Steps

1. **Check Auto Scaling Group:**
   - EC2 Console → Auto Scaling Groups → `production-forge-vision-asg`
   - Verify instance count = 1

2. **Check EC2 Instances:**
   - EC2 Console → Instances
   - Look for instance with name containing "forge-vision"
   - Verify it's running

3. **Check ECS Cluster:**
   - ECS Console → Clusters → `forge-vision-cluster` → **ECS Instances** tab
   - Should show 1 registered instance

4. **Check Service Events:**
   - ECS Console → Services → `vision-validator` → **Events** tab
   - Look for error messages

## If Instance Exists But Not Registered

The ECS agent may not be running. Check:
- User-data executed correctly
- ECS agent service is running
- IAM instance profile attached
- Security groups allow outbound traffic

## Next Steps

1. Check Auto Scaling Group in EC2 Console
2. Check if instance exists and is running
3. Check if instance is registered in ECS cluster
4. Check service events for specific error messages




