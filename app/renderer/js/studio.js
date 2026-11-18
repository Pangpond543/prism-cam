// Prism Cam studio: scenes → layers → 2D compositor, free transform gizmo, layer list and property panel.
import { api, native, bus, T, toast, htmlBox, promptBox, ctxMenu, esc, clamp, $, remember, recall } from './core.js';
import { icon } from './icons.js';
import { createProc, loadSegmenter, segment, segState } from './fx.js';
import { perf, renderScale, liveFps, resetCap, segEvery, ema, frameDone } from './perf.js';
import { hands, feedHands, poseHands, stopHands, pruneHands, setHandOptions, BONES, gestureList, gestureName, pairList } from './hands.js';
import { customList, modelReady } from './handml.js';
import { drawHandFx, dropHandFx, clearHandDrawing, FX_DEFAULT } from './handfx.js';
import { frame as animFrame, AV, kxOf, kyOf, uid as auid, PROPS as APROPS, fixClip, evalTrack } from './anim-core.js';

// GPU canvas when the graphics chip converts the camera picture (perf.js nv12: no per-frame CPU read-back at all);
// CPU canvas otherwise (the RGBA path reads every frame back). The old note "a GPU canvas made AMD drivers time out"
// dates from the wrong-exe hunt (pitfalls) and was never confirmed. Switching takes effect on the next start.
const canvas = $('scene'), ctx = canvas.getContext('2d', { willReadFrequently: !perf.gpuOn, alpha: false });
const box = $('scene-box'), gizmo = $('gizmo'), guides = $('guides');
const uid = () => Math.random().toString(36).slice(2, 9);
const MEDIA = new Set(['camera', 'screen', 'image', 'video']);
const TYPE_ICON = { camera: 'camera', screen: 'screen', image: 'image', video: 'film', text: 'text', shape: 'shape', frame: 'frame', handfx: 'hand', area: 'area' };
const typeLabel = (t) => ({ camera: T`กล้อง`, screen: T`หน้าจอ`, image: T`รูปภาพ`, video: T`วิดีโอ`, text: T`ข้อความ`, shape: T`รูปทรง`, frame: T`กรอบ`, handfx: T`เอฟเฟกต์มือ`, area: T`พื้นที่แอนิเมชัน` }[t] || t);

/* ------------------------------------------------------------------ project */
// hand tracking settings live in the project (saved with it, but not part of undo)
const HAND_CFG = { on: false, src: '', n: 2, gpu: true, smooth: 50, predict: 70, swap: false, overlay: true, binds: [], poses: [], mouse: { hand: 'any', zone: 55, mirror: true, glide: 30, click: true, rclick: true, scroll: true, sens: 50 } };
const HAND_DEF = { on: false, side: 'any', pt: 'palm', rot: false, scale: false, ref: 0, dx: 0, dy: 0, lost: 'hide', gest: '', smooth: 25 };
const fresh = () => ({ v: 1, out: { w: 1280, h: 720, fps: 30 }, cur: 0, scenes: [{ id: uid(), name: T`ซีน 1`, layers: [] }], assets: {}, hand: JSON.parse(JSON.stringify(HAND_CFG)) });
function ensureHand() {
  const h = project.hand = { ...JSON.parse(JSON.stringify(HAND_CFG)), ...(project.hand || {}) };
  h.mouse = { ...HAND_CFG.mouse, ...(h.mouse || {}) };
  if (!Array.isArray(h.binds)) h.binds = [];
  if (!Array.isArray(h.poses)) h.poses = [];
  applyHandCfg();
}
function applyHandCfg() { const h = project.hand; setHandOptions({ hands: h.n, gpu: h.gpu, smooth: h.smooth, predict: h.predict, swap: h.swap, poses: h.poses }); }
export let project = fresh();
const out = () => project.out;
const scene = () => project.scenes[project.cur] || project.scenes[0];
// layers can live inside an "animation area" (type 'area', its own list in L.kids). scope = the area being edited
const root = () => scene().layers;
let scope = null;
const findIn = (arr, id) => { for (const l of arr) { if (l.id === id) return l; if (l.kids) { const r = findIn(l.kids, id); if (r) return r; } } return null; };
const byId = (id) => (id ? findIn(root(), id) : null);
const curArea = () => { const A = scope && byId(scope); return A && A.type === 'area' ? A : null; };
const layers = () => { const A = curArea(); return A ? A.kids : root(); };   // the list being edited · index 0 = bottom
function allOf(arr, acc = []) { for (const l of arr) { acc.push(l); if (l.kids) allOf(l.kids, acc); } return acc; }
const allLayers = (s = scene()) => allOf(s.layers);
// the area a layer sits in (null = the main layers, undefined = not in this scene)
function parentOf(id, arr = root(), p = null) { for (const l of arr) { if (l.id === id) return p; if (l.kids) { const r = parentOf(id, l.kids, l); if (r !== undefined) return r; } } return undefined; }
const listOf = (L) => { const P = parentOf(L.id); return P ? P.kids : root(); };
// top-first rows with their depth (for lists that show areas and what is inside them)
function tree(arr = root(), d = 0, acc = []) { for (const L of arr.slice().reverse()) { acc.push({ L, d }); if (L.kids) tree(L.kids, d + 1, acc); } return acc; }
// every layer knows its area (not saved: JSON skips non-enumerable fields)
function linkKids(arr, p = null) { for (const l of arr) { if (l._area !== p) Object.defineProperty(l, '_area', { value: p, writable: true, configurable: true, enumerable: false }); if (l.kids) linkKids(l.kids, l); } }
let selId = null, cropMode = false, selSet = new Set(); // selId = primary (the one the panels show), selSet = everything selected
const sel = () => byId(selId);
// keep the set in step with the primary id (other code only ever sets selId)
function syncSel() {
  if (!selId || !byId(selId)) { selId = null; selSet.clear(); return; }
  if (!selSet.has(selId)) selSet = new Set([selId]);
  for (const id of [...selSet]) if (!byId(id)) selSet.delete(id);
}
const sels = () => { syncSel(); return layers().filter((l) => selSet.has(l.id)); };
// animation mode hooks: a stage edit (drag / resize / rotate / wheel / arrows) starts and ends — the animation editor turns it into keyframes
export const hooks = { begin: null, end: null, rest: null }; // rest(L) = a layer's values before the running animation edit

const rt = new Map();        // layer id → { el, ready, proc, mask, pending, url }
const cams = new Map();      // deviceId → { stream, video, promise }

/* history — three zones (each keeps its own stack, one Ctrl+Z undoes the newest change of any of them):
   studio = stage, layers and their properties · anim = animation clips · hand = hand-gesture settings.
   (Assets are kept out of the snapshots — they never change.) */
const ZONES = ['studio', 'anim', 'hand'];
const part = {
  studio: () => JSON.stringify({ cur: project.cur, out: project.out, scenes: project.scenes.map(({ clips, ...x }) => x) }),
  anim: () => JSON.stringify(project.scenes.map((x) => [x.id, x.clips || []])),
  hand: () => JSON.stringify(project.hand),
};
const last = { studio: '', anim: '', hand: '' }, undoS = { studio: [], anim: [], hand: [] }, redoS = { studio: [], anim: [], hand: [] };
let hseq = 0, saveTimer = 0, handTimer = 0;
const rebase = (...zs) => { for (const z of zs.length ? zs : ZONES) last[z] = part[z](); };
const undoBtn = () => { const b = $('btn-undo'); if (b) b.disabled = !ZONES.some((z) => undoS[z].length); };
function record(zs) {
  const link = ++hseq; let n = 0;
  for (const z of zs) {
    const x = part[z](); if (x === last[z]) continue;
    undoS[z].push({ s: last[z], link }); if (undoS[z].length > 80) undoS[z].shift();
    redoS[z].length = 0; last[z] = x; n++;
  }
  if (n) undoBtn();
  return n;
}
export function commit() { syncAreas(); if (record(ZONES)) queueSave(); }
const commitNow = () => commit();
// hand settings change through many small controls: gather a burst of them into one undo step
function touch() { queueSave(); clearTimeout(handTimer); handTimer = setTimeout(() => record(['hand']), 400); }
function applyPart(z, x) {
  const o = JSON.parse(x);
  if (z === 'studio') {
    const keep = new Map(project.scenes.map((c) => [c.id, c.clips]));
    project.cur = o.cur; project.out = o.out;
    project.scenes = o.scenes.map((c) => (keep.get(c.id) ? { ...c, clips: keep.get(c.id) } : c));
  } else if (z === 'anim') { const m = new Map(o); for (const c of project.scenes) if (m.has(c.id)) c.clips = m.get(c.id); }
  else { project.hand = o; ensureHand(); bus.emit('hand:cfg'); bus.emit('hand:binds'); }
  last[z] = x;
}
const ZNAME = () => ({ studio: T`เวทีและเลเยอร์`, anim: T`แอนิเมชัน`, hand: T`ท่ามือ` });
function step(zs, back) {
  clearTimeout(handTimer); record(['hand']);
  const from = back ? undoS : redoS, to = back ? redoS : undoS;
  let link = -1; for (const z of zs) { const e = from[z][from[z].length - 1]; if (e && e.link > link) link = e.link; }
  const where = zs.length === 1 ? ZNAME()[zs[0]] + ': ' : '';
  if (link < 0) { toast(where + (back ? T`ไม่มีอะไรให้ย้อนกลับแล้ว` : T`ไม่มีอะไรให้ทำซ้ำ`)); return; }
  const nl = ++hseq, done = [];
  for (const z of ZONES) { const a = from[z], e = a[a.length - 1]; if (!e || e.link !== link) continue; a.pop(); to[z].push({ s: last[z], link: nl }); applyPart(z, e.s); done.push(z); }
  if (done.includes('studio') || done.includes('anim')) { syncSel(); applyOut(); syncRuntime(); refreshAll(); }
  queueSave(); undoBtn();
  toast((back ? T`ย้อนกลับ` : T`ทำซ้ำ`) + ' · ' + done.map((z) => ZNAME()[z]).join(' + '));
}
// element under the mouse (overStage: Ctrl+C / V on the stage)
let hoverEl = null;
addEventListener('pointermove', (e) => { hoverEl = e.target; }, { capture: true, passive: true });
// Ctrl+Z undoes the newest change wherever it was made (stage, layers, animation, hand settings) — picking the zone
// under the mouse made Ctrl+Z "not stick" whenever the pointer rested over a different panel than the last edit.
// The toast says which part was undone.
export function undo() { step(ZONES, true); }
export function redo() { step(ZONES, false); }
// clicking anything else ends typing in a text box: otherwise Ctrl+Z kept going to that box's own undo
// (the stage and the timeline take the pointer without moving the focus)
addEventListener('pointerdown', (e) => {
  const a = document.activeElement;
  if (a && a !== document.body && a.matches && a.matches('input, textarea, [contenteditable]') && !a.contains(e.target) && !(e.target.closest && e.target.closest('label') === a.closest('label') && a.closest('label'))) a.blur();
}, true);
addEventListener('focusin', (e) => { if (e.target) e.target._typed = false; }, true);
addEventListener('input', (e) => { if (e.target && !e.target._scrub) e.target._typed = true; }, true);
// Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z everywhere (text boxes keep their own typing undo)
addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase(); if (k !== 'z' && k !== 'y') return;
  if (!$('modal').classList.contains('hidden')) return;
  const t = e.target;
  // a text box keeps its own typing-undo only while you have typed into it; a number box you just clicked → the app's undo
  if (t && t.closest && t._typed && (t.closest('textarea, [contenteditable=""], [contenteditable="true"]') || (t.matches('input') && /^(text|search|email|url|password)$/.test(t.type)))) return;
  e.preventDefault(); e.stopPropagation();
  if (t && t.matches && t.matches('input, select') && t.blur) t.blur(); // a half-typed number is applied first
  (k === 'y' || e.shiftKey) ? redo() : undo();
}, true);

function queueSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 700); }
export async function save() {
  clearTimeout(saveTimer);
  const used = new Set();
  for (const sc of project.scenes) for (const l of allLayers(sc)) if (l.asset) used.add(l.asset);
  for (const it of lib()) if (it.asset) used.add(it.asset);
  const tj = JSON.stringify(tpls()); for (const k of Object.keys(project.assets)) if (tj.includes('"asset":"' + k + '"')) used.add(k);
  // an image removed from the stage must survive while Ctrl+Z / Ctrl+Y can still bring its layer back (history keeps layers, not pictures)
  const hist = ZONES.flatMap((z) => [...undoS[z], ...redoS[z]].map((e) => e.s)).concat(last.studio);
  for (const k of Object.keys(project.assets)) if (!used.has(k) && !hist.some((s) => s.includes('"asset":"' + k + '"'))) delete project.assets[k];
  const json = JSON.stringify(project);
  if (native) await api.invoke('project:save', json).catch(() => {});
  else remember('prismcam.project', json);
}
async function load() {
  let json = null;
  if (native) { const r = await api.invoke('project:load').catch(() => null); json = r && r.ok ? r.data : null; }
  else json = recall('prismcam.project', null);
  if (!json) return;
  try {
    const p = JSON.parse(json);
    if (p && p.v === 1 && Array.isArray(p.scenes) && p.scenes.length) {
      project = p; project.assets = p.assets || {}; project.cur = clamp(p.cur | 0, 0, p.scenes.length - 1);
      const tj = JSON.stringify(project.tpl || []);
      const keep = [...new Set([...project.scenes.flatMap((sc) => allLayers(sc).map((l) => l.media).filter(Boolean)), ...(project.lib || []).map((x) => x.media).filter(Boolean), ...[...tj.matchAll(/"media":"([^"]+)"/g)].map((m) => m[1])])];
      if (native) api.invoke('media:gc', keep).catch(() => {}); else idbGc(new Set(keep)).catch(() => {});
    }
  } catch { /* corrupt save → start fresh */ }
}

/* ------------------------------------------------------------------- layers */
function newLayer(type, extra = {}) {
  const o = out();
  return {
    id: uid(), type, name: typeLabel(type), x: o.w / 2, y: o.h / 2, w: o.w * 0.5, h: o.h * 0.5, rot: 0, op: 1, vis: true, lock: false,
    crop: { l: 0, t: 0, r: 0, b: 0 }, radius: 0, mask: 'rect', flipH: false, flipV: false, border: 0, borderColor: '#ffffff', shadow: 0, blend: 'source-over',
    f: { br: 100, ct: 100, sa: 100, hue: 0, blur: 0, gray: 0, sepia: 0 },
    key: { on: false, color: '#00d000', sim: 30, smooth: 12, spill: 50 },
    ai: { mode: 'off', blur: 14, invert: false },
    hand: { ...HAND_DEF },
    fresh: true, ...extra,
  };
}
function addLayer(L, { select = true } = {}) {
  const A = curArea();
  if (A && L.type === 'handfx') exitAll();
  else if (A) { // a new layer inside an area starts in the middle of it, no bigger than it
    L.x = A.x; L.y = A.y;
    const k = Math.min(1, (A.w * 0.8) / L.w, (A.h * 0.8) / L.h); if (k < 1 && L.type !== 'text') { L.w *= k; L.h *= k; } else if (k < 1) L.h *= k;
  }
  layers().push(L);
  if (select) selId = L.id;
  syncRuntime(); commit(); refreshAll(); bus.emit('added', L);
  return L;
}
function removeLayer(id) {
  const L = byId(id); if (!L) return;
  const arr = listOf(L); arr.splice(arr.indexOf(L), 1);
  if (selId === id) selId = null;
  const gone = new Set(allOf([L]).map((l) => l.id));
  for (const s of project.scenes) for (const c of s.clips || []) c.tracks = c.tracks.filter((t) => !gone.has(t.layer));
  for (const g of gone) { dropHandFx(g); hp.delete(g); }
  syncRuntime(); commit(); refreshAll();
}
const noCopy = (l) => l.type === 'screen' || (l.type === 'video' && !l.media);
// a copy with fresh ids (also everything inside an area); lm collects old id → new id
function cloneLayer(L, lm) {
  const c = JSON.parse(JSON.stringify(L));
  const walk = (x) => { const n = uid(); lm[x.id] = n; x.id = n; x.fresh = false; if (x.kids) { x.kids = x.kids.filter((k) => !noCopy(k)); x.kids.forEach(walk); } };
  walk(c); return c;
}
function duplicate(id, batch) {
  const L = byId(id); if (!L) return;
  if (noCopy(L)) { toast(T`เลเยอร์ชนิดนี้ทำสำเนาไม่ได้ — เพิ่มใหม่จากแถบซ้ายแทน`, { kind: 'err' }); return; }
  const lm = {}, c = cloneLayer(L, lm);
  for (const x of allOf([c])) { x.x += 30; x.y += 30; }
  c.name = L.name + ' 2';
  const arr = listOf(L); arr.splice(arr.indexOf(L) + 1, 0, c);
  for (const cl of scene().clips || []) for (const t of cl.tracks.filter((x) => lm[x.layer])) { const n = JSON.parse(JSON.stringify(t)); n.id = auid(); n.layer = lm[t.layer]; if (cl.mode !== 'add' && (n.prop === 'x' || n.prop === 'y')) n.keys.forEach((k) => { k.v += 30; }); cl.tracks.push(n); }
  selId = c.id; selSet = new Set([c.id]); syncRuntime(); if (batch) return; commit(); refreshAll();
}
// An area is one object, like a video: moving, resizing or turning its box (outside an animation edit) carries
// everything inside along — positions, sizes, turn, corner radius / border and their keyframes.
// Each area remembers the box it had last frame (_f, not saved); syncAreas() compares and carries the difference.
const nrot = (a) => ((a % 360) + 540) % 360 - 180;
function setF(A) { Object.defineProperty(A, '_f', { value: { x: A.x, y: A.y, w: A.w, h: A.h, rot: A.rot, ew: A.w * kxOf(A), eh: A.h * kyOf(A) }, writable: true, configurable: true, enumerable: false }); }
function syncAreas(arr = root()) {
  for (const A of arr) {
    if (A.type !== 'area') continue;
    const f = A._f;
    if (!f) setF(A);
    else if (!(hooks.rest && hooks.rest(A)) && (f.x !== A.x || f.y !== A.y || f.rot !== A.rot || Math.abs(f.ew - A.w * kxOf(A)) > 1e-6 || Math.abs(f.eh - A.h * kyOf(A)) > 1e-6)) { carryKids(A, f); setF(A); }
    if (A.kids) syncAreas(A.kids);
  }
}
// from the box f to the area's box now · sizeK = scale every size by this one number (canvas size change)
function carryKids(A, f, clips = scene().clips || [], sizeK) {
  const ks = allOf(A.kids || []); if (!ks.length) return;
  const okk = (v) => (Number.isFinite(v) && v > 1e-4 ? v : 1);
  const sx = okk((A.w * kxOf(A)) / f.ew), sy = okk((A.h * kyOf(A)) / f.eh), uni = sizeK || Math.sqrt(sx * sy), dr = A.rot - f.rot;
  const r0 = -f.rot * Math.PI / 180, r1 = A.rot * Math.PI / 180, c0 = Math.cos(r0), s0 = Math.sin(r0), c1 = Math.cos(r1), s1 = Math.sin(r1);
  const vec = (dx, dy) => { const u = (dx * c0 - dy * s0) * sx, v = (dx * s0 + dy * c0) * sy; return [u * c1 - v * s1, u * s1 + v * c1]; };
  const pt = (x, y) => { const [u, v] = vec(x - f.x, y - f.y); return [A.x + u, A.y + v]; };
  const size = (k) => { // a layer square to the area stretches with it; a tilted one keeps its shape
    if (sizeK) return [sizeK, sizeK];
    const r = ((k.rot - f.rot) % 180 + 180) % 180, side = Math.abs(r - 90) < 1;
    return r < 1 || r > 179 ? [sx, sy] : side ? [sy, sx] : [uni, uni];
  };
  const ids = new Map(ks.map((k) => [k.id, k]));
  for (const c of clips) { // keyframes first (they read the layers' old values)
    const add = c.mode === 'add', by = new Map();
    for (const t of c.tracks) if (ids.has(t.layer)) { if (!by.has(t.layer)) by.set(t.layer, {}); by.get(t.layer)[t.prop] = t; }
    for (const [id, T0] of by) {
      const k = ids.get(id), [kw, kh] = size(k), tk = Math.min(kw, kh);
      if (T0.x || T0.y) {
        const at = (tr, t, own) => (tr ? evalTrack(tr, t) : add ? 0 : own);
        const map = (x, y) => (add ? vec(x, y) : pt(x, y));
        const nx = T0.x && T0.x.keys.map((q) => map(q.v, at(T0.y, q.t, k.y))[0]), ny = T0.y && T0.y.keys.map((q) => map(at(T0.x, q.t, k.x), q.v)[1]);
        if (nx) T0.x.keys.forEach((q, i) => { q.v = nx[i]; });
        if (ny) T0.y.keys.forEach((q, i) => { q.v = ny[i]; });
      }
      if (T0.w && k.type !== 'text') T0.w.keys.forEach((q) => { q.v *= kw; });
      if (T0.h) T0.h.keys.forEach((q) => { q.v *= k.type === 'text' ? tk : kh; });
      if (T0.rot && !add && dr) T0.rot.keys.forEach((q) => { q.v += dr; });
      if (T0.radius) T0.radius.keys.forEach((q) => { q.v *= uni; });
      if (T0.border) T0.border.keys.forEach((q) => { q.v *= uni; });
    }
  }
  for (const k of ks) {
    const [kw, kh] = size(k);
    [k.x, k.y] = pt(k.x, k.y);
    if (k.type === 'text') k.h = Math.max(4, k.h * Math.min(kw, kh)); else { k.w = Math.max(1, k.w * kw); k.h = Math.max(1, k.h * kh); }
    if (dr) k.rot = nrot(k.rot + dr);
    if (k.radius) k.radius *= uni;
    if (k.border) k.border *= uni;
    if (k.type === 'area') setF(k);
  }
}
function reorder(id, to) { // to: 'front' | 'back' | +1 | -1
  const L0 = byId(id); if (!L0) return;
  const a = listOf(L0), i = a.indexOf(L0); if (i < 0) return;
  const [L] = a.splice(i, 1);
  const j = to === 'front' ? a.length : to === 'back' ? 0 : clamp(i + to, 0, a.length);
  a.splice(j, 0, L); commit(); renderLayers();
}

/* natural size of a layer's source (0 when not ready) */
function natural(L) {
  const r = rt.get(L.id); if (!r || !r.el || !r.ready) return null;
  const w = r.el.videoWidth || r.el.naturalWidth || 0, h = r.el.videoHeight || r.el.naturalHeight || 0;
  return w && h ? { w, h } : null;
}
const cropAspect = (L, n) => (n.w * (1 - L.crop.l - L.crop.r)) / (n.h * (1 - L.crop.t - L.crop.b));
function place(L, mode) {
  placeIn(L, mode);
}
function placeIn(L, mode) {
  const P = L._area || parentOf(L.id), n = natural(L);
  const o = P ? { w: P.w, h: P.h } : out(), x0 = P ? P.x - P.w / 2 : 0, y0 = P ? P.y - P.h / 2 : 0;
  const ar = MEDIA.has(L.type) && n ? cropAspect(L, n) : L.w / L.h;
  const m = Math.round(o.w * 0.025);
  const set = (w, h, x, y) => { L.w = w; L.h = h; L.x = x + x0; L.y = y + y0; L.rot = 0; };
  if (mode === 'cover') { const w = Math.max(o.w, o.h * ar); set(w, w / ar, o.w / 2, o.h / 2); }
  else if (mode === 'contain') { const w = Math.min(o.w, o.h * ar); set(w, w / ar, o.w / 2, o.h / 2); }
  else if (mode === 'center') { L.x = x0 + o.w / 2; L.y = y0 + o.h / 2; }
  else if (mode === 'left' || mode === 'right') {
    // half the canvas, cropping the source so it is not squashed
    if (MEDIA.has(L.type) && n) { const want = (o.w / 2) / o.h, full = n.w / n.h; L.crop = { l: 0, t: 0, r: 0, b: 0 }; if (full > want) { const c = (1 - want / full) / 2; L.crop.l = L.crop.r = c; } else { const c = (1 - full / want) / 2; L.crop.t = L.crop.b = c; } }
    set(o.w / 2, o.h, mode === 'left' ? o.w / 4 : o.w * 0.75, o.h / 2);
  } else if (mode === 'bubble') {
    if (MEDIA.has(L.type) && n) { L.crop = { l: 0, t: 0, r: 0, b: 0 }; const full = n.w / n.h; if (full > 1) L.crop.l = L.crop.r = (1 - 1 / full) / 2; else L.crop.t = L.crop.b = (1 - full) / 2; }
    const d = o.h * 0.36; set(d, d, o.w - m - d / 2, o.h - m - d / 2); L.mask = 'ellipse'; if (!L.border) { L.border = 6; L.borderColor = '#ffffff'; } if (!L.shadow) L.shadow = 30;
  } else { // picture-in-picture corners: tl tr bl br
    const w = o.w * 0.3, h = w / ar;
    set(w, h, mode[1] === 'l' ? m + w / 2 : o.w - m - w / 2, mode[0] === 't' ? m + h / 2 : o.h - m - h / 2);
    if (!L.radius && L.mask === 'rect') L.radius = 22;
  }
}
// first frame of a new media layer: give it a sensible size
function onReady(L) {
  if (!L.fresh) return;
  L.fresh = false;
  const n = natural(L); if (!n) return;
  const P = parentOf(L.id), o = P || out();
  const first = !P && !root().some((l) => l !== L && MEDIA.has(l.type));
  if ((L.type === 'camera' || L.type === 'screen' || L.type === 'video') && first) place(L, 'cover');
  else { const ar = n.w / n.h, w = Math.min(o.w * (P ? 0.8 : 0.5), n.w, o.h * (P ? 0.8 : 0.7) * ar); L.w = w; L.h = w / ar; }
  rebase('studio'); queueSave(); // sizing is part of the "add" step, not a separate undo entry
  if (L.id === selId) renderProps();
}

/* ------------------------------------------------------------------ sources */
const dlog = (m) => { try { if (native) api.invoke('app:log', String(m)); } catch { /* */ } };
const GUARD = 'prismCamOpening';
const guard = (on) => { try { on ? localStorage.setItem(GUARD, '1') : localStorage.removeItem(GUARD); } catch { /* storage unavailable */ } };
// Opening a camera is what crashed the AMD driver on some PCs. If the previous open never finished (the app was closed or
// killed while it hung), do NOT reopen it automatically on start — wait for the user to double-click the layer.
function camera(deviceId, force, label) {
  let c = cams.get(deviceId);
  if (c && !force) return c;
  const video = document.createElement('video'); video.muted = true; video.playsInline = true;
  c = { video, stream: null, failed: false, held: false };
  cams.set(deviceId, c);
  let pending = false; try { pending = !!localStorage.getItem(GUARD); } catch { /* */ }
  if (pending && !force) { c.failed = c.held = true; c.promise = Promise.resolve(); return c; }
  const dev = deviceId ? { exact: deviceId } : undefined;
  const open = (video_) => Promise.race([
    navigator.mediaDevices.getUserMedia({ video: video_, audio: false }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
  ]);
  guard(true);
  const want = (id) => ({ deviceId: id ? { exact: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: camRate() });
  // WebView2 device ids are not stable between launches, so a saved id can be stale ("OverconstrainedError"):
  // then find the camera again by its name, and finally fall back to the default camera.
  const findByName = async () => {
    let devs = await navigator.mediaDevices.enumerateDevices();
    if (!devs.some((d) => d.kind === 'videoinput' && d.label)) { try { (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach((t) => t.stop()); } catch { /* */ } devs = await navigator.mediaDevices.enumerateDevices(); }
    const name = String(label || '').trim().toLowerCase();
    const d = devs.find((x) => x.kind === 'videoinput' && name && x.label.toLowerCase().startsWith(name));
    return d ? d.deviceId : '';
  };
  dlog(`camera open id=${String(deviceId).slice(0, 8)} label=${label}`);
  // wait for real frames: a camera that hands over a stream but never delivers a picture must not leave the layer on "Opening…"
  const playing = (s) => {
    c.stream = s; video.srcObject = s; dlog('camera stream granted');
    return Promise.race([
      video.play().then(() => new Promise((res, rej) => { const t0 = Date.now(), w = () => (video.videoWidth ? res() : Date.now() - t0 > 8000 ? rej(new Error('no frames')) : setTimeout(w, 100)); w(); })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('no frames')), 12000)),
    ]);
  };
  const failIt = (err) => {
    c.failed = true; c.err = String(err && (err.name || err.message) || err); dlog(`camera FAILED ${c.err}`);
    if (c.stream) { c.stream.getTracks().forEach((t) => t.stop()); c.stream = null; }
    toast(T`เปิดกล้องไม่ได้`, { kind: 'err' });
  };
  // preferred 720p30; a stale saved id falls back to a lookup by name
  c.promise = open(want(deviceId))
    .catch(async (err) => {
      if (err && err.message === 'timeout') throw err;
      dlog(`camera exact id failed: ${err && err.name}`);
      const id = await findByName();
      return open(id ? want(id) : { width: { ideal: 1280 }, height: { ideal: 720 } });
    })
    .then(playing)
    .then(() => { dlog(`camera OK ${video.videoWidth}x${video.videoHeight} @${camFps(c)}`); checkCamFps(c, label); })
    .catch(failIt)
    .finally(() => guard(false));
  return c;
}
// 30 fps projects ask for exactly 30 (cheapest); 60 fps projects ask for 60 and take what the camera can give
const camRate = () => (out().fps > 30 ? { ideal: 60 } : { ideal: 30, max: 30 });
const camFps = (c) => { const t = c.stream && c.stream.getVideoTracks()[0], s = t && t.getSettings ? t.getSettings() : {}; return Math.round(s.frameRate || 0); };
const camName = (s) => String(s || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '');
const fpsWarned = new Set();
function checkCamFps(c, label) {
  if (out().fps <= 30 || !c.stream) return;
  const f = camFps(c); if (!f || f >= 50) return;
  const key = label || 'cam'; if (fpsWarned.has(key)) return; fpsWarned.add(key);
  dlog(`camera only ${f} fps — warned`);
  toast(T`กล้องนี้ได้แค่ ${f} fps` + (label ? ` (${camName(label)})` : '') + T` — ภาพจากกล้องจะไม่ลื่นขึ้น แต่ข้อความ เอฟเฟกต์ และภาพหน้าจอยังวาดที่ 60 fps`, { kind: 'warn' });
}
// switch the frame rate of every open camera / screen capture without reopening them
async function applySourceFps() {
  for (const c of cams.values()) {
    const t = c.stream && c.stream.getVideoTracks()[0]; if (!t) continue;
    const s = t.getSettings();
    try { await t.applyConstraints({ width: { ideal: s.width || 1280 }, height: { ideal: s.height || 720 }, frameRate: camRate() }); } catch (err) { dlog('camera fps change failed ' + (err && err.name)); }
    const n = t.getSettings(); dlog(`camera fps now ${camFps(c)} (${n.width}x${n.height})`);
    checkCamFps(c, t.label);
  }
  for (const r of rt.values()) {
    const t = r.own && r.el && r.el.srcObject && r.el.srcObject.getVideoTracks()[0];
    if (t) t.applyConstraints({ frameRate: out().fps }).catch(() => {});
  }
}
function setFps(v) {
  const o = out(); v = v > 30 ? 60 : 30; if (o.fps === v) return;
  o.fps = v; appliedFps = v; resetCap(); fpsWarned.clear(); commit(); bus.emit('fps', v); applySourceFps();
  toast(v > 30 ? T`ตั้งเป็น 60 fps แล้ว — ภาพในโปรแกรมและวิดีโอที่อัดจะลื่นขึ้น (กล้องเสมือนยังส่ง 30 fps)` : T`ตั้งเป็น 30 fps แล้ว`);
}
function retryCamera(L) {
  const old = cams.get(L.deviceId || '');
  if (old && old.stream) old.stream.getTracks().forEach((t) => t.stop());
  cams.delete(L.deviceId || ''); rt.delete(L.id);
  syncRuntimeForce = true; syncRuntime();
}
let syncRuntimeForce = false;
function stopRuntime(id) {
  const r = rt.get(id); if (!r) return;
  if (r.own && r.el && r.el.srcObject) r.el.srcObject.getTracks().forEach((t) => t.stop());
  if (r.url) URL.revokeObjectURL(r.url);
  if (r.proc) r.proc.dispose();
  rt.delete(id);
}
// make the runtime match the current scene: start what is needed, stop what is not
function syncRuntime() {
  const all = allLayers(), live = new Set(all.map((l) => l.id)), needCams = new Set();
  for (const id of [...rt.keys()]) {
    const r = rt.get(id);
    if (!live.has(id) && !(r.keep && project.scenes.some((sc) => allLayers(sc).some((l) => l.id === id)))) stopRuntime(id);
  }
  for (const L of all) {
    let r = rt.get(L.id);
    if (L.type === 'camera') {
      if (!r) { const c = camera(L.deviceId || '', syncRuntimeForce, L.name); r = { el: c.video, ready: false, cam: c }; rt.set(L.id, r); }
    } else if (L.type === 'image' && !r) {
      const img = new Image(); r = { el: img, ready: false }; rt.set(L.id, r);
      img.onload = () => { r.ready = true; onReady(L); };
      img.src = project.assets[L.asset] || '';
    } else if (L.type === 'video' && !r && L.media) { // a saved video file: open it again by itself
      r = { el: null, ready: false, keep: true }; rt.set(L.id, r);
      videoUrl(L.media).then((url) => { if (url && rt.get(L.id) === r) attachVideoSrc(L, url, !native); });
    } else if ((L.type === 'screen' || L.type === 'video') && !r) rt.set(L.id, { el: null, ready: false, keep: true });
  }
  for (const sc of project.scenes) for (const l of allLayers(sc)) if (l.type === 'camera') needCams.add(l.deviceId || ''); // cameras stay open while any scene uses them
  for (const [id, c] of [...cams]) if (!needCams.has(id)) { if (c.stream) c.stream.getTracks().forEach((t) => t.stop()); else c.promise.then(() => c.stream && c.stream.getTracks().forEach((t) => t.stop())); cams.delete(id); }
  syncRuntimeForce = false;
  $('empty').classList.toggle('hidden', root().length > 0);
}

async function listCameras() {
  let devs = await navigator.mediaDevices.enumerateDevices();
  if (!devs.some((d) => d.kind === 'videoinput' && d.label)) { // labels need permission once
    try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach((t) => t.stop()); } catch { /* handled by caller */ }
    devs = await navigator.mediaDevices.enumerateDevices();
  }
  return devs.filter((d) => d.kind === 'videoinput' && !/prism cam/i.test(d.label));
}
async function addCamera() {
  let list = [];
  try { list = await listCameras(); } catch { /* no mediaDevices */ }
  if (!list.length) { toast(T`ไม่พบกล้อง — ตรวจว่าเสียบกล้องแล้วและอนุญาตให้ใช้กล้อง`, { kind: 'err' }); return; }
  const pick = list.length === 1 ? list[0] : await htmlBox(
    `<h3>${T`เลือกกล้อง`}</h3><div class="pick-list">${list.map((d, i) => `<button class="pick" data-i="${i}">${icon('camera')}<span><b>${esc(d.label || T`กล้อง ${i + 1}`)}</b></span></button>`).join('')}</div><div class="modal-btns"><button class="pill-btn" data-x>${T`ยกเลิก`}</button></div>`,
    (m, close) => { m.querySelector('[data-x]').onclick = () => close(null); m.querySelectorAll('.pick').forEach((b) => { b.onclick = () => close(list[+b.dataset.i]); }); });
  if (!pick) return;
  addLayer(newLayer('camera', { deviceId: pick.deviceId, name: (pick.label || T`กล้อง`).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '') }));
}
async function attachScreen(L) {
  let stream;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: out().fps }, audio: false }); }
  catch { return false; }
  const video = document.createElement('video'); video.muted = true; video.srcObject = stream; await video.play().catch(() => {});
  stopRuntime(L.id);
  rt.set(L.id, { el: video, ready: false, own: true, keep: true });
  stream.getVideoTracks()[0].addEventListener('ended', () => { const r = rt.get(L.id); if (r && r.el === video) rt.set(L.id, { el: null, ready: false, keep: true }); });
  return true;
}
async function addScreen() {
  const L = newLayer('screen');
  if (!(await attachScreen(L))) return;
  addLayer(L);
}
function attachVideoSrc(L, url, own) {
  const video = document.createElement('video'); video.muted = true; video.loop = true; video.playsInline = true;
  if (url.startsWith('http')) video.crossOrigin = 'anonymous'; // served by the app itself: keeps the canvas readable for the virtual camera
  video.src = url; video.play().catch(() => {});
  stopRuntime(L.id);
  const r = { el: video, ready: false, url: own ? url : '', keep: true }; rt.set(L.id, r);
  video.onerror = () => { if (rt.get(L.id) === r) { if (r.url) URL.revokeObjectURL(r.url); rt.set(L.id, { el: null, ready: false, keep: true }); } }; // the saved copy is gone → ask for the file again
}
function attachVideoFile(L, file) { attachVideoSrc(L, URL.createObjectURL(file), true); }
// video files are copied into the app's data folder (the browser preview keeps them in IndexedDB), so they come back next time
let idbP = null;
const idb = () => idbP || (idbP = new Promise((res, rej) => { const q = indexedDB.open('prismcam-media', 1); q.onupgradeneeded = () => q.result.createObjectStore('v'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }));
const idbDo = (mode, fn) => idb().then((db) => new Promise((res, rej) => { const tx = db.transaction('v', mode), q = fn(tx.objectStore('v')); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); }));
const idbGc = (keep) => idbDo('readwrite', (st) => { const q = st.getAllKeys(); q.onsuccess = () => { for (const k of q.result) if (!keep.has(k)) st.delete(k); }; return null; });
async function videoUrl(name) {
  if (native) return 'http://pmedia.localhost/' + encodeURIComponent(name);
  const b = await idbDo('readonly', (st) => st.get(name)).catch(() => null);
  return b ? URL.createObjectURL(b) : '';
}
async function storeVideo(file, name) {
  try {
    if (native) {
      const CH = 16 << 20, big = file.size > 64 << 20;
      if (big) toast(T`กำลังเก็บวิดีโอไว้ในโปรเจกต์…`);
      for (let off = 0; off < file.size; off += CH) {
        const r = await api.raw('media_put', new Uint8Array(await file.slice(off, off + CH).arrayBuffer()), { 'x-name': name, 'x-off': String(off) });
        if (!r || !r.ok) throw new Error('write failed');
      }
      if (big) toast(T`เก็บวิดีโอแล้ว — เปิดโปรแกรมครั้งหน้าไม่ต้องเลือกไฟล์ใหม่`);
    } else await idbDo('readwrite', (st) => st.put(file, name));
    return true;
  } catch (err) {
    dlog('video save failed ' + err);
    toast(T`เก็บไฟล์วิดีโอไว้ในโปรเจกต์ไม่สำเร็จ — ครั้งหน้าต้องเลือกไฟล์ใหม่`, { kind: 'err' });
    return false;
  }
}
// play the picked file now, and keep a copy for next time
function setVideoFile(L, file) {
  attachVideoFile(L, file);
  const hit = lib().find((x) => x.sig === sigOf(file) && x.media && !x.missing);
  if (hit) { L.media = hit.media; libAdd(hit); return; } // already stored once: no second copy
  const ext = ((file.name.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'mp4').toLowerCase();
  const name = uid() + uid() + '.' + ext;
  L.media = name;
  storeVideo(file, name).then((ok) => { if (!ok && L.media === name) { delete L.media; queueSave(); } else if (ok) libAdd({ kind: 'video', media: name, name: L.name, sig: sigOf(file) }); });
}
function pickFile(input) { return new Promise((res) => { input.value = ''; input.onchange = () => res([...input.files]); input.click(); }); }
const readDataUrl = (file) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
async function addImageFile(file) {
  if (!file.type.startsWith('image/')) return;
  const hit = file.name && lib().find((x) => x.sig === sigOf(file) && project.assets[x.asset]); // the same file again: reuse the stored picture
  const id = hit ? hit.asset : uid(); if (!hit) project.assets[id] = await readDataUrl(file);
  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || T`รูปภาพ`;
  libAdd({ kind: 'image', asset: id, name, sig: sigOf(file) });
  addLayer(newLayer('image', { asset: id, name }));
}
async function addImages() { for (const f of await pickFile($('file-image'))) await addImageFile(f); }
async function addVideo() {
  const [f] = await pickFile($('file-video')); if (!f) return;
  const L = newLayer('video', { name: f.name.replace(/\.[^.]+$/, '').slice(0, 40) });
  setVideoFile(L, f); addLayer(L);
}
function addText(text = T`ข้อความ`, extra = {}) {
  const o = out();
  addLayer(newLayer('text', { text, font: 'IBM Plex Sans Thai', weight: 600, color: '#ffffff', stroke: 0, strokeColor: '#232a47', bg: false, bgColor: '#7c8cff', h: o.h * 0.13, shadow: 12, fresh: false, name: text.slice(0, 24), ...extra }));
}
const EMOJI = '😀 😂 🥰 😎 🤩 🥳 😭 😡 🤔 😴 🤯 🥶 👍 👎 👏 🙏 💪 ✌️ 🤝 👀 ❤️ 💜 💙 💚 🧡 💔 🔥 ✨ ⭐ 🌈 ☀️ 🌙 ⚡ 💯 ✅ ❌ ❗ ❓ 💬 💤 🎉 🎁 🎮 🎧 🎤 🎬 📷 💻 🚀 🏆 👑 💎 🍕 🍜 ☕ 🧋 🐱 🐶 🐷 🦊 🐼 🌸 🍀 🎀'.split(' ');
async function addSticker(extra = {}) {
  const e = await htmlBox(`<h3>${T`เลือกสติกเกอร์`}</h3><div class="emoji-grid wide">${EMOJI.map((x) => `<button>${x}</button>`).join('')}</div><div class="modal-btns"><button class="pill-btn" data-x>${T`ยกเลิก`}</button></div>`,
    (m, close) => { m.querySelector('[data-x]').onclick = () => close(null); m.querySelectorAll('.emoji-grid button').forEach((b) => { b.onclick = () => close(b.textContent); }); });
  if (e) addText(e, { font: 'Segoe UI Emoji', weight: 400, h: out().h * 0.22, shadow: 0, name: T`สติกเกอร์ ${e}`, ...extra });
  return e;
}
function addShape() {
  const o = out();
  addLayer(newLayer('shape', { fill: '#8ea2ff', fill2: '#ff9ec7', grad: true, w: o.w * 0.4, h: o.h * 0.4, radius: 28, fresh: false }));
}
// an empty box that holds its own layers: keeps the main list tidy, and the whole box can be animated
const AREA_DEF = { kids: [], clip: true, bg: false, fill: '#1c2140', radius: 18, fresh: false };
function addArea() {
  const o = out(), A = curArea();
  const L = addLayer(newLayer('area', { ...AREA_DEF, kids: [], name: T`พื้นที่แอนิเมชัน`, w: (A ? A.w : o.w) * 0.6, h: (A ? A.h : o.h) * 0.6 }));
  toast(T`ดับเบิลคลิกที่พื้นที่เพื่อเข้าไปใส่รูป วิดีโอ หรือข้อความ`, { label: T`เข้าไปเลย`, action: () => enterArea(L) });
}
// open animation mode on an area's own clip (make one if asked), editing inside the area
function openAreaTimeline(A, make, clipId) {
  const clips = scene().clips || (scene().clips = []);
  let c = clipId ? clips.find((x) => x.id === clipId) : null;
  if (make) { c = { id: auid(), name: `${A.name} ${clips.filter((x) => x.area === A.id).length + 1}`, area: A.id, auto: true, loop: 'loop', dur: 3, fps: 30, tracks: [], events: [] }; fixClip(c); clips.push(c); commit(); }
  if (!c) return;
  enterArea(A); bus.emit('anim:open', c.id);
}
// add gesture commands straight away (e.g. swipe left / right for a slideshow)
function quickBinds(list) {
  const H = project.hand; let n = 0;
  for (const [g, cmd] of list) { if (H.binds.some((b) => b.gesture === g && b.action && b.action.cmd === cmd)) continue; H.binds.push({ id: uid(), on: true, gesture: g, hand: 'any', hold: 0, mode: 'once', every: 500, action: { type: 'app', cmd } }); n++; }
  if (!H.on) { H.on = true; applyHandCfg(); }
  touch(); bus.emit('hand:binds'); bus.emit('hand:cfg'); renderProps();
  toast(n ? T`เพิ่มท่ามือ ${n} คำสั่งแล้ว — ดูและแก้ได้ในแท็บมือ` : T`มีท่ามือนี้อยู่แล้ว`);
}
const cmdName = (c) => (c.startsWith('layer-show:') ? T`โชว์` : c.startsWith('layer-hide:') ? T`ซ่อน` : c.startsWith('layer:') ? T`โชว์ / ซ่อน` : c.startsWith('slide-next:') ? T`สไลด์ถัดไป` : c.startsWith('slide-prev:') ? T`สไลด์ก่อนหน้า` : c);
// several selected layers → one area around them (Ctrl+G)
function groupToArea() {
  const arr = layers(), G = sels().filter((l) => l.type !== 'handfx' && arr.includes(l)); if (!G.length) return;
  const b = groupBox(G), pad = 16, at = Math.max(...G.map((l) => arr.indexOf(l)));
  const A = newLayer('area', { ...AREA_DEF, kids: [], radius: 0, name: T`พื้นที่แอนิเมชัน`, x: b.cx, y: b.cy, w: b.w + pad * 2, h: b.h + pad * 2 });
  arr.splice(at + 1, 0, A);
  for (const l of arr.filter((x) => G.includes(x))) { arr.splice(arr.indexOf(l), 1); A.kids.push(l); }
  selId = A.id; selSet = new Set([A.id]); syncRuntime(); commit(); refreshAll();
  toast(T`รวม ${G.length} เลเยอร์เป็นพื้นที่แอนิเมชันแล้ว`, { label: T`เข้าไปดู`, action: () => enterArea(A) });
}
function moveInto(list, A) {
  list = list.filter((l) => l !== A && l.type !== 'handfx' && !(l.kids && allOf(l.kids).includes(A)));
  if (!list.length) return;
  for (const l of list) { const arr = listOf(l); arr.splice(arr.indexOf(l), 1); A.kids.push(l); }
  selId = null; selSet.clear(); commit(); refreshAll();
  toast(T`ย้าย ${list.length} เลเยอร์เข้า “${A.name}” แล้ว`);
}
function moveOut(list) { // from the area being edited to the list it sits in
  const A = curArea(); if (!A) return;
  const arr = listOf(A); let at = arr.indexOf(A);
  for (const l of list) { const i = A.kids.indexOf(l); if (i < 0) continue; A.kids.splice(i, 1); arr.splice(++at, 0, l); }
  selId = null; selSet.clear(); commit(); refreshAll();
}
function enterArea(A) {
  if (!A || A.type !== 'area') return;
  scope = A.id; selId = null; selSet.clear(); cropMode = false;
  refreshAll(); bus.emit('select', null); bus.emit('scope', scope);
}
function exitArea() {
  const A = curArea(); if (!A) { scope = null; return; }
  const P = parentOf(A.id); scope = P ? P.id : null;
  selId = A.id; selSet = new Set([A.id]);
  refreshAll(); bus.emit('select', selId); bus.emit('scope', scope);
}
// editing inside an area and the click lands outside its box: step out (as many levels as needed) — like closing a folder
function leaveAreaAt(p) {
  let A = curArea(), moved = false;
  while (A) {
    const e = E(A), q = toLocal(e, p);
    if (Math.abs(q.x) <= e.w / 2 && Math.abs(q.y) <= e.h / 2) break;
    const P = parentOf(A.id); scope = P ? P.id : null; A = P; moved = true;
  }
  if (!moved) return false;
  selId = null; selSet.clear(); cropMode = false; refreshAll(); bus.emit('select', null); bus.emit('scope', scope);
  return true;
}
// the area's box hugs what is inside it (only the box changes — nothing inside moves)
function fitAreaToKids(A) {
  const ks = A.kids.filter((k) => k.vis && k.type !== 'handfx'); if (!ks.length) return;
  syncAreas();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of ks) { // corners of each one, in the area's own (turned) frame
    const e = E(k), a = e.rot * Math.PI / 180, c = Math.cos(a), s2 = Math.sin(a);
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const q = toLocal(A, { x: e.x + (u * e.w / 2) * c - (v * e.h / 2) * s2, y: e.y + (u * e.w / 2) * s2 + (v * e.h / 2) * c }); x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  }
  const pad = 12, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, a = A.rot * Math.PI / 180;
  A.x += cx * Math.cos(a) - cy * Math.sin(a); A.y += cx * Math.sin(a) + cy * Math.cos(a);
  A.w = Math.max(16, (x1 - x0 + pad * 2) / (kxOf(A) || 1)); A.h = Math.max(16, (y1 - y0 + pad * 2) / (kyOf(A) || 1));
  setF(A); commit(); renderProps(); placeGizmo();
}
function exitAll() { if (!scope) return; scope = null; selId = null; selSet.clear(); refreshAll(); bus.emit('scope', null); }
function addFrame() {
  const o = out();
  addLayer(newLayer('frame', { w: o.w - 24, h: o.h - 24, radius: 34, border: 14, borderColor: '#c79bff', fresh: false }));
}
function addHandFx() {
  const o = out(), had = allLayers().find((l) => l.type === 'handfx');
  if (had) { exitAll(); select(had.id); showTab('props'); return; }
  project.hand.on = true;
  addLayer(newLayer('handfx', { name: T`เอฟเฟกต์มือ`, x: o.w / 2, y: o.h / 2, w: o.w, h: o.h, fx: { ...FX_DEFAULT }, fresh: false }));
  if (!handSource()) toast(T`เพิ่มกล้องก่อน แล้วเอฟเฟกต์มือจะทำงานทันที`);
  bus.emit('hand:cfg');
}
// text / sticker that rides on the hand
function addHandText(text, extra = {}) {
  project.hand.on = true;
  addText(text, { hand: { ...HAND_DEF, on: true, pt: 'above', scale: true, rot: false }, ...extra });
  if (!handSource()) toast(T`เพิ่มกล้องก่อน แล้วข้อความจะลอยตามมือ`);
  bus.emit('hand:cfg');
}
async function addHandSticker() {
  if (await addSticker({ hand: { ...HAND_DEF, on: true, pt: 'palm', scale: true, rot: true } })) { project.hand.on = true; bus.emit('hand:cfg'); }
}
const ADD = { camera: addCamera, screen: addScreen, image: addImages, video: addVideo, text: () => addText(), sticker: () => addSticker(), shape: addShape, frame: addFrame, handfx: addHandFx, area: addArea };

/* ------------------------------------------------------------ hand tracking */
// which layer the tracker watches: the chosen one, else the first camera (then video / screen / image) in this scene
function handSource() {
  const a = allLayers(), pick = project.hand.src && byId(project.hand.src);
  if (pick && MEDIA.has(pick.type)) return pick;
  for (const t of ['camera', 'video', 'screen', 'image']) { const c = a.filter((l) => l.type === t); if (c.length) return c.find((l) => l.vis) || c[0]; }
  return null;
}
const HS = [], hsPool = new Map(); // hands of this frame in scene pixels: { id, tr, g, pin, side, p[42], palm, size, ang }
const hp = new Map();              // layer id → live pose of a hand-attached layer
function trackHands(now) {
  HS.length = 0;
  if (!project.hand.on) { if (hands.state !== 'off') stopHands(); return; }
  pruneHands(now);
  const S = handSource(), r = S && rt.get(S.id);
  if (!S || !r || !r.el || !natural(S)) return;
  feedHands(r.el, now);
  poseHands(now);
  const c = S.crop, cw = 1 - c.l - c.r, ch = 1 - c.t - c.b, a = S.rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), fh = S.flipH ? -1 : 1, fv = S.flipV ? -1 : 1;
  for (const tr of hands.tracks) {
    let h = hsPool.get(tr.id); if (!h) { h = { id: tr.id, tr, p: new Float32Array(42), palm: [0, 0], size: 1, ang: 0 }; hsPool.set(tr.id, h); }
    const p = h.p, q = tr.p;
    for (let i = 0; i < 21; i++) { const u = ((q[i * 2] - c.l) / cw - 0.5) * S.w * fh, v = ((q[i * 2 + 1] - c.t) / ch - 0.5) * S.h * fv; p[i * 2] = S.x + u * ca - v * sa; p[i * 2 + 1] = S.y + u * sa + v * ca; }
    h.palm[0] = (p[0] + p[10] + p[18] + p[26] + p[34]) / 5; h.palm[1] = (p[1] + p[11] + p[19] + p[27] + p[35]) / 5;
    h.size = Math.max(8, Math.hypot(p[18] - p[0], p[19] - p[1]), Math.hypot(p[10] - p[34], p[11] - p[35]) * 1.25);
    h.ang = Math.atan2(p[18] - p[0], -(p[19] - p[1]));
    h.g = tr.g; h.pin = tr.pin; h.side = tr.side;
    HS.push(h);
  }
  if (hsPool.size > 8) for (const id of [...hsPool.keys()]) if (!hands.tracks.some((t) => t.id === id)) hsPool.delete(id);
}
const sceneHand = (side) => { let best = null; for (const h of HS) { if ((side === 'left' && h.side !== 'L') || (side === 'right' && h.side !== 'R')) continue; if (!best || h.tr.born < best.tr.born) best = h; } return best; };
// live pose of a layer that follows the hand (null when the layer is not attached)
function handPose(L) {
  const A = L.hand; if (!A || !A.on || L.type === 'handfx') return null;
  let s = hp.get(L.id); if (!s) { s = { a: 0, x: L.x, y: L.y, rot: 0, k: 1, ax: L.x, ay: L.y, size: 0, live: false, f: -1 }; hp.set(L.id, s); }
  if (s.f === frameNo) return s;
  s.f = frameNo;
  const o = out();
  let ok = false, ax = 0, ay = 0, ang = 0, size = 0, gest = '';
  if (A.pt === 'between') {
    if (HS.length >= 2) { const [a, b] = HS[0].palm[0] <= HS[1].palm[0] ? [HS[0], HS[1]] : [HS[1], HS[0]]; ax = (a.palm[0] + b.palm[0]) / 2; ay = (a.palm[1] + b.palm[1]) / 2; ang = Math.atan2(b.palm[1] - a.palm[1], b.palm[0] - a.palm[0]); size = Math.hypot(b.palm[0] - a.palm[0], b.palm[1] - a.palm[1]); gest = a.g === b.g ? a.g : ''; ok = true; }
  } else {
    const h = sceneHand(A.side);
    if (h) {
      const p = h.p, i = { index: 8, thumb: 4, middle: 12, pinky: 20, wrist: 0 }[A.pt];
      if (i !== undefined) { ax = p[i * 2]; ay = p[i * 2 + 1]; }
      else if (A.pt === 'pinch') { ax = (p[8] + p[16]) / 2; ay = (p[9] + p[17]) / 2; }
      else if (A.pt === 'above') { let top = p[1]; for (let j = 1; j < 21; j++) top = Math.min(top, p[j * 2 + 1]); ax = h.palm[0]; ay = top - h.size * 0.45; } // above the hand on screen, whichever way it points
      else { ax = h.palm[0]; ay = h.palm[1]; }
      ang = h.ang; size = h.size; gest = h.g; ok = true;
    }
  }
  const t = performance.now(), dt = Math.min(0.1, s.t ? (t - s.t) / 1000 : 0); s.t = t;
  // "works only with this pose": while the hand is not making it, the layer behaves exactly as when the hand is not
  // seen — hide, stay where it is, or go back home (the "when the hand is not seen" choice)
  const pairG = hands.pair ? hands.pair.g : '';
  const follow = ok && (!A.gest || (A.gest.startsWith('pair:') ? pairG === A.gest : gest === A.gest));
  if (follow) {
    const th = A.rot ? ang : 0, k = A.scale ? Math.max(0.05, size / (A.ref || (A.pt === 'between' ? o.w * 0.4 : o.h * 0.22))) : 1;
    // smoothness: the attached layer eases towards the hand (time-based, so it feels the same at any frame rate).
    // An invisible layer snaps straight to the hand so it never sweeps in from its old place.
    const sm = (A.smooth ?? 25) / 100, e = s.a < 0.05 || sm <= 0 ? 1 : 1 - Math.exp(-dt / (0.015 + sm * sm * 0.45));
    let dr = th - s.rot; dr = Math.atan2(Math.sin(dr), Math.cos(dr));
    s.rot += dr * e; s.k += (k - s.k) * e; s.ax += (ax - s.ax) * e; s.ay += (ay - s.ay) * e; s.size += (size - s.size) * e;
    const cs = Math.cos(s.rot), sn = Math.sin(s.rot);
    s.x = s.ax + (A.dx * cs - A.dy * sn) * s.k; s.y = s.ay + (A.dx * sn + A.dy * cs) * s.k;
  } else if (A.lost === 'home') { s.x += (L.x - s.x) * 0.18; s.y += (L.y - s.y) * 0.18; s.rot *= 0.82; s.k += (1 - s.k) * 0.18; }
  s.live = follow;
  const want = follow || A.lost !== 'hide' ? 1 : 0;
  s.a += (want - s.a) * 0.32; if (Math.abs(want - s.a) < 0.01) s.a = want;
  return s;
}
// the box a layer really occupies on stage (follows the hand when attached)
function E(L0) {
  const L = AV(L0), s = handPose(L), kx = kxOf(L), ky = kyOf(L);
  let r;
  if (s) r = { x: s.x, y: s.y, w: L.w * s.k * kx, h: L.h * s.k * ky, rot: L.rot + s.rot * 180 / Math.PI, k: s.k, s, kx, ky };
  else if (L === L0 && kx === 1 && ky === 1) r = L;
  else r = { x: L.x, y: L.y, w: L.w * kx, h: L.h * ky, rot: L.rot, k: 1, kx, ky };
  return L0._area ? areaMap(L0._area, r) : r;
}
// a layer inside an area moves, turns and scales with the area's animation: box in the area's resting place → on stage
const still = (A, V, kx, ky) => V.x === A.x && V.y === A.y && V.rot === A.rot && kx === 1 && ky === 1;
// the area's resting box: the layer itself, or — while the animation editor changes it — the box from before the edit
function restOf(A) {
  const b = hooks.rest && hooks.rest(A); if (!b) return A;
  return { x: b.x ?? A.x, y: b.y ?? A.y, w: b.w ?? A.w, h: b.h ?? A.h, rot: b.rot ?? A.rot, sc: b.sc ?? A.sc, sx: b.sx ?? A.sx, sy: b.sy ?? A.sy };
}
// how much the area's box on stage (V) is wider / taller than its resting box — what is inside scales the same
const areaKx = (V, R) => (V.w * kxOf(V)) / ((R.w || 1) * (kxOf(R) || 1)), areaKy = (V, R) => (V.h * kyOf(V)) / ((R.h || 1) * (kyOf(R) || 1));
function areaMap(A0, b) {
  const V = AV(A0), A = restOf(A0), kx = areaKx(V, A), ky = areaKy(V, A);
  let r = b;
  if (!still(A, V, kx, ky)) {
    const a0 = -A.rot * Math.PI / 180, a1 = V.rot * Math.PI / 180, dx = b.x - A.x, dy = b.y - A.y;
    const u = (dx * Math.cos(a0) - dy * Math.sin(a0)) * kx, v = (dx * Math.sin(a0) + dy * Math.cos(a0)) * ky;
    r = { x: V.x + u * Math.cos(a1) - v * Math.sin(a1), y: V.y + u * Math.sin(a1) + v * Math.cos(a1), w: b.w * kx, h: b.h * ky, rot: b.rot + V.rot - A.rot, k: b.k || 1, s: b.s, kx: (b.kx || 1) * kx, ky: (b.ky || 1) * ky };
  }
  return A0._area ? areaMap(A0._area, r) : r;
}
function areaUnmap(A0, x, y) { // a point on stage → the area's resting place
  if (A0._area) ({ x, y } = areaUnmap(A0._area, x, y));
  const V = AV(A0), A = restOf(A0), kx = areaKx(V, A), ky = areaKy(V, A);
  if (still(A, V, kx, ky)) return { x, y };
  const a1 = -V.rot * Math.PI / 180, a0 = A.rot * Math.PI / 180, dx = x - V.x, dy = y - V.y;
  const u = (dx * Math.cos(a1) - dy * Math.sin(a1)) / (kx || 1), v = (dx * Math.sin(a1) + dy * Math.cos(a1)) / (ky || 1);
  return { x: A.x + u * Math.cos(a0) - v * Math.sin(a0), y: A.y + u * Math.sin(a0) + v * Math.cos(a0) };
}
// move a layer so that its centre lands on (x, y); for a layer riding the hand this changes its offset from the hand
function setCenter(L, x, y) {
  const s = L.hand && L.hand.on ? hp.get(L.id) : null;
  if (s && s.live) { const cs = Math.cos(-s.rot), sn = Math.sin(-s.rot), dx = (x - s.ax) / s.k, dy = (y - s.ay) / s.k; L.hand.dx = dx * cs - dy * sn; L.hand.dy = dx * sn + dy * cs; s.x = x; s.y = y; }
  else {
    if (L._area) ({ x, y } = areaUnmap(L._area, x, y));
    L.x = x; L.y = y; if (s) { s.x = x; s.y = y; }
  }
}
// mouse mode feedback (preview only): thumb → index / middle / ring lines that light up as they close,
// a distance meter with the press and release marks, and what the hand is doing right now
function drawMouseMeter(o) {
  const mv = hands.mouseView; if (!mv || !mv.tr) return;
  const h = HS.find((x) => x.tr === mv.tr); if (!h) return;
  const p = h.p, sz = h.size, tips = [8, 12, 16], cols = ['124,140,255', '255,158,199', '120,220,170'];
  for (let i = 0; i < 3; i++) {
    const d = mv.d[i], held = mv.held === i, near = Math.max(0, Math.min(1, (mv.release * 1.5 - d) / (mv.release * 1.5 - mv.press)));
    octx.beginPath(); octx.moveTo(p[8], p[9]); octx.lineTo(p[tips[i] * 2], p[tips[i] * 2 + 1]);
    octx.lineWidth = Math.max(2, sz * (held ? 0.07 : 0.02 + near * 0.03)); octx.strokeStyle = `rgba(${cols[i]},${held ? 1 : 0.15 + near * 0.6})`; octx.stroke();
  }
  const ix = (p[10] + p[18]) / 2, iy = (p[11] + p[19]) / 2; // the knuckle point that drives the cursor
  octx.beginPath(); octx.arc(ix, iy, Math.max(5, sz * 0.07), 0, 6.2832); octx.fillStyle = mv.clutch ? 'rgba(255,255,255,.4)' : '#fff'; octx.fill();
  octx.lineWidth = 2.5; octx.strokeStyle = 'rgba(14,18,40,.7)'; octx.stroke();
  // meter: thumb ↔ index distance, with the press (solid) and release (dashed) marks
  const fs = Math.max(13, o.h * 0.022), W = Math.max(120, sz * 1.5), H8 = fs * 0.55, x = Math.min(o.w - W - 10, Math.max(10, h.palm[0] - W / 2)), y = Math.max(fs * 3, Math.min(...[1, 9, 17, 25, 33, 41].map((k) => p[k])) - fs * 2.6);
  const max = mv.release * 1.8, X = (v) => x + Math.min(1, v / max) * W;
  const label = { hover: T`เมาส์`, left: T`คลิก / ลาก`, right: T`คลิกขวา`, scroll: T`เลื่อนหน้า`, lift: T`ยกเมาส์` }[mv.state] || '';
  octx.font = `600 ${fs}px "IBM Plex Sans Thai", sans-serif`; octx.textAlign = 'center'; octx.textBaseline = 'middle';
  const tw = octx.measureText(label).width + fs * 1.4;
  octx.fillStyle = mv.state === 'hover' ? 'rgba(14,18,40,.75)' : mv.state === 'lift' ? 'rgba(120,130,160,.9)' : `rgba(${cols[Math.max(0, mv.held)]},.95)`;
  octx.beginPath(); octx.roundRect(x + W / 2 - tw / 2, y - fs * 1.9, tw, fs * 1.5, fs * 0.75); octx.fill();
  octx.fillStyle = '#fff'; octx.fillText(label, x + W / 2, y - fs * 1.15);
  octx.fillStyle = 'rgba(14,18,40,.6)'; octx.beginPath(); octx.roundRect(x, y, W, H8, H8 / 2); octx.fill();
  octx.fillStyle = mv.held === 0 ? `rgb(${cols[0]})` : 'rgba(255,255,255,.85)'; octx.beginPath(); octx.roundRect(x, y, Math.max(H8, X(mv.d[0]) - x), H8, H8 / 2); octx.fill();
  octx.lineWidth = 2; octx.strokeStyle = '#ffd36b'; octx.beginPath(); octx.moveTo(X(mv.press), y - 3); octx.lineTo(X(mv.press), y + H8 + 3); octx.stroke();
  octx.setLineDash([3, 3]); octx.beginPath(); octx.moveTo(X(mv.release), y - 3); octx.lineTo(X(mv.release), y + H8 + 3); octx.stroke(); octx.setLineDash([]);
}
// preview-only overlay (never sent to the virtual camera): skeleton, gesture name, hold progress, mouse zone
const ov = $('hand-ov'), octx = ov.getContext('2d');
let ovDirty = false;
function drawOverlay() {
  const o = out(), H = project.hand;
  if (ov.width !== o.w || ov.height !== o.h) { ov.width = o.w; ov.height = o.h; }
  if (ovDirty) { octx.clearRect(0, 0, o.w, o.h); ovDirty = false; }
  if (!H.on) return;
  const S = handSource();
  if (hands.zone && S) { // the part of the camera picture that maps onto the whole screen in mouse mode
    const z = hands.zone, c = S.crop, cw = 1 - c.l - c.r, ch = 1 - c.t - c.b, a = S.rot * Math.PI / 180, fh = S.flipH ? -1 : 1, fv = S.flipV ? -1 : 1;
    octx.save(); octx.translate(S.x, S.y); octx.rotate(a);
    const x0 = ((z[0] - c.l) / cw - 0.5) * S.w * fh, x1 = ((z[2] - c.l) / cw - 0.5) * S.w * fh, y0 = ((z[1] - c.t) / ch - 0.5) * S.h * fv, y1 = ((z[3] - c.t) / ch - 0.5) * S.h * fv;
    octx.setLineDash([14, 10]); octx.lineWidth = 3; octx.strokeStyle = 'rgba(255,255,255,.9)'; octx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    octx.fillStyle = 'rgba(124,140,255,.12)'; octx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    octx.restore(); ovDirty = true;
  }
  if (!HS.length) return;
  ovDirty = true;
  octx.lineCap = 'round';
  drawMouseMeter(o);
  if (!H.overlay) return;
  for (const h of HS) {
    const p = h.p, col = h.side === 'R' ? '124,140,255' : '255,158,199';
    octx.beginPath(); for (const [a, b] of BONES) { octx.moveTo(p[a * 2], p[a * 2 + 1]); octx.lineTo(p[b * 2], p[b * 2 + 1]); }
    octx.lineWidth = Math.max(3, h.size * 0.05); octx.strokeStyle = `rgba(${col},.55)`; octx.stroke();
    octx.lineWidth = Math.max(1.2, h.size * 0.016); octx.strokeStyle = 'rgba(255,255,255,.95)'; octx.stroke();
    octx.fillStyle = '#fff'; octx.beginPath(); for (let i = 0; i < 21; i++) { octx.moveTo(p[i * 2] + 3, p[i * 2 + 1]); octx.arc(p[i * 2], p[i * 2 + 1], Math.max(2, h.size * 0.022), 0, 6.2832); } octx.fill();
    const fs = Math.max(15, o.h * 0.026), txt = (h.side === 'R' ? T`ขวา` : T`ซ้าย`) + (h.g ? ' · ' + gestureName(h.g) : '') + (modelReady() && h.tr.conf != null && h.g && h.tr.pred === h.g ? ` ${Math.round(h.tr.conf * 100)}%` : '');
    octx.font = `600 ${fs}px "IBM Plex Sans Thai", "Segoe UI Emoji", sans-serif`; octx.textAlign = 'center'; octx.textBaseline = 'middle';
    const w = octx.measureText(txt).width + fs * 1.3, x = h.palm[0], y = Math.min(o.h - fs, Math.max(p[1], h.palm[1]) + h.size * 0.5);
    octx.fillStyle = `rgba(${col},.9)`; octx.beginPath(); octx.roundRect(x - w / 2, y - fs * 0.85, w, fs * 1.7, fs * 0.85); octx.fill();
    octx.fillStyle = '#fff'; octx.fillText(txt, x, y);
    if (h.tr.hold > 0) { octx.lineWidth = Math.max(5, h.size * 0.07); octx.strokeStyle = 'rgba(255,255,255,.95)'; octx.beginPath(); octx.arc(h.palm[0], h.palm[1], h.size * 0.8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, h.tr.hold)); octx.stroke(); }
  }
  // the two-hand pose, centred between the hands
  const P = hands.pair;
  if (P && P.g && P.ids.length === 2) {
    const a = HS.find((h) => h.tr.id === P.ids[0]), b = HS.find((h) => h.tr.id === P.ids[1]);
    if (a && b) {
      const fs = Math.max(16, o.h * 0.03), txt = gestureName(P.g) + (P.conf != null && P.pred === P.g ? ` ${Math.round(P.conf * 100)}%` : '');
      const x = (a.palm[0] + b.palm[0]) / 2, y = Math.max(fs * 1.2, Math.min(a.palm[1], b.palm[1]) - Math.max(a.size, b.size) * 1.1);
      octx.font = `600 ${fs}px "IBM Plex Sans Thai", "Segoe UI Emoji", sans-serif`; octx.textAlign = 'center'; octx.textBaseline = 'middle';
      const w = octx.measureText(txt).width + fs * 1.4;
      octx.fillStyle = 'rgba(255,107,139,.92)'; octx.beginPath(); octx.roundRect(x - w / 2, y - fs * 0.9, w, fs * 1.8, fs * 0.9); octx.fill();
      octx.fillStyle = '#fff'; octx.fillText(txt, x, y);
    }
  }
}

/* ------------------------------------------------------------------ drawing */
function shapePath(L, w, h, inset = 0) {
  ctx.beginPath();
  if (L.mask === 'ellipse') ctx.ellipse(0, 0, Math.max(1, w / 2 - inset), Math.max(1, h / 2 - inset), 0, 0, Math.PI * 2);
  else ctx.roundRect(-w / 2 + inset, -h / 2 + inset, Math.max(1, w - inset * 2), Math.max(1, h - inset * 2), Math.max(0, Math.min(L.radius, w / 2, h / 2) - inset));
}
function filterOf(f) {
  let s = '';
  if (f.br !== 100) s += `brightness(${f.br}%) `;
  if (f.ct !== 100) s += `contrast(${f.ct}%) `;
  if (f.sa !== 100) s += `saturate(${f.sa}%) `;
  if (f.hue) s += `hue-rotate(${f.hue}deg) `;
  if (f.gray) s += `grayscale(${f.gray}%) `;
  if (f.sepia) s += `sepia(${f.sepia}%) `;
  if (f.blur) s += `blur(${f.blur * rs}px) `; // filters and shadows ignore the canvas transform → follow the render scale
  return s || 'none';
}
const setShadow = (L) => { ctx.shadowColor = 'rgba(8,12,40,.55)'; ctx.shadowBlur = L.shadow * rs; ctx.shadowOffsetY = L.shadow * 0.35 * rs; };
const noShadow = () => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; };
let frameNo = 0, alphaK = 1, rs = 1; // alphaK: opacity of the area being drawn (multiplies the layers inside it)

const segm = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null, gCache = new Map();
function graphemes(s) { // whole characters (Thai vowels and tone marks stay with their consonant)
  s = String(s || ''); let g = gCache.get(s);
  if (!g) { g = segm ? [...segm.segment(s)].map((x) => x.segment).filter((x) => x !== '\n') : [...s.replace(/\n/g, '')]; if (gCache.size > 200) gCache.clear(); gCache.set(s, g); }
  return g;
}
function textMetrics(L) {
  const lines = String(L.text || ' ').split('\n');
  const pad = L.bg ? L.h * 0.16 / lines.length : 0;
  const size = Math.max(6, (L.h - pad * 2) / (lines.length * 1.25));
  ctx.font = `${L.weight || 600} ${size}px "${L.font}", "IBM Plex Sans Thai", "Segoe UI Emoji", sans-serif`;
  let mw = 1; for (const l of lines) mw = Math.max(mw, ctx.measureText(l).width);
  return { lines, size, pad, w: mw + (L.bg ? size * 0.9 : size * 0.1) };
}

function drawLayer(L, now) {
  if (L.type === 'handfx') { if (!L.fx) L.fx = { ...FX_DEFAULT }; drawHandFx(ctx, L, HS, now, out(), hands.pair); return; }
  const hs = handPose(L);
  if (hs && hs.a <= 0.01) return;
  ctx.save();
  if (hs) { ctx.translate(hs.x, hs.y); ctx.rotate(L.rot * Math.PI / 180 + hs.rot); ctx.scale(hs.k, hs.k); ctx.globalAlpha = L.op * hs.a * alphaK; }
  else { ctx.translate(L.x, L.y); ctx.rotate(L.rot * Math.PI / 180); ctx.globalAlpha = L.op * alphaK; }
  const kx = kxOf(L), ky = kyOf(L);
  if (kx !== 1 || ky !== 1) { if (Math.abs(kx) < 1e-4 || Math.abs(ky) < 1e-4) { ctx.restore(); return; } ctx.scale(kx, ky); }
  ctx.globalCompositeOperation = L.blend || 'source-over';
  if (L.type === 'text') {
    const m = textMetrics(L); L.w = m.w;
    if (L.bg) { if (L.shadow) setShadow(L); ctx.fillStyle = L.bgColor; ctx.beginPath(); ctx.roundRect(-L.w / 2, -L.h / 2, L.w, L.h, Math.min(L.radius || L.h * 0.28, L.h / 2)); ctx.fill(); noShadow(); }
    else if (L.shadow) setShadow(L);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const lh = m.size * 1.25, y0 = -((m.lines.length - 1) * lh) / 2;
    let left = L.reveal != null && L.reveal < 100 ? Math.round(graphemes(L.text).length * Math.max(0, L.reveal) / 100) : -1; // typewriter
    m.lines.forEach((ln, i) => {
      let x = 0;
      if (left >= 0) { const g = graphemes(ln); if (left < g.length) { x = -ctx.measureText(ln).width / 2; ctx.textAlign = 'left'; ln = g.slice(0, left).join(''); } left = Math.max(0, left - g.length); if (!ln) return; }
      if (L.stroke) { ctx.lineWidth = L.stroke * m.size / 40; ctx.strokeStyle = L.strokeColor; ctx.strokeText(ln, x, y0 + i * lh); }
      ctx.fillStyle = L.color; ctx.fillText(ln, x, y0 + i * lh);
      ctx.textAlign = 'center';
    });
  } else if (L.type === 'shape') {
    if (L.shadow) setShadow(L);
    if (L.grad) { const g = ctx.createLinearGradient(-L.w / 2, -L.h / 2, L.w / 2, L.h / 2); g.addColorStop(0, L.fill); g.addColorStop(1, L.fill2); ctx.fillStyle = g; } else ctx.fillStyle = L.fill;
    shapePath(L, L.w, L.h); ctx.fill(); noShadow();
  } else if (L.type === 'frame') {
    if (L.shadow) setShadow(L);
  } else {
    const r = rt.get(L.id), n = natural(L);
    if (!n) {
      if (r && r.el && (r.el.videoWidth || r.el.naturalWidth)) { r.ready = true; onReady(L); }
      // placeholder while the source starts (or needs to be picked again)
      shapePath(L, L.w, L.h); ctx.fillStyle = 'rgba(124,140,255,.22)'; ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 2; ctx.setLineDash([10, 8]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `600 ${Math.max(13, Math.min(26, L.w / 16))}px "IBM Plex Sans Thai", sans-serif`;
      const failed = r && r.cam && r.cam.failed;
      if (failed && r.cam.err) { ctx.font = '12px sans-serif'; ctx.fillText(r.cam.err, 0, 28, L.w - 20); ctx.font = `600 ${Math.max(13, Math.min(26, L.w / 16))}px "IBM Plex Sans Thai", sans-serif`; }
      ctx.fillText(failed ? (r.cam.held ? T`ครั้งก่อนกล้องค้าง — ดับเบิลคลิกเพื่อลองเปิดใหม่` : T`เปิดกล้องไม่ได้ (ดับเบิลคลิกเพื่อลองใหม่)`) : L.type === 'screen' ? T`ดับเบิลคลิกเพื่อเลือกหน้าจออีกครั้ง` : L.type === 'video' ? T`ดับเบิลคลิกเพื่อเลือกไฟล์วิดีโออีกครั้ง` : T`กำลังเปิด…`, 0, 0, L.w - 20);
    } else {
      let src = r.el;
      const fx = L.key.on || L.ai.mode !== 'off';
      if (fx) {
        if (!r.proc) r.proc = createProc();
        if (r.proc) {
          let hasMask = false;
          if (L.ai.mode !== 'off') {
            if (segState() === 'idle') loadSegmenter().then(() => { if (segState() === 'failed') toast(T`โหลดโมเดล AI ไม่สำเร็จ`, { kind: 'err' }); renderProps(); });
            const every = segEvery(liveFps(out().fps));
            if (segState() === 'ready' && L.type !== 'image' ? (frameNo + (r.seed ??= Math.floor(Math.random() * every))) % every === 0 || !r.mask : !r.mask) {
              const t0 = performance.now(), m = segment(r.el, r.mask); ema('seg', performance.now() - t0); if (m) { r.mask = m; r.proc.setMask(m.bytes, m.w, m.h); }
            }
            hasMask = !!r.mask;
          }
          src = r.proc.render(r.el, n.w, n.h, L, hasMask) || r.el;
        }
      } else if (r.proc) { r.proc.dispose(); r.proc = null; r.mask = null; }
      const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
      const c = L.crop, sx = c.l * sw, sy = c.t * sh, sW = Math.max(1, (1 - c.l - c.r) * sw), sH = Math.max(1, (1 - c.t - c.b) * sh);
      const shaped = L.radius > 0 || L.mask === 'ellipse';
      const transparent = fx && (L.key.on || L.ai.mode === 'remove');
      if (L.shadow && shaped && !transparent) { setShadow(L); ctx.fillStyle = '#000'; shapePath(L, L.w, L.h, 1); ctx.fill(); noShadow(); }
      ctx.save();
      if (shaped) { shapePath(L, L.w, L.h); ctx.clip(); } else if (L.shadow) setShadow(L);
      ctx.filter = filterOf(L.f);
      ctx.scale(L.flipH ? -1 : 1, L.flipV ? -1 : 1);
      try { ctx.drawImage(src, sx, sy, sW, sH, -L.w / 2, -L.h / 2, L.w, L.h); } catch { /* source went away mid-frame */ }
      ctx.restore();
    }
  }
  if (L.border > 0 && L.type !== 'text' ) { noShadow(); ctx.filter = 'none'; shapePath(L, L.w, L.h, L.border / 2); ctx.lineWidth = L.border; ctx.strokeStyle = L.borderColor; ctx.stroke(); }
  ctx.restore();
}

// an area: its background, then its own layers (clipped to the box), moved / turned / scaled by the area's animation
function drawArea(A, V, now) {
  const kv = kxOf(V), lv = kyOf(V); if (Math.abs(kv) < 1e-4 || Math.abs(lv) < 1e-4) return;
  const w = V.w * kv, h = V.h * lv, a0 = alphaK;
  ctx.save(); ctx.translate(V.x, V.y); ctx.rotate(V.rot * Math.PI / 180);
  alphaK = a0 * V.op;
  try {
    if (V.bg) { ctx.globalAlpha = alphaK; if (V.shadow) setShadow(V); ctx.fillStyle = V.fill || '#1c2140'; shapePath(V, w, h); ctx.fill(); noShadow(); }
    ctx.save();
    if (V.clip !== false) { shapePath(V, w, h); ctx.clip(); }
    const R = restOf(A); // what is inside is drawn like one picture of the area: moved, turned and scaled with its box
    ctx.scale(areaKx(V, R), areaKy(V, R)); ctx.rotate(-R.rot * Math.PI / 180); ctx.translate(-R.x, -R.y);
    if (A.slides && A.slides.on && scope !== A.id) drawSlides(A, now); else drawList(A.kids, now);
    ctx.restore();
    if (V.border > 0) { ctx.globalAlpha = alphaK; ctx.globalCompositeOperation = 'source-over'; shapePath(V, w, h, V.border / 2); ctx.lineWidth = V.border; ctx.strokeStyle = V.borderColor; ctx.stroke(); }
  } finally { ctx.restore(); alphaK = a0; }
}
function drawList(arr, now) {
  for (const L of arr) {
    const V = AV(L); if (!V.vis) continue;
    if (L.type === 'area') { try { drawArea(L, V, now); } catch (err) { console.error('area', err); } continue; }
    try { drawLayer(V, now); } catch (err) { console.error('layer', L.type, err); ctx.restore(); }
    if (V !== L && L.type === 'text' && V.h) L.w = V.w * (L.h / V.h); // keep the base box of a text layer in step with its text
  }
}
const animEnv = { get scene() { return scene(); }, hands: HS, out, byId, fire: (a) => bus.emit('anim:event', a), get pair() { return hands.pair ? hands.pair.g : ''; } };
let fpsN = 0, fpsT = performance.now();
function draw() {
  const o = out();
  const t0 = performance.now();
  rs = canvas.width / o.w;
  ctx.setTransform(rs, 0, 0, rs, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#05060f'; ctx.fillRect(0, 0, o.w, o.h);
  frameNo++;
  const now = performance.now();
  try { trackHands(now); } catch (err) { console.error('hands', err); }
  bus.emit('hand:tick', now);
  try { animFrame(scene(), now, animEnv); } catch (err) { console.error('anim', err); }
  alphaK = 1; linkKids(root()); syncAreas(); drawList(root(), now);
  try { drawOverlay(); } catch (err) { console.error('overlay', err); }
  fpsN++;
  if (now - fpsT >= 1000) { $('st-text').textContent = `${Math.round(fpsN * 1000 / (now - fpsT))} fps`; fpsN = 0; fpsT = now; }
  placeGizmo();
  ema('draw', performance.now() - t0);
  if (recTrack) recTrack.requestFrame();
  bus.emit('frame', canvas);
  frameDone(now, o.fps);
}

/* ----------------------------------------------------- output size change */
// New canvas size (e.g. portrait ↔ landscape). Positions follow the canvas; sizes scale by the change in area
// (√(kx·ky)), so switching back and forth never shrinks anything. A layer that filled the old canvas (camera,
// background, frame, full-screen area) fills the new one — media by re-cropping instead of squashing.
// Keyframes move with their layers; an area carries what is inside it the same way.
function resizeOut(w, h) {
  const o = out(); if (!w || !h || (w === o.w && h === o.h)) return;
  const ow = o.w, oh = o.h, kx = w / ow, ky = h / oh, k = Math.sqrt(kx * ky);
  o.w = w; o.h = h; applyOut();
  const fills = (L) => { const r = ((L.rot % 180) + 180) % 180; return (r < 1 || r > 179) && Math.abs(L.x - ow / 2) < ow * 0.04 && Math.abs(L.y - oh / 2) < oh * 0.04 && L.w * kxOf(L) >= ow * 0.94 && L.h * kyOf(L) >= oh * 0.94; };
  for (const sc of project.scenes) {
    const clips = sc.clips || [];
    for (const L of sc.layers) {
      if (L.type === 'handfx') { L.x = w / 2; L.y = h / 2; L.w = w; L.h = h; continue; }
      const full = fills(L), fw = full ? kx : k, fh = full ? ky : k, f = L.type === 'area' ? (setF(L), L._f) : null;
      for (const c of clips) for (const t of c.tracks) if (t.layer === L.id) {
        const m = t.prop === 'x' ? kx : t.prop === 'y' ? ky : t.prop === 'w' ? fw : t.prop === 'h' ? fh : t.prop === 'radius' || t.prop === 'border' ? k : 1;
        if (m !== 1) t.keys.forEach((q) => { if (typeof q.v === 'number') q.v *= m; });
      }
      L.x *= kx; L.y *= ky;
      const n = full && MEDIA.has(L.type) ? natural(L) : null;
      if (n) { // fill the new canvas: crop the source to its shape (centred)
        const want = (L.w * fw) / (L.h * fh), src = n.w / n.h; L.crop = { l: 0, t: 0, r: 0, b: 0 };
        if (src > want) L.crop.l = L.crop.r = (1 - want / src) / 2; else L.crop.t = L.crop.b = (1 - src / want) / 2;
        L.w *= fw; L.h *= fh;
      } else if (L.type === 'text') L.h *= k;
      else if (full && MEDIA.has(L.type)) { L.w *= k; L.h *= k; } // source not open yet: keep its shape
      else { L.w *= fw; L.h *= fh; }
      if (L.radius) L.radius *= k;
      if (L.border) L.border *= k;
      if (f) { carryKids(L, f, clips, k); setF(L); }
    }
  }
  commit(); refreshAll(); bus.emit('out', o);
  toast(T`เปลี่ยนขนาดภาพเป็น ${w} × ${h} แล้ว`, { label: T`ย้อนกลับ`, action: () => step(['studio', 'anim'], true) });
}

/* ------------------------------------------------------------- stage layout */
let view = 1; // css px per output px
function layout() {
  const a = $('scene-area').getBoundingClientRect(), o = out();
  view = Math.max(0.05, Math.min(a.width / o.w, a.height / o.h));
  box.style.width = Math.round(o.w * view) + 'px'; box.style.height = Math.round(o.h * view) + 'px';
  view = Math.round(o.w * view) / o.w;
}
let appliedFps = 0;
function applyOut() {
  const o = out();
  // light mode / auto quality draw fewer pixels; the GPU converter scales the picture back to full size for the camera
  const k = renderScale(), cw = Math.max(2, Math.round(o.w * k)), ch = Math.max(2, Math.round(o.h * k));
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  $('out-res').value = `${o.w}x${o.h}`;
  $('out-fps').value = String(o.fps > 30 ? 60 : 30);
  if (appliedFps && appliedFps !== o.fps) { bus.emit('fps', o.fps); applySourceFps(); } // undo / redo / loading a project changed it
  appliedFps = o.fps;
  layout();
}
// axis-aligned box around several layers (their rotated corners)
function groupBox(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const L of list) {
    const e = E(L), a = e.rot * Math.PI / 180, c = Math.cos(a), s2 = Math.sin(a);
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const x = e.x + (u * e.w / 2) * c - (v * e.h / 2) * s2, y = e.y + (u * e.w / 2) * s2 + (v * e.h / 2) * c; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}
const selBoxes = document.createElement('div'); selBoxes.id = 'sel-boxes'; box.insertBefore(selBoxes, gizmo);
// editing inside an area: the rest of the stage is dimmed (preview only — never sent to the camera output)
const dimEl = document.createElement('div'); dimEl.id = 'area-dim'; dimEl.className = 'hidden'; dimEl.innerHTML = '<i></i>'; box.insertBefore(dimEl, selBoxes);
const crumb = document.createElement('div'); crumb.id = 'area-crumb'; crumb.className = 'glass hidden'; $('scene-area').appendChild(crumb);
crumb.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (!b) return; if (b.dataset.go === 'out') exitArea(); else if (b.dataset.go === 'root') exitAll(); });
let crumbKey = '';
function placeFocus() {
  const A = curArea();
  dimEl.classList.toggle('hidden', !A); crumb.classList.toggle('hidden', !A);
  if (!A) { crumbKey = ''; return; }
  const e = E(A), w = e.w * view, h = e.h * view, f = dimEl.firstChild;
  f.style.width = w + 'px'; f.style.height = h + 'px';
  f.style.transform = `translate(${e.x * view - w / 2}px,${e.y * view - h / 2}px) rotate(${e.rot}deg)`;
  f.style.borderRadius = A.mask === 'ellipse' ? '50%' : Math.min(A.radius || 0, e.w / 2, e.h / 2) * view + 'px';
  const path = []; for (let p = A; p; p = parentOf(p.id)) path.unshift(p);
  const key = path.map((p) => p.id + p.name).join('|') + A.kids.length;
  if (key !== crumbKey) {
    crumbKey = key;
    crumb.innerHTML = `<button class="pill-btn" data-go="out">${icon('arrowl')}<span>${path.length > 1 ? T`ออกไปชั้นบน` : T`กลับเลเยอร์หลัก`}</span></button><span class="crumb-path">${icon('area')}${path.map((p) => esc(p.name)).join(' › ')}<small>${T`${A.kids.length} ชิ้น`}</small></span>`;
  }
}
let selBoxN = -1;
function placeGizmo() {
  placeFocus();
  const S = sels().filter((l) => l.type !== 'handfx' && AV(l).vis);
  if (S.length > 1) { // several layers: one box around all of them, a thin outline on each
    const b = groupBox(S), w = b.w * view, h = b.h * view;
    gizmo.classList.remove('hidden', 'crop'); gizmo.classList.add('multi');
    gizmo.classList.toggle('locked', S.every((l) => l.lock));
    gizmo.style.width = w + 'px'; gizmo.style.height = h + 'px';
    gizmo.style.transform = `translate(${b.x0 * view}px,${b.y0 * view}px)`;
    if (selBoxN !== S.length) { selBoxN = S.length; selBoxes.innerHTML = S.map(() => '<i></i>').join(''); }
    S.forEach((L, i) => { const e = E(L), el = selBoxes.children[i], ew = e.w * view, eh = e.h * view; el.style.width = ew + 'px'; el.style.height = eh + 'px'; el.style.transform = `translate(${e.x * view - ew / 2}px,${e.y * view - eh / 2}px) rotate(${e.rot}deg)`; });
    return;
  }
  gizmo.classList.remove('multi');
  if (selBoxN) { selBoxN = 0; selBoxes.innerHTML = ''; }
  const L = sel();
  if (!L || !AV(L).vis || L.type === 'handfx') { gizmo.classList.add('hidden'); return; }
  const e = E(L);
  if (e.s && e.s.a < 0.5) { gizmo.classList.add('hidden'); return; }
  gizmo.classList.remove('hidden');
  gizmo.classList.toggle('crop', cropMode && MEDIA.has(L.type));
  gizmo.classList.toggle('locked', !!L.lock);
  const w = e.w * view, h = e.h * view;
  gizmo.style.width = w + 'px'; gizmo.style.height = h + 'px';
  gizmo.style.transform = `translate(${e.x * view - w / 2}px,${e.y * view - h / 2}px) rotate(${e.rot}deg)`;
}

/* -------------------------------------------------------------- interaction */
const toScene = (e) => { const r = box.getBoundingClientRect(); return { x: (e.clientX - r.left) / view, y: (e.clientY - r.top) / view }; };
const toLocal = (L, p) => { const a = -L.rot * Math.PI / 180, dx = p.x - L.x, dy = p.y - L.y; return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) }; };
// every clickable layer under the point, top first. Small layers count as at least 24 screen px wide / high, so a thin
// line of text or a small sticker can still be grabbed.
function hitAll(p) {
  const a = layers(), r = [], min = 12 / view;
  for (let i = a.length - 1; i >= 0; i--) {
    const L = a[i]; if (!AV(L).vis || L.lock || L.type === 'handfx') continue;
    const e = E(L); if (e.s && e.s.a < 0.5) continue;
    const q = toLocal(e, p), hw = Math.max(e.w / 2, min), hh = Math.max(e.h / 2, min);
    if (Math.abs(q.x) > hw || Math.abs(q.y) > hh) continue;
    if (L.type === 'frame') { const b = L.border + 10 / view; if (Math.abs(q.x) < hw - b && Math.abs(q.y) < hh - b) continue; }
    r.push(L);
  }
  return r;
}
const hit = (p) => hitAll(p)[0] || null;
// what a press picks → [layer, swap]. Dragging on the selected layer moves it even when other layers lie on top of it;
// a plain click (no drag) there still selects the top layer (`swap`, applied in endOp). Alt+click = the next layer below.
function pick(p, e) {
  const all = hitAll(p); if (!all.length) return [null, null];
  if (e.altKey) { const i = all.findIndex((l) => l.id === selId); return [all[(i + 1) % all.length], null]; }
  const k = !multi(e) && all.find((l) => selSet.has(l.id));
  return k && k !== all[0] ? [k, all[0]] : [all[0], null];
}
// mode: undefined = only this one · 'toggle' (Ctrl) · 'add' · 'range' (Shift, in the layer list)
function select(id, mode) {
  syncSel();
  // a layer inside an area (picked in the timeline, the menu, …): open that area so the stage and the selection work on it
  if (id) { const P = parentOf(id); if (P !== undefined && (P ? P.id : null) !== scope) { scope = P ? P.id : null; selId = id; selSet = new Set([id]); cropMode = false; refreshAll(); bus.emit('scope', scope); bus.emit('select', selId); return; } }
  const before = selId + '|' + [...selSet].join();
  if (!id) { selId = null; selSet.clear(); }
  else if (mode === 'toggle') { if (selSet.has(id)) { selSet.delete(id); if (selId === id) selId = [...selSet].pop() || null; } else { selSet.add(id); selId = id; } }
  else if (mode === 'add') { selSet.add(id); selId = id; }
  else if (mode === 'range' && selId) { const a = layers(), i = a.findIndex((l) => l.id === selId), j = a.findIndex((l) => l.id === id); for (let k = Math.min(i, j); k <= Math.max(i, j); k++) selSet.add(a[k].id); selId = id; }
  else { selSet = new Set([id]); selId = id; }
  if (!selId || selSet.size > 1) cropMode = false;
  if (before === selId + '|' + [...selSet].join()) return;
  renderLayers(); renderProps(); placeGizmo();
  bus.emit('select', selId);
}
function selectMany(ids) {
  if (ids.length) { // all in one list: the one of the last picked layer
    const P = parentOf(ids[ids.length - 1]), want = P ? P.id : null;
    if (P !== undefined) { ids = ids.filter((id) => { const Q = parentOf(id); return (Q ? Q.id : null) === want; }); if (want !== scope) { scope = want; refreshAll(); bus.emit('scope', scope); } }
  }
  selSet = new Set(ids); selId = ids.length ? ids[ids.length - 1] : null; cropMode = false; renderLayers(); renderProps(); placeGizmo(); bus.emit('select', selId); }
function showMarquee(r) {
  let m = guides.querySelector('.mq');
  if (!r) { if (m) m.remove(); return; }
  if (!m) { m = document.createElement('b'); m.className = 'mq'; guides.appendChild(m); }
  m.style.left = Math.min(r.x0, r.x1) * view + 'px'; m.style.top = Math.min(r.y0, r.y1) * view + 'px';
  m.style.width = Math.abs(r.x1 - r.x0) * view + 'px'; m.style.height = Math.abs(r.y1 - r.y0) * view + 'px';
}
function showGuides(vx, hy) {
  guides.innerHTML = (vx != null ? `<i class="v" style="left:${vx * view}px"></i>` : '') + (hy != null ? `<i class="h" style="top:${hy * view}px"></i>` : '');
}
let op = null;
const multi = (e) => e.ctrlKey || e.metaKey;
// start of a stage edit on several layers: remember where each one was
// (animation mode: begin() first stands each layer where the animation shows it — otherwise the sizes / turns
// remembered here are the un-animated ones and the group jumps or warps on the first move)
function groupItems(list) {
  list = list.filter((l) => !l.lock && l.type !== 'handfx');
  if (hooks.begin) for (const L of list) hooks.begin(L);
  return list.map((L) => { const e = E(L); return { L, x: e.x, y: e.y, w: L.w, h: L.h, rot: L.rot, kx: e.w / Math.max(1e-6, L.w), ky: e.h / Math.max(1e-6, L.h) }; });
}
box.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  const e0x = e.clientX, e0y = e.clientY; pendingSwap = null;
  const p = toScene(e), hEl = e.target.closest('[data-h]');
  if (!hEl && scope && leaveAreaAt(p)) { /* clicked outside the area being edited: back out, then this click works out there */ }
  let L = sel();
  const S = sels().filter((l) => l.type !== 'handfx');
  if (hEl && S.length > 1) { // handles of the group box
    const items = groupItems(S), b = groupBox(S); if (!items.length) return;
    const h = hEl.dataset.h;
    op = h === 'rot' ? { kind: 'grot', items, b, p0: Math.atan2(p.y - b.cy, p.x - b.cx) }
      : { kind: 'gsize', items, b, hx: h.includes('w') ? -1 : h.includes('e') ? 1 : 0, hy: h.includes('n') ? -1 : h.includes('s') ? 1 : 0 };
    box.setPointerCapture(e.pointerId); e.preventDefault(); return;
  }
  if (!hEl) {
    const [H, swap] = pick(p, e);
    pendingSwap = swap;
    if (multi(e)) { // Ctrl: add / remove from the selection; Ctrl on empty space adds a drag box
      if (H) { select(H.id, 'toggle'); if (!selSet.has(H.id)) { e.preventDefault(); return; } }
      else { op = { kind: 'marquee', r: { x0: p.x, y0: p.y, x1: p.x, y1: p.y }, add: true }; box.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    } else if (!H) { select(null); op = { kind: 'marquee', r: { x0: p.x, y0: p.y, x1: p.x, y1: p.y }, add: false }; box.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    else if (!selSet.has(H.id)) select(H.id);
    else if (selId !== H.id) { selId = H.id; renderLayers(); renderProps(); bus.emit('select', selId); }
    const G = sels().filter((l) => l.type !== 'handfx');
    if (G.length > 1) { // drag the whole group
      const items = groupItems(G); if (!items.length) return;
      op = { kind: 'gmove', items, p0: p, b: groupBox(G), moved: false, sx: e0x, sy: e0y, swap: pendingSwap };
      box.setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    L = H;
  }
  if (hEl && L && !L.lock) {
    const h = hEl.dataset.h, e = E(L);
    op = h === 'rot' ? { kind: 'rot', L, a0: L.rot, p0: Math.atan2(p.y - e.y, p.x - e.x) }
      : { kind: 'size', L, hx: h.includes('w') ? -1 : h.includes('e') ? 1 : 0, hy: h.includes('n') ? -1 : h.includes('s') ? 1 : 0, s: { x: e.x, y: e.y, w: e.w, h: e.h, rot: e.rot, k: e.k || 1, kx: e.kx || 1, ky: e.ky || 1, crop: { ...L.crop } } };
  } else {
    if (!L || L.lock) return;
    const e = E(L);
    op = { kind: 'move', L, dx: p.x - e.x, dy: p.y - e.y, moved: false, sx: e0x, sy: e0y, swap: pendingSwap };
  }
  if (!op) return;
  if (hooks.begin) hooks.begin(op.L);
  box.setPointerCapture(e.pointerId); e.preventDefault();
});
function groupMove(e, p) {
  const o = out(), b = op.b;
  let dx = p.x - op.p0.x, dy = p.y - op.p0.y, gx = null, gy = null;
  if (!e.altKey) { // snap the group's edges / centre to the canvas
    const t = 9 / view;
    for (const [edge, line] of [[b.cx, o.w / 2], [b.x0, 0], [b.x1, o.w]]) if (Math.abs(edge + dx - line) < t) { dx = line - edge; gx = line; break; }
    for (const [edge, line] of [[b.cy, o.h / 2], [b.y0, 0], [b.y1, o.h]]) if (Math.abs(edge + dy - line) < t) { dy = line - edge; gy = line; break; }
  }
  for (const it of op.items) setCenter(it.L, it.x + dx, it.y + dy);
  op.moved = op.moved || Math.abs(dx) + Math.abs(dy) > 0.5; showGuides(gx, gy);
}
function groupSize(e, p) {
  const b = op.b, { hx, hy } = op;
  const ax = hx > 0 ? b.x0 : hx < 0 ? b.x1 : b.cx, ay = hy > 0 ? b.y0 : hy < 0 ? b.y1 : b.cy; // the side that stays put
  let kx = hx ? Math.max(0.05, (hx * (p.x - ax)) / Math.max(1, b.w)) : 1, ky = hy ? Math.max(0.05, (hy * (p.y - ay)) / Math.max(1, b.h)) : 1;
  if (hx && hy && !e.shiftKey) kx = ky = Math.max(kx, ky);
  for (const it of op.items) {
    const L = it.L, r = ((it.rot % 180) + 180) % 180, side = Math.abs(r - 90) < 1;
    const flat = r < 1 || r > 179 || side, uni = kx === ky ? kx : Math.sqrt(kx * ky);
    const sw = flat ? (side ? ky : kx) : uni, sh = flat ? (side ? kx : ky) : uni;
    if (L.type === 'text') L.h = Math.max(6, it.h * (hy ? sh : sw)); else { L.w = Math.max(4, it.w * sw); L.h = Math.max(4, it.h * sh); }
    setCenter(L, ax + (it.x - ax) * kx, ay + (it.y - ay) * ky);
  }
}
function groupRot(e, p) {
  const b = op.b;
  let da = (Math.atan2(p.y - b.cy, p.x - b.cx) - op.p0) * 180 / Math.PI;
  da = ((da + 540) % 360) - 180;
  if (e.shiftKey) da = Math.round(da / 15) * 15;
  const r = da * Math.PI / 180, c = Math.cos(r), s2 = Math.sin(r);
  for (const it of op.items) {
    const dx = it.x - b.cx, dy = it.y - b.cy;
    it.L.rot = ((it.rot + da + 540) % 360) - 180;
    setCenter(it.L, b.cx + dx * c - dy * s2, b.cy + dx * s2 + dy * c);
  }
}
box.addEventListener('pointermove', (e) => {
  if (!op) { box.style.cursor = e.target === box || e.target.closest('#scene') ? (hit(toScene(e)) ? 'move' : '') : ''; return; }
  // a click that wobbles a few pixels is a click, not a move
  if ((op.kind === 'move' || op.kind === 'gmove') && !op.moved && Math.hypot(e.clientX - op.sx, e.clientY - op.sy) < 4) return;
  const p = toScene(e), L = op.L, o = out();
  if (op.kind === 'marquee') { op.r.x1 = p.x; op.r.y1 = p.y; showMarquee(op.r); return; }
  if (op.kind === 'gmove' || op.kind === 'move') stageAreaHint(e, p);
  if (op.kind === 'gmove') { groupMove(e, p); syncNums(); return; }
  if (op.kind === 'gsize') { groupSize(e, p); syncNums(); return; }
  if (op.kind === 'grot') { groupRot(e, p); syncNums(); return; }
  if (op.kind === 'move') {
    let x = p.x - op.dx, y = p.y - op.dy, gx = null, gy = null;
    if (!e.altKey) { // snap edges / centre to the canvas
      const t = E(L).s ? -1 : 9 / view, flat = Math.abs(((L.rot % 180) + 180) % 180) < 0.5, hw = flat ? L.w / 2 : 0, hh = flat ? L.h / 2 : 0;
      for (const [edge, line] of [[0, o.w / 2], [-hw, 0], [hw, o.w]]) if ((edge || line === o.w / 2) && Math.abs(x + edge - line) < t) { x = line - edge; gx = line; break; }
      for (const [edge, line] of [[0, o.h / 2], [-hh, 0], [hh, o.h]]) if ((edge || line === o.h / 2) && Math.abs(y + edge - line) < t) { y = line - edge; gy = line; break; }
    }
    setCenter(L, x, y); op.moved = true; showGuides(gx, gy);
  } else if (op.kind === 'rot') {
    const e = E(L);
    let a = op.a0 + (Math.atan2(p.y - e.y, p.x - e.x) - op.p0) * 180 / Math.PI;
    a = ((a + 540) % 360) - 180;
    if (e.shiftKey) a = Math.round(a / 15) * 15;
    else for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(a - s) < 3) a = s;
    L.rot = a;
  } else {
    const s = op.s, { hx, hy } = op;
    const q = toLocal({ x: s.x, y: s.y, rot: s.rot }, p);
    const ax = -hx * s.w / 2, ay = -hy * s.h / 2;
    let w = hx ? Math.max(16, hx * (q.x - ax)) : s.w, h = hy ? Math.max(16, hy * (q.y - ay)) : s.h;
    const cropping = (cropMode || e.altKey) && MEDIA.has(L.type);
    if (cropping) {
      // the picture stays where it is; the handle only reveals or hides more of it
      const c = { ...s.crop };
      if (hx) { const full = s.w / (1 - s.crop.l - s.crop.r), side = (hx === 1) !== !!L.flipH ? 'r' : 'l', v = clamp(s.crop[side] - (w - s.w) / full, 0, 1 - s.crop[side === 'r' ? 'l' : 'r'] - 0.04); c[side] = v; w = full * (1 - c.l - c.r); }
      if (hy) { const full = s.h / (1 - s.crop.t - s.crop.b), side = (hy === 1) !== !!L.flipV ? 'b' : 't', v = clamp(s.crop[side] - (h - s.h) / full, 0, 1 - s.crop[side === 'b' ? 't' : 'b'] - 0.04); c[side] = v; h = full * (1 - c.t - c.b); }
      L.crop = c;
    } else if (L.type === 'text') { h = hy ? h : s.h * (w / s.w); w = s.w * (h / s.h); }
    else if (hx && hy && !e.shiftKey) { const k = Math.max(w / s.w, h / s.h); w = s.w * k; h = s.h * k; }
    else if (MEDIA.has(L.type) && !e.shiftKey) { if (hx) h = s.h * (w / s.w); else w = s.w * (h / s.h); } // pictures / video never stretch from an edge either (Shift = stretch)
    const cx = ax + hx * w / 2, cy = ay + hy * h / 2, a = s.rot * Math.PI / 180;
    L.w = w / s.k / s.kx; L.h = h / s.k / s.ky;
    setCenter(L, s.x + cx * Math.cos(a) - cy * Math.sin(a), s.y + cx * Math.sin(a) + cy * Math.cos(a));
    if (L.type === 'area' && e.altKey && !hooks.begin) setF(L); // Alt: only the box changes, what is inside stays put
  }
  syncNums();
});
// while dragging layers on the stage over an area: hold Ctrl and let go to put them into it
const stageHint = document.createElement('div'); stageHint.id = 'stage-hint'; stageHint.className = 'hidden'; document.body.appendChild(stageHint);
function stageAreaHint(e, p) {
  const moving = op.items ? op.items.map((it) => it.L) : [op.L];
  const A = areaAt(p, moving);
  op.into = A && e.ctrlKey && !moving.some((x) => x.type === 'handfx') ? A : null;
  showStageDrop(op.into);
  stageHint.classList.toggle('hidden', !A); stageHint.classList.toggle('ok', !!op.into);
  if (A) {
    const label = op.into ? T`ปล่อยเพื่อใส่ใน “${A.name}”` : T`กด Ctrl ค้างแล้วปล่อย = ใส่ใน “${A.name}”`;
    if (stageHint._k !== label) { stageHint._k = label; stageHint.innerHTML = `${icon('area')}<span>${esc(label)}</span>`; }
    stageHint.style.transform = `translate(${e.clientX + 16}px,${e.clientY + 18}px)`;
  }
}
let pendingSwap = null;
const endOp = () => {
  if (!op) return;
  const o = op; op = null; showGuides(null, null);
  if (o.swap && !o.moved) { if (o.items) { if (hooks.end) for (const it of o.items) hooks.end(it.L); } else if (hooks.end) hooks.end(o.L); stageHint.classList.add('hidden'); select(o.swap.id); return; }
  stageHint.classList.add('hidden'); showStageDrop(null);
  if (o.into) { // finish the move first (one undo step together with the move into the area)
    if (o.items) { if (hooks.end) for (const it of o.items) hooks.end(it.L); } else if (hooks.end) hooks.end(o.L);
    moveLayers(o.items ? o.items.map((it) => it.L) : [o.L], { kind: 'into', A: o.into });
    return;
  }
  if (o.kind === 'marquee') { // drag box: everything it touches
    showMarquee(null);
    const r = o.r, x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
    if (x1 - x0 < 3 && y1 - y0 < 3) return;
    const got = layers().filter((l) => { if (!AV(l).vis || l.lock || l.type === 'handfx') return false; const b = groupBox([l]); return b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1; }).map((l) => l.id);
    selectMany(o.add ? [...new Set([...sels().map((l) => l.id), ...got])] : got);
    return;
  }
  if (o.items) { if (hooks.end) for (const it of o.items) hooks.end(it.L); if (o.kind !== 'gmove' || o.moved) commit(); renderProps(); return; }
  const moved = o.kind !== 'move' || o.moved;
  if (hooks.end) hooks.end(o.L); if (moved) commit();
};
box.addEventListener('pointerup', endOp); box.addEventListener('pointercancel', endOp);
box.addEventListener('dblclick', async (e) => {
  const L = hit(toScene(e));
  if (!L) { if (scope) exitArea(); return; }
  const r = rt.get(L.id);
  if (L.type === 'area') enterArea(L);
  else if (L.type === 'camera' && r && r.cam && r.cam.failed) retryCamera(L);
  else if (L.type === 'screen' && !(r && r.el)) await attachScreen(L);
  else if (L.type === 'video' && !(r && r.el)) { const [f] = await pickFile($('file-video')); if (f) { setVideoFile(L, f); commit(); } }
  else if (L.type === 'text') { showTab('props'); const ta = document.querySelector('#tab-props textarea'); if (ta) { ta.focus(); ta.select(); } }
  else if (MEDIA.has(L.type)) { cropMode = !cropMode; renderProps(); toast(cropMode ? T`โหมดครอป: ลากจุดที่ขอบเพื่อตัดภาพ` : T`ออกจากโหมดครอปแล้ว`); }
});
box.addEventListener('wheel', (e) => {
  const L = sel(); if (!L || L.lock || L.type === 'handfx') return;
  e.preventDefault();
  const k = Math.exp(-e.deltaY * 0.0012), G = sels().filter((l) => !l.lock && l.type !== 'handfx');
  if (G.length > 1) { // the whole group grows / shrinks around its centre
    const b = groupBox(G);
    if (hooks.begin && !box._wg) { box._wg = G; for (const l of G) hooks.begin(l); }
    for (const l of G) { const q = E(l); l.w = Math.max(4, l.w * k); l.h = Math.max(4, l.h * k); setCenter(l, b.cx + (q.x - b.cx) * k, b.cy + (q.y - b.cy) * k); }
    syncNums(); clearTimeout(box._wt); box._wt = setTimeout(() => { if (box._wg && hooks.end) for (const l of box._wg) hooks.end(l); box._wg = null; commit(); }, 350);
    return;
  }
  if (hooks.begin && !box._wb) { box._wb = L; hooks.begin(L); }
  L.w = Math.max(16, L.w * k); L.h = Math.max(16, L.h * k); syncNums();
  clearTimeout(box._wt); box._wt = setTimeout(() => { if (box._wb && hooks.end) hooks.end(box._wb); box._wb = null; commit(); }, 350);
}, { passive: false });
box.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const p = toScene(e), L = hit(p); if (!L || !selSet.has(L.id)) select(L ? L.id : null);
  if (L) { layerMenu(L, e.clientX, e.clientY); return; }
  const hidden = layers().filter((l) => !l.vis);
  ctxMenu(e.clientX, e.clientY, [
    layerClip && { icon: 'paste', label: T`วางที่นี่ (Ctrl+V)`, run: () => { if (pasteLayers()) { const G = sels(), b = groupBox(G); for (const x of G) setCenter(x, E(x).x + p.x - b.cx, E(x).y + p.y - b.cy); commit(); } } },
    { icon: 'area', label: T`สร้างพื้นที่แอนิเมชันตรงนี้`, run: () => { addArea(); const A = sel(); if (A) { setCenter(A, p.x, p.y); commit(); } } },
    layers().length && { icon: 'layers', label: T`เลือกทั้งหมด (Ctrl+A)`, run: () => selectMany(layers().filter((l) => l.type !== 'handfx').map((l) => l.id)) },
    hidden.length && { icon: 'eye', label: T`แสดงทั้งหมด (${hidden.length})`, run: () => setVis(hidden, true) },
    curArea() && { icon: 'arrowl', label: T`ออกจากพื้นที่`, run: () => exitArea() },
  ].filter(Boolean), T`เวที`);
});
/* several layers at once: show / hide / lock, solo, align, distribute, same size */
function setVis(list, v) { list = list.filter((l) => l.vis !== v); if (!list.length) return; list.forEach((l) => { l.vis = v; }); commit(); refreshAll(); }
function setLock(list, v) { list.forEach((l) => { l.lock = v; }); commit(); renderLayers(); }
// solo: only this layer (or the selection) stays visible in its list · solo again = everything back
function solo(keep) {
  const arr = listOf(keep[0]), others = arr.filter((l) => !keep.includes(l) && l.type !== 'handfx');
  if (keep.every((l) => l.vis) && others.length && others.every((l) => !l.vis)) { setVis(others, true); toast(T`แสดงทุกเลเยอร์กลับมาแล้ว`); return; }
  keep.forEach((l) => { l.vis = true; }); others.forEach((l) => { l.vis = false; }); commit(); refreshAll();
  toast(keep.length > 1 ? T`แสดงเฉพาะ ${keep.length} เลเยอร์ที่เลือก` : T`แสดงเฉพาะ “${keep[0].name}”`, { label: T`แสดงทั้งหมด`, action: () => setVis(others, true) });
}
// toggling the eye / lock of a selected row changes every selected layer the same way
function rowToggle(L, what, e) {
  const G = selSet.has(L.id) && selSet.size > 1 ? sels() : [L];
  if (what === 'vis') { if (e && e.altKey) { solo(G); return; } setVis(G, !L.vis); }
  else setLock(G, !L.lock);
}
function frameOf(L) { // what a single layer aligns to: its area, or the canvas
  const P = parentOf(L.id), o = out();
  const r = P ? { x0: P.x - P.w / 2, y0: P.y - P.h / 2, w: P.w, h: P.h } : { x0: 0, y0: 0, w: o.w, h: o.h };
  return { ...r, x1: r.x0 + r.w, y1: r.y0 + r.h, cx: r.x0 + r.w / 2, cy: r.y0 + r.h / 2 };
}
// how: l c r (horizontal) · t m b (vertical) · dh dv (equal gaps) · size (same size as the main selected layer)
function arrange(how) {
  const G = sels().filter((l) => !l.lock && l.type !== 'handfx'); if (!G.length) return;
  if ((how === 'dh' || how === 'dv') && G.length < 3) { toast(T`เลือกอย่างน้อย 3 เลเยอร์เพื่อเว้นระยะเท่ากัน`); return; }
  if (how === 'size' && G.length < 2) return;
  const ref = G.length > 1 ? groupBox(G) : frameOf(G[0]), M = sel();
  if (hooks.begin) G.forEach((l) => hooks.begin(l));
  if (how === 'size') { for (const L of G) if (L !== M) { if (L.type === 'text') L.h = M.h; else { L.w = M.w; L.h = M.h; } } }
  else if (how === 'dh' || how === 'dv') {
    const hz = how === 'dh', items = G.map((L) => ({ L, b: groupBox([L]), e: E(L) })).sort((a, b) => (hz ? a.b.cx - b.b.cx : a.b.cy - b.b.cy));
    const span = hz ? ref.w : ref.h, used = items.reduce((n, it) => n + (hz ? it.b.w : it.b.h), 0), gap = (span - used) / (items.length - 1);
    let at = hz ? ref.x0 : ref.y0;
    for (const it of items) { const d = at - (hz ? it.b.x0 : it.b.y0); setCenter(it.L, it.e.x + (hz ? d : 0), it.e.y + (hz ? 0 : d)); at += (hz ? it.b.w : it.b.h) + gap; }
  } else for (const L of G) {
    const b = groupBox([L]), e = E(L);
    const dx = how === 'l' ? ref.x0 - b.x0 : how === 'r' ? ref.x1 - b.x1 : how === 'c' ? ref.cx - b.cx : 0;
    const dy = how === 't' ? ref.y0 - b.y0 : how === 'b' ? ref.y1 - b.y1 : how === 'm' ? ref.cy - b.cy : 0;
    setCenter(L, e.x + dx, e.y + dy);
  }
  if (hooks.end) G.forEach((l) => hooks.end(l));
  commit(); renderProps(); placeGizmo();
}
const ARRANGE = () => [['l', 'al-l', T`ชิดซ้าย`], ['c', 'al-c', T`กึ่งกลางแนวนอน`], ['r', 'al-r', T`ชิดขวา`], ['t', 'al-t', T`ชิดบน`], ['m', 'al-m', T`กึ่งกลางแนวตั้ง`], ['b', 'al-b', T`ชิดล่าง`], ['dh', 'dist-h', T`เว้นระยะแนวนอนเท่ากัน`], ['dv', 'dist-v', T`เว้นระยะแนวตั้งเท่ากัน`], ['size', 'fit', T`ขนาดเท่าเลเยอร์หลัก`]];
function arrangeMenu(x, y) { ctxMenu(x, y, ARRANGE().map(([k, ic, label]) => ({ icon: ic, label, run: () => arrange(k) })), T`จัดเรียง`); }
// menu items that move layers into / out of areas
function areaItems(list) {
  const items = [], free = list.filter((l) => l.type !== 'handfx');
  if (!free.length) return items;
  items.push({ icon: 'area', label: T`รวมเป็นพื้นที่แอนิเมชัน (Ctrl+G)`, run: () => groupToArea() });
  for (const A of layers().filter((l) => l.type === 'area' && !list.includes(l)).slice(-6).reverse()) items.push({ icon: 'area', label: T`ย้ายเข้า “${A.name}”`, run: () => moveInto(free, A) });
  if (curArea()) items.push({ icon: 'arrowl', label: T`ย้ายออกจากพื้นที่นี้`, run: () => moveOut(free) });
  return items;
}
function layerMenu(L, x, y) {
  const G = sels();
  if (G.length > 1 && G.includes(L)) {
    ctxMenu(x, y, [
      { icon: 'copy', label: T`ทำสำเนา ${G.length} เลเยอร์`, run: () => dupSel() },
      { icon: 'copy', label: T`คัดลอก (Ctrl+C)`, run: () => copyLayers(false, G) },
      { icon: 'scissors', label: T`ตัด (Ctrl+X)`, run: () => copyLayers(true, G) },
      layerClip && { icon: 'paste', label: T`วาง (Ctrl+V)`, run: () => pasteLayers() },
      ...areaItems(G),
      { icon: 'fit', label: T`จัดเรียง / จัดแนว…`, run: () => setTimeout(() => arrangeMenu(x, y), 0) },
      { icon: 'star', label: T`บันทึกที่เลือกเป็นเทมเพลต`, run: () => saveTemplate(G) },
      '-',
      G.some((l) => !l.vis) && { icon: 'eye', label: T`แสดงทั้งหมด`, run: () => setVis(G, true) },
      G.some((l) => l.vis) && { icon: 'eyeoff', label: T`ซ่อนทั้งหมด`, run: () => setVis(G, false) },
      { icon: 'eye', label: T`แสดงเฉพาะที่เลือก (Alt+คลิกรูปตา)`, run: () => solo(G) },
      G.some((l) => !l.lock) && { icon: 'lock', label: T`ล็อกทั้งหมด`, run: () => setLock(G, true) },
      G.some((l) => l.lock) && { icon: 'unlock', label: T`ปลดล็อกทั้งหมด`, run: () => setLock(G, false) },
      { icon: 'front', label: T`ย้ายไปบนสุด`, run: () => { const a = layers(), keep = a.filter((l) => !G.includes(l)), mv = a.filter((l) => G.includes(l)); a.length = 0; a.push(...keep, ...mv); commit(); renderLayers(); } },
      { icon: 'back', label: T`ย้ายไปล่างสุด`, run: () => { const a = layers(), keep = a.filter((l) => !G.includes(l)), mv = a.filter((l) => G.includes(l)); a.length = 0; a.push(...mv, ...keep); commit(); renderLayers(); } },
      '-',
      { icon: 'trash', label: T`ลบ ${G.length} เลเยอร์`, danger: true, run: () => removeSel() },
    ].filter(Boolean), T`เลือก ${G.length} เลเยอร์`);
    return;
  }
  ctxMenu(x, y, [
    L.type === 'area' && { icon: 'edit', label: T`เข้าไปแก้ไขข้างใน`, run: () => enterArea(L) },
    L.type === 'area' && L.kids.length && { icon: 'fit', label: T`กรอบพอดีของข้างใน`, run: () => fitAreaToKids(L) },
    { icon: 'copy', label: T`ทำสำเนา`, run: () => duplicate(L.id) },
    { icon: 'copy', label: T`คัดลอก (Ctrl+C)`, run: () => copyLayers(false, [L]) },
    { icon: 'scissors', label: T`ตัด (Ctrl+X)`, run: () => copyLayers(true, [L]) },
    layerClip && { icon: 'paste', label: T`วาง (Ctrl+V)`, run: () => pasteLayers() },
    layerClip && L.type === 'area' && { icon: 'paste', label: T`วางเข้าไปในพื้นที่นี้ (Ctrl+Shift+V)`, run: () => pasteLayers(L) },
    ...areaItems([L]),
    { icon: 'star', label: T`บันทึกเป็นเทมเพลต`, run: () => saveTemplate([L]) },
    { icon: 'front', label: T`ย้ายไปบนสุด`, run: () => reorder(L.id, 'front') },
    { icon: 'back', label: T`ย้ายไปล่างสุด`, run: () => reorder(L.id, 'back') },
    '-',
    { icon: 'fit', label: T`เต็มจอ`, run: () => { place(L, 'cover'); commit(); renderProps(); } },
    { icon: 'center', label: T`จัดกึ่งกลาง`, run: () => { place(L, 'center'); commit(); renderProps(); } },
    { icon: L.vis ? 'eyeoff' : 'eye', label: L.vis ? T`ซ่อน` : T`แสดง`, run: () => setVis([L], !L.vis) },
    { icon: 'eye', label: T`แสดงเฉพาะเลเยอร์นี้ (Alt+คลิกรูปตา)`, run: () => solo([L]) },
    { icon: L.lock ? 'unlock' : 'lock', label: L.lock ? T`ปลดล็อก` : T`ล็อกตำแหน่ง`, run: () => { L.lock = !L.lock; commit(); renderLayers(); } },
    { icon: 'edit', label: T`เปลี่ยนชื่อ`, run: () => renameLayer(L) },
    '-',
    { icon: 'trash', label: L.type === 'area' ? T`ลบพื้นที่และของข้างใน` : T`ลบเลเยอร์`, danger: true, run: () => removeLayer(L.id) },
  ].filter(Boolean), L.name);
}
async function renameLayer(L) { const n = await promptBox(T`เปลี่ยนชื่อ`, L.name, T`บันทึก`); if (n) { L.name = n; commit(); renderLayers(); bus.emit('renamed'); } }
async function renameScene(s = scene()) { const n = await promptBox(T`เปลี่ยนชื่อซีน`, s.name, T`บันทึก`); if (n) { s.name = n; commit(); renderScenes(); bus.emit('renamed'); } }
function removeSel() {
  const G = sels(); if (!G.length) return;
  for (const l of G) { const arr = listOf(l); arr.splice(arr.indexOf(l), 1); }
  const ids = new Set(allOf(G).map((l) => l.id));
  for (const sc of project.scenes) for (const c of sc.clips || []) c.tracks = c.tracks.filter((t) => !ids.has(t.layer));
  for (const id of ids) { dropHandFx(id); hp.delete(id); }
  selId = null; selSet.clear(); syncRuntime(); commit(); refreshAll();
}
function dupSel() {
  const G = sels(); if (G.length < 2) { if (selId) duplicate(selId); return; }
  const made = [];
  for (const L of G) { if (noCopy(L)) continue; duplicate(L.id, true); made.push(selId); }
  selectMany(made); commit(); refreshAll();
}

addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select') || !$('modal').classList.contains('hidden')) return;
  const L = sel(), k = e.key.toLowerCase();
  if (e.key === 'Escape' && !L && scope) { exitArea(); return; }
  if (e.ctrlKey && k === 'h') { e.preventDefault(); if (e.shiftKey) setVis(layers().filter((l) => !l.vis), true); else if (L) { const G = sels(); setVis(G, !G.every((l) => l.vis)); } return; }
  if (e.ctrlKey && (k === 'c' || k === 'x') && !e.shiftKey && L && (!document.body.classList.contains('anim-mode') || overStage())) { e.preventDefault(); copyLayers(k === 'x'); return; }
  if (e.ctrlKey && k === 'v' && e.shiftKey && layerClip && L && L.type === 'area') { e.preventDefault(); pasteLayers(L); return; }
  if (e.ctrlKey && k === 'g' && !e.shiftKey) { e.preventDefault(); if (sels().length) groupToArea(); return; }
  if (e.key === 'F2') { e.preventDefault(); if (L) renameLayer(L); else renameScene(); return; }
  if (e.ctrlKey && k === 'a' && layers().length && !document.body.classList.contains('anim-mode')) { e.preventDefault(); selectMany(layers().filter((l) => l.type !== 'handfx').map((l) => l.id)); return; }
  if (!L) return;
  const G = sels();
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (G.length > 1) removeSel(); else removeLayer(L.id); }
  else if (e.ctrlKey && k === 'd') { e.preventDefault(); dupSel(); }
  else if (e.key.startsWith('Arrow') && G.length > 1) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1, mv = G.filter((l) => !l.lock);
    if (hooks.begin && !box._kg) { box._kg = mv; for (const l of mv) hooks.begin(l); }
    for (const l of mv) { const b = E(l); setCenter(l, b.x + (e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0), b.y + (e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0)); }
    syncNums(); clearTimeout(box._kt); box._kt = setTimeout(() => { if (box._kg && hooks.end) for (const l of box._kg) hooks.end(l); box._kg = null; commit(); }, 400);
  }
  else if (e.key === 'Escape') select(null);
  else if (k === 'c' && MEDIA.has(L.type)) { cropMode = !cropMode; renderProps(); }
  else if (e.key === ']') reorder(L.id, e.ctrlKey ? 'front' : 1);
  else if (e.key === '[') reorder(L.id, e.ctrlKey ? 'back' : -1);
  else if (e.key.startsWith('Arrow') && !L.lock) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    if (hooks.begin && !box._kb) { box._kb = L; hooks.begin(L); }
    const b = E(L); setCenter(L, b.x + (e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0), b.y + (e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0));
    syncNums(); clearTimeout(box._kt); box._kt = setTimeout(() => { if (box._kb && hooks.end) hooks.end(box._kb); box._kb = null; commit(); }, 400);
  }
});
// drop / paste images straight onto the stage
addEventListener('dragover', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault(); box.classList.add('drop');
  const rowA = e.target.closest && e.target.closest('[data-lid]') ? byId(e.target.closest('[data-lid]').dataset.lid) : null;
  document.querySelectorAll('.drop-into').forEach((x) => x.classList.remove('drop-into'));
  if (rowA && rowA.type === 'area') e.target.closest('[data-lid]').classList.add('drop-into');
  showStageDrop(e.target.closest && e.target.closest('#scene-box') ? areaAt(toScene(e)) : null);
});
addEventListener('dragleave', (e) => { if (!e.relatedTarget) { box.classList.remove('drop'); showStageDrop(null); document.querySelectorAll('.drop-into').forEach((x) => x.classList.remove('drop-into')); } });
addEventListener('drop', async (e) => {
  box.classList.remove('drop'); showStageDrop(null); document.querySelectorAll('.drop-into').forEach((x) => x.classList.remove('drop-into'));
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  if (e.target.closest && e.target.closest('#tab-lib')) { for (const f of e.dataTransfer.files) await importToLib(f); toast(T`เพิ่มเข้าคลังแล้ว`); return; }
  const onStage = e.target.closest && e.target.closest('#scene-box'), p = onStage ? toScene(e) : null;
  const rowA = e.target.closest && e.target.closest('[data-lid]') ? byId(e.target.closest('[data-lid]').dataset.lid) : null;
  const A = (rowA && rowA.type === 'area' ? rowA : null) || (p ? areaAt(p) : null), keep = scope;
  if (A) scope = A.id; // add straight into that area
  let i = 0;
  for (const f of e.dataTransfer.files) {
    const before = layers().length;
    if (f.type.startsWith('image/')) await addImageFile(f);
    else if (f.type.startsWith('video/')) { const L = newLayer('video', { name: f.name.replace(/\.[^.]+$/, '').slice(0, 40) }); setVideoFile(L, f); addLayer(L); }
    const L = layers().length > before ? layers()[layers().length - 1] : null;
    if (L && p) { L.x = p.x + i * 24; L.y = p.y + i * 24; i++; }
  }
  if (A) { scope = keep; selId = A.id; selSet = new Set([A.id]); commit(); refreshAll(); toast(T`ใส่ไฟล์ใน “${A.name}” แล้ว`, { label: T`เข้าไปดู`, action: () => enterArea(A) }); }
  else if (p) { rebase('studio'); queueSave(); }
});
addEventListener('paste', async (e) => {
  if (e.target.closest('input, textarea') || !$('modal').classList.contains('hidden')) return;
  const cd = e.clipboardData, txt = cd ? cd.getData('text/plain') : '';
  const files = cd ? [...cd.files].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/')) : []; // files copied in File Explorer
  const imgs = files.length || (cd ? [...cd.items].some((it) => it.type.startsWith('image/')) : false);
  if (layerClip && (txt.startsWith(CLIP_MARK) || !imgs)) { e.preventDefault(); pasteLayers(); return; }
  if (files.length) {
    e.preventDefault();
    for (const f of files) {
      if (f.type.startsWith('image/')) await addImageFile(f);
      else { const L = newLayer('video', { name: f.name.replace(/\.[^.]+$/, '').slice(0, 40) }); setVideoFile(L, f); addLayer(L); }
    }
    return;
  }
  for (const it of cd ? cd.items : []) if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) await addImageFile(new File([f], T`รูปที่วาง` + '.png', { type: f.type })); }
});


/* ------------------------------------------------- drag layers like files */
// Grab one or several layers (layer list or animation timeline): they gather under the mouse, a label shows what a drop
// will do — put into an area, move here, move out — and on release they fly into place (or back home when cancelled).
const ghost = document.createElement('div'); ghost.id = 'drag-ghost'; document.body.appendChild(ghost);
const stageDrop = document.createElement('div'); stageDrop.id = 'stage-drop'; stageDrop.className = 'hidden'; box.appendChild(stageDrop);
let ldrag = null, noClickUntil = 0;
addEventListener('click', (e) => { if (Date.now() < noClickUntil) { e.stopPropagation(); e.preventDefault(); } }, true);
const inTree = (A, list) => list.some((l) => l === A || (l.kids && allOf(l.kids).includes(A))); // A is one of list, or inside one
// the top-most area on stage under a point (not one being moved)
function areaAt(p, skip = []) {
  const a = layers();
  for (let i = a.length - 1; i >= 0; i--) {
    const L = a[i]; if (L.type !== 'area' || !AV(L).vis || inTree(L, skip)) continue;
    const e = E(L), q = toLocal(e, p); if (Math.abs(q.x) <= e.w / 2 && Math.abs(q.y) <= e.h / 2) return L;
  }
  return null;
}
function showStageDrop(A) {
  stageDrop.classList.toggle('hidden', !A); if (!A) return;
  const e = E(A), w = e.w * view, h = e.h * view;
  stageDrop.style.width = w + 'px'; stageDrop.style.height = h + 'px';
  stageDrop.style.transform = `translate(${e.x * view - w / 2}px,${e.y * view - h / 2}px) rotate(${e.rot}deg)`;
  stageDrop.style.borderRadius = A.mask === 'ellipse' ? '50%' : Math.min(A.radius || 0, e.w / 2, e.h / 2) * view + 'px';
}
// called on pointerdown on a layer row; becomes a drag once the mouse moves a little
function dragLayers(e, L, rowEl) {
  if (e.button !== 0 || e.target.closest('button, input, [data-act]')) return;
  const x0 = e.clientX, y0 = e.clientY, host = rowEl.closest('#tab-layers, #anim-tl') || document.body;
  const mv = (ev) => {
    if (!ldrag) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return; beginDrag(ev, L, host, rowEl); }
    moveDrag(ev);
  };
  const up = (ev) => { removeEventListener('pointermove', mv, true); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true); removeEventListener('keydown', esc_, true); if (ldrag) endDrag(ev.type === 'pointercancel' ? null : ev); };
  const esc_ = (ev) => { if (ev.key === 'Escape' && ldrag) { ev.preventDefault(); ev.stopPropagation(); endDrag(null); } };
  addEventListener('pointermove', mv, true); addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true); addEventListener('keydown', esc_, true);
}
function beginDrag(ev, L, host, rowEl) {
  if (!selSet.has(L.id)) select(L.id);
  const items = selSet.has(L.id) && selSet.size > 1 ? sels() : [L];
  const order = allLayers(); items.sort((a, b) => order.indexOf(a) - order.indexOf(b)); // bottom → top, kept on drop
  ghost.innerHTML = ''; ghost.className = 'on';
  const cards = items.slice().reverse().map((X, i) => { // top layer first = top card
    const src = host.querySelector(`[data-lid="${X.id}"]`), r = src ? src.getBoundingClientRect() : { left: ev.clientX, top: ev.clientY, width: 180, height: 34 };
    const c = document.createElement('div'); c.className = 'dg-card';
    c.innerHTML = `${icon(TYPE_ICON[X.type])}<span>${esc(X.name)}</span>`;
    c.style.width = Math.min(240, r.width) + 'px';
    c.style.transform = `translate(${r.left - ev.clientX}px,${r.top - ev.clientY}px)`; // starts where its row is…
    c._from = { x: r.left - ev.clientX, y: r.top - ev.clientY };
    c.style.zIndex = 50 - i; ghost.appendChild(c);
    if (src) src.classList.add('dragging-src');
    return c;
  });
  const badge = document.createElement('b'); badge.className = 'dg-badge'; badge.textContent = items.length; if (items.length < 2) badge.style.display = 'none'; ghost.appendChild(badge);
  const hint = document.createElement('div'); hint.className = 'dg-hint'; ghost.appendChild(hint);
  ghost.offsetWidth; // …then everything gathers under the mouse
  cards.forEach((c, i) => { c.style.transition = `transform .38s var(--spring, cubic-bezier(.2,1.3,.4,1)) ${i * 0.025}s, opacity .3s`; c.style.transform = `translate(${16 + Math.min(i, 4) * 4}px,${12 + Math.min(i, 4) * 4}px) rotate(${(i % 2 ? 1 : -1) * Math.min(i, 3) * 2.5}deg)`; c.style.opacity = i > 4 ? 0 : 1; });
  document.body.classList.add('layer-dragging');
  let sc = rowEl.parentElement; while (sc && sc !== document.body && !(sc.scrollHeight > sc.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
  ldrag = { items, cards, hint, host, tgt: null, hl: null, x: ev.clientX, y: ev.clientY, sc: sc && sc !== document.body ? sc : null };
}
function findTarget(ev) {
  const { items } = ldrag, el = document.elementFromPoint(ev.clientX, ev.clientY);
  if (!el) return null;
  const outBtn = el.closest('[data-scope="out"], #area-crumb [data-go="out"]');
  if (outBtn && curArea() && !items.includes(curArea())) return { kind: 'out', el: outBtn, label: parentOf(curArea().id) ? T`ย้ายออกไปชั้นบน` : T`ย้ายออกไปเลเยอร์หลัก`, ico: 'arrowl' };
  const row = el.closest('[data-lid]');
  if (row) {
    const T0 = byId(row.dataset.lid); if (!T0) return null;
    if (inTree(T0, items)) return { kind: 'none', label: T`ปล่อยที่เดิม`, ico: 'x' };
    const r = row.getBoundingClientRect(), f = (ev.clientY - r.top) / r.height;
    if (T0.type === 'area' && f > 0.22 && f < 0.78) {
      if (items.some((x) => x.type === 'handfx')) return { kind: 'none', label: T`เอฟเฟกต์มือใส่ในพื้นที่ไม่ได้`, ico: 'x' };
      return { kind: 'into', A: T0, el: row, cls: 'drop-into', label: T`ใส่ใน “${T0.name}”`, ico: 'area' };
    }
    const above = f < 0.5, P = parentOf(T0.id);
    if (P && items.some((x) => x.type === 'handfx')) return { kind: 'none', label: T`เอฟเฟกต์มือใส่ในพื้นที่ไม่ได้`, ico: 'x' };
    return { kind: 'at', ref: T0, above, el: row, cls: above ? 'drop-above' : 'drop-below', label: P ? T`ย้ายมาตรงนี้ (ใน “${P.name}”)` : T`ย้ายมาตรงนี้`, ico: 'layers' };
  }
  if (el.closest('#scene-box')) {
    const A = areaAt(toScene(ev), items);
    if (A) return { kind: 'into', A, stage: true, label: T`ใส่ใน “${A.name}”`, ico: 'area' };
  }
  return null;
}
function moveDrag(ev) {
  const d = ldrag; d.x = ev.clientX; d.y = ev.clientY;
  ghost.style.transform = `translate(${ev.clientX}px,${ev.clientY}px)`;
  const t = findTarget(ev);
  if (d.hl) { d.hl.classList.remove('drop-into', 'drop-above', 'drop-below'); d.hl = null; }
  if (t && t.el && t.cls) { t.el.classList.add(t.cls); d.hl = t.el; }
  showStageDrop(t && t.stage ? t.A : null);
  d.tgt = t && t.kind !== 'none' ? t : null;
  const label = t ? t.label : T`ปล่อยเพื่อยกเลิก`, ico = t ? t.ico : 'x';
  if (d.hint._k !== label) { d.hint._k = label; d.hint.innerHTML = `${icon(ico)}<span>${esc(label)}</span>`; }
  ghost.classList.toggle('ok', !!d.tgt); ghost.classList.toggle('into', !!(d.tgt && d.tgt.kind === 'into'));
  // near the top / bottom edge of a scrolling list: scroll it
  if (d.sc) { const r = d.sc.getBoundingClientRect(); if (ev.clientX > r.left && ev.clientX < r.right) d.sc.scrollTop += ev.clientY < r.top + 28 ? -10 : ev.clientY > r.bottom - 28 ? 10 : 0; }
}
function endDrag(ev) {
  const d = ldrag; ldrag = null; noClickUntil = Date.now() + 80;
  document.body.classList.remove('layer-dragging'); showStageDrop(null);
  if (d.hl) d.hl.classList.remove('drop-into', 'drop-above', 'drop-below');
  document.querySelectorAll('.dragging-src').forEach((x) => x.classList.remove('dragging-src'));
  const t = ev ? d.tgt : null;
  // throw the cards at the target, or send them home
  let to = null;
  if (t) { const r = t.stage ? stageDrop.getBoundingClientRect() : t.el ? t.el.getBoundingClientRect() : null; if (r && r.width) to = { x: r.left + r.width / 2 - d.x - 60, y: r.top + r.height / 2 - d.y - 12 }; }
  if (t && t.stage) { showStageDrop(t.A); stageDrop.classList.add('pulse'); setTimeout(() => { stageDrop.classList.remove('pulse'); showStageDrop(null); }, 450); }
  d.cards.forEach((c, i) => { c.style.transition = `transform .34s cubic-bezier(.5,0,.75,0) ${i * 0.02}s, opacity .34s ${i * 0.02}s`; c.style.transform = to ? `translate(${to.x}px,${to.y}px) scale(.25)` : `translate(${c._from.x}px,${c._from.y}px)`; c.style.opacity = to ? 0 : 0.4; });
  d.hint.style.opacity = 0; ghost.querySelector('.dg-badge').style.opacity = 0;
  setTimeout(() => { if (!ldrag) { ghost.className = ''; ghost.innerHTML = ''; } }, 420);
  if (t) moveLayers(d.items, t);
}
// move layers (bottom → top order) into an area, next to another layer, or out of the area being edited
function moveLayers(items, t) {
  let list = items.filter((x) => x.type !== 'handfx' || t.kind === 'at');
  if (t.kind === 'into') list = list.filter((x) => !inTree(t.A, [x]));
  if (t.kind === 'at') list = list.filter((x) => !inTree(t.ref, [x]) && !(parentOf(t.ref.id) && inTree(parentOf(t.ref.id), [x])));
  if (!list.length) return;
  for (const x of list) { const a = listOf(x); a.splice(a.indexOf(x), 1); }
  if (t.kind === 'into') t.A.kids.push(...list);
  else if (t.kind === 'at') { const a = listOf(t.ref); a.splice(a.indexOf(t.ref) + (t.above ? 1 : 0), 0, ...list); }
  else { const A = curArea(), a = listOf(A); a.splice(a.indexOf(A) + 1, 0, ...list); const P = parentOf(A.id); scope = P ? P.id : null; }
  if (t.kind === 'into' && !inTree(t.A, [curArea()].filter(Boolean)) && layers().includes(t.A)) { selId = t.A.id; selSet = new Set([t.A.id]); }
  else { selSet = new Set(list.map((x) => x.id)); selId = list[list.length - 1].id; }
  syncRuntime(); commit(); refreshAll(); bus.emit('select', selId);
  if (t.kind === 'into') toast(T`ใส่ ${list.length} เลเยอร์ใน “${t.A.name}” แล้ว`, { label: T`เข้าไปดู`, action: () => enterArea(t.A) });
  else if (t.kind === 'out') toast(T`ย้าย ${list.length} เลเยอร์ออกมาแล้ว`);
}

/* ------------------------------------------------------- layer clipboard */
// Ctrl+C / Ctrl+X / Ctrl+V for layers (with what is inside areas and their keyframes). The system clipboard gets a marker,
// so pasting an image copied from another program still adds the image.
let layerClip = null;
const CLIP_MARK = 'prism-cam:layers:';
function copyLayers(cut, list = sels()) {
  const G = list.filter((l) => !noCopy(l) && l.type !== 'handfx');
  if (list.length && !G.length) { toast(T`เลเยอร์ชนิดนี้คัดลอกไม่ได้`, { kind: 'err' }); return false; }
  if (!G.length) return false;
  const order = allLayers(); G.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const ids = new Set(allOf(G).map((l) => l.id));
  layerClip = { ...bundleOf(G), stamp: Date.now(), n: cut ? -1 : 0 };
  try { navigator.clipboard.writeText(CLIP_MARK + layerClip.stamp).catch(() => {}); } catch { /* no clipboard access */ }
  if (cut) { selSet = new Set(G.map((l) => l.id)); selId = G[G.length - 1].id; removeSel(); }
  const skipped = list.length - G.length;
  toast((cut ? T`ตัด ${G.length} เลเยอร์แล้ว` : T`คัดลอก ${G.length} เลเยอร์แล้ว`) + ' — ' + T`กด Ctrl+V เพื่อวาง` + (skipped ? ' · ' + T`ข้าม ${skipped} อันที่คัดลอกไม่ได้` : ''));
  return true;
}
// layers + their keyframes + the settings of the clips they use (a clip of an area's own timeline travels with the area)
function bundleOf(G) {
  const ids = new Set(allOf(G).map((l) => l.id)), clips = scene().clips || [];
  const tracks = clips.flatMap((c) => c.tracks.filter((t) => ids.has(t.layer)).map((t) => ({ clip: c.id, mode: c.mode, t: JSON.parse(JSON.stringify(t)) })));
  const meta = {};
  for (const c of clips) if (tracks.some((x) => x.clip === c.id) || (c.area && ids.has(c.area))) { const { tracks: _t, events: _e, ...m } = c; meta[c.id] = JSON.parse(JSON.stringify(m)); }
  return { layers: JSON.parse(JSON.stringify(G)), tracks, clips: meta };
}
// put a bundle into this scene: fresh ids; at point p (centre) or shifted by off; into an area or the list being edited
function insertBundle(bd, { into = null, p = null, off = 0 } = {}) {
  const lm = {}, made = bd.layers.map((L) => cloneLayer(L, lm));
  let dx = off, dy = off;
  if (p) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const x of made) { x0 = Math.min(x0, x.x - x.w / 2); x1 = Math.max(x1, x.x + x.w / 2); y0 = Math.min(y0, x.y - x.h / 2); y1 = Math.max(y1, x.y + x.h / 2); } dx = p.x - (x0 + x1) / 2; dy = p.y - (y0 + y1) / 2; }
  for (const x of allOf(made)) { x.x += dx; x.y += dy; }
  const list = into ? into.kids : layers(), M = sel();
  list.splice(!into && M && list.includes(M) ? list.indexOf(M) + 1 : list.length, 0, ...made);
  const clips = scene().clips || (scene().clips = []), cm = {};
  const clipFor = (id) => {
    const meta = bd.clips && bd.clips[id], own = meta && meta.area && lm[meta.area];
    if (!own) { const c = clips.find((x) => x.id === id); if (c) return c; }
    if (cm[id]) return cm[id];
    if (!meta) return clips.length === 1 ? clips[0] : null;
    const c = { ...JSON.parse(JSON.stringify(meta)), id: auid(), tracks: [], events: [], next: '' };
    if (own) c.area = lm[meta.area]; else delete c.area;
    fixClip(c); clips.push(c); return (cm[id] = c);
  };
  for (const id of Object.keys(bd.clips || {})) if (bd.clips[id].area && lm[bd.clips[id].area]) clipFor(id); // an area's own (maybe empty) timeline
  for (const { clip, mode, t } of bd.tracks || []) {
    const c = clipFor(clip); if (!c || !lm[t.layer]) continue;
    const n = { ...t, id: auid(), layer: lm[t.layer], keys: t.keys.map((k) => ({ ...k })) };
    if (mode !== 'add' && c.mode !== 'add' && (dx || dy) && (n.prop === 'x' || n.prop === 'y')) n.keys.forEach((k) => { k.v += n.prop === 'x' ? dx : dy; });
    c.tracks.push(n);
  }
  return made;
}
function pasteLayers(into) {
  if (!layerClip) return false;
  layerClip.n++;
  const made = insertBundle(layerClip, { into, off: layerClip.n <= 0 ? 0 : 24 * layerClip.n }); // a cut pastes back in place first
  const A = into || null;
  if (A && layers().includes(A)) { selId = A.id; selSet = new Set([A.id]); } else { selSet = new Set(made.map((l) => l.id)); selId = made[made.length - 1].id; }
  syncRuntime(); commit(); refreshAll(); bus.emit('select', selId);
  toast(A ? T`วาง ${made.length} เลเยอร์ใน “${A.name}” แล้ว` : T`วาง ${made.length} เลเยอร์แล้ว`);
  return true;
}

/* ------------------------------------------------------------ library */
// every picture / video ever imported (project.lib) + saved templates (project.tpl): drag or click to use again
let libFilter = 'all', libQuery = '';
const lib = () => project.lib || (project.lib = []);
const tpls = () => project.tpl || (project.tpl = []);
const sigOf = (f) => `${f.name}|${f.size}|${f.lastModified}`;
function thumbOf(src, w = 220) {
  const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height; if (!sw || !sh) return '';
  const k = Math.min(1, w / sw), c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
  try { c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.72); } catch { return ''; }
}
function libAdd(e) {
  const old = lib().find((x) => (e.sig && x.sig === e.sig) || (e.asset && x.asset === e.asset) || (e.media && x.media === e.media));
  if (old) { lib().splice(lib().indexOf(old), 1); lib().unshift(old); return old; } // used again → to the front
  const it = { id: uid(), at: Date.now(), ...e }; lib().unshift(it); if (lib().length > 300) lib().length = 300;
  queueSave(); if ($('tab-lib') && $('tab-lib').classList.contains('active')) renderLib();
  return it;
}
// fill in thumbnails (and sizes / length) for library entries that don't have one yet
function libThumbs() {
  for (const it of lib()) {
    if (it.thumb || it._busy) continue;
    if (it.kind === 'image' && project.assets[it.asset]) { it._busy = true; const im = new Image(); im.onload = () => { it.thumb = thumbOf(im); it.w = im.naturalWidth; it.h = im.naturalHeight; it._busy = false; queueSave(); renderLibSoon(); }; im.src = project.assets[it.asset]; }
    else if (it.kind === 'video' && it.media) {
      it._busy = true;
      videoUrl(it.media).then((url) => {
        if (!url) { it._busy = false; return; }
        const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; if (url.startsWith('http')) v.crossOrigin = 'anonymous';
        v.onloadeddata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); };
        v.onseeked = () => { it.thumb = thumbOf(v); it.w = v.videoWidth; it.h = v.videoHeight; it.dur = v.duration; it._busy = false; v.removeAttribute('src'); v.load(); queueSave(); renderLibSoon(); };
        v.onerror = () => { it._busy = false; it.missing = true; renderLibSoon(); };
        v.src = url;
      });
    }
  }
}
let libT = 0, libHtml = '';
const renderLibSoon = () => { clearTimeout(libT); libT = setTimeout(() => { if ($('tab-lib').classList.contains('active')) renderLib(); }, 120); };
const usedCount = (it) => project.scenes.reduce((n, sc) => n + allLayers(sc).filter((l) => (it.asset && l.asset === it.asset) || (it.media && l.media === it.media)).length, 0);
function renderLib() {
  const el = $('tab-lib'); if (!el) return;
  libThumbs();
  const q = libQuery.trim().toLowerCase(), match = (x) => !q || String(x.name || '').toLowerCase().includes(q);
  const items = lib().filter((x) => (libFilter === 'all' || libFilter === x.kind) && match(x));
  const tp = libFilter === 'all' || libFilter === 'tpl' ? tpls().filter(match) : [];
  const chip = (k, label) => `<button class="chip${libFilter === k ? ' on' : ''}" data-f="${k}">${esc(label)}</button>`;
  const tile = (x, kind) => `<div class="lib-t${x.missing ? ' missing' : ''}" data-k="${kind}" data-id="${x.id}" title="${esc(x.name)}">
      <div class="lib-img">${x.thumb ? `<img src="${x.thumb}" alt="" draggable="false">` : icon(kind === 'tpl' ? 'area' : kind === 'video' ? 'film' : 'image')}${kind === 'video' && x.dur ? `<i>${fmtDur(x.dur)}</i>` : ''}${kind === 'tpl' ? `<i>${icon('area')}</i>` : ''}</div>
      <span>${esc(x.name || '')}</span>
      <button class="icon-btn lib-x" data-x title="${kind === 'tpl' ? T`ลบเทมเพลต` : T`เอาออกจากคลัง`}">${icon('x')}</button></div>`;
  const keep = el.querySelector('.lib-q'), focus = keep && document.activeElement === keep;
  const html = `<div class="lib-head"><label class="field lib-search">${icon('search')}<input class="lib-q" type="text" spellcheck="false" placeholder="${T`ค้นหาในคลัง`}"></label>
      <button class="icon-btn" data-imp="image" title="${T`นำเข้ารูปเข้าคลัง`}">${icon('image')}</button><button class="icon-btn" data-imp="video" title="${T`นำเข้าวิดีโอเข้าคลัง`}">${icon('film')}</button></div>
    <div class="chips lib-f">${chip('all', T`ทั้งหมด`)}${chip('image', T`รูป`)}${chip('video', T`วิดีโอ`)}${chip('tpl', T`เทมเพลต`)}</div>
    ${tp.length ? `<div class="lib-cap">${T`เทมเพลตพื้นที่`}</div><div class="lib-grid">${tp.map((x) => tile(x, 'tpl')).join('')}</div>` : ''}
    ${items.length ? `${tp.length ? `<div class="lib-cap">${T`รูปและวิดีโอ`}</div>` : ''}<div class="lib-grid">${items.map((x) => tile(x, x.kind)).join('')}</div>` : ''}
    ${!items.length && !tp.length ? `<div class="layers-empty">${q ? T`ไม่พบ “${libQuery}”` : T`คลังยังว่าง — รูปและวิดีโอที่นำเข้าจะมาอยู่ที่นี่เอง`}<br>${T`ลากไฟล์มาวางที่แท็บนี้ หรือกดปุ่มนำเข้าด้านบน`}</div>` : ''}
    <div class="panel-note">${T`คลิก = เพิ่มลงเวที · ลากไปวางบนเวที / บนพื้นที่แอนิเมชัน · คลิกขวาที่พื้นที่ → บันทึกเป็นเทมเพลต`}</div>`;
  // nothing changed → keep the DOM: rebuilding it under the pointer replays every hover animation
  if (html === libHtml && el.firstChild) return;
  libHtml = html; el.innerHTML = html;
  const qi = el.querySelector('.lib-q'); qi.value = libQuery; if (focus) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
  qi.oninput = () => { libQuery = qi.value; renderLib(); };
  qi.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { libQuery = ''; renderLib(); } };
  el.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { libFilter = b.dataset.f; renderLib(); }; });
  el.querySelectorAll('[data-imp]').forEach((b) => { b.onclick = async () => { for (const f of await pickFile($(b.dataset.imp === 'image' ? 'file-image' : 'file-video'))) await importToLib(f); }; });
  el.querySelectorAll('.lib-t').forEach((t) => {
    const kind = t.dataset.k, it = (kind === 'tpl' ? tpls() : lib()).find((x) => x.id === t.dataset.id); if (!it) return;
    t.querySelector('[data-x]').onclick = (e) => {
      e.stopPropagation(); const arr = kind === 'tpl' ? tpls() : lib(), i = arr.indexOf(it); arr.splice(i, 1); queueSave(); renderLib();
      toast(kind === 'tpl' ? T`ลบเทมเพลต “${it.name}” แล้ว` : T`เอา “${it.name}” ออกจากคลังแล้ว (เลเยอร์ที่ใช้อยู่ไม่หาย)`, { label: T`เอากลับมา`, action: () => { arr.splice(i, 0, it); queueSave(); renderLib(); } });
    };
    t.onpointerdown = (e) => dragLib(e, it, kind, t);
    t.oncontextmenu = (e) => {
      e.preventDefault();
      ctxMenu(e.clientX, e.clientY, [
        { icon: 'plus', label: T`เพิ่มลงเวที`, run: () => placeLib(it, kind, {}) },
        curArea() && { icon: 'area', label: T`เพิ่มลงในพื้นที่นี้`, run: () => placeLib(it, kind, {}) },
        { icon: 'edit', label: T`เปลี่ยนชื่อ`, run: async () => { const n = await promptBox(T`เปลี่ยนชื่อ`, it.name, T`บันทึก`); if (n) { it.name = n.slice(0, 40); queueSave(); renderLib(); } } },
        kind !== 'tpl' && { icon: 'layers', label: T`ใช้อยู่ ${usedCount(it)} เลเยอร์`, run: () => {} },
        '-',
        { icon: 'trash', label: kind === 'tpl' ? T`ลบเทมเพลต` : T`เอาออกจากคลัง`, danger: true, run: () => t.querySelector('[data-x]').click() },
      ].filter(Boolean), it.name);
    };
  });
}
// a file dropped on / imported into the library (not onto the stage)
async function importToLib(f) {
  if (f.type.startsWith('image/')) {
    const hit = lib().find((x) => x.sig === sigOf(f) && project.assets[x.asset]); if (hit) { libAdd(hit); return; }
    const id = uid(); project.assets[id] = await readDataUrl(f); libAdd({ kind: 'image', asset: id, name: f.name.replace(/\.[^.]+$/, '').slice(0, 40), sig: sigOf(f) });
  } else if (f.type.startsWith('video/')) {
    const hit = lib().find((x) => x.sig === sigOf(f) && x.media && !x.missing); if (hit) { libAdd(hit); return; }
    const ext = ((f.name.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'mp4').toLowerCase(), name = uid() + uid() + '.' + ext;
    if (await storeVideo(f, name)) libAdd({ kind: 'video', media: name, name: f.name.replace(/\.[^.]+$/, '').slice(0, 40), sig: sigOf(f) });
  }
  renderLib();
}
// use a library entry / template: t = { A (area), p (stage point) }
function placeLib(it, kind, t) {
  const keep = scope, A = t.A || null;
  if (A) scope = A.id;
  let made = [];
  if (kind === 'tpl') made = insertBundle(it.data, { into: A || null, p: t.p || null, off: t.p ? 0 : 0 });
  else {
    const L = newLayer(kind, { name: it.name, ...(kind === 'image' ? { asset: it.asset } : { media: it.media }) });
    if (it.w && it.h) { const o = A || out(), ar = it.w / it.h, w = Math.min(o.w * (A ? 0.8 : 0.5), it.w, o.h * (A ? 0.8 : 0.7) * ar); L.w = w; L.h = w / ar; L.fresh = false; }
    addLayer(L, { select: !A });
    if (t.p) { L.x = t.p.x; L.y = t.p.y; }
    made = [L];
  }
  if (A) { scope = keep; selId = A.id; selSet = new Set([A.id]); }
  else if (kind === 'tpl') { selSet = new Set(made.map((l) => l.id)); selId = made[made.length - 1].id; }
  if (kind !== 'tpl') libAdd(it);
  syncRuntime(); commit(); refreshAll(); bus.emit('select', selId);
  if (A) toast(T`ใส่ “${it.name}” ใน “${A.name}” แล้ว`, { label: T`เข้าไปดู`, action: () => enterArea(A) });
}
// drag a library tile onto the stage, onto an area on the stage, or onto an area row; a click adds it in the middle
function dragLib(e, it, kind, tile) {
  if (e.button !== 0 || e.target.closest('button')) return;
  const x0 = e.clientX, y0 = e.clientY; let on = false, tgt = null, card = null, hint = null, hl = null;
  const find = (ev) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY); if (!el) return null;
    const row = el.closest('[data-lid]'), R = row && byId(row.dataset.lid);
    if (R && R.type === 'area') return { A: R, el: row, label: T`ใส่ใน “${R.name}”`, ico: 'area' };
    if (el.closest('#scene-box')) { const p = toScene(ev), A = areaAt(p); return { A, p, stage: true, label: A ? T`ใส่ใน “${A.name}”` : T`วางตรงนี้`, ico: A ? 'area' : 'plus' }; }
    return null;
  };
  const mv = (ev) => {
    if (!on) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      on = true; document.body.classList.add('layer-dragging');
      ghost.innerHTML = ''; ghost.className = 'on lib';
      const r = tile.getBoundingClientRect();
      card = document.createElement('div'); card.className = 'dg-card dg-thumb'; card.innerHTML = (it.thumb ? `<img src="${it.thumb}" alt="">` : icon(kind === 'tpl' ? 'area' : kind === 'video' ? 'film' : 'image')) + `<span>${esc(it.name)}</span>`;
      card.style.transform = `translate(${r.left - ev.clientX}px,${r.top - ev.clientY}px)`; ghost.appendChild(card);
      hint = document.createElement('div'); hint.className = 'dg-hint'; ghost.appendChild(hint);
      ghost.offsetWidth; card.style.transition = 'transform .35s var(--spring, cubic-bezier(.2,1.3,.4,1))'; card.style.transform = 'translate(14px,10px) rotate(-3deg)';
    }
    ghost.style.transform = `translate(${ev.clientX}px,${ev.clientY}px)`;
    tgt = find(ev);
    if (hl) { hl.classList.remove('drop-into'); hl = null; } if (tgt && tgt.el) { tgt.el.classList.add('drop-into'); hl = tgt.el; }
    showStageDrop(tgt && tgt.stage ? tgt.A : null);
    const label = tgt ? tgt.label : T`ปล่อยเพื่อยกเลิก`; if (hint._k !== label) { hint._k = label; hint.innerHTML = `${icon(tgt ? tgt.ico : 'x')}<span>${esc(label)}</span>`; }
    ghost.classList.toggle('ok', !!tgt); ghost.classList.toggle('into', !!(tgt && tgt.A));
  };
  const up = (ev) => {
    removeEventListener('pointermove', mv, true); removeEventListener('pointerup', up, true);
    if (!on) { placeLib(it, kind, {}); return; }
    noClickUntil = Date.now() + 80; document.body.classList.remove('layer-dragging'); if (hl) hl.classList.remove('drop-into'); showStageDrop(null);
    card.style.transition = 'transform .3s cubic-bezier(.5,0,.75,0), opacity .3s'; card.style.transform = tgt ? 'translate(0,0) scale(.3)' : `translate(${tile.getBoundingClientRect().left - ev.clientX}px,${tile.getBoundingClientRect().top - ev.clientY}px)`; card.style.opacity = tgt ? 0 : 0.4; hint.style.opacity = 0;
    setTimeout(() => { if (!ldrag) { ghost.className = ''; ghost.innerHTML = ''; } }, 360);
    if (tgt) placeLib(it, kind, tgt);
  };
  addEventListener('pointermove', mv, true); addEventListener('pointerup', up, true);
}
// save layers (an area, or the selection) as a reusable template
async function saveTemplate(list) {
  list = list.filter((l) => !noCopy(l) && l.type !== 'handfx'); if (!list.length) return;
  const n = await promptBox(T`ชื่อเทมเพลต`, list.length === 1 ? list[0].name : T`เทมเพลต ${tpls().length + 1}`, T`บันทึก`); if (!n) return;
  const b = groupBox(list), o = out(), x0 = clamp(b.x0, 0, o.w), y0 = clamp(b.y0, 0, o.h), w = clamp(b.x1, 0, o.w) - x0, h = clamp(b.y1, 0, o.h) - y0;
  let thumb = '';
  if (w > 2 && h > 2) { const k = Math.min(1, 220 / w), c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k); try { c.getContext('2d').drawImage(canvas, x0 * rs, y0 * rs, w * rs, h * rs, 0, 0, c.width, c.height); thumb = c.toDataURL('image/jpeg', 0.75); } catch { /* */ } }
  tpls().unshift({ id: uid(), name: n.slice(0, 40), thumb, at: Date.now(), data: bundleOf(list) });
  queueSave();
  toast(T`บันทึกเทมเพลต “${n}” แล้ว — อยู่ในแท็บคลัง`, { label: T`เปิดคลัง`, action: () => showTab('lib') });
}

/* --------------------------------------------------------- slideshow areas */
// an area can show its layers one at a time (top of its list first): auto every N s, or on command (gesture / buttons)
const SLIDE_DEF = { on: false, mode: 'auto', every: 3, trans: 'fade', dur: 0.6, dots: false };
const slideRt = new Map(); // area id → { idx, prev, t0, next }
const slideList = (A) => A.kids.slice().reverse().filter((k) => k.vis);
function slideGo(A, d, now = performance.now()) {
  const n = slideList(A).length; if (!n) return;
  const s = slideRt.get(A.id) || { idx: 0, prev: null, t0: 0, next: 0 };
  s.prev = s.idx; s.idx = ((s.idx + d) % n + n) % n; s.t0 = now; s.next = now + (A.slides.every || 3) * 1000; slideRt.set(A.id, s);
}
function slideState(A, now) {
  let s = slideRt.get(A.id);
  if (!s) { s = { idx: 0, prev: null, t0: -1e9, next: now + (A.slides.every || 3) * 1000 }; slideRt.set(A.id, s); }
  const n = slideList(A).length; if (s.idx >= n) s.idx = 0;
  if (A.slides.mode === 'auto' && n > 1 && now >= s.next) slideGo(A, 1, now);
  return s;
}
const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function drawSlides(A, now) {
  const S = A.slides, s = slideState(A, now), list = slideList(A); if (!list.length) return;
  const p = Math.min(1, (now - s.t0) / Math.max(1, (S.dur || 0.6) * 1000)), e = easeIO(p), a0 = alphaK;
  const one = (L, phase) => {
    const V = AV(L); ctx.save();
    const k = phase === 'in' ? e : 1 - e;
    if (phase === 'still') { /* no transition: drawn as it is */ }
    else if (S.trans === 'slide') ctx.translate((phase === 'in' ? 1 - e : -e) * A.w, 0);
    else if (S.trans === 'zoom') { const z = phase === 'in' ? 0.85 + 0.15 * e : 1 + 0.15 * e; ctx.translate(A.x, A.y); ctx.scale(z, z); ctx.translate(-A.x, -A.y); alphaK = a0 * k; }
    else if (S.trans === 'flip') { const f = phase === 'in' ? Math.max(0, e * 2 - 1) : Math.max(0, 1 - e * 2); ctx.translate(A.x, A.y); ctx.scale(Math.max(0.001, f), 1); ctx.translate(-A.x, -A.y); }
    else alphaK = a0 * k;
    try { if (L.type === 'area') drawArea(L, V, now); else drawLayer(V, now); } catch (err) { console.error('slide', err); }
    ctx.restore(); alphaK = a0;
  };
  if (p < 1 && s.prev != null && list[s.prev] && s.prev !== s.idx) one(list[s.prev], 'out');
  one(list[s.idx], p < 1 && s.prev != null ? 'in' : 'still');
  if (S.dots && list.length > 1) { // page dots at the bottom of the area
    const r = Math.max(3, A.h * 0.012), gap = r * 3.2, y = A.y + A.h / 2 - r * 4, x = A.x - (list.length - 1) * gap / 2;
    ctx.save(); ctx.globalAlpha = alphaK;
    list.forEach((_, i) => { ctx.beginPath(); ctx.arc(x + i * gap, y, i === s.idx ? r * 1.25 : r, 0, 6.2832); ctx.fillStyle = i === s.idx ? '#fff' : 'rgba(255,255,255,.45)'; ctx.fill(); });
    ctx.restore();
  }
}

const overStage = () => !!(hoverEl && hoverEl.isConnected && hoverEl.closest && hoverEl.closest('#scene-area'));

/* ------------------------------------------------------------- layers panel */
function renderLayers() {
  const el = $('tab-layers'), a = layers(), A = curArea(); syncSel(); hidePeek();
  const head = A ? `<div class="scope-bar"><button class="pill-btn" data-scope="out">${icon('arrowl')}<span>${parentOf(A.id) ? T`ออกไปชั้นบน` : T`เลเยอร์หลัก`}</span></button><span class="scope-name">${icon('area')}<b>${esc(A.name)}</b></span></div>` : '';
  if (!a.length) {
    el.innerHTML = head + `<div class="layers-empty">${A ? T`พื้นที่นี้ยังว่างอยู่` : T`ยังไม่มีเลเยอร์ในซีนนี้`}<br>${T`เพิ่มกล้อง รูป หรือข้อความจากแถบด้านซ้าย`}</div>`;
    const b = el.querySelector('[data-scope]'); if (b) b.onclick = () => exitArea();
    return;
  }
  el.innerHTML = head + a.slice().reverse().map((L) => `
    <div class="layer${L.id === selId ? ' sel' : selSet.has(L.id) ? ' sel2' : ''}${L.vis ? '' : ' off'}${L.type === 'area' ? ' is-area' : ''}" data-id="${L.id}" data-lid="${L.id}">
      <span class="l-ico">${icon(TYPE_ICON[L.type])}</span>
      <span class="l-name">${esc(L.name)}<small>${esc(typeLabel(L.type))}${L.type === 'area' ? ' · ' + T`${allOf(L.kids).length} ชิ้น` : ''}</small></span>
      ${L.type === 'area' ? `<button class="icon-btn" data-act="enter" title="${T`เข้าไปแก้ไขข้างใน`}">${icon('chev')}</button>` : ''}
      <button class="icon-btn${L.lock ? ' on' : ''}" data-act="lock" title="${T`ล็อกตำแหน่ง`}">${icon(L.lock ? 'lock' : 'unlock')}</button>
      <button class="icon-btn${L.vis ? '' : ' on'}" data-act="vis" title="${T`แสดง / ซ่อน · Alt+คลิก = แสดงเฉพาะอันนี้`}">${icon(L.vis ? 'eye' : 'eyeoff')}</button>
    </div>`).join('') + `<div class="panel-note">${T`ลากเพื่อจัดลำดับ หรือลากไปวางบนพื้นที่แอนิเมชันเพื่อใส่เข้าไป · บนสุดคือด้านหน้า`}<br><kbd>Ctrl</kbd>+${T`คลิก = เลือกหลายอัน`} · <kbd>F2</kbd> ${T`เปลี่ยนชื่อ`} · <kbd>Del</kbd> ${T`ลบ`} · <kbd>Ctrl+D</kbd> ${T`ทำสำเนา`} · <kbd>Ctrl+C</kbd> <kbd>Ctrl+X</kbd> <kbd>Ctrl+V</kbd> ${T`คัดลอก ตัด วาง`} · <kbd>Ctrl+G</kbd> ${T`รวมเป็นพื้นที่`} · <kbd>Ctrl+H</kbd> ${T`ซ่อน / แสดง`} · <kbd>Ctrl+Shift+H</kbd> ${T`แสดงทั้งหมด`} · <kbd>Alt</kbd>+${T`ลากขอบ = ครอป`} · <kbd>Shift</kbd> ${T`ยืดอิสระ`}</div>`;
  const sb = el.querySelector('[data-scope]'); if (sb) sb.onclick = () => exitArea();
  const hidden = a.filter((l) => !l.vis);
  if (hidden.length) { // one click brings back everything that was hidden
    const bar = document.createElement('div'); bar.className = 'vis-bar';
    bar.innerHTML = `<span>${icon('eyeoff')}${T`ซ่อนอยู่ ${hidden.length} เลเยอร์`}</span><button class="pill-btn">${icon('eye')}<span>${T`แสดงทั้งหมด`}</span></button>`;
    bar.querySelector('button').onclick = () => setVis(hidden, true);
    el.insertBefore(bar, el.querySelector('.layer'));
  }
  el.querySelectorAll('.layer').forEach((row) => {
    const id = row.dataset.id, L = byId(id);
    row.onclick = (e) => {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'enter') { enterArea(L); return; }
      if (act) { rowToggle(L, act.dataset.act, e); return; }
      select(id, multi(e) ? 'toggle' : e.shiftKey ? 'range' : undefined);
    };
    row.ondblclick = (e) => { if (e.target.closest('[data-act]')) return; if (L.type === 'area') enterArea(L); else { select(id); showTab('props'); } };
    row.onpointerenter = () => showPeek(L, row);
    row.onpointerleave = () => hidePeek();
    row.oncontextmenu = (e) => { e.preventDefault(); if (!selSet.has(id)) select(id); layerMenu(L, e.clientX, e.clientY); };
    row.onpointerdown = (e) => { hidePeek(); dragLayers(e, L, row); };
  });
}

/* ------------------------------------------------------- hover preview */
// pointing at a row in the layer list shows what the layer is: a live picture, its size / length and its animations
const peek = document.createElement('div'); peek.id = 'layer-peek'; peek.className = 'hidden'; document.body.appendChild(peek);
let peekL = null, peekT = 0, peekRaf = 0;
const fmtDur = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function hidePeek() { clearTimeout(peekT); cancelAnimationFrame(peekRaf); peekL = null; peek.classList.add('hidden'); }
function showPeek(L, row) {
  clearTimeout(peekT);
  peekT = setTimeout(() => {
    if (!row.isConnected) return;
    peekL = L;
    const r = rt.get(L.id), n = natural(L), info = [typeLabel(L.type)];
    if (n) info.push(`${n.w}×${n.h}`);
    if (L.type === 'video' && r && r.el && Number.isFinite(r.el.duration)) info.push(fmtDur(r.el.duration));
    if (L.type === 'video' && !L.media) info.push(T`ยังไม่ได้เก็บไฟล์`);
    if (L.type === 'text') info.push('“' + String(L.text || '').replace(/\n/g, ' ').slice(0, 36) + '”');
    if (!L.vis) info.push(T`ซ่อนอยู่`);
    const anims = [];
    for (const c of scene().clips || []) { const ts = c.tracks.filter((t) => t.layer === L.id); if (ts.length) anims.push(`<span>${icon('anim')}<b>${esc(c.name)}</b><em>${(+c.dur).toFixed(1)}s · ${esc([...new Set(ts.map((t) => (APROPS[t.prop] || { label: t.prop }).label))].slice(0, 5).join(', '))}</em></span>`); }
    const kids = L.type === 'area' ? allOf(L.kids) : [];
    peek.innerHTML = `<canvas></canvas><div class="pk-t">${icon(TYPE_ICON[L.type])}<b>${esc(L.name)}</b></div><small>${esc(info.join(' · '))}</small>`
      + (L.type === 'area' ? `<div class="pk-kids">${kids.length ? kids.slice(0, 8).map((k) => `<span>${icon(TYPE_ICON[k.type])}${esc(k.name)}</span>`).join('') + (kids.length > 8 ? `<span>+${kids.length - 8}</span>` : '') : `<span>${T`ยังว่างอยู่`}</span>`}</div>` : '')
      + `<div class="pk-anim">${anims.length ? anims.join('') : `<span class="none">${T`ยังไม่มีแอนิเมชัน`}</span>`}</div>`;
    peek.classList.remove('hidden');
    const rr = row.getBoundingClientRect(), pw = peek.offsetWidth, ph = peek.offsetHeight;
    peek.style.left = Math.max(8, rr.left - pw - 12) + 'px';
    peek.style.top = clamp(rr.top + rr.height / 2 - ph / 2, 64, innerHeight - ph - 8) + 'px';
    cancelAnimationFrame(peekRaf); drawPeek();
  }, 260);
}
function drawPeek() {
  const L = peekL, cv = peek.querySelector('canvas'); if (!L || !cv) return;
  const r = rt.get(L.id), n = natural(L), o = out();
  let img = null, sx = 0, sy = 0, sw = 0, sh = 0;
  if (n && r && r.el) { const c = L.crop; img = r.el; sx = c.l * n.w; sy = c.t * n.h; sw = n.w * (1 - c.l - c.r); sh = n.h * (1 - c.t - c.b); }
  else if (L.type !== 'handfx') { // the part of the stage picture where the layer is
    const b = groupBox([L]), x0 = clamp(b.x0, 0, o.w), y0 = clamp(b.y0, 0, o.h), x1 = clamp(b.x1, 0, o.w), y1 = clamp(b.y1, 0, o.h);
    if (x1 - x0 > 2 && y1 - y0 > 2) { img = canvas; sx = x0; sy = y0; sw = x1 - x0; sh = y1 - y0; }
  }
  if (!img) { img = canvas; sw = o.w; sh = o.h; }
  const q = img === canvas ? rs : 1; // the scene canvas may be drawn smaller than the scene (light mode)
  const W = 232, H = 150, k = Math.min(W / sw, H / sh), cw = Math.max(1, Math.round(sw * k)), ch = Math.max(1, Math.round(sh * k));
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  const g = cv.getContext('2d'); g.clearRect(0, 0, cw, ch);
  try { g.drawImage(img, sx * q, sy * q, sw * q, sh * q, 0, 0, cw, ch); } catch { /* source not ready */ }
  peekRaf = requestAnimationFrame(drawPeek);
}

/* ---------------------------------------------------------------- props tab */
const PRESETS = [
  [T`ปกติ`, { br: 100, ct: 100, sa: 100, hue: 0, blur: 0, gray: 0, sepia: 0 }],
  [T`สดใส`, { br: 106, ct: 112, sa: 140, hue: 0, blur: 0, gray: 0, sepia: 0 }],
  [T`อบอุ่น`, { br: 104, ct: 104, sa: 112, hue: -8, blur: 0, gray: 0, sepia: 26 }],
  [T`เย็น`, { br: 102, ct: 106, sa: 104, hue: 14, blur: 0, gray: 0, sepia: 0 }],
  [T`ขาวดำ`, { br: 104, ct: 116, sa: 100, hue: 0, blur: 0, gray: 100, sepia: 0 }],
  [T`วินเทจ`, { br: 98, ct: 92, sa: 82, hue: 0, blur: 0, gray: 0, sepia: 58 }],
  [T`ดราม่า`, { br: 92, ct: 142, sa: 118, hue: 0, blur: 0, gray: 0, sepia: 0 }],
  [T`นุ่มฝัน`, { br: 110, ct: 90, sa: 112, hue: 0, blur: 2, gray: 0, sepia: 8 }],
];
const FONTS = ['IBM Plex Sans Thai', 'Prompt', 'Kanit', 'Anuphan', 'Noto Sans Thai', 'Segoe UI', 'Segoe UI Emoji'];
const BLENDS = [['source-over', T`ปกติ`], ['screen', 'Screen'], ['multiply', 'Multiply'], ['overlay', 'Overlay'], ['lighter', 'Add'], ['soft-light', 'Soft light']];
let numSync = [];
function syncNums() { for (const f of numSync) f(); }

// with several layers selected, a change made in the panel is copied to all of them (only the fields each one has)
const NOSPREAD = new Set(['id', 'name', 'text', 'x', 'y', 'w', 'h', 'crop', 'fresh', 'asset', 'media', 'deviceId', 'type', 'kids', 'lock', 'vis']);
function spread(before, L, peers) {
  const walk = (a, b, path) => {
    for (const k of Object.keys(a)) {
      if (!path.length && NOSPREAD.has(k)) continue;
      const av = a[k], bv = b == null ? undefined : b[k];
      if (av && typeof av === 'object' && !Array.isArray(av)) { walk(av, bv, [...path, k]); continue; }
      if (JSON.stringify(av) === JSON.stringify(bv)) continue;
      for (const X of peers) { let o = X; for (const p of path) o = o && o[p]; if (o && typeof o === 'object' && (path.length || k in o)) o[k] = Array.isArray(av) ? av.slice() : av; }
    }
  };
  walk(L, before, []);
}
function renderProps() {
  const el = $('tab-props'), L = sel();
  numSync = [];
  if (!L) { el.innerHTML = `<div class="layers-empty">${T`เลือกเลเยอร์บนเวทีหรือในรายการเพื่อปรับแต่ง`}</div>`; return; }
  el.innerHTML = '';
  const media = MEDIA.has(L.type);
  const peers = sels().filter((X) => X !== L);
  let base = peers.length ? JSON.stringify(L) : '';
  // every control below commits through this: copy what changed on L to the other selected layers first
  const commit = () => { if (peers.length) { spread(JSON.parse(base), L, peers); base = JSON.stringify(L); } commitNow(); };
  const pathTo = (obj) => (obj === L ? [] : (() => { const k = Object.keys(L).find((x) => L[x] === obj); return k ? [k] : null; })());
  const live = (obj, key) => { // while dragging a slider: the others follow live
    if (!peers.length) return; const p = pathTo(obj); if (!p) return;
    for (const X of peers) { const o = p.reduce((a, k) => (a ? a[k] : a), X); if (o && typeof o === 'object' && (p.length || key in o)) o[key] = obj[key]; }
  };
  const each = (fn) => () => { for (const X of [L, ...peers]) fn(X); };
  if (peers.length) {
    const bar = document.createElement('div'); bar.className = 'arrange-bar';
    bar.innerHTML = ARRANGE().map(([k, ic, label]) => `<button class="icon-btn" data-ar="${k}" title="${esc(label)}">${icon(ic)}</button>`).join('');
    bar.onclick = (e) => { const b = e.target.closest('[data-ar]'); if (b) arrange(b.dataset.ar); };
    const vis = document.createElement('div'); vis.className = 'chips'; vis.style.margin = '0 0 8px';
    for (const [label, ic, run] of [[T`แสดงทั้งหมด`, 'eye', () => setVis([L, ...peers], true)], [T`ซ่อนทั้งหมด`, 'eyeoff', () => setVis([L, ...peers], false)], [T`แสดงเฉพาะที่เลือก`, 'eye', () => solo([L, ...peers])]]) { const b = document.createElement('button'); b.className = 'chip'; b.innerHTML = icon(ic) + `<span>${esc(label)}</span>`; b.onclick = run; vis.appendChild(b); }
    el.appendChild(bar); el.appendChild(vis);
  }
  if (peers.length) { const n = document.createElement('div'); n.className = 'multi-sel'; n.textContent = T`เลือก ${peers.length + 1} เลเยอร์ — ค่าที่ปรับในแผงนี้จะเปลี่ยนทุกเลเยอร์ที่เลือกพร้อมกัน (ตำแหน่ง X Y W H ปรับทีละอัน หรือลากบนเวที) · แผงนี้แสดงค่าของ “${L.name}”`; el.appendChild(n); }
  const sec = (ico, title, toggle) => {
    const s = document.createElement('div'); s.className = 'sec';
    s.innerHTML = `<h4>${icon(ico)}<span>${esc(title)}</span>${toggle ? '<label><input type="checkbox"></label>' : ''}</h4>`;
    el.appendChild(s);
    if (toggle) { const cb = s.querySelector('input'); cb.checked = toggle.get(); cb.onchange = () => { toggle.set(cb.checked); commit(); renderProps(); }; }
    return s;
  };
  const slider = (parent, label, obj, key, min, max, step = 1, fmt = (v) => v) => {
    const d = document.createElement('div'); d.className = 'sl';
    d.innerHTML = `<span>${esc(label)}</span><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`;
    const inp = d.querySelector('input'), o = d.querySelector('output');
    const show = () => { inp.value = obj[key]; o.textContent = fmt(obj[key]); inp.style.setProperty('--p', ((obj[key] - min) / (max - min)) * 100 + '%'); };
    inp.oninput = () => { obj[key] = +inp.value; live(obj, key); show(); };
    inp.onchange = commit;
    show(); parent.appendChild(d); numSync.push(show);
    return d;
  };
  const row = (parent, label, html) => { const d = document.createElement('div'); d.className = 'rowf'; d.innerHTML = `<span>${esc(label)}</span>${html}`; parent.appendChild(d); return d; };
  const color = (parent, label, obj, key) => { const d = row(parent, label, '<input type="color">'); const c = d.querySelector('input'); c.value = obj[key]; c.oninput = () => { obj[key] = c.value; live(obj, key); }; c.onchange = commit; return d; };
  const chips = (parent, items, cls = 'chips') => {
    const d = document.createElement('div'); d.className = cls;
    for (const [label, run, on, ico, tip] of items) { const b = document.createElement('button'); b.className = 'chip' + (on ? ' on' : '') + (label ? '' : ' ico-only'); b.innerHTML = (ico ? icon(ico) : '') + (label ? `<span>${esc(label)}</span>` : ''); if (tip) b.title = tip; b.onclick = () => { run(); commit(); renderProps(); renderLayers(); }; d.appendChild(b); }
    parent.appendChild(d); return d;
  };

  /* — hand effects layer — */
  if (L.type === 'handfx') {
    const F = L.fx || (L.fx = { ...FX_DEFAULT });
    const tog = (label, k) => [label, () => { F[k] = !F[k]; }, F[k]];
    const fxs = sec('hand', T`เอฟเฟกต์มือ`);
    chips(fxs, [tog(T`โครงมือนีออน`, 'skel'), tog(T`ปลายนิ้วเรืองแสง`, 'glow'), tog(T`ประกายไฟ`, 'sparks'), tog(T`ลูกพลังบนฝ่ามือ`, 'orb'), tog(T`วงเวท`, 'ring'), tog(T`สายฟ้าระหว่างสองมือ`, 'link'), tog(T`อีโมจิตามท่ามือ`, 'emoji'), tog(T`ป้ายชื่อท่า`, 'label')]).style.marginBottom = '8px';
    const tr = row(fxs, T`หางแสง`, `<label class="field"><select><option value="off">${T`ปิด`}</option><option value="index">${T`นิ้วชี้`}</option><option value="all">${T`ทุกนิ้ว`}</option></select></label>`);
    const ts = tr.querySelector('select'); ts.value = F.trail; ts.onchange = () => { F.trail = ts.value; commit(); };
    const note = document.createElement('div'); note.className = 'panel-note';
    note.textContent = T`แบมือเพื่อเรียกลูกพลัง แล้วกำมือเพื่อระเบิด · ยกสองมือเพื่อให้สายฟ้าวิ่งระหว่างนิ้วชี้`; fxs.appendChild(note);
    const cs = sec('drop', T`สีและขนาด`);
    if (!F.rainbow) { color(cs, T`สีหลัก`, F, 'color'); color(cs, T`สีรอง`, F, 'color2'); }
    chips(cs, [tog(T`สีรุ้ง`, 'rainbow')]).style.margin = '6px 0';
    slider(cs, T`ขนาดเส้น`, F, 'size', 40, 250, 5, (v) => v + '%');
    const dr = sec('edit', T`วาดรูปกลางอากาศ`, { get: () => F.draw, set: (v) => { F.draw = v; } });
    if (F.draw) {
      slider(dr, T`จางหาย`, F, 'drawFade', 0, 30, 1, (v) => (v ? v + 's' : '∞'));
      chips(dr, [[T`ล้างภาพวาด`, () => clearHandDrawing()]]).style.margin = '6px 0';
      const n2 = document.createElement('div'); n2.className = 'panel-note'; n2.textContent = T`จีบนิ้วโป้งกับนิ้วชี้แล้วลากเพื่อวาด ปล่อยนิ้วเพื่อหยุดวาด`; dr.appendChild(n2);
    }
    return;
  }

  /* — text — */
  if (L.type === 'text') {
    const s = sec('text', T`ข้อความ`);
    const f = document.createElement('label'); f.className = 'field area'; f.innerHTML = '<textarea spellcheck="false"></textarea>'; s.appendChild(f);
    const ta = f.querySelector('textarea'); ta.value = L.text; ta.oninput = () => { L.text = ta.value; }; ta.onchange = () => { L.name = (L.text.split('\n')[0] || T`ข้อความ`).slice(0, 24); commit(); renderLayers(); };
    const fr = row(s, T`ฟอนต์`, `<label class="field"><select>${FONTS.map((x) => `<option>${x}</option>`).join('')}</select></label>`);
    const fs = fr.querySelector('select'); fs.value = L.font; fs.onchange = () => { L.font = fs.value; commit(); };
    slider(s, T`ความหนา`, L, 'weight', 400, 700, 100);
    color(s, T`สีตัวอักษร`, L, 'color');
    slider(s, T`ขอบตัวอักษร`, L, 'stroke', 0, 12, 1);
    if (L.stroke) color(s, T`สีขอบ`, L, 'strokeColor');
    const bgs = sec('shape', T`พื้นหลังข้อความ`, { get: () => L.bg, set: (v) => { L.bg = v; } });
    if (L.bg) { color(bgs, T`สีพื้น`, L, 'bgColor'); slider(bgs, T`มุมโค้ง`, L, 'radius', 0, 120); }
  }
  if (L.type === 'area') {
    const s = sec('area', T`พื้นที่แอนิเมชัน`);
    chips(s, [[T`เข้าไปแก้ไขข้างใน (${allOf(L.kids).length})`, () => enterArea(L), false, 'edit'], [T`ซ่อนส่วนที่ล้นขอบ`, () => { L.clip = L.clip === false; }, L.clip !== false, 'crop'], L.kids.length && [T`กรอบพอดีของข้างใน`, () => fitAreaToKids(L), false, 'fit']].filter(Boolean));
    const an = document.createElement('div'); an.className = 'panel-note';
    an.textContent = T`พื้นที่เป็นชิ้นเดียวเหมือนวิดีโอ: ลาก ย่อ/ขยาย หมุน แล้วของข้างในไปด้วยทั้งหมด (กด Alt ค้างตอนลากมุม = ปรับแค่กรอบ) · ดับเบิลคลิกเพื่อเข้าไปแก้ของข้างใน คลิกนอกกรอบหรือกด Esc เพื่อออก · คลิกขวาที่เลเยอร์เพื่อย้ายเข้าพื้นที่`;
    s.appendChild(an);
    const bg = sec('drop', T`พื้นหลังของพื้นที่`, { get: () => !!L.bg, set: (v) => { L.bg = v; } });
    if (L.bg) color(bg, T`สีพื้น`, L, 'fill');

    // its own timeline: clips that belong to the area, play by themselves while it is shown and restart when it appears
    const own = (scene().clips || []).filter((c) => c.area === L.id);
    const tl = sec('anim', T`ไทม์ไลน์ของพื้นที่`);
    if (!own.length) chips(tl, [[T`สร้างไทม์ไลน์ของพื้นที่`, () => openAreaTimeline(L, true), false, 'plus']]);
    for (const c of own) {
      const r = document.createElement('div'); r.className = 'own-clip';
      r.innerHTML = `${icon('anim')}<b>${esc(c.name)}</b><small>${(+c.dur).toFixed(1)}s · ${c.tracks.length} ${T`แถว`}</small>`;
      tl.appendChild(r);
      chips(tl, [
        [T`แก้ไขแอนิเมชัน`, () => openAreaTimeline(L, false, c.id), false, 'edit'],
        [T`เล่นเองเมื่อพื้นที่โผล่`, () => { c.auto = !c.auto; }, !!c.auto, 'play'],
        [c.loop === 'loop' ? T`วนลูป` : c.loop === 'pingpong' ? T`ไป-กลับ` : T`เล่นครั้งเดียว`, () => { c.loop = { once: 'loop', loop: 'pingpong', pingpong: 'once' }[c.loop] || 'loop'; }, c.loop !== 'once', 'loop'],
      ]);
    }
    if (own.length) chips(tl, [[T`เพิ่มอีกคลิป`, () => openAreaTimeline(L, true), false, 'plus']]);
    const tn = document.createElement('div'); tn.className = 'panel-note'; tn.textContent = T`แอนิเมชันของของข้างในพื้นที่ แยกจากคลิปหลัก — เล่นวนเองเมื่อพื้นที่แสดงอยู่ และเริ่มใหม่ทุกครั้งที่พื้นที่โผล่ขึ้นมา`; tl.appendChild(tn);

    // slideshow
    const S0 = L.slides = { ...SLIDE_DEF, ...(L.slides || {}) };
    const ss = sec('image', T`สไลด์โชว์`, { get: () => S0.on, set: (v) => { S0.on = v; slideRt.delete(L.id); } });
    if (S0.on) {
      const nS = slideList(L).length;
      chips(ss, [[T`เลื่อนเอง`, () => { S0.mode = 'auto'; }, S0.mode === 'auto', 'clock'], [T`เลื่อนเมื่อสั่ง`, () => { S0.mode = 'manual'; }, S0.mode === 'manual', 'hand']]).style.marginBottom = '6px';
      if (S0.mode === 'auto') slider(ss, T`ทุกๆ`, S0, 'every', 1, 15, 0.5, (v) => v + 's');
      chips(ss, [[T`จางเข้า`, () => { S0.trans = 'fade'; }, S0.trans === 'fade'], [T`เลื่อน`, () => { S0.trans = 'slide'; }, S0.trans === 'slide'], [T`ซูม`, () => { S0.trans = 'zoom'; }, S0.trans === 'zoom'], [T`พลิก`, () => { S0.trans = 'flip'; }, S0.trans === 'flip']]).style.margin = '6px 0';
      slider(ss, T`ความเร็วเปลี่ยนภาพ`, S0, 'dur', 0.1, 2, 0.05, (v) => (+v).toFixed(2) + 's');
      chips(ss, [['‹ ' + T`ก่อนหน้า`, () => slideGo(L, -1)], [T`ถัดไป` + ' ›', () => slideGo(L, 1)], [T`จุดบอกหน้า`, () => { S0.dots = !S0.dots; }, S0.dots]]).style.marginTop = '6px';
      chips(ss, [[T`ปัดมือซ้าย/ขวาเพื่อเลื่อน`, () => quickBinds([['swipe-left', 'slide-prev:' + L.id], ['swipe-right', 'slide-next:' + L.id]]), false, 'hand']]).style.marginTop = '6px';
      const sn = document.createElement('div'); sn.className = 'panel-note'; sn.textContent = T`${nS} สไลด์ = เลเยอร์ที่แสดงอยู่ในพื้นที่ (บนสุดก่อน) · ตอนเข้าไปแก้ข้างในจะเห็นทุกอันพร้อมกัน`; ss.appendChild(sn);
    }

    // hand gestures for this area
    const gs = sec('hand', T`สั่งพื้นที่ด้วยท่ามือ`);
    const mine = project.hand.binds.filter((x) => x.action && x.action.type === 'app' && String(x.action.cmd || '').endsWith(':' + L.id) && !String(x.action.cmd).startsWith('anim:'));
    for (const x of mine) { const r = document.createElement('div'); r.className = 'own-clip'; r.innerHTML = `${icon('hand')}<b>${esc(gestureName(x.gesture))}</b><small>${esc(cmdName(x.action.cmd))}</small><button class="icon-btn" title="${T`ลบ`}">${icon('x')}</button>`; r.querySelector('button').onclick = () => { project.hand.binds.splice(project.hand.binds.indexOf(x), 1); touch(); bus.emit('hand:binds'); renderProps(); }; gs.appendChild(r); }
    chips(gs, [
      [T`ท่ามือ → โชว์ / ซ่อน`, () => bus.emit('hand:edit-bind', { action: { type: 'app', cmd: 'layer:' + L.id } }), false, 'eye'],
      [T`ท่ามือ → โชว์`, () => bus.emit('hand:edit-bind', { action: { type: 'app', cmd: 'layer-show:' + L.id } }), false, 'eye'],
      [T`ท่ามือ → ซ่อน`, () => bus.emit('hand:edit-bind', { action: { type: 'app', cmd: 'layer-hide:' + L.id } }), false, 'eyeoff'],
      own.length && [T`ท่ามือ → เล่นแอนิเมชันพื้นที่`, () => bus.emit('hand:edit-bind', { action: { type: 'app', cmd: 'anim:play:' + own[0].id } }), false, 'play'],
    ].filter(Boolean));
    chips(gs, [[T`บันทึกพื้นที่นี้เป็นเทมเพลต`, () => saveTemplate([L]), false, 'star']]).style.marginTop = '6px';
  }
  if (L.type === 'shape') {
    const s = sec('shape', T`สีรูปทรง`, { get: () => L.grad, set: (v) => { L.grad = v; } });
    color(s, L.grad ? T`สีเริ่ม` : T`สี`, L, 'fill');
    if (L.grad) color(s, T`สีปลาย`, L, 'fill2');
  }

  /* — layout — */
  const lay = sec('fit', T`ตำแหน่งและขนาด`);
  chips(lay, [
    [T`เต็มจอ`, each((X) => place(X, 'cover'))], [T`พอดีจอ`, each((X) => place(X, 'contain'))], [T`กึ่งกลาง`, each((X) => place(X, 'center'))], [T`วงกลม`, each((X) => place(X, 'bubble'))],
    ['', each((X) => place(X, 'tl')), false, 'pipTl', T`มุมซ้ายบน`], ['', each((X) => place(X, 'tr')), false, 'pipTr', T`มุมขวาบน`], ['', each((X) => place(X, 'bl')), false, 'pipBl', T`มุมซ้ายล่าง`], ['', each((X) => place(X, 'br')), false, 'pipBr', T`มุมขวาล่าง`],
    [T`ครึ่งซ้าย`, each((X) => place(X, 'left'))], [T`ครึ่งขวา`, each((X) => place(X, 'right'))],
    [T`กลับซ้ายขวา`, () => { L.flipH = !L.flipH; }, L.flipH], [T`กลับบนล่าง`, () => { L.flipV = !L.flipV; }, L.flipV],
  ], 'grid4');
  const nums = document.createElement('div'); nums.className = 'nums'; nums.style.marginTop = '9px'; lay.appendChild(nums);
  for (const [k, lab] of [['x', 'X'], ['y', 'Y'], ['w', 'W'], ['h', 'H']]) {
    const f = document.createElement('label'); f.className = 'field'; f.innerHTML = `<b>${lab}</b><input type="number">`; nums.appendChild(f);
    const inp = f.querySelector('input'); const show = () => { if (document.activeElement !== inp && !inp._scrub) inp.value = Math.round(L[k]); };
    const apply = () => { const v = +inp.value; if (!Number.isFinite(v)) return false; if ((k === 'w' || k === 'h') && L.type !== 'frame' && L.type !== 'shape') { const ar = L.w / L.h; if (k === 'w') { L.w = Math.max(8, v); L.h = L.w / ar; } else { L.h = Math.max(8, v); L.w = L.h * ar; } } else L[k] = (k === 'w' || k === 'h') ? Math.max(8, v) : v; return true; };
    inp.oninput = () => { if (inp._scrub) apply(); }; // dragging the number: live, one undo step at the end
    inp.onchange = () => { if (apply()) { commit(); syncNums(); } };
    show(); numSync.push(show);
  }
  // size that never stretches: 100 % = fits the screen (or the area it is in); every selected layer scales by the same factor
  const fitW = (X) => { const P = parentOf(X.id), o = P ? { w: P.w, h: P.h } : out(), ar = X.w / Math.max(1e-6, X.h); return Math.min(o.w, o.h * ar); };
  const scaleBy = (k) => { for (const X of [L, ...peers]) { if (X.lock || X.type === 'handfx') continue; X.w = Math.max(8, X.w * k); X.h = Math.max(8, X.h * k); } };
  const Z = { get k() { return Math.round(L.w / fitW(L) * 100); }, set k(v) { scaleBy(Math.max(5, v) / 100 * fitW(L) / L.w); } };
  slider(lay, T`ขนาด`, Z, 'k', 5, 300, 1, (v) => v + '%').title = T`ย่อ / ขยายโดยไม่ยืด — 100% = พอดีจอ`;
  const n0 = MEDIA.has(L.type) ? natural(L) : null;
  chips(lay, [
    ['', () => scaleBy(1 / 1.1), false, 'zoomOut', T`ย่อลง 10%`],
    ['', () => scaleBy(1.1), false, 'zoomIn', T`ขยาย 10%`],
    n0 && [T`ขนาดจริง`, () => { const k = n0.w * (1 - L.crop.l - L.crop.r) / L.w; scaleBy(k); }, false, null, T`1 พิกเซลของรูป = 1 พิกเซลของภาพที่ส่งออก`],
    n0 && [T`แก้ภาพยืด`, each((X) => { const n = natural(X); if (!n) return; const ar = cropAspect(X, n), a = Math.sqrt(X.w * X.h); X.w = a * Math.sqrt(ar); X.h = a / Math.sqrt(ar); }), false, 'ratio', T`คืนสัดส่วนเดิมของรูป / วิดีโอ (ขนาดพื้นที่เท่าเดิม)`],
  ].filter(Boolean), 'chips size-row');
  slider(lay, T`หมุน`, L, 'rot', -180, 180, 1, (v) => Math.round(v) + '°');
  slider(lay, T`ความทึบ`, L, 'op', 0, 1, 0.01, (v) => Math.round(v * 100) + '%');

  /* — follow the hand — */
  const A = L.hand || (L.hand = { ...HAND_DEF });
  const hsec = L.type === 'area' ? null : sec('hand', T`ติดตามมือ`, { get: () => A.on, set: (v) => { A.on = v; if (v) { project.hand.on = true; hp.delete(L.id); for (const X of peers) hp.delete(X.id); bus.emit('hand:cfg'); } } });
  if (hsec && A.on) {
    const pickRow = (label, key, opts, after) => {
      const d = row(hsec, label, `<label class="field"><select>${opts.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join('')}</select></label>`);
      const se = d.querySelector('select'); se.value = A[key]; se.onchange = () => { A[key] = se.value; if (after) after(); commit(); renderProps(); };
    };
    pickRow(T`จุดที่เกาะ`, 'pt', [['palm', T`กลางฝ่ามือ`], ['above', T`ลอยเหนือมือ`], ['index', T`ปลายนิ้วชี้`], ['thumb', T`ปลายนิ้วโป้ง`], ['middle', T`ปลายนิ้วกลาง`], ['pinky', T`ปลายนิ้วก้อย`], ['pinch', T`จุดจีบนิ้ว`], ['wrist', T`ข้อมือ`], ['between', T`ระหว่างสองมือ`]], () => { A.dx = A.dy = 0; A.ref = 0; });
    if (A.pt !== 'between') pickRow(T`มือ`, 'side', [['any', T`มือไหนก็ได้`], ['right', T`มือขวา`], ['left', T`มือซ้าย`]]);
    chips(hsec, [
      [T`หมุนตามมือ`, () => { A.rot = !A.rot; }, A.rot],
      [T`ย่อขยายตามมือ`, () => { A.scale = !A.scale; const ps = hp.get(L.id); A.ref = A.scale && ps && ps.live ? ps.size : 0; }, A.scale],
      [T`รีเซ็ตตำแหน่ง`, () => { A.dx = A.dy = 0; }],
    ]).style.margin = '6px 0';
    A.smooth ??= 25;
    slider(hsec, T`ความนุ่มนวล`, A, 'smooth', 0, 100, 5, (v) => (v ? v + '%' : T`ติดแน่น`));
    pickRow(T`เมื่อไม่เห็นมือ`, 'lost', [['hide', T`ซ่อน`], ['stay', T`ค้างไว้ที่เดิม`], ['home', T`กลับตำแหน่งตั้งต้น`]]);
    pickRow(T`มีผลเฉพาะท่า`, 'gest', [['', T`ทุกท่า`], ...gestureList().filter((g) => !g[0].startsWith('swipe')).map((g) => [g[0], g[1] + ' ' + g[2]]), ...customList().map((p) => ['c:' + p.id, '⭐ ' + p.name]), ...pairList().map((g) => [g, gestureName(g)])]);
    if (A.gest) { const gn = document.createElement('div'); gn.className = 'panel-note'; gn.textContent = { hide: T`ไม่ได้ทำท่านี้ = ซ่อนเลเยอร์`, stay: T`ไม่ได้ทำท่านี้ = เลเยอร์ค้างอยู่ที่เดิม ขยับและย่อขยายตามมือเฉพาะตอนทำท่านี้`, home: T`ไม่ได้ทำท่านี้ = เลเยอร์กลับไปตำแหน่งตั้งต้น` }[A.lost] || ''; hsec.appendChild(gn); }
    const hn = document.createElement('div'); hn.className = 'panel-note';
    hn.textContent = T`ลากเลเยอร์บนเวทีขณะที่กล้องเห็นมือ เพื่อเลื่อนตำแหน่งเทียบกับมือ`; hsec.appendChild(hn);
  }

  /* — shape of the box — */
  if (L.type !== 'text') {
    const sh = sec('frame', T`รูปร่างและกรอบ`);
    chips(sh, [[T`สี่เหลี่ยม`, () => { L.mask = 'rect'; }, L.mask === 'rect'], [T`วงรี / วงกลม`, () => { L.mask = 'ellipse'; }, L.mask === 'ellipse'],
      media && [cropMode ? T`เสร็จสิ้นการครอป` : T`ครอปภาพ`, () => { cropMode = !cropMode; }, cropMode, 'crop'],
      media && (L.crop.l || L.crop.r || L.crop.t || L.crop.b) && [T`ล้างครอป`, () => { const n = natural(L); const c = L.crop; if (n) { const fw = L.w / (1 - c.l - c.r), fh = L.h / (1 - c.t - c.b); L.w = fw; L.h = fh; } L.crop = { l: 0, t: 0, r: 0, b: 0 }; }]].filter(Boolean)).style.marginBottom = '6px';
    if (L.mask === 'rect') slider(sh, T`มุมโค้ง`, L, 'radius', 0, 300);
    slider(sh, T`ความหนากรอบ`, L, 'border', 0, 60);
    if (L.border) color(sh, T`สีกรอบ`, L, 'borderColor');
    slider(sh, T`เงา`, L, 'shadow', 0, 80);
  } else slider(lay, T`เงา`, L, 'shadow', 0, 60);

  /* — colour & filters — */
  if (media) {
    const fl = sec('sparkle', T`ฟิลเตอร์และสี`);
    const same = (p) => Object.keys(p).every((k) => p[k] === L.f[k]);
    chips(fl, PRESETS.map(([name, p]) => [name, () => { L.f = { ...p }; }, same(p)])).style.marginBottom = '8px';
    slider(fl, T`ความสว่าง`, L.f, 'br', 40, 180, 1, (v) => v + '%');
    slider(fl, T`คอนทราสต์`, L.f, 'ct', 40, 200, 1, (v) => v + '%');
    slider(fl, T`ความสดของสี`, L.f, 'sa', 0, 250, 1, (v) => v + '%');
    slider(fl, T`โทนสี`, L.f, 'hue', -180, 180, 1, (v) => v + '°');
    slider(fl, T`เบลอ`, L.f, 'blur', 0, 30, 0.5);
    slider(fl, T`ขาวดำ`, L.f, 'gray', 0, 100, 1, (v) => v + '%');
    slider(fl, T`ซีเปีย`, L.f, 'sepia', 0, 100, 1, (v) => v + '%');

    const ai = sec('wand', T`พื้นหลัง AI`);
    chips(ai, [[T`ปิด`, () => { L.ai.mode = 'off'; }, L.ai.mode === 'off'], [T`ลบพื้นหลัง`, () => { L.ai.mode = 'remove'; }, L.ai.mode === 'remove'], [T`เบลอพื้นหลัง`, () => { L.ai.mode = 'blur'; }, L.ai.mode === 'blur']]);
    if (L.ai.mode !== 'off') {
      if (L.ai.mode === 'blur') slider(ai, T`ระดับเบลอ`, L.ai, 'blur', 2, 40);
      const st = segState();
      const note = document.createElement('div'); note.className = 'panel-note';
      note.textContent = st === 'ready' ? T`ตัดตัวคนออกจากฉากหลังอัตโนมัติ ไม่ต้องใช้กรีนสกรีน` : st === 'failed' ? T`โหลดโมเดล AI ไม่สำเร็จ` : T`กำลังโหลดโมเดล AI…`;
      ai.appendChild(note);
    }

    const ck = sec('drop', T`Chroma key (กรีนสกรีน)`, { get: () => L.key.on, set: (v) => { L.key.on = v; } });
    if (L.key.on) {
      color(ck, T`สีที่จะลบ`, L.key, 'color');
      slider(ck, T`ช่วงสี`, L.key, 'sim', 1, 100);
      slider(ck, T`ขอบนุ่ม`, L.key, 'smooth', 0, 60);
      slider(ck, T`ลดสีสะท้อน`, L.key, 'spill', 0, 100);
    }
    const bl = sec('layers', T`การผสมสี`);
    const br = row(bl, T`โหมด`, `<label class="field"><select>${BLENDS.map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join('')}</select></label>`);
    const bs = br.querySelector('select'); bs.value = L.blend; bs.onchange = () => { L.blend = bs.value; commit(); };
  }
}

/* ---------------------------------------------------------- scenes / status */
function renderScenes() {
  const el = $('scenes'); el.innerHTML = '';
  project.scenes.forEach((s, i) => {
    const b = document.createElement('button'); b.className = 'chip' + (i === project.cur ? ' on' : ''); b.textContent = s.name;
    b.onclick = () => { if (i === project.cur) return; project.cur = i; selId = null; commit(); syncRuntime(); refreshAll(); };
    b.oncontextmenu = (e) => {
      e.preventDefault();
      ctxMenu(e.clientX, e.clientY, [
        { icon: 'edit', label: T`เปลี่ยนชื่อ`, run: async () => { const n = await promptBox(T`เปลี่ยนชื่อ`, s.name, T`บันทึก`); if (n) { s.name = n; commit(); renderScenes(); } } },
        { icon: 'copy', label: T`ทำสำเนาซีน`, run: () => { const lm = {}, c = { ...JSON.parse(JSON.stringify(s)), id: uid(), name: s.name + ' 2', layers: s.layers.filter((l) => !noCopy(l)).map((l) => cloneLayer(l, lm)) }; remapClips(c, lm); project.scenes.splice(i + 1, 0, c); project.cur = i + 1; selId = null; commit(); syncRuntime(); refreshAll(); } },
        project.scenes.length > 1 && { icon: 'trash', label: T`ลบซีน`, danger: true, run: () => { project.scenes.splice(i, 1); project.cur = clamp(project.cur >= i ? project.cur - 1 : project.cur, 0, project.scenes.length - 1); selId = null; commit(); syncRuntime(); refreshAll(); } },
      ], s.name);
    };
    el.appendChild(b);
  });
}
function refreshAll() { if (scope && !curArea()) scope = null; linkKids(root()); renderScenes(); renderLayers(); renderProps(); placeGizmo(); $('empty').classList.toggle('hidden', root().length > 0); bus.emit('studio:refresh'); }
// a copied scene gets fresh layer ids: point its clips (and their chains) at the copies
function remapClips(c, lm) {
  const cm = {}; for (const cl of c.clips || []) cm[cl.id] = uid();
  for (const cl of c.clips || []) { cl.id = cm[cl.id]; cl.next = cm[cl.next] || ''; cl.tracks = cl.tracks.filter((t) => lm[t.layer]).map((t) => ({ ...t, id: uid(), layer: lm[t.layer] })); }
}
function showTab(name) {
  if (name === 'lib') renderLib();
  document.querySelectorAll('#panel-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.ptab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
}

/* ------------------------------------------------------- snapshot / record */
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
async function saveBlob(blob, name) {
  if (native) {
    const r = await api.raw('media_save', new Uint8Array(await blob.arrayBuffer()), { 'x-name': name }).catch(() => null);
    if (r && r.ok) toast(T`บันทึกแล้ว: ${r.path}`, { label: T`เปิดโฟลเดอร์`, action: () => api.invoke('media:reveal', r.path) });
    else toast(T`บันทึกไฟล์ไม่สำเร็จ`, { kind: 'err' });
  } else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast(T`บันทึกแล้ว: ${name}`); }
}
function snapshot() { canvas.toBlob((b) => b && saveBlob(b, `PrismCam-${stamp()}.png`), 'image/png'); }
let rec = null, recTrack = null;
async function toggleRecord() {
  const btn = $('btn-rec');
  if (rec) { rec.stop(); return; }
  // captureStream(0) + requestFrame() after every draw: exactly one video frame per drawn frame. The automatic
  // capture (captureStream(fps)) samples on screen refresh and lost ~15 % of the frames at 60 fps.
  const stream = canvas.captureStream(0);
  recTrack = stream.getVideoTracks()[0];
  let mic = null;
  try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); mic.getAudioTracks().forEach((t) => stream.addTrack(t)); } catch { /* no microphone → silent video */ }
  const mime = window.__recMime || ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const chunks = [], t0 = Date.now();
  rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: out().fps > 30 ? 12e6 : 8e6 });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const timer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); $('rec-label').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 500);
  rec.onstop = () => {
    clearInterval(timer); rec = null; recTrack = null; btn.classList.remove('on'); $('rec-label').textContent = T`อัดวิดีโอ`;
    if (mic) mic.getTracks().forEach((t) => t.stop());
    saveBlob(new Blob(chunks, { type: 'video/webm' }), `PrismCam-${stamp()}.webm`);
  };
  rec.start(1000); btn.classList.add('on'); $('rec-label').textContent = '00:00';
  toast(mic ? T`เริ่มอัดวิดีโอพร้อมเสียงไมค์แล้ว` : T`เริ่มอัดวิดีโอแล้ว (ไม่มีเสียง)`);
}

/* --------------------------------------------------------------------- boot */
export async function startStudio() {
  await load();
  ensureHand();
  for (const sc of project.scenes) for (const l of allLayers(sc)) {
    if (l.type === 'image' && l.asset && project.assets[l.asset] && !lib().some((x) => x.asset === l.asset)) lib().push({ id: uid(), kind: 'image', asset: l.asset, name: l.name, at: Date.now() });
    if (l.type === 'video' && l.media && !lib().some((x) => x.media === l.media)) lib().push({ id: uid(), kind: 'video', media: l.media, name: l.name, at: Date.now() });
  }
  rebase();
  applyOut(); syncRuntime(); refreshAll();
  document.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => ADD[b.dataset.add](); });
  document.querySelectorAll('#panel-tabs .tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });
  bus.on('studio:refresh', () => { if ($('tab-lib').classList.contains('active')) renderLibSoon(); });
  $('scene-add').onclick = () => { project.scenes.push({ id: uid(), name: T`ซีน ${project.scenes.length + 1}`, layers: [] }); project.cur = project.scenes.length - 1; selId = null; commit(); syncRuntime(); refreshAll(); };
  $('out-res').onchange = () => resizeOut(...$('out-res').value.split('x').map(Number));
  $('out-fps').onchange = () => setFps(+$('out-fps').value);
  $('btn-undo').onclick = () => step(ZONES, true);
  $('btn-snap').onclick = snapshot;
  $('btn-rec').onclick = toggleRecord;
  addEventListener('resize', layout);
  new ResizeObserver(layout).observe($('scene-area'));
  bus.on('select-tab', showTab);
  // commands fired by hand gestures (and anything else that wants to drive the studio)
  const gotoScene = (i) => { if (i < 0 || i >= project.scenes.length || i === project.cur) return; project.cur = i; selId = null; commit(); syncRuntime(); refreshAll(); };
  bus.on('cmd', (c) => {
    const n = project.scenes.length;
    if (c === 'scene-next') gotoScene((project.cur + 1) % n);
    else if (c === 'scene-prev') gotoScene((project.cur + n - 1) % n);
    else if (c.startsWith('scene:')) gotoScene(+c.slice(6));
    else if (c === 'snap') snapshot();
    else if (c === 'rec') toggleRecord();
    else if (c === 'fx-clear') clearHandDrawing();
    else if (c.startsWith('layer:')) { const L = byId(c.slice(6)); if (L) { L.vis = !L.vis; commit(); renderLayers(); } }
    else if (c.startsWith('layer-show:') || c.startsWith('layer-hide:')) { const L = byId(c.slice(c.indexOf(':') + 1)); if (L) setVis([L], c.startsWith('layer-show:')); }
    else if (c.startsWith('slide-next:') || c.startsWith('slide-prev:')) { const A = byId(c.slice(c.indexOf(':') + 1)); if (A && A.slides && A.slides.on) slideGo(A, c.startsWith('slide-next:') ? 1 : -1); }
  });
  // a worker drives the frame clock so the output keeps running while the window is minimised or covered
  let ticking = false;
  // a PC that falls behind gets a queue of ticks: drop the ones that arrive right after a frame instead of drawing them all late
  // frames follow a fixed schedule (every 1000/fps ms): timer jitter neither adds frames nor loses them, and a late PC
  // restarts the schedule instead of catching up with a burst
  let due = 0;
  const tick = () => {
    if (ticking) return;
    const t = performance.now(), step = 1000 / liveFps(out().fps);
    if (t < due - step * 0.3) return; // a tick a little early still counts (the worker ticks at the same rate)
    due = t - due > step ? t + step : due + step;
    ticking = true; try { draw(); } finally { ticking = false; }
  };
  bus.on('perf', applyOut);
  try {
    const w = new Worker(new URL('./tick.js', import.meta.url));
    const rate = () => w.postMessage(liveFps(out().fps));
    w.onmessage = tick; rate();
    bus.on('out', rate); bus.on('fps', rate); bus.on('perf', rate);
  } catch { setInterval(tick, 1000 / 30); }
  // first selection change also opens the properties tab once, so new users discover it
  let hinted = false;
  bus.on('added', () => { if (!hinted) { hinted = true; showTab('props'); } });
}
function reset() { project = fresh(); ensureHand(); selId = null; scope = null; for (const z of ZONES) { undoS[z].length = 0; redoS[z].length = 0; } rebase(); undoBtn(); applyOut(); syncRuntime(); refreshAll(); queueSave(); }
// release every camera / screen stream so the driver is never left holding a device after the app closes
export function releaseAll() {
  for (const c of cams.values()) { if (c.stream) c.stream.getTracks().forEach((t) => t.stop()); if (c.video) c.video.srcObject = null; }
  for (const r of rt.values()) if (r.own && r.el && r.el.srcObject) r.el.srcObject.getTracks().forEach((t) => t.stop());
  guard(false);
}
addEventListener('pagehide', releaseAll);
export const studio = {
  canvas, out, save, layers, addText, addShape, reset, releaseAll,
  rebaseNow: () => { rebase(); undoBtn(); queueSave(); },
  sourceOf: (L) => { const r = rt.get(L.id); return r && r.el && natural(L) ? r.el : null; },
  hand: () => project.hand, applyHandCfg, touch, handSource, saveTemplate, slideGo, setVis, solo, arrange, dragLayers, layerMenu, copyLayers, pasteLayers, overStage, hasLayerClip: () => !!layerClip, allLayers, tree, enterArea, exitArea, scope: () => scope, parentOf, scenes: () => project.scenes,
  addHandFx, addHandText, addHandSticker, refreshProps: renderProps, showTab,
  scene, byId, select, selectMany, selected: () => sel(), selection: () => sels(), renameLayer, renameScene, commit, E, AV, hands: HS, typeLabel, TYPE_ICON, renderLayers, refreshAll, layout,
};
