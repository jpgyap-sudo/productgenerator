// ═══════════════════════════════════════════════════════════════════
//  api/agent/submit.js — POST /api/agent/submit
//  Uploading Agent: Confirms extracted data and submits to render queue.
//  Uploads the selected image to Supabase Storage, creates a queue item.
// ═══════════════════════════════════════════════════════════════════

import { supabase, QUEUE_TABLE } from '../../lib/supabase.js';

/**
 * POST /api/agent/submit
 *
 * Request: application/json
 * {
 *   name: "Dining Chair HC-001",
 *   brand: "Home Atelier",
 *   description: "Elegant upholstered dining chair...",
 *   productCode: "HACH-005R",  // auto-generated: HA + originalCode + R
 *   imageDataUrl: "data:image/jpeg;base64,...",
 *   imageName: "chair_p03_18_xref80.jpeg",
 *   resolution: "1K"  // optional, default "1K"
 * }
 *
 * Response:
 * {
 *   success: true,
 *   itemId: 42,
 *   queuePosition: 1,
 *   message: "Item queued successfully"
 * }
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
    const { name, brand, description, productCode, imageDataUrl, imageName, resolution } = req.body;

    // Validate required fields
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Product name is required' });
    }

    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'Product description is required' });
    }

    if (!imageDataUrl) {
      return res.status(400).json({ error: 'Product image is required' });
    }

    console.log(`[AGENT-SUBMIT] Submitting: "${name}" (brand: ${brand || 'none'})`);

    // Step 1: Upload image to Supabase Storage
    console.log('[AGENT-SUBMIT] Uploading image to Supabase Storage...');

    const imageBuffer = dataUrlToBuffer(imageDataUrl);
    const mimeType = imageDataUrl.split(';')[0].split(':')[1] || 'image/jpeg';
    const ext = mimeType.split('/')[1] || 'jpg';
    const fileName = `agent-uploads/${Date.now()}_${(imageName || 'product').replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('product-images')
      .upload(fileName, imageBuffer, {
        contentType: mimeType,
        upsert: false
      });

    if (uploadError) {
      console.error('[AGENT-SUBMIT] Storage upload failed:', uploadError.message);
      return res.status(500).json({ error: `Failed to upload image: ${uploadError.message}` });
    }

    // Get public URL
    const { data: publicUrlData } = supabase.storage
      .from('product-images')
      .getPublicUrl(fileName);

    const imageUrl = publicUrlData?.publicUrl || '';

    console.log(`[AGENT-SUBMIT] Image uploaded: ${imageUrl}`);

    // Step 2: Create queue item in Supabase
    console.log('[AGENT-SUBMIT] Creating queue item...');

    const now = new Date().toISOString();
    const productName = name.trim();
    const productBrand = (brand || '').trim();
    const productDescription = description.trim();
    const productResolution = resolution || '1K';

    // Determine provider based on sub_text (default to openai for agent submissions)
    const provider = 'openai';

    // Use the generated product code as the folder name for Drive
    const generatedCode = (productCode || '').trim();

    const { data: queueItem, error: queueError } = await supabase
      .from(QUEUE_TABLE)
      .insert({
        name: productName,
        brand: productBrand,
        description: productDescription,
        image_url: imageUrl,
        resolution: productResolution,
        status: 'wait',
        sub_text: `Agent submitted: ${productName}${productBrand ? ` (${productBrand})` : ''}${generatedCode ? ` [${generatedCode}]` : ''}`,
        provider,
        drive_folder_name: generatedCode || null,  // Store generated code as folder name
        created_at: now,
        updated_at: now
      })
      .select()
      .single();

    if (queueError) {
      console.error('[AGENT-SUBMIT] Queue insert failed:', queueError.message);
      // Try to clean up the uploaded image
      await supabase.storage.from('product-images').remove([fileName]);
      return res.status(500).json({ error: `Failed to create queue item: ${queueError.message}` });
    }

    console.log(`[AGENT-SUBMIT] Queue item created: ID ${queueItem.id}`);

    // Step 3: Get queue position
    const { data: aheadCount } = await supabase
      .from(QUEUE_TABLE)
      .select('id', { count: 'exact', head: true })
      .in('status', ['wait', 'active'])
      .lt('id', queueItem.id);

    const queuePosition = (aheadCount?.length || 0) + 1;

    return res.json({
      success: true,
      itemId: queueItem.id,
      queuePosition,
      message: `"${productName}" has been queued for rendering (position #${queuePosition})`
    });

  } catch (err) {
    console.error('[AGENT-SUBMIT] Error:', err);
    return res.status(500).json({
      error: 'Failed to submit to queue',
      details: err.message
    });
  }
}

/**
 * Convert a data URL string to a Buffer.
 * Supports base64-encoded data URLs.
 */
function dataUrlToBuffer(dataUrl) {
  // Strip the data URL prefix (e.g., "data:image/jpeg;base64,")
  const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}
