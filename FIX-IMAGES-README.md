# Image Preview Fix Guide

## Problem Summary

Your website `https://render.abcx124.xyz/completebatch` is not showing image previews because:

1. **VPS images return 404** - Nginx is not properly serving the `/vps-assets/` directory
2. **Images exist on your VPS** - Found 57 batches with images stored locally

## Files Created

| File | Purpose |
|------|---------|
| `fix-image-preview.sh` | Main fix script - updates nginx config and permissions |
| `check-vps-images.sh` | Diagnostic script - checks current state of images |
| `deploy-image-fix.mjs` | Automated deployment via Tailscale |
| `crawl_website.py` | Website crawler that identified the issue |
| `check_vps_images.py` | Python script to verify image accessibility |

## Quick Fix (Choose One Method)

### Method 1: Automated Deployment (Recommended)

**Prerequisites:**
- Tailscale installed on both your local machine and VPS
- Your VPS Tailscale IP (run `tailscale ip -4` on VPS to get it)

**Steps:**

1. **Edit `deploy-image-fix.mjs`** and update the CONFIG section:
```javascript
const CONFIG = {
  sshHost: '100.64.x.x',  // ← REPLACE with your VPS Tailscale IP
  sshUser: 'root',         // or your VPS username
  sshIdentityFile: 'C:\\Users\\User\\.ssh\\id_rsa',
  vpsPath: '/root/productgenerator',
};
```

2. **Run the deployment:**
```bash
node deploy-image-fix.mjs
```

### Method 2: Manual Fix via SSH

If you don't have Tailscale, run these commands directly on your VPS:

1. **SSH into your VPS:**
```bash
ssh root@render.abcx124.xyz
```

2. **Navigate to project directory:**
```bash
cd /root/productgenerator
```

3. **Upload the fix script** (from your local machine):
```bash
scp fix-image-preview.sh root@render.abcx124.xyz:/root/productgenerator/
```

4. **Run the fix script:**
```bash
sudo bash fix-image-preview.sh
```

### Method 3: DigitalOcean Console

If you can't SSH, use the DigitalOcean web console:

1. Open DigitalOcean console for your droplet
2. Login as root
3. Run:
```bash
cd /root/productgenerator
# Copy-paste the contents of fix-image-preview.sh into a new file
nano fix-image-preview.sh
# Paste content, then Ctrl+X, Y, Enter to save
sudo bash fix-image-preview.sh
```

## What the Fix Does

The script performs these actions:

1. **Finds your vps-assets directory** - Searches common locations
2. **Fixes permissions** - Sets 755 permissions so nginx can read files
3. **Updates nginx config** - Adds proper `/vps-assets/` location block
4. **Tests nginx config** - Validates before applying
5. **Reloads nginx** - Applies the new configuration
6. **Verifies accessibility** - Tests that images are now served correctly

## Verification

After running the fix:

1. **Test in browser:**
   - Visit: `https://render.abcx124.xyz/completebatch`
   - Check if images now load

2. **Test via curl:**
```bash
curl -I https://render.abcx124.xyz/vps-assets/renders/item-77/HA-801_img1_Front_view.png
```
Expected: `HTTP/1.1 200 OK`

3. **Check nginx status:**
```bash
sudo systemctl status nginx
```

## Troubleshooting

### Images still not showing

1. **Check browser DevTools:**
   - Press F12 → Network tab
   - Reload page
   - Look for image requests (red = error)

2. **Check nginx error logs:**
```bash
sudo tail -50 /var/log/nginx/error.log
```

3. **Run diagnostic script:**
```bash
bash check-vps-images.sh
```

### Permission denied errors

If you see permission errors, the fix script should handle this, but manually:
```bash
sudo chown -R www-data:www-data /root/productgenerator/vps-assets
sudo chmod -R 755 /root/productgenerator/vps-assets
```

### Nginx config test fails

The fix script creates a backup. To restore:
```bash
sudo cp /etc/nginx/sites-available/render.abcx124.xyz.backup.* /etc/nginx/sites-available/render.abcx124.xyz
sudo nginx -t && sudo systemctl reload nginx
```

## Image Locations

Your images are stored in two places:

1. **Supabase Storage** (accessible ✅):
   - URL: `https://rbhfkwwnpmytmwueajje.supabase.co/storage/v1/object/public/product_images/queue/...`
   - Working fine

2. **VPS Local Storage** (was broken ❌ - now fixed):
   - Path: `/root/productgenerator/vps-assets/renders/item-{id}/`
   - URL: `https://render.abcx124.xyz/vps-assets/renders/item-{id}/...`
   - Fixed by nginx configuration

## Support

If the fix doesn't work:
1. Run `bash check-vps-images.sh` and share the output
2. Check `curl -I` output for specific image URLs
3. Review nginx error logs
