// ═══════════════════════════════════════════════════════════════════
//  api/agent/batch-status.js — GET /api/agent/batch-status/:batchId
//  Returns the current state of a batch job for UI polling.
//
//  Response (processing):
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
//
//  Response (completed):
//    Same fields + matches[] array with final results
// ═══════════════════════════════════════════════════════════════════

import { getBatchState } from '../../lib/batch-queue.js';
import { supabase, PRODUCT_MATCHES_TABLE } from '../../lib/supabase.js';

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

    const isComplete = state.status === 'completed' || state.status === 'partial' || state.status === 'failed';

    // Build response
    const response = {
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
    };

    // If batch is complete, also fetch match results from product_matches table
    if (isComplete) {
      const { data: matches, error: matchError } = await supabase
        .from(PRODUCT_MATCHES_TABLE)
        .select('*')
        .eq('batch_id', batchId)
        .order('id', { ascending: true });

      if (!matchError && matches) {
        response.matches = matches.map(m => {
          let topCandidates = [];
          if (m.top_candidates) {
            try {
              topCandidates = typeof m.top_candidates === 'string'
                ? JSON.parse(m.top_candidates)
                : m.top_candidates;
            } catch { /* ignore parse errors */ }
          }
          return {
            productIndex: m.id,
            product: {
              productCode: m.product_code,
              name: m.product_name,
              description: m.product_description
            },
            bestMatch: m.selected_image_name ? {
              imageIndex: m.selected_image_id !== null ? parseInt(m.selected_image_id, 10) : -1,
              imageName: m.selected_image_name,
              confidence: m.confidence || 0,
              reason: m.reason || '',
              status: m.status
            } : null,
            status: m.status,
            reason: m.reason || '',
            allResults: topCandidates
          };
        });

        // Compute stats
        const autoAccepted = matches.filter(m => m.status === 'auto_accepted').length;
        const needsReview = matches.filter(m => m.status === 'needs_review' || m.status === 'review').length;
        const rejected = matches.filter(m => m.status === 'rejected').length;
        response.matchStats = { autoAccepted, needsReview, rejected, retryNeeded: 0 };
      }
    }

    return res.json(response);

  } catch (err) {
    console.error('[BATCH-STATUS] Error:', err.message);
    return res.status(500).json({
      error: 'Failed to fetch batch status',
      details: err.message
    });
  }
}
