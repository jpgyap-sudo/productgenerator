// ═══════════════════════════════════════════════════════════════════
//  api/agent/matched-images.js — GET /api/agent/matched-images
//  Returns the history of saved matched product-image pairs.
//
//  Query params:
//    limit   - max results (default 50)
//    offset  - pagination offset (default 0)
//    search  - optional text search on product_name or product_code
//
//  Response:
//    {
//      success: true,
//      images: [...],
//      total: 50
//    }
// ═══════════════════════════════════════════════════════════════════

import { supabase, MATCHED_IMAGES_TABLE } from '../../lib/supabase.js';

/**
 * GET /api/agent/matched-images
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
    const limit = Math.min(parseInt(req.query?.limit || '50', 10), 200);
    const offset = parseInt(req.query?.offset || '0', 10);
    const search = req.query?.search || '';

    console.log(`[MATCHED-IMAGES] Fetching history (limit: ${limit}, offset: ${offset}, search: ${search || 'none'})`);

    let query = supabase
      .from(MATCHED_IMAGES_TABLE)
      .select('*', { count: 'exact' });

    // Apply text search if provided
    if (search) {
      query = query.or(`product_name.ilike.%${search}%,product_code.ilike.%${search}%,product_brand.ilike.%${search}%`);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('[MATCHED-IMAGES] Query error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch matched images', details: error.message });
    }

    // Enrich each matched image with render completion status
    const enrichedImages = [];
    for (const img of data || []) {
      let hasCompletedRender = false;
      let completedRenderUrl = '';
      let queueStatus = '';

      // If linked to a queue item, check its render status
      if (img.queue_item_id) {
        try {
          // Check product_queue for this item's status
          const { data: queueData } = await supabase
            .from('product_queue')
            .select('status, image_url')
            .eq('id', img.queue_item_id)
            .single();

          if (queueData) {
            queueStatus = queueData.status || '';
            // Check if there are completed render_results for this queue item
            if (queueData.status === 'done') {
              hasCompletedRender = true;
              completedRenderUrl = queueData.image_url || '';
            } else {
              // Also check render_results for any 'done' rows
              const { data: renderData } = await supabase
                .from('render_results')
                .select('image_url, status')
                .eq('queue_item_id', img.queue_item_id)
                .eq('status', 'done')
                .limit(1);

              if (renderData && renderData.length > 0) {
                hasCompletedRender = true;
                completedRenderUrl = renderData[0].image_url || '';
              }
            }
          }
        } catch (err) {
          // Non-critical — just skip enrichment
          console.warn(`[MATCHED-IMAGES] Enrichment error for queue_item_id ${img.queue_item_id}:`, err.message);
        }
      }

      enrichedImages.push({
        ...img,
        has_completed_render: hasCompletedRender,
        completed_render_url: completedRenderUrl,
        queue_status: queueStatus
      });
    }

    console.log(`[MATCHED-IMAGES] Found ${data?.length || 0} records (total: ${count || 0})`);

    return res.json({
      success: true,
      images: enrichedImages,
      total: count || 0,
      limit,
      offset
    });

  } catch (err) {
    console.error('[MATCHED-IMAGES] Error:', err);
    return res.status(500).json({
      error: 'Failed to fetch matched images',
      details: err.message
    });
  }
}
