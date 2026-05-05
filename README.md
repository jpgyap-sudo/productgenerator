# Product Image Studio

AI-powered product photography studio — generates 5 professional views (front, side, isometric, back, interior scene) from a single product image using [fal.ai](https://fal.ai) Nano Banana 2 model.

## Features

- **5 views per product** — front, side, isometric, back, and luxury interior scene
- **Parallel processing** — process up to 4 products simultaneously
- **Dark mode** — automatic system preference detection + manual toggle
- **Queue management** — reorder items, clear completed/all, per-item controls
- **Batch retry** — retry only failed views without re-processing everything
- **ZIP download** — download all renders with progress indicator
- **Image lightbox** — click any render for full-size preview
- **Supabase cloud persistence** — queue and images persist in the cloud across devices and page refreshes (optional, free tier available)
- **LocalStorage fallback** — works without Supabase, queue survives page refresh within the same browser
- **Environment variable API key** — set `FAL_API_KEY` in Vercel for zero-config deployments
- **Responsive layout** — works on desktop and mobile
- **Exponential backoff retry** — automatic retry with jitter for transient API errors
- **Content Security Policy** — CSP headers for enhanced security

## Deploy to Vercel

This project is configured for Vercel deployment.

### Option 1: API key via environment variable (recommended)

1. Push this repo to your GitHub account
2. Import the project in Vercel: `https://vercel.com/new`
3. Or connect to existing project: `https://vercel.com/jpgyap-4508s-projects/productgenerator`
4. **Set your fal.ai API key** in Vercel Dashboard:
   - Go to your project → **Settings** → **Environment Variables**
   - Add variable: **Name** = `FAL_API_KEY`, **Value** = your fal.ai key
   - Deploy the project
5. The API key is automatically injected at build time — no manual entry needed

### Option 2: Manual API key entry

If you don't set the environment variable, the API key input field will be available for manual entry (saved to localStorage).

## Usage

1. Enter a product description (color, material, style)
2. Upload product images (PNG/JPG/WEBP, max 10MB each)
3. Select resolution (0.5K–4K)
4. Adjust parallelism (1–4) for batch processing speed
5. Click **Start Queue**
6. Download individual renders or ZIP archives

> **Note:** If `FAL_API_KEY` is set as a Vercel environment variable, the API key field will be pre-filled and locked. No manual entry needed.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Main application (single-page app) |
| `vercel.json` | Vercel deployment configuration |
| `package.json` | Project metadata & build script |

## Tech Stack

- Vanilla JavaScript (no framework)
- [fal.ai](https://fal.ai) Nano Banana 2 API for AI image generation
- [JSZip](https://stuk.github.io/jszip/) for ZIP downloads
- Vercel for hosting
- [Supabase](https://supabase.com) for cloud persistence (optional)

## Supabase Setup (Required — for Cloud Persistence)

The app uses Supabase to persist your queue, images, and API key in the cloud, so they survive page refreshes and are accessible across any device.

### Step 1: Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign up (free tier: 500 MB database, 1 GB storage, no credit card required)
2. Create a new project
3. Once created, go to **Project Settings → API** and copy your **Project URL** and **anon public key**

### Step 2: Create the database tables

In the Supabase Dashboard, go to **SQL Editor** and run:

```sql
-- Create the queue table
CREATE TABLE product_queue (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'wait',
  description TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE product_queue ENABLE ROW LEVEL SECURITY;

-- Allow anonymous read/write (safe with anon key + RLS)
CREATE POLICY "anon_all" ON product_queue
  FOR ALL USING (true) WITH CHECK (true);

-- Create the app_config table for cross-device settings (API key, etc.)
CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_config" ON app_config
  FOR ALL USING (true) WITH CHECK (true);
```

> **⚠️ If you already created the table without the `description` column**, run this ALTER statement to add it:
> ```sql
> ALTER TABLE product_queue ADD COLUMN description TEXT DEFAULT '';
> ```

### Step 3: Create a storage bucket

1. Go to **Storage** in the Supabase Dashboard
2. Create a new bucket called `product_images` (make it **public**)
3. Go to **Storage → Policies** and add a policy to allow public access:

```sql
-- Allow public access to the bucket
CREATE POLICY "public_access" ON storage.objects
  FOR ALL USING (bucket_id = 'product_images') WITH CHECK (bucket_id = 'product_images');
```

### Step 4: Hardcode credentials in the app

The Supabase Project URL and anon key are hardcoded in [`index.html`](index.html:898) — they are public credentials designed to be embedded in client-side apps. Security is enforced via Row Level Security (RLS) policies, not by keeping the anon key secret.

To update the credentials for your own Supabase project, edit these lines in [`index.html`](index.html:898):

```js
const SUPA_URL = 'https://rbhfkwwnpmytmwueajje.supabase.co';
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIs...';
```

> **Note:** Once connected, the **fal API key** is automatically synced to the `app_config` table. Enter it once on any device and it will be available on all devices connected to the same Supabase project.
