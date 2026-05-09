// POST /api/queue/rerender-view
// Re-generates a single view for an existing completed item using a specified provider.
// Body: { itemId, viewId, provider }  (provider defaults to 'gemini')
//
// The item may no longer exist in the product_queue table (cleaned up after completion),
// so we also fall back to completed-batches.json data.

import { supabase, QUEUE_TABLE, RESULTS_TABLE } from '../../lib/supabase.js';
import { VIEWS } from '../../lib/fal.js';
import { generateGeminiView } from '../../lib/gemini.js';
import { saveRenderImageToVps, saveRenderImageBufferToVps } from '../../lib/vps-storage.js';
import { saveCompletedBatch, listCompletedBatches } from '../../lib/completed-batches.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { itemId, viewId, provider = 'gemini' } = req.body || {};

  if (!itemId || !viewId) {
    return res.status(400).json({ error: 'itemId and viewId are required' });
  }

  const view = VIEWS.find(v => Number(v.id) === Number(viewId));
  if (!view) {
    return res.status(400).json({ error: `Invalid viewId: ${viewId}` });
  }

  // Try to fetch the queue item from Supabase first
  let item = null;
  let itemName = `Item ${itemId}`;
  let itemImageUrl = '';
  let itemDescription = '';
  let itemBrand = '';

  const { data: items, error: fetchError } = await supabase
    .from(QUEUE_TABLE)
    .select('*')
    .eq('id', itemId);

  if (!fetchError && items?.length) {
    item = items[0];
    itemName = item.name || itemName;
    itemImageUrl = item.image_url || '';
    itemDescription = item.description || '';
    itemBrand = item.brand || '';
    console.log(`[RERENDER] Found item ${itemId} in Supabase queue table`);
  } else {
    // Fall back to completed-batches.json
    console.log(`[RERENDER] Item ${itemId} not in queue table, checking completed-batches.json`);
    try {
      const batches = await listCompletedBatches();
      const batch = batches.find(b => Number(b.id) === Number(itemId));
      if (batch) {
        itemName = batch.name || itemName;
        itemImageUrl = batch.imageUrl || '';
        // Description and brand are not stored in completed-batches.json,
        // but we can still rerender with what we have
        console.log(`[RERENDER] Found item ${itemId} in completed-batches.json`);
      } else {
        return res.status(404).json({ error: 'Item not found in queue table or completed batches' });
      }
    } catch (listErr) {
      console.warn(`[RERENDER] Failed to list completed batches: ${listErr.message}`);
      return res.status(404).json({ error: 'Item not found' });
    }
  }

  if (!itemImageUrl) {
    return res.status(400).json({ error: 'Item has no reference image' });
  }

  try {
    // Generate the view with Gemini Flash
    console.log(`[RERENDER] Item ${itemId} view ${viewId} with ${provider}`);
    const result = await generateGeminiView(view, itemDescription, itemImageUrl, '1K', itemBrand, { forceFlash: true });

    if (!result?.cdnUrl) throw new Error('Generator returned no image URL');

    const providerUsed = 'gemini-flash';

    // Save to VPS - download the image from the Gemini CDN/Supabase URL
    // and store it locally so it is served by the Express static server
    let publicUrl;
    try {
      const stored = await saveRenderImageToVps(result.cdnUrl, itemId, view, itemName);
      publicUrl = stored.publicUrl;
    } catch (saveErr) {
      console.warn(`[RERENDER] saveRenderImageToVps failed: ${saveErr.message}`);
      throw new Error(`Failed to save render image to VPS: ${saveErr.message}`);
    }

    // Update render_results in Supabase (if the row exists)
    const updatePayload = {
      status: 'done',
      image_url: publicUrl,
      error_message: '',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      provider_used: providerUsed
    };

    const { error: saveError } = await supabase
      .from(RESULTS_TABLE)
      .update(updatePayload)
      .eq('queue_item_id', itemId)
      .eq('view_id', viewId);

    // If provider_used column doesn't exist, retry without it
    if (saveError && isMissingColumnError(saveError)) {
      const { provider_used: _pu, ...safePayload } = updatePayload;
      const { error: retryErr } = await supabase
        .from(RESULTS_TABLE)
        .update(safePayload)
        .eq('queue_item_id', itemId)
        .eq('view_id', viewId);
      if (retryErr) {
        console.warn(`[RERENDER] Failed to update render_results: ${retryErr.message}`);
      }
    } else if (saveError) {
      console.warn(`[RERENDER] Failed to update render_results: ${saveError.message}`);
    }

    // Refresh completed-batches.json with updated view
    try {
      const { data: allRows } = await supabase
        .from(RESULTS_TABLE)
        .select('*')
        .eq('queue_item_id', itemId);

      if (allRows?.length) {
        await saveCompletedBatch({
          id: itemId,
          name: itemName,
          imageUrl: itemImageUrl,
          status: 'done',
          provider: item?.provider || 'openai-mini',
          apiModel: item?.api_model || 'gpt-image-1-mini + Gemini Flash fallback',
          updatedAt: new Date().toISOString(),
          viewResults: allRows.map(row => ({
            viewId: row.view_id,
            status: row.status,
            imageUrl: row.image_url,
            errorMessage: row.error_message || null,
            completedAt: row.completed_at || null,
            providerUsed: row.provider_used || (Number(row.view_id) === Number(viewId) ? providerUsed : null)
          }))
        });
      } else {
        // No rows in Supabase - update the batch in completed-batches.json directly
        const batches = await listCompletedBatches();
        const existing = batches.find(b => Number(b.id) === Number(itemId));
        if (existing) {
          const updatedViewResults = (existing.viewResults || []).map(vr =>
            Number(vr.viewId) === Number(viewId)
              ? { ...vr, imageUrl: publicUrl, status: 'done', providerUsed, completedAt: new Date().toISOString() }
              : vr
          );
          await saveCompletedBatch({
            ...existing,
            updatedAt: new Date().toISOString(),
            viewResults: updatedViewResults
          });
        }
      }
    } catch (storeErr) {
      console.warn(`[RERENDER] Failed to update completed-batches for item ${itemId}:`, storeErr.message);
    }

    return res.json({ success: true, imageUrl: publicUrl, providerUsed });
  } catch (err) {
    console.error(`[RERENDER] Failed for item ${itemId} view ${viewId}:`, err.message);
    return res.status(500).json({ error: err.message || 'Rerender failed' });
  }
}

function isMissingColumnError(error) {
  return error?.code === 'PGRST204'
    || /column .* does not exist/i.test(error?.message || '')
    || /Could not find .* column/i.test(error?.message || '');
}
