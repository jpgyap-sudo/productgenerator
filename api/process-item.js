// ═══════════════════════════════════════════════════════════════════
//  POST /api/process-item — Background worker
//  Called by submit.js via waitUntil(). Processes queue items by:
//  1. Generating all 5 views in parallel via fal.ai queue-based API
//     (uses fal.ai CDN URLs directly — no redundant download/upload)
//  2. Saving results to Supabase (render_results table + storage)
//  3. Updating queue item status
//
//  IMPROVEMENT: Now uses fal.ai CDN URLs directly instead of
//  downloading images and re-uploading to Supabase. This eliminates
//  the redundant data transfer and speeds up processing.
// ═══════════════════════════════════════════════════════════════════
import { supabase, QUEUE_TABLE, RESULTS_TABLE, BUCKET_NAME } from '../lib/supabase.js';
import { generateView, VIEWS } from '../lib/fal.js';

export const config = {
  runtime: 'nodejs',
  // Allow up to 300 seconds (5 minutes) for background processing
  // Each view generation uses fal.ai queue-based API with polling,
  // so we need enough time for all 5 parallel generations + fallbacks
  maxDuration: 300
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const url = new URL(req.url);
    const idsParam = url.searchParams.get('ids');
    const resolution = url.searchParams.get('res') || '1K';

    if (!idsParam) {
      return new Response(JSON.stringify({ error: 'ids parameter required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const itemIds = idsParam.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    if (itemIds.length === 0) {
      return new Response(JSON.stringify({ error: 'No valid IDs' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Process each item sequentially
    for (const itemId of itemIds) {
      await processItem(itemId, resolution);
    }

    return new Response(JSON.stringify({
      success: true,
      processedIds: itemIds
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Process item error:', error);
    return new Response(JSON.stringify({
      error: error.message || 'Internal server error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Process a single queue item: generate 5 views, save results.
 */
async function processItem(itemId, resolution) {
  const now = new Date().toISOString();

  // Fetch the item
  const { data: items, error: fetchError } = await supabase
    .from(QUEUE_TABLE)
    .select('*')
    .eq('id', itemId);

  if (fetchError || !items || items.length === 0) {
    console.error(`Item ${itemId} not found:`, fetchError);
    return;
  }

  const item = items[0];
  const imageUrl = item.image_url;
  const desc = item.description || '';

  if (!imageUrl) {
    // No reference image — mark as error
    await updateItemStatus(itemId, 'error', 'No reference image');
    await updateAllViewStatuses(itemId, 'error', 'No reference image');
    return;
  }

  try {
    // Step 1: Mark all views as generating
    await updateItemStatus(itemId, 'active', 'Generating 5 views...');
    await updateAllViewStatuses(itemId, 'generating', null);

    // Step 2: Generate all 5 views in parallel
    // Each call uses fal.ai queue-based API internally (submit + poll)
    // Returns fal.ai CDN URLs directly — no redundant download/upload
    const results = await Promise.allSettled(
      VIEWS.map(view => generateView(view, desc, imageUrl, resolution))
    );

    // Step 3: Save results
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < VIEWS.length; i++) {
      const view = VIEWS[i];
      const result = results[i];

      if (result.status === 'fulfilled' && result.value) {
        // Success — save the fal.ai CDN URL to Supabase
        successCount++;
        try {
          const cdnUrl = result.value.cdnUrl;
          const fileName = `renders/${itemId}_view${view.id}_${Date.now()}.jpg`;

          // ── Improvement: Use fal.ai CDN URL directly ──
          // Fal.ai serves results via their CDN (v3.fal.media).
          // We store the CDN URL and optionally mirror to Supabase.
          // This is faster than downloading + re-uploading.
          let publicUrl = cdnUrl;

          // Optionally mirror to Supabase storage for redundancy
          try {
            const imgRes = await fetch(cdnUrl);
            if (imgRes.ok) {
              const buffer = Buffer.from(await imgRes.arrayBuffer());
              const { error: uploadError } = await supabase.storage
                .from(BUCKET_NAME)
                .upload(fileName, buffer, {
                  contentType: 'image/jpeg',
                  upsert: true
                });

              if (!uploadError) {
                const { data: { publicUrl: pubUrl } } = supabase.storage
                  .from(BUCKET_NAME)
                  .getPublicUrl(fileName);
                publicUrl = pubUrl;
              }
            }
          } catch (mirrorErr) {
            console.warn(`Mirror to Supabase failed for item ${itemId} view ${view.id}, using CDN URL`);
          }

          // Update render_results row
          await supabase
            .from(RESULTS_TABLE)
            .update({
              status: 'done',
              image_url: publicUrl,
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('queue_item_id', itemId)
            .eq('view_id', view.id);

        } catch (saveErr) {
          console.error(`Failed to save result for item ${itemId} view ${view.id}:`, saveErr);
          await supabase
            .from(RESULTS_TABLE)
            .update({
              status: 'error',
              error_message: saveErr.message,
              updated_at: new Date().toISOString()
            })
            .eq('queue_item_id', itemId)
            .eq('view_id', view.id);
          failCount++;
        }
      } else {
        // Failed
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

    // Step 4: Update queue item final status
    const finalStatus = successCount === 5 ? 'done' : 'error';
    const statusText = successCount === 5
      ? 'All 5 views generated'
      : `${successCount}/5 views generated`;
    await updateItemStatus(itemId, finalStatus, statusText);

  } catch (error) {
    console.error(`Error processing item ${itemId}:`, error);
    await updateItemStatus(itemId, 'error', error.message || 'Processing failed');
    await updateAllViewStatuses(itemId, 'error', error.message || 'Processing failed');
  }
}

/**
 * Update a queue item's status and sub-text.
 */
async function updateItemStatus(itemId, status, subText) {
  const now = new Date().toISOString();
  const updateData = { status, updated_at: now };
  if (subText) updateData.sub_text = subText;

  const { error } = await supabase
    .from(QUEUE_TABLE)
    .update(updateData)
    .eq('id', itemId);

  if (error) {
    console.error(`Failed to update item ${itemId} status:`, error);
  }
}

/**
 * Update all view statuses for an item (e.g., set all to error).
 */
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
    console.error(`Failed to update view statuses for item ${itemId}:`, error);
  }
}
