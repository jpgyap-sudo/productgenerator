# Environment Variables — VPS Setup

Create `/var/www/productgenerator/.env` on the VPS with these values.

## Required

```env
# Database
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# AI Providers
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
DEEPSEEK_API_KEY=sk-...

# Optional: Stability AI (fallback image gen)
STABILITY_API_KEY=sk-...

# Google Drive (service account JSON, single-line stringified)
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}

# Server
NODE_ENV=production
PORT=3000

# Local storage paths (relative to project root)
VPS_ASSET_DIR=./vps-assets
VPS_PUBLIC_PREFIX=/vps-assets
```

## Notes

- `GOOGLE_SERVICE_ACCOUNT_JSON` must be the entire service account JSON on a single line
  (remove all newlines). Use `jq -c . service-account.json` to compact it.
- `SUPABASE_SERVICE_ROLE_KEY` is the `service_role` key (not `anon`). Found in
  Supabase → Project Settings → API.
- All keys from the old Vercel environment should transfer 1:1.

## Verifying on VPS

```bash
cd /var/www/productgenerator
node -e "import('./lib/supabase.js').then(m => console.log('supabase ok'))"
```

Or hit the monitor endpoint after starting the server:
```bash
curl http://localhost:3000/api/monitor | jq .
```

Expected output: all services show `"ok"` or a latency in ms.
