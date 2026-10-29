// popup.html -> popup-demo.html (paths from store/assets, fake chrome API first)
//   node store/assets/build-demo.js
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
let html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
html = html
  .replace(/(href|src)="(?!https?:|#)([^"]+)"/g, '$1="../../$2"')
  .replace('<script src="../../hls.min.js"></script>', '<script src="fake-chrome.js"></script>\n  <script src="../../hls.min.js"></script>');
fs.writeFileSync(path.join(__dirname, 'popup-demo.html'), html);
console.log('popup-demo.html written');
