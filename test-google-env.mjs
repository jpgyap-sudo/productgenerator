import 'dotenv/config';

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
console.log('Has value:', !!raw);
console.log('Length:', raw?.length);
if (raw) {
  console.log('First 100 chars:', JSON.stringify(raw.slice(0, 100)));
  console.log('Last 20 chars:', JSON.stringify(raw.slice(-20)));
  console.log('Contains \\n (escaped):', raw.includes('\\n'));
  console.log('Contains real newline:', raw.includes('\n'));
  try {
    const parsed = JSON.parse(raw);
    console.log('JSON.parse: OK');
    console.log('Has private_key:', !!parsed.private_key);
    console.log('Private key length:', parsed.private_key?.length);
    console.log('Has client_email:', !!parsed.client_email);
  } catch (e) {
    console.log('JSON.parse: FAIL -', e.message.slice(0, 200));
  }
}
