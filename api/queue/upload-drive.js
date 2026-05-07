// POST /api/queue/upload-drive
// Manually uploads a completed queue item's render_results images to Google Drive.
import { supabase, QUEUE_TABLE, RESULTS_TABLE } from '../../lib/supabase.js';
import { VIEWS } from '../../lib/fal.js';
import { uploadRendersToDrive } from '../../lib/drive.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const itemId = Number(req.body?.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: 'Valid itemId is required' });
  }

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return res.status(400).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON environment variable is not set' });
  }

  try {
    const { data: items, error: itemError } = await supabase
      .from(QUEUE_TABLE)
      .select('*')
      .eq('id', itemId)
      .limit(1);

    if (itemError) throw itemError;
    const item = items?.[0];
    if (!item) return res.status(404).json({ error: 'Queue item not found' });

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
        message: `Already uploaded to Google Drive${item.drive_folder_name ? `: ${item.drive_folder_name}` : ''}`
      });
    }

    const { data: rows, error: rowsError } = await supabase
      .from(RESULTS_TABLE)
      .select('*')
      .eq('queue_item_id', itemId)
      .eq('status', 'done')
      .order('view_id', { ascending: true });

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
        updated_at: new Date().toISOString()
      })
    });

    const success = driveResult.files.length === doneViews.length;
    await updateDriveUploadState(itemId, {
      drive_folder_id: driveResult.folderId,
      drive_folder_name: driveResult.folderName,
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
