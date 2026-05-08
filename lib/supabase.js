// ═══════════════════════════════════════════════════════════════════
//  Shared Supabase Client — used by all serverless API endpoints
// ═══════════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

// Use service role key so the server can bypass RLS
// Provide ws polyfill for Node.js 20 (no native WebSocket)
const supabase = createClient(
  SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY || '',
  {
    auth: { persistSession: false },
    realtime: { transport: WebSocket }
  }
);

const QUEUE_TABLE = 'product_queue';
const RESULTS_TABLE = 'render_results';
const BUCKET_NAME = 'product_images';
const CONFIG_TABLE = 'app_config';
const MATCHED_IMAGES_TABLE = 'matched_images';

export { supabase, QUEUE_TABLE, RESULTS_TABLE, BUCKET_NAME, CONFIG_TABLE, MATCHED_IMAGES_TABLE };
