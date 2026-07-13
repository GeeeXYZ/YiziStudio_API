const fs = require('fs');
const iconv = require('iconv-lite');

let content = fs.readFileSync('database_schema.md', 'utf8');
const lines = content.split('\n');

for (let i = 0; i < 270; i++) {
  // If the line contains any CJK unified ideographs (which are the mojibake characters)
  if (/[\u4e00-\u9fa5]/.test(lines[i])) {
    const buf = iconv.encode(lines[i], 'gbk');
    const fixed = buf.toString('utf8');
    // If the fixed version has a lot of , maybe it was not meant to be decoded, but in this case the first half is all mojibake
    lines[i] = fixed;
  }
}

fs.writeFileSync('database_schema_fixed.md', lines.join('\n'));
console.log('Fixed completely. Check database_schema_fixed.md');
