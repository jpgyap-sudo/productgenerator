// ═══════════════════════════════════════════════════════════════════
//  Render Router — Orchestrates GPT main render → QA → fix/fallback
//
//  For each of the 4 views (front, side, isometric, interior):
//    1. GPT Image Mini generates the main render
//    2. QA engine compares against original product image
//    3. If score >= 85: pass — save as-is
//    4. If score 65-84: fix — Gemini Flash repair (up to 2 attempts)
//    5. If score < 65: fallback — full Gemini rerender
//    6. Save final output to Supabase storage
//
//  Integrates with existing lib/openai.js and lib/gemini.js modules.
// ═══════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { supabase, BUCKET_NAME } from './supabase.js';
import { generateOpenAIView } from './openai.js';
import { generateGeminiView } from './gemini.js';
import { mainRenderPrompt, geminiFixPrompt, geminiFallbackPrompt, VIEWS } from './prompts.js';
import { qaCompareProduct } from './qa-engine.js';

/** Maximum fix attempts before falling back */
const MAX_FIX_ATTEMPTS = Number(process.env.MAX_FIX_ATTEMPTS || 2);

/** Temporary working directory for render files */
const RENDER_TEMP_DIR = path.join(process.cwd(), 'public', 'renders');

/**
 * Ensure the temp renders directory exists.
 */
function ensureTempDir() {
  fs.mkdirSync(RENDER_TEMP_DIR, { recursive: true });
}

/**
 * Upload a local file to Supabase storage and return the public URL.
 * @param {string} filePath - Local file path
 * @param {string} key - Storage key (path within bucket)
 * @returns {Promise<string>} Public URL
 */
async function uploadToSupabase(filePath, key) {
  const buffer = fs.readFileSync(filePath);
  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(key, buffer, { upsert: true, contentType: 'image/png' });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(key);
  return data.publicUrl;
}

/**
 * Upload a local file to Supabase and return the public URL.
 * Falls back to a local path if Supabase upload fails.
 * @param {string} filePath - Local file path
 * @param {string} view - View name for the storage key
 * @returns {Promise<string>} Public URL
 */
async function finalizeOutput(filePath, view) {
  const key = `renders/${Date.now()}-${nanoid(8)}-${view}.png`;
  try {
    return await uploadToSupabase(filePath, key);
  } catch (err) {
    console.error(`[RENDER-ROUTER] Supabase upload failed for ${view}, using local path:`, err.message);
    // Fall back to local path relative to public/
    const relPath = path.relative(path.join(process.cwd(), 'public'), filePath);
    return `/public/${relPath}`;
  }
}

/**
 * Download a URL to a local file.
 * @param {string} url - The URL to download
 * @param {string} outputPath - Local file path to save to
 */
async function downloadUrlToFile(url, outputPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download from ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
}

/**
 * Generate all 4 render views for a product.
 *
 * @param {object} input
 * @param {string} input.originalImagePath - Local path to the uploaded product image
 * @param {string} [input.productName] - Optional product name
 * @param {string} [input.brand] - Optional brand
 * @param {string} [input.mode] - 'balanced' (default), 'gpt-only', or 'gemini-only'
 * @returns {Promise<Array<{view: string, status: string, imageUrl: string, qaScore?: number, qaDecision?: string, qaNotes?: string[], attempts: number}>>}
 */
export async function renderFourImages(input) {
  ensureTempDir();

  // First, upload the original product image to Supabase to get a URL
  // (the existing generateOpenAIView and generateGeminiView work with URLs)
  const originalKey = `renders/originals/${Date.now()}-${nanoid(8)}.png`;
  const originalImageUrl = await uploadToSupabase(input.originalImagePath, originalKey);

  const results = [];

  for (const view of VIEWS) {
    const result = await renderSingleView({
      originalImagePath: input.originalImagePath,
      originalImageUrl,
      productName: input.productName,
      brand: input.brand,
      mode: input.mode || 'balanced',
      view
    });
    results.push(result);
  }

  return results;
}

/**
 * Render a single view with the full QA pipeline.
 *
 * @param {object} params
 * @param {string} params.originalImagePath - Local path to original
 * @param {string} params.originalImageUrl - Public URL of original
 * @param {string} params.productName
 * @param {string} params.brand
 * @param {string} params.mode
 * @param {string} params.view - 'front', 'side', 'isometric', 'interior'
 * @returns {Promise<object>} Render result
 */
async function renderSingleView({ originalImagePath, originalImageUrl, productName, brand, mode, view }) {
  const baseName = `${view}.png`;
  const mainPath = path.join(RENDER_TEMP_DIR, `${Date.now()}-${nanoid(8)}-${baseName}`);

  // Map view name to view ID (1-4) for the existing generate functions
  const viewId = VIEWS.indexOf(view) + 1;
  const viewObj = { id: viewId, label: view };

  try {
    // ── Step 1: Generate main render ──
    if (mode === 'gemini-only') {
      // Gemini-only mode: skip GPT, go straight to Gemini
      const geminiResult = await generateGeminiView(viewObj, productName || '', originalImageUrl, '1K', brand || '', { forceFlash: true });
      await downloadUrlToFile(geminiResult.cdnUrl, mainPath);
    } else {
      // GPT main render
      const gptResult = await generateOpenAIView(viewObj, productName || '', originalImageUrl, '1K', brand || '', {});
      await downloadUrlToFile(gptResult.cdnUrl, mainPath);
    }

    // If gpt-only or gemini-only mode, skip QA and return immediately
    if (mode === 'gpt-only' || mode === 'gemini-only') {
      const publicUrl = await finalizeOutput(mainPath, view);
      return { view, status: 'generated', imageUrl: publicUrl, attempts: 1 };
    }

    // ── Step 2: QA check ──
    let qa = await qaCompareProduct({
      originalImagePath,
      generatedImagePath: mainPath,
      view
    });

    // Pass — save as-is
    if (qa.decision === 'pass') {
      const publicUrl = await finalizeOutput(mainPath, view);
      return {
        view,
        status: 'generated',
        imageUrl: publicUrl,
        qaScore: qa.score,
        qaDecision: qa.decision,
        qaNotes: qa.notes,
        attempts: 1
      };
    }

    // ── Step 3: Fix attempts (for score 65-84) ──
    if (qa.decision === 'fix') {
      let currentPath = mainPath;
      const initialQa = qa;

      for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        const fixedPath = path.join(RENDER_TEMP_DIR, `${Date.now()}-${nanoid(8)}-${view}-fixed-${attempt}.png`);
        const fixPrompt = geminiFixPrompt(view, qa.detectedIssues);

        let geminiResult;
        try {
          // Upload current render to Supabase to get a URL for Gemini
          const currentKey = `renders/temp/${Date.now()}-${nanoid(8)}-${view}-current.png`;
          await uploadToSupabase(currentPath, currentKey);

          geminiResult = await generateGeminiView(
            { id: viewId, label: `${view} (fix attempt ${attempt})` },
            fixPrompt,
            originalImageUrl,
            '1K',
            brand || '',
            { forceFlash: true }
          );
        } catch (geminiErr) {
          // Gemini quota or error — fall back to the original OpenAI render rather than failing
          console.warn(`[RENDER-ROUTER] Gemini fix failed for ${view} (attempt ${attempt}): ${geminiErr.message}. Saving original OpenAI render.`);
          const publicUrl = await finalizeOutput(mainPath, view);
          return {
            view,
            status: 'generated',
            imageUrl: publicUrl,
            qaScore: initialQa.score,
            qaDecision: 'gemini-unavailable',
            qaNotes: [`Gemini fix unavailable: ${geminiErr.message}`],
            attempts: 1
          };
        }

        await downloadUrlToFile(geminiResult.cdnUrl, fixedPath);

        // QA check the fixed version
        qa = await qaCompareProduct({
          originalImagePath,
          generatedImagePath: fixedPath,
          view
        });

        if (qa.decision === 'pass' || attempt === MAX_FIX_ATTEMPTS) {
          const publicUrl = await finalizeOutput(fixedPath, view);
          return {
            view,
            status: 'fixed',
            imageUrl: publicUrl,
            qaScore: qa.score,
            qaDecision: qa.decision,
            qaNotes: qa.notes,
            attempts: 1 + attempt
          };
        }

        currentPath = fixedPath;
      }
    }

    // ── Step 4: Fallback (score < 65 or fix exhausted) ──
    const fallbackPath = path.join(RENDER_TEMP_DIR, `${Date.now()}-${nanoid(8)}-${view}-fallback.png`);
    const fallbackPrompt = geminiFallbackPrompt(view);

    let geminiResult;
    try {
      geminiResult = await generateGeminiView(
        { id: viewId, label: `${view} (fallback)` },
        fallbackPrompt,
        originalImageUrl,
        '1K',
        brand || '',
        { forceFlash: true }
      );
    } catch (geminiErr) {
      // Gemini quota or error — save the original OpenAI render as the result
      console.warn(`[RENDER-ROUTER] Gemini fallback failed for ${view}: ${geminiErr.message}. Saving original OpenAI render.`);
      const publicUrl = await finalizeOutput(mainPath, view);
      return {
        view,
        status: 'generated',
        imageUrl: publicUrl,
        qaScore: qa.score,
        qaDecision: 'gemini-unavailable',
        qaNotes: [`Gemini unavailable: ${geminiErr.message}`],
        attempts: 1
      };
    }

    await downloadUrlToFile(geminiResult.cdnUrl, fallbackPath);

    // Final QA check on fallback
    qa = await qaCompareProduct({
      originalImagePath,
      generatedImagePath: fallbackPath,
      view
    });

    const publicUrl = await finalizeOutput(fallbackPath, view);
    return {
      view,
      status: 'fallback',
      imageUrl: publicUrl,
      qaScore: qa.score,
      qaDecision: qa.decision,
      qaNotes: qa.notes,
      attempts: 2
    };
  } catch (err) {
    console.error(`[RENDER-ROUTER] Error rendering ${view}:`, err);
    return {
      view,
      status: 'failed',
      qaNotes: [err.message],
      attempts: 1
    };
  }
}
