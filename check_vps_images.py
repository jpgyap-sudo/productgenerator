#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Verify VPS image accessibility
"""

import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

import urllib.request
import ssl

BASE_URL = 'https://render.abcx124.xyz'

# Image URLs from the API
IMAGE_URLS = [
    # Supabase storage
    "https://rbhfkwwnpmytmwueajje.supabase.co/storage/v1/object/public/product_images/queue/77_1778658769740.png",
    # VPS local paths
    "/vps-assets/renders/item-77/HA-801_img1_Front_view.png",
    "/vps-assets/renders/item-77/HA-801_img2_Side_view.jpg",
    "/vps-assets/renders/item-77/HA-801_img3_Isometric_view.jpg",
    "/vps-assets/renders/item-77/HA-801_img4_Interior_scene.jpg",
]

def check_url(url):
    """Check if URL is accessible"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
    
    # If relative URL, make absolute
    if url.startswith('/'):
        url = BASE_URL + url
    
    req = urllib.request.Request(url, headers=headers, method='HEAD')
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE
    
    try:
        with urllib.request.urlopen(req, timeout=15, context=ssl_context) as response:
            return {
                'status': response.status,
                'accessible': response.status == 200,
                'content_type': response.headers.get('Content-Type', 'N/A'),
            }
    except Exception as e:
        return {
            'status': 'ERROR',
            'accessible': False,
            'error': str(e),
        }

def main():
    print('=' * 80)
    print('VPS IMAGE ACCESSIBILITY CHECK')
    print('=' * 80)
    
    accessible_count = 0
    
    for url in IMAGE_URLS:
        result = check_url(url)
        status_icon = '✅' if result['accessible'] else '❌'
        
        print(f"\n{status_icon} {url}")
        print(f"   Status: {result['status']}")
        if 'content_type' in result:
            print(f"   Content-Type: {result['content_type']}")
        if 'error' in result:
            print(f"   Error: {result['error']}")
        
        if result['accessible']:
            accessible_count += 1
    
    print('\n' + '=' * 80)
    print(f'SUMMARY: {accessible_count}/{len(IMAGE_URLS)} images are accessible')
    print('=' * 80)
    
    if accessible_count == 0:
        print("""
🔴 CRITICAL ISSUE:
   Images exist in API response but are NOT accessible!
   
   This means:
   1. The images ARE stored on your VPS (good!)
   2. But the web server cannot serve them (bad!)
   
   LIKELY CAUSES:
   - Nginx/Apache not configured to serve /vps-assets/
   - Directory permissions are wrong
   - Files are in a different location
   
   VPS DIAGNOSIS STEPS:
   1. SSH to your VPS
   2. Check if files exist:
      ls -la /var/www/vps-assets/renders/item-77/
   3. Check nginx config:
      cat /etc/nginx/sites-enabled/default
   4. Ensure location block exists for /vps-assets/:
      location /vps-assets/ {
          alias /var/www/vps-assets/;
      }
""")
    else:
        print("""
✅ GOOD NEWS:
   Some images are accessible! The issue is likely with the FRONTEND.
   
   The HTML contains raw template literals like:
     - ${escHtml(result.imageUrl)}
     - ${thumbSrc}
   
   These are JavaScript template expressions that should be evaluated
   by the browser, but the page shows them as LITERAL TEXT.
   
   This means the HTML is being served BEFORE JavaScript renders it.
   The images exist, but the page isn't showing them correctly.
""")

if __name__ == '__main__':
    main()
