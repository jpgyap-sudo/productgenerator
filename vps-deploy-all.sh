#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  vps-deploy-all.sh — COMPLETE one-command VPS deployment
#
#  Paste this ENTIRE script into your VPS terminal (as root).
#  It will:
#    1. Install Docker + Docker Compose
#    2. Create all project files
#    3. Prompt you for API keys
#    4. Build and start the Docker container
#
#  Usage:
#    sudo bash vps-deploy-all.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Product Image Studio — Full VPS Deployment${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"

# ── Step 1: System update ──
echo -e "\n${YELLOW}[1/8] Updating system packages...${NC}"
apt-get update -qq && apt-get upgrade -y -qq
echo -e "${GREEN}  ✓ System updated${NC}"

# ── Step 2: Install Docker ──
echo -e "\n${YELLOW}[2/8] Installing Docker...${NC}"
if command -v docker &>/dev/null; then
  echo "  Docker already installed: $(docker --version)"
else
  curl -fsSL https://get.docker.com | bash
  echo -e "${GREEN}  ✓ Docker installed: $(docker --version)${NC}"
fi

# ── Step 3: Install Docker Compose plugin ──
echo -e "\n${YELLOW}[3/8] Installing Docker Compose...${NC}"
if docker compose version &>/dev/null; then
  echo "  Docker Compose already installed: $(docker compose version)"
else
  apt-get install -y -qq docker-compose-plugin
  echo -e "${GREEN}  ✓ Docker Compose installed: $(docker compose version)${NC}"
fi

# ── Step 4: Create project directory ──
echo -e "\n${YELLOW}[4/8] Creating project directory...${NC}"
PROJECT_DIR="/root/productgenerator"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"
echo -e "${GREEN}  ✓ Working directory: $PROJECT_DIR${NC}"

# ── Step 5: Create all project files ──
echo -e "\n${YELLOW}[5/8] Creating project files...${NC}"

# ── Create directory structure ──
mkdir -p lib api/queue logs

# ── package.json ──
cat > package.json << 'PKGJSON'
{
  "name": "product-image-studio",
  "version": "2.0.0",
  "description": "Product Image Studio — AI-powered product photography using OpenAI GPT Image 2 and Gemini 3",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node server.js",
    "start": "node server.js",
    "build": "echo 'No build step needed for VPS deployment'"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.39.0",
    "express": "^4.21.0",
    "googleapis": "^140.0.0"
  }
}
PKGJSON

# ── ecosystem.config.cjs ──
cat > ecosystem.config.cjs << 'ECOSYSTEM'
module.exports = {
  apps: [{
    name: 'product-image-studio',
    script: './server.js',
    node_args: '--experimental-modules',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 3000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    max_size: '10M',
    retain: 3,
    kill_timeout: 10000,
    watch: false,
    instances: 1,
    exec_mode: 'fork'
  }]
};
ECOSYSTEM

# ── server.js ──
cat > server.js << 'SERVERJS'
import express from 'express';
import { supabase, QUEUE_TABLE, RESULTS_TABLE } from './lib/supabase.js';
import { VIEWS } from './lib/fal.js';
import { generateGeminiView } from './lib/gemini.js';
import { generateOpenAIView } from './lib/openai.js';
import { uploadRendersToDrive } from './lib/drive.js';

import submitHandler from './api/queue/submit.js';
import statusHandler from './api/queue/status.js';
import webhookHandler from './api/fal-webhook.js';

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = 5000;
const CONCURRENCY = 2;

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), memory: process.memoryUsage().rss });
});

app.post('/api/queue/submit', async (req, res) => {
  try {
    const result = await submitHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[SUBMIT] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/api/queue/status', async (req, res) => {
  try {
    const result = await statusHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[STATUS] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/api/fal-webhook', async (req, res) => {
  try {
    const result = await webhookHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[WEBHOOK] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.use(express.static('.'));

let workerRunning = false;
let currentJobs = new Map();

async function workerLoop() {
  if (workerRunning) return;
  workerRunning = true;
  console.log(`[WORKER] Background worker started (poll interval: ${POLL_INTERVAL_MS}ms, concurrency: ${CONCURRENCY})`);
  while (true) {
    try {
      await processNextBatch();
    } catch (err) {
      console.error('[WORKER] Loop error:', err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function processNextBatch() {
  const activeJobCount = currentJobs.size;
  const availableSlots = CONCURRENCY - activeJobCount;
  if (availableSlots <= 0) return;

  const { data: items, error } = await supabase
    .from(QUEUE_TABLE)
    .select('*')
    .in('status', ['active', 'wait'])
    .order('id', { ascending: true })
    .limit(availableSlots);

  if (error) {
    console.error('[WORKER] Failed to fetch queue items:', error.message);
    return;
  }
  if (!items || items.length === 0) return;

  for (const item of items) {
    if (currentJobs.has(item.id)) continue;
    const provider = item.provider || detectProvider(item) || 'openai';
    console.log(`[WORKER] Starting item ${item.id} ("${item.name}") with provider: ${provider}`);

    await supabase
      .from(QUEUE_TABLE)
      .update({
        status: 'active',
        sub_text: `Generating 5 views with ${provider === 'gemini' ? 'Gemini' : 'OpenAI'}...`,
        provider,
        updated_at: new Date().toISOString()
      })
      .eq('id', item.id);

    await ensureRenderRows(item.id, provider);

    const jobPromise = processItem(item.id, provider).finally(() => {
      currentJobs.delete(item.id);
    });
    currentJobs.set(item.id, jobPromise);
  }
}

function detectProvider(item) {
  if (!item.sub_text) return null;
  const t = item.sub_text.toLowerCase();
  if (t.includes('gemini')) return 'gemini';
  if (t.includes('openai')) return 'openai';
  return null;
}

async function ensureRenderRows(itemId, provider) {
  const now = new Date().toISOString();
  const { data: existing } = await supabase
    .from(RESULTS_TABLE)
    .select('view_id')
    .eq('queue_item_id', itemId);

  const existingViewIds = new Set((existing || []).map(r => r.view_id));
  const missingViews = VIEWS.filter(v => !existingViewIds.has(v.id));
  if (missingViews.length === 0) return;

  const rows = missingViews.map(view => ({
    queue_item_id: itemId,
    view_id: view.id,
    status: 'generating',
    image_url: '',
    error_message: '',
    request_id: '',
    response_url: '',
    status_url: '',
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now
  }));

  const { error } = await supabase
    .from(RESULTS_TABLE)
    .upsert(rows, { onConflict: 'queue_item_id,view_id' });

  if (error) {
    console.error(`[WORKER] Failed to create render rows for item ${itemId}:`, error.message);
  }
}

async function processItem(itemId, provider = 'openai') {
  const now = new Date().toISOString();
  const { data: items, error: fetchError } = await supabase
    .from(QUEUE_TABLE)
    .select('*')
    .eq('id', itemId);

  if (fetchError || !items || items.length === 0) {
    console.error(`[WORKER] Item ${itemId} not found:`, fetchError?.message);
    return;
  }

  const item = items[0];
  const imageUrl = item.image_url;
  const desc = item.description || '';

  if (!imageUrl) {
    await updateItemStatus(itemId, 'error', 'No reference image');
    await updateAllViewStatuses(itemId, 'error', 'No reference image');
    return;
  }

  try {
    const providerLabel = provider === 'gemini' ? 'Gemini' : 'OpenAI';
    await updateItemStatus(itemId, 'active', `Generating 5 views with ${providerLabel}...`);
    await updateAllViewStatuses(itemId, 'generating', null);

    const generateFn = provider === 'gemini' ? generateGeminiView : generateOpenAIView;
    const results = await Promise.allSettled(
      VIEWS.map(view => generateFn(view, desc, imageUrl, item.resolution || '1K'))
    );

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < VIEWS.length; i++) {
      const view = VIEWS[i];
      const result = results[i];

      if (result.status === 'fulfilled' && result.value) {
        successCount++;
        try {
          const publicUrl = result.value.cdnUrl;
          await supabase
            .from(RESULTS_TABLE)
            .update({
              status: 'done',
              image_url: publicUrl,
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('queue_item_id', itemId)
            .eq('view_id', view.id);
        } catch (saveErr) {
          console.error(`[WORKER] Failed to save result for item ${itemId} view ${view.id}:`, saveErr);
          await supabase
            .from(RESULTS_TABLE)
            .update({
              status: 'error',
              error_message: saveErr.message,
              updated_at: new Date().toISOString()
            })
            .eq('queue_item_id', itemId)
            .eq('view_id', view.id);
          failCount++;
        }
      } else {
        failCount++;
        const errMsg = result.status === 'rejected' ? result.reason?.message || 'Unknown error' : 'No result';
        await supabase
          .from(RESULTS_TABLE)
          .update({
            status: 'error',
            error_message: errMsg,
            updated_at: new Date().toISOString()
          })
          .eq('queue_item_id', itemId)
          .eq('view_id', view.id);
      }
    }

    const finalStatus = successCount === 5 ? 'done' : 'error';
    const statusText = successCount === 5
      ? 'All 5 views generated'
      : `${successCount}/5 views generated`;
    await updateItemStatus(itemId, finalStatus, statusText);

    if (successCount === 5) {
      await triggerDriveUpload(item);
    }
  } catch (error) {
    console.error(`[WORKER] Error processing item ${itemId}:`, error);
    await updateItemStatus(itemId, 'error', error.message || 'Processing failed');
    await updateAllViewStatuses(itemId, 'error', error.message || 'Processing failed');
  }
}

async function triggerDriveUpload(item) {
  try {
    const hasDriveEnv = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!hasDriveEnv) return;

    const alreadyUploaded = !!(item.drive_folder_id && item.drive_folder_id !== '')
      || !!(item.drive_folder_name && item.drive_folder_name !== '');
    if (alreadyUploaded) return;

    const { data: doneRows } = await supabase
      .from(RESULTS_TABLE)
      .select('*')
      .eq('queue_item_id', item.id)
      .eq('status', 'done');

    if (!doneRows || doneRows.length !== 5) return;

    const doneViews = doneRows.map(row => ({
      viewId: row.view_id,
      viewLabel: getViewLabel(row.view_id),
      imageUrl: row.image_url
    }));

    await updateDriveUploadState(item.id, {
      drive_upload_status: 'uploading',
      drive_upload_done: 0,
      drive_upload_total: doneViews.length,
      drive_upload_error: '',
      updated_at: new Date().toISOString()
    });

    const driveResult = await uploadRendersToDrive(item.id, item.name, doneViews, {
      onProgress: progress => updateDriveUploadState(item.id, {
        drive_upload_status: progress.status,
        drive_upload_done: progress.uploaded,
        drive_upload_total: progress.total,
        drive_upload_error: progress.status === 'error' ? progress.message || 'Drive upload incomplete' : '',
        drive_folder_id: progress.folderId || item.drive_folder_id || '',
        drive_folder_name: progress.folderName || item.drive_folder_name || '',
        updated_at: new Date().toISOString()
      })
    });

    await updateDriveUploadState(item.id, {
      drive_folder_id: driveResult.folderId,
      drive_folder_name: driveResult.folderName,
      drive_upload_status: driveResult.files.length === doneViews.length ? 'done' : 'error',
      drive_upload_done: driveResult.files.length,
      drive_upload_total: doneViews.length,
      drive_upload_error: driveResult.files.length === doneViews.length ? '' : 'Some files failed to upload',
      updated_at: new Date().toISOString()
    });

    console.log(`[WORKER] SUCCESS: Uploaded item ${item.id} to Drive folder "${driveResult.folderName}"`);
  } catch (driveErr) {
    await updateDriveUploadState(item.id, {
      drive_upload_status: 'error',
      drive_upload_error: driveErr.message || 'Drive upload failed',
      updated_at: new Date().toISOString()
    });
    console.error(`[WORKER] Drive upload failed for item ${item.id}:`, driveErr.message);
  }
}

function getViewLabel(viewId) {
  const view = VIEWS.find(v => v.id === viewId);
  return view ? view.label : `View ${viewId}`;
}

async function updateItemStatus(itemId, status, subText) {
  const now = new Date().toISOString();
  const updateData = { status, updated_at: now };
  if (subText) updateData.sub_text = subText;
  const { error } = await supabase
    .from(QUEUE_TABLE)
    .update(updateData)
    .eq('id', itemId);
  if (error) console.error(`[WORKER] Failed to update item ${itemId} status:`, error.message);
}

async function updateAllViewStatuses(itemId, status, errorMessage) {
  const now = new Date().toISOString();
  const updateData = { status, updated_at: now };
  if (errorMessage) updateData.error_message = errorMessage;
  if (status === 'generating') updateData.started_at = now;
  if (status === 'done' || status === 'error') updateData.completed_at = now;
  const { error } = await supabase
    .from(RESULTS_TABLE)
    .update(updateData)
    .eq('queue_item_id', itemId);
  if (error) console.error(`[WORKER] Failed to update view statuses for item ${itemId}:`, error.message);
}

async function updateDriveUploadState(itemId, fields) {
  const { error } = await supabase
    .from(QUEUE_TABLE)
    .update(fields)
    .eq('id', itemId);
  if (!error || !isMissingColumnError(error)) return;
  const { drive_upload_status, drive_upload_done, drive_upload_total, drive_upload_error, ...safeFields } = fields;
  await supabase.from(QUEUE_TABLE).update(safeFields).eq('id', itemId);
}

function isMissingColumnError(error) {
  return error?.code === 'PGRST204'
    || /column .* does not exist/i.test(error?.message || '')
    || /Could not find .* column/i.test(error?.message || '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Product Image Studio running on port ${PORT}`);
  console.log(`[SERVER] Environment: SUPABASE_URL=${process.env.SUPABASE_URL ? '✓ set' : '✗ missing'}`);
  console.log(`[SERVER] Environment: SUPABASE_SERVICE_ROLE_KEY=${process.env.SUPABASE_SERVICE_ROLE_KEY ? '✓ set' : '✗ missing'}`);
  console.log(`[SERVER] Environment: OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? '✓ set' : '✗ missing'}`);
  console.log(`[SERVER] Environment: GEMINI_API_KEY=${process.env.GEMINI_API_KEY ? '✓ set' : '✗ missing'}`);
  console.log(`[SERVER] Environment: GOOGLE_SERVICE_ACCOUNT_JSON=${process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? '✓ set' : '✗ missing (optional)'}`);
  workerLoop().catch(err => {
    console.error('[SERVER] Worker loop crashed:', err);
    process.exit(1);
  });
});
SERVERJS

# ── lib/supabase.js ──
cat > lib/supabase.js << 'SUPABASEJS'
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabase = createClient(
  SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { persistSession: false } }
);

const QUEUE_TABLE = 'product_queue';
const RESULTS_TABLE = 'render_results';
const BUCKET_NAME = 'product_images';
const CONFIG_TABLE = 'app_config';

export { supabase, QUEUE_TABLE, RESULTS_TABLE, BUCKET_NAME, CONFIG_TABLE };
SUPABASEJS

# ── lib/fal.js ──
cat > lib/fal.js << 'FALJS'
const FAL_API_KEY = process.env.FAL_API_KEY;

if (!FAL_API_KEY) {
  console.error('Missing FAL_API_KEY environment variable');
}

export const VIEWS = [
  { id: 1, label: 'Front view' },
  { id: 2, label: 'Side view' },
  { id: 3, label: 'Isometric view' },
  { id: 4, label: 'Back view' },
  { id: 5, label: 'Interior scene' }
];

function buildDesc(desc) {
  return (desc && desc.trim()) ? `the product from the reference image (${desc})` : 'the product from the reference image';
}

function fallbackPrompt(view, desc) {
  const d = buildDesc(desc);
  if (view.id === 1) return `Create a clean studio product photo of this ${d} from the reference image on a white background.`;
  if (view.id === 5) return `Create a photorealistic modern interior scene featuring this ${d} from the reference image.`;
  return `Create a clean ${view.label.toLowerCase()} product photo of this ${d} from the reference image on a white background.`;
}

function homeuPrompt(view, desc) {
  const d = buildDesc(desc);
  const fidelity = `Use ONLY the exact uploaded reference product image for ${d}. Maintain 100% product fidelity: do not redesign, reinterpret, replace, improve, recolor, resize disproportionately, add/remove cushions, change legs/base/frame, alter materials, or change structure. The product must remain the same object with the same proportions, color, material, silhouette, texture, and visible details.`;
  const productShot = `Generate one separate image only, not a collage or grid. White background, centered product photography, clean premium catalog lighting, soft realistic shadows, no extra furniture or decor.`;
  if (view.id === 1) return `${fidelity} ${productShot} Image 1: front view of the chair.`;
  if (view.id === 2) return `${fidelity} ${productShot} Image 2: side view of the chair.`;
  if (view.id === 3) return `${fidelity} ${productShot} Image 3: isometric 45-degree view of the chair.`;
  if (view.id === 4) return `${fidelity} ${productShot} Image 4: back view of the chair. Infer hidden rear details conservatively from the reference without changing the design.`;
  return `${fidelity} Generate one separate image only, not a collage or grid. Image 5: full luxury modern dining room interior scene using the EXACT same chair as the main furniture. Place it naturally in a high-end condominium or architect-designed luxury home setting with premium materials such as marble, travertine, wood veneer, brushed metal, linen or boucle textures, soft natural daylight, balanced exposure, realistic grounding shadows, correct scale and perspective, eye-level camera, and Homeu-style neutral luxury tones: beige, taupe, cream, warm gray, black accents, walnut or oak. Supporting decor such as rugs, pendant lights, wall art, curtains, vases, books, or trays is allowed only if it does not overpower the chair. The scene must look like a real photographed luxury property listing or interior design magazine image.`;
}

export const VIEW_PROMPTS = [
  { id: 1, prompt: d => homeuPrompt({ id: 1 }, d) },
  { id: 2, prompt: d => homeuPrompt({ id: 2 }, d) },
  { id: 3, prompt: d => homeuPrompt({ id: 3 }, d) },
  { id: 4, prompt: d => homeuPrompt({ id: 4 }, d) },
  { id: 5, prompt: d => homeuPrompt({ id: 5 }, d) }
];

export function extractImageUrl(result) {
  if (!result) return null;
  if (result.image?.url) return result.image.url;
  if (result.images?.[0]?.url) return result.images[0].url;
  if (result.output?.image_url) return result.output.image_url;
  if (result.output?.images?.[0]?.url) return result.output.images[0].url;
  if (result.image_url) return result.image_url;
  return null;
}
FALJS

# ── lib/openai.js ──
cat > lib/openai.js << 'OPENAIJS'
import { supabase, BUCKET_NAME } from './supabase.js';
import { VIEW_PROMPTS } from './fal.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) console.error('Missing OPENAI_API_KEY environment variable');

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5';

function mapResolution(resolution, isLandscape) {
  const size = resolution === '4K' || resolution === '2K' ? '1536' : '1024';
  if (isLandscape) return `${size}x1024`;
  return `1024x${size}`;
}

async function fetchImageBuffer(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch reference image: ${res.status}`);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: contentType };
}

export async function generateOpenAIView(view, desc, imageUrl, resolution = '1K') {
  const apiKey = OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const promptEntry = VIEW_PROMPTS.find(v => v.id === view.id) || VIEW_PROMPTS[0];
  const promptText = promptEntry.prompt(desc);
  const isLandscape = view.id === 5;
  const imageSize = mapResolution(resolution, isLandscape);

  console.log(`[OPENAI] Generating view ${view.id} (${view.label}) using ${OPENAI_IMAGE_MODEL}, size=${imageSize}`);

  const { buffer: imageBuffer, mimeType: imageMimeType } = await fetchImageBuffer(imageUrl);

  const formData = new FormData();
  const imageBlob = new Blob([imageBuffer], { type: imageMimeType });
  formData.append('image', imageBlob, `reference.${imageMimeType.includes('png') ? 'png' : 'jpg'}`);
  formData.append('prompt', promptText);
  formData.append('model', OPENAI_IMAGE_MODEL);
  formData.append('n', '1');
  formData.append('size', imageSize);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  let res;
  try {
    res = await fetch(`${OPENAI_API_BASE}/images/edits`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
      signal: controller.signal
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if (fetchErr.name === 'AbortError') throw new Error('OpenAI API request timed out after 60 seconds');
    throw fetchErr;
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    let errorDetail;
    try { errorDetail = await res.json(); } catch (e2) { /* ignore */ }
    const msg = typeof errorDetail === 'object'
      ? (errorDetail.error?.message || errorDetail.error || JSON.stringify(errorDetail))
      : errorDetail;
    throw new Error(`OpenAI API error ${res.status}: ${msg || 'Unknown error'}`);
  }

  const data = await res.json();
  if (!data?.data?.[0]?.b64_json) {
    throw new Error('No image in OpenAI response — ' + JSON.stringify(data).slice(0, 300));
  }

  const base64Data = data.data[0].b64_json;
  const buffer = Buffer.from(base64Data, 'base64');
  const mimeType = 'image/png';

  const publicUrl = await uploadOpenAIResult(buffer, mimeType, view.id);
  return { cdnUrl: publicUrl, label: view.label };
}

async function uploadOpenAIResult(buffer, mimeType, viewId) {
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const fileName = `openai_renders/view${viewId}_${Date.now()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, buffer, { contentType: mimeType, upsert: true });
  if (uploadError) throw new Error(`Failed to upload OpenAI result to storage: ${uploadError.message}`);
  const { data: { publicUrl } } = supabase.storage.from(BUCKET_NAME).getPublicUrl(fileName);
  return publicUrl;
}
OPENAIJS

# ── lib/gemini.js ──
cat > lib/gemini.js << 'GEMINIJS'
import { supabase, BUCKET_NAME } from './supabase.js';
import { VIEW_PROMPTS } from './fal.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) console.error('Missing GEMINI_API_KEY environment variable');

const GEMINI_MODELS = {
  STANDARD: 'gemini-3.1-flash-image-preview',
  PREMIUM: 'gemini-3-pro-image-preview'
};

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function imageUrlToInlineData(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch reference image: ${res.status}`);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await res.arrayBuffer());
  const base64Data = buffer.toString('base64');
  return { mimeType: contentType, data: base64Data };
}

export async function generateGeminiView(view, desc, imageUrl, resolution = '1K') {
  const apiKey = GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const modelName = view.id === 5 ? GEMINI_MODELS.PREMIUM : GEMINI_MODELS.STANDARD;
  const apiUrl = `${GEMINI_API_BASE}/${modelName}:generateContent?key=${apiKey}`;

  const promptEntry = VIEW_PROMPTS.find(v => v.id === view.id) || VIEW_PROMPTS[0];
  const promptText = promptEntry.prompt(desc);
  const inlineImage = await imageUrlToInlineData(imageUrl);

  const requestBody = {
    contents: [{
      role: 'user',
      parts: [
        { text: promptText },
        { inlineData: { mimeType: inlineImage.mimeType, data: inlineImage.data } }
      ]
    }],
    generationConfig: {
      responseModalities: ['Image', 'Text'],
      temperature: 0.4,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 8192
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };

  console.log(`[GEMINI] Generating view ${view.id} (${view.label}) using model ${modelName}`);

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    let errorDetail;
    try { errorDetail = await res.json(); } catch (e2) { /* ignore */ }
    const msg = typeof errorDetail === 'object'
      ? (errorDetail.error?.message || errorDetail.error || JSON.stringify(errorDetail))
      : errorDetail;
    throw new Error(`Gemini API error ${res.status}: ${msg || 'Unknown error'}`);
  }

  const data = await res.json();
  const imageData = extractGeminiImage(data);
  if (!imageData) throw new Error('No image in Gemini response — ' + JSON.stringify(data).slice(0, 300));

  const publicUrl = await uploadGeminiResult(imageData.buffer, imageData.mimeType, view.id);
  return { cdnUrl: publicUrl, label: view.label };
}

function extractGeminiImage(response) {
  if (!response?.candidates?.[0]?.content?.parts) return null;
  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData && part.inlineData.data) {
      const buffer = Buffer.from(part.inlineData.data, 'base64');
      const mimeType = part.inlineData.mimeType || 'image/jpeg';
      return { buffer, mimeType };
    }
  }
  return null;
}

async function uploadGeminiResult(buffer, mimeType, viewId) {
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const fileName = `gemini_renders/view${viewId}_${Date.now()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, buffer, { contentType: mimeType, upsert: true });
  if (uploadError) throw new Error(`Failed to upload Gemini result to storage: ${uploadError.message}`);
  const { data: { publicUrl } } = supabase.storage.from(BUCKET_NAME).getPublicUrl(fileName);
  return publicUrl;
}
GEMINIJS

# ── lib/drive.js ──
cat > lib/drive.js << 'DRIVEJS'
import { google } from 'googleapis';
import { supabase, CONFIG_TABLE } from './supabase.js';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function getDriveClient() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!rawJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON environment variable not set');
  let credentials;
  try { credentials = JSON.parse(rawJson); } catch (e) { throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON: ' + e.message); }
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  return google.drive({ version: 'v3', auth });
}

async function getOrCreateFolder(drive, folderName, parentId) {
  const query = `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) query.concat(` and '${parentId}' in parents`);
  const { data } = await drive.files.list({ q: query, fields: 'files(id,name)', pageSize: 1 });
  if (data.files?.length > 0) return data.files[0];
  const fileMetadata = { name: folderName, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) fileMetadata.parents = [parentId];
  const { data: folder } = await drive.files.create({ resource: fileMetadata, fields: 'id' });
  return folder;
}

async function uploadFileToDrive(drive, folderId, fileName, buffer, mimeType) {
  const { data: existing } = await drive.files.list({
    q: `name='${fileName.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
    pageSize: 1
  });
  if (existing.files?.length > 0) {
    await drive.files.update({ fileId: existing.files[0].id, media: { mimeType, body: buffer } });
    return existing.files[0].id;
  }
  const { data: file } = await drive.files.create({
    resource: { name: fileName, parents: [folderId] },
    media: { mimeType, body: buffer },
    fields: 'id'
  });
  return file.id;
}

async function fetchImageBuffer(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type') || 'image/jpeg';
  return { buffer, mimeType };
}

function getNextHaNumber(existingFolders) {
  const nums = existingFolders
    .map(f => { const m = f.name?.match(/^HA(\d+)$/i); return m ? parseInt(m[1], 10) : null; })
    .filter(n => n !== null)
    .sort((a, b) => a - b);
  let next = 1;
  for (const n of nums) { if (n === next) next++; else break; }
  return String(next).padStart(2, '0');
}

export async function uploadRendersToDrive(itemId, itemName, views, options = {}) {
  const drive = getDriveClient();
  const onProgress = options.onProgress || (() => {});

  const { data: config } = await supabase.from(CONFIG_TABLE).select('value').eq('key', 'drive_root_folder_id').single();
  const rootFolderId = config?.value || null;

  const { data: existingFolders } = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and name contains 'HA' and trashed=false${rootFolderId ? ` and '${rootFolderId}' in parents` : ''}`,
    fields: 'files(id,name)',
    pageSize: 100
  });

  const haNumber = getNextHaNumber(existingFolders?.files || []);
  const folderName = `HA${haNumber}`;

  const folder = await getOrCreateFolder(drive, folderName, rootFolderId);
  onProgress({ status: 'folder_created', uploaded: 0, total: views.length, folderId: folder.id, folderName });

  const uploadedFiles = [];
  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    try {
      const { buffer, mimeType } = await fetchImageBuffer(view.imageUrl);
      const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
      const fileName = `${itemName}_${view.viewLabel.replace(/\s+/g, '_')}.${ext}`;
      const fileId = await uploadFileToDrive(drive, folder.id, fileName, buffer, mimeType);
      uploadedFiles.push({ viewId: view.viewId, fileId, fileName });
      onProgress({ status: 'uploading', uploaded: i + 1, total: views.length, folderId: folder.id, folderName });
    } catch (err) {
      console.error(`[DRIVE] Failed to upload ${view.viewLabel}:`, err.message);
      onProgress({ status: 'error', uploaded: i + 1, total: views.length, message: err.message, folderId: folder.id, folderName });
    }
  }

  return { folderId: folder.id, folderName, files: uploadedFiles };
}
DRIVEJS

# ── api/queue/submit.js ──
cat > api/queue/submit.js << 'SUBMITJS'
import { supabase, QUEUE_TABLE, RESULTS_TABLE, BUCKET_NAME } from '../../lib/supabase.js';
import { VIEWS } from '../../lib/fal.js';

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!match) return null;
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

function imageExtension(mimeType) {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  return 'jpg';
}

async function uploadSubmittedImage(itemId, imageData) {
  const parsed = parseDataUrl(imageData);
  if (!parsed) return '';
  const ext = imageExtension(parsed.mimeType);
  const fileName = `queue/${itemId}_${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET_NAME).upload(fileName, parsed.buffer, { contentType: parsed.mimeType, upsert: true });
  if (error) throw new Error(`Failed to upload queued reference image: ${error.message}`);
  const { data: { publicUrl } } = supabase.storage.from(BUCKET_NAME).getPublicUrl(fileName);
  return publicUrl;
}

async function upsertSubmittedItems(itemIds, submittedItems, activeProvider, resolution) {
  if (!Array.isArray(submittedItems) || submittedItems.length === 0) return;
  const wantedIds = new Set(itemIds.map(id => Number(id)));
  const now = new Date().toISOString();
  const rows = [];
  for (const submitted of submittedItems) {
    const id = Number(submitted?.id);
    if (!Number.isFinite(id) || !wantedIds.has(id)) continue;
    let imageUrl = submitted.imageUrl || '';
    if (!imageUrl && submitted.imageData) imageUrl = await uploadSubmittedImage(id, submitted.imageData);
    rows.push({
      id, name: submitted.name || `Item ${id}`, image_url: imageUrl, status: 'active',
      sub_text: `Queued for ${activeProvider === 'gemini' ? 'Gemini' : 'OpenAI'} processing...`,
      description: submitted.description || '', brand: submitted.brand || '', provider: activeProvider,
      resolution: resolution || '1K', drive_folder_name: submitted.driveFolderName || '', updated_at: now
    });
  }
  if (rows.length === 0) return;
  const { error } = await supabase.from(QUEUE_TABLE).upsert(rows, { onConflict: 'id', ignoreDuplicates: false });
  if (error) throw error;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const { itemIds, items: submittedItems, resolution, provider } = body;
    if (!Array.isArray(itemIds) || itemIds.length === 0) return res.status(400).json({ error: 'itemIds array is required' });

    const activeProvider = provider || 'openai';
    if (activeProvider !== 'openai' && activeProvider !== 'gemini') return res.status(400).json({ error: `Unsupported provider: "${activeProvider}". Use "openai" or "gemini".` });

    await upsertSubmittedItems(itemIds, submittedItems, activeProvider, resolution);

    const { data: items, error: fetchError } = await supabase.from(QUEUE_TABLE).select('*').in('id', itemIds);
    if (fetchError) throw fetchError;
    if (!items || items.length === 0) return res.status(404).json({ error: 'No items found' });

    const now = new Date().toISOString();
    const { error: updateError } = await supabase.from(QUEUE_TABLE).update({
      status: 'active', sub_text: `Queued for ${activeProvider === 'gemini' ? 'Gemini' : 'OpenAI'} processing...`,
      provider: activeProvider, resolution: resolution || '1K', updated_at: now
    }).in('id', itemIds);
    if (updateError) throw updateError;

    const resultRows = [];
    for (const item of items) {
      for (const view of VIEWS) {
        resultRows.push({ queue_item_id: item.id, view_id: view.id, status: 'waiting', image_url: '', error_message: '', request_id: '', response_url: '', status_url: '', started_at: null, completed_at: null, created_at: now, updated_at: now });
      }
    }
    const { error: upsertError } = await supabase.from(RESULTS_TABLE).upsert(resultRows, { onConflict: 'queue_item_id,view_id' });
    if (upsertError) throw upsertError;

    console.log(`[SUBMIT] Queued ${items.length} item(s) for ${activeProvider} processing`);
    return res.json({ success: true, message: `Queued ${items.length} item(s) for ${activeProvider} processing`, provider: activeProvider, items: items.map(item => ({ id: item.id, name: item.name })) });
  } catch (error) {
    console.error('[SUBMIT] Error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
SUBMITJS

# ── api/queue/status.js ──
cat > api/queue/status.js << 'STATUSJS'
import { supabase, QUEUE_TABLE, RESULTS_TABLE, BUCKET_NAME } from '../../lib/supabase.js';
import { VIEWS } from '../../lib/fal.js';
import { uploadRendersToDrive } from '../../lib/drive.js';

const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5';
const cache = { data: null, key: null, timestamp: 0, TTL: 2000 };
function getCached(key) { if (cache.data && Date.now() - cache.timestamp < cache.TTL && cache.key === key) return cache.data; return null; }
function setCached(key, data) { cache.data = data; cache.key = key; cache.timestamp = Date.now(); }

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const itemId = req.query.itemId || null;
    const { data: queueItems, error: queueError } = await fetchQueueItems(itemId);
    if (queueError) throw queueError;
    if (!queueItems || queueItems.length === 0) return res.json({ queue: [], renderResults: {}, hasActiveItems: false, hasPendingItems: false });

    const itemIds = queueItems.map(item => item.id);
    const { data: renderRows, error: resultsError } = await supabase.from(RESULTS_TABLE).select('*').in('queue_item_id', itemIds).order('view_id', { ascending: true });
    if (resultsError) throw resultsError;

    const rowsWithActiveItems = await ensureRowsForActiveItems(renderRows || [], queueItems);
    await updateQueueStatuses(queueItems, rowsWithActiveItems);

    const { data: refreshedQueue } = await fetchQueueItems(itemId);
    const { data: refreshedRows } = await supabase.from(RESULTS_TABLE).select('*').in('queue_item_id', itemIds).order('view_id', { ascending: true });

    const queue = refreshedQueue || queueItems;
    const rows = refreshedRows || rowsWithActiveItems;

    const response = {
      queue: queue.map(item => ({
        id: item.id, name: item.name, imageUrl: item.image_url || '', status: item.status,
        description: item.description || '', provider: item.provider || '', apiModel: getBatchApiModel(item.provider),
        driveFolderId: item.drive_folder_id || '', driveFolderName: item.drive_folder_name || '',
        driveUploadStatus: item.drive_upload_status || '', driveUploadDone: item.drive_upload_done || 0,
        driveUploadTotal: item.drive_upload_total || 0, driveUploadError: item.drive_upload_error || '',
        updatedAt: item.updated_at
      })),
      renderResults: groupResults(rows),
      hasActiveItems: queue.some(item => item.status === 'active'),
      hasPendingItems: queue.some(item => item.status === 'wait')
    };
    return res.json(response);
  } catch (error) {
    console.error('[STATUS] Error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

function getBatchApiModel(provider) {
  if (provider === 'openai') return OPENAI_IMAGE_MODEL;
  if (provider === 'gemini') return 'gemini-3.1-flash-image-preview / gemini-3-pro-image-preview';
  return '';
}

function fetchQueueItems(itemId) {
  let query = supabase.from(QUEUE_TABLE).select('*').order('id', { ascending: true });
  if (itemId) query = query.eq('id', parseInt(itemId, 10));
  return query;
}

async function ensureRowsForActiveItems(rows, queueItems) {
  const nextRows = [...rows];
  const rowsByItemId = new Map();
  for (const row of rows) { if (!rowsByItemId.has(row.queue_item_id)) rowsByItemId.set(row.queue_item_id, []); rowsByItemId.get(row.queue_item_id).push(row); }
  const now = new Date().toISOString();
  const missingRows = [];
  for (const item of queueItems) {
    if (item.status !== 'active') continue;
    const itemRows = rowsByItemId.get(item.id) || [];
    if (itemRows.length > 0) continue;
    for (const view of VIEWS) missingRows.push({ queue_item_id: item.id, view_id: view.id, status: 'waiting', image_url: '', error_message: '', request_id: '', response_url: '', status_url: '', started_at: null, completed_at: null, created_at: now, updated_at: now });
  }
  if (missingRows.length === 0) return nextRows;
  const { error } = await supabase.from(RESULTS_TABLE).upsert(missingRows, { onConflict: 'queue_item_id,view_id' });
  if (error) throw error;
  nextRows.push(...missingRows);
  return nextRows;
}

async function updateQueueStatuses(queueItems, rows) {
  const updates = [];
  for (const item of queueItems) {
    if (item.status === 'stopped') continue;
    const itemRows = rows.filter(row => row.queue_item_id === item.id);
    if (itemRows.length === 0) continue;
    const doneCount = itemRows.filter(row => row.status === 'done').length;
    const errorCount = itemRows.filter(row => row.status === 'error').length;
    const activeCount = itemRows.filter(row => row.status === 'generating' || row.status === 'waiting').length;
    let status = item.status;
    let subText = item.sub_text || '';
    if (activeCount > 0) { status = 'active'; subText = `${doneCount}/5 views completed`; }
    else if (doneCount === 5) {
      status = 'done'; subText = 'All 5 views generated';
      const hasDriveEnv = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      const alreadyUploaded = !!(item.drive_folder_id && item.drive_folder_id !== '') || !!(item.drive_folder_name && item.drive_folder_name !== '');
      if (hasDriveEnv && !alreadyUploaded) {
        try {
          const doneViews = itemRows.filter(row => row.status === 'done' && row.image_url).map(row => ({ viewId: row.view_id, viewLabel: getViewLabel(row.view_id), imageUrl: row.image_url }));
          if (doneViews.length === 5) {
            await updateDriveUploadState(item.id, { drive_upload_status: 'uploading', drive_upload_done: 0, drive_upload_total: doneViews.length, drive_upload_error: '', updated_at: new Date().toISOString() });
            const driveResult = await uploadRendersToDrive(item.id, item.name, doneViews, { onProgress: progress => updateDriveUploadState(item.id, { drive_upload_status: progress.status, drive_upload_done: progress.uploaded, drive_upload_total: progress.total, drive_upload_error: progress.status === 'error' ? progress.message || 'Drive upload incomplete' : '', drive_folder_id: progress.folderId || item.drive_folder_id || '', drive_folder_name: progress.folderName || item.drive_folder_name || '', updated_at: new Date().toISOString() }) });
            await updateDriveUploadState(item.id, { drive_folder_id: driveResult.folderId, drive_folder_name: driveResult.folderName, drive_upload_status: driveResult.files.length === doneViews.length ? 'done' : 'error', drive_upload_done: driveResult.files.length, drive_upload_total: doneViews.length, drive_upload_error: driveResult.files.length === doneViews.length ? '' : 'Some files failed to upload', updated_at: new Date().toISOString() });
          }
        } catch (driveErr) { console.error(`[STATUS] Drive upload FAILED for item ${item.id}:`, driveErr.message); }
      }
    } else if (errorCount > 0) { status = 'error'; subText = errorCount === 5 ? 'All views failed' : `${doneCount}/5 views generated, ${errorCount} failed`; }
    if (status !== item.status || subText !== item.sub_text) updates.push({ id: item.id, status, sub_text: subText, updated_at: new Date().toISOString() });
  }
  for (const update of updates) { await supabase.from(QUEUE_TABLE).update({ status: update.status, sub_text: update.sub_text, updated_at: update.updated_at }).eq('id', update.id); }
}

function getViewLabel(viewId) { const view = VIEWS.find(v => v.id === viewId); return view ? view.label : `View ${viewId}`; }

async function updateDriveUploadState(itemId, fields) {
  const { error } = await supabase.from(QUEUE_TABLE).update(fields).eq('id', itemId);
  if (!error || !isMissingColumnError(error)) return;
  const { drive_upload_status, drive_upload_done, drive_upload_total, drive_upload_error, ...safeFields } = fields;
  await supabase.from(QUEUE_TABLE).update(safeFields).eq('id', itemId);
}

function isMissingColumnError(error) { return error?.code === 'PGRST204' || /column .* does not exist/i.test(error?.message || '') || /Could not find .* column/i.test(error?.message || ''); }

function groupResults(rows) {
  const grouped = {};
  for (const row of rows) { if (!grouped[row.queue_item_id]) grouped[row.queue_item_id] = []; grouped[row.queue_item_id].push({ viewId: row.view_id, status: row.status, imageUrl: row.image_url || null, errorMessage: row.error_message || null, startedAt: row.started_at, completedAt: row.completed_at }); }
  return grouped;
}
STATUSJS

# ── api/fal-webhook.js ──
cat > api/fal-webhook.js << 'WEBHOOKJS'
import { supabase, RESULTS_TABLE, QUEUE_TABLE, BUCKET_NAME } from '../../lib/supabase.js';
import { extractImageUrl, VIEWS } from '../../lib/fal.js';
import { uploadRendersToDrive } from '../../lib/drive.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const payload = req.body || {};
    const { request_id, gateway_request_id, status, payload: resultPayload, error } = payload;
    console.log(`[FAL-WEBHOOK] Received webhook for request ${request_id}, status=${status}`);
    if (!request_id) { console.error('[FAL-WEBHOOK] Missing request_id'); return res.json({ received: true }); }
    const { data: rows, error: fetchError } = await supabase.from(RESULTS_TABLE).select('*').eq('request_id', request_id);
    if (fetchError) { console.error(`[FAL-WEBHOOK] Error fetching row:`, fetchError.message); return res.json({ received: true }); }
    if (!rows || rows.length === 0) {
      if (gateway_request_id && gateway_request_id !== request_id) {
        const { data: gwRows } = await supabase.from(RESULTS_TABLE).select('*').eq('request_id', gateway_request_id);
        if (gwRows && gwRows.length > 0) return await processWebhookResult(gwRows[0], status, resultPayload, error, res);
      }
      console.warn(`[FAL-WEBHOOK] No matching row for request ${request_id}`); return res.json({ received: true });
    }
    return await processWebhookResult(rows[0], status, resultPayload, error, res);
  } catch (error) { console.error('[FAL-WEBHOOK] Error:', error.message); return res.json({ received: true }); }
}

async function processWebhookResult(row, status, resultPayload, error, res) {
  const now = new Date().toISOString();
  if (status === 'ERROR' || error) {
    console.error(`[FAL-WEBHOOK] Job failed for item ${row.queue_item_id} view ${row.view_id}:`, error || 'Unknown error');
    await supabase.from(RESULTS_TABLE).update({ status: 'error', error_message: error || 'Webhook reported error', completed_at: now, updated_at: now }).eq('queue_item_id', row.queue_item_id).eq('view_id', row.view_id);
    return res.json({ received: true });
  }
  const imageUrl = extractImageUrl(resultPayload);
  if (!imageUrl) {
    console.error(`[FAL-WEBHOOK] No image URL for item ${row.queue_item_id} view ${row.view_id}`);
    await supabase.from(RESULTS_TABLE).update({ status: 'error', error_message: 'No image URL in webhook payload', completed_at: now, updated_at: now }).eq('queue_item_id', row.queue_item_id).eq('view_id', row.view_id);
    return res.json({ received: true });
  }
  let storedUrl = imageUrl;
  try {
    const imageRes = await fetch(imageUrl);
    if (imageRes.ok) {
      const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
      const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
      const buffer = Buffer.from(await imageRes.arrayBuffer());
      const fileName = `renders/${row.queue_item_id}_view${row.view_id}_${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from(BUCKET_NAME).upload(fileName, buffer, { contentType, upsert: true });
      if (!uploadError) { const { data: { publicUrl } } = supabase.storage.from(BUCKET_NAME).getPublicUrl(fileName); storedUrl = publicUrl; }
    }
  } catch (storageErr) { console.warn(`[FAL-WEBHOOK] Failed to mirror to storage:`, storageErr.message); }
  await supabase.from(RESULTS_TABLE).update({ status: 'done', image_url: storedUrl, error_message: '', completed_at: now, updated_at: now }).eq('queue_item_id', row.queue_item_id).eq('view_id', row.view_id);
  console.log(`[FAL-WEBHOOK] View ${row.view_id} for item ${row.queue_item_id} completed`);
  try { await maybeUploadToDrive(row.queue_item_id); } catch (driveErr) { console.error(`[FAL-WEBHOOK] Drive upload failed:`, driveErr.message); }
  return res.json({ received: true });
}

async function maybeUploadToDrive(itemId) {
  const { data: items } = await supabase.from(QUEUE_TABLE).select('*').eq('id', itemId);
  if (!items || items.length === 0) return;
  const item = items[0];
  if ((item.drive_folder_id && item.drive_folder_id !== '') || (item.drive_folder_name && item.drive_folder_name !== '')) return;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return;
  const { data: rows } = await supabase.from(RESULTS_TABLE).select('*').eq('queue_item_id', itemId).order('view_id', { ascending: true });
  if (!rows) return;
  const doneViews = rows.filter(row => row.status === 'done' && row.image_url).map(row => ({ viewId: row.view_id, viewLabel: getViewLabel(row.view_id), imageUrl: row.image_url }));
  if (doneViews.length === 5) {
    try {
      await updateDriveUploadState(item.id, { drive_upload_status: 'uploading', drive_upload_done: 0, drive_upload_total: doneViews.length, drive_upload_error: '', updated_at: new Date().toISOString() });
      const driveResult = await uploadRendersToDrive(item.id, item.name, doneViews, { onProgress: progress => updateDriveUploadState(item.id, { drive_upload_status: progress.status, drive_upload_done: progress.uploaded, drive_upload_total: progress.total, drive_upload_error: progress.status === 'error' ? progress.message || 'Drive upload incomplete' : '', drive_folder_id: progress.folderId || item.drive_folder_id || '', drive_folder_name: progress.folderName || item.drive_folder_name || '', updated_at: new Date().toISOString() }) });
      await updateDriveUploadState(item.id, { drive_folder_id: driveResult.folderId, drive_folder_name: driveResult.folderName, drive_upload_status: driveResult.files.length === doneViews.length ? 'done' : 'error', drive_upload_done: driveResult.files.length, drive_upload_total: doneViews.length, drive_upload_error: driveResult.files.length === doneViews.length ? '' : 'Some files failed to upload', updated_at: new Date().toISOString() });
      console.log(`[FAL-WEBHOOK] SUCCESS: Uploaded ${item.name} to Drive folder "${driveResult.folderName}"`);
    } catch (driveErr) { await updateDriveUploadState(item.id, { drive_upload_status: 'error', drive_upload_error: driveErr.message || 'Drive upload failed', updated_at: new Date().toISOString() }); console.error(`[FAL-WEBHOOK] Drive upload FAILED:`, driveErr.message); }
  }
}

function getViewLabel(viewId) { const view = VIEWS.find(v => v.id === viewId); return view ? view.label : `View ${viewId}`; }

async function updateDriveUploadState(itemId, fields) {
  const { error } = await supabase.from(QUEUE_TABLE).update(fields).eq('id', itemId);
  if (!error || !isMissingColumnError(error)) return;
  const { drive_upload_status, drive_upload_done, drive_upload_total, drive_upload_error, ...safeFields } = fields;
  await supabase.from(QUEUE_TABLE).update(safeFields).eq('id', itemId);
}

function isMissingColumnError(error) { return error?.code === 'PGRST204' || /column .* does not exist/i.test(error?.message || '') || /Could not find .* column/i.test(error?.message || ''); }
WEBHOOKJS

# ── Dockerfile ──
cat > Dockerfile << 'DOCKERFILE'
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:20-slim AS runner
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ecosystem.config.cjs ./
COPY lib/ ./lib/
COPY api/ ./api/
COPY server.js ./
RUN mkdir -p logs
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "pm2-runtime", "start", "ecosystem.config.cjs", "--env", "production"]
DOCKERFILE

# ── docker-compose.yml ──
cat > docker-compose.yml << 'DOCKERCOMPOSE'
version: "3.9"
services:
  backend:
    build:
      context: .
      dockerfile: Dockerfile
    image: product-image-studio:latest
    container_name: product-studio-backend
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 512M
        reservations:
          memory: 384M
    ports:
      - "0.0.0.0:3000:3000"
    env_file:
      - .env
    volumes:
      - ./logs:/app/logs
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/health', r => {process.exit(r.statusCode===200?0:1)})"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
DOCKERCOMPOSE

# ── .dockerignore ──
cat > .dockerignore << 'DOCKERIGNORE'
node_modules
npm-debug.log*
.env
.git
.gitignore
*.md
logs/
deploy.sh
vps-setup.sh
vps-deploy-all.sh
Caddyfile
README-VPS.md
AI_CODER_LOG.md
supabase_setup.sql
plans/
DOCKERIGNORE

echo -e "${GREEN}  ✓ All project files created${NC}"

# ── Step 6: Collect API keys ──
echo -e "\n${YELLOW}[6/8] Setting up environment variables...${NC}"
echo -e "${CYAN}  You will need to provide your API keys.${NC}"
echo -e "${CYAN}  (Press Enter to skip any optional field)${NC}"
echo ""

read -p "  SUPABASE_URL (e.g., https://xxxxx.supabase.co): " SUPABASE_URL
read -p "  SUPABASE_SERVICE_ROLE_KEY (your service role key): " SUPABASE_SERVICE_ROLE_KEY
read -p "  OPENAI_API_KEY (sk-...): " OPENAI_API_KEY
read -p "  GEMINI_API_KEY (AIza...): " GEMINI_API_KEY
read -p "  STABILITY_API_KEY (sk-..., optional): " STABILITY_API_KEY
read -p "  GOOGLE_SERVICE_ACCOUNT_JSON (optional, paste full JSON): " GOOGLE_SERVICE_ACCOUNT_JSON
read -p "  FAL_API_KEY (optional): " FAL_API_KEY

# Create .env file
cat > .env << ENVFILE
# Supabase
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}

# OpenAI (GPT Image 2)
OPENAI_API_KEY=${OPENAI_API_KEY}

# Google Gemini 3
GEMINI_API_KEY=${GEMINI_API_KEY}

# Stability AI (SDXL — optional)
STABILITY_API_KEY=${STABILITY_API_KEY}

# Google Drive (optional — for auto-upload to Drive)
GOOGLE_SERVICE_ACCOUNT_JSON=${GOOGLE_SERVICE_ACCOUNT_JSON}

# fal.ai (optional — not used by default on VPS)
FAL_API_KEY=${FAL_API_KEY}
ENVFILE

echo -e "${GREEN}  ✓ .env file created${NC}"

# ── Step 7: Open firewall port ──
echo -e "\n${YELLOW}[7/8] Opening port 3000 in firewall...${NC}"
if command -v ufw &>/dev/null; then
  ufw allow 3000/tcp 2>/dev/null && echo -e "${GREEN}  ✓ Port 3000 opened${NC}" || echo -e "  ${YELLOW}UFW not active, skipping${NC}"
else
  echo -e "  ${YELLOW}UFW not installed, skipping firewall config${NC}"
fi

# ── Step 8: Build and start Docker container ──
echo -e "\n${YELLOW}[8/8] Building and starting Docker container...${NC}"
echo -e "  ${CYAN}This will take a few minutes on first run (downloading Node.js image)...${NC}"

docker compose build
docker compose up -d

echo -e "\n${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ DEPLOYMENT COMPLETE!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Backend API running at:${NC}"
echo -e "    http://104.248.225.250:3000"
echo -e "    http://104.248.225.250:3000/health"
echo ""
echo -e "  ${CYAN}Container status:${NC}"
docker ps --filter name=product-studio-backend --format "  Status: {{.Status}} — Ports: {{.Ports}}"
echo ""
echo -e "  ${CYAN}View logs:${NC}"
echo -e "    docker compose logs -f"
echo ""
echo -e "  ${CYAN}Stop container:${NC}"
echo -e "    docker compose down"
echo ""
echo -e "  ${CYAN}Restart container:${NC}"
echo -e "    docker compose restart"
echo ""
echo -e "  ${CYAN}Update container (after code changes):${NC}"
echo -e "    docker compose build && docker compose up -d"
echo ""
echo -e "  ${YELLOW}⚠  IMPORTANT:${NC}"
echo -e "  Your frontend on Vercel must point to:"
echo -e "    http://104.248.225.250:3000"
echo ""
echo -e "  ${YELLOW}⚠  Security note:${NC}"
echo -e "  The API is exposed on port 3000 without authentication."
echo -e "  For production, add a reverse proxy (Caddy/Nginx) with HTTPS."
echo ""
