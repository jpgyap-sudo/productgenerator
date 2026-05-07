// GET/POST/DELETE /api/queue/completed
// Persists completed batch metadata on the VPS.

import {
  clearCompletedBatches,
  deleteCompletedBatch,
  listCompletedBatches,
  saveCompletedBatch
} from '../../lib/completed-batches.js';
import { VIEWS } from '../../lib/fal.js';
import { createRenderZipOnVps, saveRenderImageToVps } from '../../lib/vps-storage.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      return res.json({ completedBatches: await listCompletedBatches() });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const batch = await saveCompletedBatch(await mirrorBatchToVps(body));
      return res.json({ success: true, batch });
    }

    if (req.method === 'DELETE') {
      const body = req.body || {};
      if (Array.isArray(body.ids)) {
        return res.json({ success: true, ...(await clearCompletedBatches(body.ids)) });
      }
      if (body.clearAll) {
        return res.json({ success: true, ...(await clearCompletedBatches()) });
      }
      return res.json({ success: true, ...(await deleteCompletedBatch(body.id)) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[COMPLETED] Error:', error);
    return res.status(500).json({ error: error.message || 'Completed batch request failed' });
  }
}

async function mirrorBatchToVps(batch = {}) {
  const id = Number(batch.id);
  if (!Number.isFinite(id)) return batch;

  const viewResults = Array.isArray(batch.viewResults) ? batch.viewResults : [];
  const mirrored = [];

  for (const row of viewResults) {
    if (!row?.imageUrl) {
      mirrored.push(row);
      continue;
    }

    const viewId = Number(row.viewId);
    const view = VIEWS.find(v => Number(v.id) === viewId) || { id: viewId, label: `View ${viewId}` };
    try {
      const stored = await saveRenderImageToVps(row.imageUrl, id, view, batch.name || `Item ${id}`);
      mirrored.push({ ...row, imageUrl: stored.publicUrl });
    } catch (error) {
      console.warn(`[COMPLETED] Failed to mirror item ${id} view ${row.viewId}:`, error.message);
      mirrored.push(row);
    }
  }

  let zipUrl = batch.zipUrl || '';
  const doneViews = mirrored.filter(row => row.status === 'done' && row.imageUrl);
  if (doneViews.length) {
    try {
      const zipResult = await createRenderZipOnVps(id, batch.name || `Item ${id}`, doneViews);
      zipUrl = zipResult.publicUrl;
    } catch (error) {
      console.warn(`[COMPLETED] Failed to create VPS ZIP for item ${id}:`, error.message);
    }
  }

  return {
    ...batch,
    zipUrl,
    viewResults: mirrored
  };
}
