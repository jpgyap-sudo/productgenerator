// ═══════════════════════════════════════════════════════════════════
//  lib/et-image-extractor.js — Extract embedded images + row data
//  from .et (WPS Spreadsheet) files.
//
//  Workflow:
//    1. Try direct OLE2 extraction first (bypasses LibreOffice for images)
//    2. Convert .et → .xlsx via LibreOffice (soffice --headless)
//    3. Use exceljs to read worksheet data AND extract embedded images
//    4. Parse drawing XML to map images to cell anchors (row/col)
//    5. Match images to products via UUID (from DISPIMG formulas)
//    6. Return row-mapped products with image data URLs
//
//  This is an ADDITIONAL function — does NOT replace the existing
//  text-only extraction in lib/et-extractor.js.
//
//  Dependencies:
//    - LibreOffice (soffice) must be installed on the system
//    - exceljs npm package
//    - cfb (for OLE2 parsing, already a dependency of xlsx)
// ═══════════════════════════════════════════════════════════════════

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import ExcelJS from 'exceljs';
import XLSX from 'xlsx';
import { extractImagesFromETCellImageData } from './et-ole-image-extractor.js';

// ── Constants ──────────────────────────────────────────────────────
const LIBREOFFICE_TIMEOUT = 60000; // 60s max for conversion
const MAX_IMAGE_SIZE_MB = 10;      // Skip images larger than this

// ── Progress animation constants ───────────────────────────────────
// Artificial delays added between progress steps to make the progress
// bar visible and smooth instead of jumping instantly to 80%.
const PROGRESS_STEP_DELAY_MS = 800;  // Delay between progress steps (ms)
const PROGRESS_ANIMATION_STEPS = [   // Sub-steps for smooth animation
  { from: 0, to: 3, label: 'Initializing', delay: 600 },
  { from: 3, to: 7, label: 'Checking LibreOffice', delay: 500 },
  { from: 7, to: 12, label: 'Preparing temp directory', delay: 400 },
  { from: 12, to: 18, label: 'Converting .et to .xlsx', delay: 700 },
  { from: 18, to: 25, label: 'Converting .et to .xlsx', delay: 800 },
  { from: 25, to: 35, label: 'Converting .et to .xlsx', delay: 1000 },
  { from: 35, to: 42, label: 'Converting .et to .xlsx', delay: 600 },
  { from: 42, to: 47, label: 'Extracting embedded images', delay: 500 },
  { from: 47, to: 55, label: 'Extracting embedded images', delay: 700 },
  { from: 55, to: 62, label: 'Extracting embedded images', delay: 600 },
  { from: 62, to: 67, label: 'Extracting product data', delay: 500 },
  { from: 67, to: 75, label: 'Extracting product data', delay: 700 },
  { from: 75, to: 82, label: 'Extracting product data', delay: 600 },
  { from: 82, to: 87, label: 'Building image data URLs', delay: 500 },
  { from: 87, to: 95, label: 'Building image data URLs', delay: 700 },
  { from: 95, to: 100, label: 'Finalizing', delay: 600 },
];

// ── Pause/Resume control ───────────────────────────────────────────
// Global map of batchId -> { paused: boolean } for pause/resume support.
// The UI calls POST /api/agent/et-pause/:batchId to toggle pause.
export const etPauseStore = new Map();

/**
 * Check if LibreOffice is available on the system.
 * @returns {Promise<boolean>}
 */
export async function isLibreOfficeAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('soffice', ['--headless', '--version'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Convert a .et buffer to .xlsx using LibreOffice.
 * Writes temp files, runs soffice, reads result, cleans up.
 *
 * @param {Buffer} etBuffer - Raw .et file buffer
 * @param {string} tempDir - Temporary directory for conversion
 * @returns {Promise<Buffer>} The converted .xlsx buffer
 */
async function convertETtoXLSX(etBuffer, tempDir) {
  const timestamp = Date.now();
  const inputPath = path.join(tempDir, `input_${timestamp}.et`);
  const outputPath = path.join(tempDir, `input_${timestamp}.xlsx`);

  // Write .et to temp file
  await fs.promises.writeFile(inputPath, etBuffer);

  return new Promise((resolve, reject) => {
    const soffice = spawn('soffice', [
      '--headless',
      '--convert-to', 'xlsx',
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
        // Clean up output if it exists
        try { await fs.promises.unlink(outputPath); } catch {}
        return reject(new Error(`LibreOffice conversion failed (exit ${code}): ${stderr.trim() || 'Unknown error'}`));
      }

      try {
        const xlsxBuffer = await fs.promises.readFile(outputPath);
        // Clean up output file
        try { await fs.promises.unlink(outputPath); } catch {}
        resolve(xlsxBuffer);
      } catch (readErr) {
        reject(new Error(`Failed to read converted .xlsx: ${readErr.message}`));
      }
    });

    soffice.on('error', (err) => {
      // Clean up temp files
      try { fs.promises.unlink(inputPath); } catch {}
      try { fs.promises.unlink(outputPath); } catch {}
      reject(new Error(`LibreOffice not found: ${err.message}. Install LibreOffice to extract images from .et files.`));
    });
  });
}

/**
 * Extract images and cell-anchor mapping from a .xlsx buffer using exceljs.
 *
 * @param {Buffer} xlsxBuffer - Converted .xlsx file buffer
 * @returns {Promise<{images: Array, rowImageMap: Map<number, object>, imageNameMap: Map<string, object>}>}
 *   images: Array of { id, index, buffer, extension, mimeType, name }
 *   rowImageMap: Map<rowNumber, imageObject> — images mapped by anchor row
 *   imageNameMap: Map<imageName, imageObject> — images mapped by name for DISPIMG lookup
 */
async function extractImagesFromXLSX(xlsxBuffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsxBuffer);

  // ── Collect all embedded images from workbook media ──────────────
  // exceljs stores media in workbook.media (array of { buffer, extension, type, name })
  const mediaList = [];
  if (workbook.media && workbook.media.length > 0) {
    workbook.media.forEach((medium, index) => {
      if (!medium.buffer) return;
      // Skip oversized images
      if (medium.buffer.length > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
        console.log(`[ET-IMAGE-EXTRACTOR] Skipping oversized image #${index}: ${(medium.buffer.length / 1024 / 1024).toFixed(1)} MB`);
        return;
      }
      const ext = medium.extension || 'png';
      const mimeType = ext === 'jpg' ? 'image/jpeg'
        : ext === 'jpeg' ? 'image/jpeg'
        : ext === 'png' ? 'image/png'
        : ext === 'gif' ? 'image/gif'
        : ext === 'bmp' ? 'image/bmp'
        : `image/${ext}`;
      mediaList.push({
        id: medium.index ?? index,
        index,
        buffer: medium.buffer,
        extension: ext,
        mimeType,
        name: medium.name || `image_${index}.${ext}`
      });
    });
  }

  if (mediaList.length === 0) {
    return { images: [], rowImageMap: new Map(), imageNameMap: new Map() };
  }

  console.log(`[ET-IMAGE-EXTRACTOR] Found ${mediaList.length} embedded images in workbook`);

  // ── Build imageNameMap: map image name → image object ───────────
  // WPS spreadsheets reference images by name via DISPIMG() formulas
  const imageNameMap = new Map();
  for (const media of mediaList) {
    // The name might be like "image1", "image2", etc. or have an extension
    const baseName = media.name.replace(/\.[^.]+$/, ''); // Strip extension
    imageNameMap.set(media.name, media);
    imageNameMap.set(baseName, media);
    // Also store by index as fallback
    imageNameMap.set(String(media.index), media);
    imageNameMap.set(String(media.id), media);
  }

  // ── Parse drawing XML to map images to cell anchors ──────────────
  // exceljs provides worksheet.getImages() which returns image placement info
  // Each image entry has: { imageId, range: { tl: { row, col }, br: { row, col } }, type }
  const rowImageMap = new Map();

  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) {
    console.warn('[ET-IMAGE-EXTRACTOR] No worksheet found in workbook');
    return { images: mediaList, rowImageMap, imageNameMap };
  }

  try {
    const drawingImages = worksheet.getImages();
    console.log(`[ET-IMAGE-EXTRACTOR] Found ${drawingImages.length} image placements in drawings`);

    drawingImages.forEach((imgPlacement) => {
      // imgPlacement.imageId refers to the index in workbook.media
      const mediaIndex = imgPlacement.imageId;
      const media = mediaList.find(m => m.id === mediaIndex || m.index === mediaIndex);
      if (!media) {
        console.warn(`[ET-IMAGE-EXTRACTOR] No media found for imageId ${mediaIndex}`);
        return;
      }

      // Get the top-left cell anchor (row is 0-based in exceljs)
      const tl = imgPlacement.range?.tl;
      if (!tl || tl.row === undefined) {
        console.warn(`[ET-IMAGE-EXTRACTOR] Image #${mediaIndex} has no cell anchor, skipping`);
        return;
      }

      // exceljs uses 0-based row/col; spreadsheet rows are 1-based
      // IMPORTANT: Anchor rows can be floats (e.g., 338.99999), so round them
      const spreadsheetRow = Math.round(tl.row) + 1; // Round first, then convert to 1-based

      // If multiple images map to the same row, keep the first one
      if (!rowImageMap.has(spreadsheetRow)) {
        rowImageMap.set(spreadsheetRow, media);
        console.log(`[ET-IMAGE-EXTRACTOR] Mapped image #${mediaIndex} "${media.name}" to row ${spreadsheetRow} (raw tl.row=${tl.row})`);
      }
    });
  } catch (drawErr) {
    // getImages() may fail on some .xlsx files — non-fatal
    console.warn('[ET-IMAGE-EXTRACTOR] Drawing parsing failed (non-fatal):', drawErr.message);
  }

  return { images: mediaList, rowImageMap, imageNameMap };
}

/**
 * Extract plain text from a cell value that may be a rich text object.
 * SheetJS sometimes returns { richText: [{ font: ..., text: "..." }, ...] }
 * instead of a plain string.
 *
 * @param {any} cellValue - Raw cell value from SheetJS
 * @returns {string} Plain text
 */
function extractCellText(cellValue) {
  if (cellValue === null || cellValue === undefined) return '';
  if (typeof cellValue === 'string') return cellValue.trim();
  if (typeof cellValue === 'number') return String(cellValue);
  if (typeof cellValue === 'boolean') return String(cellValue);

  // Handle rich text objects: { richText: [{ text: "HA-790\n" }, { text: "锌合金脚" }] }
  if (typeof cellValue === 'object' && cellValue !== null) {
    if (Array.isArray(cellValue.richText)) {
      return cellValue.richText
        .map(rt => (rt.text || ''))
        .join('')
        .trim();
    }
    // Handle other object types
    if (cellValue.text !== undefined) return String(cellValue.text).trim();
    if (cellValue.h !== undefined) return String(cellValue.h).trim();
  }

  return String(cellValue).trim();
}

/**
 * Extract product data from worksheet rows and map images to them.
 * Uses a two-pass approach:
 *   Pass 1: Scan all cells for DISPIMG() formula references to build image-to-row mapping
 *   Pass 2: Parse data rows and map images
 *
 * @param {Buffer} xlsxBuffer - Converted .xlsx file buffer
 * @param {Map<number, object>} rowImageMap - Map of rowNumber -> image object (from drawing anchors)
 * @param {Map<string, object>} imageNameMap - Map of imageName -> image object (for DISPIMG lookup)
 * @param {Map<string, object>|null} uuidMap - Map of UUID -> image object (from OLE2 ETCellImageData extraction)
 * @param {Array<object>|null} sortedImagesByPosition - OLE2 images sorted by y-coordinate from cellImages.xml
 *        These are mapped to rows one-to-one by position order, which is more reliable
 *        than UUID matching because DISPIMG formulas may use different naming schemes.
 * @returns {Array<object>} Array of { row, productCode, name, description, brand, generatedCode, imageBuffer, imageName, dataUrl }
 */
/**
 * Extract products by positional zipping — pair images and text rows 1:1 by index.
 *
 * This replaces the complex DISPIMG/calibration approach with a simple assumption:
 * the .et file has images sorted top-to-bottom by yPos (from cellImages.xml),
 * and data rows sorted top-to-bottom in the spreadsheet. They correspond 1:1.
 *
 * @param {Buffer} xlsxBuffer - LibreOffice-converted xlsx buffer
 * @param {Array} sortedImagesByPosition - OLE2 images sorted by yPos ascending
 * @returns {Array} products - paired products with images
 */
function extractProductsPositionally(xlsxBuffer, sortedImagesByPosition) {
  if (!xlsxBuffer || !sortedImagesByPosition || sortedImagesByPosition.length === 0) {
    console.log('[ET-IMAGE-EXTRACTOR] Positional extraction: no data available');
    return [];
  }

  const workbook = XLSX.read(xlsxBuffer, {
    type: 'buffer',
    cellDates: false,
    cellNF: false,
    cellText: true,
    cellFormula: true
  });

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) return [];
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) return [];

  // Convert to 2D array
  const data = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: false
  });

  if (!data || data.length < 2) return [];

  // Find column indices by header names
  const headers = data[0].map(h => extractCellText(h).toLowerCase());
  const findCol = (keywords) => {
    for (let i = 0; i < headers.length; i++) {
      for (const kw of keywords) {
        if (headers[i].includes(kw)) return i;
      }
    }
    return -1;
  };

  let codeCol = findCol(['code', 'product code', 'item code', 'sku', 'no', 'part number']);
  let descCol = findCol(['description', 'desc', 'product description', 'item description', 'name', 'product name']);
  let brandCol = findCol(['brand', 'brand name', 'manufacturer', 'vendor']);

  // Fallback heuristics
  if (codeCol === -1 && headers.length > 0 && headers[0] === '') codeCol = 0;
  if (descCol === -1 && headers.length > 2 && headers[2] === '') descCol = 2;
  if (codeCol === -1 && headers.length > 0) {
    for (let i = 1; i < Math.min(6, data.length); i++) {
      if (data[i] && data[i][0] !== '' && data[i][0] !== null && data[i][0] !== undefined) {
        codeCol = 0; break;
      }
    }
  }
  if (descCol === -1 && headers.length > 2) {
    for (let i = 1; i < Math.min(6, data.length); i++) {
      if (data[i] && data[i][2] !== '' && data[i][2] !== null && data[i][2] !== undefined) {
        descCol = 2; break;
      }
    }
  }

  console.log(`[ET-IMAGE-EXTRACTOR] Positional column mapping: code=${codeCol}, desc=${descCol}, brand=${brandCol}`);

  // Find first data row (skip header, skip empty rows)
  let startRow = 1;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row && row.some(cell => cell !== '' && cell !== null && cell !== undefined)) {
      startRow = i; break;
    }
  }

  // Collect non-empty data rows
  const dataRows = [];
  const seenCodes = new Set();
  for (let r = startRow; r < data.length; r++) {
    const row = data[r];
    if (!row) continue;
    if (row.every(cell => cell === '' || cell === null || cell === undefined)) continue;

    const getCell = (colIdx) => {
      if (colIdx < 0 || colIdx >= row.length) return '';
      const val = row[colIdx];
      if (val === null || val === undefined) return '';
      const str = extractCellText(val);
      if (str.startsWith('=') && str.includes('DISPIMG')) return '';
      return str;
    };

    const productCode = getCell(codeCol);
    const description = getCell(descCol);
    const brand = getCell(brandCol);

    if (!productCode && !description) continue;
    if (productCode && seenCodes.has(productCode)) continue;
    if (productCode) seenCodes.add(productCode);

    dataRows.push({ productCode, description, brand, spreadsheetRow: r + 1 });
  }

  // ── Positional zipping: 1st image ↔ 1st data row ────────────────
  const count = Math.min(sortedImagesByPosition.length, dataRows.length);
  console.log(`[ET-IMAGE-EXTRACTOR] Positional zipping: ${count} pairs (${sortedImagesByPosition.length} images, ${dataRows.length} data rows)`);

  if (count === 0) {
    console.log('[ET-IMAGE-EXTRACTOR] Positional zipping: no pairs to create');
    return [];
  }

  const products = [];
  for (let i = 0; i < count; i++) {
    const img = sortedImagesByPosition[i];
    const row = dataRows[i];

    const dataUrl = img.dataUrl || '';
    const name = row.description
      ? (row.description.length > 60 ? row.description.substring(0, 60) + '...' : row.description)
      : (row.productCode ? `Product ${row.productCode}` : `Row ${row.spreadsheetRow}`);

    products.push({
      row: row.spreadsheetRow,
      productCode: row.productCode || '',
      name,
      description: row.description || '',
      brand: row.brand || '',
      generatedCode: row.productCode
        ? (row.productCode.startsWith('HA') ? row.productCode : `HA${row.productCode}R`)
        : '',
      imageBuffer: null,
      imageName: img.name || '',
      dataUrl,
      hasPreMappedImage: true,
      matchedViaUUID: false
    });
  }

  console.log(`[ET-IMAGE-EXTRACTOR] Positional extraction: ${products.length} products with images`);
  return products;
}

function extractProductsFromRows(xlsxBuffer, rowImageMap, imageNameMap, uuidMap, sortedImagesByPosition) {
  // Use SheetJS (xlsx) for reliable row data parsing
  // We re-parse the xlsx buffer rather than using exceljs for data,
  // because SheetJS handles cell formatting and text extraction better
  const workbook = XLSX.read(xlsxBuffer, {
    type: 'buffer',
    cellDates: false,
    cellNF: false,
    cellText: true,
    cellFormula: true  // Keep formulas so we can detect DISPIMG()
  });

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return [];
  }

  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) return [];

  // ── Pass 1: Scan all cells for DISPIMG() formula references ─────
  // WPS spreadsheets use =DISPIMG("image_name", ...) to reference images
  // The image_name is a UUID like "ID_A4788EC807314E32B18BBBB82BEC6098"
  // which can be matched directly against the OLE2-extracted uuidMap.
  const dispimgMap = new Map(); // Map<rowNumber, imageName/UUID>
  const uuidMatchCount = { total: 0, matched: 0 }; // Track UUID matching stats
  const cellAddresses = Object.keys(worksheet);
  for (const addr of cellAddresses) {
    if (addr.startsWith('!')) continue; // Skip sheet-level keys
    const cell = worksheet[addr];
    if (!cell) continue;

    // Check for DISPIMG formula
    let formulaStr = '';
    if (cell.f && typeof cell.f === 'string') {
      formulaStr = cell.f;
    }
    // Also check the raw value (SheetJS may store formula result differently)
    if (cell.l && typeof cell.l === 'object' && cell.l.Target) {
      // Hyperlink - not what we want
    }

    if (formulaStr.toUpperCase().includes('DISPIMG')) {
      // Extract the image name from DISPIMG("name", ...)
      // Pattern: =DISPIMG("image_name", ...) or =DISPIMG('image_name', ...)
      // P5: Try multiple regex patterns for different WPS DISPIMG formats
      let imageName = null;
      
      // Pattern 1: Standard quoted argument — DISPIMG("UUID", ...) or DISPIMG('UUID', ...)
      const match1 = formulaStr.match(/DISPIMG\s*\(\s*["']([^"']+)["']/i);
      if (match1 && match1[1]) {
        imageName = match1[1].trim();
      }
      
      // Pattern 2: Unquoted first argument — DISPIMG(UUID, ...) (some WPS versions omit quotes)
      if (!imageName) {
        const match2 = formulaStr.match(/DISPIMG\s*\(\s*([^,)\s]+)/i);
        if (match2 && match2[1]) {
          imageName = match2[1].trim();
        }
      }
      
      // Pattern 3: DISPIMG with leading/trailing whitespace inside parens
      if (!imageName) {
        const match3 = formulaStr.match(/DISPIMG\s*\(\s*["']?\s*([A-Za-z0-9_-]+)\s*["']?\s*[,\)]/i);
        if (match3 && match3[1]) {
          imageName = match3[1].trim();
        }
      }
      
      // Pattern 4: DISPIMG with numeric ID (some WPS versions use numeric image IDs)
      if (!imageName) {
        const match4 = formulaStr.match(/DISPIMG\s*\(\s*(\d+)/i);
        if (match4 && match4[1]) {
          imageName = match4[1].trim();
        }
      }
      
      if (imageName) {
        // Parse the cell address to get row number
        const colRow = addr.match(/[A-Z]+(\d+)/);
        if (colRow && colRow[1]) {
          const rowNum = parseInt(colRow[1], 10);
          dispimgMap.set(rowNum, imageName);

          // Check if this UUID can be matched via OLE2 uuidMap
          if (uuidMap && uuidMap.size > 0 && uuidMap.has(imageName)) {
            uuidMatchCount.matched++;
            console.log(`[ET-IMAGE-EXTRACTOR] DISPIMG UUID match: cell ${addr} (row ${rowNum}) → UUID "${imageName}" → image "${uuidMap.get(imageName).name}"`);
          } else {
            console.log(`[ET-IMAGE-EXTRACTOR] DISPIMG reference: cell ${addr} (row ${rowNum}) → "${imageName}"`);
          }
          uuidMatchCount.total++;
        }
      }
    }
  }

  if (dispimgMap.size > 0) {
    console.log(`[ET-IMAGE-EXTRACTOR] Found ${dispimgMap.size} DISPIMG formula references (${uuidMatchCount.matched}/${uuidMatchCount.total} UUID-matched via OLE2)`);
  }

  // ── Convert to 2D array (header: 1 = raw data, no header mapping) ─
  const data = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: false
  });

  if (!data || data.length < 2) return []; // Need at least header + 1 data row

  // ── Find column indices by header names ──────────────────────────
  const headers = data[0].map(h => extractCellText(h).toLowerCase());

  // Try to find relevant columns (flexible matching)
  const findCol = (keywords) => {
    for (let i = 0; i < headers.length; i++) {
      for (const kw of keywords) {
        if (headers[i].includes(kw)) return i;
      }
    }
    return -1;
  };

  let codeCol = findCol(['code', 'product code', 'item code', 'sku', 'no', 'part number']);
  let descCol = findCol(['description', 'desc', 'product description', 'item description', 'name', 'product name']);
  let brandCol = findCol(['brand', 'brand name', 'manufacturer', 'vendor']);
  let imageCol = findCol(['image', 'img', 'picture', 'photo', 'pic']);

  // ── Fallback: if keyword search fails, use positional heuristics ─
  // Many .et files have empty headers for columns 0 and 2 (code and description)
  if (codeCol === -1 && headers.length > 0 && headers[0] === '') {
    codeCol = 0;
    console.log('[ET-IMAGE-EXTRACTOR] Column fallback: using col 0 for product code (empty header)');
  }
  if (descCol === -1 && headers.length > 2 && headers[2] === '') {
    descCol = 2;
    console.log('[ET-IMAGE-EXTRACTOR] Column fallback: using col 2 for description (empty header)');
  }
  // If still not found, try broader fallback
  if (codeCol === -1 && headers.length > 0) {
    // Check if first column has any data that looks like product codes
    const sampleValues = [];
    for (let i = 1; i < Math.min(6, data.length); i++) {
      const row = data[i];
      if (row && row[0] !== '' && row[0] !== null && row[0] !== undefined) {
        sampleValues.push(extractCellText(row[0]));
      }
    }
    if (sampleValues.length > 0) {
      codeCol = 0;
      console.log('[ET-IMAGE-EXTRACTOR] Column fallback: using col 0 for product code (heuristic)');
    }
  }
  if (descCol === -1 && headers.length > 2) {
    const sampleValues = [];
    for (let i = 1; i < Math.min(6, data.length); i++) {
      const row = data[i];
      if (row && row[2] !== '' && row[2] !== null && row[2] !== undefined) {
        sampleValues.push(extractCellText(row[2]));
      }
    }
    if (sampleValues.length > 0) {
      descCol = 2;
      console.log('[ET-IMAGE-EXTRACTOR] Column fallback: using col 2 for description (heuristic)');
    }
  }

  console.log(`[ET-IMAGE-EXTRACTOR] Column mapping: code=${codeCol}, desc=${descCol}, brand=${brandCol}, image=${imageCol}`);

  // ── Build position-based rowImageMap from OLE2 data ──────────────
  // If we have sortedImagesByPosition from the OLE2 extractor, use it
  // to build a rowImageMap. The images are sorted by y-coordinate from
  // cellImages.xml <a:off y="..."/>, which tells us the vertical position
  // of each image in the spreadsheet. We map them one-to-one to data rows.
  //
  // First, find the actual data start (skip empty rows after header)
  let startRow = 1;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row && row.some(cell => cell !== '' && cell !== null && cell !== undefined)) {
      startRow = i;
      break;
    }
  }

  // ── P2: Build rowImageMap from OLE2 position-sorted images ─────────
  // Instead of sequential assignment (imgIdx++), we now estimate the
  // spreadsheet row from each image's y-coordinate using DISPIMG calibration.
  //
  // Strategy:
  // 1. If DISPIMG formulas exist, use them as calibration points — the
  //    DISPIMG formula at row N tells us which image UUID belongs to row N.
  //    We can then derive the y-coordinate → row mapping from these known pairs.
  // 2. For images without DISPIMG references, interpolate row position
  //    based on y-coordinate ordering relative to calibrated rows.
  // 3. If no DISPIMG formulas exist, fall back to sequential assignment
  //    (original behavior) but with empty-row awareness.
  if (sortedImagesByPosition && sortedImagesByPosition.length > 0) {
    console.log(`[ET-IMAGE-EXTRACTOR] Building rowImageMap from ${sortedImagesByPosition.length} OLE2 position-sorted images (data starts at row ${startRow + 1})`);

    // ── Step 1: Build calibration map from DISPIMG formulas ──────────
    // For each DISPIMG formula, find the image with matching UUID and record
    // the (yPos → spreadsheetRow) calibration pair.
    const calibrationPairs = []; // Array of { yPos, row }
    if (dispimgMap.size > 0 && uuidMap && uuidMap.size > 0) {
      for (const [spreadsheetRow, uuid] of dispimgMap) {
        // Find the image in sortedImagesByPosition that has this UUID
        const matchingImg = sortedImagesByPosition.find(img => img.uuid === uuid);
        if (matchingImg && typeof matchingImg.yPos === 'number') {
          calibrationPairs.push({ yPos: matchingImg.yPos, row: spreadsheetRow });
          console.log(`[ET-IMAGE-EXTRACTOR] Calibration: DISPIMG row ${spreadsheetRow} ↔ y=${matchingImg.yPos} (uuid=${uuid})`);
        }
      }
    }

    // ── Step 2: Derive row for each image using calibration ──────────
    // Sort calibration pairs by yPos ascending
    calibrationPairs.sort((a, b) => a.yPos - b.yPos);

    if (calibrationPairs.length >= 2) {
      // We have enough calibration points to estimate row from y-coordinate
      // Use linear interpolation between calibration points
      console.log(`[ET-IMAGE-EXTRACTOR] Using ${calibrationPairs.length} calibration points for y-coordinate → row mapping`);

      for (const img of sortedImagesByPosition) {
        if (typeof img.yPos !== 'number') {
          console.log(`[ET-IMAGE-EXTRACTOR] Image "${img.name}" has no yPos, skipping position-based mapping`);
          continue;
        }

        // If this image's UUID matches a DISPIMG formula directly, use that row
        if (img.uuid && dispimgMap.size > 0) {
          let directMatch = false;
          for (const [spreadsheetRow, uuid] of dispimgMap) {
            if (uuid === img.uuid) {
              rowImageMap.set(spreadsheetRow, img);
              console.log(`[ET-IMAGE-EXTRACTOR] Calibrated map: row ${spreadsheetRow} → "${img.name}" (y=${img.yPos}, uuid match via DISPIMG)`);
              directMatch = true;
              break;
            }
          }
          if (directMatch) continue;
        }

        // Estimate row from y-coordinate using nearest calibration points.
        // To avoid multiple images collapsing to the same row when extrapolating
        // beyond calibration bounds, we use sequential offset from the nearest
        // calibration point, tracking which rows are already taken.
        let estimatedRow = null;
        if (img.yPos <= calibrationPairs[0].yPos) {
          // Before first calibration point — use sequential offset backward
          // Count how many images are before the first calibration point
          const imagesBeforeCalibration = sortedImagesByPosition.filter(
            i => i.yPos < calibrationPairs[0].yPos && i !== img
          ).length;
          estimatedRow = calibrationPairs[0].row - (imagesBeforeCalibration + 1);
          if (estimatedRow < 1) estimatedRow = 1;
        } else if (img.yPos >= calibrationPairs[calibrationPairs.length - 1].yPos) {
          // After last calibration point — use sequential offset forward
          // Count how many images (including this one) are after the last calibration point
          const imagesAfterCalibration = sortedImagesByPosition.filter(
            i => i.yPos > calibrationPairs[calibrationPairs.length - 1].yPos && i !== img
          ).length;
          estimatedRow = calibrationPairs[calibrationPairs.length - 1].row + (imagesAfterCalibration + 1);
        } else {
          // Between calibration points — linear interpolation
          for (let ci = 0; ci < calibrationPairs.length - 1; ci++) {
            const low = calibrationPairs[ci];
            const high = calibrationPairs[ci + 1];
            if (img.yPos >= low.yPos && img.yPos <= high.yPos) {
              const ratio = (img.yPos - low.yPos) / (high.yPos - low.yPos);
              estimatedRow = low.row + Math.round(ratio * (high.row - low.row));
              break;
            }
          }
        }

        if (estimatedRow !== null) {
          // Avoid overwriting an existing mapping — if the estimated row is
          // already taken, find the nearest available row
          let finalRow = estimatedRow;
          if (rowImageMap.has(finalRow)) {
            // Try rows above and below
            for (let offset = 1; offset <= 10; offset++) {
              if (!rowImageMap.has(finalRow + offset)) {
                finalRow = finalRow + offset;
                break;
              }
              if (!rowImageMap.has(finalRow - offset) && (finalRow - offset) >= 1) {
                finalRow = finalRow - offset;
                break;
              }
            }
          }
          rowImageMap.set(finalRow, img);
          const method = finalRow === estimatedRow ? 'estimated' : 'adjusted';
          console.log(`[ET-IMAGE-EXTRACTOR] Calibrated map: row ${finalRow} → "${img.name}" (y=${img.yPos}, ${method} from calibration, original=${estimatedRow})`);
        } else {
          console.log(`[ET-IMAGE-EXTRACTOR] Could not estimate row for "${img.name}" (y=${img.yPos})`);
        }
      }
    } else if (calibrationPairs.length === 1) {
      // Only one calibration point — use it as anchor, assign remaining images
      // sequentially before/after based on y-coordinate ordering
      const anchorY = calibrationPairs[0].yPos;
      const anchorRow = calibrationPairs[0].row;
      console.log(`[ET-IMAGE-EXTRACTOR] Single calibration point at y=${anchorY} → row ${anchorRow}, using sequential assignment around anchor`);

      // Sort images by yPos
      const sortedByY = [...sortedImagesByPosition].sort((a, b) => (a.yPos || 0) - (b.yPos || 0));
      const anchorIdx = sortedByY.findIndex(img => img.uuid === calibrationPairs[0].uuid || img.yPos === anchorY);

      // Assign rows: images before anchor get anchorRow - N, images after get anchorRow + N
      for (let si = 0; si < sortedByY.length; si++) {
        const img = sortedByY[si];
        const rowOffset = si - anchorIdx;
        const estimatedRow = anchorRow + rowOffset;
        if (estimatedRow >= 1) {
          rowImageMap.set(estimatedRow, img);
          console.log(`[ET-IMAGE-EXTRACTOR] Single-anchor map: row ${estimatedRow} → "${img.name}" (y=${img.yPos}, offset=${rowOffset})`);
        }
      }
    } else {
      // No calibration points — fall back to sequential assignment (original behavior)
      // but with improved empty-row awareness
      console.log(`[ET-IMAGE-EXTRACTOR] No DISPIMG calibration points available, using sequential assignment`);
      let imgIdx = 0;
      for (let r = startRow; r < data.length && imgIdx < sortedImagesByPosition.length; r++) {
        const row = data[r];
        if (!row) continue;
        // Skip completely empty rows
        if (row.every(cell => cell === '' || cell === null || cell === undefined)) continue;
        const spreadsheetRow = r + 1;
        const img = sortedImagesByPosition[imgIdx];
        rowImageMap.set(spreadsheetRow, img);
        console.log(`[ET-IMAGE-EXTRACTOR] Sequential map: row ${spreadsheetRow} → "${img.name}" (y=${img.yPos}, uuid=${img.uuid})`);
        imgIdx++;
      }
      console.log(`[ET-IMAGE-EXTRACTOR] Built rowImageMap with ${rowImageMap.size} entries from sequential assignment (${imgIdx}/${sortedImagesByPosition.length} images mapped)`);
    }
  } else {
    console.log(`[ET-IMAGE-EXTRACTOR] No OLE2 position data available, using existing rowImageMap (${rowImageMap.size} entries)`);
  }

  // ── Process data rows ────────────────────────────────────────────
  const products = [];
  const seenCodes = new Set(); // For deduplication of merged cells

  for (let r = startRow; r < data.length; r++) {
    const row = data[r];
    if (!row) continue;

    // Skip completely empty rows
    if (row.every(cell => cell === '' || cell === null || cell === undefined)) continue;

    // Extract cell values using rich-text-aware extraction
    const getCell = (colIdx) => {
      if (colIdx < 0 || colIdx >= row.length) return '';
      const val = row[colIdx];
      if (val === null || val === undefined) return '';
      const str = extractCellText(val);
      // Skip formula artifacts
      if (str.startsWith('=') && str.includes('DISPIMG')) return '';
      return str;
    };

    const productCode = getCell(codeCol);
    const description = getCell(descCol);
    const brand = getCell(brandCol);

    // Skip rows with no meaningful product data
    if (!productCode && !description) continue;

    // Deduplicate: skip if we've seen this product code before (merged cells)
    if (productCode && seenCodes.has(productCode)) continue;
    if (productCode) seenCodes.add(productCode);

    // The spreadsheet row number (1-based, accounting for header row 0)
    const spreadsheetRow = r + 1;

    // ── Image mapping strategy (tiered) ────────────────────────────
    // Tier 0: UUID matching (from OLE2 ETCellImageData DISPIMG formula)
    // Tier 1: Position-based row mapping (from cellImages.xml <a:off y="..."/>)
    //         The OLE2 extractor sorts images by y-coordinate and assigns
    //         them to sequential rows. This is the most reliable method
    //         because it uses the actual position data from the .et file.
    // Tier 2: (removed) Old positional mapping by sorted index was unreliable
    // NOTE: No cycling fallback. If a product has no unique image,
    // it gets hasPreMappedImage: false so it's flagged for review rather
    // than silently assigned a wrong image via cycling.
    let rowImage = null;
    let matchedViaUUID = false;

    // Tier 0: UUID matching
    // The DISPIMG formula contains a UUID like "ID_A4788EC807314E32B18BBBB82BEC6098".
    // The OLE2 extractor's cellImages.xml maps these same UUIDs to images.
    // This is the most accurate matching method — it directly links the
    // DISPIMG formula to the embedded image by UUID.
    if (uuidMap && uuidMap.size > 0 && dispimgMap.has(spreadsheetRow)) {
      const uuid = dispimgMap.get(spreadsheetRow);
      if (uuidMap.has(uuid)) {
        rowImage = uuidMap.get(uuid);
        matchedViaUUID = true;
        console.log(`[ET-IMAGE-EXTRACTOR] Row ${spreadsheetRow}: matched via UUID "${uuid}" → "${rowImage.name}"`);
      }
    }

    // Tier 1: Position-based row mapping from cellImages.xml <a:off y="..."/>
    // The OLE2 extractor sorts images by y-coordinate and assigns them to
    // sequential rows. This is the most reliable method because it uses the
    // actual position data from the .et file's ETCellImageData stream.
    // Each image's y-position tells us exactly which row it belongs to.
    if (!rowImage) {
      rowImage = rowImageMap.get(spreadsheetRow);
      if (rowImage) {
        console.log(`[ET-IMAGE-EXTRACTOR] Row ${spreadsheetRow}: matched via OLE2 position-based row mapping → "${rowImage.name}" (y=${rowImage.yPos})`);
      }
    }

    // Generate dataUrl if image exists
    // OLE2 images have dataUrl directly; xlsx images have buffer
    let dataUrl = '';
    if (rowImage) {
      if (rowImage.dataUrl) {
        dataUrl = rowImage.dataUrl;
      } else if (rowImage.buffer) {
        dataUrl = `data:${rowImage.mimeType};base64,${rowImage.buffer.toString('base64')}`;
      }
    }

    // Generate product name from description or code
    const name = description
      ? (description.length > 60 ? description.substring(0, 60) + '...' : description)
      : (productCode ? `Product ${productCode}` : `Row ${spreadsheetRow}`);

    products.push({
      row: spreadsheetRow,
      productCode: productCode || '',
      name,
      description: description || '',
      brand: brand || '',
      // generatedCode: Use product code as-is if it already starts with "HA",
      // otherwise wrap with HA...R for Drive folder naming convention.
      // This prevents double-wrapping like "HA" + "HA" + "R" = "HAHAR".
      generatedCode: productCode
        ? (productCode.startsWith('HA') ? productCode : `HA${productCode}R`)
        : '',
      // Image data (only present if image was found for this row)
      imageBuffer: rowImage?.buffer || null,
      imageName: rowImage?.name || '',
      dataUrl: dataUrl || '',
      // Flag to indicate this product has a pre-mapped image
      hasPreMappedImage: !!rowImage,
      // Flag to indicate this product was matched via UUID (OLE2)
      matchedViaUUID
    });
  }

  console.log(`[ET-IMAGE-EXTRACTOR] Extracted ${products.length} products with data`);
  const withImages = products.filter(p => p.hasPreMappedImage).length;
  console.log(`[ET-IMAGE-EXTRACTOR] ${withImages}/${products.length} products have pre-mapped images`);

  // ── P3: Alignment diagnostic report ───────────────────────────────
  // Log a detailed alignment report showing the mapping between
  // spreadsheet rows, DISPIMG references, OLE2 position data, and
  // actual image assignments. This helps diagnose row alignment issues.
  if (products.length > 0) {
    console.log(`[ET-IMAGE-EXTRACTOR] ═══════════ ALIGNMENT REPORT ═══════════`);
    console.log(`[ET-IMAGE-EXTRACTOR] Total products: ${products.length}, Total images (OLE2): ${sortedImagesByPosition ? sortedImagesByPosition.length : 'N/A'}`);
    console.log(`[ET-IMAGE-EXTRACTOR] DISPIMG formulas found: ${dispimgMap.size}`);
    console.log(`[ET-IMAGE-EXTRACTOR] UUID-matched: ${products.filter(p => p.matchedViaUUID).length}`);
    console.log(`[ET-IMAGE-EXTRACTOR] Position-mapped: ${products.filter(p => p.hasPreMappedImage && !p.matchedViaUUID).length}`);
    console.log(`[ET-IMAGE-EXTRACTOR] Unmapped products: ${products.filter(p => !p.hasPreMappedImage).length}`);

    // Show first 5 and last 5 product-image alignments
    const showProducts = (list, label) => {
      if (list.length === 0) return;
      console.log(`[ET-IMAGE-EXTRACTOR] --- ${label} ---`);
      const subset = list.length <= 10 ? list : [...list.slice(0, 5), ...list.slice(-5)];
      for (const p of subset) {
        const imgInfo = p.hasPreMappedImage
          ? `image="${p.imageName}"${p.matchedViaUUID ? ' [UUID]' : ' [POS]'}`
          : 'NO IMAGE';
        console.log(`[ET-IMAGE-EXTRACTOR]   Row ${p.row}: code="${p.productCode}" ${imgInfo}`);
      }
      if (list.length > 10) {
        console.log(`[ET-IMAGE-EXTRACTOR]   ... (${list.length - 10} rows omitted)`);
      }
    };
    showProducts(products, 'Product-Image Alignment');
    console.log(`[ET-IMAGE-EXTRACTOR] ═══════════ END ALIGNMENT REPORT ═══════════`);
  }

  return products;
}

/**
 * Report progress via the onProgress callback.
 * @param {function|null} onProgress
 * @param {number} percent - 0-100
 * @param {string} stage - Current stage name
 * @param {string} [detail] - Optional detail message
 */
function reportProgress(onProgress, percent, stage, detail) {
  if (typeof onProgress === 'function') {
    try {
      onProgress({ percent, stage, detail: detail || '' });
    } catch {}
  }
  console.log(`[ET-IMAGE-EXTRACTOR] Progress: ${percent}% — ${stage}${detail ? ': ' + detail : ''}`);
}

/**
 * Animate progress smoothly through predefined sub-steps with delays.
 * This makes the progress bar appear to move smoothly instead of jumping.
 * Checks for pause flag between steps.
 *
 * @param {function|null} onProgress
 * @param {string} batchId - The batch ID for pause checking
 * @param {number} startPercent - Starting percent
 * @param {number} endPercent - Ending percent
 * @param {string} stage - Stage label
 * @param {number} totalDelayMs - Total time to spend animating (ms)
 */
async function animateProgress(onProgress, batchId, startPercent, endPercent, stage, totalDelayMs) {
  const steps = 8; // Number of sub-steps
  const stepSize = (endPercent - startPercent) / steps;
  const stepDelay = totalDelayMs / steps;

  for (let s = 1; s <= steps; s++) {
    // Check pause flag before each sub-step
    if (batchId && etPauseStore.has(batchId) && etPauseStore.get(batchId).paused) {
      // Wait until unpaused
      while (etPauseStore.has(batchId) && etPauseStore.get(batchId).paused) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const pct = Math.round(startPercent + stepSize * s);
    reportProgress(onProgress, Math.min(pct, endPercent), stage, '');
    await new Promise(r => setTimeout(r, stepDelay));
  }
}

/**
 * Save resume state to a temp file so extraction can be resumed if interrupted.
 * @param {string} tempDir
 * @param {object} state - Resume state object
 */
async function saveResumeState(tempDir, state) {
  const statePath = path.join(tempDir, 'resume-state.json');
  try {
    await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2));
  } catch {}
}

/**
 * Load resume state from temp file.
 * @param {string} tempDir
 * @returns {object|null}
 */
async function loadResumeState(tempDir) {
  const statePath = path.join(tempDir, 'resume-state.json');
  try {
    const data = await fs.promises.readFile(statePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Clear resume state file.
 * @param {string} tempDir
 */
async function clearResumeState(tempDir) {
  const statePath = path.join(tempDir, 'resume-state.json');
  try {
    await fs.promises.unlink(statePath);
  } catch {}
}

/**
 * Main entry point: Extract embedded images and row data from a .et file.
 *
 * Workflow:
 *   1. Check LibreOffice availability
 *   2. Convert .et → .xlsx via soffice (with retry)
 *   3. Extract images + cell anchors via exceljs
 *   4. Extract product data from rows via SheetJS
 *   5. Merge images with row data
 *   6. Return format compatible with existing pipeline
 *
 * Supports progress reporting via onProgress callback and resume fallback
 * via resume state saved to temp directory.
 *
 * @param {Buffer} etBuffer - Raw .et file buffer
 * @param {object} [options]
 * @param {string} [options.tempDir] - Custom temp directory (default: os.tmpdir())
 * @param {function} [options.onProgress] - Progress callback ({ percent, stage, detail })
 * @param {boolean} [options.useResume] - Whether to try resuming from saved state (default: true)
 * @returns {Promise<{products: Array, allImages: Array, totalImages: number, hasEmbeddedImages: boolean}>}
 */
export async function extractETImagesAndData(etBuffer, options = {}) {
  const onProgress = options.onProgress || null;
  const useResume = options.useResume !== false; // Default: true
  const batchId = options.batchId || null; // For pause/resume support
  const fileSizeMB = (etBuffer.length / 1024 / 1024).toFixed(2);

  console.log(`[ET-IMAGE-EXTRACTOR] Starting extraction (${fileSizeMB} MB)`);
  reportProgress(onProgress, 0, 'Initializing', `File size: ${fileSizeMB} MB`);

  // ── Step 1: Try direct OLE2 extraction first ─────────────────────
  // WPS .et files store embedded cell images in a proprietary OLE2
  // stream called "ETCellImageData". LibreOffice's .et → .xlsx conversion
  // does NOT know about this stream, so it only extracts linked images
  // (typically 0-4 instead of the full set of 53+ images).
  //
  // By trying OLE2 extraction FIRST, we bypass LibreOffice for images
  // and get all embedded images with their DISPIMG UUID mappings.
  reportProgress(onProgress, 5, 'Trying direct OLE2 extraction', 'Parsing ETCellImageData stream...');
  const oleResult = extractImagesFromETCellImageData(etBuffer);
  let oleImages = null;
  let oleUuidMap = null;

  if (oleResult.success && oleResult.imageCount > 0) {
    console.log(`[ET-IMAGE-EXTRACTOR] OLE2 direct extraction: ${oleResult.imageCount} images with ${oleResult.uuidMap.size} UUID mappings`);
    oleImages = oleResult.images;
    oleUuidMap = oleResult.uuidMap;
    reportProgress(onProgress, 15, 'OLE2 extraction', `${oleResult.imageCount} images found with UUID mappings`);
  } else {
    console.log(`[ET-IMAGE-EXTRACTOR] OLE2 extraction not available or empty: ${oleResult.error || 'no images'}`);
    reportProgress(onProgress, 10, 'OLE2 extraction skipped', oleResult.error || 'no images found');
  }

  // ── Step 2: Check LibreOffice ────────────────────────────────────
  reportProgress(onProgress, 15, 'Checking LibreOffice');
  const libreAvailable = await isLibreOfficeAvailable();
  if (!libreAvailable) {
    console.warn('[ET-IMAGE-EXTRACTOR] LibreOffice not available — cannot extract product data');
    reportProgress(onProgress, 100, 'Failed', 'LibreOffice not installed');
    return {
      products: [],
      allImages: [],
      totalImages: 0,
      hasEmbeddedImages: false,
      warning: 'LibreOffice is not installed. Install LibreOffice to extract product data from .et files.'
    };
  }

  // ── Step 3: Create temp directory ────────────────────────────────
  reportProgress(onProgress, 20, 'Preparing temp directory');
  const tempDir = options.tempDir || path.join(os.tmpdir(), 'et-extract');
  try {
    await fs.promises.mkdir(tempDir, { recursive: true });
  } catch {}

  // Check for resume state
  let resumeState = null;
  if (useResume) {
    resumeState = await loadResumeState(tempDir);
    if (resumeState) {
      console.log(`[ET-IMAGE-EXTRACTOR] Found resume state from previous run (step: ${resumeState.step || 'unknown'})`);
      reportProgress(onProgress, 20, 'Resuming', `Previous step: ${resumeState.step || 'unknown'}`);
    }
  }

  // ── Step 4: Convert .et → .xlsx (with retry) ─────────────────────
  // We still need LibreOffice conversion because SheetJS (xlsx library)
  // needs the .xlsx format to parse product data (rows, columns, formulas).
  // But we only use the xlsx for TEXT data — images come from OLE2.
  reportProgress(onProgress, 25, 'Converting .et to .xlsx', 'Running LibreOffice...');
  let xlsxBuffer;

  // Save resume state before conversion
  await saveResumeState(tempDir, { step: 'converting', timestamp: Date.now() });

  // Try conversion with up to 2 retries
  const MAX_CONV_RETRIES = 2;
  let convErr = null;
  for (let attempt = 0; attempt <= MAX_CONV_RETRIES; attempt++) {
    if (attempt > 0) {
      const waitSec = attempt * 3;
      console.log(`[ET-IMAGE-EXTRACTOR] Conversion retry ${attempt}/${MAX_CONV_RETRIES} after ${waitSec}s delay...`);
      reportProgress(onProgress, 25, 'Retrying conversion', `Attempt ${attempt}/${MAX_CONV_RETRIES}`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
    try {
      xlsxBuffer = await convertETtoXLSX(etBuffer, tempDir);
      convErr = null;
      break; // Success
    } catch (err) {
      convErr = err;
      console.warn(`[ET-IMAGE-EXTRACTOR] Conversion attempt ${attempt + 1} failed:`, err.message);
    }
  }

  if (convErr) {
    console.error('[ET-IMAGE-EXTRACTOR] All conversion attempts failed:', convErr.message);
    await clearResumeState(tempDir);
    reportProgress(onProgress, 100, 'Failed', `Conversion error: ${convErr.message}`);
    return {
      products: [],
      allImages: [],
      totalImages: 0,
      hasEmbeddedImages: false,
      warning: `LibreOffice conversion failed after ${MAX_CONV_RETRIES + 1} attempts: ${convErr.message}.`
    };
  }

  console.log(`[ET-IMAGE-EXTRACTOR] Conversion successful (${(xlsxBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  // ── P4: Validate LibreOffice output buffer ────────────────────────
  // LibreOffice can silently produce a corrupt/empty xlsx (e.g., only 4 bytes
  // containing an empty ZIP header) when the .et file has structural issues
  // that don't throw an error. Check that the output is a valid xlsx.
  if (!xlsxBuffer || xlsxBuffer.length < 100) {
    console.error(`[ET-IMAGE-EXTRACTOR] LibreOffice produced invalid output: ${xlsxBuffer ? xlsxBuffer.length : 0} bytes (expected > 100)`);
    await clearResumeState(tempDir);
    reportProgress(onProgress, 100, 'Failed', `LibreOffice produced invalid output: ${xlsxBuffer ? xlsxBuffer.length : 0} bytes`);
    return {
      products: [],
      allImages: [],
      totalImages: 0,
      hasEmbeddedImages: false,
      warning: `LibreOffice conversion produced an invalid output (${xlsxBuffer ? xlsxBuffer.length : 0} bytes). The .et file may be corrupted or in an unsupported format.`
    };
  }

  reportProgress(onProgress, 50, 'Converting .et to .xlsx', 'Done');

  // Save resume state after conversion
  await saveResumeState(tempDir, { step: 'extracting_images', timestamp: Date.now() });

  // ── Step 5: Extract images (from OLE2 if available, else from xlsx) ──
  let images;
  let rowImageMap;
  let imageNameMap;
  let sortedImagesByPosition = null; // OLE2 images sorted by y-position for row mapping

  if (oleImages && oleImages.length > 0) {
    // Use OLE2-extracted images — these have UUID mappings for DISPIMG matching
    // AND position-sorted images from cellImages.xml <a:off y="..."/> data.
    // The position data is more reliable than UUID matching because DISPIMG
    // formulas may reference images by different naming schemes.
    console.log(`[ET-IMAGE-EXTRACTOR] Using ${oleImages.length} OLE2-extracted images with position-based row mapping`);
    images = oleImages;
    // Get the position-sorted images from OLE2 extraction (sorted by y-coordinate
    // from cellImages.xml <a:off y="..."/>). These will be mapped to rows
    // one-to-one in extractProductsFromRows.
    sortedImagesByPosition = oleResult.sortedImagesByPosition || null;
    rowImageMap = new Map(); // Will be built in extractProductsFromRows
    imageNameMap = new Map(); // Not needed when we have OLE2 images
    console.log(`[ET-IMAGE-EXTRACTOR] OLE2 sortedImagesByPosition has ${sortedImagesByPosition ? sortedImagesByPosition.length : 0} entries`);
    reportProgress(onProgress, 60, 'Using OLE2 images', `${oleImages.length} images with position-based row mapping`);
  } else {
    // Fall back to LibreOffice-extracted images
    reportProgress(onProgress, 55, 'Extracting embedded images', 'Parsing workbook media...');
    const xlsxResult = await extractImagesFromXLSX(xlsxBuffer);
    images = xlsxResult.images;
    rowImageMap = xlsxResult.rowImageMap;
    imageNameMap = xlsxResult.imageNameMap;

    if (images.length === 0) {
      console.log('[ET-IMAGE-EXTRACTOR] No embedded images found in .et file');
      await clearResumeState(tempDir);
      reportProgress(onProgress, 100, 'Failed', 'No embedded images found');
      return {
        products: [],
        allImages: [],
        totalImages: 0,
        hasEmbeddedImages: false,
        warning: 'No embedded images found in the .et file.'
      };
    }
    reportProgress(onProgress, 60, 'Extracting embedded images', `${images.length} images found`);
  }

  // Save resume state after image extraction
  await saveResumeState(tempDir, { step: 'extracting_products', timestamp: Date.now(), imageCount: images.length });

  // ── Step 6: Extract products (positional zipping) ────────────────
  // Use the new positional zipping approach: images sorted by yPos from
  // cellImages.xml are paired 1:1 with spreadsheet data rows in order.
  // Falls back to extractProductsFromRows (calibration method) if positional
  // zipping fails to produce any products.
  reportProgress(onProgress, 65, 'Extracting product data', 'Positional zipping images to rows...');
  let products;
  if (sortedImagesByPosition && sortedImagesByPosition.length > 0) {
    products = extractProductsPositionally(xlsxBuffer, sortedImagesByPosition);
    if (products.length === 0 && sortedImagesByPosition.length > 0) {
      console.log('[ET-IMAGE-EXTRACTOR] Positional zipping produced 0 products, falling back to calibration method');
      products = extractProductsFromRows(xlsxBuffer, rowImageMap, imageNameMap, oleUuidMap, sortedImagesByPosition);
    }
  } else {
    products = extractProductsFromRows(xlsxBuffer, rowImageMap, imageNameMap, oleUuidMap, sortedImagesByPosition);
  }
  reportProgress(onProgress, 80, 'Extracting product data', `${products.length} products found`);

  // ── Step 6.5: Report matching stats ──────────────────────────────
  if (products.length > 0 && images.length > 0) {
    const withImages = products.filter(p => p.hasPreMappedImage).length;
    const uuidMatched = products.filter(p => p.matchedViaUUID).length;
    console.log(`[ET-IMAGE-EXTRACTOR] Matching: ${withImages}/${products.length} products have images (${uuidMatched} via UUID, ${withImages - uuidMatched} via positional)`);
  }

  // ── Step 7: Build allImages array (compatible with existing format) ──
  reportProgress(onProgress, 85, 'Building image data URLs', `${images.length} images`);
  const allImages = images.map((img, idx) => {
    // OLE2 images have dataUrl directly; xlsx images have buffer
    const dataUrl = img.dataUrl || (img.buffer
      ? `data:${img.mimeType};base64,${img.buffer.toString('base64')}`
      : '');
    return {
      name: img.name || `embedded_image_${idx}.${img.extension || 'png'}`,
      dataUrl,
      width: img.width || 0,
      height: img.height || 0,
      size: img.size || (img.buffer ? img.buffer.length : 0),
      galleryUrl: '',
      isEmbedded: true,
      imageIndex: idx,
      uuid: img.uuid || ''
    };
  });

  // ── Step 7.5: Smooth progress animation ──────────────────────────
  if (typeof onProgress === 'function') {
    await animateProgress(onProgress, batchId, 85, 98, 'Finalizing', 3000);
  }

  // ── Step 8: Finalize ─────────────────────────────────────────────
  await clearResumeState(tempDir);

  const withImages = products.filter(p => p.hasPreMappedImage).length;
  console.log(`[ET-IMAGE-EXTRACTOR] Extraction complete: ${products.length} products, ${allImages.length} images (${withImages} with pre-mapped images)`);
  reportProgress(onProgress, 100, 'Complete', `${products.length} products, ${allImages.length} images`);

  return {
    products,
    allImages,
    totalImages: allImages.length,
    hasEmbeddedImages: true
  };
}

/**
 * Quick check if a buffer appears to be a .et file (re-exported for convenience).
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isETFile(buffer) {
  if (!buffer || buffer.length < 8) return false;
  const magic = buffer.readUInt32LE(0);
  return magic === 0xE11AB1A0 || magic === 0xE011CFD0;
}

// ──────────────────────────────────────────────────────────────────────
//  AI Verification for .et product-image matches
//
//  After positional mapping extracts products+images from the .et file,
//  AI vision models visually verify each product-image pair to catch
//  misalignments caused by LibreOffice conversion artifacts.
//
//  The positional mapping (DISPIMG row order → image anchor row order)
//  can be wrong when LibreOffice reorders images during .et → .xlsx
//  conversion. AI verification catches these cases.
//
//  Design:
//    - Primary: OpenAI GPT-4o Vision (gpt-4o-mini default)
//    - Fallback: Gemini 2.0 Flash when OpenAI rate-limits (429)
//    - Batch-by-batch processing: 1 product at a time (slow = no rate limits)
//    - 5s deliberate pause between batches to avoid rate limits
//    - Retry with exponential backoff (10s → 30s → 60s)
//    - 60s timeout per product match
//    - Pause/resume via file-based resume state
//    - Graceful degradation: individual failures produce "needs review" entries
// ──────────────────────────────────────────────────────────────────────

const OPENAI_API_KEY = () => process.env.OPENAI_API_KEY;
const VERIFY_MODEL = process.env.OPENAI_VERIFY_MODEL || 'gpt-4o-mini';
const OPENAI_API_BASE = 'https://api.openai.com/v1';

const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY;
const GEMINI_VERIFY_MODEL = process.env.GEMINI_VERIFY_MODEL || 'gemini-2.0-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const ET_BATCH_SIZE = 1;            // Products per batch (1 at a time = no rate limits)
const ET_INTER_BATCH_DELAY_MS = 5000; // 5s pause between batches
const ET_MATCH_TIMEOUT_MS = 60000;  // 60s timeout per product match
const ET_MAX_RETRIES = 3;
const ET_RETRY_DELAYS = [10000, 30000, 60000]; // 10s, 30s, 60s

/**
 * Verify a single product-image pair using OpenAI GPT-4o Vision.
 * Sends product info + candidate image, returns structured JSON with confidence.
 *
 * @param {object} product - { name, productCode, description, brand, row }
 * @param {string} imageDataUrl - Base64 data URL of the candidate image
 * @returns {Promise<{isMatch: boolean, confidence: number, reason: string}>}
 */
async function verifyProductImagePair(product, imageDataUrl) {
  const openaiKey = OPENAI_API_KEY();
  const geminiKey = GEMINI_API_KEY();

  if (!openaiKey && !geminiKey) {
    return { isMatch: true, confidence: 100, reason: 'AI verification skipped (no API keys configured)' };
  }

  const productInfo = JSON.stringify({
    name: product.name || '',
    code: product.productCode || '',
    brand: product.brand || '',
    description: (product.description || '').substring(0, 300),
    row: product.row || ''
  }, null, 2);

  const openaiPrompt = `You are a product-image verification assistant for a furniture catalog. I will give you product information extracted from a spreadsheet row, and an image that was embedded in that same spreadsheet cell.

IMPORTANT: Your task is to verify whether the IMAGE actually matches the PRODUCT DESCRIPTION. The spreadsheet may have more products than images, and some products may have been assigned the wrong image. Do NOT blindly trust row alignment — verify the content match.

PRODUCT INFORMATION (from spreadsheet row):
${productInfo}

TASK:
Look at the image and determine if it shows the SAME product described in the product information. Compare the image content (type of furniture, style, color, material, shape) against the product description.

CRITICAL RULES:
- Check if the image shows a furniture item that MATCHES the product description (e.g., if description says "dining chair", the image should show a dining chair, not a sofa)
- If the description mentions specific features (color, material, style), check if the image is consistent with those features
- If the image clearly shows a DIFFERENT type of furniture than what the description says, it's a MISMATCH
- If the image shows a furniture item that COULD match the description (same category), it's a VALID match
- Only reject if the image clearly does NOT match the product description (e.g., description says "sofa" but image shows a "dining table")
- If the image is a logo, icon, blank, or corrupted data, reject it
- If you cannot determine the match from the image alone, give a medium confidence and flag for review

Return STRICT JSON ONLY with this exact structure:
{
  "match": true,
  "confidence": 95,
  "reason": "The image shows a dining chair that matches the product description."
}

RULES:
- "match" must be true or false
- "confidence" must be an integer 0-100
- Auto-accept if confidence >= 90 (image clearly matches the product description)
- Needs review if confidence >= 70 and < 90 (possible match but uncertain)
- Reject if confidence < 70 (image does NOT match the product description)
- "reason" should briefly explain WHY the image matches or doesn't match the description
- Return ONLY valid JSON, no markdown, no code fences`;

  const geminiPrompt = `You are a product-image verification assistant for a furniture catalog. I will give you product information extracted from a spreadsheet row, and an image that was embedded in that same spreadsheet cell.

IMPORTANT: Your task is to verify whether the IMAGE actually matches the PRODUCT DESCRIPTION. The spreadsheet may have more products than images, and some products may have been assigned the wrong image. Do NOT blindly trust row alignment — verify the content match.

PRODUCT INFORMATION (from spreadsheet row):
${productInfo}

TASK:
Look at the image and determine if it shows the SAME product described in the product information. Compare the image content (type of furniture, style, color, material, shape) against the product description.

CRITICAL RULES:
- Check if the image shows a furniture item that MATCHES the product description (e.g., if description says "dining chair", the image should show a dining chair, not a sofa)
- If the description mentions specific features (color, material, style), check if the image is consistent with those features
- If the image clearly shows a DIFFERENT type of furniture than what the description says, it's a MISMATCH
- If the image shows a furniture item that COULD match the description (same category), it's a VALID match
- Only reject if the image clearly does NOT match the product description (e.g., description says "sofa" but image shows a "dining table")
- If the image is a logo, icon, blank, or corrupted data, reject it
- If you cannot determine the match from the image alone, give a medium confidence and flag for review

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "match": true,
  "confidence": 95,
  "reason": "The image shows a dining chair that matches the product description."
}

RULES:
- "match" must be true or false
- "confidence" must be an integer 0-100
- Auto-accept if confidence >= 90 (image clearly matches the product description)
- Needs review if confidence >= 70 and < 90 (possible match but uncertain)
- Reject if confidence < 70 (image does NOT match the product description)
- "reason" should briefly explain WHY the image matches or doesn't match the description`;

  console.log(`[ET-IMAGE-EXTRACTOR] AI verifying product "${product.name || product.productCode}" (row ${product.row})...`);

  /**
   * Try verifying with OpenAI GPT-4o Vision.
   */
  const tryOpenAI = async () => {
    if (!openaiKey) return null;

    const requestBody = {
      model: VERIFY_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: openaiPrompt },
            {
              type: 'image_url',
              image_url: {
                url: imageDataUrl,
                detail: 'high'
              }
            }
          ]
        }
      ],
      max_tokens: 500,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    };

    const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(ET_MATCH_TIMEOUT_MS)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`OpenAI API error (${res.status}): ${errText || res.statusText}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    return parseVerificationResult(content, 'OpenAI');
  };

  /**
   * Try verifying with Gemini as fallback.
   */
  const tryGemini = async () => {
    if (!geminiKey) return null;

    // Extract base64 data from data URL
    const matches = imageDataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!matches) {
      console.log(`[ET-IMAGE-EXTRACTOR] Gemini fallback: invalid image data URL for "${product.name}", skipping`);
      return null;
    }

    const mimeType = matches[1];
    const base64Data = matches[2];
    const apiUrl = `${GEMINI_API_BASE}/${GEMINI_VERIFY_MODEL}:generateContent?key=${geminiKey}`;

    const requestBody = {
      contents: [{
        role: 'user',
        parts: [
          { text: geminiPrompt },
          {
            inlineData: {
              mimeType,
              data: base64Data
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500
      }
    };

    console.log(`[ET-IMAGE-EXTRACTOR] Gemini fallback verifying "${product.name || product.productCode}"...`);

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(ET_MATCH_TIMEOUT_MS)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini API error (${res.status}): ${errText.substring(0, 200) || res.statusText}`);
    }

    const data = await res.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!content) {
      throw new Error('Empty response from Gemini');
    }

    return parseVerificationResult(content, 'Gemini');
  };

  /**
   * Parse JSON verification result from either provider.
   */
  const parseVerificationResult = (content, provider) => {
    let result;
    try {
      result = JSON.parse(content);
    } catch (parseErr) {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error(`Failed to parse ${provider} verification JSON: ${parseErr.message}`);
      }
    }

    if (result.match === undefined) {
      throw new Error(`${provider} verification response missing "match" field`);
    }

    const confidence = Math.min(100, Math.max(0, Math.round(result.confidence || 0)));
    const isMatch = result.match === true;

    console.log(`[ET-IMAGE-EXTRACTOR] AI verification (${provider}): product "${product.name || product.productCode}" → ${isMatch ? 'MATCH' : 'MISMATCH'} (confidence: ${confidence}) — ${result.reason || ''}`);

    return {
      isMatch,
      confidence,
      reason: result.reason || '',
      provider
    };
  };

  /**
   * Check if an error is a rate-limit error (429).
   */
  const isRateLimitError = (err) => {
    return err.status === 429 || err.message?.includes('429') || err.message?.includes('rate_limit');
  };

  // ── Strategy: Try OpenAI first, fall back to Gemini on rate limits ──
  // OpenAI gets 2 retries with backoff, then falls back to Gemini.
  // Gemini gets 1 retry, then gives up.

  // Phase 1: Try OpenAI with retries
  if (openaiKey) {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        return await tryOpenAI();
      } catch (err) {
        // Non-retryable errors — bail immediately
        const isNonRetryable =
          err.message?.includes('401') ||
          err.message?.includes('403') ||
          err.message?.includes('invalid_api_key') ||
          err.message?.includes('insufficient_quota');

        if (isNonRetryable) {
          console.error(`[ET-IMAGE-EXTRACTOR] Non-retryable OpenAI error for "${product.name}": ${err.message}`);
          // Try Gemini fallback
          if (geminiKey) {
            console.log(`[ET-IMAGE-EXTRACTOR] Falling back to Gemini for "${product.name}"...`);
            try {
              return await tryGemini();
            } catch (geminiErr) {
              console.error(`[ET-IMAGE-EXTRACTOR] Gemini fallback also failed for "${product.name}": ${geminiErr.message}`);
              return { isMatch: true, confidence: 100, reason: `AI verification unavailable (OpenAI: ${err.message}, Gemini: ${geminiErr.message}), trusting positional mapping` };
            }
          }
          return { isMatch: true, confidence: 100, reason: `AI verification unavailable: ${err.message}, trusting positional mapping` };
        }

        // Rate limit (429) — retry with backoff, then fall back to Gemini
        if (isRateLimitError(err)) {
          if (attempt < 2) {
            const delay = ET_RETRY_DELAYS[attempt];
            console.warn(`[ET-IMAGE-EXTRACTOR] OpenAI rate-limited for "${product.name}", retry ${attempt + 1}/2 in ${(delay / 1000).toFixed(0)}s`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          // Exhausted OpenAI retries — fall back to Gemini
          if (geminiKey) {
            console.log(`[ET-IMAGE-EXTRACTOR] OpenAI rate-limited, falling back to Gemini for "${product.name}"...`);
            try {
              return await tryGemini();
            } catch (geminiErr) {
              console.error(`[ET-IMAGE-EXTRACTOR] Gemini fallback also failed for "${product.name}": ${geminiErr.message}`);
              return { isMatch: true, confidence: 100, reason: `AI verification failed (OpenAI rate-limited, Gemini error: ${geminiErr.message}), trusting positional mapping` };
            }
          }
          return { isMatch: true, confidence: 100, reason: `AI verification failed after retries (rate-limited), trusting positional mapping` };
        }

        // Other errors — retry with backoff
        if (attempt < 2) {
          const delay = ET_RETRY_DELAYS[attempt];
          console.warn(`[ET-IMAGE-EXTRACTOR] OpenAI error for "${product.name}", retry ${attempt + 1}/2 in ${(delay / 1000).toFixed(0)}s: ${err.message}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // All OpenAI attempts exhausted — try Gemini
          if (geminiKey) {
            console.log(`[ET-IMAGE-EXTRACTOR] OpenAI failed, falling back to Gemini for "${product.name}"...`);
            try {
              return await tryGemini();
            } catch (geminiErr) {
              console.error(`[ET-IMAGE-EXTRACTOR] Gemini fallback also failed for "${product.name}": ${geminiErr.message}`);
              return { isMatch: true, confidence: 100, reason: `AI verification failed (OpenAI: ${err.message}, Gemini: ${geminiErr.message}), trusting positional mapping` };
            }
          }
          return { isMatch: true, confidence: 100, reason: `AI verification failed after retries: ${err.message}, trusting positional mapping` };
        }
      }
    }
  }

  // Phase 2: No OpenAI key, try Gemini directly
  if (geminiKey) {
    try {
      return await tryGemini();
    } catch (err) {
      console.error(`[ET-IMAGE-EXTRACTOR] Gemini verification failed for "${product.name}": ${err.message}`);
      return { isMatch: true, confidence: 100, reason: `AI verification failed (Gemini: ${err.message}), trusting positional mapping` };
    }
  }

  return { isMatch: true, confidence: 100, reason: 'AI verification skipped (no API keys configured)' };
}

/**
 * Run AI verification on all product-image pairs from .et extraction.
 * Uses OpenAI GPT-4o Vision to verify each positional-mapped pair.
 *
 * Features:
 *   - Batch-by-batch processing (2 products at a time)
 *   - 3s deliberate pause between batches to avoid rate limits
 *   - Retry with exponential backoff per product
 *   - Pause/resume via file-based resume state
 *   - Progress reporting
 *
 * @param {Array<object>} products - Products from extractETImagesAndData
 * @param {Array<object>} allImages - All embedded images
 * @param {object} [options]
 * @param {function} [options.onProgress] - Progress callback
 * @param {string} [options.resumeDir] - Directory for pause/resume state (uses tempDir from extraction)
 * @returns {Promise<Array<object>>} Products with AI-verified confidence scores
 */
export async function verifyEtMatchesWithAI(products, allImages, options = {}) {
  const onProgress = options.onProgress || null;
  const resumeDir = options.resumeDir || null;
  const batchId = options.batchId || null; // For pause/resume support

  if (!products || products.length === 0) {
    return [];
  }

  console.log(`[ET-IMAGE-EXTRACTOR] AI verification: verifying ${products.length} product-image pairs (batch size: ${ET_BATCH_SIZE}, delay: ${ET_INTER_BATCH_DELAY_MS}ms)`);

  // Try to load resume state
  let resumeState = null;
  if (resumeDir) {
    resumeState = await loadResumeState(resumeDir);
  }

  const verifiedProducts = [];
  let completed = 0;
  const totalProducts = products.length;

  // Determine starting point from resume state
  const startIndex = resumeState?.aiVerificationIndex || 0;
  if (startIndex > 0) {
    // Restore already-verified products from resume state
    if (resumeState?.verifiedProducts) {
      verifiedProducts.push(...resumeState.verifiedProducts);
      completed = verifiedProducts.length;
      console.log(`[ET-IMAGE-EXTRACTOR] Resuming from product ${startIndex + 1}/${totalProducts} (${completed} already verified)`);
    }
  }

  // Process in batches
  for (let i = startIndex; i < totalProducts; i += ET_BATCH_SIZE) {
    // ── Check pause flag before each batch ──────────────────────────
    // If the user clicked "Pause", wait here until they click "Continue".
    // The UI calls POST /api/agent/et-pause/:batchId to toggle the flag.
    if (batchId && etPauseStore.has(batchId) && etPauseStore.get(batchId).paused) {
      console.log(`[ET-IMAGE-EXTRACTOR] AI verification paused at product ${i + 1}/${totalProducts}`);
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            percent: Math.round((completed / totalProducts) * 100),
            stage: 'AI Verification (Paused)',
            detail: `Paused at ${i + 1}/${totalProducts} — waiting to continue...`
          });
        } catch {}
      }
      // Wait until unpaused
      while (etPauseStore.has(batchId) && etPauseStore.get(batchId).paused) {
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log(`[ET-IMAGE-EXTRACTOR] AI verification resumed at product ${i + 1}/${totalProducts}`);
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            percent: Math.round((completed / totalProducts) * 100),
            stage: 'AI Verification',
            detail: `${completed}/${totalProducts} products verified`
          });
        } catch {}
      }
    }

    const batch = products.slice(i, i + ET_BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (product) => {
        // Find the matched image for this product
        let imageDataUrl = '';
        if (product.hasPreMappedImage && product.imageName) {
          const img = allImages.find(img => img.name === product.imageName);
          if (img) imageDataUrl = img.dataUrl;
        }
        // Fallback: use positional index
        if (!imageDataUrl && product.dataUrl) {
          imageDataUrl = product.dataUrl;
        }

        if (!imageDataUrl) {
          return {
            ...product,
            aiVerified: false,
            aiConfidence: 0,
            aiReason: 'No image available for verification',
            aiMatchStatus: 'needs_review'
          };
        }

        const result = await verifyProductImagePair(product, imageDataUrl);

        return {
          ...product,
          aiVerified: true,
          aiConfidence: result.confidence,
          aiReason: result.reason,
          aiMatchStatus: result.isMatch && result.confidence >= 90
            ? 'auto_accepted'
            : result.isMatch && result.confidence >= 70
              ? 'needs_review'
              : 'rejected'
        };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        verifiedProducts.push(result.value);
      } else {
        // Keep original product on error
        const idx = verifiedProducts.length;
        verifiedProducts.push({
          ...products[idx],
          aiVerified: false,
          aiConfidence: 100,
          aiReason: `Verification error: ${result.reason?.message || 'unknown'}`,
          aiMatchStatus: 'needs_review'
        });
      }
      completed++;
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            percent: Math.round((completed / totalProducts) * 100),
            stage: 'AI Verification',
            detail: `${completed}/${totalProducts} products verified`
          });
        } catch {}
      }
    }

    // Save resume state after each batch
    if (resumeDir) {
      await saveResumeState(resumeDir, {
        aiVerificationIndex: i + ET_BATCH_SIZE,
        verifiedProducts
      });
    }

    // Deliberate pause between batches to avoid rate limits
    if (i + ET_BATCH_SIZE < totalProducts) {
      console.log(`[ET-IMAGE-EXTRACTOR] Batch complete (${Math.min(i + ET_BATCH_SIZE, totalProducts)}/${totalProducts}), pausing ${ET_INTER_BATCH_DELAY_MS}ms before next batch...`);
      await new Promise(resolve => setTimeout(resolve, ET_INTER_BATCH_DELAY_MS));
    }
  }

  // Clear resume state on successful completion
  if (resumeDir) {
    await clearResumeState(resumeDir);
  }

  const autoAccepted = verifiedProducts.filter(p => p.aiMatchStatus === 'auto_accepted').length;
  const needsReview = verifiedProducts.filter(p => p.aiMatchStatus === 'needs_review').length;
  const rejected = verifiedProducts.filter(p => p.aiMatchStatus === 'rejected').length;

  console.log(`[ET-IMAGE-EXTRACTOR] AI verification complete: ${autoAccepted} auto-accepted, ${needsReview} needs review, ${rejected} rejected`);

  return verifiedProducts;
}
