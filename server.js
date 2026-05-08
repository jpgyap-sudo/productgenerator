// ═══════════════════════════════════════════════════════════════════
//  server.js — Express entry point for VPS deployment
//  Replaces Vercel serverless functions with a persistent Node.js
//  server + background worker loop.
//
//  Architecture:
//    - Express HTTP server on :3000 (behind Caddy reverse proxy)
//    - Background worker polls Supabase every 5s for active queue items
//    - Processes items using OpenAI GPT Image 2 or Gemini 3
//    - PM2 manages process lifecycle (auto-restart on crash)
//    - Environment variables loaded from .env file (via dotenv)
// ═══════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import multer from 'multer';
import { supabase, QUEUE_TABLE, RESULTS_TABLE } from './lib/supabase.js';
import { VIEWS } from './lib/fal.js';
import { generateGeminiView } from './lib/gemini.js';
import { generateOpenAIView } from './lib/openai.js';
import { generateStabilityView } from './lib/stability.js';
import { generateWithFallback } from './lib/render-with-fallback.js';
import { uploadRendersToDrive, getNextFolderCounter, getNextFolderCounterFallback, isSupabaseConnectionError } from './lib/drive.js';
import {
  VPS_ASSET_ROOT,
  createRenderZipOnVps,
  saveRenderImageToVps
} from './lib/vps-storage.js';
import { saveCompletedBatch } from './lib/completed-batches.js';

// ── Import API handlers (adapted for Express) ──
import submitHandler from './api/queue/submit.js';
import statusHandler from './api/queue/status.js';
import completedHandler from './api/queue/completed.js';
import downloadZipHandler from './api/queue/download-zip.js';
import uploadDriveHandler from './api/queue/upload-drive.js';
import saveStateHandler from './api/queue/save-state.js';
import agentProcessHandler from './api/agent/process.js';
import agentMatchHandler from './api/agent/match.js';
import agentSubmitHandler from './api/agent/submit.js';
import agentSaveMatchedHandler from './api/agent/save-matched.js';
import agentMatchedImagesHandler from './api/agent/matched-images.js';
import agentSaveMatchedPermanentHandler from './api/agent/save-matched-permanent.js';
import agentMatchedImagesPermanentHandler from './api/agent/matched-images-permanent.js';
import renderProductHandler from './api/render/product.js';
import renderQueueRoutes from './api/render-queue/index.js';
import monitorHandler from './api/monitor.js';
import rerenderViewHandler from './api/queue/rerender-view.js';

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = 5000; // Check for new jobs every 5 seconds
const CONCURRENCY = 5; // Process up to 5 items simultaneously

const app = express();

// ── Middleware ──
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ── CORS (allow frontend from any origin) ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), memory: process.memoryUsage().rss });
});

// ── API Monitoring ──
app.get('/api/monitor', async (req, res) => {
  try {
    await monitorHandler(req, res);
  } catch (err) {
    console.error('[MONITOR] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── API Routes ──
// These wrap the existing Vercel handlers into Express route handlers.
// The handlers use req.query / req.body / res.json instead of
// Vercel's (req) => Response pattern.

app.post('/api/queue/submit', async (req, res) => {
  try {
    const result = await submitHandler(req, res);
    // If handler already sent response, don't send again
    if (!res.headersSent) {
      res.json(result);
    }
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

app.all('/api/queue/completed', async (req, res) => {
  try {
    const result = await completedHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[COMPLETED] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/api/queue/upload-drive', async (req, res) => {
  try {
    const result = await uploadDriveHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[UPLOAD-DRIVE] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/api/queue/download-zip', async (req, res) => {
  try {
    const result = await downloadZipHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[DOWNLOAD-ZIP] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/api/queue/save-state', async (req, res) => {
  try {
    const result = await saveStateHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[SAVE-STATE] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── Uploading Agent Routes ──
app.post('/api/agent/process', async (req, res) => {
  try {
    const result = await agentProcessHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[AGENT-PROCESS] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/match', async (req, res) => {
  try {
    const result = await agentMatchHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[AGENT-MATCH] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/submit', async (req, res) => {
  try {
    const result = await agentSubmitHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[AGENT-SUBMIT] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── Matched Images Routes ──
app.post('/api/agent/save-matched', async (req, res) => {
  try {
    const result = await agentSaveMatchedHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[SAVE-MATCHED] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/api/agent/matched-images', async (req, res) => {
  try {
    const result = await agentMatchedImagesHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[MATCHED-IMAGES] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── Permanent Canvas Routes ──
app.post('/api/agent/save-matched-permanent', async (req, res) => {
  try {
    const result = await agentSaveMatchedPermanentHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[SAVE-MATCHED-PERMANENT] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/api/agent/matched-images-permanent', async (req, res) => {
  try {
    const result = await agentMatchedImagesPermanentHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[MATCHED-IMAGES-PERMANENT] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/api/queue/rerender-view', async (req, res) => {
  try {
    await rerenderViewHandler(req, res);
  } catch (err) {
    console.error('[RERENDER-VIEW] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── Render Product Route (with QA pipeline) ──
const renderUpload = multer({ dest: 'uploads/' });
app.post('/api/render/product', renderUpload.single('productImage'), async (req, res) => {
  try {
    await renderProductHandler(req, res);
  } catch (err) {
    console.error('[RENDER-PRODUCT] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── Render Queue Routes (cloud-based permanent queue) ──
app.use('/api/render-queue', renderQueueRoutes);

// ── Temporary Migration Endpoint ──
// Run Supabase migration for permanent canvas columns
// Call: curl -X POST http://localhost:3000/api/admin/run-migration
app.post('/api/admin/run-migration', async (req, res) => {
  try {
    console.log('[MIGRATION] Starting permanent canvas migration...');
    const pkg = await import('pg');
    const { Client } = pkg.default;
    const projectRef = process.env.SUPABASE_URL.replace('https://', '').replace('.supabase.co', '').trim();
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const configs = [
      { connectionString: `postgresql://postgres.${projectRef}:${SUPABASE_SERVICE_ROLE_KEY}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`, label: 'Session pooler (5432)' },
      { connectionString: `postgresql://postgres.${projectRef}:${SUPABASE_SERVICE_ROLE_KEY}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`, label: 'Transaction pooler (6543)' },
    ];

    let client = null;
    for (const cfg of configs) {
      try {
        console.log(`[MIGRATION] Trying ${cfg.label}...`);
        const c = new Client({ connectionString: cfg.connectionString, connectionTimeoutMillis: 15000 });
        await c.connect();
        console.log(`[MIGRATION] Connected via ${cfg.label}`);
        client = c;
        break;
      } catch (err) {
        console.log(`[MIGRATION] ${cfg.label} failed: ${err.message}`);
      }
    }

    if (!client) {
      return res.status(500).json({ error: 'Could not connect to database via any method' });
    }

    const results = [];

    // Add columns
    const alterStatements = [
      `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Dining Chair';`,
      `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS original_description TEXT DEFAULT '';`,
      `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS image_hash TEXT DEFAULT '';`,
      `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS duplicate_notices JSONB DEFAULT '[]'::jsonb;`,
      `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS saved_at TIMESTAMPTZ DEFAULT NOW();`,
    ];

    for (const sql of alterStatements) {
      const colName = sql.match(/ADD COLUMN IF NOT EXISTS (\w+)/)?.[1] || 'unknown';
      console.log(`[MIGRATION] Adding column: ${colName}...`);
      await client.query(sql);
      results.push({ action: 'add_column', name: colName, status: 'ok' });
      console.log(`[MIGRATION]   ✓ ${colName} added`);
    }

    // Create indexes
    const indexStatements = [
      `CREATE INDEX IF NOT EXISTS idx_matched_images_product_code ON public.matched_images(product_code);`,
      `CREATE INDEX IF NOT EXISTS idx_matched_images_image_name ON public.matched_images(image_name);`,
      `CREATE INDEX IF NOT EXISTS idx_matched_images_image_hash ON public.matched_images(image_hash);`,
      `CREATE INDEX IF NOT EXISTS idx_matched_images_saved_at ON public.matched_images(saved_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_matched_images_category ON public.matched_images(category);`,
    ];

    for (const sql of indexStatements) {
      const idxName = sql.match(/CREATE INDEX IF NOT EXISTS (\w+)/)?.[1] || 'unknown';
      console.log(`[MIGRATION] Creating index: ${idxName}...`);
      await client.query(sql);
      results.push({ action: 'create_index', name: idxName, status: 'ok' });
      console.log(`[MIGRATION]   ✓ ${idxName} created`);
    }

    // Verify
    const { rows } = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'matched_images'
      ORDER BY ordinal_position;
    `);

    await client.end();
    console.log('[MIGRATION] Migration complete!');
    res.json({ success: true, results, columns: rows });
  } catch (err) {
    console.error('[MIGRATION] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Favicon ──
app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/x-icon');
  // Return a minimal 1x1 transparent favicon to avoid 404s
  // This is a valid ICO file (68 bytes) that browsers accept silently
  const ico = Buffer.from('AAABAAEAEBACAAEAAQCwAAAAFgAAACgAAAAQAAAAIAAAAAEAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'base64');
  res.send(ico);
});

// ── Serve static frontend ──
app.use('/vps-assets', express.static(VPS_ASSET_ROOT, {
  maxAge: '5m'
}));
app.get('/completebatch', (req, res) => {
  res.sendFile('index.html', { root: process.cwd() });
});
app.use(express.static('.'));

// ═══════════════════════════════════════════════════════════════════
//  Background Worker Loop
//  Polls Supabase for active queue items and processes them.
//  This replaces Vercel's waitUntil() mechanism.
// ═══════════════════════════════════════════════════════════════════

let workerRunning = false;
let currentJobs = new Map(); // itemId -> processing promise

/**
 * Main worker loop — runs indefinitely.
 * Polls Supabase every POLL_INTERVAL_MS for items with status='active'
 * that are not already being processed.
 */
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

/**
 * Fetch the next batch of active items and process them.
 */
async function processNextBatch() {
  // Count how many slots are free
  const activeJobCount = currentJobs.size;
  const availableSlots = CONCURRENCY - activeJobCount;

  if (availableSlots <= 0) return;

  // Fetch items that need processing (exclude archived items)
  // Use try/catch with fallback for missing archived_at column
  let items, error;
  try {
    const result = await supabase
      .from(QUEUE_TABLE)
      .select('*')
      .in('status', ['active', 'wait'])
      .is('archived_at', null)
      .order('id', { ascending: true })
      .limit(availableSlots);
    items = result.data;
    error = result.error;
  } catch (firstErr) {
    error = firstErr;
  }

  // Fallback: if archived_at column doesn't exist, query without it
  if (error && (error.code === 'PGRST204' || /column .* does not exist/i.test(error.message || ''))) {
    console.warn('[WORKER] archived_at column not found, querying without it');
    const result = await supabase
      .from(QUEUE_TABLE)
      .select('*')
      .in('status', ['active', 'wait'])
      .order('id', { ascending: true })
      .limit(availableSlots);
    items = result.data;
    error = result.error;
  }

  if (error) {
    console.error('[WORKER] Failed to fetch queue items:', error.message);
    return;
  }

  if (!items || items.length === 0) return;

  for (const item of items) {
    // Skip if already being processed
    if (currentJobs.has(item.id)) continue;

    // Reserve the slot IMMEDIATELY to prevent duplicate processing.
    // We create a placeholder promise that gets replaced after setup.
    const setupPromise = (async () => {
      const provider = item.provider || detectProvider(item) || 'openai-mini';

      console.log(`[WORKER] Starting item ${item.id} ("${item.name}") with provider: ${provider}`);

      // Mark as active
      const providerLabel = provider.startsWith('stability')
        ? provider.includes('cheap') || provider.includes('mini')
          ? 'Stability AI (cheap/mini)'
          : 'Stability AI'
        : provider === 'gemini'
          ? 'Gemini'
          : provider.includes('cheap') || provider.includes('mini')
            ? 'OpenAI (cheap/mini)'
            : 'OpenAI';
      await updateQueueItemFields(item.id, {
        status: 'active',
        sub_text: `Generating 4 views with ${providerLabel}...`,
        provider,
        updated_at: new Date().toISOString()
      });

      // Ensure render_results rows exist
      await ensureRenderRows(item.id, provider);

      // Start processing in background
      const jobPromise = processItem(item.id, provider).finally(() => {
        currentJobs.delete(item.id);
      });

      // Replace the placeholder with the real job promise
      currentJobs.set(item.id, jobPromise);
      return jobPromise;
    })();

    // Set the placeholder immediately so subsequent poll cycles skip this item
    currentJobs.set(item.id, setupPromise);
  }
}

/**
 * Detect provider from item sub_text or default to openai.
 * Preserves sub-variants like 'openai-cheap', 'openai-mini', 'stability', 'stability-cheap'.
 */
function detectProvider(item) {
  if (!item.sub_text) return null;
  const t = item.sub_text.toLowerCase();
  // Preserve sub-variants: check for 'cheap'/'mini' suffixes first
  if (t.includes('stability')) {
    if (t.includes('cheap') || t.includes('mini')) return 'stability-cheap';
    return 'stability';
  }
  if (t.includes('gemini')) return 'gemini';
  if (t.includes('openai')) {
    if (t.includes('cheap') || t.includes('mini')) return 'openai-cheap';
    return 'openai';
  }
  return null;
}

/**
 * Ensure render_results rows exist for all 4 views of an item.
 */
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

/**
 * Process a single queue item: generate all 4 views, save results.
 */
async function processItem(itemId, provider = 'openai-mini') {
  const now = new Date().toISOString();

  // Fetch the item
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

  // Warn if description is empty — AI renders will be lower quality
  if (!desc || desc.trim().length < 5) {
    console.warn(`[WORKER] Item ${itemId} ("${item.name || 'unnamed'}") has no meaningful description — AI render quality may be degraded`);
  }

  try {
    const { data: existingRows, error: existingRowsError } = await supabase
      .from(RESULTS_TABLE)
      .select('view_id, status, image_url')
      .eq('queue_item_id', itemId);

    if (existingRowsError) throw existingRowsError;

    const completedViewIds = new Set(
      (existingRows || [])
        .filter(row => row.status === 'done' && row.image_url)
        .map(row => Number(row.view_id))
    );
    const viewsToGenerate = VIEWS.filter(view => !completedViewIds.has(Number(view.id)));

    if (viewsToGenerate.length === 0) {
      await updateItemStatus(itemId, 'done', 'All 4 views generated');
      return;
    }

    // Mark unfinished views as generating
    const providerLabel = provider.startsWith('stability')
      ? provider.includes('cheap') || provider.includes('mini')
        ? 'Stability AI (cheap/mini)'
        : 'Stability AI'
      : provider === 'gemini'
        ? 'Gemini'
        : provider.includes('cheap') || provider.includes('mini')
          ? 'OpenAI (cheap/mini)'
          : 'OpenAI';
    await updateItemStatus(itemId, 'active', `Generating 4 views with ${providerLabel}...`);
    await updateViewStatuses(itemId, viewsToGenerate.map(view => view.id), 'generating', null);

    // Generate unfinished views in parallel. Completed views are preserved for
    // retry flows so successful renders are not charged/regenerated again.
    const isStability = provider.startsWith('stability');
    const isGemini = provider === 'gemini';
    const isMiniGemini = provider === 'openai-mini';
    const generateFn = isStability
      ? generateStabilityView
      : isGemini
        ? generateGeminiView
        : isMiniGemini
          ? generateWithFallback
          : generateOpenAIView;
    const brand = item.brand || '';
    // Pass the provider string as options.provider so the generate function can
    // resolve the model (e.g., 'openai-cheap' → dall-e-2, 'stability-cheap' → sdxl-turbo)
    const genOptions = { provider };
    let results = await Promise.allSettled(
      viewsToGenerate.map(view => generateFn(view, desc, imageUrl, item.resolution || '1K', brand, genOptions))
    );

    // If Gemini failed due to quota or timeout, retry with OpenAI
    if (provider === 'gemini') {
      const geminiFailCount = results.filter(r => r.status === 'rejected').length;
      if (geminiFailCount > 0) {
        const shouldFallback = results.some(r =>
          r.status === 'rejected' &&
          /quota|rate.limi|resource.exhausted|too.many.request|timeout|abort/i.test(r.reason?.message || '')
        );
        if (shouldFallback) {
          console.log(`[WORKER] Gemini quota/timeout for item ${itemId} (${geminiFailCount} failed views), retrying with OpenAI...`);
          const fallbackResults = await Promise.allSettled(
            viewsToGenerate.map((view, i) => {
              if (results[i].status === 'fulfilled') return Promise.resolve(results[i].value);
              return generateOpenAIView(view, desc, imageUrl, item.resolution || '1K', brand, { provider: 'openai' });
            })
          );
          results = fallbackResults;
        }
      }
    }

    // Save results
    let successCount = completedViewIds.size;
    let failCount = 0;

    for (let i = 0; i < viewsToGenerate.length; i++) {
      const view = viewsToGenerate[i];
      const result = results[i];

      if (result.status === 'fulfilled' && result.value) {
        try {
          const generatedUrl = result.value.cdnUrl;
          if (!generatedUrl) {
            throw new Error('Generator returned no image URL');
          }

          const stored = await saveRenderImageToVps(generatedUrl, itemId, view, item.name);

          const { error: saveError } = await supabase
            .from(RESULTS_TABLE)
            .update({
              status: 'done',
              image_url: stored.publicUrl,
              error_message: '',
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('queue_item_id', itemId)
            .eq('view_id', view.id);

          if (saveError) throw saveError;
          successCount++;
        } catch (saveErr) {
          console.error(`[WORKER] Failed to save result for item ${itemId} view ${view.id}:`, saveErr);
          failCount++;
          await supabase
            .from(RESULTS_TABLE)
            .update({
              status: 'error',
              image_url: '',
              error_message: saveErr.message || 'Failed to save image URL',
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('queue_item_id', itemId)
            .eq('view_id', view.id);
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

    // Update queue item final status
    const finalStatus = successCount === 4 ? 'done' : 'error';
    const statusText = successCount === 4
      ? 'All 4 views generated'
      : `${successCount}/4 views generated`;
    await updateItemStatus(itemId, finalStatus, statusText);

    // Store the completed batch ZIP on the VPS and trigger Drive upload if all 4 views completed
    if (successCount === 4) {
      const { data: doneRows } = await supabase
        .from(RESULTS_TABLE)
        .select('*')
        .eq('queue_item_id', itemId)
        .eq('status', 'done');

      if (doneRows && doneRows.length === 4) {
        let zipUrl = '';
        try {
          const zipResult = await createRenderZipOnVps(itemId, item.name, doneRows.map(row => ({
            viewId: row.view_id,
            imageUrl: row.image_url
          })));
          zipUrl = zipResult.publicUrl;
          console.log(`[WORKER] Stored VPS ZIP for item ${itemId}: ${zipResult.publicUrl}`);
        } catch (zipErr) {
          console.warn(`[WORKER] Failed to store VPS ZIP for item ${itemId}:`, zipErr.message);
        }

        try {
          await saveCompletedBatch({
            id: itemId,
            name: item.name,
            imageUrl: item.image_url || '',
            status: finalStatus,
            provider,
            apiModel: provider === 'gemini'
              ? 'gemini-3.1-flash-image-preview / gemini-3-pro-image-preview'
              : provider === 'openai-mini'
                ? 'gpt-image-1-mini + Gemini Flash fallback'
                : process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1-mini',
            updatedAt: new Date().toISOString(),
            driveFolderId: item.drive_folder_id || '',
            driveFolderName: item.drive_folder_name || '',
            driveUploadStatus: item.drive_upload_status || '',
            driveUploadDone: item.drive_upload_done || 0,
            driveUploadTotal: item.drive_upload_total || 0,
            driveUploadError: item.drive_upload_error || '',
            zipUrl,
            viewResults: doneRows.map(row => ({
              viewId: row.view_id,
              status: row.status,
              imageUrl: row.image_url,
              errorMessage: row.error_message || null,
              completedAt: row.completed_at || null
            }))
          });
        } catch (storeErr) {
          console.warn(`[WORKER] Failed to save completed batch index for item ${itemId}:`, storeErr.message);
        }
      }

      // Fetch fresh item data for Drive upload (item object may be stale)
      const { data: freshItems } = await supabase
        .from(QUEUE_TABLE)
        .select('*')
        .eq('id', itemId)
        .single();
      await triggerDriveUpload(freshItems || item);
    }

  } catch (error) {
    console.error(`[WORKER] Error processing item ${itemId}:`, error);
    await updateItemStatus(itemId, 'error', error.message || 'Processing failed');
    await updateAllViewStatuses(itemId, 'error', error.message || 'Processing failed');
  }
}

/**
 * Upload completed renders to Google Drive.
 * Uses sequential counter for folder naming (e.g., "001_ProductName").
 */
async function triggerDriveUpload(item) {
  try {
    const hasDriveEnv = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!hasDriveEnv) return;

    // Fetch fresh drive state to avoid race conditions
    const { data: freshItem } = await supabase
      .from(QUEUE_TABLE)
      .select('drive_upload_status, drive_folder_id, drive_folder_name')
      .eq('id', item.id)
      .single();

    const driveStatus = freshItem?.drive_upload_status || item.drive_upload_status || '';
    const driveFolderId = freshItem?.drive_folder_id || item.drive_folder_id || '';
    const driveFolderName = freshItem?.drive_folder_name || item.drive_folder_name || '';

    // Check if upload is already in progress or completed
    if (driveStatus === 'uploading') return;

    // Only skip if upload was actually completed (has a folder ID from a previous upload).
    // drive_folder_name alone is NOT sufficient — it may be a user-specified folder name hint
    // from the agent flow, not an indicator that upload is done.
    const alreadyUploaded = !!(driveFolderId && driveFolderId !== '')
      || driveStatus === 'done';

    if (alreadyUploaded) return;

    // ── Try Supabase first, fall back to local storage on connection error ──
    let doneRows, supabaseFailed = false;
    try {
      const result = await supabase
        .from(RESULTS_TABLE)
        .select('*')
        .eq('queue_item_id', item.id)
        .eq('status', 'done');
      doneRows = result.data;
      if (result.error && isSupabaseConnectionError(result.error)) throw result.error;
    } catch (supaErr) {
      if (isSupabaseConnectionError(supaErr)) {
        console.log(`[WORKER] Supabase unreachable for item ${item.id}, falling back to local storage`);
        supabaseFailed = true;
      } else {
        throw supaErr;
      }
    }

    if (!supabaseFailed) {
      // Normal Supabase path
      if (!doneRows || doneRows.length !== 4) return;

      const doneViews = doneRows.map(row => ({
        viewId: row.view_id,
        viewLabel: getViewLabel(row.view_id),
        imageUrl: row.image_url
      }));

      // Use user-specified drive_folder_name if provided, otherwise generate from counter + item name
      let folderName;
      if (driveFolderName && driveFolderName.trim()) {
        // User specified a folder name (e.g., from agent flow) — use it directly
        folderName = driveFolderName.trim()
          .replace(/[^a-zA-Z0-9\s_-]/g, '')
          .replace(/\s+/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '')
          .substring(0, 60);
        // If the user-specified name is empty after sanitization, fall back to generated name
        if (!folderName) {
          const counter = await getNextFolderCounter();
          const safeName = (item.name || `Item_${item.id}`)
            .replace(/[^a-zA-Z0-9\s_-]/g, '')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 55);
          folderName = `${String(counter).padStart(3, '0')}_${safeName}`;
        }
      } else {
        const counter = await getNextFolderCounter();
        const safeName = (item.name || `Item_${item.id}`)
          .replace(/[^a-zA-Z0-9\s_-]/g, '')
          .replace(/\s+/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '')
          .substring(0, 55);
        folderName = `${String(counter).padStart(3, '0')}_${safeName}`;
      }

      await updateDriveUploadState(item.id, {
        drive_upload_status: 'uploading',
        drive_upload_done: 0,
        drive_upload_total: doneViews.length,
        drive_upload_error: '',
        updated_at: new Date().toISOString()
      });

      const driveResult = await uploadRendersToDrive(item.id, item.name, doneViews, {
        folderName,
        onProgress: progress => updateDriveUploadState(item.id, {
          drive_upload_status: progress.status,
          drive_upload_done: progress.uploaded,
          drive_upload_total: progress.total,
          drive_upload_error: progress.status === 'error' ? progress.message || 'Drive upload incomplete' : '',
          drive_folder_id: progress.folderId || item.drive_folder_id || '',
          drive_folder_name: progress.folderName || item.drive_folder_name || '',
          drive_folder_url: progress.folderUrl || item.drive_folder_url || '',
          updated_at: new Date().toISOString()
        })
      });

      await updateDriveUploadState(item.id, {
        drive_folder_id: driveResult.folderId,
        drive_folder_name: driveResult.folderName,
        drive_folder_url: driveResult.folderUrl || '',
        drive_upload_status: driveResult.files.length === doneViews.length ? 'done' : 'error',
        drive_upload_done: driveResult.files.length,
        drive_upload_total: doneViews.length,
        drive_upload_error: driveResult.files.length === doneViews.length ? '' : 'Some files failed to upload',
        updated_at: new Date().toISOString()
      });

      console.log(`[WORKER] SUCCESS: Uploaded item ${item.id} to Drive folder "${driveResult.folderName}" (URL: ${driveResult.folderUrl || 'N/A'})`);
    } else {
      // ── SUPABASE FALLBACK PATH: Use local completed-batches.json ──
      const { listCompletedBatches, saveCompletedBatch } = await import('./lib/completed-batches.js');
      const batches = await listCompletedBatches();
      const batch = batches.find(b => Number(b.id) === Number(item.id));

      if (!batch || !Array.isArray(batch.viewResults) || batch.viewResults.length < 4) {
        console.log(`[WORKER] Item ${item.id} not found in local batches or incomplete, skipping Drive upload fallback`);
        return;
      }

      const doneViews = batch.viewResults
        .filter(r => r.status === 'done' && r.imageUrl)
        .map(r => ({
          viewId: r.viewId,
          viewLabel: getViewLabel(r.viewId),
          imageUrl: r.imageUrl
        }));

      if (doneViews.length !== 4) {
        console.log(`[WORKER] Item ${item.id} has ${doneViews.length}/4 done views locally, skipping Drive upload fallback`);
        return;
      }

      // Use file-based counter fallback
      const counter = await getNextFolderCounterFallback();
      const safeName = (item.name || batch.name || `Item_${item.id}`)
        .replace(/[^a-zA-Z0-9\s_-]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 55);
      const folderName = `${String(counter).padStart(3, '0')}_${safeName}`;

      console.log(`[WORKER] Drive upload fallback: uploading ${doneViews.length} views for item ${item.id} to "${folderName}"`);

      const driveResult = await uploadRendersToDrive(item.id, item.name || batch.name, doneViews, {
        folderName,
        onProgress: progress => {
          console.log(`[WORKER] Drive fallback progress: ${progress.status} ${progress.uploaded}/${progress.total}`);
        }
      });

      // Store result in local completed-batches.json
      const success = driveResult.files.length === doneViews.length;
      await saveCompletedBatch({
        id: item.id,
        name: item.name || batch.name || `Item ${item.id}`,
        status: 'done',
        provider: batch.provider || '',
        apiModel: batch.apiModel || '',
        driveFolderId: driveResult.folderId,
        driveFolderName: driveResult.folderName,
        driveFolderUrl: driveResult.folderUrl || '',
        driveUploadStatus: success ? 'done' : 'error',
        driveUploadDone: driveResult.files.length,
        driveUploadTotal: doneViews.length,
        driveUploadError: success ? '' : 'Some files failed to upload',
        viewResults: batch.viewResults
      });

      console.log(`[WORKER] SUCCESS (fallback): Uploaded item ${item.id} to Drive folder "${driveResult.folderName}" (URL: ${driveResult.folderUrl || 'N/A'})`);
    }
  } catch (driveErr) {
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

  await updateQueueItemFields(itemId, updateData);
}

async function updateQueueItemFields(itemId, fields) {
  let updateData = { ...fields };
  const strippedColumns = [];

  for (let attempt = 0; attempt < 8; attempt++) {
    if (Object.keys(updateData).length === 0) return;

    const { error } = await supabase
      .from(QUEUE_TABLE)
      .update(updateData)
      .eq('id', itemId);

    if (!error) {
      if (strippedColumns.length > 0) {
        console.warn(`[WORKER] Updated item ${itemId} without optional columns missing from product_queue: ${strippedColumns.join(', ')}`);
      }
      return;
    }

    const missingColumn = getMissingSchemaColumn(error);
    if (!isMissingColumnError(error) || !missingColumn || !(missingColumn in updateData)) {
      console.error(`[WORKER] Failed to update item ${itemId} status:`, error.message);
      return;
    }

    strippedColumns.push(missingColumn);
    delete updateData[missingColumn];
  }

  console.error(`[WORKER] Failed to update item ${itemId}: too many missing schema columns`);
}

function getMissingSchemaColumn(error) {
  const message = String(error?.message || '');
  const quoted = message.match(/'([^']+)' column/i);
  if (quoted) return quoted[1];
  const plain = message.match(/column\s+([a-zA-Z0-9_]+)\s+does not exist/i);
  if (plain) return plain[1];

  for (const column of [
    'sub_text',
    'provider',
    'resolution',
    'drive_folder_name',
    'drive_folder_id',
    'drive_folder_url',
    'drive_upload_status',
    'drive_upload_done',
    'drive_upload_total',
    'drive_upload_error'
  ]) {
    if (message.includes(column)) return column;
  }

  return '';
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

  if (error) {
    console.error(`[WORKER] Failed to update view statuses for item ${itemId}:`, error.message);
  }
}

async function updateViewStatuses(itemId, viewIds, status, errorMessage) {
  if (!Array.isArray(viewIds) || viewIds.length === 0) return;

  const now = new Date().toISOString();
  const updateData = { status, updated_at: now };
  if (errorMessage) updateData.error_message = errorMessage;
  if (status === 'generating') updateData.started_at = now;
  if (status === 'done' || status === 'error') updateData.completed_at = now;

  const { error } = await supabase
    .from(RESULTS_TABLE)
    .update(updateData)
    .eq('queue_item_id', itemId)
    .in('view_id', viewIds);

  if (error) {
    console.error(`[WORKER] Failed to update view statuses for item ${itemId}:`, error.message);
  }
}

async function updateDriveUploadState(itemId, fields) {
  const { error } = await supabase
    .from(QUEUE_TABLE)
    .update(fields)
    .eq('id', itemId);

  if (!error || !isMissingColumnError(error)) return;

  // Strip all drive_* columns that might not exist in older schemas
  const {
    drive_upload_status,
    drive_upload_done,
    drive_upload_total,
    drive_upload_error,
    drive_folder_id,
    drive_folder_name,
    drive_folder_url,
    ...safeFields
  } = fields;

  await supabase
    .from(QUEUE_TABLE)
    .update(safeFields)
    .eq('id', itemId);
}

function isMissingColumnError(error) {
  return error?.code === 'PGRST204'
    || /column .* does not exist/i.test(error?.message || '')
    || /Could not find .* column/i.test(error?.message || '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════
//  Start Server
// ═══════════════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Product Image Studio running on port ${PORT}`);
  console.log(`[SERVER] Environment: SUPABASE_URL=${process.env.SUPABASE_URL ? '✓ set' : '✗ missing'}`);
  console.log(`[SERVER] Environment: SUPABASE_SERVICE_ROLE_KEY=${process.env.SUPABASE_SERVICE_ROLE_KEY ? '✓ set' : '✗ missing'}`);
  console.log(`[SERVER] Environment: OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? '✓ set' : '✗ missing'}`);
  console.log(`[SERVER] Environment: GEMINI_API_KEY=${process.env.GEMINI_API_KEY ? '✓ set' : '✗ missing'}`);
  console.log(`[SERVER] Environment: DEEPSEEK_API_KEY=${process.env.DEEPSEEK_API_KEY ? '✓ set' : '✗ missing'}`);
  console.log(`[SERVER] Environment: GOOGLE_SERVICE_ACCOUNT_JSON=${process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? '✓ set' : '✗ missing (optional)'}`);

  // Start background worker
  workerLoop().catch(err => {
    console.error('[SERVER] Worker loop crashed:', err);
    process.exit(1);
  });
});
