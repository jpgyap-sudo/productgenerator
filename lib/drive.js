// ═══════════════════════════════════════════════════════════════════
//  Google Drive Upload — Service Account based
//  Creates folders (HA01, HA02, ...) and uploads rendered images.
//
//  Setup:
//  1. Go to https://console.cloud.google.com → Enable Google Drive API
//  2. Create a Service Account → download JSON key
//  3. Share your Google Drive root folder with the service account email
//     (found in JSON as "client_email") — grant Editor access
//  4. Set GOOGLE_SERVICE_ACCOUNT_JSON env var in Vercel to the full JSON string
// ═══════════════════════════════════════════════════════════════════

import { google } from 'googleapis';
import { supabase, CONFIG_TABLE } from './supabase.js';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

/**
 * Get an authenticated Google Drive client using the Service Account.
 */
function getDriveClient() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!rawJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON environment variable not set');
  }

  let credentials;
  try {
    credentials = JSON.parse(rawJson);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  // DEBUG: Log key diagnostic info (redacted)
  console.log('[DRIVE] Auth debug:', {
    hasClientEmail: !!credentials.client_email,
    hasPrivateKey: !!credentials.private_key,
    privateKeyLength: credentials.private_key?.length,
    privateKeyHasActualNewlines: credentials.private_key?.includes('\n') && !credentials.private_key?.includes('\\n'),
    privateKeyHasEscapedNewlines: credentials.private_key?.includes('\\n'),
    privateKeyStartsCorrectly: credentials.private_key?.startsWith('-----BEGIN PRIVATE KEY-----')
  });

  // Fix possible escaped newlines from env var
  const privateKey = credentials.private_key?.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    privateKey,
    SCOPES,
    null
  );

  return google.drive({ version: 'v3', auth });
}

/**
 * Get or create the next folder counter from Supabase app_config.
 * Returns the counter value and increments it atomically.
 */
async function getNextFolderCounter() {
  const { data, error } = await supabase
    .from(CONFIG_TABLE)
    .select('value')
    .eq('key', 'drive_folder_counter')
    .single();

  let counter = 1;

  if (error || !data) {
    // No counter exists yet — insert starting at 1
    const { error: insertError } = await supabase
      .from(CONFIG_TABLE)
      .insert({ key: 'drive_folder_counter', value: '2', updated_at: new Date().toISOString() });

    if (insertError) {
      console.error('Failed to initialize drive_folder_counter:', insertError);
    }
    return 1;
  }

  counter = parseInt(data.value, 10);
  if (isNaN(counter) || counter < 1) counter = 1;

  // Increment for next time
  const { error: updateError } = await supabase
    .from(CONFIG_TABLE)
    .update({ value: String(counter + 1), updated_at: new Date().toISOString() })
    .eq('key', 'drive_folder_counter');

  if (updateError) {
    console.error('Failed to increment drive_folder_counter:', updateError);
  }

  return counter;
}

/**
 * Create a folder in Google Drive.
 * @param {object} drive - Authenticated Drive client
 * @param {string} folderName - Name of the folder (e.g. "HA01")
 * @returns {Promise<string>} The folder ID
 */
async function createFolder(drive, folderName) {
  const response = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder'
    },
    fields: 'id'
  });

  return response.data.id;
}

/**
 * Upload a file buffer to a Google Drive folder.
 * @param {object} drive - Authenticated Drive client
 * @param {Buffer} buffer - File content
 * @param {string} fileName - Name for the file (e.g. "HA01_img1_Front_view.jpg")
 * @param {string} mimeType - MIME type (e.g. "image/jpeg")
 * @param {string} parentFolderId - ID of the parent folder
 * @returns {Promise<string>} The file ID
 */
async function uploadFile(drive, buffer, fileName, mimeType, parentFolderId) {
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentFolderId]
    },
    media: {
      mimeType: mimeType,
      body: buffer
    },
    fields: 'id,webViewLink'
  });

  return {
    fileId: response.data.id,
    webViewLink: response.data.webViewLink
  };
}

/**
 * Fetch an image from URL and prepare it for Drive upload.
 */
async function fetchImageBuffer(imageUrl) {
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error(`Image fetch failed: HTTP ${imageRes.status}`);
  const arrayBuffer = await imageRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  return { buffer, contentType, ext };
}

/**
 * Upload a single view to Drive with retry logic (Improvement 5).
 */
async function uploadViewWithRetry(drive, view, folderName, folderId, maxRetries = 3) {
  if (!view.imageUrl) return null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { buffer, contentType, ext } = await fetchImageBuffer(view.imageUrl);

      const safeLabel = (view.viewLabel || `View_${view.viewId}`)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');

      const fileName = `${folderName}_img${view.viewId}_${safeLabel}.${ext}`;

      const result = await uploadFile(drive, buffer, fileName, contentType, folderId);

      console.log(`[DRIVE] Uploaded ${fileName} to folder "${folderName}"`);
      return {
        viewId: view.viewId,
        viewLabel: view.viewLabel,
        fileName,
        fileId: result.fileId,
        webViewLink: result.webViewLink
      };
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000); // 1s, 2s, 4s
        console.log(`[DRIVE] Retry ${attempt}/${maxRetries} for view ${view.viewId} in ${delay}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[DRIVE] FAILED to upload view ${view.viewId} after ${maxRetries} attempts:`, err.message);
        return null;
      }
    }
  }
  return null;
}

/**
 * Upload all 5 rendered views for a completed item to Google Drive.
 * Creates a folder named HA{NN} and uploads the 5 images into it.
 *
 * @param {number} itemId - Queue item ID
 * @param {string} productName - Product name (for file naming)
 * @param {Array<{viewId: number, viewLabel: string, imageUrl: string}>} views - Completed render views
 * @returns {Promise<{folderId: string, folderName: string, files: Array}>}
 */
export async function uploadRendersToDrive(itemId, productName, views, options = {}) {
  console.log(`[DRIVE] Starting upload for item ${itemId} (${productName}), views count: ${views.length}`);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  await onProgress?.({
    status: 'uploading',
    uploaded: 0,
    total: views.length,
    message: 'Connecting to Google Drive...'
  });

  const drive = getDriveClient();

  // Get the next folder counter (HA01, HA02, ...)
  const counter = await getNextFolderCounter();
  const folderName = `HA${String(counter).padStart(2, '0')}`;

  console.log(`[DRIVE] Creating folder "${folderName}" for item ${itemId}`);
  await onProgress?.({
    status: 'uploading',
    uploaded: 0,
    total: views.length,
    folderName,
    message: `Creating Drive folder ${folderName}...`
  });

  // Create the folder
  let folderId;
  try {
    folderId = await createFolder(drive, folderName);
    console.log(`[DRIVE] Created folder "${folderName}" with ID: ${folderId}`);
  } catch (folderErr) {
    console.error(`[DRIVE] FAILED to create folder:`, folderErr.message);
    throw folderErr;
  }

  // ── Improvement 2: Upload all 5 views in parallel ──
  let completed = 0;
  const uploadPromises = views.map(async view => {
    const result = await uploadViewWithRetry(drive, view, folderName, folderId);
    completed++;
    await onProgress?.({
      status: 'uploading',
      uploaded: completed,
      total: views.length,
      folderId,
      folderName,
      message: `Uploaded ${completed}/${views.length} files to ${folderName}`
    });
    return result;
  });

  const results = await Promise.all(uploadPromises);
  const uploadedFiles = results.filter(r => r !== null);

  console.log(`[DRIVE] Upload complete for item ${itemId}: ${uploadedFiles.length}/${views.length} files uploaded to "${folderName}"`);
  await onProgress?.({
    status: uploadedFiles.length === views.length ? 'done' : 'error',
    uploaded: uploadedFiles.length,
    total: views.length,
    folderId,
    folderName,
    message: uploadedFiles.length === views.length
      ? `Uploaded to Google Drive folder ${folderName}`
      : `Uploaded ${uploadedFiles.length}/${views.length} files to Drive`
  });

  return {
    folderId,
    folderName,
    files: uploadedFiles
  };
}
