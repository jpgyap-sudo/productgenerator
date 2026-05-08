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
import { verifyMatches, visualSearchMatch } from '../../lib/gemini-verify.js';

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

    // Step 3: Gemini visual search fallback for products with no pattern match
    // Products with score < 40 or no matchedImage get a second chance via visual search
    const unmatchedProducts = matchResult.matches.filter(m =>
      !m.matchedImage || m.score < 40
    );

    if (unmatchedProducts.length > 0 && verifyWithGemini) {
      console.log(`[MATCH] Running visual search fallback for ${unmatchedProducts.length} unmatched product(s)`);

      // Collect images that are NOT already used by accepted matches (score >= 40)
      const usedIndices = new Set();
      matchResult.matches.forEach(m => {
        if (m.matchedImage && m.score >= 40) {
          usedIndices.add(m.matchedImage.imageIndex);
        }
      });
      const availableImages = images
        .map((img, idx) => ({ ...img, imageIndex: idx }))
        .filter(img => !usedIndices.has(img.imageIndex));

      if (availableImages.length > 0) {
        // Process visual search in batches of 3 (concurrent within each batch)
        // to speed things up while avoiding rate limits
        const VS_BATCH_SIZE = 3;
        for (let i = 0; i < unmatchedProducts.length; i += VS_BATCH_SIZE) {
          const batch = unmatchedProducts.slice(i, i + VS_BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map(async (um) => {
              try {
                const visualResult = await visualSearchMatch(um.product, availableImages);
                if (visualResult && visualResult.matchedImage) {
                  // Update the match with the visual search result
                  um.matchedImage = visualResult.matchedImage;
                  um.score = visualResult.score;
                  um.matchType = 'visual-search';
                  um.verification = visualResult.verification;

                  // Remove the used image from available pool
                  const usedIdx = availableImages.findIndex(
                    img => img.imageIndex === visualResult.matchedImage.imageIndex
                  );
                  if (usedIdx !== -1) availableImages.splice(usedIdx, 1);

                  console.log(`[MATCH] Visual search found match for "${um.product.name}" (score: ${visualResult.score})`);
                }
              } catch (vsErr) {
                console.error(`[MATCH] Visual search error for "${um.product.name}": ${vsErr.message}`);
              }
            })
          );
          const succeeded = results.filter(r => r.status === 'fulfilled').length;
          console.log(`[MATCH] Visual search batch ${Math.floor(i/VS_BATCH_SIZE)+1}: ${succeeded}/${batch.length} processed`);
        }
      } else {
        console.log('[MATCH] No available images for visual search fallback');
      }

      // Recalculate match stats
      const newMatched = matchResult.matches.filter(m => m.matchedImage !== null).length;
      matchResult.matchStats.matched = newMatched;
      matchResult.matchStats.unmatched = matchResult.matches.length - newMatched;
    }

    // Recalculate unmatchedImages based on final state
    const finalUsedIndices = new Set();
    matchResult.matches.forEach(m => {
      if (m.matchedImage) {
        finalUsedIndices.add(m.matchedImage.imageIndex);
      }
    });
    matchResult.unmatchedImages = images
      .map((img, idx) => ({ imageIndex: idx, name: img.name }))
      .filter(img => !finalUsedIndices.has(img.imageIndex));

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
