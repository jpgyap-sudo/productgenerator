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

// Count lines in HTML before script so we can report HTML line numbers
const htmlLinesBefore = html.slice(0, scriptStart + 8).split('\n').length - 1;
console.log('Script starts at HTML line:', htmlLinesBefore);

try {
  new Function(script);
  console.log('Script parses OK');
} catch (e) {
  console.log('Parse error:', e.message);
  const lines = script.split('\n');
  const match = e.message.match(/line (\d+)/);
  if (match) {
    const ln = parseInt(match[1]);
    console.log('\nContext (HTML lines ~' + (htmlLinesBefore + ln - 2) + '-' + (htmlLinesBefore + ln + 2) + '):');
    for (let i = Math.max(0, ln - 4); i < Math.min(lines.length, ln + 4); i++) {
      const marker = i + 1 === ln ? '>>>' : '   ';
      console.log(marker, (htmlLinesBefore + i + 1) + ':', lines[i]);
    }
  }
}

// Scan for duplicate var/let/const declarations (strict mode killers)
const declMap = {};
const declRe = /\b(var|let|const)\s+(\w+)\b/g;
let m;
while ((m = declRe.exec(script)) !== null) {
  const name = m[2];
  if (!declMap[name]) declMap[name] = [];
  const ln = script.slice(0, m.index).split('\n').length;
  declMap[name].push({ kind: m[1], line: htmlLinesBefore + ln });
}
const dupes = Object.entries(declMap).filter(([, arr]) => arr.length > 1);
if (dupes.length > 0) {
  console.log('\nDuplicate declarations (HTML line numbers):');
  dupes.forEach(([name, locs]) => {
    console.log(' ', name, '->', locs.map(l => `${l.kind} at HTML line ${l.line}`).join(', '));
  });
} else {
  console.log('No duplicate declarations found');
}

// Scan for common panel-hiding bugs: querySelectorAll('[id$="Panel"]')
const panelSelRe = /querySelectorAll\s*\(\s*['"][^'"]*Panel[^'"]*['"]\s*\)/g;
const panelMatches = [];
let pm;
while ((pm = panelSelRe.exec(script)) !== null) {
  const ln = script.slice(0, pm.index).split('\n').length;
  panelMatches.push({ selector: pm[0], htmlLine: htmlLinesBefore + ln });
}
if (panelMatches.length > 0) {
  console.log('\nPanel selector usages:');
  panelMatches.forEach(p => console.log(' HTML line', p.htmlLine, ':', p.selector));
}
