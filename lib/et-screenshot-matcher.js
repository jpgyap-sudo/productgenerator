// ═══════════════════════════════════════════════════════════════════
//  et-screenshot-matcher.js
//
//  Visual row-alignment matcher for .et spreadsheet images.
//
//  Problem:
//    When .et files are converted to .xlsx via LibreOffice, the embedded
//    images (DISPIMG) are extracted but the row mapping is unreliable.
//    LibreOffice may reorder images during conversion, making it impossible
//    to know which image belongs to which product row via positional mapping.
//
//  Solution:
//    1. Convert .et → PDF via LibreOffice (preserves visual layout)
//    2. Use Playwright to screenshot each PDF page
//    3. Send the screenshot to AI vision to visually determine which image
//       belongs to which product row
//    4. Return a row-to-image map that's more accurate than positional mapping
//
//  This approach lets the AI see the ACTUAL rendered spreadsheet layout,
//  including images embedded in their correct cells, and visually match
//  each product row to its corresponding image.
// ═══════════════════════════════════════════════════════════════════

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ──────────────────────────────────────────────────

const LIBREOFFICE_TIMEOUT = 60000; // 60s for LibreOffice conversion
const SCREENSHOT_TIMEOUT = 30000;  // 30s for Playwright screenshot
const PDF_RENDER_TIMEOUT = 15000;  // 15s for PDF.js to render

const OPENAI_API_KEY = () => process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY;
const VERIFY_MODEL = process.env.OPENAI_VERIFY_MODEL || 'gpt-4o-mini';
const OPENAI_API_BASE = 'https://api.openai.com/v1';
const GEMINI_VERIFY_MODEL = process.env.GEMINI_VERIFY_MODEL || 'gemini-2.0-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── Step 1: Convert .et to PDF via LibreOffice ────────────────────

/**
 * Convert a .et buffer to PDF using LibreOffice.
 * @param {Buffer} etBuffer - Raw .et file buffer
 * @param {string} tempDir - Temporary directory for conversion
 * @returns {Promise<Buffer>} PDF file buffer
 */
async function convertETtoPDF(etBuffer, tempDir) {
  const timestamp = Date.now();
  const inputPath = path.join(tempDir, `input_${timestamp}.et`);
  const outputPath = path.join(tempDir, `input_${timestamp}.pdf`);

  // Write .et to temp file
  await fs.promises.writeFile(inputPath, etBuffer);

  return new Promise((resolve, reject) => {
    const soffice = spawn('soffice', [
      '--headless',
      '--convert-to', 'pdf',
      '--outdir', tempDir,
      inputPath
    ], {
      timeout: LIBREOFFICE_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    soffice.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    soffice.on('close', async (code) => {
      // Clean up input .et file
      try { await fs.promises.unlink(inputPath); } catch {}

      if (code !== 0) {
        try { await fs.promises.unlink(outputPath); } catch {}
        return reject(new Error(`LibreOffice PDF conversion failed (exit ${code}): ${stderr.trim() || 'Unknown error'}`));
      }

      try {
        const pdfBuffer = await fs.promises.readFile(outputPath);
        // Clean up output file
        try { await fs.promises.unlink(outputPath); } catch {}
        console.log(`[ET-SCREENSHOT] PDF conversion successful (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);
        resolve(pdfBuffer);
      } catch (readErr) {
        reject(new Error(`Failed to read converted PDF: ${readErr.message}`));
      }
    });

    soffice.on('error', (err) => {
      try { fs.promises.unlink(inputPath); } catch {}
      try { fs.promises.unlink(outputPath); } catch {}
      reject(new Error(`LibreOffice not found: ${err.message}`));
    });
  });
}

// ── Step 2: Screenshot PDF pages using Playwright ─────────────────

/**
 * Convert PDF buffer to page screenshots using Playwright.
 * Opens the PDF in a browser using PDF.js viewer and screenshots each page.
 *
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @returns {Promise<string[]>} Array of base64 data URLs, one per page
 */
async function screenshotPDFPages(pdfBuffer) {
  // Use system Chromium if PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is set
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    console.log(`[ET-SCREENSHOT] Using system Chromium at: ${launchOptions.executablePath}`);
  }
  const browser = await chromium.launch(launchOptions);

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 10800 }, // Tall viewport to fit all PDF pages
      deviceScaleFactor: 2 // Retina quality for AI vision
    });

    const page = await context.newPage();

    // Create a data URL for the PDF
    const base64PDF = pdfBuffer.toString('base64');
    const pdfDataUrl = `data:application/pdf;base64,${base64PDF}`;

    // Use PDF.js built into Chrome to render the PDF
    // We embed PDF.js directly via a data URL
    const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; background: #525659; display: flex; flex-direction: column; align-items: center; }
    .page-container { margin: 8px auto; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    canvas { display: block; width: 100%; }
  </style>
</head>
<body>
  <div id="container"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const loadingTask = pdfjsLib.getDocument('${pdfDataUrl}');
    loadingTask.promise.then(async function(pdf) {
      const container = document.getElementById('container');
      const totalPages = pdf.numPages;
      for (let i = 1; i <= totalPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.className = 'page-container';
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        container.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
      }
      // Signal that rendering is complete
      document.title = 'PDF_RENDERED_' + totalPages;
    });
  </script>
</body>
</html>`;

    // Write HTML to temp file and load it
    const tempDir = path.dirname(pdfDataUrl.replace('data:application/pdf;base64,', ''));
    // Actually, let's use a different approach - write the HTML to a temp file
    const htmlPath = path.join(process.cwd(), 'uploads', `pdf_viewer_${Date.now()}.html`);
    await fs.promises.writeFile(htmlPath, htmlContent);

    await page.goto(`file://${htmlPath}`, {
      waitUntil: 'networkidle',
      timeout: SCREENSHOT_TIMEOUT
    });

    // Wait for PDF to render
    await page.waitForFunction(
      () => document.title.startsWith('PDF_RENDERED_'),
      { timeout: PDF_RENDER_TIMEOUT }
    );

    // Get total pages from title
    const title = await page.title();
    const totalPages = parseInt(title.replace('PDF_RENDERED_', ''), 10);
    console.log(`[ET-SCREENSHOT] PDF has ${totalPages} page(s)`);

    // Screenshot each page canvas
    const screenshots = [];
    const canvases = await page.$$('canvas');
    for (let i = 0; i < canvases.length; i++) {
      const canvas = canvases[i];

      // Scroll the canvas into view before screenshotting
      await page.evaluate((el) => el.scrollIntoView({ behavior: 'instant', block: 'center' }), canvas);
      // Small delay to let rendering settle
      await page.waitForTimeout(200);

      // Use element screenshot to capture just the canvas (avoids viewport clipping issues)
      const screenshotBuffer = await canvas.screenshot({ type: 'png' });

      const dataUrl = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
      screenshots.push(dataUrl);
      console.log(`[ET-SCREENSHOT] Page ${i + 1}/${totalPages} screenshot: ${(screenshotBuffer.length / 1024).toFixed(1)} KB`);
    }

    // Clean up temp HTML
    try { await fs.promises.unlink(htmlPath); } catch {}

    return screenshots;
  } finally {
    await browser.close();
  }
}

// ── Step 3: AI Vision to determine row-to-image mapping ───────────

/**
 * Use AI vision to analyze a spreadsheet screenshot and determine
 * which image belongs to which product row.
 *
 * @param {string} screenshotDataUrl - Base64 PNG data URL of the spreadsheet page
 * @param {Array<object>} products - Products extracted from the spreadsheet
 * @param {Array<object>} images - Images extracted from the spreadsheet
 * @param {number} pageIndex - Which page this is (0-based)
 * @returns {Promise<Array<{productIndex: number, imageIndex: number, confidence: number}>>}
 */
async function analyzeScreenshotWithAI(screenshotDataUrl, products, images, pageIndex) {
  const openaiKey = OPENAI_API_KEY();
  const geminiKey = GEMINI_API_KEY();

  if (!openaiKey && !geminiKey) {
    console.log('[ET-SCREENSHOT] No API keys configured, skipping AI analysis');
    return null;
  }

  // Build a concise product list for the prompt
  const productList = products.map((p, i) =>
    `  ${i + 1}. "${p.name || 'Unknown'}" (code: ${p.productCode || 'N/A'}, brand: ${p.brand || 'N/A'})`
  ).join('\n');

  const imageList = images.map((img, i) =>
    `  ${i + 1}. "${img.name || `image${i + 1}`}"`
  ).join('\n');

  const prompt = `You are analyzing a screenshot of a spreadsheet from a furniture company's .et file.

The spreadsheet has product rows. Each row has product text in columns on the left, and an image thumbnail in a column on the right.

PRODUCTS (${products.length} total — listed in spreadsheet order):
${productList}

IMAGES available (${images.length} total — these are the actual image thumbnails embedded in the spreadsheet cells):
${imageList}

YOUR TASK — ROW ALIGNMENT ONLY:
Look at the screenshot and determine which IMAGE THUMBNAIL is visually positioned next to each product row.

This is purely a SPATIAL/VISUAL task:
- Find each product's text in the screenshot
- Look to the right of that text for the image thumbnail
- Report which image (by index from the list above) appears in that row

CRITICAL RULES:
- Do NOT use product descriptions to match — only use VISUAL POSITION (which image thumbnail is horizontally aligned with which row of text)
- If a product's text is visible but no image thumbnail is next to it, set imageIndex to -1
- If you can see which image thumbnail is in each row, report the mapping
- The same image may repeat across multiple rows — that's expected
- confidence: 0-100 based ONLY on how clearly you can see the row alignment

Return a JSON array:
[
  { "productIndex": 0, "imageIndex": 0, "confidence": 95, "reason": "Image 1 thumbnail is clearly positioned to the right of product 1's row" },
  { "productIndex": 1, "imageIndex": 1, "confidence": 90, "reason": "Image 2 thumbnail is aligned with product 2's row" }
]

Return ONLY valid JSON array, no markdown, no code fences.`;

  // Try OpenAI first
  if (openaiKey) {
    try {
      console.log(`[ET-SCREENSHOT] Analyzing page ${pageIndex + 1} with OpenAI...`);
      const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`
        },
        body: JSON.stringify({
          model: VERIFY_MODEL,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: screenshotDataUrl,
                  detail: 'high'
                }
              }
            ]
          }],
          max_tokens: 2000,
          temperature: 0.1,
          response_format: { type: 'json_object' }
        }),
        signal: AbortSignal.timeout(60000)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`OpenAI API error (${res.status}): ${errText.substring(0, 200)}`);
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response from OpenAI');

      let result;
      try {
        result = JSON.parse(content);
      } catch (parseErr) {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error(`Failed to parse: ${parseErr.message}`);
        }
      }

      // Handle both array and {mappings: [...]} formats
      const mappings = Array.isArray(result) ? result : (result.mappings || result.map || []);
      console.log(`[ET-SCREENSHOT] OpenAI returned ${mappings.length} mappings for page ${pageIndex + 1}`);
      return mappings;
    } catch (err) {
      console.error(`[ET-SCREENSHOT] OpenAI analysis failed: ${err.message}`);
      // Fall through to Gemini
    }
  }

  // Fallback to Gemini
  if (geminiKey) {
    try {
      console.log(`[ET-SCREENSHOT] Analyzing page ${pageIndex + 1} with Gemini fallback...`);

      // Extract base64 data
      const matches = screenshotDataUrl.match(/^data:image\/\w+;base64,(.+)$/);
      if (!matches) throw new Error('Invalid screenshot data URL');

      const apiUrl = `${GEMINI_API_BASE}/${GEMINI_VERIFY_MODEL}:generateContent?key=${geminiKey}`;

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: matches[1]
                }
              }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2000
          }
        }),
        signal: AbortSignal.timeout(60000)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Gemini API error (${res.status}): ${errText.substring(0, 200)}`);
      }

      const data = await res.json();
      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) throw new Error('Empty Gemini response');

      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array in Gemini response');

      const result = JSON.parse(jsonMatch[0]);
      const mappings = Array.isArray(result) ? result : (result.mappings || result.map || []);
      console.log(`[ET-SCREENSHOT] Gemini returned ${mappings.length} mappings for page ${pageIndex + 1}`);
      return mappings;
    } catch (err) {
      console.error(`[ET-SCREENSHOT] Gemini analysis also failed: ${err.message}`);
    }
  }

  return null;
}

// ── Main entry point ──────────────────────────────────────────────

/**
 * Use Playwright screenshot + AI vision to determine the correct
 * row-to-image mapping for .et spreadsheet products.
 *
 * @param {Buffer} etBuffer - Raw .et file buffer
 * @param {Array<object>} products - Products extracted from the .et file
 * @param {Array<object>} images - Images extracted from the .et file
 * @param {string} tempDir - Temporary directory for conversion
 * @returns {Promise<{rowImageMap: Map<number, object>, method: string}>}
 */
export async function matchRowsViaScreenshot(etBuffer, products, images, tempDir) {
  console.log(`[ET-SCREENSHOT] Starting visual row alignment: ${products.length} products, ${images.length} images`);

  if (!products || products.length === 0 || !images || images.length === 0) {
    console.log('[ET-SCREENSHOT] No products or images to match');
    return { rowImageMap: new Map(), method: 'none' };
  }

  // Step 1: Convert .et to PDF
  console.log('[ET-SCREENSHOT] Step 1: Converting .et to PDF...');
  let pdfBuffer;
  try {
    pdfBuffer = await convertETtoPDF(etBuffer, tempDir);
  } catch (err) {
    console.error(`[ET-SCREENSHOT] PDF conversion failed: ${err.message}`);
    return { rowImageMap: new Map(), method: 'conversion_failed' };
  }

  // Step 2: Screenshot PDF pages
  console.log('[ET-SCREENSHOT] Step 2: Screenshotting PDF pages...');
  let screenshots;
  try {
    screenshots = await screenshotPDFPages(pdfBuffer);
  } catch (err) {
    console.error(`[ET-SCREENSHOT] Screenshot failed: ${err.message}`);
    return { rowImageMap: new Map(), method: 'screenshot_failed' };
  }

  if (screenshots.length === 0) {
    console.log('[ET-SCREENSHOT] No screenshots generated');
    return { rowImageMap: new Map(), method: 'no_screenshots' };
  }

  // Step 3: Analyze each page with AI vision
  console.log('[ET-SCREENSHOT] Step 3: Analyzing screenshots with AI vision...');

  // Distribute products across pages
  const productsPerPage = Math.ceil(products.length / screenshots.length);
  const allMappings = [];

  for (let pageIdx = 0; pageIdx < screenshots.length; pageIdx++) {
    const pageStart = pageIdx * productsPerPage;
    const pageEnd = Math.min(pageStart + productsPerPage, products.length);
    const pageProducts = products.slice(pageStart, pageEnd);

    console.log(`[ET-SCREENSHOT] Analyzing page ${pageIdx + 1}/${screenshots.length} (products ${pageStart + 1}-${pageEnd})...`);

    const mappings = await analyzeScreenshotWithAI(
      screenshots[pageIdx],
      pageProducts,
      images,
      pageIdx
    );

    if (mappings && mappings.length > 0) {
      // Adjust product indices to be global (not page-relative)
      for (const m of mappings) {
        allMappings.push({
          ...m,
          productIndex: pageStart + (m.productIndex || 0)
        });
      }
    }
  }

  // Step 4: Build the row-to-image map
  const rowImageMap = new Map();

  if (allMappings.length === 0) {
    console.log('[ET-SCREENSHOT] AI returned no mappings, falling back to positional mapping');
    return { rowImageMap, method: 'ai_failed' };
  }

  // Apply mappings: for each product, find its image
  for (const mapping of allMappings) {
    const productIdx = mapping.productIndex;
    const imageIdx = mapping.imageIndex;
    const confidence = mapping.confidence || 0;

    if (productIdx >= 0 && productIdx < products.length &&
        imageIdx >= 0 && imageIdx < images.length &&
        confidence > 0) {
      const product = products[productIdx];
      const image = images[imageIdx];

      // Map by the product's spreadsheet row
      if (product.row !== undefined) {
        rowImageMap.set(product.row, {
          ...image,
          _aiConfidence: confidence,
          _aiReason: mapping.reason || ''
        });
        console.log(`[ET-SCREENSHOT] Mapped product #${productIdx + 1} (row ${product.row}) → image "${image.name}" (confidence: ${confidence})`);
      }
    }
  }

  console.log(`[ET-SCREENSHOT] Visual row alignment complete: ${rowImageMap.size}/${products.length} products mapped`);
  return { rowImageMap, method: 'visual_ai' };
}

/**
 * Quick test function to verify Playwright PDF screenshot works.
 */
export async function testScreenshotPipeline() {
  console.log('[ET-SCREENSHOT] Running pipeline test...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2
    });

    const page = await context.newPage();

    // Test with a simple HTML page
    await page.setContent(`
      <html>
      <body style="background:white;padding:20px;font-family:Arial;">
        <h1>Test Spreadsheet</h1>
        <table border="1" cellpadding="8">
          <tr><th>Product</th><th>Code</th><th>Image</th></tr>
          <tr><td>Dining Chair A</td><td>DC-001</td><td style="width:100px;height:100px;background:#4CAF50;">🍃</td></tr>
          <tr><td>Dining Chair B</td><td>DC-002</td><td style="width:100px;height:100px;background:#2196F3;">💧</td></tr>
        </table>
      </body>
      </html>
    `);

    const screenshot = await page.screenshot({ type: 'png' });
    console.log(`[ET-SCREENSHOT] Test screenshot: ${(screenshot.length / 1024).toFixed(1)} KB`);
    console.log('[ET-SCREENSHOT] Pipeline test PASSED');

    return `data:image/png;base64,${screenshot.toString('base64')}`;
  } finally {
    await browser.close();
  }
}
