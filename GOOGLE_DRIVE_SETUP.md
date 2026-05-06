# Google Drive Auto-Upload — Setup Guide

This guide walks you through setting up Google Drive so that every time a product's 5 renders complete, they are automatically uploaded to a folder named `HA01`, `HA02`, `HA03`, etc.

---

## Step 1: Enable Google Drive API

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Go to **APIs & Services → Library**
4. Search for **"Google Drive API"** and click **Enable**

---

## Step 2: Create a Service Account

1. In Google Cloud Console, go to **APIs & Services → Credentials**
2. Click **+ Create Credentials → Service Account**
3. Give it a name (e.g. `product-generator-drive`)
4. Click **Create and Continue** (you can skip granting roles)
5. Click **Done**

---

## Step 3: Generate a JSON Key

1. In the **Service Accounts** list, click on the account you just created
2. Go to the **Keys** tab
3. Click **Add Key → Create New Key**
4. Choose **JSON** and click **Create**
5. The JSON key file will download automatically — **keep this safe**

The JSON looks like this:

```json
{
  "type": "service_account",
  "project_id": "your-project-id",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "product-generator-drive@your-project-id.iam.gserviceaccount.com",
  "client_id": "...",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  ...
}
```

---

## Step 4: Share Your Google Drive Root Folder

1. Open [Google Drive](https://drive.google.com/)
2. Navigate to your root/"My Drive" folder
3. Right-click → **Share**
4. Paste the **`client_email`** from the JSON key file (e.g. `product-generator-drive@your-project-id.iam.gserviceaccount.com`)
5. Set permission to **Editor**
6. Uncheck "Notify people" (optional)
7. Click **Share**

> ⚠️ The folders (HA01, HA02...) will be created at the root level of your Drive. If you want them inside a specific folder instead, share that subfolder with the service account instead.

---

## Step 5: Set the Environment Variable in Vercel

### Option A: Using Vercel CLI

```bash
# Install Vercel CLI if you haven't already
npm i -g vercel

# Login
vercel login

# Add the secret (paste the ENTIRE JSON as a single line)
vercel secrets add google-service-account-json '{"type":"service_account","project_id":"...",...}'
```

### Option B: Using Vercel Dashboard

1. Go to your project on [Vercel Dashboard](https://vercel.com/)
2. Go to **Settings → Environment Variables**
3. Add a new variable:
   - **Name**: `GOOGLE_SERVICE_ACCOUNT_JSON`
   - **Value**: Paste the entire JSON key content
   - **Environments**: Production (and Preview if desired)
4. Click **Save**

---

## Step 6: Update Supabase Database

Run the updated SQL script in your Supabase SQL Editor (Dashboard → SQL Editor):

1. Open [`supabase_setup.sql`](supabase_setup.sql)
2. Copy and execute the entire script
3. This will:
   - Add `drive_folder_id` and `drive_folder_name` columns to `product_queue`
   - Insert the initial `drive_folder_counter = 1` into `app_config`

---

## Step 7: Install Dependencies & Deploy

```bash
# Install the googleapis package
npm install

# Commit and push to your git repository
git add .
git commit -m "Add Google Drive auto-upload feature"
git push

# Deploy to Vercel
vercel --prod
```

---

## How It Works

1. You upload source images and submit them for rendering
2. The app processes all 5 views (front, back, left, right, top)
3. When all 5 views are **done**, the server automatically:
   - Reads the next counter from Supabase (`drive_folder_counter`)
   - Creates a folder in Google Drive named `HA01` (then `HA02`, `HA03`, etc.)
   - Fetches each rendered image from Supabase Storage
   - Uploads all 5 images into that folder
   - Increments the counter for the next product
4. The folder name and Drive link are stored in the queue item for reference

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Folders not being created | Check that `GOOGLE_SERVICE_ACCOUNT_JSON` is set correctly in Vercel |
| "Insufficient permissions" error | Make sure you shared your Drive folder with the service account email as **Editor** |
| Counter not incrementing | Check that `drive_folder_counter` exists in Supabase `app_config` table |
| Images not uploading | Check that the rendered images exist in Supabase Storage (`product_images` bucket) |
