/**
 * Vision Validate Plugin Service
 *
 * External service that provides AI-powered CAD geometry validation.
 * Deployed on dedicated hardware with Blender for rendering.
 *
 * Flow:
 * 1. Receive render request with part name and session info
 * 2. Enqueue job, return jobId immediately
 * 3. Worker fetches 3MF file from artifacts storage
 * 4. Render multiple views with Blender (concurrency-limited)
 * 5. Poll job status to retrieve JPEG artifacts when complete
 *
 * API Endpoints:
 * - GET  /health      - Health check with queue stats
 * - POST /render      - Submit render job (returns jobId)
 * - POST /job/status  - Check job status (plugin tool endpoint)
 * - GET  /job/:id     - Check job status (HTTP debugging)
 * - POST /validate    - Gating validation
 *
 * Environment Variables:
 * - BACKEND_API_KEY     - API key for backend artifact storage
 * - STORAGE_BASE_URL    - Base URL for artifact storage
 * - BLENDER_PATH        - Path to Blender executable
 * - PORT                - Server port (default: 8080)
 * - RENDER_CONCURRENCY  - Max concurrent Blender processes (default: 2)
 * - MAX_PENDING_JOBS    - Max queued jobs before rejecting (default: 20)
 */

import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import PQueue from 'p-queue';
import crypto from 'crypto';


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

// Session render tracking: Map<sessionId, Map<partName, lastRenderStep>>
const sessionRenders: Map<string, Map<string, number>> = new Map();

function recordRender(sessionId: string, partName: string, step: number): void {
  if (!sessionRenders.has(sessionId)) {
    sessionRenders.set(sessionId, new Map());
  }
  sessionRenders.get(sessionId)!.set(partName, step);
  console.log(`[gating] Recorded render: session=${sessionId} part=${partName} step=${step}`);
}

function getLastRenderStep(sessionId: string, partName: string): number {
  return sessionRenders.get(sessionId)?.get(partName) ?? -1;
}

// --- Queue & Job State ---

const CONCURRENCY_LIMIT = parseInt(process.env.RENDER_CONCURRENCY || '2', 10);
const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
const STUCK_JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_PENDING_JOBS = parseInt(process.env.MAX_PENDING_JOBS || '20', 10);

const renderQueue = new PQueue({ concurrency: CONCURRENCY_LIMIT });

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

interface JobState {
  id: string;
  status: JobStatus;
  request: RenderRequest;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: PluginResult;
  error?: string;
  jobDir: string;
}

const jobs = new Map<string, JobState>();

function createJob(request: RenderRequest): JobState {
  const id = crypto.randomUUID();
  const job: JobState = {
    id,
    status: 'queued',
    request,
    createdAt: Date.now(),
    jobDir: path.join(WORK_DIR, `job_${id}`),
  };
  jobs.set(id, job);
  return job;
}

function getQueuePosition(jobId: string): number {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'queued') return 0;
  let position = 0;
  for (const [, j] of jobs) {
    if (j.status === 'queued' && j.createdAt < job.createdAt) {
      position++;
    }
  }
  return position + 1;
}

// --- Types ---

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

type AllowedView = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'
                 | 'section_x' | 'section_y' | 'section_z';
const ALLOWED_VIEWS = new Set<AllowedView>([
  'iso', 'front', 'back', 'left', 'right', 'top', 'bottom',
  'section_x', 'section_y', 'section_z'
]);
const ALLOWED_VIEW_LIST = Array.from(ALLOWED_VIEWS).join(', ');

// --- File Fetching ---

/**
 * Fetch 3MF file into an isolated job directory
 */
async function fetch3mfFileIsolated(
  artifact3mfUrl: string,
  jobDir: string
): Promise<Fetch3mfResult> {
  console.log(`Fetching 3MF from: ${artifact3mfUrl}`);

  try {
    const fileName = path.basename(new URL(artifact3mfUrl).pathname);

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
    const localPath = path.join(jobDir, fileName);

    fs.mkdirSync(jobDir, { recursive: true });
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

// --- Blender Rendering ---

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

// --- Job Execution ---

async function executeRenderJob(job: JobState): Promise<void> {
  job.status = 'processing';
  job.startedAt = Date.now();

  const { part, views: requestedViews } = job.request.args;
  const { sessionId, artifact3mfUrl, step } = job.request.context;
  const { views } = normalizeViews(requestedViews);

  console.log(`[job:${job.id}] Processing: part=${part} views=${views.join(',')}`);

  try {
    fs.mkdirSync(job.jobDir, { recursive: true });

    const fetchResult = await fetch3mfFileIsolated(artifact3mfUrl, job.jobDir);
    if (!fetchResult.success || !fetchResult.localPath) {
      const errorDetail = fetchResult.statusCode
        ? `Failed to fetch 3MF: ${fetchResult.error} from ${fetchResult.url}`
        : `Failed to fetch 3MF: ${fetchResult.error || 'unknown error'} from ${fetchResult.url}`;
      job.status = 'failed';
      job.completedAt = Date.now();
      job.error = errorDetail;
      return;
    }

    const outputDir = path.join(job.jobDir, 'output');
    const renderResult = await renderWithBlender(fetchResult.localPath, outputDir, views);

    if (!renderResult.success || renderResult.images.length === 0) {
      job.status = 'failed';
      job.completedAt = Date.now();
      job.error = 'Rendering failed';
      return;
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

    job.result = {
      ok: true,
      tokensUsed: 0,
      artifacts,
      result: JSON.stringify({
        renderedViews,
        part,
        viewsRequested: views,
        jobId: job.id
      })
    };

    // Record render for gating
    const currentStep = step ?? Date.now();
    recordRender(sessionId, part, currentStep);

    job.status = 'completed';
    job.completedAt = Date.now();

    console.log(`[job:${job.id}] Completed in ${job.completedAt - job.startedAt!}ms, views=${renderedViews.length}`);
  } catch (error: any) {
    console.error(`[job:${job.id}] Error: ${error.message}`);
    job.status = 'failed';
    job.completedAt = Date.now();
    job.error = error.message;
  } finally {
    // Clean up job directory for failed jobs (completed jobs keep files until TTL)
    if (job.status === 'failed') {
      try {
        if (fs.existsSync(job.jobDir)) {
          fs.rmSync(job.jobDir, { recursive: true, force: true });
        }
      } catch { /* ignore cleanup errors */ }
    }
  }
}

// --- Job Status Response Builder ---

function buildJobStatusResponse(job: JobState): PluginResult {
  switch (job.status) {
    case 'queued':
      return {
        ok: true,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({
          status: 'queued',
          jobId: job.id,
          position: getQueuePosition(job.id),
        })
      };
    case 'processing':
      return {
        ok: true,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({
          status: 'processing',
          jobId: job.id,
          elapsedMs: Date.now() - (job.startedAt || job.createdAt),
        })
      };
    case 'completed':
      if (!job.result) {
        return {
          ok: false,
          tokensUsed: 0,
          artifacts: [],
          result: JSON.stringify({ error: 'Job completed but result is missing' }),
          error: 'Job completed but result is missing'
        };
      }
      return job.result;
    case 'failed':
      return {
        ok: false,
        tokensUsed: 0,
        artifacts: [],
        result: JSON.stringify({ error: job.error }),
        error: job.error
      };
  }
}

// --- Endpoints ---

// Health check
app.get('/health', (req: express.Request, res: express.Response) => {
  res.json({
    status: 'healthy',
    service: 'vision-validate-plugin',
    timestamp: new Date().toISOString(),
    blenderPath: BLENDER_PATH,
    allowedViews: Array.from(ALLOWED_VIEWS),
    queue: {
      pending: renderQueue.pending,
      size: renderQueue.size,
      concurrency: CONCURRENCY_LIMIT,
      totalJobs: jobs.size,
    }
  });
});

// Submit render job (returns jobId immediately)
app.post('/render', (req: express.Request, res: express.Response) => {
  const body = req.body as RenderRequest;

  const { part, views: requestedViews } = body.args || {};
  const { sessionId, artifact3mfUrl, step } = body.context || {};

  console.log(`[render_preview] Received: part=${part} views=${requestedViews?.join(',')} session=${sessionId}`);

  // Validate input synchronously
  if (!part) {
    return res.json({
      ok: false,
      tokensUsed: 0,
      artifacts: [],
      result: JSON.stringify({ error: 'part is required' }),
      error: 'part is required'
    });
  }

  const { views, error: viewError } = normalizeViews(requestedViews);
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

  // Check pending job count
  let pendingCount = 0;
  for (const [, j] of jobs) {
    if (j.status === 'queued' || j.status === 'processing') pendingCount++;
  }
  if (pendingCount >= MAX_PENDING_JOBS) {
    return res.status(429).json({
      ok: false,
      tokensUsed: 0,
      artifacts: [],
      result: JSON.stringify({ error: 'Too many pending jobs. Try again later.' }),
      error: 'Too many pending jobs. Try again later.'
    });
  }

  // Create and enqueue job
  const job = createJob(body);

  console.log(`[render_preview] Job ${job.id} queued: session=${sessionId} part=${part} step=${step}`);

  renderQueue.add(() => executeRenderJob(job)).catch((err) => {
    console.error(`[job:${job.id}] Queue error: ${err.message}`);
    if (job.status !== 'failed') {
      job.status = 'failed';
      job.completedAt = Date.now();
      job.error = err.message;
    }
  });

  res.json({
    ok: true,
    tokensUsed: 0,
    artifacts: [],
    result: JSON.stringify({
      jobId: job.id,
      status: 'queued',
      position: getQueuePosition(job.id),
    })
  });
});

// Job status endpoint (plugin tool format: POST with { args: { jobId }, context: {...} })
app.post('/job/status', (req: express.Request, res: express.Response) => {
  const { args } = req.body || {};
  const jobId = args?.jobId;

  if (!jobId) {
    return res.json({
      ok: false,
      tokensUsed: 0,
      artifacts: [],
      result: JSON.stringify({ error: 'jobId is required' }),
      error: 'jobId is required'
    });
  }

  const job = jobs.get(jobId);
  if (!job) {
    return res.json({
      ok: false,
      tokensUsed: 0,
      artifacts: [],
      result: JSON.stringify({ error: 'Job not found' }),
      error: 'Job not found'
    });
  }

  res.json(buildJobStatusResponse(job));
});

// Job status endpoint (HTTP debugging: GET /job/:id)
app.get('/job/:id', (req: express.Request, res: express.Response) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(buildJobStatusResponse(job));
});

// Gating validation endpoint
interface ValidateRequest {
  sessionId: string;
  artifacts: Array<{ name: string; url: string; partName?: string; step?: number }>;
}

app.post('/validate', (req: express.Request, res: express.Response) => {
  const body = req.body as ValidateRequest;
  const { sessionId, artifacts } = body;

  console.log(`[validate] sessionId=${sessionId} artifacts=${artifacts?.length || 0}`);

  if (!sessionId || !artifacts || !Array.isArray(artifacts)) {
    return res.json({ validated: false, message: 'Invalid request: sessionId and artifacts required' });
  }

  const missingRenders: string[] = [];

  for (const artifact of artifacts) {
    // Only check 3MF files
    if (artifact.name.endsWith('.3mf')) {
      // Extract part name: remove timestamp suffix and .3mf extension
      // e.g., "part_cube_1766323549127.3mf" -> "part_cube"
      const partName = artifact.partName || artifact.name.replace(/_\d+\.3mf$/, '').replace(/\.3mf$/, '');
      const artifactStep = artifact.step ?? 0;
      const lastRenderStep = getLastRenderStep(sessionId, partName);

      console.log(`[validate] Checking: part=${partName} artifactStep=${artifactStep} lastRender=${lastRenderStep}`);

      // Valid if render happened at or after artifact creation
      if (lastRenderStep < artifactStep) {
        missingRenders.push(`${artifact.name} (created step ${artifactStep}, last rendered step ${lastRenderStep})`);
      }
    }
  }

  if (missingRenders.length > 0) {
    const partsList = missingRenders.join(', ');
    const message = `The following parts need to be rendered: ${partsList}

\u26a0\ufe0f IMPORTANT: You MUST render these parts ONE BY ONE (not all at once). For each part:
1. Call render_preview for that single part
2. Carefully analyze the rendered image to verify the geometry is correct
3. If there are any issues with the design, fix the SCAD code and re-render before proceeding
4. Only move to the next part after confirming the current one looks correct

Do NOT batch all renders in a single step. Each render must be followed by visual analysis and potential iteration.`;
    console.log(`[validate] FAILED: ${message}`);
    return res.json({ validated: false, message });
  }

  console.log(`[validate] PASSED for session=${sessionId}`);
  res.json({ validated: true });
});

// --- Job Cleanup ---

function cleanupExpiredJobs(): void {
  const now = Date.now();
  let cleaned = 0;
  let stuck = 0;

  for (const [id, job] of jobs) {
    // Remove completed/failed jobs older than TTL
    if ((job.status === 'completed' || job.status === 'failed') &&
        job.completedAt && (now - job.completedAt) > JOB_TTL_MS) {
      try {
        if (fs.existsSync(job.jobDir)) {
          fs.rmSync(job.jobDir, { recursive: true, force: true });
        }
      } catch { /* ignore cleanup errors */ }
      jobs.delete(id);
      cleaned++;
    }
    // Mark stuck queued/processing jobs as failed
    else if ((job.status === 'queued' || job.status === 'processing') &&
             (now - job.createdAt) > STUCK_JOB_TTL_MS) {
      job.status = 'failed';
      job.completedAt = now;
      job.error = 'Job timed out (stuck for over 2 hours)';
      stuck++;
    }
  }

  if (cleaned > 0 || stuck > 0) {
    console.log(`[cleanup] Removed ${cleaned} expired jobs, marked ${stuck} stuck jobs as failed. Active: ${jobs.size}`);
  }
}

setInterval(cleanupExpiredJobs, 5 * 60 * 1000); // Run every 5 minutes

// --- Server Startup ---

app.listen(PORT, () => {
  console.log(`Vision Validate Plugin running on port ${PORT}`);
  console.log(`Work directory: ${WORK_DIR}`);
  console.log(`Blender path: ${BLENDER_PATH}`);
  console.log(`Gating: ENABLED`);
  console.log(`Queue: concurrency=${CONCURRENCY_LIMIT} maxPending=${MAX_PENDING_JOBS}`);
});
