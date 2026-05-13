// ═══════════════════════════════════════════════════════════════════
//  upload-gallery.js — Persistent image storage for batch uploads
//
//  When a ZIP is uploaded during batch processing, images are saved
//  to the VPS filesystem under vps-assets/upload-gallery/<batch-id>/.
//  The client receives URLs instead of dataUrls, reducing memory
//  pressure and enabling images to persist for the matchmaking flow.
//
//  Cleanup: Images older than 48 hours that are NOT referenced by
//  any completed batch or the permanent matched-images gallery are
//  automatically deleted.
// ═══════════════════════════════════════════════════════════════════

import fs from 'node:fs/promises';
import path from 'node:path';
import { VPS_ASSET_ROOT, VPS_PUBLIC_PREFIX } from './vps-storage.js';

const GALLERY_DIR = path.join(VPS_ASSET_ROOT, 'upload-gallery');
const GALLERY_PUBLIC_PREFIX = `${VPS_PUBLIC_PREFIX}/upload-gallery`;
const CLEANUP_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;  // Check every hour

/**
 * Save an array of images (with dataUrls) to the upload gallery.
 * @param {Array<{name: string, dataUrl: string, width?: number, height?: number, size?: number, mimeType?: string}>} images
 * @param {string|number} batchId - Unique batch identifier
 * @returns {Promise<Array<{name: string, url: string, width: number, height: number, size: number, mimeType: string}>>}
 */
export async function saveImagesToGallery(images, batchId) {
  const batchDir = path.join(GALLERY_DIR, String(batchId));
  await fs.mkdir(batchDir, { recursive: true });

  const saved = [];

  for (const img of images) {
    try {
      const buffer = dataUrlToBuffer(img.dataUrl);
      const mimeType = img.mimeType || guessMimeType(img.name);
      const ext = mimeType.split('/')[1] || 'jpg';
      const safeName = sanitizeFilename(img.name || `img_${Date.now()}`);
      const filename = `${safeName}.${ext}`;
      const filePath = path.join(batchDir, filename);

      await fs.writeFile(filePath, buffer);

      saved.push({
        name: img.name || filename,
        url: `${GALLERY_PUBLIC_PREFIX}/${String(batchId)}/${filename}`,
        width: img.width || 0,
        height: img.height || 0,
        size: buffer.length,
        mimeType
      });
    } catch (err) {
      console.error(`[UPLOAD-GALLERY] Failed to save image "${img.name}":`, err.message);
    }
  }

  // Write a manifest so cleanup knows when this batch was created
  const manifestPath = path.join(batchDir, '.manifest.json');
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8').catch(() => '{}'));
    manifest.createdAt = manifest.createdAt || new Date().toISOString();
    manifest.updatedAt = new Date().toISOString();
    manifest.imageCount = saved.length;
    manifest.imageNames = saved.map(s => s.name);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (err) {
    console.warn('[UPLOAD-GALLERY] Failed to write manifest:', err.message);
  }

  console.log(`[UPLOAD-GALLERY] Saved ${saved.length}/${images.length} images for batch ${batchId}`);
  return saved;
}

/**
 * Delete a batch's gallery directory.
 */
export async function deleteBatchGallery(batchId) {
  const batchDir = path.join(GALLERY_DIR, String(batchId));
  try {
    await fs.rm(batchDir, { recursive: true, force: true });
    console.log(`[UPLOAD-GALLERY] Deleted gallery for batch ${batchId}`);
    return true;
  } catch (err) {
    console.warn(`[UPLOAD-GALLERY] Failed to delete batch ${batchId}:`, err.message);
    return false;
  }
}

/**
 * List all gallery batches with their metadata.
 */
export async function listGalleryBatches() {
  try {
    const entries = await fs.readdir(GALLERY_DIR, { withFileTypes: true });
    const batches = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(GALLERY_DIR, entry.name, '.manifest.json');
      try {
        const raw = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw);
        batches.push({
          batchId: entry.name,
          createdAt: manifest.createdAt || null,
          updatedAt: manifest.updatedAt || null,
          imageCount: manifest.imageCount || 0,
          imageNames: manifest.imageNames || []
        });
      } catch {
        // No manifest — skip
      }
    }

    return batches.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.warn('[UPLOAD-GALLERY] Failed to list batches:', err.message);
    return [];
  }
}

/**
 * Cleanup: remove gallery batches older than 48 hours.
 * This should be called periodically (e.g., every hour).
 * @param {Set<string>} [protectedBatchIds] - Set of batch IDs that should NOT be deleted
 */
export async function cleanupGallery(protectedBatchIds = new Set()) {
  console.log('[UPLOAD-GALLERY] Running cleanup...');
  const now = Date.now();
  const batches = await listGalleryBatches();
  let deleted = 0;

  for (const batch of batches) {
    // Skip protected batches
    if (protectedBatchIds.has(batch.batchId)) {
      continue;
    }

    const createdAt = batch.createdAt ? new Date(batch.createdAt).getTime() : 0;
    if (!createdAt) continue;

    const age = now - createdAt;
    if (age > CLEANUP_AGE_MS) {
      await deleteBatchGallery(batch.batchId);
      deleted++;
    }
  }

  if (deleted > 0) {
    console.log(`[UPLOAD-GALLERY] Cleanup removed ${deleted} expired batch(es)`);
  }
  return deleted;
}

/**
 * Start periodic cleanup. Returns the interval handle.
 * @param {() => Promise<Set<string>>} getProtectedBatchIds - Async function returning protected batch IDs
 */
export function startGalleryCleanup(getProtectedBatchIds) {
  // Run once on startup
  setTimeout(() => {
    cleanupGallery().catch(err => console.warn('[UPLOAD-GALLERY] Initial cleanup error:', err.message));
  }, 10000);

  const handle = setInterval(async () => {
    try {
      const protectedIds = typeof getProtectedBatchIds === 'function'
        ? await getProtectedBatchIds()
        : new Set();
      await cleanupGallery(protectedIds);
    } catch (err) {
      console.warn('[UPLOAD-GALLERY] Cleanup error:', err.message);
    }
  }, CLEANUP_INTERVAL_MS);

  return handle;
}

/**
 * Save batch image metadata to a JSON file in the gallery directory.
 * This is used by batch-status.js to return image info without needing
 * an all_images column in the batch_jobs database table.
 * @param {string|number} batchId
 * @param {Array<{name: string, galleryUrl: string, width?: number, height?: number, size?: number}>} images
 */
export async function saveBatchImageMetadata(batchId, images) {
  const batchDir = path.join(GALLERY_DIR, String(batchId));
  const metaPath = path.join(batchDir, 'batch-images.json');
  try {
    await fs.mkdir(batchDir, { recursive: true });
    const meta = images.map(img => ({
      name: img.name || '',
      galleryUrl: img.galleryUrl || img.url || '',
      width: img.width || 0,
      height: img.height || 0,
      size: img.size || 0
    }));
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    console.log(`[UPLOAD-GALLERY] Saved image metadata for batch ${batchId} (${meta.length} images)`);
    return meta;
  } catch (err) {
    console.warn(`[UPLOAD-GALLERY] Failed to save image metadata for batch ${batchId}:`, err.message);
    return [];
  }
}

/**
 * Load batch image metadata from the gallery directory.
 * @param {string|number} batchId
 * @returns {Promise<Array<{name: string, galleryUrl: string, width: number, height: number, size: number}>>}
 */
export async function loadBatchImageMetadata(batchId) {
  const metaPath = path.join(GALLERY_DIR, String(batchId), 'batch-images.json');
  try {
    const raw = await fs.readFile(metaPath, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    return [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.warn(`[UPLOAD-GALLERY] Failed to load image metadata for batch ${batchId}:`, err.message);
    return [];
  }
}

// ── Helpers ──

function dataUrlToBuffer(dataUrl) {
  const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

function guessMimeType(filename) {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  const mimeMap = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff'
  };
  return mimeMap[ext] || 'image/jpeg';
}

function sanitizeFilename(name) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 200) || 'image';
}
