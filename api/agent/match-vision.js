// ═══════════════════════════════════════════════════════════════════
//  api/agent/match-vision.js — POST /api/agent/match-vision
//  Vision-based product-image matching using OpenAI Vision.
//
//  Takes PDF product rows + ZIP images, creates visual fingerprints
//  for each image, then ranks top 3 candidates per product.
//
//  Request body:
//    {
//      products: [{ name, brand, productCode, category, material, color,
//                   dimensions, description, page }],
//      images: [{ name, dataUrl, width, height }]
//    }
//
//  Response:
//    {
//      success: true,
//      matches: [{ productIndex, product, bestMatch, secondMatch,
//                  thirdMatch, overallConfidence, autoAccept }],
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
    const { products, images } = req.body;

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'products array is required' });
    }

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'images array is required' });
    }

    console.log(`[MATCH-VISION] Matching ${products.length} products to ${images.length} images using OpenAI Vision`);

    // Run the vision-based matching pipeline
    const result = await matchProductsWithVision(products, images);

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
