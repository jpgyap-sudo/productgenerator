-- Render Queue permanent cloud queue schema
-- Run this in Supabase Dashboard SQL Editor.

CREATE TABLE IF NOT EXISTS public.render_queue_batches (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  category TEXT DEFAULT '',
  source TEXT DEFAULT 'Image Canvas',
  status TEXT DEFAULT 'queued',
  priority TEXT DEFAULT 'medium',
  product_count INTEGER DEFAULT 0,
  total_images INTEGER DEFAULT 0,
  completed_images INTEGER DEFAULT 0,
  failed_images INTEGER DEFAULT 0,
  needs_repair_images INTEGER DEFAULT 0,
  estimated_time_left_seconds INTEGER DEFAULT 0,
  auto_delete_days INTEGER DEFAULT 7,
  auto_delete_at TIMESTAMPTZ,
  repair_review_location TEXT DEFAULT '/render/completed',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.render_queue_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id TEXT REFERENCES public.render_queue_batches(id) ON DELETE CASCADE,
  matched_image_id BIGINT,
  product_code TEXT DEFAULT '',
  product_name TEXT DEFAULT '',
  product_brand TEXT DEFAULT '',
  source_image_url TEXT DEFAULT '',
  render_type TEXT DEFAULT '',
  render_label TEXT DEFAULT '',
  status TEXT DEFAULT 'queued',
  priority TEXT DEFAULT 'medium',
  ai_model TEXT DEFAULT '',
  rendered_image_url TEXT DEFAULT '',
  estimated_cost NUMERIC DEFAULT 0,
  actual_cost NUMERIC DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  queue_wait_seconds INTEGER DEFAULT 0,
  consistency_score INTEGER DEFAULT 0,
  failure_reason TEXT DEFAULT '',
  error_message TEXT DEFAULT '',
  prompt_used TEXT DEFAULT '',
  retry_count INTEGER DEFAULT 0,
  repair_status TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_render_queue_batches_status ON public.render_queue_batches(status);
CREATE INDEX IF NOT EXISTS idx_render_queue_batches_created_at ON public.render_queue_batches(created_at);
CREATE INDEX IF NOT EXISTS idx_render_queue_batches_auto_delete ON public.render_queue_batches(auto_delete_at);
CREATE INDEX IF NOT EXISTS idx_render_queue_items_batch_id ON public.render_queue_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_render_queue_items_status ON public.render_queue_items(status);
CREATE INDEX IF NOT EXISTS idx_render_queue_items_matched_image ON public.render_queue_items(matched_image_id);

-- Optional stats view
CREATE OR REPLACE VIEW public.render_queue_stats AS
SELECT
  COUNT(*) FILTER (WHERE status IN ('queued', 'rendering', 'paused')) AS total_active_batches,
  COUNT(*) FILTER (WHERE status = 'rendering') AS rendering_batches,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed_batches,
  COUNT(*) FILTER (WHERE status = 'needs_repair') AS needs_repair_batches,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed_batches
FROM public.render_queue_batches;
