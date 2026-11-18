// Hand effects layer: everything here is drawn straight into the 2D scene from the tracked hand points.
// The scene canvas is a CPU canvas, so glow is built from additive sprites and layered strokes — never shadowBlur.
import { BONES, TIPS, gestureEmoji, gestureName } from './hands.js';

export const FX_DEFAULT = { skel: true, glow: true, trail: 'index', sparks: true, orb: true, ring: false, link: true, draw: false, emoji: true, label: false, color: '#7c8cff', color2: '#ff9ec7', rainbow: false, size: 100, drawFade: 0 };
const st = new Map(); // layer id → runtime state
const state = (id) => st.get(id) || st.set(id, { trails: new Map(), last: new Map(), parts: [], strokes: [], cur: new Map(), orbs: new Map(), pops: [], gest: new Map(), t: 0 }).get(id);
export const dropHandFx = (id) => st.delete(id);
export function clearHandDrawing() { for (const s of st.values()) { s.strokes.length = 0; s.cur.clear(); } }

const rgb = (hex) => { const n = parseInt(String(hex).slice(1), 16) || 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const hsl = (h) => { const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (0.6 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }; return [f(0), f(8), f(4)]; };
const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const sprites = new Map();
function sprite(c) { // soft round glow, cached per colour
  const key = (c[0] >> 3) << 10 | (c[1] >> 3) << 5 | (c[2] >> 3);
  let s = sprites.get(key);
  if (!s) {
    s = document.createElement('canvas'); s.width = s.height = 64;
    const x = s.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.18, css(c, 0.9)); g.addColorStop(0.5, css(c, 0.28)); g.addColorStop(1, css(c, 0));
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    if (sprites.size > 80) sprites.clear();
    sprites.set(key, s);
  }
  return s;
}
const blob = (ctx, c, x, y, r) => ctx.drawImage(sprite(c), x - r, y - r, r * 2, r * 2);

// H: [{ id, g, pin, p: Float32Array(42) scene px, palm: [x, y], size: px, ang }]
export function drawHandFx(ctx, L, H, now, o, pair) {
  const F = L.fx, s = state(L.id), dt = Math.min(0.1, s.t ? (now - s.t) / 1000 : 0.033), k = F.size / 100;
  s.t = now;
  const c1 = F.rainbow ? hsl((now / 14) % 360) : rgb(F.color), c2 = F.rainbow ? hsl((now / 14 + 140) % 360) : rgb(F.color2);
  const live = new Set(H.map((h) => h.id));
  for (const m of [s.trails, s.last, s.cur, s.gest]) for (const id of [...m.keys()]) if (!live.has(id)) m.delete(id);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  /* air drawing (kept under the hand effects) */
  if (F.draw || s.strokes.length) {
    for (const h of H) {
      let cur = s.cur.get(h.id);
      if (F.draw && h.pin) {
        const x = (h.p[8] + h.p[16]) / 2, y = (h.p[9] + h.p[17]) / 2;
        if (!cur) { cur = { pts: [x, y], c: c1, c2, w: Math.max(3, o.h * 0.012 * k), t: now }; s.cur.set(h.id, cur); s.strokes.push(cur); }
        else { const n = cur.pts.length; if (Math.hypot(x - cur.pts[n - 2], y - cur.pts[n - 1]) > 2.5) cur.pts.push(x, y); cur.t = now; }
      } else if (cur) s.cur.delete(h.id);
    }
    let total = 0; for (const q of s.strokes) total += q.pts.length;
    while (total > 9000 && s.strokes.length > 1) total -= s.strokes.shift().pts.length;
    ctx.globalCompositeOperation = 'source-over';
    for (let i = s.strokes.length - 1; i >= 0; i--) {
      const q = s.strokes[i], age = (now - q.t) / 1000;
      const a = F.drawFade > 0 ? Math.min(1, (F.drawFade - age) / Math.min(1.5, F.drawFade)) : 1;
      if (a <= 0) { s.strokes.splice(i, 1); continue; }
      const P = q.pts; if (P.length < 4) continue;
      ctx.beginPath(); ctx.moveTo(P[0], P[1]);
      for (let j = 2; j < P.length - 2; j += 2) ctx.quadraticCurveTo(P[j], P[j + 1], (P[j] + P[j + 2]) / 2, (P[j + 1] + P[j + 3]) / 2);
      ctx.lineTo(P[P.length - 2], P[P.length - 1]);
      ctx.lineWidth = q.w * 2.6; ctx.strokeStyle = css(q.c, 0.3 * a); ctx.stroke();
      ctx.lineWidth = q.w; ctx.strokeStyle = css(q.c2, 0.95 * a); ctx.stroke();
      ctx.lineWidth = q.w * 0.35; ctx.strokeStyle = `rgba(255,255,255,${0.9 * a})`; ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'lighter';

  /* magic circle under the palm */
  if (F.ring) for (const h of H) {
    const R = h.size * 1.05, a = now / 900;
    ctx.save(); ctx.translate(h.palm[0], h.palm[1]);
    ctx.strokeStyle = css(c1, 0.85); ctx.lineWidth = Math.max(1.5, R * 0.03 * k);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 6.2832); ctx.stroke();
    ctx.rotate(a); ctx.setLineDash([R * 0.2, R * 0.11]); ctx.strokeStyle = css(c2, 0.8);
    ctx.beginPath(); ctx.arc(0, 0, R * 0.84, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
    ctx.rotate(-a * 2.2); ctx.strokeStyle = css(c1, 0.7); ctx.lineWidth = Math.max(1, R * 0.018 * k);
    for (let t = 0; t < 2; t++) { ctx.beginPath(); for (let i = 0; i < 3; i++) { const q = t * Math.PI + i * 2.0944; ctx.lineTo(Math.sin(q) * R * 0.84, -Math.cos(q) * R * 0.84); } ctx.closePath(); ctx.stroke(); }
    ctx.rotate(a * 3); ctx.strokeStyle = css(c2, 0.6);
    ctx.beginPath(); for (let i = 0; i < 12; i++) { const q = i * 0.5236; ctx.moveTo(Math.sin(q) * R * 1.06, -Math.cos(q) * R * 1.06); ctx.lineTo(Math.sin(q) * R * 1.16, -Math.cos(q) * R * 1.16); } ctx.stroke();
    ctx.restore();
  }

  /* lightning between the two hands */
  if (F.link && H.length >= 2) {
    const a = H[0], b = H[1], ax = a.p[16], ay = a.p[17], bx = b.p[16], by = b.p[17], len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / len, ny = (bx - ax) / len, amp = Math.min(len * 0.09, o.h * 0.07);
    for (let pass = 0; pass < 3; pass++) {
      ctx.beginPath(); ctx.moveTo(ax, ay);
      for (let i = 1; i < 14; i++) { const t = i / 14, j = (Math.random() - 0.5) * 2 * amp * Math.sin(t * Math.PI); ctx.lineTo(ax + (bx - ax) * t + nx * j, ay + (by - ay) * t + ny * j); }
      ctx.lineTo(bx, by);
      ctx.lineWidth = Math.max(4, o.h * 0.014) * k; ctx.strokeStyle = css(pass ? c2 : c1, 0.22); ctx.stroke();
      ctx.lineWidth = Math.max(1.2, o.h * 0.0035) * k; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.stroke();
    }
    blob(ctx, c1, ax, ay, a.size * 0.5); blob(ctx, c2, bx, by, b.size * 0.5);
  }

  for (const h of H) {
    const p = h.p, sz = h.size;
    const last = s.last.get(h.id);
    /* finger trails */
    if (F.trail !== 'off') {
      let tr = s.trails.get(h.id); if (!tr) { tr = [[], [], [], [], []]; s.trails.set(h.id, tr); }
      TIPS.forEach((tip, f) => {
        if (F.trail === 'index' && f !== 1) { tr[f].length = 0; return; }
        const a = tr[f]; a.push(p[tip * 2], p[tip * 2 + 1], now);
        while (a.length && now - a[2] > 420) a.splice(0, 3);
        const n = a.length / 3; if (n < 2) return;
        const col = f % 2 ? c1 : c2, w = sz * 0.11 * k;
        for (let i = 1; i < n; i++) {
          const q = i / n;
          ctx.beginPath(); ctx.moveTo(a[i * 3 - 3], a[i * 3 - 2]); ctx.lineTo(a[i * 3], a[i * 3 + 1]);
          ctx.lineWidth = w * q + 1; ctx.strokeStyle = css(col, 0.55 * q * q); ctx.stroke();
          ctx.lineWidth = w * q * 0.35 + 0.5; ctx.strokeStyle = `rgba(255,255,255,${0.7 * q * q})`; ctx.stroke();
        }
      });
    } else s.trails.delete(h.id);

    /* neon skeleton */
    if (F.skel) {
      ctx.beginPath();
      for (const [a, b] of BONES) { ctx.moveTo(p[a * 2], p[a * 2 + 1]); ctx.lineTo(p[b * 2], p[b * 2 + 1]); }
      ctx.lineWidth = Math.max(4, sz * 0.085) * k; ctx.strokeStyle = css(c1, 0.3); ctx.stroke();
      ctx.lineWidth = Math.max(2, sz * 0.04) * k; ctx.strokeStyle = css(c2, 0.55); ctx.stroke();
      ctx.lineWidth = Math.max(1, sz * 0.014) * k; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.beginPath();
      const r = Math.max(1.5, sz * 0.022) * k;
      for (let i = 0; i < 21; i++) { ctx.moveTo(p[i * 2] + r, p[i * 2 + 1]); ctx.arc(p[i * 2], p[i * 2 + 1], r, 0, 6.2832); }
      ctx.fill();
    }
    /* glowing fingertips */
    if (F.glow) TIPS.forEach((tip, f) => blob(ctx, f % 2 ? c1 : c2, p[tip * 2], p[tip * 2 + 1], sz * 0.2 * k));

    /* sparks thrown off by fast fingertips */
    if (F.sparks && last && s.parts.length < 520) for (const tip of TIPS) {
      const vx = (p[tip * 2] - last[tip * 2]) / dt, vy = (p[tip * 2 + 1] - last[tip * 2 + 1]) / dt, sp = Math.hypot(vx, vy);
      const n = Math.min(3, Math.floor(sp / (o.h * 0.55) + Math.random()));
      for (let i = 0; i < n; i++) s.parts.push({ x: p[tip * 2], y: p[tip * 2 + 1], vx: vx * 0.18 + (Math.random() - 0.5) * o.h * 0.25, vy: vy * 0.18 + (Math.random() - 0.5) * o.h * 0.25, l: 1, d: 1.1 + Math.random() * 1.6, r: sz * (0.05 + Math.random() * 0.07) * k, c: Math.random() < 0.5 ? c1 : c2 });
    }
    /* energy orb in an open palm; closing the hand bursts it */
    if (F.orb) {
      let ob = s.orbs.get(h.id); if (!ob) { ob = { r: 0 }; s.orbs.set(h.id, ob); }
      const want = h.g === 'palm' ? 1 : 0;
      if (!want && ob.r > 0.6 && h.g === 'fist') { for (let i = 0; i < 46; i++) { const q = Math.random() * 6.2832, v = o.h * (0.25 + Math.random() * 0.9); s.parts.push({ x: h.palm[0], y: h.palm[1], vx: Math.cos(q) * v, vy: Math.sin(q) * v, l: 1, d: 1 + Math.random() * 1.4, r: sz * (0.06 + Math.random() * 0.1) * k, c: Math.random() < 0.5 ? c1 : c2 }); } ob.r = 0; }
      ob.r += (want - ob.r) * Math.min(1, dt * (want ? 5 : 9));
      if (ob.r > 0.02) {
        const R = sz * 0.5 * ob.r * (1 + Math.sin(now / 130) * 0.05), x = h.palm[0], y = h.palm[1];
        blob(ctx, c1, x, y, R * 2.6); blob(ctx, c2, x, y, R * 1.5); blob(ctx, [255, 255, 255], x, y, R * 0.8);
        ctx.lineWidth = Math.max(1.5, R * 0.07) * k;
        for (let i = 0; i < 3; i++) { const a0 = now / (260 + i * 90) * (i % 2 ? -1 : 1) + i * 2.1; ctx.strokeStyle = css(i % 2 ? c1 : c2, 0.8); ctx.beginPath(); ctx.ellipse(x, y, R * (1.15 + i * 0.16), R * (0.5 + i * 0.12), a0, 0, 4.4); ctx.stroke(); }
        if (Math.random() < 0.6 && s.parts.length < 520) { const q = Math.random() * 6.2832; s.parts.push({ x: x + Math.cos(q) * R, y: y + Math.sin(q) * R, vx: Math.cos(q) * o.h * 0.08, vy: -o.h * 0.22 - Math.random() * o.h * 0.12, l: 1, d: 1.4, r: sz * 0.06 * k, c: c2, up: 1 }); }
      }
    }
    /* gesture reactions */
    const prev = s.gest.get(h.id);
    if (prev !== h.g) { s.gest.set(h.id, h.g); if (F.emoji && h.g && prev !== undefined) s.pops.push({ x: h.palm[0], y: h.palm[1] - sz * 1.1, e: gestureEmoji(h.g), l: 1, s: sz * 0.95 }); }
    if (F.label && h.g) {
      ctx.globalCompositeOperation = 'source-over';
      const txt = gestureName(h.g), fs = Math.max(13, sz * 0.2);
      ctx.font = `600 ${fs}px "IBM Plex Sans Thai", "Segoe UI Emoji", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const w = ctx.measureText(txt).width + fs * 1.2, x = p[0], y = p[1] + sz * 0.45;
      ctx.fillStyle = 'rgba(14,18,40,.72)'; ctx.beginPath(); ctx.roundRect(x - w / 2, y - fs * 0.85, w, fs * 1.7, fs * 0.85); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(txt, x, y);
      ctx.globalCompositeOperation = 'lighter';
    }
    s.last.set(h.id, Float32Array.from(p));
  }
  for (const id of [...s.orbs.keys()]) if (!live.has(id)) s.orbs.delete(id);

  /* a two-hand pose pops its emoji between the hands */
  if (pair) {
    const g = pair.g || '';
    if (g !== (s.pairG || '')) {
      const a = H.find((h) => h.id === pair.ids[0]), b = H.find((h) => h.id === pair.ids[1]);
      if (F.emoji && g && a && b) s.pops.push({ x: (a.palm[0] + b.palm[0]) / 2, y: (a.palm[1] + b.palm[1]) / 2 - Math.max(a.size, b.size) * 0.9, e: gestureEmoji(g), l: 1, s: Math.max(a.size, b.size) * 1.4 });
      s.pairG = g;
    }
  }
  /* particles */
  const P = s.parts, g = o.h * 0.45;
  for (let i = P.length - 1; i >= 0; i--) {
    const q = P[i]; q.l -= dt * q.d;
    if (q.l <= 0) { P[i] = P[P.length - 1]; P.pop(); continue; }
    if (!q.up) q.vy += g * dt;
    q.vx *= 1 - dt * 1.6; q.vy *= 1 - dt * 1.6; q.x += q.vx * dt; q.y += q.vy * dt;
    ctx.globalAlpha = Math.min(1, q.l * 1.6);
    blob(ctx, q.c, q.x, q.y, q.r * (0.6 + q.l * 0.9));
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  /* emoji pops */
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = s.pops.length - 1; i >= 0; i--) {
    const q = s.pops[i]; q.l -= dt * 0.85;
    if (q.l <= 0) { s.pops.splice(i, 1); continue; }
    const t = 1 - q.l, sc = t < 0.14 ? t / 0.14 * 1.25 : 1.25 - Math.min(0.25, (t - 0.14) * 2.5);
    ctx.globalAlpha = Math.min(1, q.l * 2.2);
    ctx.font = `${q.s * sc}px "Segoe UI Emoji", sans-serif`;
    ctx.fillText(q.e, q.x, q.y - t * q.s * 1.1);
  }
  ctx.restore();
}
