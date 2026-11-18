// Animation engine (no DOM): scene → clips → tracks → keyframes, easing (editable cubic-bezier + spring / elastic / bounce),
// players (play / loop / ping-pong / reverse / hold-to-play / hand-driven time) and per-frame evaluation into layer overrides.
// The compositor never sees clips: it asks AV(layer) for a cheap prototype "view" of the layer with animated values on top.
import { T } from './i18n.js';

export const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------------ easing */
// cubic-bezier presets (easings.net) — every one of these can be reshaped with handles
export const BEZ = {
  linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1],
  sineIn: [0.12, 0, 0.39, 0], sineOut: [0.61, 1, 0.88, 1], sineInOut: [0.37, 0, 0.63, 1],
  quadIn: [0.11, 0, 0.5, 0], quadOut: [0.5, 1, 0.89, 1], quadInOut: [0.45, 0, 0.55, 1],
  cubicIn: [0.32, 0, 0.67, 0], cubicOut: [0.33, 1, 0.68, 1], cubicInOut: [0.65, 0, 0.35, 1],
  quartIn: [0.5, 0, 0.75, 0], quartOut: [0.25, 1, 0.5, 1], quartInOut: [0.76, 0, 0.24, 1],
  quintIn: [0.64, 0, 0.78, 0], quintOut: [0.22, 1, 0.36, 1], quintInOut: [0.83, 0, 0.17, 1],
  expoIn: [0.7, 0, 0.84, 0], expoOut: [0.16, 1, 0.3, 1], expoInOut: [0.87, 0, 0.13, 1],
  circIn: [0.55, 0, 1, 0.45], circOut: [0, 0.55, 0.45, 1], circInOut: [0.85, 0, 0.15, 1],
  backIn: [0.36, 0, 0.66, -0.56], backOut: [0.34, 1.56, 0.64, 1], backInOut: [0.68, -0.6, 0.32, 1.6],
};
const bounceOut = (x) => { const n = 7.5625, d = 2.75; if (x < 1 / d) return n * x * x; if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75; if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375; return n * (x -= 2.625 / d) * x + 0.984375; };
const C4 = (2 * Math.PI) / 3, C5 = (2 * Math.PI) / 4.5;
const FN = {
  hold: () => 0,
  elasticIn: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * C4)),
  elasticOut: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * C4) + 1),
  elasticInOut: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? -(Math.pow(2, 20 * x - 10) * Math.sin((20 * x - 11.125) * C5)) / 2 : (Math.pow(2, -20 * x + 10) * Math.sin((20 * x - 11.125) * C5)) / 2 + 1),
  bounceIn: (x) => 1 - bounceOut(1 - x),
  bounceOut,
  bounceInOut: (x) => (x < 0.5 ? (1 - bounceOut(1 - 2 * x)) / 2 : (1 + bounceOut(2 * x - 1)) / 2),
  spring: (x) => (x >= 1 ? 1 : 1 - Math.cos(x * 4.5 * Math.PI) * Math.exp(-x * 6)),
};
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t, dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const e = sx(t) - x; if (Math.abs(e) < 1e-6) return sy(t); const d = dx(t); if (Math.abs(d) < 1e-6) break; t -= e / d; }
    let lo = 0, hi = 1; t = x;
    for (let i = 0; i < 40; i++) { const v = sx(t); if (Math.abs(v - x) < 1e-6) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sy(t);
  };
}
const bezCache = new Map();
function bezFn(cp) {
  const k = cp.join(',');
  let f = bezCache.get(k);
  if (!f) { if (bezCache.size > 400) bezCache.clear(); f = bezier(cp[0], cp[1], cp[2], cp[3]); bezCache.set(k, f); }
  return f;
}
// the curve a keyframe uses towards the next key
export const cpOf = (k) => (k.e === 'bezier' && Array.isArray(k.cp) ? k.cp : BEZ[k.e] || null);
export function easeFn(e, cp) {
  if (e === 'bezier' && cp) return bezFn(cp);
  if (BEZ[e]) return bezFn(BEZ[e]);
  return FN[e] || bezFn(BEZ.linear);
}
export const isEditableEase = (e) => e === 'bezier' || !!BEZ[e];
export const EASE_FAMILIES = () => [
  ['sine', 'Sine'], ['quad', 'Quad'], ['cubic', 'Cubic'], ['quart', 'Quart'], ['quint', 'Quint'], ['expo', 'Expo'], ['circ', 'Circ'],
  ['back', T`เด้งเกิน (Back)`], ['elastic', T`ยืดหยุ่น (Elastic)`], ['bounce', T`กระเด้ง (Bounce)`],
];
export const easeLabel = (e) => ({
  linear: T`เส้นตรง`, ease: T`นุ่มนวล`, hold: T`ค้าง (กระโดด)`, spring: T`สปริง`, bezier: T`กำหนดเอง`,
}[e] || String(e).replace(/(In|Out|InOut)$/, (m) => ' ' + { In: 'In', Out: 'Out', InOut: 'In-Out' }[m]).replace(/^./, (c) => c.toUpperCase()));

/* ------------------------------------------------------------- properties */
// what can be animated: key → { group, label, type: num | color | bool, def, min, max, step, pct, unit, when(L) }
const MEDIA = new Set(['camera', 'screen', 'image', 'video']);
export const GROUPS = () => [['tr', T`ตำแหน่งและขนาด`], ['look', T`รูปลักษณ์`], ['text', T`ข้อความ`], ['shape', T`สีรูปทรง`], ['fx', T`ฟิลเตอร์และสี`], ['crop', T`ครอป`]];
export const PROPS = {};
const P = (key, group, label, o = {}) => { PROPS[key] = { key, group, label, type: 'num', step: 1, ...o }; };
export function defineProps() {
  for (const k of Object.keys(PROPS)) delete PROPS[k];
  const notFx = (L) => L.type !== 'handfx', media = (L) => MEDIA.has(L.type), text = (L) => L.type === 'text', boxy = (L) => L.type !== 'text' && L.type !== 'handfx';
  P('x', 'tr', 'X', { when: notFx, unit: 'px' });
  P('y', 'tr', 'Y', { when: notFx, unit: 'px' });
  P('sc', 'tr', T`สเกล`, { def: 100, min: 0, unit: '%', when: notFx });
  P('sx', 'tr', T`ยืดแนวนอน`, { def: 100, unit: '%', when: notFx });
  P('sy', 'tr', T`ยืดแนวตั้ง`, { def: 100, unit: '%', when: notFx });
  P('rot', 'tr', T`หมุน`, { unit: '°', when: notFx });
  P('w', 'tr', T`ความกว้าง`, { min: 1, unit: 'px', when: (L) => boxy(L) });
  P('h', 'tr', T`ความสูง`, { min: 1, unit: 'px', when: notFx });
  P('op', 'tr', T`ความทึบ`, { min: 0, max: 1, step: 0.01, pct: true, def: 1, when: notFx });
  P('vis', 'tr', T`แสดงผล`, { type: 'bool', def: 1 });
  P('radius', 'look', T`มุมโค้ง`, { min: 0, when: (L) => boxy(L) || (text(L) && L.bg) });
  P('border', 'look', T`ความหนากรอบ`, { min: 0, when: boxy });
  P('borderColor', 'look', T`สีกรอบ`, { type: 'color', when: boxy });
  P('shadow', 'look', T`เงา`, { min: 0, when: notFx });
  P('color', 'text', T`สีตัวอักษร`, { type: 'color', when: text });
  P('reveal', 'text', T`พิมพ์ทีละตัว`, { def: 100, min: 0, max: 100, unit: '%', when: text });
  P('stroke', 'text', T`ขอบตัวอักษร`, { min: 0, step: 0.1, when: text });
  P('strokeColor', 'text', T`สีขอบ`, { type: 'color', when: text });
  P('bgColor', 'text', T`สีพื้น`, { type: 'color', when: (L) => text(L) && L.bg });
  P('fill', 'shape', T`สีเริ่ม`, { type: 'color', when: (L) => L.type === 'shape' });
  P('fill2', 'shape', T`สีปลาย`, { type: 'color', when: (L) => L.type === 'shape' && L.grad });
  P('f.br', 'fx', T`ความสว่าง`, { def: 100, min: 0, unit: '%', when: media });
  P('f.ct', 'fx', T`คอนทราสต์`, { def: 100, min: 0, unit: '%', when: media });
  P('f.sa', 'fx', T`ความสดของสี`, { def: 100, min: 0, unit: '%', when: media });
  P('f.hue', 'fx', T`โทนสี`, { unit: '°', when: media });
  P('f.blur', 'fx', T`เบลอ`, { min: 0, step: 0.1, unit: 'px', when: media });
  P('f.gray', 'fx', T`ขาวดำ`, { min: 0, max: 100, unit: '%', when: media });
  P('f.sepia', 'fx', T`ซีเปีย`, { min: 0, max: 100, unit: '%', when: media });
  P('ai.blur', 'fx', T`เบลอพื้นหลัง AI`, { min: 0, when: (L) => media(L) && L.ai && L.ai.mode === 'blur' });
  P('crop.l', 'crop', T`ครอปซ้าย`, { min: 0, max: 0.96, step: 0.001, pct: true, when: media });
  P('crop.r', 'crop', T`ครอปขวา`, { min: 0, max: 0.96, step: 0.001, pct: true, when: media });
  P('crop.t', 'crop', T`ครอปบน`, { min: 0, max: 0.96, step: 0.001, pct: true, when: media });
  P('crop.b', 'crop', T`ครอปล่าง`, { min: 0, max: 0.96, step: 0.001, pct: true, when: media });
}
defineProps();
export const propsFor = (L) => Object.values(PROPS).filter((p) => !p.when || p.when(L));
export function getV(L, key) {
  const p = PROPS[key], dot = key.indexOf('.');
  let v = dot > 0 ? (L[key.slice(0, dot)] || {})[key.slice(dot + 1)] : L[key];
  if (p && p.type === 'bool') return v === false ? 0 : 1;
  if (v === undefined || v === null) v = p && p.def !== undefined ? p.def : p && p.type === 'color' ? '#ffffff' : 0;
  return v;
}
export function setV(L, key, v) {
  const p = PROPS[key], dot = key.indexOf('.');
  if (p && p.type === 'bool') v = v >= 0.5;
  if (dot > 0) { const a = key.slice(0, dot); L[a] = { ...(L[a] || {}), [key.slice(dot + 1)]: v }; } else L[key] = v;
}
export function fmtV(key, v) {
  const p = PROPS[key]; if (!p) return String(v);
  if (p.type === 'color') return String(v);
  if (p.type === 'bool') return v >= 0.5 ? T`แสดง` : T`ซ่อน`;
  if (p.pct) return Math.round(v * 1000) / 10 + '%';
  const r = p.step < 1 ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10;
  return r + (p.unit && p.unit !== 'px' ? p.unit : '');
}

/* ------------------------------------------------------------ colour mix */
const rgbCache = new Map();
function rgb(hex) {
  let c = rgbCache.get(hex);
  if (!c) { const h = String(hex).replace('#', ''), f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h.padEnd(6, '0'); c = [parseInt(f.slice(0, 2), 16) || 0, parseInt(f.slice(2, 4), 16) || 0, parseInt(f.slice(4, 6), 16) || 0]; if (rgbCache.size > 500) rgbCache.clear(); rgbCache.set(hex, c); }
  return c;
}
const hx = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
export function mixColor(a, b, w) { const p = rgb(a), q = rgb(b); return '#' + hx(p[0] + (q[0] - p[0]) * w) + hx(p[1] + (q[1] - p[1]) * w) + hx(p[2] + (q[2] - p[2]) * w); }

/* ------------------------------------------------------------- evaluation */
export function keyIndex(keys, t) { // last key with k.t <= t (−1 when before the first)
  let lo = 0, hi = keys.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (keys[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
export function evalTrack(tr, t) {
  const k = tr.keys, n = k.length; if (!n) return undefined;
  if (n === 1 || t <= k[0].t) return k[0].v;
  if (t >= k[n - 1].t) return k[n - 1].v;
  const i = keyIndex(k, t), a = k[i], b = k[i + 1], p = PROPS[tr.prop];
  if (a.e === 'hold' || (p && p.type === 'bool')) return a.v;
  const w = easeFn(a.e, a.cp)((t - a.t) / Math.max(1e-6, b.t - a.t));
  if (typeof a.v === 'string') return mixColor(a.v, b.v, clamp(w, 0, 1));
  return a.v + (b.v - a.v) * w;
}

/* ------------------------------------------------------------------ model */
export function newClip(name, extra = {}) {
  return { id: uid(), name, dur: 3, fps: 30, loop: 'once', speed: 1, mode: 'abs', end: 'hold', auto: false, next: '', hot: '', hotVerb: 'play',
    drive: { src: 'none', side: 'any', min: 20, max: 80, invert: false, smooth: 30, lost: 'hold', gest: '', grab: false }, tracks: [], events: [], ...extra };
}
export function fixClip(c) {
  const d = newClip(c.name || 'clip');
  for (const k of Object.keys(d)) if (c[k] === undefined) c[k] = d[k];
  c.drive = { ...d.drive, ...(c.drive || {}) };
  if (!Array.isArray(c.tracks)) c.tracks = [];
  if (!Array.isArray(c.events)) c.events = [];
  // a keyframe without a usable value (an old bug saved "nothing") must not make a layer vanish: drop it
  for (const tr of c.tracks) tr.keys = (tr.keys || []).filter((k) => k && Number.isFinite(k.t) && k.v !== undefined && k.v !== null && !(typeof k.v === 'number' && !Number.isFinite(k.v)));
  c.tracks = c.tracks.filter((tr) => tr.keys.length);
  return c;
}
export const clipsOf = (scene) => (scene.clips || (scene.clips = []));
export const findTrack = (c, layer, prop) => c.tracks.find((t) => t.layer === layer && t.prop === prop) || null;
export function ensureTrack(c, layer, prop) {
  let tr = findTrack(c, layer, prop);
  if (!tr) { tr = { id: uid(), layer, prop, keys: [] }; c.tracks.push(tr); }
  return tr;
}
export const snapT = (c, t) => Math.round(t * c.fps) / c.fps;
export const sortKeys = (tr) => tr.keys.sort((a, b) => a.t - b.t);
export const keyAt = (c, tr, t) => (tr ? tr.keys.find((k) => Math.abs(k.t - t) < 0.5 / c.fps) || null : null);
export function setKey(c, tr, t, v, ease) {
  if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) { if (!tr.keys.length) { const i = c.tracks.indexOf(tr); if (i >= 0) c.tracks.splice(i, 1); } return null; } // never store "no value"
  t = Math.max(0, snapT(c, t));
  let k = keyAt(c, tr, t);
  if (k) k.v = v;
  else { k = { t, v, e: ease || ed.defEase }; tr.keys.push(k); sortKeys(tr); }
  return k;
}
export function removeKey(c, tr, k) { const i = tr.keys.indexOf(k); if (i >= 0) tr.keys.splice(i, 1); if (!tr.keys.length) c.tracks.splice(c.tracks.indexOf(tr), 1); }
export const allTimes = (c) => [...new Set(c.tracks.flatMap((t) => t.keys.map((k) => k.t)))].sort((a, b) => a - b);

/* ------------------------------------------------------------ editor state */
// shared by the animation UI modules (selection, playhead, view options)
let saved = {}; try { saved = JSON.parse(localStorage.getItem('prismcam.anim') || '{}') || {}; } catch { /* */ }
export const ed = {
  mode: false, clipId: '', selKeys: new Set(), selTracks: new Set(), view: 'dope', zoom: 150, scroll: 0,
  tlH: saved.tlH || 290, autokey: saved.autokey ?? true, snap: saved.snap ?? true, path: saved.path ?? true,
  defEase: saved.defEase || 'sineInOut', tab: 'keys', expanded: new Set(), gHide: new Set(), clip: null, driveTest: false, presetDur: saved.presetDur || 0.6, onion: !!saved.onion,
};
export function saveEd() { try { localStorage.setItem('prismcam.anim', JSON.stringify({ tlH: ed.tlH, autokey: ed.autokey, snap: ed.snap, path: ed.path, defEase: ed.defEase, presetDur: ed.presetDur, onion: ed.onion })); } catch { /* */ } }

/* ---------------------------------------------------------------- players */
export const eng = { players: new Map(), ov: new Map(), views: new Map(), suspended: new Set(), sceneId: '', last: 0, drive: new Map(), ver: 0, crossed: null, areaVis: new Map(), grab: new Map() };
export function player(c) {
  let p = eng.players.get(c.id);
  if (!p) { p = { t: 0, dir: 1, playing: false, active: false, hold: false, dv: null }; eng.players.set(c.id, p); }
  return p;
}
export function play(c, p, env, from = true) {
  p.dir = 1; p.hold = false; p.playing = true; p.active = true;
  if (from || p.t >= c.dur - 1e-4) { p.t = 0; if (env && env.fire) for (const ev of c.events) if (ev.t <= 1e-4) env.fire(ev.action); }
}
export function stop(c, p) { p.playing = false; p.active = false; p.t = 0; p.dir = 1; p.hold = false; }
export function command(scene, verb, id, phase, env) {
  const c = clipsOf(scene).find((x) => x.id === id); if (!c) return false;
  const p = player(c);
  if (phase === 'end') { if (verb === 'hold') { p.dir = -1; p.playing = true; p.hold = true; } return true; }
  if (verb === 'play') play(c, p, env, true);
  else if (verb === 'toggle') { if (p.playing) p.playing = false; else play(c, p, env, !p.active || p.t >= c.dur - 1e-4); }
  else if (verb === 'stop') stop(c, p);
  else if (verb === 'pause') p.playing = false;
  else if (verb === 'reverse') { if (!p.active) { p.t = c.dur; p.active = true; } p.dir = -p.dir || -1; if (p.dir > 0 && p.t >= c.dur) p.t = 0; if (p.dir < 0 && p.t <= 0) p.t = c.dur; p.playing = true; }
  else if (verb === 'hold') { p.hold = false; p.dir = 1; p.active = true; p.playing = true; if (p.t >= c.dur) p.t = 0; }
  return true;
}
function fireRange(c, a, b, fire) {
  if (!fire || !c.events.length || a === b) return;
  const fwd = b > a;
  for (const ev of c.events) if (fwd ? ev.t > a && ev.t <= b : ev.t < a && ev.t >= b) { fire(ev.action); if (eng.crossed) eng.crossed(ev); }
}
function finish(c, p, env) {
  p.playing = false;
  if (p.dir < 0) { if (p.hold || c.end === 'reset') { p.active = false; p.t = 0; } p.hold = false; p.dir = 1; return; }
  if (c.end === 'reset') { p.active = false; p.t = 0; }
  if (c.next && env && env.scene) { const n = clipsOf(env.scene).find((x) => x.id === c.next); if (n && n !== c) play(n, player(n), env, true); }
}
export function advance(c, p, dt, env) {
  const d = Math.max(1 / c.fps, c.dur), fire = env && env.fire;
  const t0 = p.t; let t = t0 + dt * p.dir;
  if (t > d || t < 0) {
    if (c.loop === 'loop' && !p.hold) {
      fireRange(c, t0, p.dir > 0 ? d : 0, fire);
      t = ((t % d) + d) % d;
      fireRange(c, p.dir > 0 ? 0 : d, t, fire);
      p.t = t; return;
    }
    if (c.loop === 'pingpong' && !p.hold) {
      fireRange(c, t0, p.dir > 0 ? d : 0, fire);
      t = p.dir > 0 ? 2 * d - t : -t; p.dir = -p.dir; t = clamp(t, 0, d);
      p.t = t; return;
    }
    t = clamp(t, 0, d); fireRange(c, t0, t, fire); p.t = t; finish(c, p, env); return;
  }
  fireRange(c, t0, t, fire); p.t = t;
}

/* ------------------------------------------------------- hand-driven time */
export const DRIVES = () => [['none', T`ไม่ใช้`], ['handx', T`ตำแหน่งมือ ซ้าย ↔ ขวา`], ['handy', T`ตำแหน่งมือ ล่าง ↕ บน`], ['pinch', T`ระยะจีบ โป้ง ↔ ชี้`], ['size', T`ระยะมือใกล้ ↔ ไกลกล้อง`], ['tilt', T`การเอียงมือ`], ['spread', T`ระยะห่างสองมือ`]];
export function driveRaw(D, env) {
  const H = env.hands, o = env.out(); if (!H || !H.length) return null;
  const G = D.gest || '', pairG = G.startsWith('pair:');
  if (pairG && env.pair !== G) return null; // a two-hand pose: both hands must make it
  const okG = (x) => !G || pairG || x.g === G;
  if (D.src === 'spread') { if (H.length < 2 || !okG(H[0]) || !okG(H[1])) return null; return Math.hypot(H[0].palm[0] - H[1].palm[0], H[0].palm[1] - H[1].palm[1]) / o.w; }
  let h = null; for (const x of H) { if ((D.side === 'left' && x.side !== 'L') || (D.side === 'right' && x.side !== 'R') || !okG(x)) continue; if (!h || x.tr.born < h.tr.born) h = x; }
  if (!h) return null;
  if (D.src === 'handx') return h.palm[0] / o.w;
  if (D.src === 'handy') return 1 - h.palm[1] / o.h;
  if (D.src === 'pinch') return Math.hypot(h.p[8] - h.p[16], h.p[9] - h.p[17]) / Math.max(8, h.size) / 1.2;
  if (D.src === 'size') return h.size / o.h / 0.6;
  if (D.src === 'tilt') return (Math.atan2(Math.sin(h.ang), Math.cos(h.ang)) + Math.PI / 2) / Math.PI;
  return null;
}
function drive(c, p, env, dt) {
  const D = c.drive, raw = driveRaw(D, env);
  // no hand: 'hide' = the clip lets go; 'hold' / 'reset' keep it on (before any hand was seen that is the start pose at 0 s)
  if (raw === null) { eng.drive.set(c.id, null); eng.grab.delete(c.id); if (D.lost === 'reset') { p.t += (0 - p.t) * Math.min(1, dt * 6); if (p.t < 1e-3) { p.t = 0; } } if (D.lost === 'hide') p.active = false; else p.active = true; return; }
  let u = (raw * 100 - D.min) / Math.max(1, D.max - D.min); u = clamp(u, 0, 1); if (D.invert) u = 1 - u;
  eng.drive.set(c.id, { raw, u });
  let target = u * c.dur;
  if (D.grab) { // grab & drag: time moves from where it was when the pose started, by how far the hand moved since
    let g = eng.grab.get(c.id); if (!g) { g = { u0: u, t0: p.t }; eng.grab.set(c.id, g); }
    target = clamp(g.t0 + (u - g.u0) * c.dur, 0, c.dur);
  }
  const tau = (D.smooth || 0) / 100 * 0.35;
  p.t = tau <= 0 ? target : p.t + (target - p.t) * (1 - Math.exp(-dt / tau));
  p.active = true; p.playing = false;
}

/* -------------------------------------------------------------- per frame */
// env: { scene, hands, out(), byId(id), fire(action) }
export function frame(scene, now, env) {
  const dt = eng.last ? Math.min(0.1, (now - eng.last) / 1000) : 0; eng.last = now;
  const clips = clipsOf(scene);
  if (scene.id !== eng.sceneId) { // a new scene: everything starts from rest, autoplay clips start
    eng.sceneId = scene.id; eng.players.clear();
    if (!ed.mode) for (const c of clips) if (c.auto) play(c, player(c), env, true);
  }
  eng.ov.clear(); eng.views.clear();
  if (!ed.mode) for (const c of clips) { // a clip of an area's own timeline: stops while the area is hidden, restarts when it appears
    if (!c.area) continue;
    const A = env.byId(c.area), shown = !!(A && A.vis), was = eng.areaVis.get(c.id);
    if (was !== undefined && shown !== was) { const p = player(c); if (!shown) stop(c, p); else if (c.auto) play(c, p, env, true); }
    eng.areaVis.set(c.id, shown);
  }
  for (const c of clips) {
    const editing = ed.mode && c.id === ed.clipId;
    if (ed.mode && !editing) continue;
    const p = player(c);
    if (c.drive && c.drive.src !== 'none' && (!ed.mode || (editing && ed.driveTest))) drive(c, p, env, dt);
    else if (p.playing) advance(c, p, dt * (c.speed || 1), editing ? { fire: null } : env);
    if (!editing && !p.active) continue;
    applyClip(c, p.t, env);
  }
}
export function applyClip(c, t, env) {
  const add = c.mode === 'add';
  for (const tr of c.tracks) {
    if (tr.mute || !tr.keys.length) continue;
    const prop = PROPS[tr.prop]; if (!prop) continue;
    const L = env.byId(tr.layer); if (!L) continue;
    let o = eng.ov.get(L.id); if (!o) { o = {}; eng.ov.set(L.id, o); }
    const v = evalTrack(tr, t);
    if (add && prop.type === 'num') o[tr.prop] = (o[tr.prop] !== undefined ? o[tr.prop] : getV(L, tr.prop)) + v;
    else o[tr.prop] = v;
  }
}
// the layer as it should be drawn now (prototype view; reads fall through to the layer itself)
export function AV(L) {
  const o = eng.ov.get(L.id);
  if (!o || eng.suspended.has(L.id)) return L;
  let V = eng.views.get(L.id);
  if (!V) { V = makeView(L, o); eng.views.set(L.id, V); }
  return V;
}
function makeView(L, o) {
  const V = Object.create(L);
  for (const key in o) {
    let v = o[key];
    const p = PROPS[key];
    if (p && p.type === 'num') { if (p.min !== undefined) v = Math.max(p.min, v); if (p.max !== undefined) v = Math.min(p.max, v); }
    const dot = key.indexOf('.');
    if (dot > 0) { const a = key.slice(0, dot); if (!Object.prototype.hasOwnProperty.call(V, a)) V[a] = { ...(L[a] || {}) }; V[a][key.slice(dot + 1)] = v; }
    else if (p && p.type === 'bool') V[key] = v >= 0.5;
    else V[key] = v;
  }
  if (V.crop && Object.prototype.hasOwnProperty.call(V, 'crop')) { const c = V.crop; if (c.l + c.r > 0.96) c.r = 0.96 - c.l; if (c.t + c.b > 0.96) c.b = 0.96 - c.t; }
  return V;
}
// scale factors of a (viewed) layer
export const kxOf = (L) => ((L.sc ?? 100) * (L.sx ?? 100)) / 10000;
export const kyOf = (L) => ((L.sc ?? 100) * (L.sy ?? 100)) / 10000;

/* ----------------------------------------------------------------- presets */
// each preset → { prop: [[t (0..1 of duration), value(b) , ease]] } where b(key) is the layer's value at the playhead
export const PRESETS = () => [
  ['in', T`เข้า`, [
    ['fadeIn', T`ค่อยๆ ปรากฏ`], ['popIn', T`เด้งขึ้นมา`], ['zoomIn', T`ซูมเข้า`], ['slideL', T`เลื่อนจากซ้าย`], ['slideR', T`เลื่อนจากขวา`],
    ['slideT', T`เลื่อนจากบน`], ['slideB', T`เลื่อนจากล่าง`], ['drop', T`ตกลงมาเด้ง`], ['spinIn', T`หมุนเข้า`], ['blurIn', T`ชัดขึ้นจากเบลอ`], ['type', T`พิมพ์ทีละตัว`],
  ]],
  ['out', T`ออก`, [
    ['fadeOut', T`ค่อยๆ หายไป`], ['popOut', T`ยุบหายไป`], ['zoomOut', T`ซูมออก`], ['slideOutL', T`เลื่อนออกซ้าย`], ['slideOutR', T`เลื่อนออกขวา`], ['slideOutB', T`ร่วงลงล่าง`], ['spinOut', T`หมุนออก`],
  ]],
  ['em', T`เน้น`, [
    ['pulse', T`ชีพจร`], ['heart', T`หัวใจเต้น`], ['shake', T`สั่น`], ['wobble', T`โยกเยก`], ['jelly', T`เยลลี่`], ['bounce', T`กระโดด`], ['flash', T`กะพริบ`], ['spin', T`หมุนรอบ`], ['tada', T`ทาดา!`],
  ]],
  ['loop', T`วนลูป`, [['float', T`ลอยขึ้นลง`], ['sway', T`แกว่งไปมา`], ['breathe', T`หายใจ`], ['orbit', T`โคจรเป็นวง`], ['rainbow', T`ไล่โทนสี`]]],
];
export const PRESET_DUR = { pulse: 1, heart: 1, shake: 0.6, wobble: 1, jelly: 0.9, bounce: 0.9, flash: 1, spin: 1, tada: 1, float: 2, sway: 2, breathe: 2.4, orbit: 2.4, rainbow: 3, type: 1.2, drop: 0.9 };
export function presetKeys(name, L, b, o) {
  const x = b('x'), y = b('y'), w = L.w * kxOf(L), h = L.h * kyOf(L), op = b('op'), sc = b('sc'), r = b('rot'), sx = b('sx'), sy = b('sy');
  const K = {
    fadeIn: { op: [[0, 0, 'cubicOut'], [1, op || 1]] },
    fadeOut: { op: [[0, op, 'cubicIn'], [1, 0]] },
    popIn: { sc: [[0, 0, 'backOut'], [1, sc]], op: [[0, 0, 'linear'], [0.35, op || 1]] },
    popOut: { sc: [[0, sc, 'backIn'], [1, 0]], op: [[0.65, op, 'linear'], [1, 0]] },
    zoomIn: { sc: [[0, sc * 2.4, 'expoOut'], [1, sc]], op: [[0, 0, 'cubicOut'], [0.6, op || 1]] },
    zoomOut: { sc: [[0, sc, 'expoIn'], [1, sc * 2.4]], op: [[0.4, op, 'cubicIn'], [1, 0]] },
    slideL: { x: [[0, -w / 2 - 20, 'cubicOut'], [1, x]] },
    slideR: { x: [[0, o.w + w / 2 + 20, 'cubicOut'], [1, x]] },
    slideT: { y: [[0, -h / 2 - 20, 'cubicOut'], [1, y]] },
    slideB: { y: [[0, o.h + h / 2 + 20, 'cubicOut'], [1, y]] },
    slideOutL: { x: [[0, x, 'cubicIn'], [1, -w / 2 - 20]] },
    slideOutR: { x: [[0, x, 'cubicIn'], [1, o.w + w / 2 + 20]] },
    slideOutB: { y: [[0, y, 'backIn'], [1, o.h + h / 2 + 20]] },
    drop: { y: [[0, -h / 2 - 20, 'bounceOut'], [1, y]] },
    spinIn: { rot: [[0, r - 360, 'cubicOut'], [1, r]], sc: [[0, 0, 'cubicOut'], [1, sc]] },
    spinOut: { rot: [[0, r, 'cubicIn'], [1, r + 360]], sc: [[0, sc, 'cubicIn'], [1, 0]] },
    blurIn: MEDIA.has(L.type) ? { 'f.blur': [[0, 24, 'cubicOut'], [1, b('f.blur')]], op: [[0, 0, 'cubicOut'], [0.5, op || 1]] } : { op: [[0, 0, 'cubicOut'], [1, op || 1]], sc: [[0, sc * 1.15, 'cubicOut'], [1, sc]] },
    type: L.type === 'text' ? { reveal: [[0, 0, 'linear'], [1, 100]] } : { op: [[0, 0, 'linear'], [1, op || 1]] },
    pulse: { sc: [[0, sc, 'sineInOut'], [0.5, sc * 1.12, 'sineInOut'], [1, sc]] },
    heart: { sc: [[0, sc, 'quadOut'], [0.14, sc * 1.18, 'quadIn'], [0.28, sc, 'quadOut'], [0.42, sc * 1.14, 'quadIn'], [0.7, sc]] },
    shake: { x: [[0, x, 'linear'], [0.15, x - 14, 'linear'], [0.3, x + 14, 'linear'], [0.45, x - 10, 'linear'], [0.6, x + 10, 'linear'], [0.8, x - 4, 'linear'], [1, x]] },
    wobble: { rot: [[0, r, 'sineInOut'], [0.18, r - 12, 'sineInOut'], [0.36, r + 10, 'sineInOut'], [0.54, r - 6, 'sineInOut'], [0.74, r + 3, 'sineInOut'], [1, r]] },
    jelly: { sx: [[0, sx, 'sineInOut'], [0.3, sx * 1.25, 'sineInOut'], [0.45, sx * 0.75, 'sineInOut'], [0.6, sx * 1.15, 'sineInOut'], [0.75, sx * 0.95, 'sineInOut'], [0.9, sx * 1.05, 'sineInOut'], [1, sx]],
      sy: [[0, sy, 'sineInOut'], [0.3, sy * 0.75, 'sineInOut'], [0.45, sy * 1.25, 'sineInOut'], [0.6, sy * 0.85, 'sineInOut'], [0.75, sy * 1.05, 'sineInOut'], [0.9, sy * 0.95, 'sineInOut'], [1, sy]] },
    bounce: { y: [[0, y, 'quadOut'], [0.4, y - h * 0.35, 'bounceOut'], [1, y]], sy: [[0, sy, 'quadOut'], [0.15, sy * 0.88, 'quadOut'], [0.35, sy * 1.05, 'quadOut'], [0.6, sy]] },
    flash: { op: [[0, op, 'hold'], [0.25, 0, 'hold'], [0.5, op, 'hold'], [0.75, 0, 'hold'], [1, op]] },
    spin: { rot: [[0, r, 'cubicInOut'], [1, r + 360]] },
    tada: { sc: [[0, sc, 'quadOut'], [0.1, sc * 0.9, 'quadOut'], [0.3, sc * 1.1, 'linear'], [0.9, sc * 1.1, 'quadOut'], [1, sc]],
      rot: [[0, r, 'linear'], [0.1, r - 3, 'linear'], [0.3, r + 3, 'linear'], [0.4, r - 3, 'linear'], [0.5, r + 3, 'linear'], [0.6, r - 3, 'linear'], [0.7, r + 3, 'linear'], [0.8, r - 3, 'linear'], [0.9, r + 3, 'linear'], [1, r]] },
    float: { y: [[0, y, 'sineInOut'], [0.5, y - Math.max(10, h * 0.08), 'sineInOut'], [1, y]] },
    sway: { rot: [[0, r - 6, 'sineInOut'], [0.5, r + 6, 'sineInOut'], [1, r - 6]] },
    breathe: { sc: [[0, sc, 'sineInOut'], [0.5, sc * 1.06, 'sineInOut'], [1, sc]], op: [[0, op, 'sineInOut'], [0.5, Math.max(0, op - 0.15), 'sineInOut'], [1, op]] },
    orbit: { x: [[0, x + 30, 'sineInOut'], [0.25, x, 'sineInOut'], [0.5, x - 30, 'sineInOut'], [0.75, x, 'sineInOut'], [1, x + 30]], y: [[0, y, 'sineInOut'], [0.25, y - 30, 'sineInOut'], [0.5, y, 'sineInOut'], [0.75, y + 30, 'sineInOut'], [1, y]] },
    rainbow: MEDIA.has(L.type) ? { 'f.hue': [[0, b('f.hue'), 'linear'], [1, b('f.hue') + 360]] }
      : L.type === 'text' ? { color: [[0, '#ff6b8b', 'linear'], [0.2, '#ffc75f', 'linear'], [0.4, '#7fe3d0', 'linear'], [0.6, '#7c8cff', 'linear'], [0.8, '#c79bff', 'linear'], [1, '#ff6b8b']] }
        : L.type === 'shape' ? { fill: [[0, '#ff6b8b', 'linear'], [0.33, '#7fe3d0', 'linear'], [0.66, '#7c8cff', 'linear'], [1, '#ff6b8b']] } : { borderColor: [[0, '#ff6b8b', 'linear'], [0.33, '#7fe3d0', 'linear'], [0.66, '#7c8cff', 'linear'], [1, '#ff6b8b']] },
  };
  return K[name] || null;
}

// what a trigger can do to a clip (gesture bindings, hotkeys, timeline events)
export const ANIM_VERBS = () => [['play', T`เล่นตั้งแต่ต้น`], ['toggle', T`เล่น / หยุดชั่วคราว`], ['stop', T`หยุดและรีเซ็ต`], ['reverse', T`เล่นย้อนกลับ`], ['hold', T`เล่นขณะค้างท่า แล้วย้อนกลับเมื่อเลิก`]];
