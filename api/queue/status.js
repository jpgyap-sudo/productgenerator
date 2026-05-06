// GET /api/queue/status
// Polls Supabase and reconciles any durable render jobs that finished
// while the browser was closed or reloading.
//
// PROVIDER SUPPORT: Supports 'fal' (default), 'gemini', and 'openai'.
// - fal: Uses fal.ai queue-based API with webhook support (reconciliation polls fal.ai)
// - gemini: Uses Google Gemini API directly (synchronous, no queue to poll)
// - openai: Uses OpenAI GPT Image 2 API directly (synchronous, no queue to poll)
import { supabase, QUEUE_TABLE, RESULTS_TABLE, BUCKET_NAME } from '../../lib/supabase.js';
import { getQueuedResult, extractImageUrl, getAttemptCount, submitViewJob, VIEWS } from '../../lib/fal.js';
import { uploadRendersToDrive } from '../../lib/drive.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 300
};

// ── Improvement: In-memory cache with longer TTL ──
// Since webhooks handle most completions, the status endpoint is mostly
// read-only. Cache can be more aggressive.
const cache = {
  data: null,
  key: null,
  timestamp: 0,
  TTL: 2000 // 2 seconds
};

function getCached(key) {
  if (cache.data && Date.now() - cache.timestamp < cache.TTL && cache.key === key) {
    return cache.data;
  }
  return null;
}

function setCached(key, data) {
  cache.data = data;
  cache.key = key;
  cache.timestamp = Date.now();
}

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    // BUGFIX: In Vercel serverless, req.url is a relative path (e.g. '/api/queue/status')
    // new URL() requires a full URL, so provide the host header as base
    const url = new URL(req.url, `https://${req.headers.get('host') || 'localhost'}`);
    const itemId = url.searchParams.get('itemId');

    const { data: queueItems, error: queueError } = await fetchQueueItems(itemId);
    if (queueError) throw queueError;

    if (!queueItems || queueItems.length === 0) {
      return json({
        queue: [],
        renderResults: {},
        hasActiveItems: false,
        hasPendingItems: false
      });
    }

    const itemIds = queueItems.map(item => item.id);
    const { data: renderRows, error: resultsError } = await supabase
      .from(RESULTS_TABLE)
      .select('*')
      .in('queue_item_id', itemIds)
      .order('view_id', { ascending: true });

    if (resultsError) throw resultsError;

    // ── Improvement: Only reconcile rows that are still 'generating' ──
    // With webhooks, most completed jobs are already updated in the DB.
    // We only need to check rows that are still 'generating' or 'waiting'.
    const rowsWithActiveItems = await ensureRowsForActiveItems(renderRows || [], queueItems);
    const reconciledRows = await reconcileFalJobs(rowsWithActiveItems, queueItems);
    await updateQueueStatuses(queueItems, reconciledRows);

    const { data: refreshedQueue, error: refreshedQueueError } = await fetchQueueItems(itemId);
    if (refreshedQueueError) throw refreshedQueueError;

    const { data: refreshedRows, error: refreshedRowsError } = await supabase
      .from(RESULTS_TABLE)
      .select('*')
      .in('queue_item_id', itemIds)
      .order('view_id', { ascending: true });

    if (refreshedRowsError) throw refreshedRowsError;

    const queue = refreshedQueue || queueItems;
    const rows = refreshedRows || reconciledRows;

    const response = {
      queue: queue.map(item => ({
        id: item.id,
        name: item.name,
        imageUrl: item.image_url || '',
        status: item.status,
        description: item.description || '',
        driveFolderId: item.drive_folder_id || '',
        driveFolderName: item.drive_folder_name || '',
        driveUploadStatus: item.drive_upload_status || '',
        driveUploadDone: item.drive_upload_done || 0,
        driveUploadTotal: item.drive_upload_total || 0,
        driveUploadError: item.drive_upload_error || '',
        updatedAt: item.updated_at
      })),
      renderResults: groupResults(rows),
      hasActiveItems: queue.some(item => item.status === 'active'),
      hasPendingItems: queue.some(item => item.status === 'wait')
    };

    return json(response, 200, {
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
  } catch (error) {
    console.error('Queue status error:', error);
    return json({ error: error.message || 'Internal server error' }, 500);
  }
}

function fetchQueueItems(itemId) {
  let query = supabase
    .from(QUEUE_TABLE)
    .select('*')
    .order('id', { ascending: true });

  if (itemId) query = query.eq('id', parseInt(itemId, 10));
  return query;
}

/**
 * Reconcile render jobs that are still in progress.
 *
 * IMPROVEMENT: With webhooks, most fal.ai jobs are handled server-side.
 * This reconciliation is a fallback for jobs that complete without
 * a webhook delivery (e.g., webhook timeout, network issues).
 * Fal.ai retries webhooks 10x over 2 hours, so this is a safety net.
 *
 * PROVIDER SUPPORT:
 * - fal rows: Poll fal.ai queue status for completion
 * - gemini rows: Skip reconciliation (Gemini is synchronous, handled by
 *   the background worker in process-item.js)
 */
async function reconcileFalJobs(rows, queueItems) {
  const nextRows = [];
  const itemsById = new Map(queueItems.map(item => [item.id, item]));

  for (const row of rows) {
    // ── Improvement: Skip rows that are already done or errored ──
    // Webhook handler already updated these. No need to re-check.
    // However, if the row is 'done' but has a CDN URL (not Supabase),
    // we should attempt to mirror it to Supabase for persistence.
    if (row.status === 'done' || row.status === 'error') {
      nextRows.push(row);
      continue;
    }

    // ── Gemini / OpenAI providers: skip reconciliation ──
    // Both Gemini and OpenAI are synchronous and handled by the background
    // worker (process-item.js). The worker updates the DB directly when done.
    // No fal.ai queue to poll. The provider is stored on the queue item,
    // not on the render result row.
    // NOTE: We use startsWith() for sub_text checks because process-item.js
    // may overwrite the sub_text with a slightly different string (e.g.
    // "Generating 5 views with OpenAI..."). The exact match fallback is
    // for backward compatibility with previously submitted items.
    const queueItem = itemsById.get(row.queue_item_id);
    if (queueItem && (
      queueItem.provider === 'gemini' ||
      queueItem.provider === 'openai' ||
      (queueItem.sub_text && (
        queueItem.sub_text.startsWith('Generating with Gemini') ||
        queueItem.sub_text.startsWith('Generating with OpenAI') ||
        queueItem.sub_text.startsWith('Generating 5 views with Gemini') ||
        queueItem.sub_text.startsWith('Generating 5 views with OpenAI')
      ))
    )) {
      nextRows.push(row);
      continue;
    }

    if (row.status === 'waiting') {
      const item = itemsById.get(row.queue_item_id);
      const submitted = await submitWaitingRow(row, item);
      nextRows.push(submitted);
      continue;
    }

    if (row.status !== 'generating') {
      nextRows.push(row);
      continue;
    }

    try {
      const queued = await getQueuedResult(row);
      if (queued.state === 'pending') {
        nextRows.push(row);
        continue;
      }

      if (queued.state === 'error') {
        const updated = {
          ...row,
          status: 'error',
          error_message: queued.error || 'Render failed',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await saveResultRow(updated);
        nextRows.push(updated);
        continue;
      }

      const imageUrl = extractImageUrl(queued.result);
      if (!imageUrl) {
        const updated = {
          ...row,
          status: 'error',
          error_message: 'No image URL in fal response',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await saveResultRow(updated);
        nextRows.push(updated);
        continue;
      }

      // ── Improvement: Try to use fal.ai CDN URL directly ──
      // Only mirror to Supabase storage if the CDN URL might expire.
      // Fal.ai CDN URLs (v3.fal.media) are publicly accessible.
      const storedUrl = await copyImageToStorage(imageUrl, row.queue_item_id, row.view_id);
      const updated = {
        ...row,
        status: 'done',
        image_url: storedUrl || imageUrl,
        error_message: '',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      await saveResultRow(updated);
      nextRows.push(updated);

      // Trigger Drive upload immediately if all 5 views are done
      try {
        await maybeUploadToDrive(row.queue_item_id, itemsById);
      } catch (driveErr) {
        console.error(`[RECONCILE] Drive upload check failed for item ${row.queue_item_id}:`, driveErr.message);
      }
    } catch (error) {
      console.error(`Failed to reconcile item ${row.queue_item_id} view ${row.view_id}:`, error);
      nextRows.push(row);
    }
  }

  return nextRows;
}

async function ensureRowsForActiveItems(rows, queueItems) {
  const nextRows = [...rows];
  const rowsByItemId = new Map();
  for (const row of rows) {
    if (!rowsByItemId.has(row.queue_item_id)) rowsByItemId.set(row.queue_item_id, []);
    rowsByItemId.get(row.queue_item_id).push(row);
  }

  const now = new Date().toISOString();
  const missingRows = [];
  for (const item of queueItems) {
    if (item.status !== 'active') continue;
    // Skip Gemini and OpenAI items — their render rows are created by
    // submit.js before the background worker is triggered. If no rows
    // exist yet, the worker will create them. Don't create waiting rows
    // here that would confuse the reconciliation logic.
    if (
      item.provider === 'gemini' || item.sub_text === 'Generating with Gemini...' ||
      item.provider === 'openai' || item.sub_text === 'Generating with OpenAI...'
    ) continue;
    const itemRows = rowsByItemId.get(item.id) || [];
    if (itemRows.length > 0) continue;

    for (const view of VIEWS) {
      missingRows.push({
        queue_item_id: item.id,
        view_id: view.id,
        status: 'waiting',
        image_url: '',
        error_message: '',
        request_id: '',
        response_url: '',
        status_url: '',
        started_at: null,
        completed_at: null,
        created_at: now,
        updated_at: now
      });
    }
  }

  if (missingRows.length === 0) return nextRows;

  const { error } = await supabase
    .from(RESULTS_TABLE)
    .upsert(missingRows, { onConflict: 'queue_item_id,view_id' });

  if (error) throw error;
  nextRows.push(...missingRows);
  return nextRows;
}

async function submitWaitingRow(row, item) {
  const now = new Date().toISOString();

  if (!item?.image_url) {
    const updated = {
      ...row,
      status: 'error',
      error_message: 'No reference image',
      completed_at: now,
      updated_at: now
    };
    await saveResultRow(updated);
    return updated;
  }

  const view = VIEWS.find(v => v.id === row.view_id);
  if (!view) {
    const updated = {
      ...row,
      status: 'error',
      error_message: 'Unknown render view',
      completed_at: now,
      updated_at: now
    };
    await saveResultRow(updated);
    return updated;
  }

  let lastError = null;
  for (let attempt = 0; attempt < getAttemptCount(); attempt++) {
    try {
      // ── Improvement: Derive webhook URL from environment ──
      // This ensures fal.ai notifies us when the job completes,
      // even if the client tab is closed.
      const webhookUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}/api/fal-webhook`
        : undefined;

      // BUGFIX: Use item.resolution if available, otherwise default to '1K'
      // The resolution is set during initial submission in submit.js
      const resolution = item.resolution || '1K';

      const queued = await submitViewJob(
        view,
        item.description || '',
        item.image_url,
        resolution,
        attempt,
        webhookUrl ? { webhookUrl } : {}
      );
      const updated = {
        ...row,
        status: 'generating',
        request_id: queued.request_id || '',
        response_url: queued.response_url || '',
        status_url: queued.status_url || '',
        cancel_url: queued.cancel_url || '',
        queue_position: queued.queue_position != null ? queued.queue_position : null,
        attempt_index: queued.attempt || 0,
        attempt_label: queued.attempt_label || '',
        error_message: '',
        started_at: row.started_at || now,
        completed_at: null,
        updated_at: now
      };
      await saveSubmittedRow(updated);
      return updated;
    } catch (error) {
      lastError = error;
      console.error(`fal submit attempt ${attempt + 1} failed for item ${row.queue_item_id} view ${row.view_id}:`, error);
    }
  }

  const updated = {
    ...row,
    status: 'error',
    error_message: lastError?.message || 'Failed to submit fal queue job',
    completed_at: now,
    updated_at: now
  };
  await saveResultRow(updated);
  return updated;
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

async function saveResultRow(row) {
  const { error } = await supabase
    .from(RESULTS_TABLE)
    .update({
      status: row.status,
      image_url: row.image_url || '',
      error_message: row.error_message || '',
      completed_at: row.completed_at || null,
      updated_at: row.updated_at || new Date().toISOString()
    })
    .eq('queue_item_id', row.queue_item_id)
    .eq('view_id', row.view_id);

  if (error) throw error;
}

async function saveSubmittedRow(row) {
  const { error } = await supabase
    .from(RESULTS_TABLE)
    .update({
      status: row.status,
      request_id: row.request_id || '',
      response_url: row.response_url || '',
      status_url: row.status_url || '',
      attempt_index: row.attempt_index || 0,
      attempt_label: row.attempt_label || '',
      error_message: row.error_message || '',
      started_at: row.started_at || new Date().toISOString(),
      completed_at: null,
      updated_at: row.updated_at || new Date().toISOString()
    })
    .eq('queue_item_id', row.queue_item_id)
    .eq('view_id', row.view_id);

  if (error) throw error;
}

async function updateQueueStatuses(queueItems, rows) {
  console.log(`[STATUS] updateQueueStatuses called for ${queueItems.length} items, ${rows.length} rows`);

  const updates = [];

  for (const item of queueItems) {
    if (item.status === 'stopped') continue;

    const itemRows = rows.filter(row => row.queue_item_id === item.id);
    if (itemRows.length === 0) continue;

    const doneCount = itemRows.filter(row => row.status === 'done').length;
    const errorCount = itemRows.filter(row => row.status === 'error').length;
    const activeCount = itemRows.filter(row => row.status === 'generating' || row.status === 'waiting').length;

    let status = item.status;
    let subText = item.sub_text || '';

    console.log(`[STATUS] Item ${item.id} (${item.name}): done=${doneCount}, error=${errorCount}, active=${activeCount}, currentStatus=${item.status}, driveFolder=${item.drive_folder_name || 'none'}`);

    if (activeCount > 0) {
      status = 'active';
      subText = `${doneCount}/5 views completed`;
    } else if (doneCount === 5) {
      status = 'done';
      subText = 'All 5 views generated';

      // Auto-upload completed renders to Google Drive
      const hasDriveEnv = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      // BUGFIX: Check for non-empty strings to avoid false positives
      // from empty string defaults in the database schema
      const alreadyUploaded = !!(item.drive_folder_id && item.drive_folder_id !== '') || !!(item.drive_folder_name && item.drive_folder_name !== '');
      console.log(`[STATUS] Item ${item.id} all done. hasDriveEnv=${hasDriveEnv}, alreadyUploaded=${alreadyUploaded}`);

      if (hasDriveEnv && !alreadyUploaded) {
        try {
          const doneViews = itemRows
            .filter(row => row.status === 'done' && row.image_url)
            .map(row => ({
              viewId: row.view_id,
              viewLabel: getViewLabel(row.view_id),
              imageUrl: row.image_url
            }));

          console.log(`[STATUS] Attempting Drive upload for item ${item.id} with ${doneViews.length} views`);

          if (doneViews.length === 5) {
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

            console.log(`[STATUS] SUCCESS: Uploaded ${item.name} to Drive folder "${driveResult.folderName}"`);
          } else {
            console.log(`[STATUS] Skipped Drive upload: only ${doneViews.length}/5 views have image URLs`);
          }
        } catch (driveErr) {
          console.error(`[STATUS] Drive upload FAILED for item ${item.id}:`, driveErr.message);
        }
      } else if (alreadyUploaded) {
        console.log(`[STATUS] Skipped Drive upload: already uploaded to ${item.drive_folder_name}`);
      } else {
        console.log(`[STATUS] Skipped Drive upload: GOOGLE_SERVICE_ACCOUNT_JSON not set`);
      }
    } else if (errorCount > 0) {
      status = 'error';
      subText = errorCount === 5
        ? 'All views failed'
        : `${doneCount}/5 views generated, ${errorCount} failed`;
    }

    if (status !== item.status || subText !== item.sub_text) {
      updates.push({
        id: item.id,
        status,
        sub_text: subText,
        updated_at: new Date().toISOString()
      });
    }
  }

  // Apply all status updates
  if (updates.length > 0) {
    for (const update of updates) {
      await supabase
        .from(QUEUE_TABLE)
        .update({ status: update.status, sub_text: update.sub_text, updated_at: update.updated_at })
        .eq('id', update.id);
    }
    console.log(`[STATUS] Batch updated ${updates.length} items`);
  }
}

/**
 * Check if all 5 views for an item are done and trigger Drive upload.
 * Called from reconcileFalJobs when a view transitions to 'done'.
 */
async function maybeUploadToDrive(itemId, itemsById) {
  const item = itemsById.get(itemId);
  if (!item) {
    console.log(`[MAYBE_UPLOAD] Item ${itemId} not found in itemsById`);
    return;
  }

  // Already uploaded — skip
  // BUGFIX: Check for non-empty strings to avoid false positives
  // from empty string defaults in the database schema
  if ((item.drive_folder_id && item.drive_folder_id !== '') || (item.drive_folder_name && item.drive_folder_name !== '')) {
    console.log(`[MAYBE_UPLOAD] Item ${itemId} already uploaded to "${item.drive_folder_name}"`);
    return;
  }

  // Check env var
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log(`[MAYBE_UPLOAD] GOOGLE_SERVICE_ACCOUNT_JSON not set`);
    return;
  }

  // Fetch latest render results for this item
  const { data: rows, error } = await supabase
    .from(RESULTS_TABLE)
    .select('*')
    .eq('queue_item_id', itemId)
    .order('view_id', { ascending: true });

  if (error) {
    console.error(`[MAYBE_UPLOAD] Failed to fetch results for item ${itemId}:`, error.message);
    return;
  }

  const doneCount = rows.filter(row => row.status === 'done').length;
  const doneViews = rows
    .filter(row => row.status === 'done' && row.image_url)
    .map(row => ({
      viewId: row.view_id,
      viewLabel: getViewLabel(row.view_id),
      imageUrl: row.image_url
    }));

  console.log(`[MAYBE_UPLOAD] Item ${itemId}: ${doneCount}/5 done, ${doneViews.length} with image URLs`);

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

      // Update local cache
      item.drive_folder_id = driveResult.folderId;
      item.drive_folder_name = driveResult.folderName;

      console.log(`[MAYBE_UPLOAD] SUCCESS: Uploaded ${item.name} to Drive folder "${driveResult.folderName}"`);
    } catch (driveErr) {
      console.error(`[MAYBE_UPLOAD] FAILED for item ${itemId}:`, driveErr.message);
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

function groupResults(rows) {
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.queue_item_id]) grouped[row.queue_item_id] = [];
    grouped[row.queue_item_id].push({
      viewId: row.view_id,
      status: row.status,
      imageUrl: row.image_url || null,
      errorMessage: row.error_message || null,
      startedAt: row.started_at,
      completedAt: row.completed_at
    });
  }
  return grouped;
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders
    }
  });
}
