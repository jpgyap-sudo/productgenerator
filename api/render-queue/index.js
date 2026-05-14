// ═══════════════════════════════════════════════════════════════════
//  Render Queue API Routes — Express router
//
//  Base path: /api/render-queue
//
//  Provides endpoints for managing the permanent cloud render queue.
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import {
  listQueueBatches,
  createQueueBatchFromCanvas,
  pauseBatch,
  resumeBatch,
  cancelBatch,
  pauseAll,
  resumeAll,
  cancelAllQueued,
  cleanupCompleted,
  moveNeedsRepairToCompletedReview,
  retryFailedItems,
  getBatchItems,
  cancelQueueItem
} from '../../lib/render-queue.service.js';

const router = express.Router();

/**
 * GET /api/render-queue/batches
 * List queue batches with optional filtering.
 * Query: limit, offset, status, search
 */
router.get('/batches', async (req, res) => {
  try {
    const result = await listQueueBatches(req.query);
    res.json(result);
  } catch (err) {
    console.error('[RENDER-QUEUE] listQueueBatches error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/render-queue/from-image-canvas
 * Create a permanent render queue batch from saved Image Canvas records.
 * Body: { batchName, category, matchedImageIds, priority }
 */
router.post('/from-image-canvas', async (req, res) => {
  try {
    const result = await createQueueBatchFromCanvas(req.body);
    res.json(result);
  } catch (err) {
    console.error('[RENDER-QUEUE] createQueueBatchFromCanvas error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/render-queue/batches/:batchId/pause
 */
router.post('/batches/:batchId/pause', async (req, res) => {
  try {
    const result = await pauseBatch(req.params.batchId);
    res.json(result);
  } catch (err) {
    console.error('[RENDER-QUEUE] pauseBatch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/render-queue/batches/:batchId/resume
 */
router.post('/batches/:batchId/resume', async (req, res) => {
  try {
    const result = await resumeBatch(req.params.batchId);
    res.json(result);
  } catch (err) {
    console.error('[RENDER-QUEUE] resumeBatch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/render-queue/batches/:batchId/cancel
 */
router.post('/batches/:batchId/cancel', async (req, res) => {
  try {
    const result = await cancelBatch(req.params.batchId);
    res.json(result);
  } catch (err) {
    console.error('[RENDER-QUEUE] cancelBatch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/render-queue/batches/:batchId/move-to-completed-repair-review
 */
router.post('/batches/:batchId/move-to-completed-repair-review', async (req, res) => {
  try {
    const result = await moveNeedsRepairToCompletedReview(req.params.batchId);
    res.json(result);
  } catch (err) {
    console.error('[RENDER-QUEUE] moveNeedsRepairToCompletedReview error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/render-queue/pause-all
 */
router.post('/pause-all', async (req, res) => {
  try {
    const result = await pauseAll();
    res.json(result);
  } catch (err) {
    console.error('[RENDER-QUEUE] pauseAll error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/render-queue/resume-all
 */
router.post('/resume-all', async (req, res) => {
  try {
    const result = await resumeAll();
    res.json(result);
  } catch (err) {
    console.error('[RENDER-QUEUE] resumeAll error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/render-queue/cancel-all-queued
 */
router.post('/cancel-all-queued', async (req, res) => {
  try {
    const result = await cancelAllQueued();
    res.json(result);
  } catch (err) {
    console.error('[RENDER-QUEUE] cancelAllQueued error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/render-queue/cleanup-completed
 */
router.post('/cleanup-completed', async (req, res) => {
  try {
    const result = await cleanupCompleted();
    res.json(result);
  } catch (err) {
    console.error('[RENDER-QUEUE] cleanupCompleted error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/render-queue/batches/:batchId/items
 * Fetch all items for a specific batch.
 */
router.get('/batches/:batchId/items', async (req, res) => {
  try {
    const items = await getBatchItems(req.params.batchId);
    res.json({ success: true, items });
  } catch (err) {
    console.error('[RENDER-QUEUE] getBatchItems error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/render-queue/batches/:batchId/retry-failed
 * Retry all failed items in a batch.
 */
router.post('/batches/:batchId/retry-failed', async (req, res) => {
  try {
    const result = await retryFailedItems(req.params.batchId);
    res.json(result);
  } catch (err) {
    console.error('[RENDER-QUEUE] retryFailedItems error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/render-queue/items/:itemId/cancel
 * Cancel a single queued/paused item.
 */
router.post('/items/:itemId/cancel', async (req, res) => {
  try {
    const result = await cancelQueueItem(req.params.itemId);
    res.json(result);
  } catch (err) {
    console.error('[RENDER-QUEUE] cancelQueueItem error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
