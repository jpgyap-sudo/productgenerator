#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  Render Queue Worker — BullMQ job processor
//
//  Standalone PM2 process that processes render jobs from BullMQ.
//  Uses the existing render-router pipeline (GPT → QA → Fix/Fallback).
//
//  Run as:
//    node workers/render-queue.worker.js
//  Or via PM2:
//    pm2 start workers/render-queue.worker.js --name render-queue-worker
// ═══════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import cron from 'node-cron';

// ── Redis Connection ──
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

// ── Supabase Client ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false }
  }
);

// ── Import render pipeline ──
import { renderSingleView } from '../lib/render-router.js';
import { VIEWS } from '../lib/prompts.js';

// ── Temp directory for render downloads ──
const RENDER_TEMP_DIR = path.join(process.cwd(), 'public', 'renders');
function ensureTempDir() {
  fs.mkdirSync(RENDER_TEMP_DIR, { recursive: true });
}
ensureTempDir();

/**
 * Download a URL to a local temp file for QA processing.
 */
async function downloadUrlToFile(url, outputPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download from ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
}

/**
 * Process a single render job using the existing render-router pipeline.
 * Downloads the source image, runs renderSingleView, returns result.
 */
async function renderWithAI(jobData) {
  const tempImagePath = path.join(RENDER_TEMP_DIR, `${nanoid(8)}-source.png`);

  try {
    // Download source image from matched_images URL
    await downloadUrlToFile(jobData.sourceImageUrl, tempImagePath);

    // Use renderSingleView from the existing render-router pipeline
    // This runs: GPT main render → QA → Gemini fix/fallback
    const result = await renderSingleView({
      originalImagePath: tempImagePath,
      originalImageUrl: jobData.sourceImageUrl,
      productName: jobData.productName || '',
      brand: jobData.productBrand || '',
      mode: 'balanced',
      view: jobData.renderType
    });

    return {
      imageUrl: result.imageUrl || '',
      modelUsed: result.aiModel || 'gpt-image-1-mini',
      estimatedCost: 0.012,
      actualCost: 0.012,
      durationSeconds: result.durationSeconds || 0,
      consistencyScore: result.qaScore || 85,
      promptUsed: result.promptUsed || '',
      status: result.status || 'completed',
      qaDecision: result.qaDecision || 'pass',
      qaNotes: result.qaNotes || []
    };
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tempImagePath); } catch { /* ignore */ }
  }
}

/**
 * Update batch counters after each item completes.
 */
async function updateBatchCounters(batchId) {
  const { data: items, error } = await supabase
    .from('render_queue_items')
    .select('status')
    .eq('batch_id', batchId);

  if (error) throw error;

  const total = items.length;
  const completed = items.filter(i => i.status === 'completed').length;
  const failed = items.filter(i => i.status === 'failed').length;
  const needsRepair = items.filter(i => i.status === 'needs_repair').length;
  const rendering = items.filter(i => i.status === 'rendering').length;

  let batchStatus = 'queued';
  if (rendering > 0) batchStatus = 'rendering';
  if (completed + failed + needsRepair === total) {
    batchStatus = needsRepair > 0 ? 'needs_repair' : failed > 0 ? 'failed' : 'completed';
  }

  const updatePayload = {
    status: batchStatus,
    completed_images: completed,
    failed_images: failed,
    needs_repair_images: needsRepair,
    updated_at: new Date().toISOString()
  };

  if (batchStatus === 'completed' || batchStatus === 'needs_repair' || batchStatus === 'failed') {
    updatePayload.completed_at = new Date().toISOString();
    const autoDeleteAt = new Date();
    autoDeleteAt.setDate(autoDeleteAt.getDate() + 7);
    updatePayload.auto_delete_at = autoDeleteAt.toISOString();
  }

  await supabase
    .from('render_queue_batches')
    .update(updatePayload)
    .eq('id', batchId);
}

/**
 * Insert a completed render record for the Completed Renders page.
 */
async function insertCompletedRenderRecord(data, result, status, failureReason) {
  await supabase
    .from('render_images')
    .upsert({
      id: `render-${data.queueItemId}`,
      batch_id: data.batchId,
      render_group_id: `group-${data.matchedImageId}`,
      label: data.renderLabel,
      render_type: data.renderType,
      status,
      image_url: result.imageUrl,
      original_image_url: data.sourceImageUrl,
      file_name: `${data.productCode}_${data.renderType}.jpg`,
      ai_model: result.modelUsed,
      estimated_cost: result.estimatedCost,
      actual_cost: result.actualCost,
      duration_seconds: result.durationSeconds,
      consistency_score: result.consistencyScore,
      failure_reason: failureReason,
      prompt_used: result.promptUsed,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
}

// ── BullMQ Worker ──
export const worker = new Worker(
  'product-render-queue',
  async (job) => {
    const data = job.data;

    console.log(`[RENDER-WORKER] Processing job ${job.id}: ${data.renderType} for batch ${data.batchId}`);

    // Mark item as rendering
    await supabase
      .from('render_queue_items')
      .update({
        status: 'rendering',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', data.queueItemId);

    // Mark batch as rendering
    await supabase
      .from('render_queue_batches')
      .update({
        status: 'rendering',
        updated_at: new Date().toISOString()
      })
      .eq('id', data.batchId);

    try {
      const result = await renderWithAI(data);

      // Determine status based on QA score
      const status = result.consistencyScore < 80 ? 'needs_repair' : 'completed';
      const failureReason = status === 'needs_repair'
        ? 'Low consistency score. Review before/after in Completed Renders.'
        : '';

      // Update item record
      await supabase
        .from('render_queue_items')
        .update({
          status,
          rendered_image_url: result.imageUrl,
          ai_model: result.modelUsed,
          estimated_cost: result.estimatedCost,
          actual_cost: result.actualCost,
          duration_seconds: result.durationSeconds,
          consistency_score: result.consistencyScore,
          prompt_used: result.promptUsed,
          failure_reason: failureReason,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', data.queueItemId);

      // Insert completed render record
      await insertCompletedRenderRecord(data, result, status, failureReason);

      // Update batch counters
      await updateBatchCounters(data.batchId);

      console.log(`[RENDER-WORKER] Job ${job.id} complete: ${status} (score: ${result.consistencyScore})`);
      return result;
    } catch (error) {
      console.error(`[RENDER-WORKER] Job ${job.id} failed:`, error.message);

      await supabase
        .from('render_queue_items')
        .update({
          status: 'failed',
          error_message: error.message,
          updated_at: new Date().toISOString()
        })
        .eq('id', data.queueItemId);

      await updateBatchCounters(data.batchId);
      throw error;
    }
  },
  {
    connection,
    concurrency: Number(process.env.RENDER_WORKER_CONCURRENCY || 2)
  }
);

worker.on('completed', (job) => {
  console.log(`[RENDER-WORKER] Job completed: ${job.id}`);
});

worker.on('failed', (job, err) => {
  console.error(`[RENDER-WORKER] Job failed: ${job?.id}`, err.message);
});

// ── Cron: Queue Cleanup (daily at 3:15 AM) ──
cron.schedule('15 3 * * *', async () => {
  console.log('[QUEUE-CLEANUP] Running daily cleanup...');
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('render_queue_batches')
    .delete()
    .in('status', ['completed', 'failed', 'needs_repair', 'cancelled'])
    .lt('auto_delete_at', now)
    .select('id');

  if (error) {
    console.error('[QUEUE-CLEANUP] Failed:', error);
    return;
  }

  console.log(`[QUEUE-CLEANUP] Deleted ${data?.length || 0} old batches.`);
});

console.log('[RENDER-WORKER] Worker started. Waiting for jobs...');
console.log(`[RENDER-WORKER] Concurrency: ${process.env.RENDER_WORKER_CONCURRENCY || 2}`);
console.log(`[RENDER-WORKER] Redis: ${REDIS_URL}`);
