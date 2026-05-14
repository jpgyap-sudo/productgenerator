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
 * PATCH /api/agent/matched-images/:id  — update a matched image record
 * DELETE /api/agent/matched-images/:id — delete a matched image record
 */
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method === 'PATCH') {
    return handlePatch(req, res);
  }

  if (req.method === 'DELETE') {
    return handleDelete(req, res);
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  return handleGet(req, res);
}

/**
 * PATCH — update a matched image record's editable fields
 */
async function handlePatch(req, res) {
  try {
    // Extract ID from URL path: /api/agent/matched-images/:id
    const urlParts = req.url.split('/');
    const id = urlParts[urlParts.length - 1];

    if (!id || id === 'matched-images') {
      return res.status(400).json({ error: 'Missing image ID in URL path' });
    }

    const allowedFields = ['product_name', 'product_code', 'product_brand', 'description', 'image_name'];
    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update. Allowed: ' + allowedFields.join(', ') });
    }

    updates.updated_at = new Date().toISOString();

    console.log(`[MATCHED-IMAGES-PATCH] Updating id=${id} with:`, updates);

    const { data, error } = await supabase
      .from(MATCHED_IMAGES_TABLE)
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('[MATCHED-IMAGES-PATCH] Update error:', error.message);
      return res.status(500).json({ error: 'Failed to update matched image', details: error.message });
    }

    console.log(`[MATCHED-IMAGES-PATCH] Successfully updated id=${id}`);
    return res.json({ success: true, image: data });

  } catch (err) {
    console.error('[MATCHED-IMAGES-PATCH] Error:', err);
    return res.status(500).json({ error: 'Failed to update matched image', details: err.message });
  }
}

/**
 * GET — fetch matched images with batch-enriched render status
 * Query params:
 *   archived - if 'true', fetch only archived; if 'false' or omitted, fetch only non-archived
 */
async function handleGet(req, res) {
  try {
    const limit = Math.min(parseInt(req.query?.limit || '50', 10), 200);
    const offset = parseInt(req.query?.offset || '0', 10);
    const search = req.query?.search || '';
    const archived = req.query?.archived === 'true';

    console.log(`[MATCHED-IMAGES] Fetching history (limit: ${limit}, offset: ${offset}, search: ${search || 'none'}, archived: ${archived})`);

    let query = supabase
      .from(MATCHED_IMAGES_TABLE)
      .select('*', { count: 'exact' });

    // Filter by archived status
    if (archived) {
      query = query.not('archived_at', 'is', null);
    } else {
      query = query.is('archived_at', null);
    }

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

    // ── Batch enrichment: collect all queue_item_ids and query once ──
    const enrichedImages = [];
    const queueItemIds = (data || [])
      .map(img => img.queue_item_id)
      .filter(Boolean);

    let queueMap = {};   // queue_item_id -> { status, image_url }
    let renderMap = {};  // queue_item_id -> { image_url }

    if (queueItemIds.length > 0) {
      try {
        // Batch query #1: fetch all product_queue rows at once
        const { data: queueData } = await supabase
          .from('product_queue')
          .select('id, status, image_url')
          .in('id', queueItemIds);

        if (queueData) {
          for (const q of queueData) {
            queueMap[q.id] = { status: q.status || '', image_url: q.image_url || '' };
          }
        }

        // Batch query #2: fetch all done render_results at once
        const { data: renderData } = await supabase
          .from('render_results')
          .select('queue_item_id, image_url, status')
          .in('queue_item_id', queueItemIds)
          .eq('status', 'done');

        if (renderData) {
          for (const r of renderData) {
            // Only set if not already set (first done result wins)
            if (!renderMap[r.queue_item_id]) {
              renderMap[r.queue_item_id] = { image_url: r.image_url || '' };
            }
          }
        }
      } catch (err) {
        console.warn('[MATCHED-IMAGES] Batch enrichment error:', err.message);
      }
    }

    // ── Enrich each image from the batch maps ──
    for (const img of data || []) {
      let hasCompletedRender = false;
      let completedRenderUrl = '';
      let queueStatus = '';

      if (img.queue_item_id) {
        const qInfo = queueMap[img.queue_item_id];
        const rInfo = renderMap[img.queue_item_id];

        if (qInfo) {
          queueStatus = qInfo.status || '';
          if (qInfo.status === 'done') {
            hasCompletedRender = true;
            completedRenderUrl = qInfo.image_url || '';
          }
        }

        // If not marked done from queue status, check render_results batch data
        if (!hasCompletedRender && rInfo) {
          hasCompletedRender = true;
          completedRenderUrl = rInfo.image_url || '';
        }
      }

      enrichedImages.push({
        ...img,
        has_completed_render: hasCompletedRender,
        completed_render_url: completedRenderUrl,
        queue_status: queueStatus
      });
    }

    console.log(`[MATCHED-IMAGES] Found ${data?.length || 0} records (total: ${count || 0}) — batch enriched ${queueItemIds.length} queue items`);

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

/**
 * DELETE — delete a matched image record by ID
 */
async function handleDelete(req, res) {
  try {
    // Extract ID from URL path: /api/agent/matched-images/:id
    const urlParts = req.url.split('/');
    const id = urlParts[urlParts.length - 1];

    if (!id || id === 'matched-images') {
      return res.status(400).json({ error: 'Missing image ID in URL path' });
    }

    console.log(`[MATCHED-IMAGES-DELETE] Deleting id=${id}`);

    const { data, error } = await supabase
      .from(MATCHED_IMAGES_TABLE)
      .delete()
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('[MATCHED-IMAGES-DELETE] Delete error:', error.message);
      return res.status(500).json({ error: 'Failed to delete matched image', details: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Matched image not found' });
    }

    console.log(`[MATCHED-IMAGES-DELETE] Successfully deleted id=${id}`);
    return res.json({ success: true, image: data });

  } catch (err) {
    console.error('[MATCHED-IMAGES-DELETE] Error:', err);
    return res.status(500).json({ error: 'Failed to delete matched image', details: err.message });
  }
}
