# Vision Validate Plugin
# Docker image for AI-powered CAD geometry validation with Blender rendering
#
# GPU Support:
# - Automatically detects and uses NVIDIA (CUDA/OptiX) or AMD (HIP) GPUs
# - Falls back to CPU if no GPU is detected
# - For NVIDIA: Run with --gpus all
# - For AMD: Run with --device /dev/kfd --device /dev/dri
# - GPU drivers must be installed on host (not in container)

FROM ubuntu:22.04

# Install system dependencies
RUN apt-get update && apt-get install -y \
    blender \
    curl \
    ca-certificates \
    gnupg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better caching
COPY package.json package-lock.json* ./
RUN npm install

# Install sharp dependencies
RUN npm rebuild sharp

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Copy Blender render script
COPY scripts/render3mf.py ./dist/render3mf.py

# Build TypeScript
RUN npm run build

# Create work directory
RUN mkdir -p /tmp/vision-validate

# Environment
ENV PORT=8080
ENV WORK_DIR=/tmp/vision-validate
ENV BLENDER_PATH=/usr/bin/blender

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Run the service
CMD ["node", "dist/index.js"]


