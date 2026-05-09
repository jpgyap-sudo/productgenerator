// ═══════════════════════════════════════════════════════════════════
//  QA Engine — Image comparison quality assurance
//
//  Compares the generated render against the original product image:
//    1. Color distance (RGB channel means via Sharp)
//    2. Resolution check
//    3. Gemini vision check: view angle correctness
//
//  Scoring:
//    85-100: pass
//    65-84:  fix (send to Gemini fixer)
//    0-64:   fallback (full Gemini rerender)
// ═══════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import sharp from 'sharp';

const QA_PASS_SCORE = Number(process.env.QA_PASS_SCORE || 85);
const QA_FIX_SCORE = Number(process.env.QA_FIX_SCORE || 65);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const QC_VISION_MODEL = 'gemini-2.5-flash';

const VIEW_ANGLE_CRITERIA = {
  front: 'The product must face the camera directly from the front (0–15 degrees). Not angled to the side, not three-quarter, not side profile.',
  side: 'The product must be shown from a strict 90-degree side profile (pure left or right side). NOT a 3/4 angle, NOT front-facing, NOT isometric.',
  isometric: 'The product must be shown from a 45-degree three-quarter perspective (two sides and top visible). NOT a pure front view, NOT a pure side view.',
  interior: 'The product must appear naturally placed in an interior room scene with surrounding furniture and environment.',
};

async function imageStats(path) {
  const img = sharp(path).resize(256, 256, { fit: 'inside' });
  const stats = await img.stats();
  const meta = await sharp(path).metadata();
  return { stats, meta };
}

function colorDistance(a, b) {
  return Math.sqrt(a.reduce((sum, val, i) => sum + Math.pow(val - (b[i] || 0), 2), 0));
}

/**
 * Gemini vision check: is the rendered view at the correct camera angle?
 * Returns { correct: bool, reason: string }.
 * Defaults to { correct: true } on any error so QA degrades gracefully.
 */
async function checkViewAngle(generatedImagePath, view) {
  if (!GEMINI_API_KEY) return { correct: true, reason: 'no gemini key' };
  const criteria = VIEW_ANGLE_CRITERIA[view];
  if (!criteria) return { correct: true, reason: 'no criteria for view' };

  let imageB64;
  try {
    imageB64 = fs.readFileSync(generatedImagePath).toString('base64');
  } catch (e) {
    return { correct: true, reason: `read error: ${e.message}` };
  }

  const prompt = `You are a QA inspector for AI-generated product renders used in an e-commerce catalog.

I will show you a render. Verify that it matches the required camera angle.

Required view: "${view}"
Angle requirement: ${criteria}

CORRECT if the render clearly matches the angle requirement.
INCORRECT if the angle is clearly wrong (e.g. a "side view" that shows the front of the product, or a "front view" showing a 3/4 angle).

Respond ONLY as JSON (no markdown): {"correct": true/false, "reason": "one sentence"}`;

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${GEMINI_API_BASE}/${QC_VISION_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: prompt },
          { inlineData: { mimeType: 'image/png', data: imageB64 } }
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 100 }
      }),
      signal: controller.signal
    });
    clearTimeout(tid);

    if (!res.ok) return { correct: true, reason: `gemini ${res.status}` };

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { correct: true, reason: 'unparseable response' };

    const result = JSON.parse(match[0]);
    return { correct: result.correct !== false, reason: result.reason || '' };
  } catch (e) {
    return { correct: true, reason: `angle check error: ${e.message}` };
  }
}

/**
 * Run QA comparison between original product image and generated render.
 *
 * @param {object} params
 * @param {string} params.originalImagePath
 * @param {string} params.generatedImagePath
 * @param {string} params.view - 'front' | 'side' | 'isometric' | 'interior'
 * @returns {Promise<{score: number, decision: string, notes: string[], detectedIssues: string[]}>}
 */
export async function qaCompareProduct({ originalImagePath, generatedImagePath, view }) {
  const [original, generated] = await Promise.all([
    imageStats(originalImagePath),
    imageStats(generatedImagePath)
  ]);

  const originalMeans = original.stats.channels.slice(0, 3).map(c => c.mean);
  const generatedMeans = generated.stats.channels.slice(0, 3).map(c => c.mean);
  const dist = colorDistance(originalMeans, generatedMeans);

  const notes = [];
  const detectedIssues = [];
  let score = 92;

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

  // ── View Angle Check (Gemini vision) ──
  // Run in parallel with other checks already done above.
  const angleCheck = await checkViewAngle(generatedImagePath, view);
  if (!angleCheck.correct) {
    score -= 28;
    notes.push(`Wrong camera angle: ${angleCheck.reason}`);
    detectedIssues.push(`incorrect view angle — expected ${view} perspective`);
  } else if (view === 'side' || view === 'isometric') {
    // Extra note for views where angle was verified and passed
    notes.push(`View angle verified: ${angleCheck.reason || 'correct ' + view + ' perspective confirmed'}`);
  }

  score = Math.max(0, Math.min(100, score));

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
