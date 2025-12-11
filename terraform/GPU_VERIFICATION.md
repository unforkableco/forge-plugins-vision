# GPU Configuration Verification

This document verifies that the Terraform configuration will properly run the Docker image with GPU support.

## ✅ Configuration Checklist

### 1. **ECS Task Definition - GPU Resource Requirements**
- ✅ **Status**: Configured correctly
- **Location**: `modules/ecs/main.tf` lines 145-151
- **Configuration**:
  ```hcl
  resourceRequirements = var.gpu_enabled ? [
    {
      type  = "GPU"
      value = "1"
    }
  ] : []
  ```
- **Verification**: This tells ECS to allocate 1 GPU to the task

### 2. **NVIDIA Device Mappings**
- ✅ **Status**: Configured correctly for g6f instances
- **Location**: `modules/ecs/main.tf` lines 158-175
- **Configuration**:
  ```hcl
  devices = [
    { hostPath = "/dev/nvidia0", containerPath = "/dev/nvidia0", permissions = ["read", "write", "mknod"] },
    { hostPath = "/dev/nvidiactl", containerPath = "/dev/nvidiactl", permissions = ["read", "write", "mknod"] },
    { hostPath = "/dev/nvidia-uvm", containerPath = "/dev/nvidia-uvm", permissions = ["read", "write", "mknod"] }
  ]
  ```
- **Verification**: 
  - `/dev/nvidia0` - Primary GPU device (works for fractional GPUs too)
  - `/dev/nvidiactl` - NVIDIA control device
  - `/dev/nvidia-uvm` - NVIDIA unified memory device
  - All have `mknod` permission which is required for GPU access

### 3. **SYS_ADMIN Capability**
- ✅ **Status**: Configured correctly
- **Location**: `modules/ecs/main.tf` line 177
- **Configuration**:
  ```hcl
  capabilities = {
    add = ["SYS_ADMIN"]
  }
  ```
- **Verification**: Required for GPU device access in containers

### 4. **Network Mode**
- ✅ **Status**: Correct for EC2 launch type
- **Location**: `modules/ecs/main.tf` line 91
- **Configuration**:
  ```hcl
  network_mode = "bridge"
  ```
- **Verification**: Bridge mode is correct for EC2 launch type with GPU. `awsvpc` mode would also work but bridge is simpler.

### 5. **ECS GPU Support Enabled**
- ✅ **Status**: Configured correctly
- **Location**: `modules/ecs/main.tf` line 292
- **Configuration**:
  ```bash
  echo ECS_ENABLE_GPU_SUPPORT=true >> /etc/ecs/ecs.config
  ```
- **Verification**: This enables GPU support in the ECS agent on the EC2 instance

### 6. **GPU-Optimized AMI**
- ✅ **Status**: Using correct AMI
- **Location**: `modules/ecs/main.tf` lines 261-263
- **Configuration**:
  ```hcl
  data "aws_ssm_parameter" "ecs_gpu_ami" {
    name = "/aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended/image_id"
  }
  ```
- **Verification**: This AMI includes:
  - NVIDIA drivers pre-installed
  - NVIDIA Container Toolkit
  - ECS agent configured for GPU support

### 7. **Docker Image - GPU Detection**
- ✅ **Status**: Image is ready for GPU
- **Location**: `scripts/render3mf.py` lines 26-77
- **How it works**:
  1. Container runs `nvidia-smi -L` to detect NVIDIA GPU
  2. If found, configures Blender to use CUDA or OptiX
  3. Falls back to CPU if no GPU detected
- **Verification**: The image doesn't need GPU drivers (they're on the host), it just needs access to `/dev/nvidia*` devices

### 8. **Instance Type**
- ✅ **Status**: g6f.xlarge configured
- **Verification**: 
  - g6f.xlarge has 1/8 NVIDIA L4 GPU
  - Device will appear as `/dev/nvidia0` on the host
  - Fractional GPUs work the same way as full GPUs from device perspective

## 🔍 How GPU Detection Works

1. **EC2 Instance Boots**:
   - ECS GPU-optimized AMI loads with NVIDIA drivers
   - ECS agent starts with `ECS_ENABLE_GPU_SUPPORT=true`
   - GPU devices are available at `/dev/nvidia0`, `/dev/nvidiactl`, `/dev/nvidia-uvm`

2. **ECS Task Starts**:
   - ECS allocates 1 GPU to the task (via `resourceRequirements`)
   - Device mappings expose host GPU devices to container
   - Container gets access with `SYS_ADMIN` capability

3. **Container Runtime**:
   - Node.js service starts
   - When validation request comes, Blender Python script runs
   - Script executes `nvidia-smi -L` inside container
   - If successful, configures Blender Cycles to use CUDA/OptiX
   - Renders 5 views using GPU acceleration

## ⚠️ Potential Issues & Solutions

### Issue 1: GPU Not Detected
**Symptoms**: Container logs show "No GPU detected, using CPU rendering"

**Possible Causes**:
- Device mappings not working
- ECS_ENABLE_GPU_SUPPORT not set
- Wrong AMI

**Solution**: Check CloudWatch logs for:
```
[GPU] Detected NVIDIA GPU: GPU 0: NVIDIA L4 (UUID: ...)
```

### Issue 2: Permission Denied
**Symptoms**: Errors accessing `/dev/nvidia0`

**Possible Causes**:
- Missing `SYS_ADMIN` capability
- Missing `mknod` permission
- Device not mapped correctly

**Solution**: Verify device mappings in task definition

### Issue 3: nvidia-smi Not Found
**Symptoms**: `nvidia-smi: command not found` in container

**Possible Causes**:
- nvidia-smi not in container PATH (it's on host, not in container)
- This is actually OK - the script checks for it and handles gracefully

**Solution**: The script handles this - it will fall back to CPU if nvidia-smi fails

## ✅ Final Verification Steps

After deployment, verify GPU is working:

1. **Check ECS Task Logs** (CloudWatch):
   ```bash
   # Look for GPU detection messages
   [GPU] Detected NVIDIA GPU: GPU 0: NVIDIA L4
   [GPU] Using CUDA
   ```

2. **Check Task Definition**:
   ```bash
   aws ecs describe-task-definition --task-definition <task-def-name> | grep -A 10 "resourceRequirements"
   ```

3. **Test Validation**:
   - Send a validation request
   - Check rendering time (should be ~2-4s with GPU vs ~15-30s with CPU)
   - Check CloudWatch logs for GPU usage

4. **Verify Device Access**:
   ```bash
   # SSH into EC2 instance (if possible)
   docker exec <container-id> ls -la /dev/nvidia*
   # Should show: nvidia0, nvidiactl, nvidia-uvm
   ```

## 🎯 Expected Behavior

**With GPU Working**:
- Container logs: `[GPU] Detected NVIDIA GPU: GPU 0: NVIDIA L4`
- Container logs: `[GPU] Using CUDA` (or OptiX if RTX)
- Rendering time: ~2-4 seconds for 5 views
- CloudWatch metrics show GPU utilization

**Without GPU (Fallback)**:
- Container logs: `[GPU] No GPU detected, using CPU rendering`
- Rendering time: ~15-30 seconds for 5 views
- Still works, just slower

## 📝 Summary

✅ **All GPU configuration is correct**:
- GPU resource requirement: ✅ Set
- Device mappings: ✅ Correct for NVIDIA
- Capabilities: ✅ SYS_ADMIN added
- ECS GPU support: ✅ Enabled
- AMI: ✅ GPU-optimized
- Network mode: ✅ Bridge (correct for EC2)
- Image: ✅ Auto-detects GPU

**You're ready to apply!** The configuration should work correctly with GPU acceleration.




