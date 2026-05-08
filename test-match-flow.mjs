// Quick test: hit the match endpoint with real data
const BASE = 'http://localhost:3000';

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
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Test 1 failed:', err.message);
  }

  // Test 2: No match + visual search fallback
  console.log('\n=== Test 2: No match (should trigger visual search) ===');
  try {
    const res = await fetch(`${BASE}/api/agent/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        products: [{ productCode: 'LX-999', name: 'Luxury Chair', brand: 'MingRuiShi', description: 'A premium leather chair with gold accents' }],
        images: [
          { name: 'chair_01.jpg', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
          { name: 'table_01.jpg', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }
        ]
      })
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Test 2 failed:', err.message);
  }
}

main();
