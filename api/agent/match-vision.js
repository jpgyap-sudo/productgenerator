// ═══════════════════════════════════════════════════════════════════
//  api/agent/match-vision.js — POST /api/agent/match-vision
//  GPT-4o Vision direct image-to-image product matching.
//
//  Takes PDF product rows + ZIP images + PDF page images, sends the
//  PDF product image alongside ZIP candidates to GPT-4o for TRUE
//  visual image-to-image comparison.
//
//  Request body:
//    {
//      products: [{ name, brand, productCode, category, material, color,
//                   dimensions, description, page }],
//      images: [{ name, dataUrl, width, height }],
//      pdfImages: [{ page, dataUrl, width, height }]  // optional PDF page images
//    }
//
//  Response:
//    {
//      success: true,
//      matches: [{ productIndex, product, bestMatch, secondMatch,
//                  thirdMatch, overallConfidence, autoAccept, usedPdfImage }],
//      stats: { totalProducts, totalImages, fingerprintsCreated,
//               autoAccepted, needsReview }
//    }
// ═══════════════════════════════════════════════════════════════════

import { matchProductsWithVision } from '../../lib/vision-matcher.js';

/**
 * POST /api/agent/match-vision
 */
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { products, images, pdfImages } = req.body;

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'products array is required' });
    }

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'images array is required' });
    }

    console.log(`[MATCH-VISION] Matching ${products.length} products to ${images.length} images using GPT-4o Vision${pdfImages?.length ? ` (${pdfImages.length} PDF reference images available)` : ''}`);

    // Run the vision-based matching pipeline with PDF images
    const result = await matchProductsWithVision(products, images, pdfImages || []);

    // Strip dataUrl from response to reduce payload size
    // Client already has the images
    const stripDataUrl = (obj) => {
      if (!obj) return obj;
      const { dataUrl, ...rest } = obj;
      return rest;
    };

    const slimMatches = result.matches.map(m => ({
      ...m,
      bestMatch: m.bestMatch ? stripDataUrl(m.bestMatch) : null,
      secondMatch: m.secondMatch ? stripDataUrl(m.secondMatch) : null,
      thirdMatch: m.thirdMatch ? stripDataUrl(m.thirdMatch) : null
    }));

    return res.json({
      success: true,
      matches: slimMatches,
      stats: result.stats
    });

  } catch (err) {
    console.error('[MATCH-VISION] Error:', err);
    return res.status(500).json({
      error: 'Vision matching failed',
      details: err.message
    });
  }
}
