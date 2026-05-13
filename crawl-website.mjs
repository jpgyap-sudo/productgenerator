#!/usr/bin/env node
/**
 * Website Crawler - Check image preview issues
 * Crawls https://render.abcx124.xyz/completebatch
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

const TARGET_URL = 'https://render.abcx124.xyz/completebatch';

// Simple fetch function using native https
function fetchUrl(urlString) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
      },
      timeout: 30000,
    };

    const req = client.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          url: urlString,
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

// Extract image URLs from HTML
function extractImages(html, baseUrl) {
  const images = [];
  
  // Match img src attributes
  const imgSrcRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = imgSrcRegex.exec(html)) !== null) {
    const src = match[1];
    const fullUrl = src.startsWith('http') ? src : new URL(src, baseUrl).href;
    images.push({
      type: 'img',
      src: fullUrl,
      raw: match[0],
    });
  }
  
  // Match background-image in style attributes
  const bgImageRegex = /background-image:\s*url\(["']?([^"')]+)["']?\)/gi;
  while ((match = bgImageRegex.exec(html)) !== null) {
    const src = match[1];
    const fullUrl = src.startsWith('http') ? src : new URL(src, baseUrl).href;
    images.push({
      type: 'background-image',
      src: fullUrl,
      raw: match[0],
    });
  }
  
  return images;
}

// Extract data URLs from HTML
function extractDataUrls(html) {
  const dataUrls = [];
  const dataUrlRegex = /data:image\/[^;]+;base64,([^"')\s]+)/gi;
  let match;
  while ((match = dataUrlRegex.exec(html)) !== null) {
    dataUrls.push({
      type: 'data-url',
      preview: match[0].substring(0, 100) + '...',
      length: match[0].length,
    });
  }
  return dataUrls;
}

// Check if an image is accessible
async function checkImage(url) {
  try {
    const result = await fetchUrl(url);
    return {
      url,
      status: result.statusCode,
      contentType: result.headers['content-type'],
      contentLength: result.headers['content-length'],
      accessible: result.statusCode === 200,
    };
  } catch (err) {
    return {
      url,
      status: 'ERROR',
      error: err.message,
      accessible: false,
    };
  }
}

// Extract API endpoints or data sources
function extractApiEndpoints(html) {
  const endpoints = [];
  
  // Match fetch calls
  const fetchRegex = /fetch\(["']([^"']+)["']/g;
  let match;
  while ((match = fetchRegex.exec(html)) !== null) {
    endpoints.push({ type: 'fetch', url: match[1] });
  }
  
  // Match axios calls
  const axiosRegex = /axios\.(get|post|put|delete)\(["']([^"']+)["']/g;
  while ((match = axiosRegex.exec(html)) !== null) {
    endpoints.push({ type: 'axios', method: match[1], url: match[2] });
  }
  
  // Match API URLs in strings
  const apiRegex = /["'](\/api\/[^"']+)["']/g;
  while ((match = apiRegex.exec(html)) !== null) {
    endpoints.push({ type: 'api-path', url: match[1] });
  }
  
  return endpoints;
}

// Look for image-related issues
function analyzeImageIssues(html, images) {
  const issues = [];
  
  // Check for broken image indicators in HTML
  if (html.includes('alt=""') || html.includes("alt=''")) {
    issues.push('Some images have empty alt attributes');
  }
  
  // Check for placeholder images
  const placeholderPatterns = ['placeholder', 'dummy', 'no-image', 'not-found', 'default'];
  for (const pattern of placeholderPatterns) {
    if (html.toLowerCase().includes(pattern)) {
      issues.push(`Possible placeholder image found: "${pattern}"`);
    }
  }
  
  // Check for error messages
  const errorPatterns = ['error', 'failed', 'not found', '404', 'unauthorized', 'forbidden'];
  for (const pattern of errorPatterns) {
    const regex = new RegExp(`class="[^"]*${pattern}[^"]*"`, 'i');
    if (regex.test(html)) {
      issues.push(`Possible error indicator found: "${pattern}"`);
    }
  }
  
  // Check for Vue/React image binding patterns
  if (html.includes(':src=') || html.includes('v-bind:src=') || html.includes('{src}')) {
    issues.push('Dynamic image binding detected (:src or v-bind:src) - images may fail to load if data is missing');
  }
  
  // Check for srcset (responsive images)
  if (html.includes('srcset=')) {
    issues.push('Responsive images (srcset) detected - check all sizes are available');
  }
  
  return issues;
}

// Main crawl function
async function crawlWebsite() {
  console.log('='.repeat(80));
  console.log('WEBSITE CRAWLER - Image Preview Analysis');
  console.log('='.repeat(80));
  console.log(`\n🌐 Target URL: ${TARGET_URL}\n`);
  
  try {
    // Fetch the main page
    console.log('📥 Fetching main page...');
    const mainPage = await fetchUrl(TARGET_URL);
    console.log(`   Status: ${mainPage.statusCode}`);
    console.log(`   Content-Type: ${mainPage.headers['content-type'] || 'N/A'}`);
    console.log(`   Content-Length: ${mainPage.headers['content-length'] || mainPage.body.length} bytes\n`);
    
    // Extract and display images
    console.log('-'.repeat(80));
    console.log('🖼️  IMAGE ANALYSIS');
    console.log('-'.repeat(80));
    
    const images = extractImages(mainPage.body, TARGET_URL);
    console.log(`\n📊 Total images found: ${images.length}\n`);
    
    if (images.length === 0) {
      console.log('⚠️  NO IMAGES FOUND ON THE PAGE!');
      console.log('   This could explain why there are no image previews.\n');
    } else {
      // Check each image
      console.log('🔍 Checking image accessibility...\n');
      for (let i = 0; i < Math.min(images.length, 20); i++) {
        const img = images[i];
        console.log(`   [${i + 1}] Type: ${img.type}`);
        console.log(`       URL: ${img.src.substring(0, 100)}${img.src.length > 100 ? '...' : ''}`);
        
        // Only check external images, not data URLs
        if (!img.src.startsWith('data:')) {
          const check = await checkImage(img.src);
          console.log(`       Status: ${check.status}`);
          console.log(`       Content-Type: ${check.contentType || 'N/A'}`);
          console.log(`       Accessible: ${check.accessible ? '✅ YES' : '❌ NO'}`);
          if (check.error) {
            console.log(`       Error: ${check.error}`);
          }
        } else {
          console.log(`       Type: Data URL (embedded)`);
        }
        console.log('');
      }
    }
    
    // Check for data URLs
    console.log('-'.repeat(80));
    console.log('📦 DATA URL ANALYSIS (Base64 embedded images)');
    console.log('-'.repeat(80));
    const dataUrls = extractDataUrls(mainPage.body);
    console.log(`\n📊 Data URLs found: ${dataUrls.length}\n`);
    
    if (dataUrls.length > 0) {
      dataUrls.slice(0, 5).forEach((url, i) => {
        console.log(`   [${i + 1}] Length: ${url.length} bytes`);
        console.log(`       Preview: ${url.preview}\n`);
      });
    }
    
    // Extract API endpoints
    console.log('-'.repeat(80));
    console.log('🔗 API ENDPOINTS / DATA SOURCES');
    console.log('-'.repeat(80));
    const endpoints = extractApiEndpoints(mainPage.body);
    console.log(`\n📊 API endpoints found: ${endpoints.length}\n`);
    
    if (endpoints.length > 0) {
      endpoints.slice(0, 10).forEach((ep, i) => {
        console.log(`   [${i + 1}] ${ep.type}: ${ep.url}`);
      });
    }
    
    // Check for Vue/React app
    console.log('\n' + '-'.repeat(80));
    console.log('⚛️  FRAMEWORK DETECTION');
    console.log('-'.repeat(80));
    
    const frameworkChecks = [
      { name: 'Vue.js', pattern: /vue\.js|vue@|__VUE__/i },
      { name: 'React', pattern: /react|reactjs|data-reactroot/i },
      { name: 'Angular', pattern: /angular|ng-/i },
      { name: 'Svelte', pattern: /svelte/i },
    ];
    
    let detectedFramework = null;
    for (const fw of frameworkChecks) {
      if (fw.pattern.test(mainPage.body)) {
        detectedFramework = fw.name;
        console.log(`\n✅ ${fw.name} detected`);
        break;
      }
    }
    
    if (!detectedFramework) {
      console.log('\nℹ️  No major framework detected (may be vanilla JS or SSR)');
    }
    
    // Look for mount point
    const mountPointMatch = mainPage.body.match(/<div[^>]*id=["'](app|root|__nuxt|__next)["'][^>]*>/i);
    if (mountPointMatch) {
      console.log(`   Mount point: ${mountPointMatch[0]}`);
    }
    
    // Check for static image paths on VPS
    console.log('\n' + '-'.repeat(80));
    console.log('🖥️  VPS IMAGE PATH ANALYSIS');
    console.log('-'.repeat(80));
    
    const vpsPatterns = [
      { pattern: /\/uploads\//g, name: '/uploads/' },
      { pattern: /\/images\//g, name: '/images/' },
      { pattern: /\/static\//g, name: '/static/' },
      { pattern: /\/assets\//g, name: '/assets/' },
      { pattern: /\/api\/.*image/gi, name: 'API image endpoints' },
      { pattern: /render\.abcx124\.xyz/g, name: 'Domain references' },
    ];
    
    console.log('');
    for (const { pattern, name } of vpsPatterns) {
      const matches = mainPage.body.match(pattern);
      if (matches) {
        console.log(`   ✅ Found ${matches.length} references to "${name}"`);
      }
    }
    
    // Look for Supabase/storage references
    const supabaseMatch = mainPage.body.match(/supabase|supabase\.co|storage\.supabase/gi);
    if (supabaseMatch) {
      console.log(`   ✅ Found ${supabaseMatch.length} Supabase references`);
    }
    
    // Look for Google Drive references
    const driveMatch = mainPage.body.match(/drive\.google|googleusercontent|googleapis/gi);
    if (driveMatch) {
      console.log(`   ✅ Found ${driveMatch.length} Google Drive references`);
    }
    
    // Analyze issues
    console.log('\n' + '-'.repeat(80));
    console.log('⚠️  POTENTIAL ISSUES');
    console.log('-'.repeat(80));
    const issues = analyzeImageIssues(mainPage.body, images);
    
    if (issues.length === 0) {
      console.log('\n   ✅ No obvious image issues detected\n');
    } else {
      console.log('');
      issues.forEach((issue, i) => {
        console.log(`   ${i + 1}. ${issue}`);
      });
      console.log('');
    }
    
    // Check for empty gallery/image containers
    console.log('-'.repeat(80));
    console.log('📭 EMPTY CONTAINER CHECK');
    console.log('-'.repeat(80));
    
    const emptyContainerPatterns = [
      { pattern: /<div[^>]*class=["'][^"']*(?:gallery|image|preview)[^"']*["'][^>]*>\s*<\/div>/gi, name: 'Empty gallery/image divs' },
      { pattern: /<img[^>]*src=["']["']/gi, name: 'Empty src attributes' },
      { pattern: /<img[^>]*src=["']#\s*["']/gi, name: 'Hash-only src attributes' },
    ];
    
    console.log('');
    for (const { pattern, name } of emptyContainerPatterns) {
      const matches = mainPage.body.match(pattern);
      if (matches && matches.length > 0) {
        console.log(`   ⚠️  Found ${matches.length} ${name}`);
      }
    }
    
    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('📋 SUMMARY');
    console.log('='.repeat(80));
    console.log('');
    console.log(`   Total Images: ${images.length}`);
    console.log(`   Data URLs: ${dataUrls.length}`);
    console.log(`   API Endpoints: ${endpoints.length}`);
    console.log(`   Issues Found: ${issues.length}`);
    console.log('');
    
    if (images.length === 0 && dataUrls.length === 0) {
      console.log('   🔴 CRITICAL: No images detected on the page!');
      console.log('      - Page may be rendered client-side (SPA)');
      console.log('      - Images may load dynamically via JavaScript');
      console.log('      - Data may not be fetched from the server');
      console.log('');
      console.log('   💡 RECOMMENDATIONS:');
      console.log('      1. Check browser DevTools Network tab for image requests');
      console.log('      2. Verify API endpoints are returning image data');
      console.log('      3. Check if images are stored on VPS in /uploads/ directory');
      console.log('      4. Ensure proper CORS headers for external images');
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('CRAWL COMPLETE');
    console.log('='.repeat(80));
    
  } catch (err) {
    console.error('\n❌ CRAWL FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run the crawler
crawlWebsite();
