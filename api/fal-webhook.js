// ═══════════════════════════════════════════════════════════════════
//  POST /api/fal-webhook
//  Webhook endpoint called by fal.ai when a queue job completes.
//
//  IMPROVEMENT: Eliminates the need for client-side polling.
//  When fal.ai finishes processing a render job, it POSTs the result
//  to this URL. We save the result to Supabase storage and update
//  the render_results table immediately.
//
//  Reference: https://fal.ai/docs/documentation/model-apis/inference/webhooks
//
//  Fal.ai webhook guarantees:
//  - POST to webhook URL when request completes (success or error)
//  - Retry policy: 10 retries over 2 hours, 15s timeout per attempt
//  - Payload includes request_id, status (OK/ERROR), and result payload
//  - Webhook IP ranges available at https://api.fal.ai/v1/meta
// ═══════════════════════════════════════════════════════════════════
import { supabase, RESULTS_TABLE, QUEUE_TABLE, BUCKET_NAME } from '../lib/supabase.js';
import { extractImageUrl, VIEWS } from '../lib/fal.js';
import { uploadRendersToDrive } from '../lib/drive.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const payload = await req.json();
    const { request_id, gateway_request_id, status, payload: resultPayload, error } = payload;

    console.log(`[FAL-WEBHOOK] Received webhook for request ${request_id}, status=${status}`);

    if (!request_id) {
      console.error('[FAL-WEBHOOK] Missing request_id in webhook payload');
      return json({ received: true });
    }

    // Find the render result row by request_id
    const { data: rows, error: fetchError } = await supabase
      .from(RESULTS_TABLE)
      .select('*')
      .eq('request_id', request_id);

    if (fetchError) {
      console.error(`[FAL-WEBHOOK] Error fetching row for request ${request_id}:`, fetchError.message);
      return json({ received: true });
    }

    if (!rows || rows.length === 0) {
      // Try with gateway_request_id as fallback
      if (gateway_request_id && gateway_request_id !== request_id) {
        const { data: gwRows } = await supabase
          .from(RESULTS_TABLE)
          .select('*')
          .eq('request_id', gateway_request_id);

        if (gwRows && gwRows.length > 0) {
          return await processWebhookResult(gwRows[0], status, resultPayload, error);
        }
      }

      console.warn(`[FAL-WEBHOOK] No matching row found for request ${request_id}`);
      return json({ received: true });
    }

    return await processWebhookResult(rows[0], status, resultPayload, error);
  } catch (error) {
    console.error('[FAL-WEBHOOK] Error processing webhook:', error.message);
    // Always return 200 to acknowledge receipt (fal.ai will retry otherwise)
    return json({ received: true });
  }
}

/**
 * Process a completed webhook result: save image to storage, update DB, trigger Drive upload.
 */
async function processWebhookResult(row, status, resultPayload, error) {
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

    return json({ received: true });
  }

  // Extract image URL from the result payload
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

    return json({ received: true });
  }

  // ── Improvement: Use fal.ai CDN URL directly ──
  // Fal.ai serves results via their CDN (v3.fal.media).
  // We store the CDN URL directly and optionally mirror to Supabase.
  // This is faster than downloading + re-uploading.
  let storedUrl = imageUrl;

  // Optionally mirror to Supabase storage for redundancy
  try {
    storedUrl = await copyImageToStorage(imageUrl, row.queue_item_id, row.view_id);
  } catch (storageErr) {
    console.warn(`[FAL-WEBHOOK] Failed to mirror to Supabase storage for item ${row.queue_item_id}:`, storageErr.message);
    // Fall back to fal.ai CDN URL
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

  // Check if all 5 views are done and trigger Drive upload
  try {
    await maybeUploadToDrive(row.queue_item_id);
  } catch (driveErr) {
    console.error(`[FAL-WEBHOOK] Drive upload check failed for item ${row.queue_item_id}:`, driveErr.message);
  }

  return json({ received: true });
}

/**
 * Copy image from fal.ai CDN to Supabase storage for persistence.
 */
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

/**
 * Check if all 5 views for an item are done and trigger Drive upload.
 */
async function maybeUploadToDrive(itemId) {
  // Fetch the queue item
  const { data: items, error: fetchError } = await supabase
    .from(QUEUE_TABLE)
    .select('*')
    .eq('id', itemId);

  if (fetchError || !items || items.length === 0) {
    console.log(`[FAL-WEBHOOK] Item ${itemId} not found`);
    return;
  }

  const item = items[0];

  // Already uploaded — skip
  // BUGFIX: Check for non-empty strings to avoid false positives
  // from empty string defaults in the database schema
  if ((item.drive_folder_id && item.drive_folder_id !== '') || (item.drive_folder_name && item.drive_folder_name !== '')) {
    console.log(`[FAL-WEBHOOK] Item ${itemId} already uploaded to "${item.drive_folder_name}"`);
    return;
  }

  // Check env var
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return;
  }

  // Fetch latest render results for this item
  const { data: rows, error: resultsError } = await supabase
    .from(RESULTS_TABLE)
    .select('*')
    .eq('queue_item_id', itemId)
    .order('view_id', { ascending: true });

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

  if (doneViews.length === 5) {
    try {
      await updateDriveUploadState(item.id, {
        drive_upload_status: 'uploading',
        drive_upload_done: 0,
        drive_upload_total: doneViews.length,
        drive_upload_error: '',
        updated_at: new Date().toISOString()
      });

      const driveResult = await uploadRendersToDrive(item.id, item.name, doneViews, {
        onProgress: progress => updateDriveUploadState(item.id, {
          drive_upload_status: progress.status,
          drive_upload_done: progress.uploaded,
          drive_upload_total: progress.total,
          drive_upload_error: progress.status === 'error' ? progress.message || 'Drive upload incomplete' : '',
          drive_folder_id: progress.folderId || item.drive_folder_id || '',
          drive_folder_name: progress.folderName || item.drive_folder_name || '',
          updated_at: new Date().toISOString()
        })
      });

      await updateDriveUploadState(item.id, {
        drive_folder_id: driveResult.folderId,
        drive_folder_name: driveResult.folderName,
        drive_upload_status: driveResult.files.length === doneViews.length ? 'done' : 'error',
        drive_upload_done: driveResult.files.length,
        drive_upload_total: doneViews.length,
        drive_upload_error: driveResult.files.length === doneViews.length ? '' : 'Some files failed to upload',
        updated_at: new Date().toISOString()
      });

      console.log(`[FAL-WEBHOOK] SUCCESS: Uploaded ${item.name} to Drive folder "${driveResult.folderName}"`);
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

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
