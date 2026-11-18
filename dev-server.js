// Tiny static server for previewing the Prism Cam UI in a browser (no Tauri): `npm run web` → http://localhost:5317
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, 'app', 'renderer');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.tflite': 'application/octet-stream', '.json': 'application/json' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(5317, '127.0.0.1', () => console.log('Prism Cam UI preview: http://localhost:5317'));
