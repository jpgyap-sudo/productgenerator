const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scriptStart = html.indexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>');

if (scriptStart === -1) {
  console.log('No script tag found');
  process.exit(1);
}

const script = html.slice(scriptStart + 8, scriptEnd);
console.log('Script length:', script.length, 'chars');

try {
  new Function(script);
  console.log('Script parses OK');
} catch (e) {
  console.log('Parse error:', e.message);
  // Show surrounding lines
  const lines = script.split('\n');
  const match = e.message.match(/line (\d+)/);
  if (match) {
    const ln = parseInt(match[1]);
    console.log('\nContext:');
    for (let i = Math.max(0, ln - 4); i < Math.min(lines.length, ln + 4); i++) {
      const marker = i + 1 === ln ? '>>>' : '   ';
      console.log(marker, (i + 1) + ':', lines[i]);
    }
  }
}

// Also scan for duplicate var/let/const declarations
const declMap = {};
const declRe = /\b(var|let|const)\s+(\w+)\b/g;
let m;
while ((m = declRe.exec(script)) !== null) {
  const name = m[2];
  if (!declMap[name]) declMap[name] = [];
  // Compute line number
  const ln = script.slice(0, m.index).split('\n').length;
  declMap[name].push({ kind: m[1], line: ln });
}
const dupes = Object.entries(declMap).filter(([, arr]) => arr.length > 1);
if (dupes.length > 0) {
  console.log('\nDuplicate declarations:');
  dupes.forEach(([name, locs]) => {
    console.log(' ', name, '->', locs.map(l => `${l.kind} at line ${l.line}`).join(', '));
  });
} else {
  console.log('No duplicate declarations found');
}
