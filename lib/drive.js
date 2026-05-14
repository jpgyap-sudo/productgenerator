// ═══════════════════════════════════════════════════════════════════
//  Google Drive Upload — Service Account based
//  Creates folders named after the product and uploads rendered images.
//
//  Setup:
//  1. Go to https://console.cloud.google.com → Enable Google Drive API
//  2. Create a Service Account → download JSON key
//  3. Create a folder in your Google Drive and share it with the
//     service account email (client_email) — grant Editor access
//  4. Set GOOGLE_SERVICE_ACCOUNT_JSON env var to the full JSON string
//  5. Set DRIVE_PARENT_FOLDER_ID env var to the ID of the shared folder
//     (found in the URL when you open the folder in your browser)
//
//  Why a parent folder? Service accounts don't have their own storage
//  quota. By creating product sub-folders inside a folder that a real
//  user has shared with the service account, uploaded files count
//  against the real user's storage quota instead.
// ═══════════════════════════════════════════════════════════════════

import { google } from 'googleapis';
import fs from 'node:fs/promises';
import path from 'node:path';
import stream from 'node:stream';
import { supabase, CONFIG_TABLE } from './supabase.js';
import { readPublicAsset, VPS_ASSET_ROOT } from './vps-storage.js';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const UPLOAD_CONCURRENCY = 2; // Max parallel uploads to Drive at once

// Parent folder ID — a folder in the user's Drive that has been shared
// with the service account. Product sub-folders are created inside this
// parent, so uploaded files use the real user's storage quota.
const PARENT_FOLDER_ID = process.env.DRIVE_PARENT_FOLDER_ID || null;

// Shared Drive ID — if the parent folder is a Shared Drive, set this
// to the Shared Drive ID. Service accounts can upload files to Shared
// Drives without storage quota issues.
const SHARED_DRIVE_ID = process.env.DRIVE_SHARED_DRIVE_ID || null;

// Whether we're using a Shared Drive (requires supportsAllDrives flags)
const IS_SHARED_DRIVE = !!SHARED_DRIVE_ID;

// ── Supabase fallback: file-based counter ──
const DRIVE_COUNTER_PATH = path.join(VPS_ASSET_ROOT, 'drive-counter.json');

/**
 * File-based fallback for getNextFolderCounter() when Supabase is unreachable.
 * Reads/writes a simple JSON file on the VPS filesystem.
 */
export async function getNextFolderCounterFallback() {
  try {
    await fs.mkdir(path.dirname(DRIVE_COUNTER_PATH), { recursive: true });
    let counter = 1;
    try {
      const raw = await fs.readFile(DRIVE_COUNTER_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data.counter === 'number' && data.counter >= 1) {
        counter = data.counter;
      }
    } catch (readErr) {
      if (readErr.code !== 'ENOENT') {
        console.warn('[DRIVE-FALLBACK] Failed to read counter file, starting at 1:', readErr.message);
      }
    }
    // Increment for next time
    await fs.writeFile(DRIVE_COUNTER_PATH, JSON.stringify({ counter: counter + 1, updatedAt: new Date().toISOString() }, null, 2));
    console.log(`[DRIVE-FALLBACK] Got folder counter ${counter} from local file`);
    return counter;
  } catch (err) {
    console.error('[DRIVE-FALLBACK] Counter file error, using timestamp-based fallback:', err.message);
    // Last-resort fallback: use timestamp-based counter
    return Math.floor(Date.now() / 1000);
  }
}

/**
 * Check if a Supabase error indicates the database is unreachable (connection/network error).
 * Returns true for connection refused, timeout, DNS failures, etc.
 */
export function isSupabaseConnectionError(error) {
  if (!error) return false;
  const msg = (error.message || error.code || '').toLowerCase();
  return msg.includes('fetch failed')
    || msg.includes('enotfound')
    || msg.includes('econnrefused')
    || msg.includes('etimedout')
    || msg.includes('econnreset')
    || msg.includes('network')
    || msg.includes('timeout')
    || msg.includes('unreachable')
    || msg.includes('could not connect')
    || msg.includes('connection refused');
}

/**
 * Get an authenticated Google Drive client.
 *
 * Priority:
 * 1. OAuth2 with refresh token (uses your personal Google Drive storage quota)
 * 2. Service Account JWT (fallback — can create folders but NOT upload files)
 *
 * OAuth2 setup (recommended):
 *   GOOGLE_DRIVE_CLIENT_ID=xxx.apps.googleusercontent.com
 *   GOOGLE_DRIVE_CLIENT_SECRET=GOCSPX-xxx
 *   GOOGLE_DRIVE_REFRESH_TOKEN=1//xxx
 *
 * Service Account setup (fallback):
 *   GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
 */

// Cache the Drive client so we don't re-create auth on every call
let cachedDriveClient = null;

function getDriveClient() {
  if (cachedDriveClient) {
    return cachedDriveClient;
  }

  // Try OAuth2 with refresh token first (uses real user's storage quota)
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    console.log('[DRIVE] Using OAuth2 authentication (personal Google account)');
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000');
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    cachedDriveClient = google.drive({ version: 'v3', auth: oauth2Client });
    return cachedDriveClient;
  }

  // Fallback: Service Account JWT
  console.log('[DRIVE] No OAuth2 tokens found, trying Service Account...');
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!rawJson) {
    throw new Error('No Drive auth configured. Set GOOGLE_DRIVE_REFRESH_TOKEN (OAuth2) or GOOGLE_SERVICE_ACCOUNT_JSON (service account)');
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

  cachedDriveClient = google.drive({ version: 'v3', auth });
  return cachedDriveClient;
}

function allDrivesParams() {
  return IS_SHARED_DRIVE
    ? {
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'drive',
        driveId: SHARED_DRIVE_ID
      }
    : {};
}

/**
 * Get or create the next folder counter from Supabase app_config.
 * Returns the counter value and increments it atomically.
 * Uses a retry loop with atomic compare-and-swap to prevent race conditions
 * when multiple items are processed concurrently.
 */
export async function getNextFolderCounter() {
  const MAX_RETRIES = 5;
  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Read current value
      const { data, error } = await supabase
        .from(CONFIG_TABLE)
        .select('value')
        .eq('key', 'drive_folder_counter')
        .single();

      let counter = 1;

      if (error || !data) {
        // No counter exists yet — try to insert atomically
        const { error: insertError } = await supabase
          .from(CONFIG_TABLE)
          .insert({ key: 'drive_folder_counter', value: '2', updated_at: new Date().toISOString() });

        if (insertError) {
          // If another concurrent request inserted it first, retry
          if (insertError.message && insertError.message.includes('duplicate')) {
            lastError = insertError;
            continue; // Retry
          }
          console.error('Failed to initialize drive_folder_counter:', insertError);
        }
        return 1;
      }

      counter = parseInt(data.value, 10);
      if (isNaN(counter) || counter < 1) counter = 1;

      // Atomic compare-and-swap: only update if value hasn't changed
      const { error: updateError } = await supabase
        .from(CONFIG_TABLE)
        .update({ value: String(counter + 1), updated_at: new Date().toISOString() })
        .eq('key', 'drive_folder_counter')
        .eq('value', String(counter)); // Only update if value matches (atomic CAS)

      if (updateError) {
        // If the update failed (e.g. another request changed the value), retry
        lastError = updateError;
        continue;
      }

      // Success — counter was atomically incremented
      return counter;

    } catch (err) {
      lastError = err;
      // Wait a bit before retrying
      await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
    }
  }

  // All retries exhausted — fall back to non-atomic increment
  console.error('[DRIVE] Failed to atomically increment counter after', MAX_RETRIES, 'retries:', lastError?.message);
  const { data, error } = await supabase
    .from(CONFIG_TABLE)
    .select('value')
    .eq('key', 'drive_folder_counter')
    .single();

  if (error || !data) return 1;
  const fallbackCounter = parseInt(data.value, 10) || 1;
  await supabase
    .from(CONFIG_TABLE)
    .update({ value: String(fallbackCounter + 1), updated_at: new Date().toISOString() })
    .eq('key', 'drive_folder_counter');
  return fallbackCounter;
}

/**
 * Create a folder in Google Drive.
 * @param {object} drive - Authenticated Drive client
 * @param {string} folderName - Name of the folder (e.g. "HA01")
 * @returns {Promise<{id: string, webViewLink: string}>} The folder ID and link
 */
async function createFolder(drive, folderName) {
  // When a parent folder is configured, search for existing sub-folders
  // by name inside that parent. Otherwise search globally.
  let q = `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (PARENT_FOLDER_ID) {
    q += ` and '${PARENT_FOLDER_ID}' in parents`;
  }

  const listParams = {
    q,
    fields: 'files(id, webViewLink)',
    pageSize: 1
  };

  // Shared Drive support: need these flags to search inside Shared Drives
  Object.assign(listParams, allDrivesParams());

  try {
    const listResponse = await drive.files.list(listParams);

    if (listResponse.data.files && listResponse.data.files.length > 0) {
      console.log(`[DRIVE] Reusing existing folder "${folderName}" (ID: ${listResponse.data.files[0].id})`);
      return {
        id: listResponse.data.files[0].id,
        webViewLink: listResponse.data.files[0].webViewLink || ''
      };
    }
  } catch (listErr) {
    console.warn(`[DRIVE] Failed to check for existing folder "${folderName}":`, listErr.message);
    // Fall through to create
  }

  const createBody = {
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: PARENT_FOLDER_ID ? [PARENT_FOLDER_ID] : undefined
    },
    fields: 'id, webViewLink'
  };

  // Shared Drive support: need supportsAllDrives when creating inside a Shared Drive
  if (IS_SHARED_DRIVE) {
    createBody.supportsAllDrives = true;
  }

  const response = await drive.files.create(createBody);

  return {
    id: response.data.id,
    webViewLink: response.data.webViewLink || ''
  };
}

export async function listRenderImagesInDriveFolder(folderId) {
  if (!folderId) return [];

  const drive = getDriveClient();
  const files = [];
  let pageToken = null;

  do {
    const response = await drive.files.list({
      q: `'${String(folderId).replace(/'/g, "\\'")}' in parents and trashed=false and mimeType contains 'image/'`,
      fields: 'nextPageToken, files(id, name, mimeType, webViewLink)',
      pageSize: 100,
      pageToken: pageToken || undefined,
      ...allDrivesParams()
    });
    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken || null;
  } while (pageToken);

  return files
    .map(file => {
      const viewId = Number(String(file.name || '').match(/_img(\d+)_/i)?.[1]);
      return { ...file, viewId: Number.isFinite(viewId) ? viewId : null };
    })
    .filter(file => file.viewId);
}

export async function downloadDriveFileBuffer(fileId) {
  if (!fileId) throw new Error('Drive file ID is required');

  const drive = getDriveClient();
  const response = await drive.files.get(
    {
      fileId,
      alt: 'media',
      supportsAllDrives: IS_SHARED_DRIVE || undefined
    },
    { responseType: 'arraybuffer' }
  );

  return Buffer.from(response.data);
}

/**
 * Upload a file buffer to a Google Drive folder.
 * @param {object} drive - Authenticated Drive client
 * @param {Buffer} buffer - File content
 * @param {string} fileName - Name for the file (e.g. "HA01_img1_Front_view.jpg")
 * @param {string} mimeType - MIME type (e.g. "image/jpeg")
 * @param {string} parentFolderId - ID of the parent folder
 * @returns {Promise<{fileId: string, webViewLink: string}>} The file ID and link
 */
async function uploadFile(drive, buffer, fileName, mimeType, parentFolderId) {
  // googleapis v3 requires a Readable stream (with .pipe()), not a raw Buffer
  const readableStream = stream.Readable.from(buffer);

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentFolderId]
    },
    media: {
      mimeType: mimeType,
      body: readableStream
    },
    fields: 'id,webViewLink'
  });

  return {
    fileId: response.data.id,
    webViewLink: response.data.webViewLink
  };
}

/**
 * Replace a file in a Drive folder by matching its name pattern.
 * Finds the existing file by name pattern (e.g., `*_img1_*` for view 1),
 * deletes it, and uploads the new image in its place.
 * This keeps the Drive folder clean — old re-rendered images are removed.
 *
 * @param {object} drive - Authenticated Drive client
 * @param {Buffer} buffer - New file content
 * @param {string} fileName - Name for the new file (e.g. "HA01_img1_Front_view.png")
 * @param {string} mimeType - MIME type (e.g. "image/png")
 * @param {string} parentFolderId - ID of the parent folder
 * @param {string} searchPattern - Glob-like name pattern to find the old file (e.g. "*_img1_*")
 * @returns {Promise<{fileId: string, webViewLink: string}>} The new file ID and link
 */
export async function replaceDriveFile(buffer, fileName, mimeType, parentFolderId, searchPattern) {
  const drive = getDriveClient();

  // Search for existing files matching the pattern in this folder
  const escapedPattern = searchPattern.replace(/'/g, "\\'");
  const q = `'${parentFolderId.replace(/'/g, "\\'")}' in parents and name contains '${escapedPattern.replace(/\*/g, '')}' and trashed=false`;
  
  try {
    const listResponse = await drive.files.list({
      q,
      fields: 'files(id, name)',
      pageSize: 10,
      ...allDrivesParams()
    });

    const existingFiles = listResponse.data.files || [];
    for (const file of existingFiles) {
      try {
        console.log(`[DRIVE] Deleting old file "${file.name}" (ID: ${file.id}) from Drive folder ${parentFolderId}`);
        await drive.files.delete({
          fileId: file.id,
          supportsAllDrives: IS_SHARED_DRIVE || undefined
        });
      } catch (delErr) {
        console.warn(`[DRIVE] Failed to delete old file "${file.name}": ${delErr.message}`);
        // Non-fatal — continue to upload the new file
      }
    }
  } catch (listErr) {
    console.warn(`[DRIVE] Failed to search for old files to replace: ${listErr.message}`);
    // Non-fatal — continue to upload the new file
  }

  // Upload the new file
  const readableStream = stream.Readable.from(buffer);
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentFolderId]
    },
    media: {
      mimeType: mimeType,
      body: readableStream
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
  const localBuffer = await readPublicAsset(imageUrl);
  if (localBuffer) {
    const ext = extensionFromUrl(imageUrl);
    return {
      buffer: localBuffer,
      contentType: contentTypeFromExtension(ext),
      ext
    };
  }

  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error(`Image fetch failed: HTTP ${imageRes.status}`);
  const arrayBuffer = await imageRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  return { buffer, contentType, ext };
}

function extensionFromUrl(url) {
  const clean = String(url || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'png';
  if (clean.endsWith('.webp')) return 'webp';
  if (clean.endsWith('.jpeg')) return 'jpeg';
  return 'jpg';
}

function contentTypeFromExtension(ext) {
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Upload a single view to Drive with retry logic.
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
 * Process uploads with a concurrency limit.
 * Runs tasks in parallel but caps at `concurrency` at a time.
 */
async function runWithConcurrency(tasks, concurrency, onTaskComplete) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const currentIndex = index++;
      try {
        const result = await tasks[currentIndex]();
        results[currentIndex] = result;
        if (onTaskComplete) await onTaskComplete(result, currentIndex);
      } catch (err) {
        results[currentIndex] = null;
        if (onTaskComplete) await onTaskComplete(null, currentIndex);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Upload all rendered views for a completed item to Google Drive.
 * Creates a folder named after the product (sanitized) and uploads the images into it.
 *
 * @param {number} itemId - Queue item ID
 * @param {string} productName - Product name (used for folder naming fallback)
 * @param {Array<{viewId: number, viewLabel: string, imageUrl: string}>} views - Completed render views
 * @param {object} options - Options including folderName override
 * @returns {Promise<{folderId: string, folderName: string, folderUrl: string, files: Array}>}
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

  // Use provided folderName from options (e.g., generated product code), or fall back to sanitized product name
  const folderName = options.folderName
    ? options.folderName
        .replace(/[^a-zA-Z0-9\s_-]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 60) || `Item_${itemId}`
    : (productName || `Item_${itemId}`)
        .replace(/[^a-zA-Z0-9\s_-]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 60) || `Item_${itemId}`;

  console.log(`[DRIVE] Creating folder "${folderName}" for item ${itemId}`);
  await onProgress?.({
    status: 'uploading',
    uploaded: 0,
    total: views.length,
    folderName,
    message: `Creating Drive folder ${folderName}...`
  });

  // Create the folder
  let folderId, folderUrl;
  try {
    const folder = await createFolder(drive, folderName);
    folderId = folder.id;
    folderUrl = folder.webViewLink;
    console.log(`[DRIVE] Created folder "${folderName}" with ID: ${folderId}, URL: ${folderUrl}`);
  } catch (folderErr) {
    console.error(`[DRIVE] FAILED to create folder:`, folderErr.message);
    throw folderErr;
  }

  // Upload all rendered views with concurrency limit.
  // Build the task list: each task fetches the image then uploads to Drive.
  const uploadTasks = views.map((view, idx) => async () => {
    // Report which file is being fetched
    await onProgress?.({
      status: 'uploading',
      uploaded: idx, // still the previous count
      total: views.length,
      folderId,
      folderName,
      message: `Fetching image ${idx + 1}/${views.length} (${view.viewLabel})...`
    });
    return await uploadViewWithRetry(drive, view, folderName, folderId);
  });

  let completed = 0;
  const results = await runWithConcurrency(uploadTasks, UPLOAD_CONCURRENCY, async (result, idx) => {
    completed++;
    const view = views[idx];
    await onProgress?.({
      status: 'uploading',
      uploaded: completed,
      total: views.length,
      folderId,
      folderName,
      message: result
        ? `Uploaded ${completed}/${views.length} to ${folderName} (${view?.viewLabel || ''})`
        : `Failed ${view?.viewLabel || `file ${idx + 1}`} — retrying...`
    });
  });

  const uploadedFiles = results.filter(r => r !== null);

  console.log(`[DRIVE] Upload complete for item ${itemId}: ${uploadedFiles.length}/${views.length} files uploaded to "${folderName}"`);
  await onProgress?.({
    status: uploadedFiles.length === views.length ? 'done' : 'error',
    uploaded: uploadedFiles.length,
    total: views.length,
    folderId,
    folderName,
    folderUrl,
    message: uploadedFiles.length === views.length
      ? `Uploaded to Google Drive folder ${folderName}`
      : `Uploaded ${uploadedFiles.length}/${views.length} files to Drive`
  });

  return {
    folderId,
    folderName,
    folderUrl,
    files: uploadedFiles
  };
}
