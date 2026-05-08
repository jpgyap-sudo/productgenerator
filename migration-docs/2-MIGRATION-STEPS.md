# Migration Guide — Vercel → VPS (render.abcx124.xyz)

## What's Changing

| Before | After |
|---|---|
| `index.html` served by Vercel CDN | `index.html` served by nginx on VPS |
| API rewrites via `vercel.json` | nginx proxies `/api/*` directly to Express |
| Vercel security headers | nginx headers |
| Vercel domain | `https://render.abcx124.xyz` |

**The Express API and VPS logic are NOT changing** — they already run on the VPS.
This migration only moves the frontend delivery from Vercel to nginx.

---

## Pre-Migration Checklist

- [ ] SSH access to VPS at `104.248.225.250`
- [ ] nginx installed on VPS (`nginx -v`)
- [ ] SSL certificate for `render.abcx124.xyz` (Let's Encrypt or existing)
- [ ] Node.js + PM2 installed and `server.js` already running
- [ ] Confirm VPS Express is running: `curl http://localhost:3000/api/monitor`
- [ ] Backup current `.env` file

---

## Step 1 — Update server.js to serve index.html

The Express server needs to serve `index.html` for the root route.

Open `server.js` and add these lines **before** the API route registrations:

```javascript
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve frontend
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
```

> **Note:** `index.html` already uses relative API paths (`/api/...`) so no URL changes
> are needed in the frontend code.

---

## Step 2 — Install nginx (if not already installed)

```bash
sudo apt update
sudo apt install nginx -y
sudo systemctl enable nginx
```

---

## Step 3 — Configure nginx

Create the site config:

```bash
sudo nano /etc/nginx/sites-available/render.abcx124.xyz
```

Paste the config from `nginx.conf` (included in this ZIP).

Then enable it:

```bash
sudo ln -s /etc/nginx/sites-available/render.abcx124.xyz \
           /etc/nginx/sites-enabled/render.abcx124.xyz

# Remove default site if present
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t        # test config
sudo systemctl reload nginx
```

---

## Step 4 — SSL Certificate

If using Let's Encrypt (Certbot):

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d render.abcx124.xyz
```

Certbot will auto-update the nginx config with SSL settings and set up auto-renewal.

If you already have a certificate, update the `ssl_certificate` paths in `nginx.conf`.

---

## Step 5 — Deploy the latest code to VPS

```bash
# On your local machine (from project root):
npm run deploy

# OR manually:
rsync -avz --exclude node_modules --exclude .git \
  ./ root@104.248.225.250:/var/www/productgenerator/
```

---

## Step 6 — Restart Express with PM2

```bash
ssh root@104.248.225.250

cd /var/www/productgenerator
pm2 stop productgenerator   # or whatever your PM2 app name is
pm2 start ecosystem.config.js
pm2 save
```

Use the `ecosystem.config.js` included in this ZIP.

---

## Step 7 — Test

```bash
# From VPS — confirm Express is running
curl http://localhost:3000/api/monitor

# From browser — confirm full stack
https://render.abcx124.xyz/
https://render.abcx124.xyz/api/monitor
```

Expected: `/api/monitor` returns JSON with service statuses.

---

## Step 8 — Update fal.ai Webhook URL

If fal.ai async jobs are used, update the webhook URL in wherever you call
`fal.subscribe()` or set the webhook in fal.ai dashboard:

```
Old: https://productgenerator.vercel.app/api/fal-webhook
New: https://render.abcx124.xyz/api/fal-webhook
```

---

## Step 9 — Decommission Vercel (optional)

Once confirmed working on VPS:

```bash
# Remove Vercel project (optional — keeps your history)
vercel rm productgenerator

# Or just stop paying / let free tier idle
```

You can keep `vercel.json` in the repo for reference or delete it.

---

## Rollback Plan

If something goes wrong:
1. The Vercel deployment still exists until you delete it
2. Point DNS back to Vercel's nameservers
3. Fix the VPS issue, then re-point DNS to VPS

---

## Environment Variables on VPS

Make sure these are set in `/var/www/productgenerator/.env`:

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
STABILITY_API_KEY=
GOOGLE_SERVICE_ACCOUNT_JSON=
NODE_ENV=production
VPS_ASSET_DIR=./vps-assets
VPS_PUBLIC_PREFIX=/vps-assets
PORT=3000
```
