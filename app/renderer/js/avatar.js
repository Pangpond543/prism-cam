// VTuber avatars: a character that copies the tracked face — head turn / tilt / nod, blinking, mouth, smile, brows,
// where the eyes look. Built-in characters are drawn here (no picture files); "my own" characters are stacked PNG
// parts of the same size (PNGtuber style). With no face in view the character idles: breathes, blinks, sways.
import { T } from './core.js';

export const AVATARS = () => [
  ['cat', T`แมวส้มโมจิ`, '#ffa94d', '#fff3e6'], ['bot', T`หุ่นยนต์โบลต์`, '#7aa7ff', '#bff6ff'], ['ghost', T`ผีน้อยพัฟ`, '#f6f3ff', '#b79cff'],
  ['png', T`ตัวละครจากรูปของฉัน`, '#ffffff', '#ffffff'],
];
export const AV_SLOTS = () => [
  ['back', T`ผมด้านหลัง`], ['body', T`ลำตัว`], ['head', T`หัว / หน้า`], ['eyesOpen', T`ตาเปิด`], ['eyesClosed', T`ตาปิด`],
  ['mouthClosed', T`ปากปิด`], ['mouthOpen', T`ปากอ้า`], ['front', T`ผมด้านหน้า / ของตกแต่ง`],
];
export const AV_DEF = { kind: 'cat', color: '#ffa94d', color2: '#fff3e6', who: 0, follow: 40, motion: 100, parts: {} };

const S = new Map(); // layer id → smoothed rig
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (a, b, k) => a + (b - a) * k;
function rig(L, F, now) {
  let s = S.get(L.id);
  if (!s) { s = { t: now, yaw: 0, pitch: 0, roll: 0, mouth: 0, eL: 0, eR: 0, smile: 0, brow: 0, gx: 0, gy: 0, fx: 0, fy: 0, seen: 0, nextBlink: now + 2500, blinkT: 0 }; S.set(L.id, s); }
  const dt = Math.min(0.1, (now - s.t) / 1000); s.t = now;
  const k = 1 - Math.exp(-dt / 0.06), kk = 1 - Math.exp(-dt / 0.03), m = (L.av.motion ?? 100) / 100, deg = Math.PI / 180;
  const shut = (v) => clamp((v - 0.3) / 0.3, 0, 1);
  if (F) {
    s.seen = now;
    s.yaw = ease(s.yaw, clamp(F.yaw / (40 * deg), -1, 1) * m, k); s.pitch = ease(s.pitch, clamp(F.pitch / (30 * deg), -1, 1) * m, k);
    s.roll = ease(s.roll, clamp(F.roll, -0.6, 0.6) * m, k);
    s.mouth = ease(s.mouth, clamp(F.mouth / 0.55, 0, 1), kk); s.eL = ease(s.eL, shut(F.eyeL), kk); s.eR = ease(s.eR, shut(F.eyeR), kk);
    s.smile = ease(s.smile, clamp((F.smile - 0.15) / 0.55, 0, 1), k); s.brow = ease(s.brow, clamp((F.brow - 0.2) / 0.5, 0, 1), k);
    s.gx = ease(s.gx, F.gx, k); s.gy = ease(s.gy, F.gy, k);
    s.fx = ease(s.fx, F.nx || 0, k); s.fy = ease(s.fy, F.ny || 0, k);
  } else {
    // idle: back to rest, blink by itself now and then
    const r = 1 - Math.exp(-dt / 0.4);
    for (const key of ['yaw', 'pitch', 'roll', 'mouth', 'smile', 'brow', 'gx', 'gy', 'fx', 'fy']) s[key] = ease(s[key], 0, r);
    if (now > s.nextBlink) { s.blinkT = now; s.nextBlink = now + 2200 + Math.random() * 3200; }
    const b = now - s.blinkT < 160 ? 1 : 0; s.eL = ease(s.eL, b, kk); s.eR = ease(s.eR, b, kk);
    s.yaw += Math.sin(now / 1900) * 0.002; s.roll += Math.sin(now / 2300) * 0.0015;
  }
  return s;
}
export const dropAvatar = (id) => S.delete(id);

// ctx is at the layer's centre (box −w/2 … w/2); F = the face that drives it (or null)
export function drawAvatar(ctx, L, F, now, img) {
  const A = L.av || (L.av = { ...AV_DEF }), s = rig(L, F, now);
  const u = Math.min(L.w, L.h) / 1000, f = (A.follow ?? 40) / 100;
  ctx.save(); ctx.scale(u, u);
  ctx.translate(s.fx * 260 * f, s.fy * 120 * f);
  const t = now / 1000;
  try {
    if (A.kind === 'bot') bot(ctx, A, s, t); else if (A.kind === 'ghost') ghost(ctx, A, s, t); else if (A.kind === 'png') png(ctx, A, s, t, img); else cat(ctx, A, s, t);
  } finally { ctx.restore(); }
}
const shade = (hex, k) => { const n = parseInt(hex.slice(1), 16), c = (v) => clamp(Math.round(v * k), 0, 255); return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`; };
const ell = (g, x, y, rx, ry, rot = 0) => { g.beginPath(); g.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2); };
function eyesDraw(g, s, x, y, rx, ry, col, happyCol) {
  for (const [side, e] of [[-1, s.eL], [1, s.eR]]) {
    const ex = x * side, open = 1 - e;
    if (s.smile > 0.6 && e < 0.5) { g.strokeStyle = happyCol || col; g.lineWidth = rx * 0.32; g.lineCap = 'round'; g.beginPath(); g.arc(ex, y + ry * 0.3, rx * 0.9, Math.PI * 1.15, Math.PI * 1.85); g.stroke(); continue; }
    if (open < 0.18) { g.strokeStyle = col; g.lineWidth = rx * 0.3; g.lineCap = 'round'; g.beginPath(); g.arc(ex, y - ry * 0.2, rx * 0.95, Math.PI * 0.15, Math.PI * 0.85); g.stroke(); continue; }
    g.fillStyle = col; ell(g, ex + s.gx * rx * 0.35, y - s.gy * ry * 0.2, rx, ry * open); g.fill();
    g.fillStyle = '#fff'; ell(g, ex + s.gx * rx * 0.35 + rx * 0.32, y - s.gy * ry * 0.2 - ry * 0.32 * open, rx * 0.3, rx * 0.3 * Math.min(1, open * 1.4)); g.fill();
  }
}

/* --------------------------------------------------------------- the cat */
function cat(g, A, s, t) {
  const c = A.color, c2 = A.color2, breathe = Math.sin(t * 2.1) * 6;
  g.fillStyle = 'rgba(0,0,0,.12)'; ell(g, 0, 488, 230, 16); g.fill();
  g.fillStyle = c; ell(g, 0, 330 - breathe * 0.4, 265, 205 + breathe); g.fill();
  g.fillStyle = c2; ell(g, 0, 370, 150, 130 + breathe * 0.6); g.fill();
  g.fillStyle = shade(c, 0.92); for (const x of [-115, 115]) { ell(g, x, 478, 72, 34); g.fill(); }
  g.save(); g.translate(s.yaw * 45, -70 - s.pitch * 32 + breathe * 0.5); g.rotate(s.roll * 0.85);
  // ears (behind the head, move less)
  g.save(); g.translate(-s.yaw * 18, 0);
  for (const sd of [-1, 1]) { g.fillStyle = c; g.beginPath(); g.moveTo(sd * 235, -95); g.lineTo(sd * 205, -330); g.lineTo(sd * 60, -205); g.closePath(); g.fill(); g.fillStyle = '#ffb3c4'; g.beginPath(); g.moveTo(sd * 200, -130); g.lineTo(sd * 190, -280); g.lineTo(sd * 100, -205); g.closePath(); g.fill(); }
  g.restore();
  g.fillStyle = c; ell(g, 0, 0, 255, 215); g.fill();
  g.fillStyle = shade(c, 0.88); for (const x of [-40, 0, 40]) { g.beginPath(); g.moveTo(x - 14, -212); g.lineTo(x, -150); g.lineTo(x + 14, -212); g.fill(); } // stripes
  g.save(); g.translate(s.yaw * 60, -s.pitch * 36);
  g.fillStyle = `rgba(255,120,150,${0.18 + s.smile * 0.5})`; for (const x of [-150, 150]) { ell(g, x, 70, 48, 26); g.fill(); }
  eyesDraw(g, s, 95, -18 - s.brow * 8, 34, 46, '#2b2233');
  if (s.brow > 0.15) { g.strokeStyle = shade(c, 0.6); g.lineWidth = 12; g.lineCap = 'round'; for (const sd of [-1, 1]) { g.beginPath(); g.moveTo(sd * 70, -95 - s.brow * 30); g.lineTo(sd * 125, -100 - s.brow * 24); g.stroke(); } }
  g.fillStyle = '#ff8fab'; g.beginPath(); g.moveTo(-18, 38); g.lineTo(18, 38); g.lineTo(0, 56); g.closePath(); g.fill();
  if (s.mouth > 0.12) {
    g.fillStyle = '#5a2232'; ell(g, 0, 92 + s.mouth * 18, 38 + s.smile * 12, 10 + s.mouth * 52); g.fill();
    g.fillStyle = '#ff7f9f'; ell(g, 0, 105 + s.mouth * 42, 24, 8 + s.mouth * 16); g.fill();
  } else { g.strokeStyle = '#4a2a33'; g.lineWidth = 9; g.lineCap = 'round'; g.beginPath(); g.arc(-22, 60, 22, 0.1, Math.PI - 0.3); g.moveTo(44, 60); g.arc(22, 60, 22, 0.3, Math.PI - 0.1); g.stroke(); }
  g.strokeStyle = 'rgba(70,40,40,.55)'; g.lineWidth = 6; for (const sd of [-1, 1]) for (const dy of [-18, 6, 30]) { g.beginPath(); g.moveTo(sd * 165, 55 + dy * 0.5); g.lineTo(sd * 280, 40 + dy); g.stroke(); }
  g.restore(); g.restore();
}

/* ------------------------------------------------------------- the robot */
function bot(g, A, s, t) {
  const c = A.color, glow = A.color2, breathe = Math.sin(t * 2) * 4;
  g.fillStyle = 'rgba(0,0,0,.14)'; ell(g, 0, 490, 220, 14); g.fill();
  g.fillStyle = shade(c, 0.7); g.beginPath(); g.roundRect(-220, 200 - breathe, 440, 300 + breathe, 70); g.fill();
  g.fillStyle = shade(c, 0.55); g.fillRect(-50, 150, 100, 70);
  g.save(); g.shadowColor = glow; g.shadowBlur = 30 + s.mouth * 50; g.fillStyle = glow; g.globalAlpha = 0.5 + s.mouth * 0.5; ell(g, 0, 340, 46, 46); g.fill(); g.restore();
  g.save(); g.translate(s.yaw * 40, -60 - s.pitch * 30); g.rotate(s.roll * 0.8);
  g.save(); g.translate(-s.yaw * 22, 0); g.fillStyle = shade(c, 0.8); for (const sd of [-1, 1]) { ell(g, sd * 252, -10, 42, 62); g.fill(); } g.restore();
  g.strokeStyle = shade(c, 0.6); g.lineWidth = 14; g.beginPath(); g.moveTo(0, -200); g.lineTo(s.yaw * -20, -300); g.stroke();
  g.save(); g.shadowColor = glow; g.shadowBlur = 25 + s.mouth * 40; g.fillStyle = glow; ell(g, s.yaw * -20, -312, 26, 26); g.fill(); g.restore();
  const gr = g.createLinearGradient(0, -200, 0, 180); gr.addColorStop(0, shade(c, 1.12)); gr.addColorStop(1, shade(c, 0.85));
  g.fillStyle = gr; g.beginPath(); g.roundRect(-240, -200, 480, 380, 90); g.fill();
  g.fillStyle = '#141b36'; g.beginPath(); g.roundRect(-190, -135, 380, 250, 60); g.fill();
  g.save(); g.translate(s.yaw * 50, -s.pitch * 26); g.shadowColor = glow; g.shadowBlur = 22; g.fillStyle = glow;
  for (const [sd, e] of [[-1, s.eL], [1, s.eR]]) {
    const x = sd * 78 + s.gx * 14, y = -30 - s.gy * 8 - s.brow * 12;
    if (s.smile > 0.6 && e < 0.5) { g.strokeStyle = glow; g.lineWidth = 16; g.lineCap = 'round'; g.beginPath(); g.arc(x, y + 20, 32, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); continue; }
    const h = Math.max(10, 86 * (1 - e)); g.beginPath(); g.roundRect(x - 34, y - h / 2, 68, h, 22); g.fill();
  }
  for (let i = 0; i < 7; i++) { const k = 1 - Math.abs(i - 3) / 4, h = 10 + s.mouth * 64 * k + s.smile * 6; g.globalAlpha = 0.35 + 0.65 * Math.min(1, s.mouth * 2 + 0.2); g.beginPath(); g.roundRect(-91 + i * 26 - 9, 70 - h / 2, 18, h, 8); g.fill(); }
  g.restore(); g.restore();
}

/* ------------------------------------------------------------- the ghost */
function ghost(g, A, s, t) {
  const c = A.color, c2 = A.color2, bob = Math.sin(t * 1.6) * 18;
  g.fillStyle = 'rgba(0,0,0,.12)'; ell(g, 0, 480, 170 - bob, 18); g.fill();
  g.save(); g.translate(s.yaw * 40, bob - s.pitch * 26); g.rotate(s.roll * 0.7);
  const wv = Math.sin(t * 3) * 10;
  g.fillStyle = c; g.beginPath(); g.moveTo(-260, 0); g.arc(0, 0, 260, Math.PI, 0); g.lineTo(260, 330);
  for (let i = 0; i < 4; i++) { const x0 = 260 - i * 130; g.quadraticCurveTo(x0 - 32, 390 + (i % 2 ? wv : -wv), x0 - 65, 330); g.quadraticCurveTo(x0 - 98, 270, x0 - 130, 330); }
  g.closePath(); g.shadowColor = c2; g.shadowBlur = 40; g.fill(); g.shadowBlur = 0;
  g.fillStyle = c; for (const sd of [-1, 1]) { g.save(); g.translate(sd * 250, 150); g.rotate(sd * (0.4 + Math.sin(t * 2.4 + sd) * 0.25)); ell(g, 0, 0, 70, 38); g.fill(); g.restore(); }
  g.save(); g.translate(s.yaw * 70, -s.pitch * 40);
  g.fillStyle = c2; g.globalAlpha = 0.35 + s.smile * 0.45; for (const x of [-140, 140]) { ell(g, x, 80, 44, 24); g.fill(); } g.globalAlpha = 1;
  eyesDraw(g, s, 85, -10 - s.brow * 14, 42, 58, '#2d2340');
  g.fillStyle = '#2d2340'; if (s.mouth > 0.1) { ell(g, 0, 95, 30 + s.smile * 10, 10 + s.mouth * 46); g.fill(); } else { g.strokeStyle = '#2d2340'; g.lineWidth = 9; g.lineCap = 'round'; g.beginPath(); g.arc(0, 70, 26 + s.smile * 10, 0.25 * Math.PI, 0.75 * Math.PI); g.stroke(); }
  g.restore(); g.restore();
}

/* ------------------------------------------------------- my own pictures */
function png(g, A, s, t, img) {
  const P = A.parts || {}, get = (k) => (P[k] ? img(P[k]) : null);
  const ref = ['head', 'body', 'mouthClosed', 'eyesOpen', 'front', 'back'].map(get).find((x) => x && x.naturalWidth);
  if (!ref) { g.fillStyle = 'rgba(124,140,255,.22)'; g.beginPath(); g.roundRect(-420, -420, 840, 840, 60); g.fill(); g.fillStyle = '#fff'; g.font = '600 44px "IBM Plex Sans Thai", sans-serif'; g.textAlign = 'center'; g.fillText(T`ใส่รูปส่วนต่าง ๆ ในแผงด้านขวา`, 0, 0); return; }
  const k = Math.min(1000 / ref.naturalWidth, 1000 / ref.naturalHeight), w = ref.naturalWidth * k, h = ref.naturalHeight * k;
  const draw = (im, dx = 0) => { if (im && im.naturalWidth) g.drawImage(im, -w / 2 + dx, -h / 2, w, h); };
  const breathe = Math.sin(t * 2) * 0.008, hop = s.mouth * 14;
  g.save(); g.translate(0, h * 0.5); g.scale(1, 1 + breathe); g.translate(0, -h * 0.5); draw(get('body')); g.restore();
  g.save(); g.translate(s.yaw * 30, h * 0.2 - s.pitch * 22 - hop); g.rotate(s.roll * 0.8); g.translate(0, -h * 0.2);
  draw(get('back'), -s.yaw * 14);
  draw(get('head'));
  const blink = Math.max(s.eL, s.eR) > 0.6;
  draw(get(blink && P.eyesClosed ? 'eyesClosed' : 'eyesOpen'), s.yaw * 22);
  draw(get(s.mouth > 0.3 && P.mouthOpen ? 'mouthOpen' : 'mouthClosed'), s.yaw * 22);
  draw(get('front'), s.yaw * 34);
  g.restore();
}
