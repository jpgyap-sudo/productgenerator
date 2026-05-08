// ═══════════════════════════════════════════════════════════════════
//  Render Queue Service — Batch CRUD + Image Canvas import
//
//  Manages permanent cloud render queue batches and items.
//  All queue data is persisted in Supabase — never in browser memory.
// ═══════════════════════════════════════════════════════════════════

import { supabase, MATCHED_IMAGES_TABLE, RENDER_QUEUE_BATCHES_TABLE, RENDER_QUEUE_ITEMS_TABLE } from './supabase.js';
import { enqueueRenderImageJobsForBatch } from './render-worker.service.js';

const FOUR_RENDER_TYPES = [
  { key: 'front', label: 'Img 1 — Front view' },
  { key: 'side', label: 'Img 2 — Side view' },
  { key: 'isometric', label: 'Img 3 — Isometric view' },
  { key: 'interior', label: 'Img 4 — Interior scene' }
];

/**
 * List queue batches with optional filtering and pagination.
 * @param {object} query - { limit, offset, status, search }
 */
export async function listQueueBatches(query = {}) {
  const limit = Number(query.limit || 20);
  const offset = Number(query.offset || 0);
  const status = query.status || 'all';
  const search = (query.search || '').trim().toLowerCase();

  let request = supabase
    .from(RENDER_QUEUE_BATCHES_TABLE)
    .select(`
      *,
      render_queue_items (*)
    `)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (status !== 'all') {
    request = request.eq('status', status);
  }

  const { data, error } = await request;

  if (error) throw error;

  let batches = data || [];

  // Client-side search filter
  if (search) {
    batches = batches.filter(b =>
      [b.id, b.name, b.category, b.source].join(' ').toLowerCase().includes(search)
    );
  }

  return {
    success: true,
    limit,
    offset,
    batches
  };
}

/**
 * Create a permanent render queue batch from saved Image Canvas records.
 *
 * Body example:
 * {
 *   "batchName": "Dining Chairs Batch",
 *   "category": "Dining Chairs",
 *   "matchedImageIds": [1, 2, 3],
 *   "priority": "high"
 * }
 */
export async function createQueueBatchFromCanvas(payload) {
  const matchedImageIds = payload.matchedImageIds || [];
  if (!matchedImageIds.length) {
    throw new Error('matchedImageIds is required');
  }

  const batchId = `BATCH-${Date.now()}`;

  const { data: matchedImages, error: fetchError } = await supabase
    .from(MATCHED_IMAGES_TABLE)
    .select('*')
    .in('id', matchedImageIds);

  if (fetchError) throw fetchError;
  if (!matchedImages || matchedImages.length === 0) {
    throw new Error('No matched images found for the given IDs');
  }

  const totalItems = matchedImages.length * 4;

  const { error: batchError } = await supabase
    .from(RENDER_QUEUE_BATCHES_TABLE)
    .insert({
      id: batchId,
      name: payload.batchName || batchId,
      category: payload.category || 'Dining Chairs',
      source: 'Image Canvas',
      status: 'queued',
      priority: payload.priority || 'medium',
      product_count: matchedImages.length,
      total_images: totalItems,
      completed_images: 0,
      failed_images: 0,
      needs_repair_images: 0,
      auto_delete_days: 7,
      created_at: new Date().toISOString()
    });

  if (batchError) throw batchError;

  const rows = [];

  for (const image of matchedImages) {
    for (const renderType of FOUR_RENDER_TYPES) {
      rows.push({
        batch_id: batchId,
        matched_image_id: image.id,
        product_code: image.product_code || '',
        product_name: image.product_name || '',
        product_brand: image.product_brand || '',
        source_image_url: image.image_url || image.image_data_url || '',
        render_type: renderType.key,
        render_label: renderType.label,
        status: 'queued',
        priority: payload.priority || 'medium',
        created_at: new Date().toISOString()
      });
    }
  }

  const { data: insertedItems, error: itemError } = await supabase
    .from(RENDER_QUEUE_ITEMS_TABLE)
    .insert(rows)
    .select();

  if (itemError) throw itemError;

  // Enqueue all items to BullMQ for cloud processing
  await enqueueRenderImageJobsForBatch(batchId, insertedItems);

  return {
    success: true,
    batchId,
    totalProducts: matchedImages.length,
    totalImages: totalItems,
    message: 'Permanent cloud render queue created. Rendering will continue even if the website is closed.'
  };
}

/**
 * Pause a single batch — stops worker from picking up new items.
 */
export async function pauseBatch(batchId) {
  return updateBatchStatus(batchId, 'paused');
}

/**
 * Resume a paused batch — allows worker to continue processing.
 */
export async function resumeBatch(batchId) {
  await updateBatchStatus(batchId, 'queued');
  return { success: true, batchId, status: 'queued' };
}

/**
 * Cancel a batch — marks queued/paused items as cancelled.
 */
export async function cancelBatch(batchId) {
  await updateBatchStatus(batchId, 'cancelled');

  await supabase
    .from(RENDER_QUEUE_ITEMS_TABLE)
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('batch_id', batchId)
    .in('status', ['queued', 'paused']);

  return { success: true, batchId, status: 'cancelled' };
}

async function updateBatchStatus(batchId, status) {
  const { error } = await supabase
    .from(RENDER_QUEUE_BATCHES_TABLE)
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', batchId);

  if (error) throw error;

  return { success: true, batchId, status };
}

/**
 * Pause all active batches.
 */
export async function pauseAll() {
  const { error } = await supabase
    .from(RENDER_QUEUE_BATCHES_TABLE)
    .update({ status: 'paused', updated_at: new Date().toISOString() })
    .in('status', ['queued', 'rendering']);

  if (error) throw error;
  return { success: true };
}

/**
 * Resume all paused batches.
 */
export async function resumeAll() {
  const { error } = await supabase
    .from(RENDER_QUEUE_BATCHES_TABLE)
    .update({ status: 'queued', updated_at: new Date().toISOString() })
    .eq('status', 'paused');

  if (error) throw error;
  return { success: true };
}

/**
 * Cancel all queued/paused batches.
 */
export async function cancelAllQueued() {
  const { error } = await supabase
    .from(RENDER_QUEUE_BATCHES_TABLE)
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .in('status', ['queued', 'paused']);

  if (error) throw error;
  return { success: true };
}

/**
 * Delete completed batches older than 7 days.
 */
export async function cleanupCompleted() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);

  const { error } = await supabase
    .from(RENDER_QUEUE_BATCHES_TABLE)
    .delete()
    .eq('status', 'completed')
    .lt('completed_at', cutoff.toISOString());

  if (error) throw error;

  return {
    success: true,
    deletedOlderThan: cutoff.toISOString()
  };
}

/**
 * Move a needs-repair batch to Completed Renders review flow.
 */
export async function moveNeedsRepairToCompletedReview(batchId) {
  const { error } = await supabase
    .from(RENDER_QUEUE_BATCHES_TABLE)
    .update({
      status: 'needs_repair',
      repair_review_location: '/render/completed',
      updated_at: new Date().toISOString()
    })
    .eq('id', batchId);

  if (error) throw error;

  return {
    success: true,
    batchId,
    message: 'Needs Repair items should be reviewed in Completed Renders before/after Gemini repair preview.'
  };
}
