// ═══════════════════════════════════════════════════════════════════
//  upload-gallery.js — API for managing the upload image gallery
//
//  POST /api/agent/upload-gallery
//    Body: { images: [{name, dataUrl, width?, height?, size?, mimeType?}], batchId: string }
//    Saves images to vps-assets/upload-gallery/<batchId>/
//    Returns: { success, images: [{name, url, width, height, size, mimeType}] }
//
//  DELETE /api/agent/upload-gallery?batchId=<id>
//    Deletes a batch's gallery directory.
//
//  GET /api/agent/upload-gallery?list=true
//    Lists all gallery batches.
//
//  POST /api/agent/upload-gallery?cleanup=true
//    Triggers cleanup of expired batches (>48h).
// ═══════════════════════════════════════════════════════════════════

import {
  saveImagesToGallery,
  deleteBatchGallery,
  listGalleryBatches,
  cleanupGallery
} from '../../lib/upload-gallery.js';

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  try {
    // ── GET: List batches ──
    if (req.method === 'GET' && req.query.list === 'true') {
      const batches = await listGalleryBatches();
      return res.json({ success: true, batches });
    }

    // ── DELETE: Remove a batch ──
    if (req.method === 'DELETE') {
      const { batchId } = req.query;
      if (!batchId) {
        return res.status(400).json({ error: 'batchId query parameter is required' });
      }
      await deleteBatchGallery(batchId);
      return res.json({ success: true, message: `Deleted gallery batch ${batchId}` });
    }

    // ── POST: Save images or trigger cleanup ──
    if (req.method === 'POST') {
      // Trigger cleanup
      if (req.query.cleanup === 'true') {
        const deleted = await cleanupGallery();
        return res.json({ success: true, deleted, message: `Cleaned up ${deleted} expired batch(es)` });
      }

      // Save images
      const { images, batchId } = req.body;

      if (!images || !Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ error: 'images array is required' });
      }

      if (!batchId) {
        return res.status(400).json({ error: 'batchId is required' });
      }

      console.log(`[UPLOAD-GALLERY] Saving ${images.length} images for batch ${batchId}`);
      const saved = await saveImagesToGallery(images, batchId);

      return res.json({
        success: true,
        images: saved,
        saved: saved.length,
        total: images.length,
        message: `Saved ${saved.length}/${images.length} images to gallery`
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[UPLOAD-GALLERY] API error:', err);
    return res.status(500).json({
      error: 'Upload gallery operation failed',
      details: err.message
    });
  }
}
