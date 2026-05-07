import 'dotenv/config';
import fs from 'fs';

async function testOpenAIEdits() {
  console.log('=== TESTING OPENAI /images/edits (actual endpoint used by code) ===');
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5';
  console.log('Model:', model);

  try {
    // Create a small test image (1x1 red pixel PNG)
    const testImageBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

    const formData = new FormData();
    const imageBlob = new Blob([testImageBuffer], { type: 'image/png' });
    formData.append('image', imageBlob, 'reference.png');
    formData.append('prompt', 'A professional product photo of a red apple on a white background');
    formData.append('model', model);
    formData.append('n', '1');
    formData.append('size', '1024x1024');

    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData
    });

    console.log('Status:', res.status, res.statusText);
    const data = await res.json();
    console.log('Response:', JSON.stringify(data, null, 2));

    if (res.ok) {
      console.log('✅ OpenAI /images/edits works with', model);
    } else {
      console.log('❌ OpenAI /images/edits failed');
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

async function testOpenAIGenerations() {
  console.log('\n=== TESTING OPENAI /images/generations with gpt-image-1.5 (JSON) ===');
  const apiKey = process.env.OPENAI_API_KEY;
  const model = 'gpt-image-1.5';

  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        prompt: 'A professional product photo of a red apple on a white background',
        n: 1,
        size: '1024x1024'
      })
    });

    console.log('Status:', res.status, res.statusText);
    const data = await res.json();
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

async function testGeminiRetry() {
  console.log('\n=== TESTING GEMINI again (checking if rate limit vs quota) ===');
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = 'gemini-3.1-flash-image-preview';

  try {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Generate an image of a red apple' }] }],
      generationConfig: { responseModalities: ['Image', 'Text'], temperature: 0.4 }
    };

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    console.log('Status:', res.status, res.statusText);
    const data = await res.json();
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

async function main() {
  await testOpenAIEdits();
  await testOpenAIGenerations();
  await testGeminiRetry();
}

main();
