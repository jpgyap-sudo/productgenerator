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
/**
 * Check which matched_image_ids already have completed render items.
 * Returns details of already-rendered items grouped by matched_image_id.
 * @param {number[]} matchedImageIds
 * @returns {Promise<{alreadyRendered: Array, hasDuplicates: boolean}>}
 */
export async function checkAlreadyRendered(matchedImageIds) {
  if (!matchedImageIds || !matchedImageIds.length) {
    return { alreadyRendered: [], hasDuplicates: false };
  }

  const { data, error } = await supabase
    .from(RENDER_QUEUE_ITEMS_TABLE)
    .select(`
      id,
      matched_image_id,
      product_code,
      product_name,
      render_type,
      render_label,
      status,
      rendered_image_url,
      batch_id
    `)
    .in('matched_image_id', matchedImageIds)
    .eq('status', 'completed');

  if (error) throw error;

  const alreadyRendered = data || [];
  return {
    alreadyRendered,
    hasDuplicates: alreadyRendered.length > 0
  };
}

export async function createQueueBatchFromCanvas(payload) {
  const matchedImageIds = payload.matchedImageIds || [];
  const force = payload.force === true;

  if (!matchedImageIds.length) {
    throw new Error('matchedImageIds is required');
  }

  // ── Double-render protection ────────────────────────────────────
  // Check if any of these matched images already have completed items.
  // If so, return a warning unless `force: true` is set.
  if (!force) {
    const { alreadyRendered, hasDuplicates } = await checkAlreadyRendered(matchedImageIds);
    if (hasDuplicates) {
      // Group by matched_image_id for a cleaner response
      const grouped = {};
      for (const item of alreadyRendered) {
        const mid = item.matched_image_id;
        if (!grouped[mid]) grouped[mid] = [];
        grouped[mid].push(item);
      }

      return {
        success: false,
        requiresConfirmation: true,
        message: `${alreadyRendered.length} item(s) have already been rendered. Submit again with "force: true" to proceed anyway.`,
        alreadyRenderedCount: alreadyRendered.length,
        alreadyRendered,
        groupedByMatchedImage: grouped,
        affectedMatchedImageIds: [...new Set(alreadyRendered.map(i => i.matched_image_id))]
      };
    }
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

/**
 * Retry all failed items in a batch — re-enqueues them to BullMQ.
 * @param {string} batchId
 * @returns {Promise<{success: boolean, batchId: string, retriedCount: number}>}
 */
export async function retryFailedItems(batchId) {
  // Fetch failed items for this batch
  const { data: failedItems, error: fetchError } = await supabase
    .from(RENDER_QUEUE_ITEMS_TABLE)
    .select('*')
    .eq('batch_id', batchId)
    .eq('status', 'failed');

  if (fetchError) throw fetchError;
  if (!failedItems || failedItems.length === 0) {
    return { success: true, batchId, retriedCount: 0, message: 'No failed items to retry' };
  }

  // Reset their status to 'queued'
  const ids = failedItems.map(i => i.id);
  const { error: updateError } = await supabase
    .from(RENDER_QUEUE_ITEMS_TABLE)
    .update({ status: 'queued', error_message: null, updated_at: new Date().toISOString() })
    .in('id', ids);

  if (updateError) throw updateError;

  // Re-enqueue to BullMQ
  await enqueueRenderImageJobsForBatch(batchId, failedItems);

  // Update batch status back to queued if it was completed/failed
  await supabase
    .from(RENDER_QUEUE_BATCHES_TABLE)
    .update({ status: 'queued', updated_at: new Date().toISOString() })
    .eq('id', batchId)
    .in('status', ['completed', 'failed']);

  return { success: true, batchId, retriedCount: failedItems.length };
}

/**
 * Fetch items for a specific batch.
 * @param {string} batchId
 * @returns {Promise<Array>}
 */
export async function getBatchItems(batchId) {
  const { data, error } = await supabase
    .from(RENDER_QUEUE_ITEMS_TABLE)
    .select('*')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

/**
 * Cancel a single queue item by setting its status to 'cancelled'.
 * @param {string} itemId
 * @returns {Promise<{success: boolean, itemId: string}>}
 */
export async function cancelQueueItem(itemId) {
  const { error } = await supabase
    .from(RENDER_QUEUE_ITEMS_TABLE)
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', itemId)
    .in('status', ['queued', 'paused']);

  if (error) throw error;
  return { success: true, itemId };
}
