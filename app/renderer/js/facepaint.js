// Face paint: a picture laid out in the face's texture map (MediaPipe canonical face, data/face-mesh.js) is stretched
// over the tracked face mesh with WebGL, so it bends, turns and opens with the face. Built-in paints are drawn here
// from the face points' texture positions; users can paint their own on the template (saveFaceTemplate).
import { UV, TRI } from '../data/face-mesh.js';
import { T } from './core.js';

const S = 1024; // texture size
const U = (i) => [UV[i * 2] * S, UV[i * 2 + 1] * S];
const LIPS_OUT = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LIPS_IN = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
const EYE_A = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_B = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const BROW_A = [70, 63, 105, 66, 107], BROW_B = [300, 293, 334, 296, 336];
// closed loops / open lines of the face outline (the preview-only face mesh in studio.js draws these)
export const FACE_LINES = { loops: [OVAL, EYE_A, EYE_B, LIPS_OUT, LIPS_IN], lines: [BROW_A, BROW_B] };

// id · label · default colour
export const PAINTS = () => [
  ['blush', T`แก้มชมพู`, '#ff6b9a'], ['lips', T`ลิปสติก`, '#d6204f'], ['cat', T`หน้าแมว`, '#2a1f2b'], ['panda', T`ตาแพนด้า`, '#151320'],
  ['hero', T`หน้ากากฮีโร่`, '#2b2d6e'], ['stars', T`ดาวกากเพชร`, '#ffd34d'], ['hearts', T`แก้มหัวใจ`, '#ff4f7b'], ['freckles', T`กระน่ารัก`, '#9a5a3c'],
  ['tiger', T`ลายเสือ`, '#16110d'], ['neon', T`เส้นนีออน`, '#6ef3ff'],
];
export const paintName = (id) => { const p = PAINTS().find((x) => x[0] === id); return p ? p[1] : T`ลายของฉัน`; };

const poly = (g, idx, k = 1) => { // a loop of face points, optionally grown around its own centre
  let cx = 0, cy = 0; for (const i of idx) { const [x, y] = U(i); cx += x; cy += y; } cx /= idx.length; cy /= idx.length;
  idx.forEach((i, n) => { const [x, y] = U(i); const px = cx + (x - cx) * k, py = cy + (y - cy) * k; if (n) g.lineTo(px, py); else g.moveTo(px, py); });
  g.closePath(); return [cx, cy];
};
const dist = (a, b) => Math.hypot(U(a)[0] - U(b)[0], U(a)[1] - U(b)[1]);
function heart(g, x, y, r) { g.beginPath(); g.moveTo(x, y + r * 0.9); g.bezierCurveTo(x - r * 1.6, y - r * 0.2, x - r * 0.7, y - r * 1.3, x, y - r * 0.45); g.bezierCurveTo(x + r * 0.7, y - r * 1.3, x + r * 1.6, y - r * 0.2, x, y + r * 0.9); g.fill(); }
function star(g, x, y, r) { g.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? r * 0.42 : r; g.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); } g.closePath(); g.fill(); }
let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// a built-in paint as a texture canvas
export function makePaint(id, color) {
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'); g.lineCap = g.lineJoin = 'round'; seed = 7;
  const fw = dist(234, 454);
  if (id === 'blush') for (const i of [50, 280]) { const [x, y] = U(i), r = fw * 0.13, gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, color + 'aa'); gr.addColorStop(1, color + '00'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); }
  else if (id === 'lips') {
    g.fillStyle = color; g.beginPath(); poly(g, LIPS_OUT); poly(g, LIPS_IN); g.fill('evenodd');
    const [x, y] = U(14); g.fillStyle = 'rgba(255,255,255,.28)'; g.beginPath(); g.ellipse(x - fw * 0.03, y + fw * 0.025, fw * 0.035, fw * 0.01, -0.2, 0, 7); g.fill();
  } else if (id === 'cat') {
    g.fillStyle = color; const [nx, ny] = U(4); heart(g, nx, ny + fw * 0.005, fw * 0.045);
    g.strokeStyle = color; g.lineWidth = fw * 0.012; g.beginPath(); g.moveTo(...U(2)); g.lineTo(...U(0)); g.stroke();
    g.lineWidth = fw * 0.008;
    for (const [i, dir] of [[205, -1], [425, 1]]) { const [x, y] = U(i); for (let k = -1; k <= 1; k++) { g.beginPath(); g.moveTo(x, y + k * fw * 0.03); g.quadraticCurveTo(x + dir * fw * 0.1, y + k * fw * 0.04 - fw * 0.01, x + dir * fw * 0.2, y + k * fw * 0.06); g.stroke(); } }
  } else if (id === 'panda') {
    g.filter = `blur(${fw * 0.012}px)`; g.fillStyle = color;
    for (const e of [EYE_A, EYE_B]) { g.beginPath(); poly(g, e, 1.9); g.fill(); }
    g.filter = 'none';
  } else if (id === 'hero') {
    g.fillStyle = color; g.beginPath(); poly(g, EYE_A, 2.3); poly(g, EYE_B, 2.3); g.fill();
    const a = U(133), b = U(362), t = U(168); g.beginPath(); g.moveTo(a[0], a[1] - fw * 0.04); g.quadraticCurveTo(t[0], t[1] - fw * 0.02, b[0], b[1] - fw * 0.04); g.lineTo(b[0], b[1] + fw * 0.03); g.quadraticCurveTo(t[0], t[1] + fw * 0.05, a[0], a[1] + fw * 0.03); g.closePath(); g.fill();
    g.globalCompositeOperation = 'destination-out'; g.beginPath(); poly(g, EYE_A, 1.25); poly(g, EYE_B, 1.25); g.fill(); g.globalCompositeOperation = 'source-over';
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = fw * 0.006; g.beginPath(); poly(g, EYE_A, 2.3); g.stroke(); g.beginPath(); poly(g, EYE_B, 2.3); g.stroke();
  } else if (id === 'stars') {
    g.shadowColor = color; g.shadowBlur = fw * 0.03; g.fillStyle = color;
    for (const [i, s] of [[117, 1], [346, 1], [118, 0.6], [347, 0.6], [101, 0.45], [330, 0.45]]) { const [x, y] = U(i); star(g, x, y, fw * 0.05 * s); }
    g.fillStyle = '#fff'; g.shadowBlur = 0; for (let k = 0; k < 40; k++) { const [x, y] = U([117, 346, 118, 347][k % 4]); g.globalAlpha = 0.5 + rnd() * 0.5; g.beginPath(); g.arc(x + (rnd() - 0.5) * fw * 0.2, y + (rnd() - 0.5) * fw * 0.14, fw * 0.004 * (1 + rnd()), 0, 7); g.fill(); }
    g.globalAlpha = 1;
  } else if (id === 'hearts') { g.fillStyle = color; for (const i of [50, 280]) { const [x, y] = U(i); heart(g, x, y, fw * 0.06); } }
  else if (id === 'freckles') { g.fillStyle = color + 'b0'; for (const i of [205, 425, 6]) { const [x, y] = U(i); for (let k = 0; k < 14; k++) { g.beginPath(); g.arc(x + (rnd() - 0.5) * fw * (i === 6 ? 0.12 : 0.2), y + (rnd() - 0.5) * fw * 0.1, fw * (0.004 + rnd() * 0.005), 0, 7); g.fill(); } } }
  else if (id === 'tiger') {
    g.fillStyle = color; const [cx, cy] = U(6);
    OVAL.forEach((i, n) => {
      if (n % 3) return; const [x, y] = U(i), dx = cx - x, dy = cy - y, l = Math.hypot(dx, dy) || 1, len = l * (0.22 + rnd() * 0.12), nx = -dy / l, ny = dx / l, w = fw * 0.022;
      g.beginPath(); g.moveTo(x + nx * w, y + ny * w); g.quadraticCurveTo(x + dx / l * len * 0.6 + nx * w * 0.3, y + dy / l * len * 0.6 + ny * w * 0.3, x + dx / l * len, y + dy / l * len); g.quadraticCurveTo(x + dx / l * len * 0.6 - nx * w * 0.3, y + dy / l * len * 0.6 - ny * w * 0.3, x - nx * w, y - ny * w); g.fill();
    });
  } else if (id === 'neon') {
    g.strokeStyle = color; g.shadowColor = color; g.shadowBlur = fw * 0.02; g.lineWidth = fw * 0.008;
    for (const loop of [OVAL, LIPS_OUT, EYE_A, EYE_B]) { g.beginPath(); poly(g, loop, loop === OVAL ? 0.97 : 1.15); g.stroke(); }
    for (const b of [BROW_A, BROW_B]) { g.beginPath(); b.forEach((i, n) => (n ? g.lineTo(...U(i)) : g.moveTo(...U(i)))); g.stroke(); }
  }
  return c;
}

// a small preview of a paint on a plain cartoon face (for the picker)
const thumbs = new Map();
export function paintThumb(id, color) {
  const key = id + color; if (thumbs.has(key)) return thumbs.get(key);
  const c = document.createElement('canvas'); c.width = c.height = 96;
  const g = c.getContext('2d'); g.scale(96 / S, 96 / S);
  g.fillStyle = '#f3cfae'; g.beginPath(); poly(g, OVAL); g.fill();
  g.fillStyle = '#5b3a2e'; for (const e of [EYE_A, EYE_B]) { g.beginPath(); poly(g, e, 0.7); g.fill(); }
  g.fillStyle = '#c7766f'; g.beginPath(); poly(g, LIPS_OUT); poly(g, LIPS_IN); g.fill('evenodd');
  g.drawImage(makePaint(id, color), 0, 0);
  const url = c.toDataURL(); thumbs.set(key, url); return url;
}

// the template people paint their own face on: the face mesh in texture space, eyes / lips / brows marked
export function faceTemplate() {
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'); g.fillStyle = '#f4f1ea'; g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(60,70,120,.28)'; g.lineWidth = 1;
  g.beginPath(); for (let t = 0; t < TRI.length; t += 3) { const a = U(TRI[t]), b = U(TRI[t + 1]), d = U(TRI[t + 2]); g.moveTo(...a); g.lineTo(...b); g.lineTo(...d); g.closePath(); } g.stroke();
  g.lineWidth = 3;
  for (const [loop, col] of [[OVAL, '#5a6cff'], [LIPS_OUT, '#e0457a'], [LIPS_IN, '#e0457a'], [EYE_A, '#1f9d74'], [EYE_B, '#1f9d74']]) { g.strokeStyle = col; g.beginPath(); poly(g, loop); g.stroke(); }
  for (const b of [BROW_A, BROW_B]) { g.strokeStyle = '#8a5a2b'; g.beginPath(); b.forEach((i, n) => (n ? g.lineTo(...U(i)) : g.moveTo(...U(i)))); g.stroke(); }
  g.fillStyle = '#3a3f66'; g.font = '600 22px "IBM Plex Sans Thai", sans-serif'; g.textAlign = 'center';
  g.fillText(T`แม่แบบลายหน้า Prism Cam — วาดทับแล้วบันทึกเป็น PNG พื้นใส`, S / 2, 40);
  g.font = '18px "IBM Plex Sans Thai", sans-serif'; g.fillText(T`ซ้ายของรูป = ซ้ายของภาพกล้อง · ลบเส้นแม่แบบออกก่อนใช้`, S / 2, 70);
  return c;
}

/* --------------------------------------------------------------- renderer */
let gl = null, cv = null, prog = null, bPos = null, bIdx = null, uSize = null, uAlpha = null, aPos = -1, aUv = -1, failed = false;
const tex = new Map(); // key → { t, src }
const pos = new Float32Array(468 * 3);
function init() {
  if (gl || failed) return !!gl;
  try {
    cv = document.createElement('canvas');
    gl = cv.getContext('webgl', { premultipliedAlpha: true, alpha: true, depth: true, antialias: true });
    if (!gl) throw new Error('no webgl');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec3 p;attribute vec2 uv;uniform vec2 sz;varying vec2 v;void main(){v=uv;gl_Position=vec4(p.x/sz.x*2.0-1.0,1.0-p.y/sz.y*2.0,clamp(p.z*3.0,-0.99,0.99),1.0);}'));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, 'precision mediump float;uniform sampler2D t;uniform float a;varying vec2 v;void main(){vec4 c=texture2D(t,v);gl_FragColor=vec4(c.rgb*c.a,c.a)*a;}'));
    gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    aPos = gl.getAttribLocation(prog, 'p'); aUv = gl.getAttribLocation(prog, 'uv'); uSize = gl.getUniformLocation(prog, 'sz'); uAlpha = gl.getUniformLocation(prog, 'a');
    const bUv = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bUv); gl.bufferData(gl.ARRAY_BUFFER, UV, gl.STATIC_DRAW); gl.enableVertexAttribArray(aUv); gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
    bPos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bPos); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    bIdx = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, TRI, gl.STATIC_DRAW);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gl = null; tex.clear(); });
    return true;
  } catch (err) { console.warn('face paint', err); failed = true; gl = null; return false; }
}
function texFor(key, src) {
  let e = tex.get(key);
  if (e && e.src === src) return e.t;
  if (!src || !(src.width || src.naturalWidth)) return null;
  if (!e) { e = { t: gl.createTexture(), src: null }; tex.set(key, e); }
  gl.bindTexture(gl.TEXTURE_2D, e.t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  e.src = src; if (tex.size > 24) { const [k0, v0] = tex.entries().next().value; if (k0 !== key) { gl.deleteTexture(v0.t); tex.delete(k0); } }
  return e.t;
}
const paintCache = new Map();
export function paintSource(L, assets, imgOf) {
  if (L.paint === 'custom') return imgOf(L);
  const key = L.paint + '|' + L.color;
  let c = paintCache.get(key); if (!c) { c = makePaint(L.paint, L.color); paintCache.set(key, c); if (paintCache.size > 30) paintCache.delete(paintCache.keys().next().value); }
  return c;
}
// draw the paint over every face in `faces` (scene pixels) — ctx is the stage context with its base transform
export function drawFacePaint(ctx, L, faces, o, scale, src) {
  if (!faces.length || !src || !init()) return;
  const w = Math.max(2, Math.round(o.w * scale)), h = Math.max(2, Math.round(o.h * scale));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const t = texFor(L.id + '|' + (L.paint === 'custom' ? L.asset : L.paint + L.color), src); if (!t) return;
  gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(prog); gl.uniform2f(uSize, o.w, o.h); gl.uniform1f(uAlpha, 1);
  gl.bindTexture(gl.TEXTURE_2D, t);
  const list = L.who === 'all' ? faces : faces.slice(+L.who || 0, (+L.who || 0) + 1);
  for (const F of list) {
    for (let i = 0; i < 468; i++) { pos[i * 3] = F.p[i * 2]; pos[i * 3 + 1] = F.p[i * 2 + 1]; pos[i * 3 + 2] = F.z[i]; }
    gl.bindBuffer(gl.ARRAY_BUFFER, bPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    gl.drawElements(gl.TRIANGLES, TRI.length, gl.UNSIGNED_SHORT, 0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }
  ctx.drawImage(cv, 0, 0, o.w, o.h);
}
