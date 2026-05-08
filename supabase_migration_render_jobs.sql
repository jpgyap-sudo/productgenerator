-- ═══════════════════════════════════════════════════════════════════
--  Migration: Render Jobs & Outputs tables
--
--  Run this in Supabase Dashboard SQL Editor.
--  Creates tables for tracking render jobs with QA audit trail.
-- ═══════════════════════════════════════════════════════════════════

-- Render jobs table
create table if not exists public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  product_name text,
  brand text,
  mode text not null default 'balanced',
  original_image_url text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Render outputs table (one per view per job)
create table if not exists public.render_outputs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.render_jobs(id) on delete cascade,
  view text not null,
  status text not null,
  image_url text,
  qa_score numeric,
  qa_decision text,
  qa_notes jsonb,
  attempts int not null default 1,
  created_at timestamptz not null default now()
);

-- Indexes for performance
create index if not exists idx_render_jobs_status on public.render_jobs(status);
create index if not exists idx_render_jobs_created_at on public.render_jobs(created_at desc);
create index if not exists idx_render_outputs_job_id on public.render_outputs(job_id);
