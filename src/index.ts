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
import OpenAI from 'openai';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;
const WORK_DIR = process.env.WORK_DIR || '/tmp/vision-validate';
const BLENDER_PATH = process.env.BLENDER_PATH || 'blender';
const API_KEY = process.env.API_KEY;
const BACKEND_API_KEY = process.env.BACKEND_API_KEY;

// Ensure work directory exists
if (!fs.existsSync(WORK_DIR)) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

// API Key Authentication Middleware
const authenticateApiKey = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Skip authentication for health check
  if (req.path === '/health') {
    return next();
  }

  // Check if API key is configured
  if (!API_KEY) {
    console.error('[AUTH] API_KEY environment variable not set');
    return res.status(500).json({
      ok: false,
      error: 'Server configuration error: API key not configured'
    });
  }

  // Extract API key from headers
  const providedKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!providedKey) {
    console.warn('[AUTH] Request missing API key');
    return res.status(401).json({
      ok: false,
      error: 'Authentication required: Missing API key'
    });
  }

  if (providedKey !== API_KEY) {
    console.warn('[AUTH] Invalid API key provided');
    return res.status(403).json({
      ok: false,
      error: 'Authentication failed: Invalid API key'
    });
  }

  // Authentication successful
  next();
};

// Apply authentication middleware to all routes
app.use(authenticateApiKey);

interface ValidationRequest {
  context: {
    sessionId: string;
    projectId?: string;
    accountId: string;
    step: number;
    artifact3mfUrl: string;  // Direct URL to 3MF file
  };
  args: {
    part: string;
    partDescription?: string;
    focus?: string;
    checks?: string[];
  };
  apiKeys: {
    OPENAI_API_KEY?: string;
    GEMINI_API_KEY?: string;
  };
}

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
      env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1' }
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

/**
 * Build vision analysis prompt
 */
function buildVisionPrompt(
  partContext: string,
  partDescription?: string,
  focus?: string,
  checks?: string[]
): string {
  const isAssembly = !partContext || partContext === 'assembly' || partContext.toLowerCase() === 'assembly';
  const hasPartDescription = partDescription && partDescription.trim().length > 0;

  const checklistInstruction = checks && checks.length > 0
    ? `Evaluate ONLY the following checklist items:\n${checks.map((item, idx) => `${idx + 1}. ${item}`).join('\n')}`
    : '';

  return [
    isAssembly
      ? 'You are evaluating an ASSEMBLY of 3D-printable parts.'
      : `You are evaluating a SINGLE PART: ${partContext}`,

    hasPartDescription
      ? `REQUIREMENTS TO VALIDATE:\n${partDescription}`
      : 'Validate that the geometry appears structurally sound and complete.',

    focus ? `FOCUS AREA: ${focus}` : '',
    checklistInstruction,
    '',
    'VALIDATION RULES:',
    '- Only validate what is described in the REQUIREMENTS above',
    '- Do NOT imagine or expect features not mentioned in the requirements',
    '- Focus on: presence of described features, relative positioning, obvious shape issues',
    '',
    'WHAT TO IGNORE:',
    '- Color differences (all parts may be same color)',
    '- Render artifacts (shadows, reflections)',
    '- Exact dimensions (you cannot measure precisely from images)',
    '',
    'OUTPUT FORMAT:',
    'Respond with ONLY valid JSON in this exact format:',
    '{',
    '  "verdict": "pass" | "fail" | "uncertain",',
    '  "confidence": 0.0 to 1.0,',
    '  "summary": "Brief overall assessment",',
    '  "issues": [{"type": "string", "detail": "string", "severity": "critical"|"major"|"minor"|"suggestion"}],',
    '  "recommendations": ["string"]',
    '}',
  ].filter(Boolean).join('\n');
}

/**
 * Call OpenAI Vision API
 */
async function callOpenAIVision(
  apiKey: string,
  prompt: string,
  images: Array<{ base64: string }>
): Promise<{ text: string; tokensUsed: number }> {
  const openai = new OpenAI({ apiKey });

  const content: OpenAI.Chat.ChatCompletionContentPart[] = [
    { type: 'text', text: prompt }
  ];

  for (const img of images) {
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${img.base64}`,
        detail: 'high'
      }
    });
  }

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content }],
    max_tokens: 2000,
    temperature: 0.1,
  });

  return {
    text: response.choices[0]?.message?.content || '',
    tokensUsed: response.usage?.total_tokens || 0
  };
}

/**
 * Call Gemini Vision API
 */
async function callGeminiVision(
  apiKey: string,
  prompt: string,
  images: Array<{ base64: string }>
): Promise<{ text: string; tokensUsed: number }> {
  const parts: any[] = [{ text: prompt }];

  for (const img of images) {
    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: img.base64
      }
    });
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2000,
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const data = await response.json() as any;
  return {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
    tokensUsed: data.usageMetadata?.totalTokenCount || 0
  };
}

/**
 * Parse vision response
 */
function parseVisionResponse(raw: string): any {
  let jsonStr = raw;
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    return {
      verdict: 'unknown',
      confidence: null,
      summary: raw,
      issues: [],
      recommendations: []
    };
  }
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
      const jpegBuffer = await convertToJpeg(img.path, 300);
      const base64 = jpegBuffer.toString('base64');

      artifacts.push({
        name: `${part}_${img.viewName}.jpg`,
        type: 'image',
        base64,
        mimeType: 'image/jpeg',
      });

      renderedViews.push({ view: img.viewName as AllowedView, file: `${part}_${img.viewName}.jpg` });
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

// Main validation endpoint
app.post('/validate', async (req: express.Request, res: express.Response) => {
  const body = req.body as ValidationRequest;
  const startTime = Date.now();

  // Debug logging
  console.log('[vision_validate] Received request body:', JSON.stringify(body, null, 2));

  try {
    const { part, partDescription, focus, checks } = body.args || {};
    const { sessionId, artifact3mfUrl, step } = body.context || {};

    console.log('[vision_validate] Extracted args:', { part, partDescription, focus, checks });
    console.log('[vision_validate] Extracted context:', { sessionId, artifact3mfUrl, step });

    if (!part) {
      const result: PluginResult = {
        ok: false,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({ error: 'part is required' }),
        error: 'part is required'
      };
      return res.json(result);
    }

    console.log(`[vision_validate] session=${sessionId} part=${part} step=${step}`);

    // Step 1: Fetch 3MF
    if (!artifact3mfUrl) {
      return res.json({
        ok: false,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({ error: 'artifact3mfUrl is required' }),
        error: 'artifact3mfUrl is required'
      });
    }

    const fetchResult = await fetch3mfFile(artifact3mfUrl, sessionId);
    if (!fetchResult.success) {
      const errorDetail = fetchResult.statusCode 
        ? `Failed to fetch 3MF: ${fetchResult.error} from ${fetchResult.url}`
        : `Failed to fetch 3MF: ${fetchResult.error} from ${fetchResult.url}`;
      return res.json({
        ok: false,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({ 
          verdict: 'error',
          error: errorDetail,
          url: fetchResult.url,
          statusCode: fetchResult.statusCode
        }),
        error: errorDetail
      });
    }

    // Step 2: Render with Blender
    const outputDir = path.join(WORK_DIR, sessionId, `render_${Date.now()}`);
    const renderResult = await renderWithBlender(fetchResult.localPath!, outputDir);

    if (!renderResult.success || renderResult.images.length === 0) {
      return res.json({
        ok: false,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({
          verdict: 'error',
          error: 'Rendering failed'
        }),
        error: 'Rendering failed'
      });
    }

    // Step 3: Convert to JPEG and prepare for vision
    const imageData: Array<{ base64: string; viewName: string }> = [];
    const artifacts: PluginArtifact[] = [];

    for (const img of renderResult.images) {
      const jpegBuffer = await convertToJpeg(img.path);
      const base64 = jpegBuffer.toString('base64');
      
      imageData.push({ base64, viewName: img.viewName });
      artifacts.push({
        name: `${part}_${img.viewName}.jpg`,  // Name includes view for identification
        type: 'image',
        base64,
        mimeType: 'image/jpeg',
      });
    }

    // Step 4: Run vision analysis
    const prompt = buildVisionPrompt(part, partDescription, focus, checks);
    
    const openaiKey = body.apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    const geminiKey = body.apiKeys?.GEMINI_API_KEY || process.env.GEMINI_API_KEY;

    let visionResult: { text: string; tokensUsed: number };
    let visionProvider: 'gemini' | 'openai';

    if (geminiKey) {
      visionResult = await callGeminiVision(geminiKey, prompt, imageData);
      visionProvider = 'gemini';
    } else if (openaiKey) {
      visionResult = await callOpenAIVision(openaiKey, prompt, imageData);
      visionProvider = 'openai';
    } else {
      return res.json({
        ok: false,
        tokensUsed: 0,
        artifacts,
        result: JSON.stringify({ error: 'No vision API key provided' }),
        error: 'No vision API key provided'
      });
    }

    // Step 5: Parse response
    console.log(
      `[vision_validate] raw model response provider=${visionProvider} tokens=${visionResult.tokensUsed} ` +
      `len=${visionResult.text?.length ?? 0}: ${visionResult.text?.slice(0, 1000) || '<empty>'}`
    );

    const parsed = parseVisionResponse(visionResult.text);

    const result: PluginResult = {
      ok: true,
      tokensUsed: visionResult.tokensUsed,
      artifacts,
      result: JSON.stringify({
        verdict: parsed.verdict,
        confidence: parsed.confidence,
        summary: parsed.summary,
        issues: parsed.issues,
        recommendations: parsed.recommendations,
        validatedPart: part
      })
    };

    console.log(`[vision_validate] completed in ${Date.now() - startTime}ms, verdict=${parsed.verdict}`);
    res.json(result);

    // Cleanup
    try {
      fs.rmSync(outputDir, { recursive: true, force: true });
    } catch {}

  } catch (error: any) {
    console.error('[vision_validate] error:', error.message);
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
  console.log(`API Key authentication: ${API_KEY ? 'ENABLED' : 'DISABLED (WARNING!)'}`);
  console.log(`OpenAI API Key: ${process.env.OPENAI_API_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`Gemini API Key: ${process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET'}`);

  if (!API_KEY) {
    console.error('⚠️  WARNING: API_KEY not set - service is not secured!');
  }
});


