// VPS-backed render asset storage.
// Saves finished render images and ZIP archives to disk so they are served
// by the persistent Express server instead of depending on third-party URLs.

import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { VIEWS } from './fal.js';

export const VPS_ASSET_ROOT = path.resolve(process.env.VPS_ASSET_DIR || path.join(process.cwd(), 'vps-assets'));
export const VPS_PUBLIC_PREFIX = (process.env.VPS_PUBLIC_PREFIX || '/vps-assets').replace(/\/$/, '');

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

export function publicAssetPath(...parts) {
  return [VPS_PUBLIC_PREFIX, ...parts.map(part => encodeURIComponent(String(part)))].join('/');
}

export function renderItemDir(itemId) {
  return path.join(VPS_ASSET_ROOT, 'renders', `item-${Number(itemId)}`);
}

export function renderZipPublicUrl(itemId, productName = 'renders') {
  return publicAssetPath('renders', `item-${Number(itemId)}`, `${sanitizeName(productName)}_renders.zip`);
}

export async function saveRenderImageToVps(sourceUrl, itemId, view, productName = 'render') {
  const image = await readImage(sourceUrl);
  const ext = extensionFromContentType(image.contentType) || extensionFromUrl(sourceUrl) || 'jpg';
  return saveRenderImageBufferToVps(image.buffer, image.contentType, itemId, view, productName, ext);
}

export async function saveRenderImageBufferToVps(buffer, contentType, itemId, view, productName = 'render', preferredExt = '') {
  const ext = preferredExt || extensionFromContentType(contentType) || 'jpg';
  const dir = renderItemDir(itemId);
  // Include a timestamp in the filename so re-renders produce a unique file path.
  // This prevents browser caching issues where the old image is served from cache
  // because the URL hasn't changed. The frontend also appends a cache-busting param.
  const timestamp = Date.now();
  const filename = `${sanitizeName(productName)}_img${view.id}_${sanitizeName(view.label)}_${timestamp}.${ext}`;
  const filePath = path.join(dir, filename);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, buffer);

  return {
    publicUrl: publicAssetPath('renders', `item-${Number(itemId)}`, filename),
    filePath,
    contentType
  };
}

export async function createRenderZipOnVps(itemId, productName, views) {
  const dir = renderItemDir(itemId);
  const zipName = `${sanitizeName(productName || `item_${itemId}`)}_renders.zip`;
  const zipPath = path.join(dir, zipName);
  const zip = new AdmZip();
  let added = 0;

  await fs.mkdir(dir, { recursive: true });

  for (const viewResult of views || []) {
    if (!viewResult?.imageUrl) continue;
    const viewId = Number(viewResult.viewId);
    const view = VIEWS.find(v => Number(v.id) === viewId) || { id: viewId || added + 1, label: `View ${viewId || added + 1}` };
    const image = await readImage(viewResult.imageUrl);
    const ext = extensionFromContentType(image.contentType) || extensionFromUrl(viewResult.imageUrl) || 'jpg';
    const filename = `${sanitizeName(productName || `item_${itemId}`)}_img${view.id}_${sanitizeName(view.label)}.${ext}`;
    zip.addFile(filename, image.buffer);
    added++;
  }

  if (!added) throw new Error('No render images available to store in ZIP');

  const buffer = zip.toBuffer();
  await fs.writeFile(zipPath, buffer);

  return {
    publicUrl: publicAssetPath('renders', `item-${Number(itemId)}`, zipName),
    filePath: zipPath,
    buffer,
    added
  };
}

export async function readPublicAsset(publicUrl) {
  const filePath = resolvePublicAssetPath(publicUrl);
  if (!filePath) return null;
  return fs.readFile(filePath);
}

export function resolvePublicAssetPath(publicUrl) {
  const value = String(publicUrl || '');
  let pathname = value;

  if (/^https?:\/\//i.test(value)) {
    try {
      pathname = new URL(value).pathname;
    } catch {
      return null;
    }
  }

  if (!pathname.startsWith(`${VPS_PUBLIC_PREFIX}/`)) return null;
  const relative = decodeURIComponent(pathname.slice(VPS_PUBLIC_PREFIX.length + 1));
  const resolved = path.resolve(VPS_ASSET_ROOT, relative);
  if (!resolved.startsWith(`${VPS_ASSET_ROOT}${path.sep}`) && resolved !== VPS_ASSET_ROOT) {
    return null;
  }
  return resolved;
}

async function readImage(url) {
  const localBuffer = await readPublicAsset(url);
  if (localBuffer) {
    return {
      buffer: localBuffer,
      contentType: contentTypeFromUrl(url)
    };
  }

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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength <= 0) throw new Error('Image response was empty');
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large (${Math.round(arrayBuffer.byteLength / 1024 / 1024)} MB)`);
    }

    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: response.headers.get('content-type') || contentTypeFromUrl(url)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function sanitizeName(value) {
  return String(value || 'file')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'file';
}

function extensionFromContentType(contentType = '') {
  const type = String(contentType).toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('jpeg')) return 'jpg';
  if (type.includes('jpg')) return 'jpg';
  return '';
}

function extensionFromUrl(url) {
  const clean = String(url || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'png';
  if (clean.endsWith('.webp')) return 'webp';
  if (clean.endsWith('.jpeg')) return 'jpeg';
  if (clean.endsWith('.jpg')) return 'jpg';
  return '';
}

function contentTypeFromUrl(url) {
  const ext = extensionFromUrl(url);
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}
