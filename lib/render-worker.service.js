// ═══════════════════════════════════════════════════════════════════
//  Render Worker Service — BullMQ queue management
//
//  Manages the BullMQ "product-render-queue" for cloud-based
//  render processing. Jobs are picked up by the render worker
//  process running on the VPS.
// ═══════════════════════════════════════════════════════════════════

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

export const renderQueue = new Queue('product-render-queue', { connection });

/**
 * Enqueue all render jobs for a batch into BullMQ.
 * Each item becomes a "render-single-image" job.
 *
 * @param {string} batchId - The batch ID
 * @param {Array} items - Array of render_queue_items from Supabase
 * @returns {Promise<{success: boolean, count: number}>}
 */
export async function enqueueRenderImageJobsForBatch(batchId, items) {
  const jobs = items.map((item) => ({
    name: 'render-single-image',
    data: {
      batchId,
      queueItemId: item.id,
      matchedImageId: item.matched_image_id,
      renderType: item.render_type,
      renderLabel: item.render_label,
      sourceImageUrl: item.source_image_url,
      productCode: item.product_code,
      productName: item.product_name,
      productBrand: item.product_brand
    },
    opts: {
      attempts: 2,
      backoff: {
        type: 'exponential',
        delay: 15000
      },
      removeOnComplete: 5000,
      removeOnFail: false
    }
  }));

  await renderQueue.addBulk(jobs);
  return { success: true, count: jobs.length };
}
