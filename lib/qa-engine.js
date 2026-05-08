// ═══════════════════════════════════════════════════════════════════
//  QA Engine — Image comparison quality assurance
//
//  Compares the generated render against the original product image
//  using Sharp-based analysis:
//    - Color distance (RGB channel means)
//    - Resolution check
//    - View-specific manual QA notes
//
//  Scoring:
//    85-100: pass
//    65-84:  fix (send to Gemini fixer)
//    0-64:   fallback (full Gemini rerender)
// ═══════════════════════════════════════════════════════════════════

import sharp from 'sharp';

/** Default QA thresholds */
const QA_PASS_SCORE = Number(process.env.QA_PASS_SCORE || 85);
const QA_FIX_SCORE = Number(process.env.QA_FIX_SCORE || 65);

/**
 * Extract image statistics for comparison.
 * Resizes to 256x256 for consistent color analysis.
 * @param {string} path - Image file path
 * @returns {Promise<{stats: import('sharp').Stats, meta: import('sharp').Metadata}>}
 */
async function imageStats(path) {
  const img = sharp(path).resize(256, 256, { fit: 'inside' });
  const stats = await img.stats();
  const meta = await sharp(path).metadata();
  return { stats, meta };
}

/**
 * Calculate Euclidean color distance between two RGB channel arrays.
 * @param {number[]} a - RGB means of first image
 * @param {number[]} b - RGB means of second image
 * @returns {number} Color distance
 */
function colorDistance(a, b) {
  return Math.sqrt(a.reduce((sum, val, i) => sum + Math.pow(val - (b[i] || 0), 2), 0));
}

/**
 * Run QA comparison between original product image and generated render.
 *
 * @param {object} params
 * @param {string} params.originalImagePath - Path to the original product image
 * @param {string} params.generatedImagePath - Path to the generated render
 * @param {string} params.view - The render view ('front', 'side', 'isometric', 'interior')
 * @returns {Promise<{score: number, decision: string, notes: string[], detectedIssues: string[]}>}
 */
export async function qaCompareProduct({ originalImagePath, generatedImagePath, view }) {
  const original = await imageStats(originalImagePath);
  const generated = await imageStats(generatedImagePath);

  const originalMeans = original.stats.channels.slice(0, 3).map(c => c.mean);
  const generatedMeans = generated.stats.channels.slice(0, 3).map(c => c.mean);
  const dist = colorDistance(originalMeans, generatedMeans);

  const notes = [];
  const detectedIssues = [];
  let score = 92; // Start high, deduct for issues

  // ── Color/Material Check ──
  if (dist > 70) {
    score -= 18;
    notes.push('Large average color/material shift detected.');
    detectedIssues.push('color or material differs from original reference');
  } else if (dist > 40) {
    score -= 8;
    notes.push('Moderate average color/material shift detected.');
    detectedIssues.push('possible color/material drift');
  }

  // ── Resolution Check ──
  const w = generated.meta.width || 0;
  const h = generated.meta.height || 0;
  if (w < 900 || h < 900) {
    score -= 10;
    notes.push('Output resolution is below recommended 1024px.');
    detectedIssues.push('low resolution or soft output');
  }

  // ── View-Specific Notes ──
  if (view === 'side') {
    notes.push('Manual/vision QA recommended: confirm true 90-degree side profile.');
  }
  if (view === 'isometric') {
    notes.push('Manual/vision QA recommended: confirm 45-degree three-quarter view.');
  }
  if (view === 'interior') {
    notes.push('Manual/vision QA recommended: confirm chair identity is preserved in room scene.');
  }

  // Clamp score to 0-100
  score = Math.max(0, Math.min(100, score));

  // Determine decision
  let decision;
  if (score >= QA_PASS_SCORE) {
    decision = 'pass';
  } else if (score >= QA_FIX_SCORE) {
    decision = 'fix';
  } else {
    decision = 'fallback';
  }

  return { score, decision, notes, detectedIssues };
}
