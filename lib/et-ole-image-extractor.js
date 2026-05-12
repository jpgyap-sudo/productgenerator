// ═══════════════════════════════════════════════════════════════════
//  lib/et-ole-image-extractor.js
//
//  Direct OLE2 parser for WPS .et files.
//
//  Problem:
//    WPS Office .et files store embedded cell images in a proprietary
//    OLE2 stream called "ETCellImageData". LibreOffice's .et → .xlsx
//    conversion does NOT know about this stream, so it only extracts
//    linked (non-embedded) images — typically 0-4 instead of the full
//    set of 57+ images.
//
//  Solution:
//    Parse the OLE2 compound document directly using the `cfb` library
//    (already a dependency of `xlsx`). The ETCellImageData stream
//    contains an embedded ZIP archive with:
//      - xl/cellImages.xml       — image-to-cell mapping with DISPIMG UUIDs
//      - xl/media/image*.png     — actual embedded images
//      - xl/_rels/cellImages.xml.rels — rId-to-filename mapping
//
//  Usage:
//    import { extractImagesFromETCellImageData } from './lib/et-ole-image-extractor.js';
//    const result = extractImagesFromETCellImageData(etBuffer);
//    // result.images = [{ name, dataUrl, width, height, size, uuid }]
//    // result.uuidMap = Map<uuid, imageObject>
// ═══════════════════════════════════════════════════════════════════

import CFB from 'cfb';
import zlib from 'zlib';

// ── Constants ──────────────────────────────────────────────────────

const ETCellImageData_STREAM = 'ETCellImageData';

// ZIP local file header signature
const ZIP_LOCAL_HEADER_SIG = 0x04034b50;
// ZIP central directory signature
const ZIP_CENTRAL_DIR_SIG = 0x02014b50;
// ZIP end of central directory signature
const ZIP_EOCD_SIG = 0x06054b50;

// ── Main extraction function ───────────────────────────────────────

/**
 * Extract all embedded cell images from a WPS .et file by parsing
 * the OLE2 ETCellImageData stream directly.
 *
 * @param {Buffer} etBuffer - Raw .et file buffer
 * @returns {object} {
 *   images: Array<{ name, dataUrl, width, height, size, uuid }>,
 *   uuidMap: Map<string, object>,  // UUID → image object
 *   imageCount: number,
 *   success: boolean,
 *   error?: string
 * }
 */
export function extractImagesFromETCellImageData(etBuffer) {
  try {
    // ── Step 1: Parse OLE2 compound document ──────────────────────
    const cfb = CFB.read(etBuffer, { type: 'buffer' });

    // ── Step 2: Find the ETCellImageData stream ───────────────────
    const entry = CFB.find(cfb, ETCellImageData_STREAM);
    if (!entry) {
      return {
        images: [],
        uuidMap: new Map(),
        imageCount: 0,
        success: false,
        error: 'ETCellImageData stream not found in OLE2 document'
      };
    }

    const rawContent = entry.content;
    if (!rawContent || rawContent.length < 4) {
      return {
        images: [],
        uuidMap: new Map(),
        imageCount: 0,
        success: false,
        error: 'ETCellImageData stream is empty'
      };
    }

    // ── Step 3: Parse the embedded ZIP archive ────────────────────
    const zipEntries = parseEmbeddedZip(rawContent);
    if (zipEntries.length === 0) {
      return {
        images: [],
        uuidMap: new Map(),
        imageCount: 0,
        success: false,
        error: 'No ZIP entries found in ETCellImageData stream'
      };
    }

    // ── Step 4: Extract cellImages.xml ────────────────────────────
    const cellImagesXmlEntry = zipEntries.find(e =>
      e.fileName === 'xl/cellImages.xml'
    );
    if (!cellImagesXmlEntry) {
      return {
        images: [],
        uuidMap: new Map(),
        imageCount: 0,
        success: false,
        error: 'xl/cellImages.xml not found in embedded ZIP'
      };
    }

    const cellImagesXml = decompressEntry(rawContent, cellImagesXmlEntry);
    if (!cellImagesXml) {
      return {
        images: [],
        uuidMap: new Map(),
        imageCount: 0,
        success: false,
        error: 'Failed to decompress xl/cellImages.xml'
      };
    }

    // ── Step 5: Extract relationships file ────────────────────────
    const relsEntry = zipEntries.find(e =>
      e.fileName === 'xl/_rels/cellImages.xml.rels'
    );
    let relsXml = null;
    if (relsEntry) {
      relsXml = decompressEntry(rawContent, relsEntry);
    }

    // ── Step 6: Parse relationships → rId → filename map ─────────
    const relsMap = parseRelsXml(relsXml);

    // ── Step 7: Parse cellImages.xml → UUID → rId → position ─────
    const cellImageEntries = parseCellImagesXml(cellImagesXml);

    // ── Step 8: Build UUID → image mapping ────────────────────────
    const uuidMap = new Map();
    const images = [];

    for (const cellImage of cellImageEntries) {
      const { uuid, rId, description } = cellImage;
      const fileName = relsMap.get(rId);

      if (!fileName) {
        console.log(`[ET-OLE] No filename found for rId "${rId}" (UUID: ${uuid})`);
        continue;
      }

      // Find the ZIP entry for this image file
      const mediaEntry = zipEntries.find(e =>
        e.fileName === `xl/${fileName}` || e.fileName.endsWith(fileName)
      );

      if (!mediaEntry) {
        console.log(`[ET-OLE] No ZIP entry found for "${fileName}" (UUID: ${uuid})`);
        continue;
      }

      // Decompress the image data
      const imageBuffer = decompressEntry(rawContent, mediaEntry);
      if (!imageBuffer) {
        console.log(`[ET-OLE] Failed to decompress "${fileName}" (UUID: ${uuid})`);
        continue;
      }

      // Determine image type from filename
      const ext = fileName.split('.').pop().toLowerCase();
      const mimeType = ext === 'png' ? 'image/png' :
                       ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                       'application/octet-stream';

      const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

      const imageObj = {
        name: fileName,
        dataUrl,
        width: 0,   // Can be determined from image headers if needed
        height: 0,
        size: imageBuffer.length,
        uuid,
        description: description || '',
        mimeType
      };

      images.push(imageObj);
      uuidMap.set(uuid, imageObj);
    }

    console.log(`[ET-OLE] Extracted ${images.length} images from ETCellImageData (${uuidMap.size} UUID mappings)`);

    return {
      images,
      uuidMap,
      imageCount: images.length,
      success: images.length > 0
    };

  } catch (err) {
    console.error(`[ET-OLE] Extraction failed: ${err.message}`);
    return {
      images: [],
      uuidMap: new Map(),
      imageCount: 0,
      success: false,
      error: err.message
    };
  }
}

// ── ZIP parsing ────────────────────────────────────────────────────

/**
 * Parse a ZIP archive embedded in a buffer.
 * Scans for local file headers (PK\x03\x04) and extracts entry metadata.
 *
 * @param {Buffer} buffer - Raw buffer containing ZIP data
 * @returns {Array<{fileName, compressionMethod, compressedSize, uncompressedSize, dataStart}>}
 */
function parseEmbeddedZip(buffer) {
  const entries = [];

  for (let i = 0; i < buffer.length - 30; i++) {
    // Check for ZIP local file header
    if (buffer.readUInt32LE(i) === ZIP_LOCAL_HEADER_SIG) {
      const compressionMethod = buffer.readUInt16LE(i + 8);
      const compressedSize = buffer.readUInt32LE(i + 18);
      const fileNameLen = buffer.readUInt16LE(i + 26);
      const extraLen = buffer.readUInt16LE(i + 28);
      const fileName = buffer.slice(i + 30, i + 30 + fileNameLen).toString('utf8');
      const dataStart = i + 30 + fileNameLen + extraLen;

      entries.push({
        offset: i,
        fileName,
        compressionMethod,
        compressedSize,
        uncompressedSize: buffer.readUInt32LE(i + 22),
        dataStart,
        dataEnd: dataStart + compressedSize
      });

      // Skip past this entry's data to find next header faster
      i = dataStart + compressedSize - 1;
    }
  }

  return entries;
}

/**
 * Decompress a ZIP entry's data.
 * Supports method 0 (stored) and method 8 (deflate).
 *
 * @param {Buffer} buffer - Raw ZIP buffer
 * @param {object} entry - ZIP entry metadata
 * @returns {Buffer|null} Decompressed data, or null on failure
 */
function decompressEntry(buffer, entry) {
  try {
    const rawData = buffer.slice(entry.dataStart, entry.dataEnd);

    if (entry.compressionMethod === 0) {
      // Stored (no compression)
      return rawData;
    } else if (entry.compressionMethod === 8) {
      // Deflate
      return zlib.inflateRawSync(rawData);
    } else {
      console.warn(`[ET-OLE] Unsupported compression method: ${entry.compressionMethod} for "${entry.fileName}"`);
      return null;
    }
  } catch (err) {
    console.warn(`[ET-OLE] Decompression failed for "${entry.fileName}": ${err.message}`);
    return null;
  }
}

// ── XML parsing (no external deps) ─────────────────────────────────

/**
 * Parse cellImages.xml to extract UUID → rId → position mappings.
 * Uses simple string-based parsing to avoid XML library dependency.
 *
 * @param {string} xml - cellImages.xml content
 * @returns {Array<{uuid, rId, description}>}
 */
function parseCellImagesXml(xml) {
  const entries = [];

  // Split by <etc:cellImage> tags
  const cellImageRegex = /<etc:cellImage>([\s\S]*?)<\/etc:cellImage>/g;
  let match;

  while ((match = cellImageRegex.exec(xml)) !== null) {
    const block = match[1];

    // Extract UUID from <xdr:cNvPr name="ID_...">
    const nameMatch = block.match(/name="([^"]+)"/);
    const uuid = nameMatch ? nameMatch[1] : '';

    // Extract description (product code hint)
    const descMatch = block.match(/descr="([^"]*)"/);
    const description = descMatch ? descMatch[1] : '';

    // Extract rId from <a:blip r:embed="rId...">
    const rIdMatch = block.match(/r:embed="([^"]+)"/);
    const rId = rIdMatch ? rIdMatch[1] : '';

    if (uuid && rId) {
      entries.push({ uuid, rId, description });
    }
  }

  console.log(`[ET-OLE] Parsed ${entries.length} cell image entries from XML`);
  return entries;
}

/**
 * Parse the relationships XML to build rId → filename map.
 *
 * @param {string|null} xml - cellImages.xml.rels content
 * @returns {Map<string, string>} rId → filename
 */
function parseRelsXml(xml) {
  const map = new Map();

  if (!xml) return map;

  const relRegex = /<Relationship[^>]*\/>/g;
  let match;

  while ((match = relRegex.exec(xml)) !== null) {
    const tag = match[0];
    const idMatch = tag.match(/Id="([^"]+)"/);
    const targetMatch = tag.match(/Target="([^"]+)"/);

    if (idMatch && targetMatch) {
      map.set(idMatch[1], targetMatch[1]);
    }
  }

  console.log(`[ET-OLE] Parsed ${map.size} relationship mappings`);
  return map;
}

// ── Utility ─────────────────────────────────────────────────────────

/**
 * Check if a buffer is a WPS .et file (OLE2 compound document).
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isETFile(buffer) {
  if (!buffer || buffer.length < 8) return false;
  // OLE2 signature: D0CF11E0A1B11AE1
  return buffer.slice(0, 8).toString('hex') === 'd0cf11e0a1b11ae1';
}

/**
 * Check if a buffer has the ETCellImageData stream.
 *
 * @param {Buffer} etBuffer
 * @returns {boolean}
 */
export function hasETCellImageData(etBuffer) {
  try {
    const cfb = CFB.read(etBuffer, { type: 'buffer' });
    const entry = CFB.find(cfb, ETCellImageData_STREAM);
    return !!entry;
  } catch {
    return false;
  }
}
