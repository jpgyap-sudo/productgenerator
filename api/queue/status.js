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
import { downloadDriveFileBuffer, listRenderImagesInDriveFolder } from '../../lib/drive.js';
import { renderZipPublicUrl, saveRenderImageBufferToVps } from '../../lib/vps-storage.js';

const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1-mini';

// In-memory cache with 2 second TTL, keyed by itemId
// Using a Map so different itemIds don't share cache entries
const cacheMap = new Map();
const CACHE_TTL = 2000;

function getCached(key) {
  const entry = cacheMap.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data;
  }
  return null;
}

function setCached(key, data) {
  cacheMap.set(key, { data, timestamp: Date.now() });
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
      queue: queue.map(item => {
        const itemProvider = inferQueueProvider(item);
        return {
        id: item.id,
        name: item.name,
        imageUrl: item.image_url || '',
        status: item.status,
        description: item.description || '',
        provider: itemProvider,
        apiModel: getBatchApiModel(itemProvider),
        subText: item.sub_text || '',
        driveFolderId: item.drive_folder_id || '',
        driveFolderName: item.drive_folder_name || '',
        driveFolderUrl: item.drive_folder_url || '',
        driveUploadStatus: item.drive_upload_status || '',
        driveUploadDone: item.drive_upload_done || 0,
        driveUploadTotal: item.drive_upload_total || 0,
        driveUploadError: item.drive_upload_error || '',
        zipUrl: renderZipPublicUrl(item.id, item.name),
        updatedAt: item.updated_at
        };
      }),
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
  if (provider === 'openai-mini') return 'gpt-image-1-mini + Gemini Flash fallback';
  if (provider === 'openai') return OPENAI_IMAGE_MODEL;
  if (provider === 'gemini') return 'gemini-3.1-flash-image-preview (+ fallbacks)';
  return '';
}

function inferQueueProvider(item = {}) {
  const provider = String(item.provider || '').toLowerCase();
  if (provider === 'openai-mini' || provider === 'openai' || provider === 'gemini' || provider === 'fal') return provider;

  const text = [
    item.sub_text,
    item.description,
    item.resolution
  ].filter(Boolean).join(' ').toLowerCase();

  if (text.includes('gemini')) return 'gemini';
  if (text.includes('mini + flash') || text.includes('gpt-image-1-mini')) return 'openai-mini';
  if (text.includes('openai') || text.includes('gpt-image') || text.includes('gpt image')) return 'openai';
  if (text.includes('fal')) return 'fal';
  return '';
}

function fetchQueueItems(itemId) {
  let query = supabase
    .from(QUEUE_TABLE)
    .select('*')
    .order('id', { ascending: true });

  if (itemId) {
    // When fetching a specific item (e.g., for completed panel), include archived
    query = query.eq('id', parseInt(itemId, 10));
  } else {
    // When fetching the full queue, exclude archived items
    query = query.is('archived_at', null);
  }
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
  const now = new Date().toISOString();

  for (const item of queueItems) {
    if (item.status === 'stopped') continue;
    const inferredProvider = inferQueueProvider(item);

    const itemRows = rows.filter(row => row.queue_item_id === item.id);
    if (itemRows.length === 0) continue;

    const incompleteDoneRows = itemRows.filter(row => row.status === 'done' && !row.image_url);
    for (const row of incompleteDoneRows) {
      await supabase
        .from(RESULTS_TABLE)
        .update({
          status: 'error',
          image_url: '',
          error_message: 'Missing stored image URL',
          completed_at: row.completed_at || now,
          updated_at: now
        })
        .eq('queue_item_id', row.queue_item_id)
        .eq('view_id', row.view_id);
    }

    const doneCount = itemRows.filter(row => row.status === 'done' && row.image_url).length;
    const incompleteDoneCount = incompleteDoneRows.length;
    const errorCount = itemRows.filter(row => row.status === 'error').length;
    const activeCount = itemRows.filter(row => row.status === 'generating' || row.status === 'waiting').length;

    let status = item.status;
    let subText = item.sub_text || '';

    const reconciled = await reconcileDriveUploadsForItem(item, itemRows);
    if (reconciled > 0) {
      updates.push({
        id: item.id,
        status: reconciled + doneCount >= VIEWS.length ? 'done' : 'active',
        sub_text: reconciled + doneCount >= VIEWS.length
          ? 'All 4 views generated (recovered from Drive)'
          : `${Math.min(VIEWS.length, reconciled + doneCount)}/4 views completed (recovered from Drive)`,
        provider: inferredProvider || item.provider,
        updated_at: new Date().toISOString()
      });
      continue;
    }

    if (activeCount > 0) {
      status = 'active';
      subText = `${doneCount}/4 views completed`;
    } else if (doneCount === 4) {
      status = 'done';
      subText = 'All 4 views generated';
    } else if (errorCount > 0 || incompleteDoneCount > 0) {
      status = 'error';
      const totalErrorCount = errorCount + incompleteDoneCount;
      subText = totalErrorCount === 4
        ? 'All views failed'
        : `${doneCount}/4 views generated, ${totalErrorCount} failed`;
    }

    if (status !== item.status || subText !== item.sub_text || (inferredProvider && inferredProvider !== item.provider)) {
      updates.push({
        id: item.id,
        status,
        sub_text: subText,
        provider: inferredProvider || item.provider,
        updated_at: new Date().toISOString()
      });
    }
  }

  if (updates.length > 0) {
    for (const update of updates) {
      const updateData = {
        status: update.status,
        sub_text: update.sub_text,
        updated_at: update.updated_at
      };
      if (update.provider) updateData.provider = update.provider;

      // Use schema fallback: strip unknown columns and retry
      let currentValues = { ...updateData };
      const strippedColumns = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        if (Object.keys(currentValues).length === 0) break;
        const { error } = await supabase
          .from(QUEUE_TABLE)
          .update(currentValues)
          .eq('id', update.id);
        if (!error) {
          if (strippedColumns.length > 0) {
            console.warn(`[STATUS] Updated item ${update.id} without optional columns: ${strippedColumns.join(', ')}`);
          }
          break;
        }
        const missingColumn = getMissingSchemaColumn(error);
        if (!missingColumn || !(missingColumn in currentValues)) {
          console.error(`[STATUS] Failed to update item ${update.id}:`, error.message);
          break;
        }
        strippedColumns.push(missingColumn);
        delete currentValues[missingColumn];
      }
    }
  }
}

async function reconcileDriveUploadsForItem(item, itemRows) {
  const hasCompletedDriveUpload = item.drive_upload_status === 'done'
    || !!(item.drive_folder_id && item.drive_folder_id !== '');
  if (!hasCompletedDriveUpload || !item.drive_folder_id) return 0;

  const rowsByView = new Map(itemRows.map(row => [Number(row.view_id), row]));
  const missingViews = VIEWS.filter(view => {
    const row = rowsByView.get(Number(view.id));
    return !row || row.status !== 'done' || !row.image_url;
  });
  if (missingViews.length === 0) return 0;

  let driveFiles = [];
  try {
    driveFiles = await listRenderImagesInDriveFolder(item.drive_folder_id);
  } catch (error) {
    console.warn(`[STATUS] Drive reconciliation could not list folder for item ${item.id}:`, error.message);
    return 0;
  }

  const filesByView = new Map(driveFiles.map(file => [Number(file.viewId), file]));
  let recovered = 0;

  for (const view of missingViews) {
    const file = filesByView.get(Number(view.id));
    if (!file) continue;

    try {
      const buffer = await downloadDriveFileBuffer(file.id);
      const stored = await saveRenderImageBufferToVps(
        buffer,
        file.mimeType || 'image/jpeg',
        item.id,
        view,
        item.name || `Item ${item.id}`
      );

      const { error } = await supabase
        .from(RESULTS_TABLE)
        .update({
          status: 'done',
          image_url: stored.publicUrl,
          error_message: '',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('queue_item_id', item.id)
        .eq('view_id', view.id);

      if (error) throw error;
      recovered++;
      console.log(`[STATUS] Recovered item ${item.id} view ${view.id} from Drive file ${file.name}`);
    } catch (error) {
      console.warn(`[STATUS] Failed to recover item ${item.id} view ${view.id} from Drive:`, error.message);
    }
  }

  return recovered;
}

function getViewLabel(viewId) {
  const view = VIEWS.find(v => v.id === viewId);
  return view ? view.label : `View ${viewId}`;
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
      completedAt: row.completed_at,
      providerUsed: row.provider_used || null
    });
  }
  return grouped;
}

/**
 * Extract the missing column name from a Supabase schema cache error.
 * Returns the column name (e.g., 'sub_text', 'brand') or null if not found.
 */
function getMissingSchemaColumn(error) {
  const message = String(error?.message || '');
  const quoted = message.match(/'([^']+)' column/i);
  if (quoted) return quoted[1];
  const plain = message.match(/column\s+([a-zA-Z0-9_]+)\s+does not exist/i);
  if (plain) return plain[1];

  for (const column of [
    'sub_text', 'brand', 'resolution', 'drive_folder_name',
    'drive_folder_id', 'drive_folder_url', 'drive_upload_status',
    'drive_upload_done', 'drive_upload_total', 'drive_upload_error',
    'archived_at', 'api_model'
  ]) {
    if (message.includes(column)) return column;
  }
  return null;
}
