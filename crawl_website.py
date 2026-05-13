#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Website Crawler - Check image preview issues
Crawls https://render.abcx124.xyz/completebatch
"""

import sys
import io

# Force UTF-8 encoding for stdout
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

import urllib.request
import urllib.error
import ssl
import re
import json
from urllib.parse import urljoin, urlparse
from datetime import datetime

TARGET_URL = 'https://render.abcx124.xyz/completebatch'

def fetch_url(url, timeout=30):
    """Fetch URL content with proper headers"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
    }
    
    req = urllib.request.Request(url, headers=headers)
    
    # Create SSL context that doesn't verify certificates (for testing)
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE
    
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as response:
            content = response.read().decode('utf-8', errors='ignore')
            return {
                'status': response.status,
                'headers': dict(response.headers),
                'body': content,
                'url': url
            }
    except urllib.error.HTTPError as e:
        return {
            'status': e.code,
            'headers': dict(e.headers) if e.headers else {},
            'body': e.read().decode('utf-8', errors='ignore') if e.fp else '',
            'url': url,
            'error': str(e)
        }
    except Exception as e:
        return {
            'status': 'ERROR',
            'headers': {},
            'body': '',
            'url': url,
            'error': str(e)
        }

def extract_images(html, base_url):
    """Extract all image URLs from HTML"""
    images = []
    
    # Match img src attributes
    img_pattern = r'<img[^>]+src=["\']([^"\']+)["\'][^>]*>'
    for match in re.finditer(img_pattern, html, re.IGNORECASE):
        src = match.group(1)
        full_url = src if src.startswith('http') else urljoin(base_url, src)
        images.append({
            'type': 'img',
            'src': full_url,
            'raw': match.group(0)[:100]
        })
    
    # Match background-image in style attributes
    bg_pattern = r'background-image:\s*url\(["\']?([^"\')]+)["\']?\)'
    for match in re.finditer(bg_pattern, html, re.IGNORECASE):
        src = match.group(1)
        full_url = src if src.startswith('http') else urljoin(base_url, src)
        images.append({
            'type': 'background-image',
            'src': full_url,
            'raw': match.group(0)[:100]
        })
    
    return images

def extract_data_urls(html):
    """Extract base64 data URLs"""
    data_urls = []
    pattern = r'data:image/[^;]+;base64,([^"\')\s]+)'
    for match in re.finditer(pattern, html, re.IGNORECASE):
        full_data = match.group(0)
        data_urls.append({
            'preview': full_data[:100] + '...' if len(full_data) > 100 else full_data,
            'length': len(full_data)
        })
    return data_urls

def check_image(url):
    """Check if an image URL is accessible"""
    result = fetch_url(url, timeout=10)
    return {
        'url': url[:100] + '...' if len(url) > 100 else url,
        'status': result['status'],
        'content_type': result['headers'].get('Content-Type', 'N/A'),
        'content_length': result['headers'].get('Content-Length', 'N/A'),
        'accessible': result['status'] == 200
    }

def extract_api_endpoints(html):
    """Extract API endpoints from HTML"""
    endpoints = []
    
    # Match fetch calls
    fetch_pattern = r'fetch\(["\']([^"\']+)["\']'
    for match in re.finditer(fetch_pattern, html):
        endpoints.append({'type': 'fetch', 'url': match.group(1)})
    
    # Match API paths
    api_pattern = r'["\'](/api/[^"\']+)["\']'
    for match in re.finditer(api_pattern, html):
        endpoints.append({'type': 'api-path', 'url': match.group(1)})
    
    return endpoints

def analyze_image_issues(html, images):
    """Analyze potential image issues"""
    issues = []
    
    # Check for empty alt attributes
    if 'alt=""' in html or "alt=''" in html:
        issues.append('Some images have empty alt attributes')
    
    # Check for placeholder patterns
    placeholder_patterns = ['placeholder', 'dummy', 'no-image', 'not-found', 'default']
    for pattern in placeholder_patterns:
        if pattern in html.lower():
            issues.append(f'Possible placeholder indicator: "{pattern}"')
    
    # Check for Vue/React bindings
    if ':src=' in html or 'v-bind:src=' in html or '{src}' in html:
        issues.append('Dynamic image binding detected - images may fail if data is missing')
    
    return issues

def detect_framework(html):
    """Detect frontend framework"""
    frameworks = [
        ('Vue.js', r'vue\.js|vue@|__VUE__|v-if|v-for'),
        ('React', r'react|reactjs|data-reactroot|createElement'),
        ('Angular', r'angular|ng-'),
        ('Svelte', r'svelte'),
    ]
    
    for name, pattern in frameworks:
        if re.search(pattern, html, re.IGNORECASE):
            return name
    return None

def analyze_vps_paths(html):
    """Analyze VPS-specific paths"""
    findings = {}
    
    patterns = [
        (r'/uploads/', 'uploads references'),
        (r'/images/', 'images references'),
        (r'/static/', 'static references'),
        (r'/assets/', 'assets references'),
        (r'/api/.*image', 'API image endpoints'),
        (r'supabase|supabase\.co|storage\.supabase', 'Supabase references'),
        (r'drive\.google|googleusercontent', 'Google Drive references'),
        (r'render\.abcx124\.xyz', 'Domain references'),
    ]
    
    for pattern, name in patterns:
        matches = re.findall(pattern, html, re.IGNORECASE)
        if matches:
            findings[name] = len(matches)
    
    return findings

def main():
    print('=' * 80)
    print('WEBSITE CRAWLER - Image Preview Analysis')
    print('=' * 80)
    print(f'\n🌐 Target URL: {TARGET_URL}\n')
    
    # Fetch main page
    print('📥 Fetching main page...')
    main_page = fetch_url(TARGET_URL)
    print(f"   Status: {main_page['status']}")
    print(f"   Content-Type: {main_page['headers'].get('Content-Type', 'N/A')}")
    content_length = len(main_page['body'])
    print(f"   Content-Length: {content_length} bytes\n")
    
    if main_page['status'] != 200:
        print(f"❌ FAILED: HTTP {main_page['status']}")
        if 'error' in main_page:
            print(f"   Error: {main_page['error']}")
        return
    
    # Image analysis
    print('-' * 80)
    print('🖼️  IMAGE ANALYSIS')
    print('-' * 80)
    
    images = extract_images(main_page['body'], TARGET_URL)
    print(f'\n📊 Total images found: {len(images)}\n')
    
    if len(images) == 0:
        print('⚠️  NO IMAGES FOUND ON THE PAGE!')
        print('   This explains why there are no image previews.\n')
    else:
        print('🔍 Checking image accessibility...\n')
        for i, img in enumerate(images[:15]):  # Check first 15
            print(f"   [{i+1}] Type: {img['type']}")
            print(f"       URL: {img['src'][:100]}{'...' if len(img['src']) > 100 else ''}")
            
            if not img['src'].startswith('data:'):
                check = check_image(img['src'])
                print(f"       Status: {check['status']}")
                print(f"       Content-Type: {check['content_type']}")
                print(f"       Accessible: {'✅ YES' if check['accessible'] else '❌ NO'}")
            else:
                print(f"       Type: Data URL (embedded)")
            print()
    
    # Data URL analysis
    print('-' * 80)
    print('📦 DATA URL ANALYSIS (Base64 embedded images)')
    print('-' * 80)
    data_urls = extract_data_urls(main_page['body'])
    print(f'\n📊 Data URLs found: {len(data_urls)}\n')
    
    if data_urls:
        for i, url in enumerate(data_urls[:5]):
            print(f"   [{i+1}] Length: {url['length']} bytes")
            print(f"       Preview: {url['preview']}\n")
    
    # API endpoints
    print('-' * 80)
    print('🔗 API ENDPOINTS / DATA SOURCES')
    print('-' * 80)
    endpoints = extract_api_endpoints(main_page['body'])
    print(f'\n📊 API endpoints found: {len(endpoints)}\n')
    
    if endpoints:
        for i, ep in enumerate(endpoints[:10]):
            print(f"   [{i+1}] {ep['type']}: {ep['url']}")
    
    # Framework detection
    print('\n' + '-' * 80)
    print('⚛️  FRAMEWORK DETECTION')
    print('-' * 80)
    framework = detect_framework(main_page['body'])
    print(f'\n   Detected: {framework if framework else "None (vanilla JS or SSR)"}\n')
    
    # VPS path analysis
    print('-' * 80)
    print('🖥️  VPS IMAGE PATH ANALYSIS')
    print('-' * 80)
    vps_findings = analyze_vps_paths(main_page['body'])
    print()
    if vps_findings:
        for name, count in vps_findings.items():
            print(f'   ✅ Found {count} {name}')
    else:
        print('   ℹ️  No VPS-specific paths detected')
    
    # Issues analysis
    print('\n' + '-' * 80)
    print('⚠️  POTENTIAL ISSUES')
    print('-' * 80)
    issues = analyze_image_issues(main_page['body'], images)
    print()
    if issues:
        for i, issue in enumerate(issues, 1):
            print(f'   {i}. {issue}')
    else:
        print('   ✅ No obvious issues detected')
    
    # Check for empty containers
    print('\n' + '-' * 80)
    print('📭 EMPTY CONTAINER CHECK')
    print('-' * 80)
    
    empty_patterns = [
        (r'<div[^>]*class=["\'][^"\']*(?:gallery|image|preview)[^"\']*["\'][^>]*>\s*</div>', 'Empty gallery/image divs'),
        (r'<img[^>]*src=["\']["\']', 'Empty src attributes'),
        (r'<img[^>]*src=["\']#\s*["\']', 'Hash-only src attributes'),
    ]
    
    print()
    found_empty = False
    for pattern, name in empty_patterns:
        matches = re.findall(pattern, main_page['body'], re.IGNORECASE)
        if matches:
            print(f'   ⚠️  Found {len(matches)} {name}')
            found_empty = True
    
    if not found_empty:
        print('   ✅ No empty containers detected')
    
    # Check JavaScript data loading
    print('\n' + '-' * 80)
    print('📜 JAVASCRIPT DATA LOADING CHECK')
    print('-' * 80)
    
    js_patterns = [
        (r'fetch\(', 'fetch API calls'),
        (r'axios', 'axios calls'),
        (r'XMLHttpRequest', 'XHR requests'),
        (r'new Image\(', 'Image object creation'),
        (r'Image\(\)', 'Image constructor'),
        (r'lazy', 'Lazy loading'),
        (r'loading=["\']lazy["\']', 'Native lazy loading'),
    ]
    
    print()
    for pattern, name in js_patterns:
        if re.search(pattern, main_page['body'], re.IGNORECASE):
            print(f'   ✅ {name} detected')
    
    # Summary
    print('\n' + '=' * 80)
    print('📋 SUMMARY')
    print('=' * 80)
    print()
    print(f"   Total Images: {len(images)}")
    print(f"   Data URLs: {len(data_urls)}")
    print(f"   API Endpoints: {len(endpoints)}")
    print(f"   Issues Found: {len(issues)}")
    print()
    
    # Critical assessment
    if len(images) == 0 and len(data_urls) == 0:
        print('   🔴 CRITICAL: No images detected on the page!')
        print()
        print('   DIAGNOSIS:')
        print('   - The page appears to be a Single Page Application (SPA)')
        print('   - Images are likely loaded dynamically via JavaScript')
        print('   - The initial HTML does not contain rendered images')
        print()
        print('   💡 RECOMMENDATIONS:')
        print('   1. Check browser DevTools Network tab for image requests')
        print('   2. Verify API endpoints return proper image data')
        print('   3. Check VPS /uploads/ directory has images:')
        print('      - SSH to your VPS')
        print('      - Run: ls -la /var/www/uploads/')
        print('      - Or: ls -la /app/uploads/')
        print('   4. Check if images need authentication to access')
        print('   5. Verify image URLs are correct in database/API response')
    
    print()
    print('=' * 80)
    print('CRAWL COMPLETE')
    print(f'Time: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
    print('=' * 80)

if __name__ == '__main__':
    main()
