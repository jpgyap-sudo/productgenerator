// ═══════════════════════════════════════════════════════════════════
//  POST /api/render/product — Generate 4 product renders with QA
//
//  Accepts multipart form-data:
//    - productImage: uploaded chair image (required)
//    - productName: optional product name
//    - brand: optional brand/style source
//    - mode: 'balanced' (default), 'gpt-only', 'gemini-only'
//
//  Returns a render job with four outputs and QA status.
// ═══════════════════════════════════════════════════════════════════

import { renderFourImages } from '../../lib/render-router.js';

/**
 * Handler for POST /api/render/product
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Missing productImage file' });
  }

  const productName = req.body?.productName || '';
  const brand = req.body?.brand || '';
  const mode = req.body?.mode || 'balanced';

  // Validate mode
  const validModes = ['balanced', 'gpt-only', 'gemini-only'];
  if (!validModes.includes(mode)) {
    return res.status(400).json({
      error: `Invalid mode "${mode}". Must be one of: ${validModes.join(', ')}`
    });
  }

  console.log(`[RENDER-API] Starting render job: productName="${productName}", brand="${brand}", mode="${mode}", file="${file.originalname}"`);

  try {
    const outputs = await renderFourImages({
      productName,
      brand,
      mode,
      originalImagePath: file.path
    });

    console.log(`[RENDER-API] Render job complete: ${outputs.filter(o => o.status !== 'failed').length}/${outputs.length} succeeded`);

    return res.json({
      ok: true,
      outputs
    });
  } catch (err) {
    console.error('[RENDER-API] Render job failed:', err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
