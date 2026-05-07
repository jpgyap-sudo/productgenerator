import json

# ═══════════════════════════════════════════════════════════════════
#  Service Account Helper — adds a Google Drive service account
#  to a shared drive for the Product Image Studio app.
#
#  IMPORTANT: This is a TEMPLATE file.
#  Do NOT put real credentials here. Instead:
#    1. Copy this file to add_sa.local.py (gitignored)
#    2. Fill in your actual service account JSON
#    3. Run: python add_sa.local.py
#
#  The real service account JSON is stored in:
#    - .env (on VPS, synced via deploy.sh from vps-env.txt)
#    - GOOGLE_SERVICE_ACCOUNT_JSON env var
# ═══════════════════════════════════════════════════════════════════

sa = {
  "type": "service_account",
  "project_id": "YOUR_PROJECT_ID",
  "private_key_id": "YOUR_PRIVATE_KEY_ID",
  "private_key": "-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n",
  "client_email": "your-sa@your-project.iam.gserviceaccount.com",
  "client_id": "YOUR_CLIENT_ID",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/your-sa%40your-project.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
}

# ── Add this service account to a shared drive ──
# Replace SHARED_DRIVE_ID with the actual drive ID
SHARED_DRIVE_ID = "YOUR_SHARED_DRIVE_ID"

def add_sa_to_drive():
    print("=" * 60)
    print("  Service Account Helper")
    print("=" * 60)
    print(f"\n  Service Account Email: {sa['client_email']}")
    print(f"  Shared Drive ID:       {SHARED_DRIVE_ID}")
    print(f"\n  To add this service account to your shared drive:")
    print(f"  1. Go to https://drive.google.com")
    print(f"  2. Open the shared drive")
    print(f"  3. Click 'Manage members'")
    print(f"  4. Add '{sa['client_email']}' as 'Editor'")
    print(f"\n  Or use the Google Drive API:")
    print(f"  (See GOOGLE_DRIVE_SETUP.md for details)")
    print("=" * 60)

if __name__ == "__main__":
    add_sa_to_drive()
