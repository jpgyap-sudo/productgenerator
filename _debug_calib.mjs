const sortedImagesByPosition = [
  { name: 'img1.png', yPos: 100, uuid: 'UUID_001' },
  { name: 'img2.png', yPos: 350, uuid: 'UUID_002' },
  { name: 'img3.png', yPos: 600, uuid: 'UUID_003' },
  { name: 'img4.png', yPos: 850, uuid: 'UUID_004' },
  { name: 'img5.png', yPos: 1100, uuid: 'UUID_005' }
];
const dispimgMap = new Map([[2, 'UUID_001'], [4, 'UUID_003']]);

const calibrationPairs = [];
for (const [spreadsheetRow, uuid] of dispimgMap) {
  const matchingImg = sortedImagesByPosition.find(img => img.uuid === uuid);
  if (matchingImg && typeof matchingImg.yPos === 'number') {
    calibrationPairs.push({ yPos: matchingImg.yPos, row: spreadsheetRow });
  }
}
calibrationPairs.sort((a, b) => a.yPos - b.yPos);
console.log('Calibration pairs:', JSON.stringify(calibrationPairs));

const rowImageMap = new Map();
for (const img of sortedImagesByPosition) {
  if (img.uuid && dispimgMap.size > 0) {
    let directMatch = false;
    for (const [spreadsheetRow, uuid] of dispimgMap) {
      if (uuid === img.uuid) {
        rowImageMap.set(spreadsheetRow, img);
        console.log('DIRECT:', img.name, '-> row', spreadsheetRow);
        directMatch = true;
        break;
      }
    }
    if (directMatch) continue;
  }

  let estimatedRow = null;
  if (img.yPos <= calibrationPairs[0].yPos) {
    const before = sortedImagesByPosition.filter(i => i.yPos < calibrationPairs[0].yPos && i !== img).length;
    estimatedRow = calibrationPairs[0].row - (before + 1);
    if (estimatedRow < 1) estimatedRow = 1;
    console.log('BEFORE:', img.name, 'y=', img.yPos, 'before=', before, 'est=', estimatedRow);
  } else if (img.yPos >= calibrationPairs[calibrationPairs.length - 1].yPos) {
    const after = sortedImagesByPosition.filter(i => i.yPos > calibrationPairs[calibrationPairs.length - 1].yPos && i !== img).length;
    estimatedRow = calibrationPairs[calibrationPairs.length - 1].row + (after + 1);
    console.log('AFTER:', img.name, 'y=', img.yPos, 'after=', after, 'est=', estimatedRow);
  }

  if (estimatedRow !== null) {
    let finalRow = estimatedRow;
    if (rowImageMap.has(finalRow)) {
      for (let offset = 1; offset <= 10; offset++) {
        if (!rowImageMap.has(finalRow + offset)) { finalRow = finalRow + offset; break; }
        if (!rowImageMap.has(finalRow - offset) && (finalRow - offset) >= 1) { finalRow = finalRow - offset; break; }
      }
    }
    rowImageMap.set(finalRow, img);
    console.log('MAP:', img.name, '-> row', finalRow, '(est:', estimatedRow, ')');
  }
}

console.log('\nFinal map:');
for (const [row, img] of rowImageMap) console.log('  Row', row, '->', img.name);
