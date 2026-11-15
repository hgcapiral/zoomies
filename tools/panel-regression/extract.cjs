// Extract the test books' pages once, in the app's page order, so detection runs can be
// sharded across processes without each one loading the (1.7 GB) omnibus into memory.
//
//   node tools/panel-regression/extract.cjs <workDir>
//
// Writes <workDir>/pages/<book>/<index>.<ext> and <workDir>/manifest.json.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const books = require('./books.cjs');

const workDir = process.argv[2];
if (!workDir) throw new Error('usage: extract.cjs <workDir>');

const manifest = [];
for (const book of books) {
  const dir = path.join(workDir, 'pages', book.id);
  fs.mkdirSync(dir, { recursive: true });
  const zip = new AdmZip(book.path);
  // Same filter and order as electron/main.cjs (it sorts the extracted paths)
  const entries = zip.getEntries()
    .filter(e => !e.isDirectory && !path.basename(e.entryName).includes('__MACOSX') &&
      /\.(jpg|jpeg|png|webp)$/i.test(e.entryName))
    .sort((a, b) => a.entryName.replace(/\//g, '\\').localeCompare(b.entryName.replace(/\//g, '\\'), undefined, { numeric: true }));
  entries.forEach((entry, index) => {
    const file = path.join(dir, `${String(index).padStart(4, '0')}${path.extname(entry.entryName).toLowerCase()}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, entry.getData());
    manifest.push({ book: book.id, index, file, style: book.style, rtl: book.rtl });
  });
  console.log(`${book.id}: ${entries.length} pages`);
}
fs.writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify(manifest));
console.log(`${manifest.length} pages in total`);
