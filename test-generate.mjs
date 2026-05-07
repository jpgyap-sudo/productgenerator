import 'dotenv/config';

// Test OpenAI image generation
async function testOpenAI() {
  console.log('\n=== TESTING OPENAI ===');
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5';
    console.log('Model:', model);

    // Try the model listing first (we know this works)
    const listRes = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (listRes.ok) {
      const models = await listRes.json();
      const imageModels = models.data.filter(m => m.id.includes('image') || m.id.includes('dall'));
      console.log('Available image models:', imageModels.map(m => m.id));
    }

    // Try image generation with a test prompt
    const formData = new FormData();
    formData.append('prompt', 'a red apple on a white background');
    formData.append('model', model);
    formData.append('n', '1');
    formData.append('size', '1024x1024');

    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData
    });

    console.log('Status:', res.status, res.statusText);
    const data = await res.json();
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('OpenAI test error:', err.message);
  }
}

// Test Gemini image generation
async function testGemini() {
  console.log('\n=== TESTING GEMINI ===');
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const modelName = 'gemini-3.1-flash-image-preview';
    console.log('Model:', modelName);

    // Try model listing
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (listRes.ok) {
      const models = await listRes.json();
      const imageModels = models.models?.filter(m => m.name.includes('image') || m.name.includes('flash')) || [];
      console.log('Available image-capable models:', imageModels.map(m => m.name));
    }

    // Try generateContent with text-only (no image)
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
    console.error('Gemini test error:', err.message);
  }
}

async function testDalle3() {
  console.log('\n=== TESTING DALL-E 3 ===');
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: 'a red apple on a white background',
        n: 1,
        size: '1024x1024'
      })
    });
    console.log('Status:', res.status, res.statusText);
    const data = await res.json();
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('DALL-E 3 test error:', err.message);
  }
}

async function main() {
  await testOpenAI();
  await testGemini();
  await testDalle3();
}

main();
