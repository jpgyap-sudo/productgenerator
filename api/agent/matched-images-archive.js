// ═══════════════════════════════════════════════════════════════════
//  api/agent/matched-images-archive.js — POST /api/agent/matched-images/archive
//  Soft-deletes (archives) matched image records by setting archived_at.
//
//  Request body:
//    { ids: [1, 2, 3] }  — array of matched image IDs to archive
//
//  Response:
//    { success: true, archived: 3 }
// ═══════════════════════════════════════════════════════════════════

import { supabase, MATCHED_IMAGES_TABLE } from '../../lib/supabase.js';

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
    const { ids } = req.body || {};

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid ids array in request body' });
    }

    console.log(`[MATCHED-IMAGES-ARCHIVE] Archiving ${ids.length} record(s):`, ids);

    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from(MATCHED_IMAGES_TABLE)
      .update({ archived_at: now, updated_at: now })
      .in('id', ids)
      .select();

    if (error) {
      console.error('[MATCHED-IMAGES-ARCHIVE] Update error:', error.message);
      return res.status(500).json({ error: 'Failed to archive matched images', details: error.message });
    }

    console.log(`[MATCHED-IMAGES-ARCHIVE] Successfully archived ${data?.length || 0} record(s)`);

    return res.json({
      success: true,
      archived: data?.length || 0,
      records: data || []
    });

  } catch (err) {
    console.error('[MATCHED-IMAGES-ARCHIVE] Error:', err);
    return res.status(500).json({ error: 'Failed to archive matched images', details: err.message });
  }
}
