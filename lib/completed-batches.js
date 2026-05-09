// VPS-backed completed batch index.
// The render files live under vps-assets; this JSON file records which
// completed batches should appear in the UI even across browsers/devices.

import fs from 'node:fs/promises';
import path from 'node:path';
import { VPS_ASSET_ROOT } from './vps-storage.js';

const STORE_PATH = path.join(VPS_ASSET_ROOT, 'completed-batches.json');
const MAX_BATCHES = 500;

export async function listCompletedBatches() {
  const batches = await readStore();
  return batches.sort((a, b) => Number(b.id) - Number(a.id));
}

export async function saveCompletedBatch(batch) {
  const normalized = normalizeBatch(batch);
  if (!normalized) throw new Error('Valid completed batch is required');

  const batches = (await readStore()).filter(entry => Number(entry.id) !== Number(normalized.id));
  batches.unshift(normalized);
  await writeStore(batches.slice(0, MAX_BATCHES));
  return normalized;
}

export async function deleteCompletedBatch(id) {
  const batchId = Number(id);
  if (!Number.isFinite(batchId)) throw new Error('Valid batch id is required');
  const batches = (await readStore()).filter(entry => Number(entry.id) !== batchId);
  await writeStore(batches);
  return { id: batchId };
}

export async function clearCompletedBatches(ids = null) {
  if (!Array.isArray(ids) || !ids.length) {
    await writeStore([]);
    return { cleared: 'all' };
  }

  const idSet = new Set(ids.map(Number).filter(Number.isFinite));
  const batches = (await readStore()).filter(entry => !idSet.has(Number(entry.id)));
  await writeStore(batches);
  return { cleared: Array.from(idSet) };
}

function normalizeBatch(batch = {}) {
  const id = Number(batch.id);
  if (!Number.isFinite(id) || id <= 0) return null;

  const viewResults = Array.isArray(batch.viewResults)
    ? batch.viewResults
        .filter(row => row && row.imageUrl)
        .map(row => ({
          viewId: Number(row.viewId),
          status: row.status || 'done',
          imageUrl: row.imageUrl || null,
          errorMessage: row.errorMessage || null,
          completedAt: row.completedAt || null,
          providerUsed: row.providerUsed || null,
          qaScore: row.qaScore != null ? Number(row.qaScore) : null,
          qaNotes: Array.isArray(row.qaNotes) ? row.qaNotes : null
        }))
    : [];

  return {
    id,
    name: batch.name || `Item ${id}`,
    imageUrl: batch.imageUrl || batch.dataUrl || batch.supabaseUrl || '',
    status: batch.status || 'done',
    provider: batch.provider || '',
    apiModel: batch.apiModel || '',
    updatedAt: batch.updatedAt || new Date().toISOString(),
    driveFolderId: batch.driveFolderId || '',
    driveFolderName: batch.driveFolderName || '',
    driveFolderUrl: batch.driveFolderUrl || '',
    driveUploadStatus: batch.driveUploadStatus || '',
    driveUploadDone: Number(batch.driveUploadDone || 0),
    driveUploadTotal: Number(batch.driveUploadTotal || 0),
    driveUploadError: batch.driveUploadError || '',
    zipUrl: batch.zipUrl || '',
    viewResults
  };
}

async function readStore() {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    console.warn('[COMPLETED-BATCHES] Failed to read store:', error.message);
    return [];
  }
}

async function writeStore(batches) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tmpPath = `${STORE_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(batches, null, 2));
  await fs.rename(tmpPath, STORE_PATH);
}
