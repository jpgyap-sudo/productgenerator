// ═══════════════════════════════════════════════════════════════════
//  POST /api/process-item — Background worker
//  Called by submit.js via waitUntil(). Processes queue items by:
//  1. Generating all 4 views in parallel via the selected AI provider
//  2. Saving results to Supabase (render_results table + storage)
//  3. Updating queue item status
//
//  PROVIDER SUPPORT: Supports 'fal' (default), 'gemini', and 'openai'.
//  - fal: Uses fal.ai queue-based API with webhook support
//  - gemini: Uses Google Gemini API directly (synchronous, no queue)
//  - openai: Uses OpenAI GPT Image 2 API directly (synchronous, no queue)
// ═══════════════════════════════════════════════════════════════════
import { supabase, QUEUE_TABLE, RESULTS_TABLE, BUCKET_NAME } from '../lib/supabase.js';
import { generateView, VIEWS } from '../lib/fal.js';
import { generateGeminiView } from '../lib/gemini.js';
import { generateOpenAIView } from '../lib/openai.js';
import { uploadRendersToDrive } from '../lib/drive.js';
import { createRenderZipOnVps, saveRenderImageToVps } from '../lib/vps-storage.js';
import { saveCompletedBatch } from '../lib/completed-batches.js';

export const config = {
  runtime: 'nodejs',
  // Allow up to 300 seconds (5 minutes) for background processing
  // Each view generation uses fal.ai queue-based API with polling,
  // so we need enough time for all 4 parallel generations + fallbacks
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
    // BUGFIX: In Vercel serverless, req.url is a relative path (e.g. '/api/process-item')
    // new URL() requires a full URL, so provide the host header as base
    const url = new URL(req.url, `https://${req.headers.get('host') || 'localhost'}`);
    const idsParam = url.searchParams.get('ids');
    const resolution = url.searchParams.get('res') || '1K';
    const provider = url.searchParams.get('provider') || 'fal';

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
      await processItem(itemId, resolution, provider);
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
 * Process a single queue item: generate 4 views, save results.
 *
 * @param {number} itemId - Queue item ID
 * @param {string} resolution - Resolution setting (e.g., '1K')
 * @param {string} provider - AI provider to use: 'fal' (default) or 'gemini'
 */
async function processItem(itemId, resolution, provider = 'fal') {
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
    // Use a provider-specific sub_text so status.js can identify
    // non-fal.ai providers even if the provider column is missing
    const providerLabel = provider === 'gemini' ? 'Gemini'
      : provider === 'openai' ? 'OpenAI'
      : 'fal.ai';
    await updateItemStatus(itemId, 'active', `Generating 4 views with ${providerLabel}...`);
    await updateAllViewStatuses(itemId, 'generating', null);

    // Step 2: Generate all 4 views in parallel
    // Provider selection:
    //   - 'fal' (default): Uses fal.ai queue-based API with webhook support.
    //     Returns fal.ai CDN URLs directly — no redundant download/upload.
    //   - 'gemini': Uses Google Gemini API directly (synchronous).
    //     Returns Supabase storage URLs (Gemini returns inline base64 images).
    //   - 'openai': Uses OpenAI GPT Image 2 API directly (synchronous).
    //     Returns Supabase storage URLs (OpenAI returns b64_json).
    const generateFn = provider === 'gemini' ? generateGeminiView
      : provider === 'openai' ? generateOpenAIView
      : generateView;
    const brand = item.brand || '';
    const results = await Promise.allSettled(
      VIEWS.map(view => generateFn(view, desc, imageUrl, resolution, brand))
    );

    // Step 3: Save results
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < VIEWS.length; i++) {
      const view = VIEWS[i];
      const result = results[i];

      if (result.status === 'fulfilled' && result.value) {
        // Success only counts after the image URL is persisted.
        try {
          const cdnUrl = result.value.cdnUrl;
          if (!cdnUrl) {
            throw new Error('Generator returned no image URL');
          }

          // ── Provider-specific URL handling ──
          // fal.ai: Returns CDN URLs (v3.fal.media). We optionally mirror to
          //   Supabase storage for redundancy, then store the Supabase URL.
          // gemini: generateGeminiView() already uploads to Supabase storage
          //   and returns the public URL directly. No mirroring needed.
          // openai: generateOpenAIView() already uploads to Supabase storage
          //   and returns the public URL directly. No mirroring needed.
          let publicUrl = cdnUrl;

          // Only mirror to Supabase for fal.ai results (Gemini and OpenAI
          // results are already stored in Supabase by their respective
          // generate functions)
          if (provider !== 'gemini' && provider !== 'openai') {
            try {
              const imgRes = await fetch(cdnUrl);
              if (imgRes.ok) {
                // BUGFIX: Detect content type from response to use correct extension
                const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
                const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
                const fileName = `renders/${itemId}_view${view.id}_${Date.now()}.${ext}`;
                const buffer = Buffer.from(await imgRes.arrayBuffer());
                const { error: uploadError } = await supabase.storage
                  .from(BUCKET_NAME)
                  .upload(fileName, buffer, {
                    contentType,
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
          }

          const stored = await saveRenderImageToVps(publicUrl, itemId, view, item.name);
          publicUrl = stored.publicUrl;

          // Update render_results row
          const { error: saveError } = await supabase
            .from(RESULTS_TABLE)
            .update({
              status: 'done',
              image_url: publicUrl,
              error_message: '',
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('queue_item_id', itemId)
            .eq('view_id', view.id);

          if (saveError) throw saveError;
          successCount++;
        } catch (saveErr) {
          console.error(`Failed to save result for item ${itemId} view ${view.id}:`, saveErr);
          failCount++;
          await supabase
            .from(RESULTS_TABLE)
            .update({
              status: 'error',
              image_url: '',
              error_message: saveErr.message || 'Failed to save image URL',
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('queue_item_id', itemId)
            .eq('view_id', view.id);
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
    const finalStatus = successCount === 4 ? 'done' : 'error';
    const statusText = successCount === 4
      ? 'All 4 views generated'
      : `${successCount}/4 views generated`;
    await updateItemStatus(itemId, finalStatus, statusText);

    // Step 5: Store ZIP on VPS and trigger Drive upload if all 4 views completed
    if (successCount === 4) {
      const { data: zipRows } = await supabase
        .from(RESULTS_TABLE)
        .select('*')
        .eq('queue_item_id', itemId)
        .eq('status', 'done');

      if (zipRows && zipRows.length === 4) {
        let zipUrl = '';
        try {
          const zipResult = await createRenderZipOnVps(itemId, item.name, zipRows.map(row => ({
            viewId: row.view_id,
            imageUrl: row.image_url
          })));
          zipUrl = zipResult.publicUrl;
        } catch (zipErr) {
          console.warn(`[PROCESS] Failed to store VPS ZIP for item ${itemId}:`, zipErr.message);
        }

        try {
          await saveCompletedBatch({
            id: itemId,
            name: item.name,
            imageUrl: item.image_url || '',
            status: finalStatus,
            provider,
            apiModel: provider === 'gemini'
              ? 'gemini-3.1-flash-image-preview / gemini-3-pro-image-preview'
              : provider === 'openai'
                ? process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5'
                : 'fal.ai',
            updatedAt: new Date().toISOString(),
            zipUrl,
            viewResults: zipRows.map(row => ({
              viewId: row.view_id,
              status: row.status,
              imageUrl: row.image_url,
              errorMessage: row.error_message || null,
              completedAt: row.completed_at || null
            }))
          });
        } catch (storeErr) {
          console.warn(`[PROCESS] Failed to save completed batch index for item ${itemId}:`, storeErr.message);
        }
      }

      try {
        const hasDriveEnv = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
        if (hasDriveEnv) {
          // Fetch the item to check if already uploaded
          const { data: updatedItems } = await supabase
            .from(QUEUE_TABLE)
            .select('*')
            .eq('id', itemId);

          if (updatedItems && updatedItems.length > 0) {
            const updatedItem = updatedItems[0];

            // Check if upload is already in progress or completed
            if (updatedItem.drive_upload_status === 'uploading') return;

            const alreadyUploaded = !!(updatedItem.drive_folder_id && updatedItem.drive_folder_id !== '')
              || !!(updatedItem.drive_folder_name && updatedItem.drive_folder_name !== '');

            if (!alreadyUploaded) {
              // Fetch all done views
              const { data: doneRows } = await supabase
                .from(RESULTS_TABLE)
                .select('*')
                .eq('queue_item_id', itemId)
                .eq('status', 'done');

              if (doneRows && doneRows.length === 4) {
                const doneViews = doneRows.map(row => ({
                  viewId: row.view_id,
                  viewLabel: getViewLabel(row.view_id),
                  imageUrl: row.image_url
                }));

                await updateDriveUploadState(itemId, {
                  drive_upload_status: 'uploading',
                  drive_upload_done: 0,
                  drive_upload_total: doneViews.length,
                  drive_upload_error: '',
                  updated_at: new Date().toISOString()
                });

                const driveResult = await uploadRendersToDrive(itemId, updatedItem.name, doneViews, {
                  folderName: updatedItem.drive_folder_name || '',
                  onProgress: progress => updateDriveUploadState(itemId, {
                    drive_upload_status: progress.status,
                    drive_upload_done: progress.uploaded,
                    drive_upload_total: progress.total,
                    drive_upload_error: progress.status === 'error' ? progress.message || 'Drive upload incomplete' : '',
                    drive_folder_id: progress.folderId || updatedItem.drive_folder_id || '',
                    drive_folder_name: progress.folderName || updatedItem.drive_folder_name || '',
                    updated_at: new Date().toISOString()
                  })
                });

                await updateDriveUploadState(itemId, {
                  drive_folder_id: driveResult.folderId,
                  drive_folder_name: driveResult.folderName,
                  drive_upload_status: driveResult.files.length === doneViews.length ? 'done' : 'error',
                  drive_upload_done: driveResult.files.length,
                  drive_upload_total: doneViews.length,
                  drive_upload_error: driveResult.files.length === doneViews.length ? '' : 'Some files failed to upload',
                  updated_at: new Date().toISOString()
                });

                console.log(`[PROCESS] SUCCESS: Uploaded item ${itemId} to Drive folder "${driveResult.folderName}"`);
              }
            }
          }
        }
      } catch (driveErr) {
        await updateDriveUploadState(itemId, {
          drive_upload_status: 'error',
          drive_upload_error: driveErr.message || 'Drive upload failed',
          updated_at: new Date().toISOString()
        });
        console.error(`[PROCESS] Drive upload failed for item ${itemId}:`, driveErr.message);
      }
    }

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

/**
 * Get a human-readable label for a view ID.
 */
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
