# Google Drive Auto-Upload — Setup Guide

This guide walks you through setting up Google Drive so that every time a product's renders complete, they are automatically uploaded to a folder named `HA01`, `HA02`, `HA03`, etc.

---

## Option A: OAuth2 (Recommended — uses your personal Drive storage)

This is the recommended approach. The app authenticates as **you**, so uploaded files use your personal Google Drive storage quota.

### Step 1: Enable Google Drive API

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Go to **APIs & Services → Library**
4. Search for **"Google Drive API"** and click **Enable**

### Step 2: Create OAuth 2.0 Credentials

1. In Google Cloud Console, go to **APIs & Services → Credentials**
2. Click **+ Create Credentials → OAuth client ID**
3. Application type: **Desktop application**
4. Name: `ProductGenerator Drive`
5. Click **Create**
6. Copy the **Client ID** and **Client Secret**

### Step 3: Generate a Refresh Token

Run the token generator script on your local machine:

```bash
# Set your credentials (Windows CMD)
set GOOGLE_OAUTH_CLIENT_ID=your_client_id.apps.googleusercontent.com
set GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxx

# Run the generator
node generate-google-token.mjs
```

1. Open the URL shown in the terminal
2. Sign in with your Google account
3. Click **Allow** to grant Drive.file access
4. Copy the redirect URL from your browser's address bar
5. The script will exchange it for tokens automatically

### Step 4: Set Environment Variables

Add these to your `.env` file on the VPS:

```
GOOGLE_DRIVE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_DRIVE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxx
GOOGLE_DRIVE_REFRESH_TOKEN=1//xxxxxxxxxxxxx
```

Then restart PM2:

```bash
pm2 restart product-image-studio --update-env
```

---

## Option B: Service Account (Limited — folder creation only)

> ⚠️ **Limitation**: Service accounts don't have their own Drive storage quota. They can create folders but **cannot upload files** unless using a Shared Drive or OAuth2.

### Step 1: Enable Google Drive API

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Go to **APIs & Services → Library**
4. Search for **"Google Drive API"** and click **Enable**

### Step 2: Create a Service Account

1. In Google Cloud Console, go to **APIs & Services → Credentials**
2. Click **+ Create Credentials → Service Account**
3. Give it a name (e.g. `product-generator-drive`)
4. Click **Create and Continue** (you can skip granting roles)
5. Click **Done**

### Step 3: Generate a JSON Key

1. In the **Service Accounts** list, click on the account you just created
2. Go to the **Keys** tab
3. Click **Add Key → Create New Key**
4. Choose **JSON** and click **Create**
5. The JSON key file will download automatically

### Step 4: Create a Parent Folder & Share with Service Account

1. Open [Google Drive](https://drive.google.com/)
2. Create a new folder (e.g. `ProductRenders`) in your **My Drive**
3. Right-click the folder → **Share**
4. Add the service account email (from the JSON key)
5. Set permission to **Editor**
6. Click **Share**

### Step 5: Set Environment Variables

```
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...",...}'
DRIVE_PARENT_FOLDER_ID='your-folder-id-here'
```

---

## How It Works

1. You upload source images and submit them for rendering
2. The app processes all views (front, back, left, right)
3. When all views are **done**, the server automatically:
   - Reads the next counter from Supabase (`drive_folder_counter`)
   - Creates a folder in Google Drive named `HA01` (then `HA02`, `HA03`, etc.)
   - Fetches each rendered image from Supabase Storage
   - Uploads all images into that folder
   - Increments the counter for the next product
4. The folder name and Drive link are stored in the queue item for reference

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Service Accounts do not have storage quota" | Switch to OAuth2 (Option A above) — service accounts can't upload files to regular folders |
| Folders not being created | Check that auth credentials are set correctly |
| "Insufficient permissions" error | Make sure you shared your Drive folder with the service account email as **Editor** |
| Counter not incrementing | Check that `drive_folder_counter` exists in Supabase `app_config` table |
| Images not uploading | Check that the rendered images exist in Supabase Storage (`product_images` bucket) |
