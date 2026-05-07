// ═══════════════════════════════════════════════════════════════════
//  GET /api/queue/status — Express route handler
//  Returns queue state and render results from Supabase.
//
//  VPS ADAPTATION:
//  - Removed Vercel config export
//  - Uses Express req.query instead of URL parsing from req.url
//  - Uses Express res.json() instead of custom json() helper
//  - Removed fal.ai reconciliation (not used on VPS)
//  - Removed @vercel/functions dependency
// ═══════════════════════════════════════════════════════════════════
import { supabase, QUEUE_TABLE, RESULTS_TABLE, BUCKET_NAME } from '../../lib/supabase.js';
import { VIEWS } from '../../lib/fal.js';
import { uploadRendersToDrive } from '../../lib/drive.js';

const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5';

// In-memory cache with 2 second TTL
const cache = {
  data: null,
  key: null,
  timestamp: 0,
  TTL: 2000
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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const itemId = req.query.itemId || null;

    const { data: queueItems, error: queueError } = await fetchQueueItems(itemId);
    if (queueError) throw queueError;

    if (!queueItems || queueItems.length === 0) {
      return res.json({
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

    // Ensure render rows exist for active items
    const rowsWithActiveItems = await ensureRowsForActiveItems(renderRows || [], queueItems);

    // Update queue statuses based on render results
    await updateQueueStatuses(queueItems, rowsWithActiveItems);

    // Fetch fresh data after updates
    const { data: refreshedQueue, error: refreshedQueueError } = await fetchQueueItems(itemId);
    if (refreshedQueueError) throw refreshedQueueError;

    const { data: refreshedRows, error: refreshedRowsError } = await supabase
      .from(RESULTS_TABLE)
      .select('*')
      .in('queue_item_id', itemIds)
      .order('view_id', { ascending: true });

    if (refreshedRowsError) throw refreshedRowsError;

    const queue = refreshedQueue || queueItems;
    const rows = refreshedRows || rowsWithActiveItems;

    const response = {
      queue: queue.map(item => ({
        id: item.id,
        name: item.name,
        imageUrl: item.image_url || '',
        status: item.status,
        description: item.description || '',
        provider: item.provider || '',
        apiModel: getBatchApiModel(item.provider),
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

    return res.json(response);
  } catch (error) {
    console.error('[STATUS] Error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

function getBatchApiModel(provider) {
  if (provider === 'openai') return OPENAI_IMAGE_MODEL;
  if (provider === 'gemini') return 'gemini-3.1-flash-image-preview / gemini-3-pro-image-preview';
  return '';
}

function fetchQueueItems(itemId) {
  let query = supabase
    .from(QUEUE_TABLE)
    .select('*')
    .order('id', { ascending: true });

  if (itemId) query = query.eq('id', parseInt(itemId, 10));
  return query;
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

async function updateQueueStatuses(queueItems, rows) {
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

    if (activeCount > 0) {
      status = 'active';
      subText = `${doneCount}/4 views completed`;
    } else if (doneCount === 4) {
      status = 'done';
      subText = 'All 4 views generated';

      // Auto-upload completed renders to Google Drive
      const hasDriveEnv = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      const alreadyUploaded = !!(item.drive_folder_id && item.drive_folder_id !== '')
        || !!(item.drive_folder_name && item.drive_folder_name !== '');

      if (hasDriveEnv && !alreadyUploaded) {
        try {
          const doneViews = itemRows
            .filter(row => row.status === 'done' && row.image_url)
            .map(row => ({
              viewId: row.view_id,
              viewLabel: getViewLabel(row.view_id),
              imageUrl: row.image_url
            }));

          if (doneViews.length === 4) {
            await updateDriveUploadState(item.id, {
              drive_upload_status: 'uploading',
              drive_upload_done: 0,
              drive_upload_total: doneViews.length,
              drive_upload_error: '',
              updated_at: new Date().toISOString()
            });

            const driveResult = await uploadRendersToDrive(item.id, item.name, doneViews, {
              folderName: item.drive_folder_name || '',
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
          }
        } catch (driveErr) {
          console.error(`[STATUS] Drive upload FAILED for item ${item.id}:`, driveErr.message);
        }
      }
    } else if (errorCount > 0) {
      status = 'error';
      subText = errorCount === 4
        ? 'All views failed'
        : `${doneCount}/4 views generated, ${errorCount} failed`;
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

  if (updates.length > 0) {
    for (const update of updates) {
      await supabase
        .from(QUEUE_TABLE)
        .update({ status: update.status, sub_text: update.sub_text, updated_at: update.updated_at })
        .eq('id', update.id);
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
