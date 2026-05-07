// ═══════════════════════════════════════════════════════════════════
//  lib/zip-extractor.js — ZIP extraction + image scoring
//  Uses adm-zip to extract ZIP files and score images by quality.
// ═══════════════════════════════════════════════════════════════════

import AdmZip from 'adm-zip';

const MIN_IMAGE_SIZE = 200; // Minimum width or height in pixels
const MIN_PIXEL_COUNT = 400 * 400; // Minimum total pixels (400x400)
const MAX_IMAGES_TO_RETURN = 20; // Max images to return in response
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB per image max

/**
 * Extract images from a ZIP buffer and score them by quality.
 *
 * @param {Buffer} zipBuffer - The ZIP file buffer
 * @returns {Promise<{images: Array, totalImages: number, selectedImage: object|null}>}
 */
export async function extractImagesFromZip(zipBuffer) {
  if (!zipBuffer || !Buffer.isBuffer(zipBuffer)) {
    throw new Error('ZIP buffer is required');
  }

  if (zipBuffer.length === 0) {
    throw new Error('ZIP buffer is empty');
  }

  console.log(`[ZIP-EXTRACTOR] Extracting images from ZIP (${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  console.log(`[ZIP-EXTRACTOR] ZIP contains ${entries.length} entries`);

  // Filter for image files and extract metadata
  const imageEntries = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const name = entry.entryName.toLowerCase();
    const isImage = /\.(jpg|jpeg|png|gif|webp|bmp|tiff?)$/i.test(name);

    if (!isImage) {
      console.log(`[ZIP-EXTRACTOR] Skipping non-image: ${entry.entryName}`);
      continue;
    }

    const data = entry.getData();

    if (!data || data.length === 0) {
      console.log(`[ZIP-EXTRACTOR] Skipping empty entry: ${entry.entryName}`);
      continue;
    }

    if (data.length > MAX_IMAGE_SIZE_BYTES) {
      console.log(`[ZIP-EXTRACTOR] Skipping oversized image: ${entry.entryName} (${(data.length / 1024 / 1024).toFixed(2)} MB)`);
      continue;
    }

    // Try to get dimensions from the image data
    const dimensions = getImageDimensions(data);

    imageEntries.push({
      name: entry.entryName,
      data,
      size: data.length,
      width: dimensions.width || 0,
      height: dimensions.height || 0,
      mimeType: getMimeType(entry.entryName)
    });
  }

  console.log(`[ZIP-EXTRACTOR] Found ${imageEntries.length} valid images`);

  if (imageEntries.length === 0) {
    return {
      images: [],
      totalImages: 0,
      selectedImage: null
    };
  }

  // Score and rank images
  const scored = imageEntries.map(img => ({
    ...img,
    score: calculateImageScore(img)
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Select the best image
  const selectedImage = scored[0] || null;

  // Prepare response — only include base64 data for the selected image
  // to keep the JSON response small (avoid browser hang with many images)
  const images = scored.slice(0, MAX_IMAGES_TO_RETURN).map(img => ({
    name: img.name,
    width: img.width,
    height: img.height,
    size: img.size,
    score: img.score,
    selected: img === selectedImage,
    // Only include base64 data for the selected image
    dataUrl: img === selectedImage
      ? `data:${img.mimeType};base64,${img.data.toString('base64')}`
      : null
  }));

  return {
    images,
    totalImages: imageEntries.length,
    selectedImage: selectedImage ? {
      name: selectedImage.name,
      width: selectedImage.width,
      height: selectedImage.height,
      size: selectedImage.size,
      score: selectedImage.score,
      dataUrl: `data:${selectedImage.mimeType};base64,${selectedImage.data.toString('base64')}`
    } : null
  };
}

/**
 * Calculate image quality score based on size and aspect ratio.
 * Higher score = better image for AI rendering.
 *
 * @param {object} img - Image entry with width, height, size
 * @returns {number} Quality score
 */
function calculateImageScore(img) {
  const { width, height, size } = img;

  // Skip images that are too small
  if (width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE) {
    return -1;
  }

  const pixelCount = width * height;

  // Base score: pixel count (more pixels = more detail)
  let score = pixelCount;

  // Aspect ratio bonus: prefer square-ish images (natural product photo ratio)
  const aspectRatio = Math.max(width, height) / Math.min(width, height);
  let aspectBonus = 1.0;

  if (aspectRatio <= 1.2) {
    // Nearly square — ideal
    aspectBonus = 1.2;
  } else if (aspectRatio <= 1.5) {
    // Slightly rectangular — good (4:3, 3:2)
    aspectBonus = 1.1;
  } else if (aspectRatio <= 2.0) {
    // Moderately rectangular — acceptable
    aspectBonus = 0.9;
  } else {
    // Very wide or very tall — penalize
    aspectBonus = 0.6;
  }

  score *= aspectBonus;

  // File size bonus: larger files typically have more detail
  const sizeBonus = Math.min(size / (100 * 1024), 3.0); // Cap at 3x for files >300KB
  score *= (1 + sizeBonus * 0.1);

  // Penalize very small images (below 400x400)
  if (pixelCount < MIN_PIXEL_COUNT) {
    score *= 0.5;
  }

  return Math.round(score);
}

/**
 * Try to extract image dimensions from raw image data.
 * Supports JPEG, PNG, GIF, WebP, BMP headers.
 *
 * @param {Buffer} data - Raw image data
 * @returns {{width: number, height: number}|null}
 */
function getImageDimensions(data) {
  if (!data || data.length < 24) return null;

  try {
    // JPEG
    if (data[0] === 0xFF && data[1] === 0xD8) {
      return getJpegDimensions(data);
    }

    // PNG
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
      return {
        width: data.readUInt32BE(16),
        height: data.readUInt32BE(20)
      };
    }

    // GIF
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
      return {
        width: data.readUInt16LE(6),
        height: data.readUInt16LE(8)
      };
    }

    // WebP
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
      // VP8X or VP8L or VP8
      const webpType = data.toString('ascii', 8, 12);
      if (webpType === 'VP8X') {
        const w = (data[24] | (data[25] << 8) | (data[26] << 16)) + 1;
        const h = (data[27] | (data[28] << 8) | (data[29] << 16)) + 1;
        return { width: w, height: h };
      }
      if (webpType === 'VP8 ' || webpType === 'VP8L') {
        // Simplified — skip detailed parsing
        return null;
      }
    }

    // BMP
    if (data[0] === 0x42 && data[1] === 0x4D) {
      return {
        width: data.readUInt32LE(18),
        height: Math.abs(data.readInt32LE(22))
      };
    }
  } catch (err) {
    // Silently fail — dimensions aren't critical
  }

  return null;
}

/**
 * Extract dimensions from JPEG data by scanning for SOF markers.
 */
function getJpegDimensions(data) {
  let offset = 2;

  while (offset < data.length - 1) {
    // Find next marker (0xFF)
    if (data[offset] !== 0xFF) {
      offset++;
      continue;
    }

    const marker = data[offset + 1];

    // SOS (Start of Scan) — no more metadata
    if (marker === 0xDA) break;

    // SOF markers (0xC0-0xCF, except 0xC4, 0xC8, 0xCC)
    const isSOF = (marker >= 0xC0 && marker <= 0xCF)
      && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;

    if (isSOF && offset + 9 < data.length) {
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7)
      };
    }

    // Skip to next marker
    const segmentLength = data.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }

  return null;
}

/**
 * Get MIME type from file extension.
 */
function getMimeType(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeMap = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff'
  };
  return mimeMap[ext] || 'application/octet-stream';
}
