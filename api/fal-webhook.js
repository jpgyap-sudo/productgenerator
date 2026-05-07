// ═══════════════════════════════════════════════════════════════════
//  POST /api/fal-webhook — Express route handler
//  Webhook endpoint for fal.ai queue job completions.
//
//  VPS ADAPTATION:
//  - Removed Vercel config export
//  - Uses Express req.body instead of req.json()
//  - Uses Express res.json() instead of custom json() helper
//  - Still functional if fal.ai is used, but on VPS the primary
//    providers are OpenAI and Gemini (no webhook needed for those)
// ═══════════════════════════════════════════════════════════════════
import { supabase, RESULTS_TABLE, QUEUE_TABLE, BUCKET_NAME } from '../lib/supabase.js';
import { extractImageUrl, VIEWS } from '../lib/fal.js';
import { uploadRendersToDrive, getNextFolderCounter, getNextFolderCounterFallback, isSupabaseConnectionError } from '../lib/drive.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body || {};
    const { request_id, gateway_request_id, status, payload: resultPayload, error } = payload;

    console.log(`[FAL-WEBHOOK] Received webhook for request ${request_id}, status=${status}`);

    if (!request_id) {
      console.error('[FAL-WEBHOOK] Missing request_id in webhook payload');
      return res.json({ received: true });
    }

    // Find the render result row by request_id
    const { data: rows, error: fetchError } = await supabase
      .from(RESULTS_TABLE)
      .select('*')
      .eq('request_id', request_id);

    if (fetchError) {
      console.error(`[FAL-WEBHOOK] Error fetching row for request ${request_id}:`, fetchError.message);
      return res.json({ received: true });
    }

    if (!rows || rows.length === 0) {
      // Try with gateway_request_id as fallback
      if (gateway_request_id && gateway_request_id !== request_id) {
        const { data: gwRows } = await supabase
          .from(RESULTS_TABLE)
          .select('*')
          .eq('request_id', gateway_request_id);

        if (gwRows && gwRows.length > 0) {
          return await processWebhookResult(gwRows[0], status, resultPayload, error, res);
        }
      }

      console.warn(`[FAL-WEBHOOK] No matching row found for request ${request_id}`);
      return res.json({ received: true });
    }

    return await processWebhookResult(rows[0], status, resultPayload, error, res);
  } catch (error) {
    console.error('[FAL-WEBHOOK] Error processing webhook:', error.message);
    return res.json({ received: true });
  }
}

async function processWebhookResult(row, status, resultPayload, error, res) {
  const now = new Date().toISOString();

  if (status === 'ERROR' || error) {
    console.error(`[FAL-WEBHOOK] Job failed for item ${row.queue_item_id} view ${row.view_id}:`, error || 'Unknown error');
    await supabase
      .from(RESULTS_TABLE)
      .update({
        status: 'error',
        error_message: error || 'Webhook reported error',
        completed_at: now,
        updated_at: now
      })
      .eq('queue_item_id', row.queue_item_id)
      .eq('view_id', row.view_id);

    return res.json({ received: true });
  }

  const imageUrl = extractImageUrl(resultPayload);
  if (!imageUrl) {
    console.error(`[FAL-WEBHOOK] No image URL in payload for item ${row.queue_item_id} view ${row.view_id}`);
    await supabase
      .from(RESULTS_TABLE)
      .update({
        status: 'error',
        error_message: 'No image URL in webhook payload',
        completed_at: now,
        updated_at: now
      })
      .eq('queue_item_id', row.queue_item_id)
      .eq('view_id', row.view_id);

    return res.json({ received: true });
  }

  let storedUrl = imageUrl;

  // Optionally mirror to Supabase storage for redundancy
  try {
    storedUrl = await copyImageToStorage(imageUrl, row.queue_item_id, row.view_id);
  } catch (storageErr) {
    console.warn(`[FAL-WEBHOOK] Failed to mirror to Supabase storage for item ${row.queue_item_id}:`, storageErr.message);
    storedUrl = imageUrl;
  }

  // Update the render result row
  await supabase
    .from(RESULTS_TABLE)
    .update({
      status: 'done',
      image_url: storedUrl,
      error_message: '',
      completed_at: now,
      updated_at: now
    })
    .eq('queue_item_id', row.queue_item_id)
    .eq('view_id', row.view_id);

  console.log(`[FAL-WEBHOOK] View ${row.view_id} for item ${row.queue_item_id} completed successfully`);

  // Check if all 4 views are done and trigger Drive upload
  try {
    await maybeUploadToDrive(row.queue_item_id);
  } catch (driveErr) {
    console.error(`[FAL-WEBHOOK] Drive upload check failed for item ${row.queue_item_id}:`, driveErr.message);
  }

  return res.json({ received: true });
}

async function copyImageToStorage(imageUrl, itemId, viewId) {
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error(`Image fetch failed: ${imageRes.status}`);

  const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const buffer = Buffer.from(await imageRes.arrayBuffer());
  const fileName = `renders/${itemId}_view${viewId}_${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, buffer, {
      contentType,
      upsert: true
    });

  if (uploadError) throw uploadError;

  const { data: { publicUrl } } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(fileName);

  return publicUrl;
}

async function maybeUploadToDrive(itemId) {
  // ── Try Supabase first ──
  let items, fetchError;
  try {
    const result = await supabase
      .from(QUEUE_TABLE)
      .select('*')
      .eq('id', itemId);
    items = result.data;
    fetchError = result.error;
    if (fetchError && isSupabaseConnectionError(fetchError)) throw fetchError;
  } catch (supaErr) {
    if (isSupabaseConnectionError(supaErr)) {
      console.log(`[FAL-WEBHOOK] Supabase unreachable for item ${itemId}, falling back to local storage`);
      return await maybeUploadToDriveFallback(itemId);
    }
    console.log(`[FAL-WEBHOOK] Item ${itemId} not found`);
    return;
  }

  if (!items || items.length === 0) {
    console.log(`[FAL-WEBHOOK] Item ${itemId} not found`);
    return;
  }

  const item = items[0];

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return;

  // Check if upload is already in progress or completed
  if (item.drive_upload_status === 'uploading') {
    console.log(`[FAL-WEBHOOK] Item ${itemId} Drive upload already in progress`);
    return;
  }

  if ((item.drive_folder_id && item.drive_folder_id !== '') || (item.drive_folder_name && item.drive_folder_name !== '')) {
    console.log(`[FAL-WEBHOOK] Item ${itemId} already uploaded to "${item.drive_folder_name}"`);
    return;
  }

  let rows, resultsError;
  try {
    const result = await supabase
      .from(RESULTS_TABLE)
      .select('*')
      .eq('queue_item_id', itemId)
      .order('view_id', { ascending: true });
    rows = result.data;
    resultsError = result.error;
    if (resultsError && isSupabaseConnectionError(resultsError)) throw resultsError;
  } catch (supaErr) {
    if (isSupabaseConnectionError(supaErr)) {
      console.log(`[FAL-WEBHOOK] Supabase unreachable for results of item ${itemId}, falling back to local storage`);
      return await maybeUploadToDriveFallback(itemId);
    }
    console.error(`[FAL-WEBHOOK] Failed to fetch results for item ${itemId}:`, resultsError?.message || supaErr.message);
    return;
  }

  if (resultsError) {
    console.error(`[FAL-WEBHOOK] Failed to fetch results for item ${itemId}:`, resultsError.message);
    return;
  }

  const doneViews = rows
    .filter(row => row.status === 'done' && row.image_url)
    .map(row => ({
      viewId: row.view_id,
      viewLabel: getViewLabel(row.view_id),
      imageUrl: row.image_url
    }));

  if (doneViews.length === 4) {
    try {
      // Generate sequential folder name with counter prefix
      const counter = await getNextFolderCounter();
      const safeName = (item.name || `Item_${itemId}`)
        .replace(/[^a-zA-Z0-9\s_-]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 55);
      const folderName = `${String(counter).padStart(3, '0')}_${safeName}`;

      await updateDriveUploadState(item.id, {
        drive_upload_status: 'uploading',
        drive_upload_done: 0,
        drive_upload_total: doneViews.length,
        drive_upload_error: '',
        updated_at: new Date().toISOString()
      });

      const driveResult = await uploadRendersToDrive(item.id, item.name, doneViews, {
        folderName,
        onProgress: progress => updateDriveUploadState(item.id, {
          drive_upload_status: progress.status,
          drive_upload_done: progress.uploaded,
          drive_upload_total: progress.total,
          drive_upload_error: progress.status === 'error' ? progress.message || 'Drive upload incomplete' : '',
          drive_folder_id: progress.folderId || item.drive_folder_id || '',
          drive_folder_name: progress.folderName || item.drive_folder_name || '',
          drive_folder_url: progress.folderUrl || item.drive_folder_url || '',
          updated_at: new Date().toISOString()
        })
      });

      await updateDriveUploadState(item.id, {
        drive_folder_id: driveResult.folderId,
        drive_folder_name: driveResult.folderName,
        drive_folder_url: driveResult.folderUrl || '',
        drive_upload_status: driveResult.files.length === doneViews.length ? 'done' : 'error',
        drive_upload_done: driveResult.files.length,
        drive_upload_total: doneViews.length,
        drive_upload_error: driveResult.files.length === doneViews.length ? '' : 'Some files failed to upload',
        updated_at: new Date().toISOString()
      });

      console.log(`[FAL-WEBHOOK] SUCCESS: Uploaded ${item.name} to Drive folder "${driveResult.folderName}" (URL: ${driveResult.folderUrl || 'N/A'})`);
    } catch (driveErr) {
      await updateDriveUploadState(item.id, {
        drive_upload_status: 'error',
        drive_upload_error: driveErr.message || 'Drive upload failed',
        updated_at: new Date().toISOString()
      });
      console.error(`[FAL-WEBHOOK] Drive upload FAILED for item ${itemId}:`, driveErr.message);
    }
  }
}

/**
 * Fallback Drive upload when Supabase is unreachable.
 * Reads item data from local completed-batches.json and stores results there.
 */
async function maybeUploadToDriveFallback(itemId) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return;

  const { listCompletedBatches, saveCompletedBatch } = await import('../lib/completed-batches.js');
  const batches = await listCompletedBatches();
  const batch = batches.find(b => Number(b.id) === Number(itemId));

  if (!batch || !Array.isArray(batch.viewResults) || batch.viewResults.length < 4) {
    console.log(`[FAL-WEBHOOK] Item ${itemId} not found in local batches, skipping Drive upload fallback`);
    return;
  }

  // Check if already uploaded
  if (batch.driveFolderId && batch.driveFolderId !== '') {
    console.log(`[FAL-WEBHOOK] Item ${itemId} already uploaded locally to "${batch.driveFolderName}"`);
    return;
  }

  const doneViews = batch.viewResults
    .filter(r => r.status === 'done' && r.imageUrl)
    .map(r => ({
      viewId: r.viewId,
      viewLabel: getViewLabel(r.viewId),
      imageUrl: r.imageUrl
    }));

  if (doneViews.length !== 4) {
    console.log(`[FAL-WEBHOOK] Item ${itemId} has ${doneViews.length}/4 done views locally, skipping Drive upload fallback`);
    return;
  }

  try {
    const counter = await getNextFolderCounterFallback();
    const safeName = (batch.name || `Item_${itemId}`)
      .replace(/[^a-zA-Z0-9\s_-]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 55);
    const folderName = `${String(counter).padStart(3, '0')}_${safeName}`;

    console.log(`[FAL-WEBHOOK] Drive upload fallback: uploading ${doneViews.length} views for item ${itemId} to "${folderName}"`);

    const driveResult = await uploadRendersToDrive(itemId, batch.name, doneViews, {
      folderName,
      onProgress: progress => {
        console.log(`[FAL-WEBHOOK] Drive fallback progress: ${progress.status} ${progress.uploaded}/${progress.total}`);
      }
    });

    const success = driveResult.files.length === doneViews.length;
    await saveCompletedBatch({
      id: itemId,
      name: batch.name || `Item ${itemId}`,
      status: 'done',
      provider: batch.provider || '',
      apiModel: batch.apiModel || '',
      driveFolderId: driveResult.folderId,
      driveFolderName: driveResult.folderName,
      driveFolderUrl: driveResult.folderUrl || '',
      driveUploadStatus: success ? 'done' : 'error',
      driveUploadDone: driveResult.files.length,
      driveUploadTotal: doneViews.length,
      driveUploadError: success ? '' : 'Some files failed to upload',
      viewResults: batch.viewResults
    });

    console.log(`[FAL-WEBHOOK] SUCCESS (fallback): Uploaded item ${itemId} to Drive folder "${driveResult.folderName}" (URL: ${driveResult.folderUrl || 'N/A'})`);
  } catch (driveErr) {
    console.error(`[FAL-WEBHOOK] Drive upload fallback FAILED for item ${itemId}:`, driveErr.message);
  }
}

function getViewLabel(viewId) {
  const view = VIEWS.find(v => v.id === viewId);
  return view ? view.label : `View ${viewId}`;
}

async function updateDriveUploadState(itemId, fields) {
  const { error } = await supabase
    .from(QUEUE_TABLE)
    .update(fields)
    .eq('id', itemId);

  if (!error || !isMissingColumnError(error)) return;

  const {
    drive_upload_status,
    drive_upload_done,
    drive_upload_total,
    drive_upload_error,
    ...safeFields
  } = fields;

  await supabase
    .from(QUEUE_TABLE)
    .update(safeFields)
    .eq('id', itemId);
}

function isMissingColumnError(error) {
  return error?.code === 'PGRST204'
    || /column .* does not exist/i.test(error?.message || '')
    || /Could not find .* column/i.test(error?.message || '');
}
