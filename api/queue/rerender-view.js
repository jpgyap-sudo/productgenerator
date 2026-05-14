// POST /api/queue/rerender-view
// Re-generates a single view for an existing completed item using a specified provider.
// Body: { itemId, viewId, provider }  (provider defaults to 'gemini')
//
// The item may no longer exist in the product_queue table (cleaned up after completion),
// so we also fall back to completed-batches.json data.
//
// Progress tracking: stores progress in a shared in-memory store so the frontend
// can poll for re-render progress via GET /api/queue/rerender-view/:itemId/:viewId

import { supabase, QUEUE_TABLE, RESULTS_TABLE } from '../../lib/supabase.js';
import { VIEWS } from '../../lib/fal.js';
import { generateGeminiView } from '../../lib/gemini.js';
import { saveRenderImageToVps, saveRenderImageBufferToVps, readPublicAsset } from '../../lib/vps-storage.js';
import { saveCompletedBatch, listCompletedBatches } from '../../lib/completed-batches.js';
import { replaceDriveFile, listRenderImagesInDriveFolder } from '../../lib/drive.js';

// ── In-memory re-render progress store ──────────────────────────────
// Key: `${itemId}:${viewId}`, Value: { status, progress, message, imageUrl?, error? }
export const rerenderProgressStore = new Map();

function setRerenderProgress(itemId, viewId, data) {
  const key = `${itemId}:${viewId}`;
  rerenderProgressStore.set(key, { ...data, updatedAt: Date.now() });
  // Auto-cleanup after 5 minutes
  setTimeout(() => rerenderProgressStore.delete(key), 5 * 60 * 1000);
}

export default async function handler(req, res) {
  // ── GET: Poll re-render progress ──
  if (req.method === 'GET') {
    const itemId = req.query.itemId || req.params?.itemId;
    const viewId = req.query.viewId || req.params?.viewId;
    if (!itemId || !viewId) {
      return res.status(400).json({ error: 'itemId and viewId are required' });
    }
    const key = `${itemId}:${viewId}`;
    const progress = rerenderProgressStore.get(key);
    if (!progress) {
      return res.json({ status: 'unknown', progress: 0, message: 'No re-render in progress' });
    }
    return res.json(progress);
  }

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

  // Set initial progress
  setRerenderProgress(itemId, viewId, { status: 'starting', progress: 0, message: 'Starting re-render...' });

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
        console.log(`[RERENDER] Found item ${itemId} in completed-batches.json`);
      } else {
        setRerenderProgress(itemId, viewId, { status: 'error', progress: 0, message: 'Item not found' });
        return res.status(404).json({ error: 'Item not found in queue table or completed batches' });
      }
    } catch (listErr) {
      setRerenderProgress(itemId, viewId, { status: 'error', progress: 0, message: listErr.message });
      console.warn(`[RERENDER] Failed to list completed batches: ${listErr.message}`);
      return res.status(404).json({ error: 'Item not found' });
    }
  }

  if (!itemImageUrl) {
    setRerenderProgress(itemId, viewId, { status: 'error', progress: 0, message: 'No reference image' });
    return res.status(400).json({ error: 'Item has no reference image' });
  }

  // Mark the render_results row as 'generating' so the frontend can show progress
  try {
    await supabase
      .from(RESULTS_TABLE)
      .update({ status: 'generating', error_message: '', updated_at: new Date().toISOString() })
      .eq('queue_item_id', itemId)
      .eq('view_id', viewId);
  } catch (_) {
    // Non-critical — continue even if update fails
  }

  // Probe the reference image URL to check it's reachable (non-blocking warning only)
  setRerenderProgress(itemId, viewId, { status: 'generating', progress: 10, message: 'Checking reference image...' });
  try {
    const ac = new AbortController();
    const probeTimer = setTimeout(() => ac.abort(), 8000);
    const probe = await fetch(itemImageUrl, { method: 'HEAD', signal: ac.signal });
    clearTimeout(probeTimer);
    if (!probe.ok) {
      console.warn(`[RERENDER] Reference image URL returned HTTP ${probe.status} for item ${itemId}`);
    }
  } catch (probeErr) {
    console.warn(`[RERENDER] Reference image URL unreachable for item ${itemId}: ${probeErr.message}`);
    // Continue anyway — the Gemini module will try to fetch it and may still succeed
  }

  try {
    // Generate the view with Gemini Flash
    setRerenderProgress(itemId, viewId, { status: 'generating', progress: 30, message: 'Generating with Gemini Flash...' });
    console.log(`[RERENDER] Item ${itemId} view ${viewId} with ${provider}`);
    const result = await generateGeminiView(view, itemDescription, itemImageUrl, '1K', itemBrand);

    if (!result?.cdnUrl) throw new Error('Generator returned no image URL');

    console.log(`[RERENDER] Gemini succeeded for item ${itemId} view ${viewId}, cdnUrl: ${result.cdnUrl?.slice(0, 80)}...`);

    setRerenderProgress(itemId, viewId, { status: 'saving', progress: 70, message: 'Saving rendered image...' });

    const providerUsed = 'gemini-flash';

    // Save to VPS - download the image from the Gemini CDN/Supabase URL
    // and store it locally so it is served by the Express static server
    let publicUrl;
    try {
      console.log(`[RERENDER] Saving image to VPS for item ${itemId} view ${viewId}...`);
      const stored = await saveRenderImageToVps(result.cdnUrl, itemId, view, itemName);
      publicUrl = stored.publicUrl;
      console.log(`[RERENDER] Image saved to VPS: ${publicUrl}`);
    } catch (saveErr) {
      console.warn(`[RERENDER] saveRenderImageToVps failed: ${saveErr.message}`);
      throw new Error(`Failed to save render image to VPS: ${saveErr.message}`);
    }

    setRerenderProgress(itemId, viewId, { status: 'saving', progress: 85, message: 'Updating database...' });

    // Update render_results in Supabase (if the row exists)
    const updatePayload = {
      status: 'done',
      image_url: publicUrl,
      error_message: '',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      provider_used: providerUsed
    };

    console.log(`[RERENDER] Updating Supabase render_results for item ${itemId} view ${viewId}...`);
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
    } else {
      console.log(`[RERENDER] Supabase render_results updated successfully for item ${itemId} view ${viewId}`);
    }

    setRerenderProgress(itemId, viewId, { status: 'saving', progress: 95, message: 'Refreshing completed batches...' });

    // Refresh completed-batches.json with updated view
    try {
      console.log(`[RERENDER] Refreshing completed-batches for item ${itemId}...`);
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
          apiModel: item?.api_model || 'gemini-2.5-flash-image',
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
        console.log(`[RERENDER] completed-batches updated from Supabase rows for item ${itemId}`);
      } else {
        // No rows in Supabase - update the batch in completed-batches.json directly
        console.log(`[RERENDER] No Supabase rows for item ${itemId}, updating from local store...`);
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
          console.log(`[RERENDER] completed-batches updated from local store for item ${itemId}`);
        } else {
          console.warn(`[RERENDER] Item ${itemId} not found in local store either`);
        }
      }
    } catch (storeErr) {
      console.warn(`[RERENDER] Failed to update completed-batches for item ${itemId}:`, storeErr.message);
    }

    // ── Update Google Drive with the new image ──
    // Find the Drive folder for this item and replace the old view image
    try {
      const hasDriveEnv = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON
        || !!(process.env.GOOGLE_DRIVE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET && process.env.GOOGLE_DRIVE_REFRESH_TOKEN);
      if (hasDriveEnv) {
        // Look up the Drive folder info from the item or completed batches
        let driveFolderId = item?.drive_folder_id || '';
        let driveFolderName = item?.drive_folder_name || '';

        // If not on the item, check completed-batches.json
        if (!driveFolderId) {
          try {
            const batches = await listCompletedBatches();
            const batch = batches.find(b => Number(b.id) === Number(itemId));
            if (batch) {
              driveFolderId = batch.driveFolderId || '';
              driveFolderName = batch.driveFolderName || '';
            }
          } catch (_) {}
        }

        if (driveFolderId) {
          console.log(`[RERENDER] Updating Drive folder "${driveFolderName}" (${driveFolderId}) for item ${itemId} view ${viewId}...`);

          // Read the new image buffer from VPS
          const localBuffer = await readPublicAsset(publicUrl);
          if (localBuffer) {
            const ext = String(publicUrl).split('?')[0].toLowerCase().endsWith('.png') ? 'png' : 'jpg';
            const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
            const safeLabel = getViewLabel(viewId).replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
            const fileName = `${driveFolderName}_img${viewId}_${safeLabel}.${ext}`;
            const searchPattern = `_img${viewId}_`;

            const driveResult = await replaceDriveFile(localBuffer, fileName, mimeType, driveFolderId, searchPattern);
            console.log(`[RERENDER] Drive updated for item ${itemId} view ${viewId}: ${driveResult.fileId}`);
          } else {
            console.warn(`[RERENDER] Could not read image from VPS for Drive update: ${publicUrl}`);
          }
        } else {
          console.log(`[RERENDER] No Drive folder found for item ${itemId}, skipping Drive update`);
        }
      }
    } catch (driveErr) {
      // Non-fatal — the re-render succeeded, Drive update is best-effort
      console.warn(`[RERENDER] Failed to update Drive for item ${itemId} view ${viewId}:`, driveErr.message);
    }

    // Mark as complete
    console.log(`[RERENDER] Re-render complete for item ${itemId} view ${viewId}!`);
    setRerenderProgress(itemId, viewId, { status: 'done', progress: 100, message: 'Re-render complete!', imageUrl: publicUrl });
    return res.json({ success: true, imageUrl: publicUrl, providerUsed });
  } catch (err) {
    console.error(`[RERENDER] Failed for item ${itemId} view ${viewId}:`, err.message);
    console.error(`[RERENDER] Stack:`, err.stack);
    setRerenderProgress(itemId, viewId, { status: 'error', progress: 0, message: err.message || 'Rerender failed' });
    // Only send error response if headers haven't been sent yet
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || 'Rerender failed' });
    }
  }
}

function isMissingColumnError(error) {
  return error?.code === 'PGRST204'
    || /column .* does not exist/i.test(error?.message || '')
    || /Could not find .* column/i.test(error?.message || '');
}
