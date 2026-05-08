// ═══════════════════════════════════════════════════════════════════
//  api/agent/save-matched.js — POST /api/agent/save-matched
//  Persists matched product-image pairs to the matched_images table.
//
//  Called AFTER matching (Phase 2) and BEFORE submitting to queue.
//  This ensures every matched pair is recorded in the database for
//  future reference, history browsing, and workflow traceability.
//
//  Request body:
//    {
//      matches: [
//        {
//          productName: "Dining Chair HC-001",
//          productBrand: "Home Atelier",
//          productCode: "HACH-005R",
//          description: "Elegant upholstered dining chair...",
//          imageDataUrl: "data:image/jpeg;base64,...",
//          imageName: "chair_p03_18_xref80.jpeg",
//          imageWidth: 800,
//          imageHeight: 600,
//          imageSize: 123456,
//          matchScore: 80,
//          matchType: "code-in-filename",
//          sourceBatch: "agent-upload"  // or "batch-processor"
//        }
//      ],
//      sourcePdf: "catalog.pdf",
//      sourceZip: "images.zip"
//    }
//
//  Response:
//    {
//      success: true,
//      saved: 5,
//      ids: [1, 2, 3, 4, 5],
//      message: "Saved 5 matched image(s) to database"
//    }
// ═══════════════════════════════════════════════════════════════════

import { supabase, MATCHED_IMAGES_TABLE, BUCKET_NAME } from '../../lib/supabase.js';

/**
 * POST /api/agent/save-matched
 */
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { matches, sourcePdf, sourceZip } = req.body;

    if (!matches || !Array.isArray(matches) || matches.length === 0) {
      return res.status(400).json({ error: 'matches array is required' });
    }

    console.log(`[SAVE-MATCHED] Saving ${matches.length} matched pair(s) to database`);

    const savedIds = [];
    const errors = [];

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];

      if (!m.productName || !m.description) {
        errors.push({ index: i, error: 'productName and description are required' });
        continue;
      }

      let imageUrl = '';
      let imageDataUrl = m.imageDataUrl || '';

      // Upload image to Supabase Storage if we have a data URL
      if (imageDataUrl && imageDataUrl.startsWith('data:')) {
        try {
          const imageBuffer = dataUrlToBuffer(imageDataUrl);
          const mimeType = imageDataUrl.split(';')[0].split(':')[1] || 'image/jpeg';
          const ext = mimeType.split('/')[1] || 'jpg';
          const fileName = `matched-images/${Date.now()}_${i}_${(m.imageName || 'product').replace(/[^a-zA-Z0-9._-]/g, '_')}`;

          const { data: uploadData, error: uploadError } = await supabase.storage
            .from(BUCKET_NAME)
            .upload(fileName, imageBuffer, {
              contentType: mimeType,
              upsert: false
            });

          if (uploadError) {
            console.warn(`[SAVE-MATCHED] Storage upload failed for index ${i}: ${uploadError.message}`);
            // Continue with data URL only
          } else {
            const { data: publicUrlData } = supabase.storage
              .from(BUCKET_NAME)
              .getPublicUrl(fileName);
            imageUrl = publicUrlData?.publicUrl || '';
          }
        } catch (uploadErr) {
          console.warn(`[SAVE-MATCHED] Storage upload error for index ${i}: ${uploadErr.message}`);
          // Continue with data URL only
        }
      }

      // Insert into matched_images table
      const { data: inserted, error: insertError } = await supabase
        .from(MATCHED_IMAGES_TABLE)
        .insert({
          product_name: m.productName,
          product_brand: m.productBrand || '',
          product_code: m.productCode || '',
          description: m.description,
          image_url: imageUrl,
          image_data_url: imageDataUrl,
          image_name: m.imageName || '',
          image_width: m.imageWidth || 0,
          image_height: m.imageHeight || 0,
          image_size: m.imageSize || 0,
          match_score: m.matchScore || 0,
          match_type: m.matchType || '',
          source_batch: m.sourceBatch || 'agent-upload',
          source_pdf: sourcePdf || '',
          source_zip: sourceZip || '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (insertError) {
        console.error(`[SAVE-MATCHED] Insert failed for index ${i}: ${insertError.message}`);
        errors.push({ index: i, error: insertError.message });
      } else {
        savedIds.push(inserted.id);
        console.log(`[SAVE-MATCHED] Saved match #${inserted.id}: "${m.productName}" ↔ ${m.imageName || 'image'}`);
      }
    }

    const result = {
      success: savedIds.length > 0,
      saved: savedIds.length,
      ids: savedIds,
      errors: errors.length > 0 ? errors : undefined,
      message: `Saved ${savedIds.length} matched image(s) to database${errors.length > 0 ? ` (${errors.length} error(s))` : ''}`
    };

    console.log(`[SAVE-MATCHED] Done: ${savedIds.length} saved, ${errors.length} errors`);
    return res.json(result);

  } catch (err) {
    console.error('[SAVE-MATCHED] Error:', err);
    return res.status(500).json({
      error: 'Failed to save matched images',
      details: err.message
    });
  }
}

/**
 * Convert a data URL string to a Buffer.
 */
function dataUrlToBuffer(dataUrl) {
  const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}
