# Forge Vision Validation Plugin

AI-powered CAD geometry validation plugin for the [Forge/Fabrikator](https://github.com/unforkableco/fabrikator) platform.

## Overview

This plugin provides visual validation capabilities for 3D CAD models. It renders 3MF files from multiple viewpoints using Blender and uses AI vision models (OpenAI GPT-4 Vision or Google Gemini) to analyze the geometry and detect issues.

## Features

- **Multi-view rendering**: Renders 5 views (ISO, Front, Right, Top, Bottom) for comprehensive analysis
- **AI-powered analysis**: Uses GPT-4 Vision or Gemini to validate geometry
- **Detailed feedback**: Returns verdict (pass/fail/uncertain), confidence score, issues found, and recommendations
- **Artifact generation**: Outputs rendered images as artifacts for frontend display

## How It Works

1. **Fetch 3MF**: Downloads the 3MF file from the Fabrikator backend
2. **Render with Blender**: Uses Blender's Python API to render 5 orthographic views
3. **AI Analysis**: Sends rendered images to the configured vision AI model
4. **Return Results**: Provides structured validation results with verdict, issues, and artifacts

## Installation

### As a Docker Container (Recommended)

**CPU-only (works everywhere):**
```bash
docker build -t forge-vision-validate .
docker run -p 8080:8080 \
  -e OPENAI_API_KEY=your-key \
  -e BACKEND_URL=http://host.docker.internal:3001 \
  forge-vision-validate
```

**With NVIDIA GPU (5-10x faster):**
```bash
docker run -p 8080:8080 \
  --gpus all \
  -e OPENAI_API_KEY=your-key \
  -e BACKEND_URL=http://host.docker.internal:3001 \
  forge-vision-validate
```

**With AMD GPU (5-8x faster):**
```bash
docker run -p 8080:8080 \
  --device /dev/kfd \
  --device /dev/dri \
  --group-add video \
  -e OPENAI_API_KEY=your-key \
  -e BACKEND_URL=http://host.docker.internal:3001 \
  forge-vision-validate
```

> **Note**: The container automatically detects available GPUs and configures Blender accordingly. No manual configuration needed!

### Local Development

```bash
npm install
npm run build
npm start
```

**Note**: Blender must be installed and available at `/usr/bin/blender` or set via `BLENDER_PATH` env var.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8080` | Server port |
| `OPENAI_API_KEY` | Yes* | - | OpenAI API key for GPT-4 Vision |
| `GEMINI_API_KEY` | Yes* | - | Google Gemini API key (alternative to OpenAI) |
| `BACKEND_URL` | Yes | - | Fabrikator backend URL for fetching artifacts |
| `BLENDER_PATH` | No | `/usr/bin/blender` | Path to Blender executable |
| `WORK_DIR` | No | `/tmp/vision-validate` | Working directory for temp files |

*One of `OPENAI_API_KEY` or `GEMINI_API_KEY` is required.

## API Endpoints

### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "service": "vision-validate-plugin",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "blenderPath": "/usr/bin/blender"
}
```

### `POST /validate`

Validate a 3D part's geometry.

**Request Body:**
```json
{
  "context": {
    "sessionId": "abc123",
    "artifactsUrl": "http://backend:3001/internal/artifacts/abc123",
    "step": 1
  },
  "args": {
    "part": "base",
    "partDescription": "A cylindrical base with mounting holes",
    "focus": "Check for proper hole alignment",
    "checks": ["holes are present", "cylinder is solid"]
  },
  "apiKeys": {
    "OPENAI_API_KEY": "sk-..."
  }
}
```

**Response:**
```json
{
  "ok": true,
  "tokensUsed": 1500,
  "artifacts": [
    {
      "name": "render_iso.jpg",
      "type": "image",
      "base64": "...",
      "mimeType": "image/jpeg",
      "viewName": "iso"
    }
  ],
  "result": {
    "verdict": "pass",
    "confidence": 0.95,
    "summary": "The geometry matches the description",
    "issues": [],
    "recommendations": [],
    "validatedPart": "base"
  }
}
```

## Plugin Configuration (plugin.yaml)

```yaml
plugin:
  name: Vision Validation
  slug: vision-validator
  version: 1.0.0
  author: Fabrikator Team
  description: AI-powered visual validation of 3D CAD geometry

requirements:
  apiKeys:
    - name: OPENAI_API_KEY
      required: false
      fallback: platform
    - name: GEMINI_API_KEY
      required: false
      fallback: platform

capabilities:
  tools:
    - name: vision_validate
      description: Validate 3D part geometry using AI vision
      parameters:
        type: object
        properties:
          part:
            type: string
            description: Part name to validate
          partDescription:
            type: string
            description: Description of expected geometry
        required:
          - part
      execution:
        type: external
        config:
          apiUrl: ${PLUGIN_VISION_VALIDATE_URL}
          endpoint: /validate
          timeout: 300000

pricing:
  model: free
```

## Rendered Views

The plugin renders 5 orthographic views:

| View | Camera Position | Description |
|------|-----------------|-------------|
| ISO | Isometric (45°) | Overall 3D perspective |
| Front | +Y axis | Front elevation |
| Right | +X axis | Right elevation |
| Top | +Z axis | Plan view from above |
| Bottom | -Z axis | Plan view from below |

## GPU Acceleration

The plugin **automatically detects** and uses available GPUs for significantly faster rendering:

### Supported GPUs:

| GPU Type | Backend | Auto-Detection | Performance |
|----------|---------|----------------|-------------|
| **NVIDIA RTX** | OptiX | ✅ Yes | **~10x faster** than CPU |
| **NVIDIA GTX/Tesla** | CUDA | ✅ Yes | **~8x faster** than CPU |
| **AMD Radeon** (RX 6000+, RX 7000+) | HIP/ROCm | ✅ Yes | **~5-8x faster** than CPU |
| **CPU** | Cycles CPU | ✅ Fallback | Baseline |

### How It Works:

1. **Detection**: On startup, the render script checks for:
   - NVIDIA GPUs via `nvidia-smi`
   - AMD GPUs via `rocminfo` or `/dev/kfd`
2. **Configuration**: Automatically configures Blender Cycles to use the fastest available backend
3. **Fallback**: If no GPU is detected, falls back to CPU rendering
4. **No manual config needed**: Everything is automatic!

### Performance Comparison:

**Rendering 5 views @ 500x500px:**

| Hardware | Samples | Time | Speedup |
|----------|---------|------|---------|
| CPU (8-core) | 64 | ~15-30s | 1x |
| NVIDIA RTX 4070 | 128 | ~2-4s | 10x |
| AMD RX 6800 XT | 128 | ~3-5s | 8x |

### Requirements:

**For NVIDIA:**
- NVIDIA drivers installed on host
- `nvidia-docker` or Docker with `--gpus` support
- Run with: `docker run --gpus all ...`

**For AMD:**
- ROCm drivers installed on host
- Run with: `docker run --device /dev/kfd --device /dev/dri ...`

**For CPU:**
- No requirements, works everywhere

## Development

### Project Structure

```
├── src/
│   └── index.ts          # Main Express server
├── scripts/
│   └── render3mf.py      # Blender rendering script
├── Dockerfile            # Container build
├── package.json
├── tsconfig.json
└── README.md
```

### Building

```bash
npm run build
```

### Testing Locally

```bash
# Start the server
npm run dev

# Test health endpoint
curl http://localhost:8080/health

# Test validation (requires running Fabrikator backend)
curl -X POST http://localhost:8080/validate \
  -H "Content-Type: application/json" \
  -d '{"context":{"sessionId":"test"},"args":{"part":"cube"}}'
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

