# Fix: Instance Not Registering with ECS Cluster

## Problem
- Auto Scaling Group has 1 instance
- ECS cluster shows 0 container instances
- Task stuck in "Provisioning" state

## Root Cause
The EC2 instance is running but the ECS agent hasn't registered it with the cluster.

## Check in AWS Console

### 1. Verify Instance is Running
**EC2 Console → Instances:**
- Find instance with name `production-forge-vision-ecs-instance`
- Check: State = "running"
- Check: Status checks = 2/2 passed
- Note the Instance ID

### 2. Check IAM Instance Profile
**EC2 Console → Instances → Select instance → Security tab:**
- **IAM role** should be: `production-vision-validator-ecs-instance`
- If missing or wrong, that's the problem!

### 3. Check User-Data Execution
**EC2 Console → Instances → Select instance → Actions → Instance settings → View/Edit user data:**
- Should show the ECS cluster configuration
- If empty or wrong, user-data didn't execute

### 4. Check ECS Agent Logs (if you can SSH)
If you can access the instance:
```bash
# Check ECS agent is running
sudo systemctl status ecs

# Check ECS config
cat /etc/ecs/ecs.config

# Check ECS agent logs
sudo tail -f /var/log/ecs/ecs-agent.log
```

### 5. Check Network Connectivity
**EC2 Console → Instances → Select instance → Networking tab:**
- Verify instance is in a **private subnet**
- Check security group allows outbound traffic
- Verify NAT gateway is working (instance should be able to reach internet)

## Common Fixes

### Fix 1: IAM Instance Profile Missing
**Symptom**: Instance has no IAM role attached

**Solution**: 
- This shouldn't happen if Terraform applied correctly
- Check Terraform state: `terraform state show module.ecs.aws_iam_instance_profile.ecs`
- If missing, re-run `terraform apply`

### Fix 2: User-Data Not Executed
**Symptom**: `/etc/ecs/ecs.config` doesn't exist or is wrong

**Solution**:
- Instance may need to be replaced
- Check launch template user-data is correct
- Terminate instance and let ASG create a new one

### Fix 3: ECS Agent Not Running
**Symptom**: ECS agent service is stopped

**Solution** (if you can SSH):
```bash
sudo systemctl start ecs
sudo systemctl enable ecs
```

### Fix 4: Network Connectivity
**Symptom**: Instance can't reach ECS service endpoint

**Solution**:
- Verify NAT gateway is working
- Check route tables
- Verify security groups allow outbound

## Quick Fix: Replace Instance

The fastest way to fix this is to replace the instance:

```bash
# Terminate the instance (ASG will create a new one)
aws autoscaling terminate-instance-in-auto-scaling-group \
  --instance-id <instance-id> \
  --should-decrement-desired-capacity \
  --region us-east-1
```

Or in AWS Console:
1. **EC2 → Instances** → Find the instance
2. **Instance state → Terminate instance**
3. Auto Scaling Group will automatically launch a new one
4. New instance should register with ECS

## Verify Fix

After instance replacement, check:
```bash
# Should show 1 instance now
aws ecs list-container-instances \
  --cluster forge-vision-cluster \
  --region us-east-1
```

## Most Likely Issue

Based on the symptoms, the most likely issue is:
- **IAM instance profile not attached** to the instance
- **User-data didn't execute** properly
- **ECS agent service not running**

The quickest fix is to **terminate the instance and let ASG create a new one** with the correct configuration.




