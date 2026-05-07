// POST /api/queue/download-zip
// Builds a ZIP of completed render image URLs on the server.
// This avoids browser-side fetch/CORS failures that can create empty ZIP files.
import AdmZip from 'adm-zip';
import { VIEWS } from '../../lib/fal.js';
import {
  createRenderZipOnVps,
  readPublicAsset
} from '../../lib/vps-storage.js';

const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const name = sanitizeName(req.body?.name || 'renders');
  const itemId = req.body?.itemId ? Number(req.body.itemId) : null;
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  const viewResults = Array.isArray(req.body?.viewResults) ? req.body.viewResults : [];
  const targets = files.length
    ? files.filter(file => file && file.imageUrl).slice(0, MAX_IMAGES).map((file, index) => ({
        imageUrl: file.imageUrl,
        filename: filenameWithExtension(file.filename || `${name}_${index + 1}`, file.imageUrl),
        viewId: file.viewId || index + 1
      }))
    : viewResults
        .filter(r => r && r.status === 'done' && r.imageUrl)
        .slice(0, MAX_IMAGES)
        .map((result, index) => {
          const viewId = Number(result.viewId);
          const view = VIEWS.find(v => Number(v.id) === viewId);
          const label = sanitizeName(view ? view.label : `view_${viewId || index + 1}`);
          return {
            imageUrl: result.imageUrl,
            filename: `${name}_img${viewId || index + 1}_${label}${extensionFromUrl(result.imageUrl)}`,
            viewId: result.viewId
          };
        });

  if (!targets.length) {
    return res.status(400).json({ error: 'No completed render images found to zip' });
  }

  if (itemId && Number.isFinite(itemId)) {
    try {
      const zipResult = await createRenderZipOnVps(itemId, name, targets.map(target => ({
        viewId: target.viewId,
        imageUrl: target.imageUrl
      })));
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}_renders.zip"`);
      res.setHeader('Content-Length', String(zipResult.buffer.length));
      res.setHeader('X-Zip-Image-Count', String(zipResult.added));
      res.setHeader('X-Zip-Url', zipResult.publicUrl);
      return res.end(zipResult.buffer);
    } catch (error) {
      console.warn(`[DOWNLOAD-ZIP] Failed to use VPS zip storage for item ${itemId}:`, error.message);
    }
  }

  const zip = new AdmZip();
  const failures = [];
  let added = 0;

  for (const target of targets) {
    try {
      const image = await fetchImage(target.imageUrl);
      zip.addFile(target.filename, image);
      added++;
    } catch (error) {
      failures.push({
        viewId: target.viewId,
        error: error.message || 'Image fetch failed'
      });
      console.warn(`[DOWNLOAD-ZIP] Failed view ${target.viewId}:`, error.message);
    }
  }

  if (!added) {
    return res.status(502).json({
      error: 'Could not fetch any render images for the ZIP',
      failures
    });
  }

  const buffer = zip.toBuffer();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}_renders.zip"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('X-Zip-Image-Count', String(added));
  if (failures.length) {
    res.setHeader('X-Zip-Failed-Count', String(failures.length));
  }
  return res.end(buffer);
}

async function fetchImage(url) {
  const localBuffer = await readPublicAsset(url);
  if (localBuffer) return localBuffer;

  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new Error('Image URL must be http or https, or a VPS asset path');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'product-image-studio/2.0' }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength <= 0) throw new Error('Image response was empty');
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large (${Math.round(arrayBuffer.byteLength / 1024 / 1024)} MB)`);
    }
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeName(value) {
  return String(value || 'file')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'file';
}

function extensionFromUrl(url) {
  const clean = String(url || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return '.png';
  if (clean.endsWith('.webp')) return '.webp';
  if (clean.endsWith('.jpeg')) return '.jpeg';
  return '.jpg';
}

function filenameWithExtension(filename, url) {
  const safe = sanitizeName(String(filename || 'image').replace(/\.[a-z0-9]+$/i, ''));
  return `${safe}${extensionFromUrl(url)}`;
}
