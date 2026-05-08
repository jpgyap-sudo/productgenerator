// POST /api/queue/upload-drive
// Manually uploads a completed queue item's render_results images to Google Drive.
// Supports three modes:
//   1. Live mode: itemId references an existing product_queue row
//   2. Archive fallback: if itemId not found, uses viewResults + itemName from request body
//   3. Supabase fallback: if Supabase is unreachable, uses viewResults + itemName from request body
import { supabase, QUEUE_TABLE, RESULTS_TABLE } from '../../lib/supabase.js';
import { VIEWS } from '../../lib/fal.js';
import { uploadRendersToDrive, isSupabaseConnectionError } from '../../lib/drive.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const itemId = Number(req.body?.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: 'Valid itemId is required' });
  }

  // Need either OAuth2 (GOOGLE_DRIVE_REFRESH_TOKEN) or Service Account
  const hasOAuth2 = !!(process.env.GOOGLE_DRIVE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET && process.env.GOOGLE_DRIVE_REFRESH_TOKEN);
  const hasServiceAccount = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!hasOAuth2 && !hasServiceAccount) {
    return res.status(400).json({
      error: 'No Google Drive auth configured. Set GOOGLE_DRIVE_REFRESH_TOKEN (OAuth2) or GOOGLE_SERVICE_ACCOUNT_JSON (service account)'
    });
  }

  try {
    // ── Try to find the queue item in Supabase ──
    let items, itemError;
    try {
      const result = await supabase
        .from(QUEUE_TABLE)
        .select('*')
        .eq('id', itemId)
        .limit(1);
      items = result.data;
      itemError = result.error;
      if (itemError && isSupabaseConnectionError(itemError)) throw itemError;
    } catch (supaErr) {
      if (isSupabaseConnectionError(supaErr)) {
        console.log(`[UPLOAD-DRIVE] Supabase unreachable for item ${itemId}, falling back to archive fallback`);
        return await handleArchiveFallback(req, res, itemId);
      }
      throw supaErr;
    }

    if (itemError) throw itemError;
    const item = items?.[0];

    // ── ARCHIVE FALLBACK: Queue item not found, use request body data ──
    if (!item) {
      return await handleArchiveFallback(req, res, itemId);
    }

    if (item.drive_upload_status === 'uploading') {
      return res.status(409).json({ error: 'Google Drive upload is already in progress' });
    }

    const alreadyUploaded = !!(item.drive_folder_id && item.drive_folder_id !== '')
      || !!(item.drive_folder_name && item.drive_folder_name !== '');
    if (alreadyUploaded) {
      return res.json({
        success: true,
        alreadyUploaded: true,
        folderId: item.drive_folder_id || '',
        folderName: item.drive_folder_name || '',
        folderUrl: item.drive_folder_url || '',
        message: `Already uploaded to Google Drive${item.drive_folder_name ? `: ${item.drive_folder_name}` : ''}`
      });
    }

    let rows, rowsError;
    try {
      const result = await supabase
        .from(RESULTS_TABLE)
        .select('*')
        .eq('queue_item_id', itemId)
        .eq('status', 'done')
        .order('view_id', { ascending: true });
      rows = result.data;
      rowsError = result.error;
      if (rowsError && isSupabaseConnectionError(rowsError)) throw rowsError;
    } catch (supaErr) {
      if (isSupabaseConnectionError(supaErr)) {
        console.log(`[UPLOAD-DRIVE] Supabase unreachable for results of item ${itemId}, falling back to archive fallback`);
        return await handleArchiveFallback(req, res, itemId);
      }
      throw supaErr;
    }

    if (rowsError) throw rowsError;

    const doneViews = (rows || [])
      .filter(row => row.image_url)
      .map(row => ({
        viewId: row.view_id,
        viewLabel: getViewLabel(row.view_id),
        imageUrl: row.image_url
      }));

    if (doneViews.length !== VIEWS.length) {
      return res.status(400).json({
        error: `Need ${VIEWS.length} completed render images before uploading to Drive; found ${doneViews.length}`
      });
    }

    await updateDriveUploadState(itemId, {
      drive_upload_status: 'uploading',
      drive_upload_done: 0,
      drive_upload_total: doneViews.length,
      drive_upload_error: '',
      updated_at: new Date().toISOString()
    });

    const driveResult = await uploadRendersToDrive(itemId, item.name, doneViews, {
      folderName: item.drive_folder_name || '',
      onProgress: progress => updateDriveUploadState(itemId, {
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

    const success = driveResult.files.length === doneViews.length;
    await updateDriveUploadState(itemId, {
      drive_folder_id: driveResult.folderId,
      drive_folder_name: driveResult.folderName,
      drive_folder_url: driveResult.folderUrl || '',
      drive_upload_status: success ? 'done' : 'error',
      drive_upload_done: driveResult.files.length,
      drive_upload_total: doneViews.length,
      drive_upload_error: success ? '' : 'Some files failed to upload',
      updated_at: new Date().toISOString()
    });

    return res.json({
      success,
      folderId: driveResult.folderId,
      folderName: driveResult.folderName,
      folderUrl: driveResult.folderUrl || '',
      uploaded: driveResult.files.length,
      total: doneViews.length,
      message: success
        ? `Uploaded to Google Drive folder ${driveResult.folderName}`
        : `Uploaded ${driveResult.files.length}/${doneViews.length} files to Drive`
    });
  } catch (error) {
    await updateDriveUploadState(itemId, {
      drive_upload_status: 'error',
      drive_upload_error: error.message || 'Drive upload failed',
      updated_at: new Date().toISOString()
    });
    console.error('[UPLOAD-DRIVE] Error:', error);
    return res.status(500).json({ error: error.message || 'Drive upload failed' });
  }
}

/**
 * Handle upload from archived view results when the queue item no longer exists in Supabase.
 * Accepts viewResults (array of {viewId, imageUrl}) and itemName from the request body.
 */
async function handleArchiveFallback(req, res, itemId) {
  const { viewResults, itemName } = req.body || {};

  if (!viewResults || !Array.isArray(viewResults) || viewResults.length === 0) {
    return res.status(404).json({
      error: 'Queue item not found. This completed batch may only exist in browser archive; provide viewResults and itemName to upload from archived image URLs.',
      code: 'QUEUE_ITEM_NOT_FOUND'
    });
  }

  const doneViews = viewResults
    .filter(r => r.status === 'done' && r.imageUrl)
    .map(r => ({
      viewId: r.viewId,
      viewLabel: getViewLabel(r.viewId),
      imageUrl: r.imageUrl
    }));

  if (doneViews.length !== VIEWS.length) {
    return res.status(400).json({
      error: `Need ${VIEWS.length} completed render images before uploading to Drive; found ${doneViews.length} in archive`
    });
  }

  const name = itemName || `Item ${itemId}`;
  console.log(`[UPLOAD-DRIVE] Archive fallback: uploading ${doneViews.length} views for "${name}" (item ${itemId})`);

  const driveResult = await uploadRendersToDrive(itemId, name, doneViews, {
    folderName: '',
    onProgress: progress => {
      console.log(`[UPLOAD-DRIVE] Archive progress: ${progress.status} ${progress.uploaded}/${progress.total}`);
    }
  });

  const success = driveResult.files.length === doneViews.length;
  return res.json({
    success,
    folderId: driveResult.folderId,
    folderName: driveResult.folderName,
    folderUrl: driveResult.folderUrl || '',
    uploaded: driveResult.files.length,
    total: doneViews.length,
    fromArchive: true,
    message: success
      ? `Uploaded to Google Drive folder ${driveResult.folderName} (from archived images)`
      : `Uploaded ${driveResult.files.length}/${doneViews.length} files to Drive (from archived images)`
  });
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
