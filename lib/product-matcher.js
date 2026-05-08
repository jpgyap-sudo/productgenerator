// ═══════════════════════════════════════════════════════════════════
//  lib/product-matcher.js — Pattern matching: product codes ↔ image filenames
//
//  This is the core of Phase 2: Match & Preview.
//  It uses deterministic pattern matching (NOT AI) to correlate
//  product codes extracted from PDF text with image filenames in the ZIP.
//
//  Strategy:
//    1. Normalize product codes (strip spaces, lowercase)
//    2. Normalize image filenames (strip extension, lowercase)
//    3. Score each (productCode, imageName) pair:
//       - exact match = 100
//       - code is a substring of filename = 80
//       - filename is a substring of code = 60
//       - fuzzy token overlap = 40
//    4. Assign best match per product; flag unmatched products/images
// ═══════════════════════════════════════════════════════════════════

/**
 * Score how well a product code matches an image filename.
 * Returns a score 0-100 and a label describing the match type.
 *
 * @param {string} productCode - e.g. "CH-005" or "HA-790"
 * @param {string} imageName - e.g. "CH-005.jpg" or "img_HA-790_v1.png"
 * @returns {{ score: number, matchType: string }}
 */
export function scoreMatch(productCode, imageName) {
  if (!productCode || !imageName) return { score: 0, matchType: 'none' };

  // Normalize both
  const code = productCode.trim().toLowerCase();
  const name = imageName.replace(/\.[^.]+$/, '').trim().toLowerCase();

  if (!code || !name) return { score: 0, matchType: 'none' };

  // 1. Exact match
  if (code === name) {
    return { score: 100, matchType: 'exact' };
  }

  // 2. Code is a substring of filename (e.g. code="ch-005", name="ch-005_front")
  if (name.includes(code)) {
    return { score: 80, matchType: 'code-in-filename' };
  }

  // 3. Filename is a substring of code (e.g. code="hach-005r", name="ch-005")
  if (code.includes(name)) {
    return { score: 60, matchType: 'filename-in-code' };
  }

  // 4. Token overlap — split both into alphanumeric tokens
  const codeTokens = tokenize(code);
  const nameTokens = tokenize(name);

  if (codeTokens.length === 0 || nameTokens.length === 0) {
    return { score: 0, matchType: 'none' };
  }

  const intersection = codeTokens.filter(t => nameTokens.includes(t));
  const union = new Set([...codeTokens, ...nameTokens]);
  const jaccard = intersection.length / union.size;

  if (jaccard >= 0.5) {
    return { score: Math.round(40 * jaccard), matchType: 'token-overlap' };
  }

  // 5. Check if code tokens appear as substrings in name tokens
  const substringHits = codeTokens.filter(ct =>
    nameTokens.some(nt => nt.includes(ct) || ct.includes(nt))
  );
  if (substringHits.length > 0) {
    const ratio = substringHits.length / Math.max(codeTokens.length, nameTokens.length);
    if (ratio >= 0.3) {
      return { score: Math.round(30 * ratio), matchType: 'fuzzy-token' };
    }
  }

  return { score: 0, matchType: 'none' };
}

/**
 * Match an array of products (with productCode) to an array of images (with name).
 * Returns match suggestions with scores.
 *
 * @param {Array<{productCode: string, name: string, ...}>} products
 * @param {Array<{name: string, dataUrl?: string, ...}>} images
 * @returns {{
 *   matches: Array<{
 *     productIndex: number,
 *     product: object,
 *     matchedImage: object|null,
 *     score: number,
 *     matchType: string,
 *     allCandidates: Array<{imageIndex: number, score: number, matchType: string}>
 *   }>,
 *   unmatchedImages: Array<{imageIndex: number, name: string}>,
 *   matchStats: { total: number, matched: number, unmatched: number }
 * }}
 */
export function matchProductsToImages(products, images) {
  const matches = [];
  const usedImageIndices = new Set();

  for (let pi = 0; pi < products.length; pi++) {
    const product = products[pi];
    const code = product.productCode || '';
    const candidates = [];

    for (let ii = 0; ii < images.length; ii++) {
      const result = scoreMatch(code, images[ii].name);
      if (result.score > 0) {
        candidates.push({ imageIndex: ii, ...result });
      }
    }

    // Sort candidates by score descending
    candidates.sort((a, b) => b.score - a.score);

    let bestMatch = null;
    if (candidates.length > 0) {
      const best = candidates[0];
      // Only auto-assign if score >= 40 (token overlap threshold)
      if (best.score >= 40) {
        bestMatch = {
          imageIndex: best.imageIndex,
          score: best.score,
          matchType: best.matchType
        };
        usedImageIndices.add(best.imageIndex);
      }
    }

    matches.push({
      productIndex: pi,
      product: { ...product },
      matchedImage: bestMatch
        ? { ...images[bestMatch.imageIndex], ...bestMatch }
        : null,
      score: bestMatch?.score || 0,
      matchType: bestMatch?.matchType || 'none',
      allCandidates: candidates.map(c => ({
        imageIndex: c.imageIndex,
        score: c.score,
        matchType: c.matchType
      }))
    });
  }

  // Find unmatched images
  const unmatchedImages = [];
  for (let ii = 0; ii < images.length; ii++) {
    if (!usedImageIndices.has(ii)) {
      unmatchedImages.push({ imageIndex: ii, name: images[ii].name });
    }
  }

  const matched = matches.filter(m => m.matchedImage !== null).length;

  return {
    matches,
    unmatchedImages,
    matchStats: {
      total: products.length,
      matched,
      unmatched: products.length - matched
    }
  };
}

/**
 * Split a string into alphanumeric tokens for fuzzy matching.
 * e.g. "HACH-005R" → ["hach", "005", "r"]
 *       "img_CH-005_v1" → ["img", "ch", "005", "v1"]
 *
 * @param {string} str
 * @returns {string[]}
 */
function tokenize(str) {
  return str
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 0);
}
