// ═══════════════════════════════════════════════════════════════════
//  lib/candidate-filter.js — Fast Candidate Filtering (NO AI)
//
//  Before sending to OpenAI for verification, filter ZIP images by
//  matching product attributes (type, color, material, style, arms)
//  against image fingerprints. This reduces the candidate pool from
//  100+ images to ~5 likely matches, massively reducing API costs.
//
//  Architecture:
//    1. Parse product info from PDF extraction (type, color, material)
//    2. Load image fingerprints (from Step 2 fingerprinting)
//    3. Score each image against the product using attribute matching
//    4. Return top N candidates for OpenAI verification
//
//  Key rules:
//    - NO AI calls in this step — purely attribute-based scoring
//    - Returns top 5 candidates max (configurable)
//    - Minimum score threshold to be considered a candidate
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_MIN_SCORE = 10;

/**
 * Score a single image fingerprint against a product's attributes.
 * Returns a score 0-100 based on how well the attributes match.
 *
 * @param {object} product - Product info from PDF extraction
 * @param {object} fingerprint - Image fingerprint from Step 2
 * @returns {number} Match score 0-100
 */
export function scoreCandidate(product, fingerprint) {
  if (!fingerprint) return 0;

  let score = 0;
  let totalWeight = 0;

  // ── 1. Type match (weight: 30) ──────────────────────────────────
  // If product has a category/type, check against fingerprint type
  totalWeight += 30;
  const productType = (product.category || product.type || '').toLowerCase().trim();
  const fpType = (fingerprint.type || '').toLowerCase().trim();

  if (productType && fpType) {
    // Exact match
    if (fpType === productType) {
      score += 30;
    }
    // Partial match (e.g. "dining chair" vs "chair")
    else if (fpType.includes(productType) || productType.includes(fpType)) {
      score += 20;
    }
    // Related types (e.g. "sofa" vs "loveseat")
    else if (areRelatedTypes(productType, fpType)) {
      score += 10;
    }
  } else if (!productType) {
    // No product type info — neutral (give partial credit)
    score += 15;
  }

  // ── 2. Color match (weight: 20) ─────────────────────────────────
  totalWeight += 20;
  const productColor = (product.color || '').toLowerCase().trim();
  const fpColor = (fingerprint.dominant_color || '').toLowerCase().trim();

  if (productColor && fpColor) {
    if (fpColor === productColor) {
      score += 20;
    } else if (areSimilarColors(productColor, fpColor)) {
      score += 12;
    } else if (fpColor.includes(productColor) || productColor.includes(fpColor)) {
      score += 8;
    }
  } else if (!productColor) {
    score += 10; // Neutral
  }

  // ── 3. Material match (weight: 15) ──────────────────────────────
  totalWeight += 15;
  const productMaterial = (product.material || '').toLowerCase().trim();
  const fpMaterial = (fingerprint.material || '').toLowerCase().trim();

  if (productMaterial && fpMaterial) {
    if (fpMaterial === productMaterial) {
      score += 15;
    } else if (fpMaterial.includes(productMaterial) || productMaterial.includes(fpMaterial)) {
      score += 10;
    } else if (areCompatibleMaterials(productMaterial, fpMaterial)) {
      score += 5;
    }
  } else if (!productMaterial) {
    score += 7;
  }

  // ── 4. Style match (weight: 15) ─────────────────────────────────
  totalWeight += 15;
  const productStyle = (product.style || '').toLowerCase().trim();
  const fpStyle = (fingerprint.style || '').toLowerCase().trim();

  if (productStyle && fpStyle) {
    if (fpStyle === productStyle) {
      score += 15;
    } else if (fpStyle.includes(productStyle) || productStyle.includes(fpStyle)) {
      score += 10;
    } else if (areCompatibleStyles(productStyle, fpStyle)) {
      score += 5;
    }
  } else if (!productStyle) {
    score += 7;
  }

  // ── 5. Arms match (weight: 10) ──────────────────────────────────
  totalWeight += 10;
  // Try to infer from product description if arms info is available
  const productDesc = (product.description || '').toLowerCase();
  const hasArmsMentioned = productDesc.includes('arm') || productDesc.includes('armchair');

  if (hasArmsMentioned) {
    if (fingerprint.has_arms === true) {
      score += 10;
    } else if (fingerprint.has_arms === false) {
      score += 2; // Mismatch but could be wrong
    }
  } else if (fingerprint.has_arms !== undefined) {
    // No arms info in product — neutral
    score += 5;
  }

  // ── 6. Keyword overlap (weight: 10) ─────────────────────────────
  totalWeight += 10;
  if (fingerprint.keywords && Array.isArray(fingerprint.keywords) && productDesc) {
    const matchedKeywords = fingerprint.keywords.filter(kw =>
      productDesc.includes(kw.toLowerCase())
    );
    if (matchedKeywords.length > 0) {
      score += Math.min(10, matchedKeywords.length * 3);
    }
  }

  // Calculate final percentage
  if (totalWeight === 0) return 0;
  return Math.round((score / totalWeight) * 100);
}

/**
 * Filter and rank candidate images for a product based on fingerprints.
 *
 * @param {object} product - Product info from PDF extraction
 * @param {Array<object>} images - ZIP images with metadata
 * @param {object} fingerprintMap - Map of image_name -> fingerprint
 * @param {object} [options]
 * @param {number} [options.maxCandidates=5] - Max candidates to return
 * @param {number} [options.minScore=10] - Minimum score threshold
 * @returns {Array<object>} Ranked candidates [{ imageIndex, imageName, score }]
 */
export function filterCandidates(product, images, fingerprintMap, options = {}) {
  const maxCandidates = options.maxCandidates || DEFAULT_MAX_CANDIDATES;
  const minScore = options.minScore || DEFAULT_MIN_SCORE;

  if (!images || images.length === 0) {
    return [];
  }

  const scored = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const fingerprint = fingerprintMap[img.name] || null;
    const score = scoreCandidate(product, fingerprint);

    if (score >= minScore) {
      scored.push({
        imageIndex: i,
        imageName: img.name,
        score,
        fingerprint
      });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Return top N
  return scored.slice(0, maxCandidates);
}

/**
 * Filter candidates for all products in a batch.
 *
 * @param {Array<object>} products - All products from PDF extraction
 * @param {Array<object>} images - All ZIP images
 * @param {object} fingerprintMap - Map of image_name -> fingerprint
 * @param {object} [options]
 * @returns {Array<{productIndex: number, candidates: Array}>}
 */
export function filterAllCandidates(products, images, fingerprintMap, options = {}) {
  return products.map((product, index) => ({
    productIndex: index,
    product,
    candidates: filterCandidates(product, images, fingerprintMap, options)
  }));
}

// ── Helper: Type relationships ────────────────────────────────────

const RELATED_TYPE_MAP = {
  'chair': ['stool', 'bench', 'ottoman', 'armchair'],
  'sofa': ['loveseat', 'couch', 'settee', 'chaise'],
  'table': ['desk', 'counter', 'console'],
  'bed': ['daybed', 'bunk'],
  'cabinet': ['chest', 'dresser', 'wardrobe', 'buffet', 'hutch'],
  'desk': ['table', 'console'],
  'stool': ['chair', 'bench', 'ottoman'],
  'bench': ['chair', 'stool'],
  'ottoman': ['stool', 'chair']
};

function areRelatedTypes(typeA, typeB) {
  const related = RELATED_TYPE_MAP[typeA] || [];
  return related.includes(typeB);
}

// ── Helper: Color similarity ──────────────────────────────────────

const SIMILAR_COLORS = {
  'black': ['dark gray', 'charcoal', 'dark grey'],
  'white': ['cream', 'ivory', 'off-white', 'beige'],
  'brown': ['tan', 'beige', 'camel', 'chestnut', 'walnut', 'mahogany'],
  'gray': ['grey', 'silver', 'charcoal', 'slate'],
  'beige': ['cream', 'tan', 'ivory', 'sand', 'brown'],
  'blue': ['navy', 'teal', 'aqua', 'sky blue'],
  'green': ['olive', 'sage', 'emerald', 'forest'],
  'red': ['burgundy', 'maroon', 'crimson', 'wine'],
  'gold': ['brass', 'yellow', 'bronze'],
  'silver': ['gray', 'grey', 'chrome', 'stainless']
};

function areSimilarColors(colorA, colorB) {
  const similar = SIMILAR_COLORS[colorA] || [];
  return similar.includes(colorB);
}

// ── Helper: Material compatibility ────────────────────────────────

const COMPATIBLE_MATERIALS = {
  'fabric': ['leather', 'velvet', 'linen', 'cotton', 'polyester'],
  'leather': ['fabric', 'vegan leather', 'pu'],
  'wood': ['wood veneer', 'engineered wood', 'mdf', 'plywood', 'bamboo'],
  'metal': ['steel', 'iron', 'aluminum', 'chrome', 'brass'],
  'glass': ['crystal', 'acrylic']
};

function areCompatibleMaterials(matA, matB) {
  const compatible = COMPATIBLE_MATERIALS[matA] || [];
  return compatible.includes(matB);
}

// ── Helper: Style compatibility ───────────────────────────────────

const COMPATIBLE_STYLES = {
  'modern': ['contemporary', 'minimalist', 'mid-century'],
  'contemporary': ['modern', 'minimalist'],
  'traditional': ['rustic', 'classic', 'vintage'],
  'minimalist': ['modern', 'contemporary', 'scandinavian'],
  'scandinavian': ['minimalist', 'modern', 'mid-century'],
  'mid-century': ['modern', 'scandinavian', 'retro'],
  'industrial': ['modern', 'rustic'],
  'rustic': ['traditional', 'farmhouse', 'country'],
  'luxury': ['modern', 'contemporary', 'glam'],
  'vintage': ['traditional', 'retro', 'rustic']
};

function areCompatibleStyles(styleA, styleB) {
  const compatible = COMPATIBLE_STYLES[styleA] || [];
  return compatible.includes(styleB);
}
