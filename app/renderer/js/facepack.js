// Built-in face stickers (drawn as SVG here, turned into PNG pictures when used — no picture files to ship).
//   id · label · where it sits (facedefs FACE_PTS) · width as a share of the face width · up / down shift as a share
//   of the sticker's own height (negative = up) · svg
import { T } from './core.js';

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;
const heart = (x, y, r) => `M${x} ${y + r * 0.9}C${x - r * 1.6} ${y - r * 0.2} ${x - r * 0.7} ${y - r * 1.3} ${x} ${y - r * 0.45}C${x + r * 0.7} ${y - r * 1.3} ${x + r * 1.6} ${y - r * 0.2} ${x} ${y + r * 0.9}Z`;
const star = (x, y, r, k = 0.45) => 'M' + Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? r * k : r; return `${(x + Math.cos(a) * q).toFixed(1)} ${(y + Math.sin(a) * q).toFixed(1)}`; }).join('L') + 'Z';

export const FACE_PACK = () => [
  ['sun', T`แว่นกันแดด`, 'eyes', 1.02, 0, svg(600, 220, `<defs><linearGradient id="l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3f5c"/><stop offset="1" stop-color="#0c0d16"/></linearGradient></defs>
    <path d="M40 60 Q40 40 70 40 H250 Q280 40 275 70 L262 150 Q255 190 210 190 H110 Q60 190 52 150Z M560 60 Q560 40 530 40 H350 Q320 40 325 70 L338 150 Q345 190 390 190 H490 Q540 190 548 150Z" fill="url(#l)" stroke="#111" stroke-width="10"/>
    <path d="M275 72 Q300 55 325 72" fill="none" stroke="#111" stroke-width="14"/><path d="M8 60 H42 M558 60 H592" stroke="#111" stroke-width="14" stroke-linecap="round"/>
    <path d="M80 70 L150 70 L95 140Z M380 70 L450 70 L395 140Z" fill="#fff" opacity=".18"/>`)],
  ['hearts', T`แว่นหัวใจ`, 'eyes', 1.05, 0, svg(600, 240, `<path d="${heart(165, 120, 95)}" fill="#ff4f86" stroke="#c8175a" stroke-width="12"/><path d="${heart(435, 120, 95)}" fill="#ff4f86" stroke="#c8175a" stroke-width="12"/>
    <path d="M255 92 Q300 70 345 92" fill="none" stroke="#c8175a" stroke-width="14" stroke-linecap="round"/><path d="M20 80 H70 M530 80 H580" stroke="#c8175a" stroke-width="14" stroke-linecap="round"/>
    <ellipse cx="120" cy="95" rx="24" ry="14" fill="#fff" opacity=".45" transform="rotate(-30 120 95)"/><ellipse cx="390" cy="95" rx="24" ry="14" fill="#fff" opacity=".45" transform="rotate(-30 390 95)"/>`)],
  ['round', T`แว่นกลมสีทอง`, 'eyes', 1.0, 0, svg(600, 220, `<circle cx="165" cy="110" r="88" fill="#bfe3ff" fill-opacity=".18" stroke="#d4a937" stroke-width="12"/><circle cx="435" cy="110" r="88" fill="#bfe3ff" fill-opacity=".18" stroke="#d4a937" stroke-width="12"/>
    <path d="M253 100 Q300 72 347 100" fill="none" stroke="#d4a937" stroke-width="10"/><path d="M77 95 H12 M523 95 H588" stroke="#d4a937" stroke-width="10" stroke-linecap="round"/>
    <path d="M110 70 Q130 50 160 48" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" opacity=".6"/><path d="M380 70 Q400 50 430 48" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" opacity=".6"/>`)],
  ['party', T`แว่นดาวปาร์ตี้`, 'eyes', 1.1, 0, svg(640, 260, `<path d="${star(175, 130, 120)}" fill="#ffd84d" stroke="#ff7a00" stroke-width="10" stroke-linejoin="round"/><path d="${star(465, 130, 120)}" fill="#ffd84d" stroke="#ff7a00" stroke-width="10" stroke-linejoin="round"/>
    <circle cx="175" cy="135" r="46" fill="#7b5cff" opacity=".85"/><circle cx="465" cy="135" r="46" fill="#7b5cff" opacity=".85"/><path d="M270 110 Q320 90 370 110" fill="none" stroke="#ff7a00" stroke-width="12" stroke-linecap="round"/>`)],
  ['pixel', T`แว่นพิกเซลสุดเท่`, 'eyes', 1.05, 0, svg(600, 160, `<g fill="#000"><rect x="20" y="20" width="560" height="30"/><rect x="60" y="50" width="200" height="60"/><rect x="340" y="50" width="200" height="60"/><rect x="90" y="110" width="140" height="30"/><rect x="370" y="110" width="140" height="30"/><rect x="260" y="50" width="80" height="25"/></g>
    <g fill="#fff"><rect x="90" y="60" width="30" height="20"/><rect x="120" y="80" width="30" height="20"/><rect x="370" y="60" width="30" height="20"/><rect x="400" y="80" width="30" height="20"/></g>`)],
  ['mask', T`หน้ากากงานเต้นรำ`, 'eyes', 1.2, -0.05, svg(700, 300, `<defs><linearGradient id="m" x1="0" x2="1"><stop offset="0" stop-color="#6a3cff"/><stop offset="1" stop-color="#d23cff"/></linearGradient></defs>
    <path d="M350 90 C420 30 560 20 660 70 C680 150 620 250 520 250 C440 250 400 200 350 190 C300 200 260 250 180 250 C80 250 20 150 40 70 C140 20 280 30 350 90Z" fill="url(#m)" stroke="#ffd66b" stroke-width="8"/>
    <path d="M110 130 C150 100 230 100 270 140 C230 175 150 175 110 130Z M590 130 C550 100 470 100 430 140 C470 175 550 175 590 130Z" fill="#000" opacity=".9"/>
    <path d="M40 70 C10 20 30 0 60 10 M660 70 C690 20 670 0 640 10" fill="none" stroke="#ffd66b" stroke-width="8"/><circle cx="350" cy="120" r="14" fill="#ffd66b"/>`)],
  ['tophat', T`หมวกทรงสูง`, 'top', 0.95, -0.4, svg(400, 360, `<ellipse cx="200" cy="320" rx="190" ry="34" fill="#15151d"/><path d="M80 60 Q80 30 110 30 H290 Q320 30 320 60 V315 H80Z" fill="#20202b"/>
    <rect x="80" y="240" width="240" height="46" fill="#d33a4c"/><path d="M110 40 V300" stroke="#fff" stroke-opacity=".08" stroke-width="22"/><ellipse cx="200" cy="318" rx="120" ry="10" fill="#000" opacity=".35"/>`)],
  ['crown', T`มงกุฎ`, 'top', 0.85, -0.32, svg(400, 260, `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe27a"/><stop offset="1" stop-color="#e0a21b"/></linearGradient></defs>
    <path d="M20 230 L40 70 L120 150 L200 30 L280 150 L360 70 L380 230Z" fill="url(#g)" stroke="#b77b0c" stroke-width="10" stroke-linejoin="round"/>
    <rect x="30" y="200" width="340" height="40" rx="10" fill="#e9b02c" stroke="#b77b0c" stroke-width="8"/><circle cx="200" cy="140" r="22" fill="#ff3d6e"/><circle cx="100" cy="190" r="14" fill="#3dc8ff"/><circle cx="300" cy="190" r="14" fill="#3dc8ff"/>
    <circle cx="40" cy="70" r="16" fill="#fff4c2"/><circle cx="200" cy="30" r="16" fill="#fff4c2"/><circle cx="360" cy="70" r="16" fill="#fff4c2"/>`)],
  ['partyhat', T`หมวกปาร์ตี้`, 'top', 0.55, -0.42, svg(300, 400, `<defs><clipPath id="c"><path d="M150 40 L270 370 Q150 400 30 370Z"/></clipPath></defs>
    <g clip-path="url(#c)"><rect width="300" height="400" fill="#7b5cff"/><path d="M-40 140 L340 40 V100 L-40 200Z M-40 260 L340 160 V220 L-40 320Z M-40 380 L340 280 V340 L-40 440Z" fill="#ffd84d"/></g>
    <circle cx="150" cy="38" r="34" fill="#ff5c9a"/><path d="M30 370 Q150 400 270 370" fill="none" stroke="#ff5c9a" stroke-width="14" stroke-linecap="round"/>`)],
  ['catears', T`หูแมว`, 'top', 1.1, -0.22, svg(600, 260, `<path d="M40 250 L90 20 L250 190Z M560 250 L510 20 L350 190Z" fill="#2b2233"/><path d="M85 215 L108 75 L205 180Z M515 215 L492 75 L395 180Z" fill="#ff9ab6"/>`)],
  ['bunny', T`หูกระต่าย`, 'top', 0.9, -0.44, svg(500, 520, `<ellipse cx="160" cy="250" rx="70" ry="230" fill="#fff" stroke="#e4d8ee" stroke-width="10" transform="rotate(-10 160 250)"/><ellipse cx="340" cy="250" rx="70" ry="230" fill="#fff" stroke="#e4d8ee" stroke-width="10" transform="rotate(10 340 250)"/>
    <ellipse cx="160" cy="260" rx="34" ry="180" fill="#ffb3c8" transform="rotate(-10 160 260)"/><ellipse cx="340" cy="260" rx="34" ry="180" fill="#ffb3c8" transform="rotate(10 340 260)"/>`)],
  ['halo', T`วงแหวนนางฟ้า`, 'top', 0.9, -1.4, svg(500, 160, `<defs><filter id="b"><feGaussianBlur stdDeviation="9"/></filter></defs><ellipse cx="250" cy="80" rx="210" ry="48" fill="none" stroke="#ffe066" stroke-width="30" filter="url(#b)"/><ellipse cx="250" cy="80" rx="210" ry="48" fill="none" stroke="#fff6b8" stroke-width="16"/>`)],
  ['horns', T`เขาปีศาจ`, 'top', 1.0, -0.2, svg(600, 240, `<defs><linearGradient id="h" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#9c0f24"/><stop offset="1" stop-color="#ff3b4f"/></linearGradient></defs>
    <path d="M80 235 C60 150 70 60 20 10 C140 40 200 140 200 235Z M520 235 C540 150 530 60 580 10 C460 40 400 140 400 235Z" fill="url(#h)" stroke="#6d0616" stroke-width="8"/>`)],
  ['bow', T`โบว์`, 'top', 0.7, -0.3, svg(400, 240, `<path d="M200 120 C150 40 40 10 30 70 C20 130 40 220 200 120Z M200 120 C250 40 360 10 370 70 C380 130 360 220 200 120Z" fill="#ff5c9a" stroke="#c81e63" stroke-width="10" stroke-linejoin="round"/>
    <ellipse cx="200" cy="120" rx="40" ry="46" fill="#ff7fb0" stroke="#c81e63" stroke-width="10"/><path d="M70 70 C90 60 120 70 140 90" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="10" stroke-linecap="round"/>`)],
  ['stache', T`หนวด`, 'under', 0.55, 0.08, svg(400, 140, `<path d="M200 50 C170 20 120 20 90 50 C60 80 30 90 5 70 C20 120 90 135 140 110 C170 95 190 80 200 70 C210 80 230 95 260 110 C310 135 380 120 395 70 C370 90 340 80 310 50 C280 20 230 20 200 50Z" fill="#3a2418"/>`)],
  ['clown', T`จมูกตัวตลก`, 'nose', 0.26, 0, svg(200, 200, `<defs><radialGradient id="r" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="#ff8a8a"/><stop offset=".5" stop-color="#ee1d2c"/><stop offset="1" stop-color="#8d0712"/></radialGradient></defs><circle cx="100" cy="100" r="92" fill="url(#r)"/><ellipse cx="70" cy="62" rx="24" ry="16" fill="#fff" opacity=".6"/>`)],
  ['pig', T`จมูกหมู`, 'nose', 0.3, 0.05, svg(220, 170, `<ellipse cx="110" cy="85" rx="104" ry="78" fill="#ffa3b8" stroke="#e5718d" stroke-width="8"/><ellipse cx="75" cy="88" rx="18" ry="30" fill="#b84a66"/><ellipse cx="145" cy="88" rx="18" ry="30" fill="#b84a66"/>`)],
];

const cache = new Map();
// → PNG data URL (and the picture's size) of a pack sticker
export function packPng(id) {
  if (cache.has(id)) return cache.get(id);
  const it = FACE_PACK().find((x) => x[0] === id); if (!it) return Promise.resolve(null);
  const p = new Promise((res) => {
    const im = new Image();
    im.onload = () => {
      const k = 900 / Math.max(im.naturalWidth, im.naturalHeight), c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      res({ url: c.toDataURL('image/png'), w: c.width, h: c.height });
    };
    im.onerror = () => res(null);
    im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(it[5]);
  });
  cache.set(id, p); return p;
}
// a small preview for the picker
export const packThumb = (id) => { const it = FACE_PACK().find((x) => x[0] === id); return it ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(it[5]) : ''; };
