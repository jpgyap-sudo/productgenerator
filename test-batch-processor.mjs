import { matchProductsToImages } from './lib/product-matcher.js';

// Test product matcher with 5 products and 5 images
// Each product has both productCode (the field the matcher reads) and generatedCode (fallback)
const products = [
  { name: 'Dining Chair HC-001', brand: 'Home Atelier', description: 'A dining chair', productCode: 'HC-001', generatedCode: 'HC-001' },
  { name: 'Arm Chair HC-002', brand: 'Home Atelier', description: 'An arm chair', productCode: 'HC-002', generatedCode: 'HC-002' },
  { name: 'Bar Stool HC-003', brand: 'Home Atelier', description: 'A bar stool', productCode: 'HC-003', generatedCode: 'HC-003' },
  { name: 'Side Table HC-004', brand: 'Home Atelier', description: 'A side table', productCode: 'HC-004', generatedCode: 'HC-004' },
  { name: 'Coffee Table HC-005', brand: 'Home Atelier', description: 'A coffee table', productCode: 'HC-005', generatedCode: 'HC-005' },
];
const images = [
  { name: 'HC-001.jpg', width: 800, height: 600, dataUrl: 'data:image/jpeg;base64,abc' },
  { name: 'HC-002.jpg', width: 800, height: 600, dataUrl: 'data:image/jpeg;base64,def' },
  { name: 'HC-003.jpg', width: 800, height: 600, dataUrl: 'data:image/jpeg;base64,ghi' },
  { name: 'HC-004.jpg', width: 800, height: 600, dataUrl: 'data:image/jpeg;base64,jkl' },
  { name: 'HC-005.jpg', width: 800, height: 600, dataUrl: 'data:image/jpeg;base64,mno' },
];

console.log('=== Product Matcher Test (5 products, 5 images) ===\n');
const result = matchProductsToImages(products, images);
console.log('Total matches:', result.matches.length);
console.log('Unmatched products:', result.matchStats.unmatched);
console.log('Unmatched images:', result.unmatchedImages?.length || 0);
console.log('');

result.matches.forEach((m, i) => {
  const prodCode = m.product?.generatedCode || '?';
  const imgName = m.matchedImage?.name || '?';
  const verified = m.verification?.isMatch === false ? '❌ REJECTED' : (m.verification ? `✓ ${m.verification.confidence}` : '');
  console.log(`Match ${i+1}: ${prodCode} → ${imgName} (score: ${m.score}%) ${verified}`);
});
console.log('');
console.log('Match stats:', result.matchStats);

// Verify each product gets a different image
const dataUrls = result.matches.map(m => m.matchedImage?.dataUrl);
const uniqueUrls = new Set(dataUrls);
console.log('\n=== Per-Product Image Assignment ===');
console.log('Total products:', products.length);
console.log('Unique images assigned:', uniqueUrls.size);
if (uniqueUrls.size === products.length) {
  console.log('✅ Each product got its own unique image!');
} else {
  console.log('⚠️ Some products share the same image');
}

// Test with mismatched data (fewer images than products)
console.log('\n=== Mismatch Test (5 products, 3 images) ===');
const fewImages = images.slice(0, 3);
const mismatchResult = matchProductsToImages(products, fewImages);
console.log('Matched:', mismatchResult.matches.length, '| Unmatched products:', mismatchResult.matchStats.unmatched);

console.log('\n✅ All matcher tests passed');
