// POST /api/queue/rerender-view
// Re-generates a single view for an existing completed item using a specified provider.
// Body: { itemId, viewId, provider }  (provider defaults to 'gemini')

import { supabase, QUEUE_TABLE, RESULTS_TABLE } from '../../lib/supabase.js';
import { VIEWS } from '../../lib/fal.js';
import { generateGeminiView } from '../../lib/gemini.js';
import { saveRenderImageToVps } from '../../lib/vps-storage.js';
import { saveCompletedBatch } from '../../lib/completed-batches.js';

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

  // Fetch the queue item for reference image and description
  const { data: items, error: fetchError } = await supabase
    .from(QUEUE_TABLE)
    .select('*')
    .eq('id', itemId);

  if (fetchError || !items?.length) {
    return res.status(404).json({ error: 'Item not found' });
  }

  const item = items[0];
  if (!item.image_url) {
    return res.status(400).json({ error: 'Item has no reference image' });
  }

  try {
    // Generate the view with Gemini Flash
    console.log(`[RERENDER] Item ${itemId} view ${viewId} with ${provider}`);
    const result = await generateGeminiView(view, item.description || '', item.image_url, '1K', item.brand || '', { forceFlash: true });

    if (!result?.cdnUrl) throw new Error('Generator returned no image URL');

    const providerUsed = 'gemini-flash';

    // Save to VPS
    const stored = await saveRenderImageToVps(result.cdnUrl, itemId, view, item.name);
    const publicUrl = stored.publicUrl;

    // Update render_results in Supabase
    const updatePayload = {
      status: 'done',
      image_url: publicUrl,
      error_message: '',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      provider_used: providerUsed
    };

    let { error: saveError } = await supabase
      .from(RESULTS_TABLE)
      .update(updatePayload)
      .eq('queue_item_id', itemId)
      .eq('view_id', viewId);

    // Retry without provider_used if column doesn't exist
    if (saveError && isMissingColumnError(saveError)) {
      const { provider_used: _pu, ...safePayload } = updatePayload;
      const { error: retryErr } = await supabase
        .from(RESULTS_TABLE)
        .update(safePayload)
        .eq('queue_item_id', itemId)
        .eq('view_id', viewId);
      saveError = retryErr;
    }

    if (saveError) throw saveError;

    // Refresh completed-batches.json with updated view
    try {
      const { data: allRows } = await supabase
        .from(RESULTS_TABLE)
        .select('*')
        .eq('queue_item_id', itemId);

      if (allRows?.length) {
        await saveCompletedBatch({
          id: itemId,
          name: item.name,
          imageUrl: item.image_url || '',
          status: 'done',
          provider: item.provider || 'openai-mini',
          apiModel: item.api_model || 'gpt-image-1-mini + Gemini Flash fallback',
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
