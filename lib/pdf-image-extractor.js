// ═══════════════════════════════════════════════════════════════════
//  lib/pdf-image-extractor.js — Extract images from PDF pages
//
//  Uses pdfjs-dist (via pdf-parse) + @napi-rs/canvas to render each
//  PDF page as a PNG image. These page images contain the product
//  photos embedded in the catalog PDF, which can then be visually
//  compared against ZIP images using GPT-4o Vision or Gemini.
//
//  This approach works cross-platform (Windows, Linux, macOS) without
//  requiring external binaries like poppler/pdftoppm.
//
//  Resources:
//    - pdfjs-dist: https://www.npmjs.com/package/pdfjs-dist
//    - @napi-rs/canvas: https://www.npmjs.com/package/@napi-rs/canvas
//
//  Usage:
//    const pages = await extractImagesFromPDF(pdfBuffer);
//    // pages[0] = { page: 1, dataUrl: "data:image/png;base64,...", width, height }
// ═══════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────
// CRITICAL: Polyfills MUST run at module load time, BEFORE any
// dynamic imports. pdfjs-dist v5 captures references to
// Buffer.prototype.transferToFixedLength and Promise.withResolvers
// at import time, so polyfilling inside ensureDependencies() is
// too late — pdfjs-dist will still see undefined.
// ────────────────────────────────────────────────────────────────────

if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

if (typeof Buffer.prototype.transferToFixedLength !== 'function') {
  Buffer.prototype.transferToFixedLength = function(size) {
    const newBuf = Buffer.alloc(size);
    const copyLen = Math.min(this.length, size);
    this.copy(newBuf, 0, 0, copyLen);
    return newBuf;
  };
}

const MAX_PAGES = 50;        // Max PDF pages to render
const RENDER_SCALE = 0.5;    // Render scale — 0.5 = half resolution (good balance)
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB max per page image

let pdfjsLib = null;
let canvasModule = null;

async function ensureDependencies() {
  if (pdfjsLib && canvasModule) return;

  try {
    // Load @napi-rs/canvas for rendering
    canvasModule = await import('@napi-rs/canvas');
    const { DOMMatrix, ImageData, Path2D } = canvasModule;

    // Polyfill globals needed by pdfjs-dist
    if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
    if (!globalThis.ImageData) globalThis.ImageData = ImageData;
    if (!globalThis.Path2D) globalThis.Path2D = Path2D;

    // Load pdfjs-dist (legacy build — recommended for Node.js environments)
    // The ESM build (pdfjs-dist/build/pdf.mjs) uses Node.js 22+ APIs like
    // Buffer.prototype.transferToFixedLength which are not available in
    // Node.js 20. The legacy build handles this correctly.
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

    console.log('[PDF-IMAGE-EXTRACTOR] Dependencies loaded (pdfjs-dist + @napi-rs/canvas)');
  } catch (err) {
    console.error('[PDF-IMAGE-EXTRACTOR] Failed to load dependencies:', err.message);
    throw new Error(`PDF image extraction dependencies unavailable: ${err.message}`);
  }
}

/**
 * Extract images from each page of a PDF using pdfjs-dist + @napi-rs/canvas.
 *
 * @param {Buffer} pdfBuffer - The PDF file buffer
 * @param {object} [options]
 * @param {number} [options.maxPages=50] - Max pages to render
 * @param {number} [options.scale=0.5] - Render scale (1.0 = full resolution)
 * @returns {Promise<Array<{page: number, dataUrl: string, width: number, height: number, size: number}>>}
 */
export async function extractImagesFromPDF(pdfBuffer, options = {}) {
  const maxPages = options.maxPages || MAX_PAGES;
  const scale = options.scale || RENDER_SCALE;

  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error('PDF buffer is required');
  }

  if (pdfBuffer.length === 0) {
    throw new Error('PDF buffer is empty');
  }

  console.log(`[PDF-IMAGE-EXTRACTOR] Rendering PDF pages as images (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB, scale: ${scale})`);

  // Ensure dependencies are loaded
  await ensureDependencies();

  const pages = [];

  try {
    // Load the PDF document
    // Use a copy of the underlying ArrayBuffer to avoid consuming the original Buffer.
    // pdfjs-dist may modify the ArrayBuffer during parsing, which would leave the
    // caller's Buffer empty for subsequent operations (e.g., text extraction).
    const bufferCopy = pdfBuffer.buffer.slice(0);
    const loadingTask = pdfjsLib.getDocument({ data: bufferCopy });
    const pdf = await loadingTask.promise;

    const totalPages = Math.min(pdf.numPages, maxPages);
    console.log(`[PDF-IMAGE-EXTRACTOR] PDF has ${pdf.numPages} pages, rendering up to ${totalPages}`);

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale });

        // Create a canvas using @napi-rs/canvas
        const canvas = canvasModule.createCanvas(viewport.width, viewport.height);
        const ctx = canvas.getContext('2d');

        // Render the PDF page to the canvas
        await page.render({ canvasContext: ctx, viewport }).promise;

        // Convert canvas to PNG buffer
        const pngBuffer = canvas.toBuffer('image/png');

        if (pngBuffer.length > MAX_IMAGE_SIZE) {
          console.log(`[PDF-IMAGE-EXTRACTOR] Page ${pageNum} image too large (${(pngBuffer.length / 1024 / 1024).toFixed(2)} MB), skipping`);
          continue;
        }

        if (pngBuffer.length < 1000) {
          console.log(`[PDF-IMAGE-EXTRACTOR] Page ${pageNum} appears empty (${pngBuffer.length} bytes), stopping`);
          break;
        }

        const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;

        pages.push({
          page: pageNum,
          dataUrl,
          width: viewport.width,
          height: viewport.height,
          size: pngBuffer.length
        });

        console.log(`[PDF-IMAGE-EXTRACTOR] Page ${pageNum}: ${viewport.width}x${viewport.height}, ${(pngBuffer.length / 1024).toFixed(1)} KB`);

        // Clean up page to free memory
        page.cleanup();
      } catch (pageErr) {
        console.error(`[PDF-IMAGE-EXTRACTOR] Failed to render page ${pageNum}: ${pageErr.message}`);
        // Continue with next page instead of failing entirely
        continue;
      }
    }

    // Clean up the PDF document
    pdf.destroy();

    console.log(`[PDF-IMAGE-EXTRACTOR] Extracted ${pages.length} page images from PDF`);
    return pages;

  } catch (err) {
    console.error(`[PDF-IMAGE-EXTRACTOR] Error: ${err.message}`);
    throw err;
  }
}

/**
 * Extract images from a PDF file path.
 *
 * @param {string} filePath - Path to the PDF file
 * @param {object} [options] - Options passed to extractImagesFromPDF
 * @returns {Promise<Array<{page: number, dataUrl: string, width: number, height: number, size: number}>>}
 */
export async function extractImagesFromPDFFile(filePath, options = {}) {
  const fs = await import('fs');
  const path = await import('path');
  const resolvedPath = path.resolve(filePath);
  console.log(`[PDF-IMAGE-EXTRACTOR] Reading PDF from: ${resolvedPath}`);

  const buffer = fs.readFileSync(resolvedPath);
  return extractImagesFromPDF(buffer, options);
}
