// ═══════════════════════════════════════════════════════════════════
//  api/agent/match.js — POST /api/agent/match
//  Phase 2: Match & Preview
//
//  Accepts products (from Phase 1 extraction) and images (from ZIP),
//  runs pattern matching, then optionally verifies with Gemini vision.
//
//  Request body:
//    {
//      products: [{ name, brand, productCode, generatedCode, description, category }],
//      images: [{ name, width, height, size, dataUrl }],
//      verifyWithGemini: true  // optional, defaults to true
//    }
//
//  Response:
//    {
//      success: true,
//      matches: [{ productIndex, product, matchedImage, score, matchType, verification? }],
//      unmatchedImages: [{ imageIndex, name }],
//      matchStats: { total, matched, unmatched }
//    }
// ═══════════════════════════════════════════════════════════════════

import { matchProductsToImages } from '../../lib/product-matcher.js';
import { verifyMatches } from '../../lib/gemini-verify.js';

/**
 * POST /api/agent/match
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
    const { products, images, verifyWithGemini = true } = req.body;

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'products array is required' });
    }

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'images array is required' });
    }

    console.log(`[MATCH] Matching ${products.length} products to ${images.length} images`);

    // Normalize product fields: ensure productCode is set from generatedCode if missing
    const normalizedProducts = products.map(p => ({
      ...p,
      productCode: p.productCode || p.generatedCode || ''
    }));

    // Step 1: Pattern matching (deterministic, instant)
    const matchResult = matchProductsToImages(normalizedProducts, images);

    console.log(`[MATCH] Pattern matching: ${matchResult.matchStats.matched}/${matchResult.matchStats.total} matched, ${matchResult.unmatchedImages.length} images unmatched`);

    // Step 2: Gemini visual verification (optional)
    if (verifyWithGemini) {
      console.log('[MATCH] Running Gemini visual verification...');
      const verifiedMatches = await verifyMatches(matchResult.matches, images);
      matchResult.matches = verifiedMatches;

      // Count how many were flagged
      const flagged = verifiedMatches.filter(m =>
        m.verification && m.verification.isMatch === false
      );
      console.log(`[MATCH] Gemini flagged ${flagged.length} potential mismatches`);
    } else {
      console.log('[MATCH] Skipping Gemini verification');
    }

    return res.json({
      success: true,
      ...matchResult
    });

  } catch (err) {
    console.error('[MATCH] Error:', err);
    return res.status(500).json({
      error: 'Match failed',
      details: err.message
    });
  }
}
