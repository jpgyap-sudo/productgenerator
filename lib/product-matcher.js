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
 * Extract the numeric part from a product code.
 * e.g. "CH-790" → 790, "HA-005" → 5, "CH-735-40T" → 735
 * @param {string} code
 * @returns {number|null}
 */
function extractCodeNumber(code) {
  if (!code) return null;
  // Match the first numeric sequence after a letter prefix
  const match = code.match(/[A-Za-z]{1,4}[-_]?(\d{2,4})/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract all numeric sequences from an image filename.
 * For xref-style names, the xref number is given priority.
 * e.g. "chair/chair_p01_01_xref14.jpeg" → [14, 1, 1]  (xref first)
 *       "CH-005_front.jpg" → [5]
 * @param {string} name
 * @returns {number[]}
 */
function extractImageNumbers(name) {
  const nameNoExt = name.replace(/\.[^.]+$/, '');
  const matches = nameNoExt.match(/\d+/g);
  if (!matches) return [];

  const nums = matches.map(n => parseInt(n, 10));

  // If the filename contains "xref", move the xref number to the front
  // so it gets matched first. xref numbers are typically the last numeric segment.
  const xrefMatch = nameNoExt.match(/xref(\d+)/i);
  if (xrefMatch) {
    const xrefNum = parseInt(xrefMatch[1], 10);
    const idx = nums.indexOf(xrefNum);
    if (idx > 0) {
      nums.splice(idx, 1);
      nums.unshift(xrefNum);
    }
  }

  return nums;
}

/**
 * Cross-reference match: when product codes (e.g. CH-790) don't appear in
 * image filenames (e.g. xref14), try to match by extracting numeric parts
 * from both and finding the best correlation.
 *
 * Strategy:
 * 1. Extract the numeric part of the product code (e.g. 790 from CH-790)
 * 2. Extract all numeric parts from the image filename (e.g. [1, 1, 14] from xref14)
 * 3. Score based on how close the numbers are (exact match = 50, close = 30-40)
 *
 * @param {string} productCode
 * @param {string} imageName
 * @returns {{ score: number, matchType: string }}
 */
export function scoreCrossReference(productCode, imageName) {
  if (!productCode || !imageName) return { score: 0, matchType: 'none' };

  const codeNum = extractCodeNumber(productCode);
  if (codeNum === null) return { score: 0, matchType: 'none' };

  const imageNums = extractImageNumbers(imageName);
  if (imageNums.length === 0) return { score: 0, matchType: 'none' };

  // Only match product codes with 3+ digit numbers (e.g. 002, 790, 800)
  // to avoid false positives from small position numbers (e.g. p01_01 → 1)
  if (codeNum < 100) return { score: 0, matchType: 'none' };

  // Check if the code number appears directly in the image numbers
  for (const imgNum of imageNums) {
    if (imgNum === codeNum) {
      return { score: 50, matchType: 'xref-number-match' };
    }
  }

  // Check for close numeric match (within 5% or within 2)
  for (const imgNum of imageNums) {
    const diff = Math.abs(imgNum - codeNum);
    const ratio = diff / Math.max(codeNum, 1);
    if (diff <= 2) {
      return { score: 40, matchType: 'xref-close-match' };
    }
    if (ratio <= 0.05) {
      return { score: 30, matchType: 'xref-close-ratio' };
    }
  }

  return { score: 0, matchType: 'none' };
}

/**
 * Match an array of products (with productCode) to an array of images (with name).
 * Returns match suggestions with scores.
 *
 * Strategy:
 * 1. Pattern matching (exact, substring, token overlap) — score 0-100
 * 2. Cross-reference matching (xref numbers) — score 30-50
 * 3. Sequential fallback (assign images in order) — score 10 (last resort)
 *
 * @param {Array<{productCode: string, name: string, ...}>} products
 * @param {Array<{name: string, dataUrl?: string, ...}>} images
 * @param {Object} [options]
 * @param {boolean} [options.useSequentialFallback=false] - If true, assign remaining
 *        unmatched products to remaining images sequentially (last resort).
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
export function matchProductsToImages(products, images, options = {}) {
  const { useSequentialFallback = false } = options;
  const matches = [];
  const usedImageIndices = new Set();

  for (let pi = 0; pi < products.length; pi++) {
    const product = products[pi];
    // Normalize: try productCode first, then generatedCode, then name-based extraction
    let code = product.productCode || product.generatedCode || '';
    // If still empty, try to extract a code from the product name
    if (!code && product.name) {
      const nameMatch = product.name.match(/([A-Za-z]{1,4}[-_]\d{2,4})/);
      if (nameMatch) code = nameMatch[1];
    }
    const candidates = [];

    for (let ii = 0; ii < images.length; ii++) {
      // Primary: pattern-based matching (exact, substring, token overlap)
      const primaryResult = scoreMatch(code, images[ii].name);

      // Secondary: cross-reference matching for xref-style names
      const xrefResult = scoreCrossReference(code, images[ii].name);

      // Use the best score
      const result = primaryResult.score >= xrefResult.score ? primaryResult : xrefResult;

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

  // ── SEQUENTIAL FALLBACK REMOVED ──
  // The old sequential fallback assigned unmatched products to remaining images
  // in order (score: 10, matchType: 'sequential-fallback'), creating fake 10% matches.
  // This has been removed per the batch matching system upgrade.
  // Products without a pattern match are now handled by:
  //   1. Fast candidate filtering (attribute-based, no AI)
  //   2. OpenAI Vision verification (strict JSON, confidence scoring)
  //   3. Manual review for items below auto-accept threshold
  // See: lib/candidate-filter.js, lib/openai-verify.js, lib/batch-queue.js

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
