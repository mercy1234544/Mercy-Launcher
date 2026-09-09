// Copies src/assets (app icon) into dist/assets so packaged builds can find
// it at runtime. package.json's "files" only bundles dist/**/*, not
// src/**/*, so main.ts's Tray/BrowserWindow icon paths must resolve inside
// dist/ — see src/main/main.ts.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src', 'assets');
const dest = path.join(root, 'dist', 'assets');

fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
console.log('copy-assets: copied src/assets -> dist/assets');
