// Draws the Prism logo (three stacked translucent rounded squares) and writes app/src-tauri/icons/icon.ico + icon.png.
// No dependencies: software rasteriser + minimal PNG encoder.  Run: node tools/make-icon.js
const fs = require('fs'), path = require('path'), zlib = require('zlib');

function render(size) {
  const SS = 4, N = size * SS, buf = new Float32Array(N * N * 4); // premultiplied RGBA
  const sq = [
    { rot: 0, k: 1.0, a: [142, 162, 255], b: [255, 158, 199], alpha: 0.9 },
    { rot: 30, k: 0.82, a: [255, 199, 154], b: [199, 155, 255], alpha: 0.8 },
    { rot: 60, k: 0.62, a: [127, 227, 208], b: [255, 255, 255], alpha: 0.88 },
  ];
  const half0 = N * 0.34;
  for (const s of sq) {
    const half = half0 * s.k, r = half * 0.42, bw = Math.max(1.5, N * 0.022), c = Math.cos(-s.rot * Math.PI / 180), sn = Math.sin(-s.rot * Math.PI / 180);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = x + 0.5 - N / 2, dy = y + 0.5 - N / 2, lx = dx * c - dy * sn, ly = dx * sn + dy * c;
      const qx = Math.abs(lx) - (half - r), qy = Math.abs(ly) - (half - r);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; // signed distance to rounded square
      if (d > 0) continue;
      const t = Math.min(1, Math.max(0, (lx + ly) / (4 * half) + 0.5));
      let col = [0, 1, 2].map((i) => s.a[i] + (s.b[i] - s.a[i]) * t), al = s.alpha;
      if (d > -bw) { col = [255, 255, 255]; al = 0.97; } // white rim
      const i = (y * N + x) * 4, ia = 1 - al;
      buf[i] = col[0] * al + buf[i] * ia; buf[i + 1] = col[1] * al + buf[i + 1] * ia; buf[i + 2] = col[2] * al + buf[i + 2] * ia; buf[i + 3] = al + buf[i + 3] * ia;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) { const p = ((y * SS + j) * N + x * SS + i) * 4; r += buf[p]; g += buf[p + 1]; b += buf[p + 2]; a += buf[p + 3]; }
    const o = (y * size + x) * 4, n = SS * SS;
    a /= n; out[o + 3] = Math.round(a * 255);
    if (a > 0) { out[o] = Math.round(r / n / a); out[o + 1] = Math.round(g / n / a); out[o + 2] = Math.round(b / n / a); }
  }
  return out;
}
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(rgba, size) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const sizes = [16, 32, 48, 64, 128, 256], pngs = sizes.map((s) => png(render(s), s));
const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let off = 6 + 16 * sizes.length; const dir = [];
sizes.forEach((s, i) => { const e = Buffer.alloc(16); e[0] = s % 256; e[1] = s % 256; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(off, 12); off += pngs[i].length; dir.push(e); });
const outDir = path.join(__dirname, '..', 'app', 'src-tauri', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([head, ...dir, ...pngs]));
fs.writeFileSync(path.join(outDir, 'icon.png'), png(render(512), 512));
console.log('icons written to', outDir);
