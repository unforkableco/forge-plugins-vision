# Fix: EMPTY CAPACITY PROVIDER Error

## Problem
- Task error: "EMPTY CAPACITY PROVIDER"
- Auto Scaling Group has 1 instance
- ECS cluster shows 0 container instances
- Capacity provider has no available capacity

## Root Cause
The EC2 instance exists but the ECS agent hasn't registered it with the cluster yet. The capacity provider sees 0 available capacity because no instances are registered.

## Why This Happens

The instance needs time to:
1. Boot and initialize (1-2 minutes)
2. Execute user-data script (configures ECS agent)
3. Start ECS agent service
4. Register with ECS cluster

This can take 3-5 minutes total.

## Solutions

### Solution 1: Wait and Check Again (Recommended First Step)

The instance may still be initializing. Wait 5 minutes and check:

```bash
# Check if instance registered
aws ecs list-container-instances \
  --cluster forge-vision-cluster \
  --region us-east-1
```

If still empty after 5 minutes, proceed to Solution 2.

### Solution 2: Check Instance Status in AWS Console

1. **EC2 Console → Instances**
   - Find instance: `production-forge-vision-ecs-instance`
   - Check: **Status checks** = 2/2 passed
   - If not passed, instance is still initializing

2. **Check IAM Role**
   - Select instance → **Security** tab
   - **IAM role** should be: `production-vision-validator-ecs-instance`
   - If missing, that's the problem!

3. **Check User-Data**
   - Select instance → **Actions → Instance settings → View/Edit user data**
   - Should show the bash script with ECS_CLUSTER configuration

### Solution 3: Check ECS Agent (If You Can Access Instance)

If you can SSH into the instance:
```bash
# Check ECS agent status
sudo systemctl status ecs

# Check ECS config
cat /etc/ecs/ecs.config

# Check ECS agent logs
sudo tail -f /var/log/ecs/ecs-agent.log
```

### Solution 4: Replace Instance (Quick Fix)

If instance has been running > 10 minutes and still not registered:

1. **EC2 Console → Instances**
2. Find the instance
3. **Instance state → Terminate instance**
4. Auto Scaling Group will create a new one
5. Wait 3-5 minutes for new instance to register

### Solution 5: Check Service Events

**ECS Console → Services → vision-validator → Events tab:**
- Look for messages about capacity provider
- Look for "was unable to place a task" errors
- Check for specific error messages

## Common Issues

### Issue 1: IAM Instance Profile Not Attached
**Symptom**: Instance has no IAM role

**Fix**: 
- Verify Terraform created the instance profile
- Check: `terraform state show module.ecs.aws_iam_instance_profile.ecs`
- If missing, re-run `terraform apply`

### Issue 2: User-Data Not Executing
**Symptom**: `/etc/ecs/ecs.config` doesn't exist on instance

**Fix**: 
- Check launch template user-data
- Instance may need to be replaced
- Verify user-data script is correct

### Issue 3: ECS Agent Can't Connect
**Symptom**: ECS agent logs show connection errors

**Fix**:
- Check security groups allow outbound HTTPS (for ECS API)
- Verify NAT gateway is working (instance in private subnet)
- Check route tables

### Issue 4: Instance Still Initializing
**Symptom**: Status checks not passed

**Fix**: 
- Wait longer (can take 5-10 minutes for GPU instances)
- Check instance system logs in EC2 Console

## Verification

After instance registers, verify:

```bash
# Should show 1 instance
aws ecs list-container-instances \
  --cluster forge-vision-cluster \
  --region us-east-1

# Check capacity provider status
aws ecs describe-capacity-providers \
  --capacity-providers production-forge-vision-capacity-provider \
  --region us-east-1 \
  --query 'capacityProviders[0].{status:status,availableCapacity:availableCapacity}'
```

## Expected Timeline

- **0-2 min**: Instance booting
- **2-3 min**: User-data executing, ECS agent starting
- **3-5 min**: ECS agent registering with cluster
- **5+ min**: Instance registered, tasks can be placed

If it's been > 10 minutes, something is wrong.

## Most Likely Fix

**Wait 5 minutes** - GPU instances can take longer to initialize. If still not registered after 5 minutes, **terminate and replace the instance**.




