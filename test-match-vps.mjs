// Test match endpoint on VPS
const BASE = 'https://productgenerator.superroo.com';

async function main() {
  // Test 1: Exact match
  console.log('=== Test 1: Exact match ===');
  try {
    const res = await fetch(`${BASE}/api/agent/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        products: [{ productCode: 'TC-001', name: 'Test Chair', brand: 'TestBrand', description: 'A test chair' }],
        images: [{ name: 'TC-001.jpg', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }]
      })
    });
    const data = await res.json();
    // Check that stripDataUrl removed dataUrl from matchedImage
    if (data.matches && data.matches.length > 0) {
      const match = data.matches[0];
      console.log('Match found:', match.matchedImage?.name);
      console.log('dataUrl present in matchedImage:', !!match.matchedImage?.dataUrl);
      console.log('galleryUrl present in matchedImage:', !!match.matchedImage?.galleryUrl);
      console.log('Expected: dataUrl=false, galleryUrl=true');
      console.log('PASS:', !match.matchedImage?.dataUrl && match.matchedImage?.name);
    } else {
      console.log('No matches returned');
    }
  } catch (err) {
    console.error('Test 1 failed:', err.message);
  }

  // Test 2: Process endpoint returns allImages with dataUrl and galleryUrl
  console.log('\n=== Test 2: Check process endpoint response shape ===');
  try {
    // We can't actually call process without files, but let's verify the match endpoint
    // returns the correct slim format
    const res = await fetch(`${BASE}/api/agent/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        products: [
          { productCode: 'TC-001', name: 'Test Chair', brand: 'TestBrand', description: 'A test chair' },
          { productCode: 'LX-999', name: 'Luxury Chair', brand: 'MingRuiShi', description: 'A premium leather chair' }
        ],
        images: [
          { name: 'TC-001.jpg', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
          { name: 'chair_01.jpg', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
          { name: 'table_01.jpg', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }
        ]
      })
    });
    const data = await res.json();
    console.log('Match count:', data.matches?.length);
    console.log('Match stats:', JSON.stringify(data.matchStats, null, 2));
    
    // Verify each match has slim format
    if (data.matches) {
      data.matches.forEach((m, i) => {
        console.log(`\nMatch ${i}:`);
        console.log('  productCode:', m.productCode);
        console.log('  matchedImage.name:', m.matchedImage?.name);
        console.log('  matchedImage.dataUrl:', m.matchedImage?.dataUrl ? 'PRESENT' : 'STRIPPED (correct)');
        console.log('  matchedImage.galleryUrl:', m.matchedImage?.galleryUrl ? 'PRESENT' : 'missing');
        console.log('  matchedImage.imageIndex:', m.matchedImage?.imageIndex);
        console.log('  score:', m.matchedImage?.score);
        console.log('  matchType:', m.matchedImage?.matchType);
      });
    }
  } catch (err) {
    console.error('Test 2 failed:', err.message);
  }
}

main();
