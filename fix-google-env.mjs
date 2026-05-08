import fs from 'fs';

const envPath = '.env';
let env = fs.readFileSync(envPath, 'utf8');

// Find the GOOGLE_SERVICE_ACCOUNT_JSON line - it may span multiple lines
const startMarker = 'GOOGLE_SERVICE_ACCOUNT_JSON=';
const startIdx = env.indexOf(startMarker);
if (startIdx === -1) {
  console.error('GOOGLE_SERVICE_ACCOUNT_JSON not found in .env');
  process.exit(1);
}

// Find the value - starts after the = and opening quote
let valStart = startIdx + startMarker.length;
let quote = env[valStart]; // ' or "
let valEnd;
if (quote === "'" || quote === '"') {
  // Find matching closing quote
  valEnd = env.indexOf(quote, valStart + 1);
  while (valEnd !== -1) {
    // Check if escaped
    if (env[valEnd - 1] === '\\') {
      valEnd = env.indexOf(quote, valEnd + 1);
      continue;
    }
    break;
  }
} else {
  // No quotes - value ends at newline
  valEnd = env.indexOf('\n', valStart);
  if (valEnd === -1) valEnd = env.length;
}

const rawValue = env.slice(valStart, valEnd + 1); // include closing quote
console.log('Found value, length:', rawValue.length);
console.log('Starts with:', JSON.stringify(rawValue.slice(0, 60)));
console.log('Ends with:', JSON.stringify(rawValue.slice(-20)));

// Check if the value has real newlines (multi-line)
const contentInside = rawValue.slice(1, -1); // strip quotes
const hasRealNewlines = contentInside.includes('\n');
console.log('Has real newlines:', hasRealNewlines);

if (hasRealNewlines) {
  // Replace real newlines with \n escape sequences
  const fixedContent = contentInside
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
  
  const newLine = `GOOGLE_SERVICE_ACCOUNT_JSON='${fixedContent}'`;
  const before = env.slice(0, startIdx);
  const after = env.slice(valEnd + 1);
  env = before + newLine + after;
  
  fs.writeFileSync(envPath, env);
  console.log('✅ Fixed GOOGLE_SERVICE_ACCOUNT_JSON - collapsed to single line');
  console.log('New length:', newLine.length);
} else {
  console.log('✅ Already single line, no fix needed');
}
