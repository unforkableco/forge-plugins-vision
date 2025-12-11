# Fix: GPU Not Detected by ECS Container Instance

## Problem
- ✅ Instance registered with ECS cluster
- ✅ Container instance is ACTIVE and agent is connected
- ❌ Container instance is **NOT reporting GPU resources**
- ❌ Task stuck in PROVISIONING status (can't be placed without GPU)

## Root Cause
The ECS agent on the container instance is not detecting/registering the GPU, so ECS cannot place GPU-requiring tasks.

## Diagnosis

```bash
# Check container instance resources
aws ecs describe-container-instances \
  --cluster forge-vision-cluster \
  --container-instances <container-instance-arn> \
  --region us-east-1 \
  --query 'containerInstances[0].registeredResources[?type==`GPU`]'

# Should show GPU resources, but currently returns: []
```

## Possible Causes

### 1. ECS Agent Not Fully Initialized
- **Symptom**: Instance just launched (< 5 minutes old)
- **Solution**: Wait 5-10 minutes for ECS agent to detect GPU
- **Check**: Re-run the query above after waiting

### 2. GPU Drivers Not Loaded
- **Symptom**: NVIDIA drivers not properly loaded on instance
- **Solution**: ECS GPU-optimized AMI should have drivers, but may need verification
- **Check**: Need SSH access to run `nvidia-smi -L`

### 3. Fractional GPU (g6f) Support Issue
- **Symptom**: g6f.xlarge uses fractional GPU (1/8 L4)
- **Possible Issue**: ECS agent might not detect fractional GPUs properly
- **Solution**: May need to verify ECS agent version supports fractional GPUs

### 4. ECS Agent Configuration Issue
- **Symptom**: `ECS_ENABLE_GPU_SUPPORT=true` set but GPU not detected
- **Solution**: May need to restart ECS agent after GPU detection
- **Check**: Verify `/etc/ecs/ecs.config` has correct settings

## Solutions

### Solution 1: Wait and Retry (If Instance < 10 minutes old)
GPU detection can take 5-10 minutes after instance launch:

```bash
# Wait 10 minutes, then check again
aws ecs describe-container-instances \
  --cluster forge-vision-cluster \
  --container-instances <container-instance-arn> \
  --region us-east-1 \
  --query 'containerInstances[0].registeredResources[?type==`GPU`]'
```

### Solution 2: Restart ECS Agent (Requires SSH Access)
If you can SSH into the instance:

```bash
# Check GPU is visible to OS
nvidia-smi -L
ls -la /dev/nvidia*

# Check ECS config
cat /etc/ecs/ecs.config

# Restart ECS agent
sudo systemctl restart ecs

# Check ECS agent logs
sudo tail -f /var/log/ecs/ecs-agent.log
```

### Solution 3: Verify AMI and Instance Type Compatibility
Check if the ECS GPU-optimized AMI properly supports g6f instances:

```bash
# Check AMI ID
aws ec2 describe-instances \
  --instance-ids <instance-id> \
  --region us-east-1 \
  --query 'Reservations[0].Instances[0].ImageId'

# Verify it's the ECS GPU AMI
aws ssm get-parameter \
  --name /aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended/image_id \
  --region us-east-1
```

### Solution 4: Temporarily Remove GPU Requirement (Testing Only)
To verify the instance works without GPU requirement:

1. **Update task definition** to remove GPU requirement:
   ```hcl
   resourceRequirements = []  # Temporarily disable
   ```

2. **Apply changes**:
   ```bash
   terraform apply
   ```

3. **Check if task starts** (will run on CPU, not GPU)

4. **Re-enable GPU** after confirming instance works

**Note**: This is only for testing - you want GPU support for production!

### Solution 5: Use Full GPU Instance (If Fractional GPU Not Supported)
If g6f fractional GPUs aren't properly supported by ECS:

1. **Switch to g4dn.xlarge** (full NVIDIA T4 GPU):
   ```hcl
   instance_type = "g4dn.xlarge"
   ```

2. **Apply changes**:
   ```bash
   terraform apply
   ```

3. **Verify GPU detection** on new instance

### Solution 6: Check ECS Agent Version
The ECS agent might need an update to support fractional GPUs:

```bash
# Check ECS agent version (requires SSH)
ecs-agent --version

# Update ECS agent if needed
sudo yum update -y ecs-init
sudo systemctl restart ecs
```

## Verification

After applying a solution, verify GPU is detected:

```bash
# Check GPU resources
aws ecs describe-container-instances \
  --cluster forge-vision-cluster \
  --container-instances <container-instance-arn> \
  --region us-east-1 \
  --query 'containerInstances[0].registeredResources[?type==`GPU`]'

# Should show:
# [
#   {
#     "name": "GPU",
#     "type": "GPU",
#     "integerValue": 1
#   }
# ]
```

Then check if task can be placed:

```bash
# Check task status
aws ecs describe-tasks \
  --cluster forge-vision-cluster \
  --tasks <task-arn> \
  --region us-east-1 \
  --query 'tasks[0].lastStatus'

# Should change from PROVISIONING to RUNNING
```

## Next Steps

1. **Wait 10 minutes** if instance is new (< 10 minutes old)
2. **Check GPU detection** again
3. **If still not detected**, try Solution 5 (switch to g4dn.xlarge) to verify full GPU works
4. **If g4dn works but g6f doesn't**, this indicates a fractional GPU support issue
5. **Contact AWS Support** if fractional GPU support is needed but not working

## Current Status

- **Instance**: i-091ab35872a1392bf (g6f.xlarge)
- **Container Instance**: Registered and ACTIVE
- **GPU Resources**: Not detected
- **Task Status**: PROVISIONING (waiting for GPU)




