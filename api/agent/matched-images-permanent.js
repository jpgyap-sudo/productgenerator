import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ override: true });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const limit = Number(req.query.limit || 100);
  const search = String(req.query.search || '').trim();

  let query = supabase
    .from('matched_images')
    .select('*')
    .eq('category', 'Dining Chair')
    .order('saved_at', { ascending: false })
    .limit(limit);

  if (search) {
    query = query.or(`product_name.ilike.%${search}%,product_code.ilike.%${search}%,product_brand.ilike.%${search}%,image_name.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ success: true, records: data });
}
