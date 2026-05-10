// ═══════════════════════════════════════════════════════════════════
//  api/agent/batch-status.js — GET /api/agent/batch-status/:batchId
//  Returns the current state of a batch job for UI polling.
//
//  Response:
//    {
//      success: true,
//      batchId: "...",
//      status: "queued|extracting_pdf|fingerprinting_zip|...",
//      stage: "...",
//      progress_percent: 45,
//      total_products: 88,
//      completed_products: 40,
//      total_images: 57,
//      estimated_seconds_remaining: 120,
//      last_error: null,
//      activity_log: [...]
//    }
// ═══════════════════════════════════════════════════════════════════

import { getBatchState } from '../../lib/batch-queue.js';

/**
 * GET /api/agent/batch-status/:batchId
 */
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const batchId = req.query?.batchId || req.params?.batchId || req.url?.split('/').pop();

    if (!batchId) {
      return res.status(400).json({ error: 'batchId parameter is required' });
    }

    console.log(`[BATCH-STATUS] Fetching state for batch: ${batchId}`);

    const state = await getBatchState(batchId);

    if (!state) {
      return res.status(404).json({ error: 'Batch not found', batchId });
    }

    return res.json({
      success: true,
      batchId: state.id,
      status: state.status,
      stage: state.stage,
      progress_percent: state.progress_percent || 0,
      total_products: state.total_products || 0,
      completed_products: state.completed_products || 0,
      total_images: state.total_images || 0,
      estimated_seconds_remaining: state.estimated_seconds_remaining || null,
      last_error: state.last_error || null,
      activity_log: state.activity_log || []
    });

  } catch (err) {
    console.error('[BATCH-STATUS] Error:', err.message);
    return res.status(500).json({
      error: 'Failed to fetch batch status',
      details: err.message
    });
  }
}
