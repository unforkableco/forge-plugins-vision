/**
 * Vision Validate Plugin Service
 *
 * External service that provides AI-powered CAD geometry validation.
 * Deployed on dedicated hardware with Blender for rendering.
 *
 * Flow:
 * 1. Receive validation request with part name and session info
 * 2. Fetch 3MF file from artifacts storage
 * 3. Render multiple views with Blender
 * 4. Analyze images with Vision AI (OpenAI GPT-4o or Gemini)
 * 5. Return verdict, issues, recommendations, and JPEG artifacts
 *
 * API Endpoints:
 * - GET /health - Health check (no auth required)
 * - POST /validate - Execute vision validation (requires API key)
 *
 * Environment Variables:
 * - API_KEY - API key for authenticating requests (required)
 * - OPENAI_API_KEY - OpenAI API key for vision analysis
 * - GEMINI_API_KEY - Gemini API key (alternative)
 * - STORAGE_BASE_URL - Base URL for artifact storage
 * - BLENDER_PATH - Path to Blender executable
 * - PORT - Server port (default: 8080)
 */

import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';


const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;
const WORK_DIR = process.env.WORK_DIR || '/tmp/vision-validate';
const BLENDER_PATH = process.env.BLENDER_PATH || 'blender';
const BACKEND_API_KEY = process.env.BACKEND_API_KEY;

// Ensure work directory exists
if (!fs.existsSync(WORK_DIR)) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

// No authentication middleware (API_KEY removed)



interface RenderRequest {
  context: {
    sessionId: string;
    artifact3mfUrl: string;
    step?: number;
  };
  args: {
    part: string;
    views?: string[];
  };
}

interface PluginArtifact {
  name: string;
  type: 'image' | 'file';
  base64: string;
  mimeType: string;
}

interface PluginResult {
  ok: boolean;
  tokensUsed: number;
  artifacts: PluginArtifact[];
  result: string;
  error?: string;
}

interface Fetch3mfResult {
  success: boolean;
  localPath?: string;
  error?: string;
  url: string;
  statusCode?: number;
}

type AllowedView = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
const ALLOWED_VIEWS = new Set<AllowedView>(['iso', 'front', 'back', 'left', 'right', 'top', 'bottom']);
const ALLOWED_VIEW_LIST = Array.from(ALLOWED_VIEWS).join(', ');

/**
 * Fetch 3MF file from artifacts storage
 * @param artifact3mfUrl - Direct URL to 3MF file
 * @param sessionId - Session ID for local file storage
 */
async function fetch3mfFile(
  artifact3mfUrl: string,
  sessionId: string
): Promise<Fetch3mfResult> {
  console.log(`Fetching 3MF from: ${artifact3mfUrl}`);

  try {
    const fileName = path.basename(new URL(artifact3mfUrl).pathname);

    // Add authentication headers if backend API key is configured
    const headers: Record<string, string> = {};
    if (BACKEND_API_KEY) {
      headers['X-API-Key'] = BACKEND_API_KEY;
      headers['Authorization'] = `Bearer ${BACKEND_API_KEY}`;
    }

    const response = await fetch(artifact3mfUrl, { headers });
    if (!response.ok) {
      console.error(`Failed to fetch 3MF: ${response.status}`);
      return {
        success: false,
        error: `HTTP ${response.status} ${response.statusText}`,
        url: artifact3mfUrl,
        statusCode: response.status
      };
    }

    const buffer = await response.buffer();
    const localPath = path.join(WORK_DIR, sessionId, fileName);

    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, buffer);

    return { success: true, localPath, url: artifact3mfUrl };
  } catch (error: any) {
    console.error(`Error fetching 3MF: ${error.message}`);
    return {
      success: false,
      error: error.message,
      url: artifact3mfUrl
    };
  }
}

/**
 * Render 3MF with Blender
 */
async function renderWithBlender(
  model3mfPath: string,
  outputDir: string,
  views: string[] = ['iso', 'front', 'right', 'top', 'bottom']
): Promise<{ success: boolean; images: Array<{ name: string; path: string; viewName: string }> }> {
  const scriptPath = path.join(__dirname, 'render3mf.py');

  if (!fs.existsSync(model3mfPath)) {
    console.error(`3MF file not found: ${model3mfPath}`);
    return { success: false, images: [] };
  }

  fs.mkdirSync(outputDir, { recursive: true });

  return new Promise((resolve) => {
    const args = [
      '--background',
      '--python', scriptPath,
      '--',
      model3mfPath,
      outputDir,
      ...views
    ];

    console.log(`Starting Blender render: ${model3mfPath}`);

    const proc = spawn(BLENDER_PATH, args, {
      env: {
        ...process.env,
        LIBGL_ALWAYS_SOFTWARE: '1',
        RENDER_RESOLUTION: process.env.RENDER_RESOLUTION || '500',
        RENDER_SAMPLES: process.env.RENDER_SAMPLES || '128'
      }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ success: false, images: [] });
    }, 300000); // 5 minute timeout

    proc.on('close', (code) => {
      clearTimeout(timeout);

      const images = views.map(view => ({
        name: `preview_${view}.png`,
        path: path.join(outputDir, `preview_${view}.png`),
        viewName: view
      })).filter(img => fs.existsSync(img.path));

      console.log(`Blender render complete: ${images.length}/${views.length} views`);
      resolve({ success: images.length > 0, images });
    });
  });
}

/**
 * Convert PNG to JPEG for smaller output
 */
async function convertToJpeg(pngPath: string, size?: number): Promise<Buffer> {
  try {
    const sharp = require('sharp');
    let pipeline = sharp(pngPath);

    if (size) {
      pipeline = pipeline.resize({
        width: size,
        height: size,
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 0 }
      });
    }

    return await pipeline.jpeg({ quality: 85 }).toBuffer();
  } catch {
    // Fallback: return PNG as-is
    return fs.readFileSync(pngPath);
  }
}

function normalizeViews(requested?: string[]): { views: AllowedView[]; error?: string } {
  if (!requested || requested.length === 0) {
    return {
      views: [],
      error: `views is required and must include at least one of: ${ALLOWED_VIEW_LIST}`
    };
  }

  const filtered = requested.filter((v): v is AllowedView => ALLOWED_VIEWS.has(v as AllowedView));
  if (filtered.length === 0) {
    return {
      views: [],
      error: `No valid views provided. Allowed views: ${ALLOWED_VIEW_LIST}`
    };
  }

  const seen = new Set<AllowedView>();
  const finalViews: AllowedView[] = [];
  for (const v of filtered) {
    if (!seen.has(v)) {
      seen.add(v);
      finalViews.push(v);
    }
  }
  return { views: finalViews };
}

// Health check
app.get('/health', (req: express.Request, res: express.Response) => {
  res.json({
    status: 'healthy',
    service: 'vision-validate-plugin',
    timestamp: new Date().toISOString(),
    blenderPath: BLENDER_PATH,
    allowedViews: Array.from(ALLOWED_VIEWS)
  });
});

// Render preview endpoint (300x300)
app.post('/render', async (req: express.Request, res: express.Response) => {
  const body = req.body as RenderRequest;
  const startTime = Date.now();

  console.log('[render_preview] Received request body:', JSON.stringify(body, null, 2));

  try {
    const { part, views: requestedViews } = body.args || {};
    const { sessionId, artifact3mfUrl, step } = body.context || {};

    const { views, error: viewError } = normalizeViews(requestedViews);
    console.log('[render_preview] Extracted args:', { part, views });
    console.log('[render_preview] Extracted context:', { sessionId, artifact3mfUrl, step });

    if (!part) {
      const result = {
        ok: false,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({ error: 'part is required' }),
        error: 'part is required'
      };
      return res.json(result);
    }

    if (viewError || !views || views.length === 0) {
      const msg = viewError || `views is required and must include at least one of: ${ALLOWED_VIEW_LIST}`;
      return res.json({
        ok: false,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({ error: msg, allowedViews: Array.from(ALLOWED_VIEWS) }),
        error: msg
      });
    }

    if (!artifact3mfUrl) {
      return res.json({
        ok: false,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({ error: 'artifact3mfUrl is required' }),
        error: 'artifact3mfUrl is required'
      });
    }

    if (!sessionId) {
      return res.json({
        ok: false,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({ error: 'context.sessionId is required' }),
        error: 'context.sessionId is required'
      });
    }

    console.log(`[render_preview] session=${sessionId} part=${part} step=${step}`);

    const fetchResult = await fetch3mfFile(artifact3mfUrl, sessionId);
    if (!fetchResult.success || !fetchResult.localPath) {
      const errorDetail = fetchResult.statusCode
        ? `Failed to fetch 3MF: ${fetchResult.error} from ${fetchResult.url}`
        : `Failed to fetch 3MF: ${fetchResult.error || 'unknown error'} from ${fetchResult.url}`;
      return res.json({
        ok: false,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({
          error: errorDetail,
          url: fetchResult.url,
          statusCode: fetchResult.statusCode
        }),
        error: errorDetail
      });
    }

    const outputDir = path.join(WORK_DIR, sessionId, `render_${Date.now()}`);
    const renderResult = await renderWithBlender(fetchResult.localPath, outputDir, views);

    if (!renderResult.success || renderResult.images.length === 0) {
      return res.json({
        ok: false,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({
          error: 'Rendering failed'
        }),
        error: 'Rendering failed'
      });
    }

    const artifacts: PluginArtifact[] = [];
    const renderedViews: Array<{ view: AllowedView; file: string }> = [];

    for (const img of renderResult.images) {
      const buffer = fs.readFileSync(img.path);
      const base64 = buffer.toString('base64');

      artifacts.push({
        name: `${part}_${img.viewName}.png`,
        type: 'image',
        base64,
        mimeType: 'image/png',
      });

      renderedViews.push({ view: img.viewName as AllowedView, file: `${part}_${img.viewName}.png` });
    }

    const result = {
      ok: true,
      tokensUsed: 0,
      artifacts,
      result: JSON.stringify({
        renderedViews,
        part,
        viewsRequested: views
      })
    };

    console.log(`[render_preview] completed in ${Date.now() - startTime}ms, views=${renderedViews.length}`);
    res.json(result);

    try {
      fs.rmSync(outputDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  } catch (error: any) {
    console.error('[render_preview] error:', error.message);
    res.json({
      ok: false,
      tokensUsed: 0,
      artifacts: [],
      result: JSON.stringify({ error: error.message }),
      error: error.message
    });
  }
});



app.listen(PORT, () => {
  console.log(`Vision Validate Plugin running on port ${PORT}`);
  console.log(`Work directory: ${WORK_DIR}`);
  console.log(`Blender path: ${BLENDER_PATH}`);


});


