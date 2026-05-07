// lib/pdf-extractor.js - PDF text extraction wrapper.
// Uses pdf-parse to extract text content from PDF files.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

let PDFParseClass = null;
let pdfGlobalsReady = false;
let pdfWorkerReady = false;

const require = createRequire(import.meta.url);

class FallbackDOMMatrix {
  constructor(values = [1, 0, 0, 1, 0, 0]) {
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = Array.isArray(values) ? values : [];
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
  }

  translate(x = 0, y = 0) {
    return new FallbackDOMMatrix([this.a, this.b, this.c, this.d, this.e + x, this.f + y]);
  }

  scale(scaleX = 1, scaleY = scaleX) {
    return new FallbackDOMMatrix([
      this.a * scaleX,
      this.b * scaleX,
      this.c * scaleY,
      this.d * scaleY,
      this.e,
      this.f
    ]);
  }

  multiplySelf(matrix) {
    const m = matrix || new FallbackDOMMatrix();
    const a = this.a * m.a + this.c * m.b;
    const b = this.b * m.a + this.d * m.b;
    const c = this.a * m.c + this.c * m.d;
    const d = this.b * m.c + this.d * m.d;
    const e = this.a * m.e + this.c * m.f + this.e;
    const f = this.b * m.e + this.d * m.f + this.f;
    Object.assign(this, { a, b, c, d, e, f });
    return this;
  }

  preMultiplySelf(matrix) {
    const m = new FallbackDOMMatrix(
      matrix ? [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f] : undefined
    );
    m.multiplySelf(this);
    Object.assign(this, m);
    return this;
  }

  invertSelf() {
    const det = this.a * this.d - this.b * this.c;
    if (!det) return this;
    const a = this.d / det;
    const b = -this.b / det;
    const c = -this.c / det;
    const d = this.a / det;
    const e = (this.c * this.f - this.d * this.e) / det;
    const f = (this.b * this.e - this.a * this.f) / det;
    Object.assign(this, { a, b, c, d, e, f });
    return this;
  }
}

async function ensurePdfJsNodeGlobals() {
  if (pdfGlobalsReady) return;

  try {
    const canvas = await import('@napi-rs/canvas');
    globalThis.DOMMatrix ||= canvas.DOMMatrix;
    globalThis.ImageData ||= canvas.ImageData;
    globalThis.Path2D ||= canvas.Path2D;
  } catch (error) {
    console.warn(`[PDF-EXTRACTOR] Native canvas polyfills unavailable: ${error.message}`);
  }

  // Text extraction only needs DOMMatrix during pdf.js module initialization.
  globalThis.DOMMatrix ||= FallbackDOMMatrix;
  pdfGlobalsReady = true;
}

async function getPdfParse() {
  if (!PDFParseClass) {
    await ensurePdfJsNodeGlobals();
    const mod = await import('pdf-parse');
    PDFParseClass = mod.PDFParse;
  }
  configurePdfWorker(PDFParseClass);
  return PDFParseClass;
}

function configurePdfWorker(PDFParse) {
  if (pdfWorkerReady) return;

  try {
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    PDFParse.setWorker(pathToFileURL(workerPath).href);
    pdfWorkerReady = true;
  } catch (error) {
    console.warn(`[PDF-EXTRACTOR] Could not configure pdf.js worker: ${error.message}`);
  }
}

/**
 * Extract text from a PDF buffer.
 *
 * @param {Buffer} pdfBuffer - The PDF file buffer
 * @param {object} [options] - Optional extraction options
 * @param {number} [options.maxPages] - Maximum pages to extract (0 = all)
 * @returns {Promise<{text: string, pages: number, metadata: object}>}
 */
export async function extractTextFromPDF(pdfBuffer, options = {}) {
  const { maxPages = 0 } = options;

  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error('PDF buffer is required');
  }

  if (pdfBuffer.length === 0) {
    throw new Error('PDF buffer is empty');
  }

  console.log(`[PDF-EXTRACTOR] Extracting text from PDF (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  const PDFParse = await getPdfParse();
  const parser = new PDFParse({ data: pdfBuffer, disableWorker: true });

  let textResult;
  let infoResult;

  try {
    textResult = await parser.getText({
      first: maxPages > 0 ? maxPages : undefined,
      pageJoiner: maxPages > 0 ? '\n-- PAGE_BREAK --\n' : undefined
    });
    infoResult = await parser.getInfo();
  } finally {
    await parser.destroy().catch(() => {});
  }

  let text = textResult.text || '';
  const numPages = textResult.total || 0;
  const metadata = infoResult?.info || {};

  console.log(`[PDF-EXTRACTOR] Extracted ${text.length} chars from ${numPages} pages`);

  if (maxPages > 0 && numPages > maxPages) {
    const pageBreaks = text.split('-- PAGE_BREAK --');
    if (pageBreaks.length > maxPages) {
      text = pageBreaks.slice(0, maxPages).join('\n');
      console.log(`[PDF-EXTRACTOR] Truncated to ${maxPages} pages (${text.length} chars)`);
    }
  }

  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    text,
    pages: numPages,
    metadata
  };
}

/**
 * Extract text from a PDF file path.
 *
 * @param {string} filePath - Path to the PDF file
 * @param {object} [options] - Options passed to extractTextFromPDF
 * @returns {Promise<{text: string, pages: number, metadata: object}>}
 */
export async function extractTextFromPDFFile(filePath, options = {}) {
  const resolvedPath = path.resolve(filePath);
  console.log(`[PDF-EXTRACTOR] Reading PDF from: ${resolvedPath}`);

  const buffer = fs.readFileSync(resolvedPath);
  return extractTextFromPDF(buffer, options);
}
