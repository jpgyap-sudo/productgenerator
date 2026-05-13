#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
API Image Check - Verify API endpoints return proper image data
"""

import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

import urllib.request
import urllib.error
import ssl
import json

BASE_URL = 'https://render.abcx124.xyz'

def fetch_json(url, timeout=30):
    """Fetch and parse JSON from URL"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
    }
    
    req = urllib.request.Request(url, headers=headers)
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE
    
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as response:
            content = response.read().decode('utf-8', errors='ignore')
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return {'raw': content[:500]}
    except Exception as e:
        return {'error': str(e)}

def main():
    print('=' * 80)
    print('API IMAGE ENDPOINT ANALYSIS')
    print('=' * 80)
    
    # Check completed batches endpoint
    print('\n1. Checking /api/queue/completed ...')
    completed = fetch_json(f'{BASE_URL}/api/queue/completed')
    
    if 'error' in completed:
        print(f'   ERROR: {completed["error"]}')
    else:
        print(f'   Response type: {type(completed).__name__}')
        print(f'   Full response (first 2000 chars):')
        print(json.dumps(completed, indent=2)[:2000])
        
        if isinstance(completed, dict) and 'completedBatches' in completed:
            batches = completed['completedBatches']
            print(f'\n   Batches found: {len(batches)}')
            
            if batches:
                # Analyze first batch
                batch = batches[0]
                print(f'\n   First batch keys: {list(batch.keys()) if isinstance(batch, dict) else "N/A"}')
                
                if isinstance(batch, dict):
                    # Check for image-related fields
                    image_fields = [k for k in batch.keys() if any(x in k.lower() for x in ['image', 'url', 'src', 'thumb', 'photo', 'pic', 'file'])]
                    print(f'   Image-related fields: {image_fields}')
                    
                    for field in image_fields[:10]:
                        value = batch.get(field)
                        print(f'\n   {field}:')
                        if isinstance(value, str):
                            print(f'      Value: {value[:150]}{"..." if len(str(value)) > 150 else ""}')
                        elif isinstance(value, list) and value:
                            print(f'      Array with {len(value)} items')
                            if value and isinstance(value[0], str):
                                print(f'      First item: {value[0][:150]}...')
                        else:
                            print(f'      Type: {type(value).__name__}, Value: {str(value)[:100]}')
        elif isinstance(completed, dict):
            print(f'   Keys: {list(completed.keys())}')
    
    # Check monitor endpoint
    print('\n2. Checking /api/monitor ...')
    monitor = fetch_json(f'{BASE_URL}/api/monitor')
    
    if 'error' in monitor:
        print(f'   ERROR: {monitor["error"]}')
    else:
        print(f'   Response keys: {list(monitor.keys()) if isinstance(monitor, dict) else "N/A"}')
        
        if isinstance(monitor, dict):
            # Look for image data
            for key in list(monitor.keys())[:10]:
                value = monitor[key]
                if isinstance(value, str) and any(x in value.lower() for x in ['image', 'url', 'http']):
                    print(f'   {key}: {value[:80]}...')
    
    # Check render product endpoint
    print('\n3. Checking /api/render/product ...')
    render = fetch_json(f'{BASE_URL}/api/render/product')
    
    if 'error' in render:
        print(f'   ERROR: {render["error"]}')
    else:
        print(f'   Response type: {type(render).__name__}')
        if isinstance(render, dict):
            print(f'   Keys: {list(render.keys())}')
    
    # Analysis
    print('\n' + '=' * 80)
    print('ANALYSIS')
    print('=' * 80)
    
    print("""
ROOT CAUSE IDENTIFIED:
---------------------
The crawler found that the HTML contains raw JavaScript template literals like:
  - ${escHtml(result.imageUrl)}
  - ${escapeHtml(displayUrl)}
  - ${thumbSrc}
  - ${item.dataUrl}

These should be EVALUATED by the server but are being sent as LITERAL TEXT.

This means:
1. The server IS NOT properly rendering the React/Vue templates
2. Image URLs are not being substituted with actual values
3. The browser tries to load URLs like "${thumbSrc}" which don't exist

POSSIBLE CAUSES:
1. SSR (Server-Side Rendering) is not working correctly
2. Template engine is not processing files
3. The HTML files are being served as static files instead of being processed
4. Missing template compilation step

SOLUTIONS:
1. If using React SSR: Ensure the server renders components before sending HTML
2. If using EJS/Pug/Handlebars: Check template engine configuration
3. Verify build process is running before deployment
4. Check that files are not being served as static when they need processing
""")

if __name__ == '__main__':
    main()
