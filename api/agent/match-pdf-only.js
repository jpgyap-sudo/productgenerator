// ═══════════════════════════════════════════════════════════════════
//  api/agent/match-pdf-only.js — POST /api/agent/match-pdf-only
//  AI per-row matching for PDF-only uploads.
//
//  When a user uploads only a PDF (no ZIP), this endpoint:
//    1. Takes the extracted products (from DeepSeek text analysis)
//    2. Takes the PDF page images (extracted via sharp)
//    3. Uses GPT-4o Vision to match each product to its corresponding
//       PDF page image based on product code, description, and brand
//    4. Returns per-row results with matched photo
//
//  Request body:
//    {
//      products: [{ name, brand, productCode, generatedCode, description, category }],
//      images: [{ name, dataUrl, width, height, pageNumber }]
//    }
//
//  Response:
//    {
//      success: true,
//      matches: [{
//        productIndex: number,
//        product: { name, brand, productCode, description, ... },
//        bestMatch: { imageIndex, imageName, confidence, reason, dataUrl },
//        overallConfidence: 'high'|'medium'|'low'|'none',
//        overallReason: string,
//        confirmed: boolean
//      }],
//      stats: { totalProducts, totalImages, autoAccepted, needsReview }
//    }
// ═══════════════════════════════════════════════════════════════════

import { matchPdfOnlyProducts } from '../../lib/pdf-only-matcher.js';

/**
 * POST /api/agent/match-pdf-only
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
      return res.status(400).json({ error: 'images array is required (PDF page images)' });
    }

    console.log(`[MATCH-PDF-ONLY] Matching ${products.length} products to ${images.length} PDF page images using GPT-4o Vision`);

    // Run the PDF-only matching pipeline
    const result = await matchPdfOnlyProducts(products, images);

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
    console.error('[MATCH-PDF-ONLY] Error:', err);
    return res.status(500).json({
      error: 'PDF-only matching failed',
      details: err.message
    });
  }
}
