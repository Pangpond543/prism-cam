// Animation mode — takes over the studio like an "Edit" mode: transport toolbar on top, timeline / graph editor at the
// bottom, keyframe · clip · trigger inspector on the right and a motion path on the stage. Clips start from hand gestures
// (the existing gesture → command system), hotkeys, the scene opening, other clips, timeline events, or follow the hand.
import { faceExprList, isFaceDrive } from './facedefs.js';
import { bus, T, toast, htmlBox, promptBox, confirmBox, ctxMenu, esc, clamp, theme, $ } from './core.js';
import { icon } from './icons.js';
import { studio, hooks } from './studio.js';
import * as A from './anim-core.js';
import { gestureEmoji, gestureName, gestureList, pairList, hands } from './hands.js';
import { customList } from './handml.js';
import { fire } from './handctl.js';
import { editBind, appCmds, actionLabel, comboOf } from './handui.js';

const ed = A.ed;
ed.selEv = new Set(); ed.selBars = new Set(); ed.onlyAnim = false; ed.openGroups = new Set(['tr']);
const scene = () => studio.scene();
const clips = () => A.clipsOf(scene());
const clip = () => clips().find((c) => c.id === ed.clipId) || null;
const P = () => { const c = clip(); return c ? A.player(c) : null; };
const tNow = () => { const p = P(); return p ? p.t : 0; };
const selL = () => studio.selected();
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const dirty = { tl: true, list: true, side: true, vals: true, path: true, top: true };
const dirtyAll = () => { for (const k in dirty) dirty[k] = true; };
function commit() { studio.commit(); dirtyAll(); }
// open a layer's property rows by itself only while one layer is selected (with several it would just flood the list)
const autoExpand = (id) => { if (studio.selection().length <= 1) ed.expanded.add(id); };
const isNum = (key) => A.PROPS[key] && A.PROPS[key].type === 'num';
const GCOL = { tr: '#7c8cff', look: '#c79bff', text: '#ff8fb8', shape: '#ffb37a', fx: '#4fd1b5', crop: '#6fb8ff' };
const colOf = (key) => GCOL[(A.PROPS[key] || {}).group] || '#7c8cff';
function fmtT(t, c = clip()) {
  const fps = c ? c.fps : 30, f = Math.round(Math.max(0, t) * fps), sec = Math.floor(f / fps), fr = f - sec * fps;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}.${String(fr).padStart(2, '0')}`;
}
const runAction = (a) => { if (a) fire({ id: 'anim-ev', gesture: '', action: a }, 'start'); };
const liveEnv = { get scene() { return scene(); }, fire: runAction };

/* =================================================================== mode */
let built = false;
function enter() {
  if (ed.mode) return;
  if (!built) build();
  const s = scene(); A.clipsOf(s).forEach(A.fixClip);
  if (!clips().length) { clips().push(A.newClip(T`แอนิเมชัน 1`)); studio.commit(); }
  if (!clip()) ed.clipId = clips()[0].id;
  ed.mode = true;
  const p = P(); p.playing = false;
  hooks.begin = beginEdit; hooks.end = endEdit; hooks.rest = restOf;
  const L = selL(); if (L) autoExpand(L.id);
  placeTop();
  document.body.classList.add('anim-mode'); $('dock-anim').classList.add('active');
  document.body.style.setProperty('--tl-h', Math.min(ed.tlH, Math.round(innerHeight * 0.55)) + 'px');
  dirtyAll(); requestAnimationFrame(() => { sizeCanvas(); if (!ed.fitted) { fitZoom(); ed.fitted = true; } dirtyAll(); });
  loop();
}
function exit() {
  if (!ed.mode) return;
  const c = clip(); if (c) A.stop(c, A.player(c));
  ed.mode = false; ed.driveTest = false; hooks.begin = hooks.end = hooks.rest = null; edits.clear(); A.eng.suspended.clear();
  document.body.classList.remove('anim-mode'); $('dock-anim').classList.remove('active');
  closePop(); drawPath();
  const n = bakeStatic(scene());
  A.eng.sceneId = ''; // back to live: autoplay clips (and areas' own timelines) start again
  if (n) { studio.commit(); studio.refreshAll(); toast(T`เก็บตำแหน่งที่จัดไว้ของ ${n} เลเยอร์เป็นตำแหน่งปกติแล้ว`); }
}
// A row with one keyframe at 0 s is not motion, just "where it sits": make it the layer's own value, so a layout
// arranged in animation mode stays after leaving it (otherwise everything jumps back to where it was before).
function bakeStatic(sc) {
  const all = studio.allLayers(sc), byId = (id) => all.find((l) => l.id === id), done = new Set();
  for (const c of A.clipsOf(sc)) {
    if (c.drive && c.drive.src !== 'none') continue;
    for (const tr of [...c.tracks]) {
      if (tr.mute || tr.keys.length !== 1 || tr.keys[0].t > 1e-4) continue;
      const L = byId(tr.layer), p = A.PROPS[tr.prop]; if (!L || !p) continue;
      const v = c.mode === 'add' && p.type === 'num' ? A.getV(L, tr.prop) + tr.keys[0].v : tr.keys[0].v;
      if (typeof v === 'number' && !Number.isFinite(v)) continue;
      A.setV(L, tr.prop, v); c.tracks.splice(c.tracks.indexOf(tr), 1); done.add(L.id);
    }
  }
  return done.size;
}
function switchClip(id) {
  const c = clip(); if (c) A.stop(c, A.player(c));
  ed.clipId = id; ed.selKeys.clear(); ed.selEv.clear(); ed.selTracks.clear();
  const n = clip(); if (n) { A.fixClip(n); A.player(n).playing = false; }
  fitZoom(); dirtyAll();
}

// the toolbar goes right under the title bar (measured, so it never overlaps it)
function placeTop() { const b = $('titlebar').getBoundingClientRect(); document.body.style.setProperty('--at-top', Math.round(b.bottom + 10) + 'px'); }

/* ============================================================= playhead */
function setT(t, snap = ed.snap) {
  const c = clip(), p = P(); if (!c) return;
  t = clamp(t, 0, c.dur); if (snap) t = A.snapT(c, t);
  p.t = t; p.playing = false;
  dirty.tl = dirty.vals = dirty.path = dirty.top = true;
}
function togglePlay() {
  const c = clip(), p = P(); if (!c) return;
  if (p.playing) p.playing = false;
  else { if (p.t >= c.dur - 1e-4) p.t = 0; p.dir = 1; p.hold = false; p.playing = true; }
  dirty.top = true;
}
const step = (n) => { const c = clip(); if (c) setT(tNow() + n / c.fps, true); };
function keyTimes(c) { const L = selL(), trs = L ? c.tracks.filter((t) => t.layer === L.id) : c.tracks; const s = new Set(); for (const t of (trs.length ? trs : c.tracks)) for (const k of t.keys) s.add(k.t); return [...s].sort((a, b) => a - b); }
function jumpKey(dir) {
  const c = clip(); if (!c) return; const t = tNow(), ts = keyTimes(c);
  const n = dir > 0 ? ts.find((x) => x > t + 1e-4) : [...ts].reverse().find((x) => x < t - 1e-4);
  if (n !== undefined) setT(n, false);
}

/* ======================================================= stage → keyframes */
const edits = new Map(); // layer id → { base, start } while a stage edit is running
const restOf = (L) => { const e = edits.get(L.id); return e ? e.base : null; }; // an area being edited: its box before the edit (what is inside scales from there)
function beginEdit(L) {
  const c = clip(); if (!c || !ed.mode) return;
  const V = studio.AV(L), base = {}, start = {};
  for (const p of A.propsFor(L)) {
    if (p.type === 'bool') continue;
    base[p.key] = A.getV(L, p.key);
    const tr = A.findTrack(c, L.id, p.key);
    if (tr) A.setV(L, p.key, A.getV(V, p.key)); // stand the layer where the animation shows it
    start[p.key] = A.getV(L, p.key);
  }
  A.eng.suspended.add(L.id);
  edits.set(L.id, { base, start });
}
function endEdit(L) {
  A.eng.suspended.delete(L.id);
  const ed0 = edits.get(L.id); if (!ed0) return;
  edits.delete(L.id);
  const { base, start } = ed0;
  const c = clip(); if (!c) return;
  const t = tNow(); let keyed = 0;
  for (const key in start) {
    const v = A.getV(L, key), was = start[key];
    const diff = typeof v === 'number' ? Math.abs(v - was) > 1e-6 : v !== was;
    const tr0 = A.findTrack(c, L.id, key);
    if (diff && (tr0 || ed.autokey)) {
      const tr = tr0 || A.ensureTrack(c, L.id, key), add = c.mode === 'add' && isNum(key);
      if (!tr0 && t > 1e-4) A.setKey(c, tr, 0, add ? 0 : base[key]); // first key later in the clip: animate from where it was
      A.setKey(c, tr, t, add ? v - base[key] : v);
      A.setV(L, key, base[key]); keyed++;
    } else if (tr0) A.setV(L, key, base[key]);
  }
  if (keyed) { autoExpand(L.id); dirty.list = true; }
  dirtyAll();
}
// value shown for a property at the playhead (offset in an additive clip)
function dispV(c, L, key) {
  const tr = A.findTrack(c, L.id, key);
  if (tr && tr.keys.length) return A.evalTrack(tr, tNow()); // a row that was just created has no keys yet → the layer's own value
  return c.mode === 'add' && isNum(key) ? 0 : A.getV(L, key);
}
// typed values: 50 = set · +10 / -=10 = add / subtract · *1.5 / /2 = multiply / divide (per key or per layer)
function evalRel(str, cur) {
  const m = String(str).trim().replace(',', '.').match(/^(\+|-=|\*|\/|x)?\s*(-?\d*\.?\d+)$/i); if (!m) return null;
  const n = parseFloat(m[2]), op = (m[1] || '').toLowerCase();
  return op === '+' ? cur + n : op === '-=' ? cur - n : op === '*' || op === 'x' ? cur * n : op === '/' ? (n ? cur / n : cur) : n;
}
function setValue(c, L, key, v, live) {
  const p = A.PROPS[key]; if (!p) return;
  if (p.type === 'num') { if (p.min !== undefined && c.mode !== 'add') v = Math.max(p.min, v); if (p.max !== undefined && c.mode !== 'add') v = Math.min(p.max, v); }
  const tr0 = A.findTrack(c, L.id, key);
  if (tr0 || ed.autokey) {
    const tr = tr0 || A.ensureTrack(c, L.id, key), t = tNow();
    if (!tr0 && t > 1e-4) A.setKey(c, tr, 0, c.mode === 'add' && isNum(key) ? 0 : A.getV(L, key));
    A.setKey(c, tr, t, v);
    if (!tr0) { autoExpand(L.id); dirty.list = true; }
  } else A.setV(L, key, v);
  if (live) { dirty.tl = dirty.vals = dirty.path = true; } else commit();
}
function toggleKey(c, L, key) {
  const tr = A.findTrack(c, L.id, key), k = A.keyAt(c, tr, tNow());
  if (k) { ed.selKeys.delete(k); A.removeKey(c, tr, k); }
  else { const v = dispV(c, L, key); A.setKey(c, A.ensureTrack(c, L.id, key), tNow(), v); autoExpand(L.id); }
  commit();
}
function addKeyAll() {
  const c = clip(), L0 = selL(); if (!c) return;
  if (!L0) { toast(T`เลือกเลเยอร์ก่อน แล้วกด K เพื่อใส่คีย์เฟรม`); return; }
  // every selected layer gets its keys (not only the one the panels show)
  const many = studio.selection().filter((x) => x.type !== 'handfx' && x.type !== 'facepaint');
  for (const L of many.includes(L0) ? many : [L0, ...many]) {
    const trs = c.tracks.filter((t) => t.layer === L.id);
    const keys = trs.length ? trs.map((t) => t.prop) : ['x', 'y', 'sc', 'rot', 'op'].filter((k) => A.propsFor(L).some((p) => p.key === k));
    for (const key of keys) { const v = dispV(c, L, key); A.setKey(c, A.ensureTrack(c, L.id, key), tNow(), v); }
  }
  autoExpand(L0.id); commit();
}

/* =========================================================== key editing */
function trackOfKey(c, k) { for (const t of c.tracks) if (t.keys.includes(k)) return t; return null; }
function selected(c) { const out = []; for (const t of c.tracks) for (const k of t.keys) if (ed.selKeys.has(k)) out.push({ k, tr: t }); return out; }
function pruneSel() {
  const c = clip(); if (!c) { ed.selKeys.clear(); ed.selEv.clear(); return; }
  const all = new Set(c.tracks.flatMap((t) => t.keys));
  for (const k of [...ed.selKeys]) if (!all.has(k)) ed.selKeys.delete(k);
  for (const e of [...ed.selEv]) if (!c.events.includes(e)) ed.selEv.delete(e);
  for (const id of [...ed.selTracks]) if (!c.tracks.some((t) => t.id === id)) ed.selTracks.delete(id);
  for (const id of [...ed.selBars]) if (!c.tracks.some((t) => t.layer === id)) ed.selBars.delete(id);
}
// a layer's bar on the timeline = the span of all its keys; selecting the bar selects those keys
const barKeys = (c, id) => c.tracks.filter((t) => t.layer === id).flatMap((t) => t.keys);
function barSpan(c, id) { const ks = barKeys(c, id); if (!ks.length) return null; let a = Infinity, b = -Infinity; for (const k of ks) { a = Math.min(a, k.t); b = Math.max(b, k.t); } return { a, b }; }
function selectBar(c, id, add) {
  if (!add) { ed.selBars = new Set(); ed.selKeys = new Set(); ed.selEv.clear(); }
  if (add && ed.selBars.has(id)) { ed.selBars.delete(id); for (const k of barKeys(c, id)) ed.selKeys.delete(k); }
  else { ed.selBars.add(id); for (const k of barKeys(c, id)) ed.selKeys.add(k); }
  syncStage();
}
// the layers whose bars are selected are also selected on the stage
let fromTL = false; // selection made in the timeline itself: don't re-expand rows under the mouse
function syncStage() { const ids = [...ed.selBars].filter((id) => studio.byId(id)); if (ids.length) { fromTL = true; studio.selectMany(ids); fromTL = false; } }
function deleteSel() {
  const c = clip(); if (!c) return; ed.selBars.clear();
  for (const { k, tr } of selected(c)) A.removeKey(c, tr, k);
  c.events = c.events.filter((e) => !ed.selEv.has(e));
  ed.selKeys.clear(); ed.selEv.clear(); commit();
}
function setEase(e, cp) {
  const c = clip(); if (!c) return;
  const ks = selected(c); if (!ks.length) { toast(T`เลือกคีย์เฟรมก่อน (คลิกที่คีย์บนไทม์ไลน์)`); return; }
  for (const { k } of ks) { k.e = e; if (e === 'bezier') k.cp = cp.slice(); else delete k.cp; }
  commit();
}
// clipboard = { keys: [...] } (keyframes or whole layer bars) | { clip } (a whole animation clip)
let clipboard = null;
function copyKeys(cut) {
  const c = clip(); if (!c) return; const ks = selected(c);
  if (!ks.length) { // nothing selected → the whole clip
    clipboard = { clip: JSON.parse(JSON.stringify(c)) };
    toast(T`คัดลอกคลิป “${c.name}” แล้ว — กด Ctrl+V เพื่อวางเป็นคลิปใหม่`);
    return;
  }
  const t0 = Math.min(...ks.map((x) => x.k.t));
  clipboard = { keys: ks.map(({ k, tr }) => ({ layer: tr.layer, prop: tr.prop, dt: k.t - t0, v: k.v, e: k.e, cp: k.cp ? k.cp.slice() : null })) };
  toast(cut ? T`ตัด ${ks.length} คีย์แล้ว` : T`คัดลอก ${ks.length} คีย์แล้ว`);
  if (cut) deleteSel();
}
function copyClip(c = clip()) { if (!c) return; clipboard = { clip: JSON.parse(JSON.stringify(c)) }; toast(T`คัดลอกคลิป “${c.name}” แล้ว — กด Ctrl+V เพื่อวางเป็นคลิปใหม่`); }
function pasteClip() {
  const src = clipboard && clipboard.clip; if (!src) return;
  const n = JSON.parse(JSON.stringify(src)); n.id = A.uid(); n.name = T`${src.name} (สำเนา)`; n.next = '';
  const have = (id) => !!studio.byId(id), layersIn = [...new Set(n.tracks.map((t) => t.layer))], targets = studio.selection();
  if (layersIn.length === 1 && !have(layersIn[0]) && targets.length) { // a one-layer clip from another scene: put it on the selected layer(s)
    n.tracks = targets.flatMap((L) => n.tracks.filter((t) => A.propsFor(L).some((p) => p.key === t.prop)).map((t) => ({ ...JSON.parse(JSON.stringify(t)), id: A.uid(), layer: L.id })));
  } else n.tracks = n.tracks.filter((t) => have(t.layer)).map((t) => ({ ...t, id: A.uid() }));
  A.fixClip(n); clips().push(n); switchClip(n.id); commit();
  toast(T`วางคลิป “${n.name}” แล้ว`);
}
function pasteKeys() {
  const c = clip(); if (!c || !clipboard) return;
  if (clipboard.clip) { pasteClip(); return; }
  const items = clipboard.keys, src = [...new Set(items.map((i) => i.layer))], picked = studio.selection();
  // one source layer → paste onto every selected layer; otherwise back onto the layers it came from
  const targetsOf = (it) => (src.length === 1 && picked.length ? picked : [studio.byId(it.layer)].filter(Boolean));
  ed.selKeys.clear(); ed.selBars.clear();
  for (const it of items) for (const target of targetsOf(it)) {
    if (!A.propsFor(target).some((p) => p.key === it.prop)) continue;
    const k = A.setKey(c, A.ensureTrack(c, target.id, it.prop), tNow() + it.dt, it.v, it.e);
    if (!k) continue;
    k.e = it.e; if (it.cp) k.cp = it.cp.slice(); else delete k.cp;
    ed.selKeys.add(k); autoExpand(target.id);
    if (k.t > c.dur) c.dur = A.snapT(c, k.t);
  }
  commit();
}
function selectAllKeys() { const c = clip(); if (!c) return; ed.selKeys = new Set(c.tracks.flatMap((t) => t.keys)); ed.selBars = new Set(c.tracks.map((t) => t.layer)); dirtyAll(); }
// value tools for selected keys, per property (X with X, Y with Y …)
function valueGroups(c) {
  const order = studio.tree().map((r) => r.L.id), by = new Map();
  for (const x of selected(c)) { if (!isNum(x.tr.prop)) continue; (by.get(x.tr.prop) || by.set(x.tr.prop, []).get(x.tr.prop)).push(x); }
  for (const list of by.values()) list.sort((a, b) => a.k.t - b.k.t || order.indexOf(a.tr.layer) - order.indexOf(b.tr.layer));
  return by;
}
function valueTool(kind) {
  const c = clip(); if (!c) return; const by = valueGroups(c);
  if (![...by.values()].some((l) => l.length > 1)) { toast(T`เลือกคีย์เฟรมที่เป็นตัวเลขอย่างน้อย 2 อัน`); return; }
  if (kind === 'ramp' && ![...by.values()].some((l) => l.length > 2)) { toast(T`ไล่เป็นขั้นต้องมีอย่างน้อย 3 คีย์ของคุณสมบัติเดียวกัน`); return; }
  for (const list of by.values()) {
    if (list.length < 2) continue;
    const vs = list.map((x) => x.k.v), n = list.length;
    if (kind === 'same') for (const x of list) x.k.v = vs[0];
    else if (kind === 'avg') { const m = vs.reduce((a, b) => a + b, 0) / n; for (const x of list) x.k.v = m; }
    else if (kind === 'ramp') list.forEach((x, i) => { x.k.v = vs[0] + (vs[n - 1] - vs[0]) * i / (n - 1); });
    else if (kind === 'flip') { const mid = (Math.min(...vs) + Math.max(...vs)) / 2; for (const x of list) x.k.v = 2 * mid - x.k.v; }
  }
  commit();
  toast({ same: T`ทุกคีย์เท่ากับคีย์แรกแล้ว`, avg: T`ทุกคีย์เท่ากับค่าเฉลี่ยแล้ว`, ramp: T`ไล่ค่าเป็นขั้นเท่าๆ กันแล้ว`, flip: T`สลับค่าขึ้น-ลงแล้ว` }[kind]);
}
const VALUE_TOOLS = () => [['same', 'magnet', T`ค่าเท่ากัน (ตามคีย์แรก)`], ['avg', 'fit', T`ค่าเท่ากัน (ค่าเฉลี่ย)`], ['ramp', 'stagger', T`ไล่ค่าเป็นขั้นเท่าๆ กัน`], ['flip', 'reverse', T`สลับค่าขึ้น-ลง`]];
function reverseSel() {
  const c = clip(); if (!c) return; const ks = selected(c); if (ks.length < 2) return;
  const mn = Math.min(...ks.map((x) => x.k.t)), mx = Math.max(...ks.map((x) => x.k.t));
  for (const { k } of ks) k.t = mn + mx - k.t;
  c.tracks.forEach(A.sortKeys); commit();
}
async function stretchSel() {
  const c = clip(); if (!c) return; const ks = selected(c); if (ks.length < 2) { toast(T`เลือกคีย์อย่างน้อย 2 อัน`); return; }
  const v = await promptBox(T`ยืด / หดเวลา (%)`, '150', T`ตกลง`); const f = parseFloat(v); if (!(f > 0)) return;
  const mn = Math.min(...ks.map((x) => x.k.t));
  for (const { k } of ks) k.t = A.snapT(c, mn + (k.t - mn) * f / 100);
  c.tracks.forEach(A.sortKeys);
  const mx = Math.max(...ks.map((x) => x.k.t)); if (mx > c.dur) c.dur = mx;
  commit();
}
async function staggerSel() {
  const c = clip(); if (!c) return; const ks = selected(c);
  const order = studio.tree().map((r) => r.L.id), groups = new Map();
  for (const x of ks) (groups.get(x.tr.layer) || groups.set(x.tr.layer, []).get(x.tr.layer)).push(x.k);
  if (groups.size < 2) { toast(T`เลือกคีย์ของเลเยอร์อย่างน้อย 2 เลเยอร์`); return; }
  const v = await promptBox(T`เหลื่อมเวลาแต่ละเลเยอร์ (วินาที)`, '0.1', T`ตกลง`); const s = parseFloat(v); if (!Number.isFinite(s)) return;
  [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b)).forEach((id, i) => { for (const k of groups.get(id)) k.t = Math.max(0, A.snapT(c, k.t + i * s)); });
  c.tracks.forEach(A.sortKeys);
  const mx = Math.max(...ks.map((x) => x.k.t)); if (mx > c.dur) c.dur = mx;
  commit();
}

/* =============================================================== presets */
function applyPreset(name, cat) {
  const c = clip(), L0 = selL();
  if (!c) return; if (!L0) { toast(T`เลือกเลเยอร์ก่อน แล้วเลือกพรีเซ็ต`); return; }
  const G = studio.selection().filter((x) => x.type !== 'handfx' && x.type !== 'facepaint');
  if (!G.length) { toast(T`เลเยอร์เอฟเฟกต์มือใช้ได้เฉพาะการแสดง / ซ่อน`, { kind: 'err' }); return; }
  // several layers: top of the list first, each one starting "stagger" seconds after the previous
  const order = studio.tree().map((r) => r.L.id); G.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  ed.selKeys.clear();
  let end = 0;
  G.forEach((L, i) => { end = Math.max(end, presetOn(c, L, name, cat, tNow() + i * (G.length > 1 ? ed.presetStagger || 0 : 0))); });
  if (end > c.dur) c.dur = Math.ceil(end * c.fps) / c.fps;
  commit();
  if (G.length > 1) toast(T`ใส่พรีเซ็ตให้ ${G.length} เลเยอร์แล้ว`);
  if (cat === 'loop' && c.loop === 'once') toast(T`พรีเซ็ตแบบวนลูปจะสวยที่สุดเมื่อคลิปเล่นวน`, { label: T`ตั้งเป็นวนลูป`, action: () => { c.loop = 'loop'; commit(); } });
}
function presetOn(c, L, name, cat, t0) {
  const V = studio.AV(L), d = cat === 'in' || cat === 'out' ? ed.presetDur : (A.PRESET_DUR[name] || 1);
  const K = A.presetKeys(name, V, (key) => A.getV(V, key), studio.out()); if (!K) return 0;
  const add = c.mode === 'add';
  for (const [key, list] of Object.entries(K)) {
    const p = A.PROPS[key]; if (!p || (p.when && !p.when(L))) continue;
    const tr = A.ensureTrack(c, L.id, key);
    tr.keys = tr.keys.filter((k) => k.t < t0 - 1e-4 || k.t > t0 + d + 1e-4);
    for (const [u, v, e] of list) {
      const val = add && p.type === 'num' ? v - A.getV(L, key) : v;
      const k = A.setKey(c, tr, t0 + u * d, val, e || 'linear'); if (!k) continue; k.e = e || ed.defEase; delete k.cp; ed.selKeys.add(k);
    }
  }
  autoExpand(L.id);
  return t0 + d;
}
function buildPresets(box, close) {
  const s = el('div', 'sl');
  s.innerHTML = `<span>${T`ความยาว เข้า/ออก`}</span><input type="range" min="0.1" max="3" step="0.05"><output></output>`;
  const r = s.querySelector('input'), o = s.querySelector('output');
  const show = () => { r.value = ed.presetDur; o.textContent = ed.presetDur.toFixed(2) + 's'; r.style.setProperty('--p', ((ed.presetDur - 0.1) / 2.9) * 100 + '%'); };
  r.oninput = () => { ed.presetDur = +r.value; show(); A.saveEd(); }; show();
  box.appendChild(s);
  const s2 = el('div', 'sl');
  s2.innerHTML = `<span>${T`เหลื่อมเวลาแต่ละเลเยอร์`}</span><input type="range" min="0" max="1" step="0.05"><output></output>`;
  const r2 = s2.querySelector('input'), o2 = s2.querySelector('output');
  const show2 = () => { const v = ed.presetStagger || 0; r2.value = v; o2.textContent = v ? v.toFixed(2) + 's' : T`พร้อมกัน`; r2.style.setProperty('--p', v * 100 + '%'); };
  r2.oninput = () => { ed.presetStagger = +r2.value; show2(); }; show2();
  box.appendChild(s2);
  for (const [cat, label, list] of A.PRESETS()) {
    box.appendChild(el('div', 'ap-cat', esc(label)));
    const g = el('div', 'chips ap-chips');
    for (const [id, name] of list) { const b = el('button', 'chip', `<span>${esc(name)}</span>`); b.onclick = () => { applyPreset(id, cat); if (close) close(); }; g.appendChild(b); }
    box.appendChild(g);
  }
  box.appendChild(el('div', 'panel-note', T`พรีเซ็ตเริ่มที่หัวเล่น และเริ่มจากค่าปัจจุบันของเลเยอร์ — แก้คีย์ต่อได้ทุกอัน · เลือกหลายเลเยอร์ = ใส่ให้ทุกอัน (เหลื่อมเวลาได้)`));
}

/* ================================================================= popover */
let popEl = null;
function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
function popover(anchor, fill) {
  closePop();
  const p = el('div', 'glass anim-pop'); popEl = p; document.body.appendChild(p);
  fill(p, closePop);
  const r = anchor.getBoundingClientRect(), pr = p.getBoundingClientRect();
  p.style.left = clamp(r.left, 8, innerWidth - pr.width - 8) + 'px';
  p.style.top = clamp(r.bottom + 8, 8, innerHeight - pr.height - 8) + 'px';
}
addEventListener('pointerdown', (e) => { if (popEl && !popEl.contains(e.target) && !e.target.closest('[data-a=presets]')) closePop(); }, true);

/* ===================================================================== UI */
let top, tl, side, ov, octx, tlBody, tlList, tlCw, tlCv, tctx;
function build() {
  built = true;
  top = el('div', 'glass anim-ui', `
    <button class="at-clip" data-a="clips" title="${T`เลือก / จัดการคลิปแอนิเมชัน`}">${icon('anim')}<b data-r="clip"></b>${icon('chev')}</button>
    <i class="at-sep"></i>
    <div class="at-tr">
      <button class="icon-btn" data-a="first" title="${T`ไปต้นคลิป (Home)`}">${icon('first')}</button>
      <button class="icon-btn" data-a="kprev" title="${T`คีย์เฟรมก่อนหน้า (J)`}">${icon('kprev')}</button>
      <button class="at-play" data-a="play" title="${T`เล่น / หยุด (Space)`}">${icon('play')}</button>
      <button class="icon-btn" data-a="knext" title="${T`คีย์เฟรมถัดไป (L)`}">${icon('knext')}</button>
      <button class="icon-btn" data-a="last" title="${T`ไปท้ายคลิป (End)`}">${icon('last')}</button>
      <button class="icon-btn" data-a="loop"></button>
    </div>
    <div class="at-time" title="${T`เวลาปัจจุบัน — พิมพ์วินาที (1.5) หรือเฟรม (f45)`}"><input data-r="time" spellcheck="false"><span>/</span><button data-a="dur" title="${T`ความยาวคลิป (คลิกเพื่อแก้)`}"></button></div>
    <i class="at-sep"></i>
    <button class="at-tog rec" data-a="autokey" title="${T`คีย์อัตโนมัติ — ลาก ย่อขยาย หมุนเลเยอร์บนเวที หรือแก้ค่าในแผงขวา แล้วเกิดคีย์เฟรมที่เวลานี้ทันที`}"><i></i><span>${T`คีย์อัตโนมัติ`}</span></button>
    <button class="at-tog" data-a="snap" title="${T`ดูดติดเฟรมและหัวเล่น`}">${icon('magnet')}</button>
    <button class="at-tog" data-a="path" title="${T`แสดงเส้นทางการเคลื่อนที่บนเวที`}">${icon('path')}</button>
    <button class="at-tog" data-a="onion" title="${T`เงาตำแหน่งที่คีย์ก่อนหน้า (ฟ้า) และถัดไป (ชมพู) ของเลเยอร์ที่เลือก`}">${icon('onion')}</button>
    <button class="pill-btn small" data-a="presets">${icon('sparkle')}<span>${T`พรีเซ็ต`}</span></button>
    <div class="tb-fill"></div>
    <span class="at-scene" data-r="scene"></span>
    <button class="pill-btn small primary" data-a="done" title="${T`ออกจากโหมดแอนิเมชัน`}">${icon('check')}<span>${T`เสร็จสิ้น`}</span></button>`);
  top.id = 'anim-top';
  tl = el('section', 'glass anim-ui', `
    <div class="tl-grip" title="${T`ลากเพื่อปรับความสูง`}"></div>
    <div class="tl-head">
      <div class="tabs tl-tabs"><button class="tab" data-v="dope">${icon('dope')}<span>${T`ไทม์ไลน์`}</span></button><button class="tab" data-v="graph">${icon('curve')}<span>${T`กราฟ`}</span></button></div>
      <i class="at-sep"></i>
      <button class="icon-btn" data-k="add" title="${T`ใส่คีย์เฟรมที่หัวเล่น (K)`}">${icon('keyadd')}</button>
      <button class="icon-btn" data-k="del" title="${T`ลบคีย์ที่เลือก (Delete)`}">${icon('trash')}</button>
      <button class="icon-btn" data-k="copy" title="${T`คัดลอกคีย์หรือแถบที่เลือก — ไม่ได้เลือกอะไร = คัดลอกทั้งคลิป (Ctrl+C)`}">${icon('copy')}</button>
      <button class="icon-btn" data-k="paste" title="${T`วางคีย์ที่หัวเล่น (Ctrl+V)`}">${icon('paste')}</button>
      <button class="icon-btn" data-k="reverse" title="${T`กลับลำดับเวลาของคีย์ที่เลือก`}">${icon('reverse')}</button>
      <button class="icon-btn" data-k="stretch" title="${T`ยืด / หดเวลาของคีย์ที่เลือก`}">${icon('stretch')}</button>
      <button class="icon-btn" data-k="stagger" title="${T`เหลื่อมเวลาระหว่างเลเยอร์`}">${icon('stagger')}</button>
      <i class="at-sep"></i>
      <div class="tl-ease" data-r="ease"></div>
      <div class="tb-fill"></div>
      <button class="icon-btn" data-k="zout" title="${T`ซูมออก (Ctrl+ล้อเมาส์)`}">${icon('minus')}</button>
      <button class="icon-btn" data-k="fit" title="${T`พอดีความยาวคลิป`}">${icon('fit')}</button>
      <button class="icon-btn" data-k="zin" title="${T`ซูมเข้า`}">${icon('plus')}</button>
    </div>
    <div class="tl-body"><div class="tl-list"></div><div class="tl-cw"><canvas></canvas></div></div>`);
  tl.id = 'anim-tl';
  const sw = el('aside'); sw.id = 'anim-side-wrap';
  side = el('div', 'glass', `<div class="insp-head"><div class="tabs">
      <button class="tab" data-tab="keys">${icon('key')}<span>${T`คีย์เฟรม`}</span></button>
      <button class="tab" data-tab="clip">${icon('anim')}<span>${T`คลิป`}</span></button>
      <button class="tab" data-tab="trig">${icon('bolt')}<span>${T`ทริกเกอร์`}</span></button></div></div><div class="as-body"></div>`);
  side.id = 'anim-side'; sw.appendChild(side);
  $('app').append(top, tl, sw);
  ov = el('canvas'); ov.id = 'anim-ov'; $('scene-box').insertBefore(ov, $('guides')); octx = ov.getContext('2d');
  tlBody = tl.querySelector('.tl-body'); tlList = tl.querySelector('.tl-list'); tlCw = tl.querySelector('.tl-cw'); tlCv = tlCw.querySelector('canvas'); tctx = tlCv.getContext('2d');

  /* toolbar */
  top.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a, c = clip();
    if (a === 'done') exit();
    else if (a === 'play') togglePlay();
    else if (a === 'first') setT(0);
    else if (a === 'last') setT(c ? c.dur : 0);
    else if (a === 'kprev') jumpKey(-1);
    else if (a === 'knext') jumpKey(1);
    else if (a === 'loop' && c) { c.loop = { once: 'loop', loop: 'pingpong', pingpong: 'once' }[c.loop] || 'once'; commit(); toast(loopName(c.loop)); }
    else if (a === 'autokey') { ed.autokey = !ed.autokey; A.saveEd(); dirty.top = true; }
    else if (a === 'snap') { ed.snap = !ed.snap; A.saveEd(); dirty.top = true; }
    else if (a === 'path') { ed.path = !ed.path; A.saveEd(); dirty.top = dirty.path = true; }
    else if (a === 'onion') { ed.onion = !ed.onion; A.saveEd(); dirty.top = dirty.path = true; }
    else if (a === 'presets') { if (popEl) closePop(); else popover(b, (p, close) => { p.appendChild(el('h4', 'ap-h', `${icon('sparkle')}<span>${T`พรีเซ็ตแอนิเมชัน`}</span>`)); buildPresets(p, close); }); }
    else if (a === 'clips') clipMenu(b);
    else if (a === 'dur' && c) editDur(c);
  });
  const ti = top.querySelector('[data-r=time]');
  ti.onkeydown = (e) => { if (e.key === 'Enter') { ti.blur(); } e.stopPropagation(); };
  ti.onchange = () => { const c = clip(); if (!c) return; const v = ti.value.trim().toLowerCase(); let t = v.startsWith('f') ? parseFloat(v.slice(1)) / c.fps : v.includes(':') ? v.split(':').reduce((a, x) => a * 60 + parseFloat(x || 0), 0) : parseFloat(v); if (Number.isFinite(t)) setT(t, false); dirty.top = true; };

  /* timeline header */
  tl.querySelector('.tl-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) { ed.view = b.dataset.v; dirtyAll(); } });
  tl.querySelector('.tl-head').addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'add') addKeyAll(); else if (k === 'del') deleteSel(); else if (k === 'copy') copyKeys(false); else if (k === 'paste') pasteKeys();
    else if (k === 'reverse') reverseSel(); else if (k === 'stretch') stretchSel(); else if (k === 'stagger') staggerSel();
    else if (k === 'fit') fitZoom(); else if (k === 'zin') zoomAt(1.35, TL.W / 2); else if (k === 'zout') zoomAt(1 / 1.35, TL.W / 2);
    dirty.tl = true;
  });
  const qe = tl.querySelector('[data-r=ease]');
  for (const [e, label] of [['linear', T`เส้นตรง`], ['sineInOut', T`นุ่มนวล`], ['cubicIn', 'In'], ['cubicOut', 'Out'], ['cubicInOut', 'In-Out'], ['backOut', 'Back'], ['bounceOut', 'Bounce'], ['elasticOut', 'Elastic'], ['spring', T`สปริง`], ['hold', T`ค้าง`]]) {
    const b = el('button', 'qe', `${miniCurve(e)}<span>${esc(label)}</span>`); b.title = T`ใช้การเคลื่อนไหวนี้กับคีย์ที่เลือก`; b.onclick = () => setEase(e); qe.appendChild(b);
  }
  /* resize grip */
  const grip = tl.querySelector('.tl-grip');
  grip.addEventListener('pointerdown', (e) => {
    grip.setPointerCapture(e.pointerId); document.body.classList.add('tl-resizing');
    const mv = (ev) => { ed.tlH = clamp(Math.round(innerHeight - ev.clientY - 14), 170, Math.round(innerHeight * 0.62)); document.body.style.setProperty('--tl-h', ed.tlH + 'px'); };
    const up = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); document.body.classList.remove('tl-resizing'); A.saveEd(); };
    grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up);
  });
  /* side tabs */
  side.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { ed.tab = b.dataset.tab; dirty.side = true; } });

  /* timeline list + canvas */
  tlBody.addEventListener('scroll', () => { dirty.tl = true; }, { passive: true });
  new ResizeObserver(() => { sizeCanvas(); dirty.tl = true; }).observe(tlBody);
  listEvents(); canvasEvents();
}
const loopName = (l) => ({ once: T`เล่นครั้งเดียว`, loop: T`วนลูป`, pingpong: T`ไป-กลับ` }[l] || l);
function clipMenu(anchor) {
  const r = anchor.getBoundingClientRect(), c = clip();
  ctxMenu(r.left, r.bottom + 6, [
    ...clips().map((x) => ({ icon: x.id === ed.clipId ? 'check' : x.area ? 'area' : 'anim', label: x.name + (x.area ? ' · ' + T`ของพื้นที่` : '') + (x.auto ? ' · ' + T`เล่นอัตโนมัติ` : ''), run: () => switchClip(x.id) })),
    '-',
    { icon: 'plus', label: T`คลิปใหม่`, run: () => { const n = A.newClip(T`แอนิเมชัน ${clips().length + 1}`); clips().push(n); switchClip(n.id); commit(); } },
    c && { icon: 'copy', label: T`ทำสำเนาคลิปนี้`, run: () => dupClip(c) },
    c && { icon: 'edit', label: T`เปลี่ยนชื่อ (F2)`, run: () => renameClip(c) },
    c && { icon: 'copy', label: T`คัดลอกคลิป`, run: () => copyClip(c) },
    clipboard && clipboard.clip && { icon: 'paste', label: T`วางคลิป “${clipboard.clip.name}”`, run: pasteClip },
    c && clips().length > 1 && { icon: 'trash', label: T`ลบคลิปนี้`, danger: true, run: () => deleteClip(c) },
  ], T`คลิปในซีน “${scene().name}”`);
}
function dupClip(c) { const n = JSON.parse(JSON.stringify(c)); n.id = A.uid(); n.name = c.name + ' 2'; n.tracks.forEach((t) => { t.id = A.uid(); }); clips().splice(clips().indexOf(c) + 1, 0, n); switchClip(n.id); commit(); }
async function renameClip(c) { const n = await promptBox(T`เปลี่ยนชื่อคลิป`, c.name, T`บันทึก`); if (n) { c.name = n.slice(0, 40); commit(); } }
async function deleteClip(c) {
  if (!(await confirmBox(T`ลบคลิป “${c.name}”?`, T`คีย์เฟรมทั้งหมดในคลิปนี้และท่ามือที่สั่งคลิปนี้จะถูกลบ`, T`ลบ`, true))) return;
  A.stop(c, A.player(c)); const i = clips().indexOf(c); clips().splice(i, 1);
  for (const x of clips()) if (x.next === c.id) x.next = '';
  const h = studio.hand(); h.binds = h.binds.filter((b) => !(b.action && String(b.action.cmd || '').endsWith(':' + c.id) && String(b.action.cmd).startsWith('anim:'))); studio.touch(); bus.emit('hand:cfg');
  ed.clipId = clips()[Math.max(0, i - 1)].id; switchClip(ed.clipId); commit();
}
async function editDur(c) {
  const v = await promptBox(T`ความยาวคลิป (วินาที)`, String(+c.dur.toFixed(3)), T`ตกลง`); const d = parseFloat(v);
  if (d > 0) { c.dur = Math.max(1 / c.fps, A.snapT(c, d)); setT(Math.min(tNow(), c.dur)); fitZoom(); commit(); }
}

/* --------------------------------------------------------- top bar sync */
function syncTop() {
  dirty.top = false;
  const c = clip(), p = P(); if (!c) return;
  top.querySelector('[data-r=clip]').textContent = c.name;
  top.querySelector('[data-r=scene]').textContent = T`ซีน: ${scene().name}`;
  const ti = top.querySelector('[data-r=time]'); if (document.activeElement !== ti) ti.value = fmtT(p.t, c);
  top.querySelector('[data-a=dur]').textContent = fmtT(c.dur, c);
  const pb = top.querySelector('[data-a=play]'), want = p.playing ? 'pause' : 'play';
  if (pb.dataset.ico !== want) { pb.dataset.ico = want; pb.innerHTML = icon(want); }
  pb.classList.toggle('on', p.playing);
  const lb = top.querySelector('[data-a=loop]'), li = { once: 'once', loop: 'loop', pingpong: 'pingpong' }[c.loop];
  if (lb.dataset.ico !== li) { lb.dataset.ico = li; lb.innerHTML = icon(li); }
  lb.title = T`รูปแบบการเล่น: ${loopName(c.loop)} (คลิกเพื่อเปลี่ยน)`;
  top.querySelector('[data-a=autokey]').classList.toggle('on', ed.autokey);
  top.querySelector('[data-a=snap]').classList.toggle('on', ed.snap);
  top.querySelector('[data-a=path]').classList.toggle('on', ed.path);
  top.querySelector('[data-a=onion]').classList.toggle('on', !!ed.onion);
  tl.querySelectorAll('.tl-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.v === ed.view));
}

/* ==================================================================== mini curves */
function miniCurve(e, cp, w = 30, h = 22) {
  const f = A.easeFn(e, cp), pts = [];
  for (let i = 0; i <= 24; i++) { const u = i / 24, v = e === 'hold' ? (u < 1 ? 0 : 1) : f(u); pts.push(`${(2 + u * (w - 4)).toFixed(1)},${(h - 3 - (v + 0.35) / 1.7 * (h - 6)).toFixed(1)}`); }
  if (e === 'hold') pts.splice(pts.length - 1, 0, `${(w - 2).toFixed(1)},${(h - 3 - 0.35 / 1.7 * (h - 6)).toFixed(1)}`);
  return `<svg class="mc" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/* ================================================================== inspector */
let sideUpd = [], ceDraw = null, meterUpd = null;
function sec(parent, ico, title, opt = {}) {
  const s = el('div', 'sec' + (opt.fold ? ' fold' : '') + (opt.open === false ? ' shut' : ''));
  s.innerHTML = `<h4>${icon(ico)}<span>${esc(title)}</span>${opt.extra || ''}${opt.fold ? `<i class="fold-i">${icon('chev')}</i>` : ''}</h4>`;
  if (opt.fold) s.querySelector('h4').onclick = (e) => { if (e.target.closest('input, button, label')) return; s.classList.toggle('shut'); opt.onFold && opt.onFold(!s.classList.contains('shut')); };
  parent.appendChild(s); return s;
}
const note = (parent, html) => { const n = el('div', 'panel-note', html); parent.appendChild(n); return n; };
function row(parent, label, html) { const d = el('div', 'rowf', `<span>${esc(label)}</span>${html}`); parent.appendChild(d); return d; }
function chips(parent, items, cls = 'chips') {
  const d = el('div', cls);
  for (const it of items) { if (!it) continue; const [label, run, on, ico] = it; const b = el('button', 'chip' + (on ? ' on' : ''), (ico ? icon(ico) : '') + `<span>${esc(label)}</span>`); b.onclick = () => run(b); d.appendChild(b); }
  parent.appendChild(d); return d;
}
function slider(parent, label, get, set, min, max, stepv, fmt = (v) => v, done = commit) {
  const d = el('div', 'sl', `<span>${esc(label)}</span><input type="range" min="${min}" max="${max}" step="${stepv}"><output></output>`);
  const inp = d.querySelector('input'), o = d.querySelector('output');
  const show = () => { const v = get(); inp.value = v; o.textContent = fmt(v); inp.style.setProperty('--p', ((v - min) / (max - min)) * 100 + '%'); };
  inp.oninput = () => { set(+inp.value); show(); }; inp.onchange = () => done();
  show(); parent.appendChild(d); return d;
}
function select(parent, label, value, opts, set) {
  const d = row(parent, label, `<label class="field"><select>${opts.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join('')}</select></label>`);
  const s = d.querySelector('select'); s.value = value; s.onchange = () => set(s.value); return d;
}

function renderSide() {
  dirty.side = false;
  const body = side.querySelector('.as-body'), keep = body.scrollTop;
  body.innerHTML = ''; sideUpd = []; ceDraw = null; meterUpd = null;
  side.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === ed.tab));
  const c = clip(); if (!c) return;
  if (ed.tab === 'keys') renderKeysTab(body, c);
  else if (ed.tab === 'clip') renderClipTab(body, c);
  else renderTrigTab(body, c);
  body.scrollTop = keep;
}

/* ---------------------------------------------------------------- keys tab */
function renderKeysTab(body, c) {
  renderSelKeys(body, c);
  const L = selL();
  if (!L) { const s = sec(body, 'layers', T`คุณสมบัติ`); note(s, T`เลือกเลเยอร์บนเวทีหรือในไทม์ไลน์ เพื่อดูและใส่คีย์เฟรมให้คุณสมบัติของมัน`); return; }
  const G = [L, ...studio.selection().filter((x) => x !== L && x.type !== 'handfx' && x.type !== 'facepaint')];
  const head = el('div', 'kp-head', `<span class="l-ico">${icon(G.length > 1 ? 'layers' : studio.TYPE_ICON[L.type])}</span><span class="l-name">${G.length > 1 ? T`${G.length} เลเยอร์ที่เลือก` : esc(L.name)}<small>${G.length > 1 ? esc(T`ค่า / คีย์ที่ใส่ตรงนี้ใช้กับทุกเลเยอร์ · ลากตัวเลข = ขยับทุกอันเท่ากัน · พิมพ์ +10 หรือ *2 ได้ · แสดงค่าของ “${L.name}”`) : esc(studio.typeLabel(L.type))}${c.mode === 'add' ? ' · ' + T`โหมดบวกเพิ่ม (ค่าคือระยะเปลี่ยน)` : ''}</small></span>`);
  body.appendChild(head);
  const props = A.propsFor(L).filter((p) => G.every((X) => A.propsFor(X).some((q) => q.key === p.key)));
  for (const [g, gl] of A.GROUPS()) {
    const list = props.filter((p) => p.group === g); if (!list.length) continue;
    const used = list.some((p) => A.findTrack(c, L.id, p.key));
    const s = sec(body, { tr: 'fit', look: 'frame', text: 'text', shape: 'shape', fx: 'sparkle', crop: 'crop' }[g], gl, { fold: true, open: used || ed.openGroups.has(g), onFold: (o) => { if (o) ed.openGroups.add(g); else ed.openGroups.delete(g); } });
    for (const p of list) propRow(s, c, L, p, G);
  }
  const ps = sec(body, 'sparkle', T`พรีเซ็ตแอนิเมชัน`, { fold: true, open: ed.openGroups.has('presets'), onFold: (o) => { if (o) ed.openGroups.add('presets'); else ed.openGroups.delete('presets'); } });
  buildPresets(ps);
}
function propRow(parent, c, L, p, G = [L]) {
  const r = el('div', 'kp');
  const ctl = p.type === 'color' ? '<input type="color">' : p.type === 'bool' ? '<input type="checkbox">' : '<input class="kp-num" type="text" spellcheck="false">';
  r.innerHTML = `<button class="kd" title="${T`ใส่ / เอาคีย์เฟรมออกที่เวลานี้`}"></button><span class="kp-l">${esc(p.label)}</span><span class="kp-c">${ctl}${p.unit && p.type === 'num' ? `<i>${esc(p.pct ? '%' : p.unit)}</i>` : p.pct ? '<i>%</i>' : ''}</span><button class="kp-nav" data-d="-1" title="${T`คีย์ก่อนหน้า`}">‹</button><button class="kp-nav" data-d="1" title="${T`คีย์ถัดไป`}">›</button>`;
  const kd = r.querySelector('.kd'), inp = r.querySelector('input');
  if (p.type === 'num') inp.dataset.scrub = p.pct ? +(p.step * 100).toFixed(4) : p.step;
  const toShow = (v) => (p.pct ? Math.round(v * 1000) / 10 : p.step < 1 ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10);
  const upd = () => {
    const tr = A.findTrack(c, L.id, p.key), k = A.keyAt(c, tr, tNow());
    const allK = G.length > 1 && G.every((X) => A.keyAt(c, A.findTrack(c, X.id, p.key), tNow()));
    kd.className = 'kd' + (k ? ' on' : tr ? ' tr' : '') + (G.length > 1 && k && !allK ? ' part' : '');
    r.classList.toggle('anim', !!tr);
    if (document.activeElement === inp) return;
    const v = dispV(c, L, p.key);
    if (p.type === 'color') inp.value = /^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff';
    else if (p.type === 'bool') inp.checked = v >= 0.5;
    else inp.value = toShow(v);
  };
  upd(); sideUpd.push(upd);
  kd.onclick = () => {
    if (G.length < 2) { toggleKey(c, L, p.key); return; }
    const t = tNow(), on = G.every((X) => A.keyAt(c, A.findTrack(c, X.id, p.key), t)); // all keyed → remove from all, else key the rest
    for (const X of G) { const tr = A.findTrack(c, X.id, p.key), k = A.keyAt(c, tr, t); if (on && k) { ed.selKeys.delete(k); A.removeKey(c, tr, k); } else if (!on && !k) { A.setKey(c, A.ensureTrack(c, X.id, p.key), t, dispV(c, X, p.key)); autoExpand(X.id); } }
    commit();
  };
  const setAll = (v, live) => { for (const X of G) setValue(c, X, p.key, v, true); if (!live) commit(); };
  r.querySelectorAll('.kp-nav').forEach((b) => { b.onclick = () => { const tr = A.findTrack(c, L.id, p.key); if (!tr) return; const t = tNow(), d = +b.dataset.d; const k = d > 0 ? tr.keys.find((x) => x.t > t + 1e-4) : [...tr.keys].reverse().find((x) => x.t < t - 1e-4); if (k) setT(k.t, false); }; });
  if (p.type === 'color') { inp.oninput = () => setAll(inp.value, true); inp.onchange = () => commit(); }
  else if (p.type === 'bool') inp.onchange = () => setAll(inp.checked ? 1 : 0, false);
  else {
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); };
    const k = p.pct ? 100 : 1;
    let base = null; // values of every layer when a drag starts: each one moves by the same amount
    inp.oninput = () => {
      if (!inp._scrub) return; const v = parseFloat(inp.value); if (!Number.isFinite(v)) return;
      if (!base) base = G.map((X) => dispV(c, X, p.key));
      const d = v / k - base[0]; G.forEach((X, i) => setValue(c, X, p.key, base[i] + d, true));
    };
    inp.onchange = () => {
      if (base) { base = null; commit(); return; }
      let ok = false;
      for (const X of G) { const cur = dispV(c, X, p.key), v = evalRel(inp.value, cur * k); if (v === null) continue; setValue(c, X, p.key, v / k, true); ok = true; }
      if (ok) commit(); else upd();
    };
  }
  parent.appendChild(r);
}
function renderSelKeys(body, c) {
  const ks = selected(c), evs = [...ed.selEv];
  const s = sec(body, 'key', ks.length ? T`คีย์ที่เลือก · ${ks.length}` : T`การเคลื่อนไหว (Easing)`);
  if (!ks.length) {
    note(s, T`คลิกคีย์บนไทม์ไลน์เพื่อเลือก · Shift+คลิก เลือกเพิ่ม · ลากพื้นที่ว่างเพื่อเลือกเป็นกรอบ · ดับเบิลคลิกแถวเพื่อเพิ่มคีย์ · Alt+ลาก = ทำสำเนา`).style.padding = '0 2px 8px';
    select(s, T`คีย์ใหม่ใช้`, ed.defEase, easeOptions(), (v) => { ed.defEase = v; A.saveEd(); });
    if (evs.length) note(s, T`เลือกเหตุการณ์ ${evs.length} รายการ — ดับเบิลคลิกเพื่อแก้ไข`);
    return;
  }
  const t0 = Math.min(...ks.map((x) => x.k.t));
  const tf = row(s, ks.length > 1 ? T`เวลา (เลื่อนทั้งกลุ่ม)` : T`เวลา`, `<label class="field"><input type="text" spellcheck="false"></label>`);
  const ti = tf.querySelector('input'); ti.value = fmtT(t0, c) + `  (${t0.toFixed(3)}s)`;
  ti.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') ti.blur(); };
  ti.onchange = () => { const v = ti.value.trim().toLowerCase(); const t = v.startsWith('f') ? parseFloat(v.slice(1)) / c.fps : parseFloat(v.replace(/.*\(/, '')); if (!Number.isFinite(t)) return; const d = Math.max(0, t) - t0; for (const { k } of ks) k.t = Math.max(0, A.snapT(c, k.t + d)); c.tracks.forEach(A.sortKeys); commit(); };
  if (ks.length > 1) multiKeys(s, c, ks);
  if (ks.length === 1 && A.PROPS[ks[0].tr.prop]) {
    const { k, tr } = ks[0], p = A.PROPS[tr.prop];
    if (p.type === 'num') {
      const vf = row(s, p.label, `<label class="field"><input type="text" spellcheck="false"></label>`), vi = vf.querySelector('input');
      vi.value = p.pct ? Math.round(k.v * 1000) / 10 : Math.round(k.v * 100) / 100; vi.dataset.scrub = p.pct ? +(p.step * 100).toFixed(4) : p.step;
      vi.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') vi.blur(); };
      vi.oninput = () => { if (!vi._scrub) return; let v = parseFloat(vi.value); if (!Number.isFinite(v)) return; if (p.pct) v /= 100; k.v = v; dirty.tl = dirty.vals = dirty.path = true; };
      vi.onchange = () => { let v = parseFloat(vi.value); if (!Number.isFinite(v)) return; if (p.pct) v /= 100; k.v = v; commit(); };
    } else if (p.type === 'color') { const cf = row(s, p.label, '<input type="color">'), ci = cf.querySelector('input'); ci.value = k.v; ci.oninput = () => { k.v = ci.value; dirty.tl = true; }; ci.onchange = commit; }
  }
  const first = ks[0].k, last = ks.every(({ k, tr }) => tr.keys[tr.keys.length - 1] === k);
  if (last) note(s, T`คีย์สุดท้ายของแถว — การเคลื่อนไหวใช้กับช่วงที่ออกจากคีย์ จึงไม่มีผลกับคีย์นี้`).style.padding = '2px 2px 6px';
  curveEditor(s, ks, first);
  const cur = first.e;
  s.appendChild(el('div', 'eg-cap', `${esc(T`การเคลื่อนไหวตอนนี้:`)} <b>${esc(A.easeLabel(cur))}</b>`));
  const g = el('div', 'eg');
  for (const e of ['linear', 'ease', 'spring', 'hold']) { const b = el('button', 'eg-b' + (cur === e ? ' on' : ''), miniCurve(e) + `<small>${esc(A.easeLabel(e))}</small>`); b.onclick = () => setEase(e); g.appendChild(b); }
  s.appendChild(g);
  const t = el('div', 'eg-t');
  t.innerHTML = `<span></span><b>In</b><b>Out</b><b>In-Out</b>`;
  for (const [f, name] of A.EASE_FAMILIES()) {
    t.appendChild(el('span', 'eg-f', esc(name)));
    for (const d of ['In', 'Out', 'InOut']) { const e = f + d, b = el('button', 'eg-b' + (cur === e ? ' on' : ''), miniCurve(e)); b.title = A.easeLabel(e); b.onclick = () => setEase(e); t.appendChild(b); }
  }
  s.appendChild(t);
  chips(s, [[T`ตั้งเป็นค่าเริ่มต้นของคีย์ใหม่`, () => { ed.defEase = cur === 'bezier' ? 'sineInOut' : cur; A.saveEd(); toast(T`คีย์ใหม่จะใช้ “${A.easeLabel(ed.defEase)}”`); }]]).style.marginTop = '8px';
}
// edit many keyframes at once: one row per property (all its selected keys), plus timing tools
function multiKeys(s, c, ks) {
  const byProp = new Map();
  for (const x of ks) { const p = A.PROPS[x.tr.prop]; if (p) (byProp.get(p.key) || byProp.set(p.key, []).get(p.key)).push(x); }
  const nLayers = new Set(ks.map((x) => x.tr.layer)).size;
  note(s, T`${ks.length} คีย์ · ${byProp.size} คุณสมบัติ · ${nLayers} เลเยอร์ — ค่า เวลา และการเคลื่อนไหวที่ปรับตรงนี้ใช้กับทุกคีย์ที่เลือก`).style.padding = '0 2px 6px';
  for (const [key, list] of byProp) {
    const p = A.PROPS[key], label = `${p.label} ×${list.length}`;
    if (p.type === 'num') {
      const k = p.pct ? 100 : 1, vals = list.map((x) => x.k.v), lo = Math.min(...vals), hi = Math.max(...vals), same = hi - lo < 1e-6;
      const show = (v) => Math.round(v * k * 100) / 100;
      const f = row(s, label, `<label class="field mk"><input type="text" spellcheck="false"><i>${same ? '' : esc(T`${show(lo)} ถึง ${show(hi)}`)}</i></label>`), inp = f.querySelector('input');
      inp.value = show(vals[0]); inp.dataset.scrub = p.pct ? +(p.step * 100).toFixed(4) : p.step;
      inp.title = T`พิมพ์ 50 = ทุกคีย์เป็น 50 · +10 / -=10 = บวก / ลบทุกคีย์ · *1.5 = คูณ · ลากซ้ายขวา = ขยับทุกคีย์เท่ากัน`;
      inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); };
      const v0 = vals[0];
      inp.oninput = () => { if (!inp._scrub) return; const v = parseFloat(inp.value); if (!Number.isFinite(v)) return; const d = v / k - v0; list.forEach((x, i) => { x.k.v = vals[i] + d; }); dirty.tl = dirty.vals = dirty.path = true; };
      inp.onchange = () => {
        if (inp._scrub) { commit(); return; }
        let ok = false; list.forEach((x, i) => { const v = evalRel(inp.value, vals[i] * k); if (v !== null) { x.k.v = v / k; ok = true; } });
        if (ok) commit(); else inp.value = show(v0);
      };
    } else if (p.type === 'color') {
      const f = row(s, label, '<input type="color">'), ci = f.querySelector('input'); ci.value = /^#[0-9a-f]{6}$/i.test(list[0].k.v) ? list[0].k.v : '#ffffff';
      ci.oninput = () => { for (const x of list) x.k.v = ci.value; dirty.tl = true; }; ci.onchange = commit;
    } else if (p.type === 'bool') {
      chips(s, [[`${p.label}: ${T`แสดงทั้งหมด`}`, () => { for (const x of list) x.k.v = 1; commit(); }], [`${p.label}: ${T`ซ่อนทั้งหมด`}`, () => { for (const x of list) x.k.v = 0; commit(); }]]);
    }
  }
  const times = [...new Set(ks.map((x) => x.k.t))].sort((a, b) => a - b);
  const fin = () => { c.tracks.forEach(A.sortKeys); dedupe(c); const mx = Math.max(0, ...ks.map((x) => x.k.t)); if (mx > c.dur) c.dur = A.snapT(c, mx); commit(); };
  const tools = el('div', 'chips mk-tools');
  for (const [label, ico, run, tip] of [
    [T`ย้ายมาที่หัวเล่น`, 'first', () => { const d = tNow() - times[0]; for (const x of ks) x.k.t = Math.max(0, A.snapT(c, x.k.t + d)); fin(); }, T`เลื่อนทั้งกลุ่มให้คีย์แรกอยู่ที่หัวเล่น`],
    [T`ให้ตรงเวลาเดียวกัน`, 'magnet', () => { for (const x of ks) x.k.t = times[0]; fin(); }, T`ทุกคีย์ไปอยู่ที่เวลาของคีย์แรก (คีย์ซ้ำในแถวเดียวกันจะเหลืออันเดียว)`],
    [T`เว้นระยะเท่ากัน`, 'stagger', () => { if (times.length < 3) { toast(T`ต้องมีคีย์อย่างน้อย 3 จังหวะเวลา`); return; } const a = times[0], b = times[times.length - 1], m = new Map(times.map((t, i) => [t, a + (b - a) * i / (times.length - 1)])); for (const x of ks) x.k.t = A.snapT(c, m.get(x.k.t)); fin(); }, T`จังหวะของคีย์ห่างเท่ากันระหว่างคีย์แรกกับคีย์สุดท้าย`],
    [T`กลับลำดับ`, 'reverse', () => reverseSel(), T`สลับลำดับเวลาของคีย์ที่เลือก`],
    [T`ยืด / หด`, 'stretch', () => stretchSel(), T`ยืดหรือหดช่วงเวลาเป็นเปอร์เซ็นต์`],
    [T`เหลื่อมตามเลเยอร์`, 'stagger', () => staggerSel(), T`แต่ละเลเยอร์เริ่มช้ากว่ากันทีละนิด`],
    [T`คัดลอก`, 'copy', () => copyKeys(false), 'Ctrl+C'],
    [T`ลบ`, 'trash', () => deleteSel(), 'Delete'],
  ]) { const b = el('button', 'chip', `${icon(ico)}<span>${esc(label)}</span>`); b.title = tip; b.onclick = run; tools.appendChild(b); }
  s.appendChild(tools);
  const vt = el('div', 'chips mk-tools');
  for (const [k, ico, label] of VALUE_TOOLS()) { const b = el('button', 'chip', `${icon(ico)}<span>${esc(label)}</span>`); b.onclick = () => valueTool(k); vt.appendChild(b); }
  s.appendChild(el('div', 'eg-cap', esc(T`ปรับค่าของคีย์ที่เลือก (แยกตามคุณสมบัติ)`))); s.appendChild(vt);
}
const easeOptions = () => [['linear', A.easeLabel('linear')], ['ease', A.easeLabel('ease')], ['spring', A.easeLabel('spring')], ['hold', A.easeLabel('hold')],
  ...A.EASE_FAMILIES().flatMap(([f, n]) => ['In', 'Out', 'InOut'].map((d) => [f + d, `${n} ${d === 'InOut' ? 'In-Out' : d}`]))];

// cubic-bezier curve editor with draggable handles and a ball that rides the curve
function curveEditor(parent, ks, k) {
  const wrap = el('div', 'ce'), cv = el('canvas'); wrap.appendChild(cv);
  const nums = el('div', 'ce-nums'); wrap.appendChild(nums); parent.appendChild(wrap);
  const g = cv.getContext('2d');
  const editable = A.isEditableEase(k.e) || k.e === 'linear';
  let cp = (k.e === 'linear' ? [1 / 3, 1 / 3, 2 / 3, 2 / 3] : A.cpOf(k)) || [0.25, 0.1, 0.25, 1];
  nums.innerHTML = ['x1', 'y1', 'x2', 'y2'].map((n, i) => `<label class="field"><b>${n}</b><input type="text" data-i="${i}" data-scrub="0.01" spellcheck="false"></label>`).join('');
  const showNums = () => nums.querySelectorAll('input').forEach((x) => { if (document.activeElement !== x && !x._scrub) x.value = (+cp[+x.dataset.i].toFixed(3)); });
  nums.querySelectorAll('input').forEach((x) => { x.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') x.blur(); }; const take = () => { const v = parseFloat(x.value); if (!Number.isFinite(v)) return false; const i = +x.dataset.i; cp[i] = i % 2 === 0 ? clamp(v, 0, 1) : clamp(v, -1.5, 2.5); return true; }; x.oninput = () => { if (x._scrub && take()) apply(false); }; x.onchange = () => { if (take()) apply(true); }; });
  let W = 0, H = 0, dpr = 1, drag = -1, t0 = performance.now();
  const pad = 16, map = (u, v) => [pad + u * (W - pad * 2), pad + (1.45 - v) / 1.9 * (H - pad * 2)];
  const unmap = (x, y) => [clamp((x - pad) / (W - pad * 2), 0, 1), clamp(1.45 - (y - pad) / (H - pad * 2) * 1.9, -1.5, 2.5)];
  const apply = (done) => { for (const { k: x } of ks) { x.e = 'bezier'; x.cp = cp.slice(); } dirty.tl = true; showNums(); draw(); if (done) commit(); };
  function draw() {
    const w = cv.clientWidth | 0; if (!w) return;
    if (w !== W) { W = w; H = Math.round(w * 0.6); dpr = devicePixelRatio || 1; cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px'; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const dk = theme.dark, ink = dk ? '236,240,255' : '35,42,71';
    const [x0, y0] = map(0, 0), [x1, y1] = map(1, 1);
    g.fillStyle = `rgba(${ink},.04)`; g.fillRect(x0, y1, x1 - x0, y0 - y1);
    g.strokeStyle = `rgba(${ink},.12)`; g.lineWidth = 1; g.setLineDash([3, 4]); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); g.setLineDash([]);
    g.strokeRect(x0 + 0.5, y1 + 0.5, x1 - x0, y0 - y1);
    const f = editable && (k.e === 'bezier' || A.isEditableEase(k.e) || k.e === 'linear') ? A.bezier(cp[0], cp[1], cp[2], cp[3]) : A.easeFn(k.e, k.cp);
    const grd = g.createLinearGradient(x0, 0, x1, 0); grd.addColorStop(0, '#8ea2ff'); grd.addColorStop(0.5, '#c79bff'); grd.addColorStop(1, '#ff9ec7');
    g.strokeStyle = grd; g.lineWidth = 3; g.lineCap = 'round'; g.beginPath();
    for (let i = 0; i <= 80; i++) { const u = i / 80, v = k.e === 'hold' && !editable ? (u < 1 ? 0 : 1) : f(u), [x, y] = map(u, v); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
    if (editable) {
      const [hx1, hy1] = map(cp[0], cp[1]), [hx2, hy2] = map(cp[2], cp[3]);
      g.strokeStyle = `rgba(${ink},.45)`; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x0, y0); g.lineTo(hx1, hy1); g.moveTo(x1, y1); g.lineTo(hx2, hy2); g.stroke();
      for (const [x, y, c2] of [[hx1, hy1, '#7c8cff'], [hx2, hy2, '#ff9ec7']]) { g.beginPath(); g.arc(x, y, 6.5, 0, 6.283); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = c2; g.stroke(); }
    } else { g.fillStyle = `rgba(${ink},.55)`; g.font = '11px "IBM Plex Sans Thai", sans-serif'; g.textAlign = 'center'; g.fillText(T`ลากในกราฟเพื่อเปลี่ยนเป็นเส้นโค้งกำหนดเอง`, W / 2, H - 4); }
    // preview: a ball that moves with this timing
    const ph = ((performance.now() - t0) % 1700) / 1300, u = Math.min(1, ph), v = k.e === 'hold' && !editable ? (u < 1 ? 0 : 1) : f(u);
    const bx = x0 + clamp(v, -0.3, 1.3) * (x1 - x0);
    g.fillStyle = `rgba(${ink},.08)`; g.fillRect(x0, H - 9, x1 - x0, 3);
    g.beginPath(); g.arc(bx, H - 7.5, 5, 0, 6.283); g.fillStyle = '#7c8cff'; g.fill();
    const [mx, my] = map(u, v); g.beginPath(); g.arc(mx, my, 3.5, 0, 6.283); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#7c8cff'; g.lineWidth = 2; g.stroke();
  }
  cv.onpointerdown = (e) => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const [hx1, hy1] = map(cp[0], cp[1]), [hx2, hy2] = map(cp[2], cp[3]);
    const d1 = Math.hypot(x - hx1, y - hy1), d2 = Math.hypot(x - hx2, y - hy2);
    drag = !editable ? (x < W / 2 ? 0 : 1) : d1 < 16 && d1 <= d2 ? 0 : d2 < 16 ? 1 : (x < W / 2 ? 0 : 1);
    cv.setPointerCapture(e.pointerId); move(e);
  };
  const move = (e) => { if (drag < 0) return; const r = cv.getBoundingClientRect(), [u, v] = unmap(e.clientX - r.left, e.clientY - r.top); cp[drag * 2] = +u.toFixed(3); cp[drag * 2 + 1] = +v.toFixed(3); if (!editable) { k.e = 'bezier'; } apply(false); };
  cv.onpointermove = move;
  cv.onpointerup = () => { if (drag >= 0) { drag = -1; commit(); } };
  showNums(); ceDraw = draw; requestAnimationFrame(draw);
}

/* ---------------------------------------------------------------- clip tab */
let stretchKeys = false;
function renderClipTab(body, c) {
  const s = sec(body, 'anim', T`คลิปนี้`);
  const nf = row(s, T`ชื่อ`, `<label class="field"><input type="text" spellcheck="false"></label>`), ni = nf.querySelector('input');
  ni.value = c.name; ni.onkeydown = (e) => e.stopPropagation(); ni.onchange = () => { c.name = ni.value.trim().slice(0, 40) || c.name; commit(); };
  const df = row(s, T`ความยาว`, `<label class="field"><input type="number" min="0.05" step="0.1"><b>s</b></label>`), di = df.querySelector('input');
  di.value = +c.dur.toFixed(3); di.onkeydown = (e) => e.stopPropagation();
  di.onchange = () => { const d = Math.max(1 / c.fps, parseFloat(di.value) || c.dur); if (stretchKeys) { const f = d / c.dur; for (const t of c.tracks) for (const k of t.keys) k.t = A.snapT(c, k.t * f); for (const ev of c.events) ev.t *= f; } c.dur = A.snapT(c, d); setT(Math.min(tNow(), c.dur)); fitZoom(); commit(); };
  chips(s, [[T`ยืดเวลาคีย์ตามความยาวใหม่`, () => { stretchKeys = !stretchKeys; dirty.side = true; }, stretchKeys]]).style.margin = '2px 0 6px';
  select(s, T`เฟรมต่อวินาที`, String(c.fps), [['24', '24 fps'], ['25', '25 fps'], ['30', '30 fps'], ['50', '50 fps'], ['60', '60 fps']], (v) => { c.fps = +v; commit(); });
  slider(s, T`ความเร็ว`, () => c.speed, (v) => { c.speed = v; }, 0.1, 4, 0.05, (v) => v.toFixed(2) + '×');

  const pl = sec(body, 'loop', T`การเล่น`);
  chips(pl, [[T`ครั้งเดียว`, () => { c.loop = 'once'; commit(); }, c.loop === 'once', 'once'], [T`วนลูป`, () => { c.loop = 'loop'; commit(); }, c.loop === 'loop', 'loop'], [T`ไป-กลับ`, () => { c.loop = 'pingpong'; commit(); }, c.loop === 'pingpong', 'pingpong']], 'chips grid3');
  row(pl, T`เมื่อเล่นจบ`, '');
  chips(pl, [[T`ค้างที่เฟรมสุดท้าย`, () => { c.end = 'hold'; commit(); }, c.end === 'hold'], [T`กลับสู่ค่าเดิม`, () => { c.end = 'reset'; commit(); }, c.end === 'reset']]);
  const mo = sec(body, 'layers', T`วิธีใช้ค่า`);
  chips(mo, [[T`กำหนดค่าตรงๆ`, () => { setMode(c, 'abs'); }, c.mode === 'abs'], [T`บวกเพิ่มจากค่าเดิม`, () => { setMode(c, 'add'); }, c.mode === 'add']]);
  note(mo, c.mode === 'add' ? T`ค่าในคลิปนี้คือ “ระยะที่เปลี่ยน” บวกเข้ากับตำแหน่งปัจจุบันของเลเยอร์ — เหมาะกับท่าสั่น เด้ง ลอย ที่ใช้ซ้ำได้ไม่ว่าเลเยอร์จะอยู่ตรงไหน หรือเล่นซ้อนกับคลิปอื่น` : T`ค่าในคลิปคือค่าจริงของเลเยอร์ ณ เวลานั้น (เหมือนโปรแกรมตัดต่อทั่วไป) — ถ้าหลายคลิปคุมค่าเดียวกัน คลิปที่อยู่ล่างในรายการชนะ`);
  const st = sec(body, 'chart', T`สรุป`);
  const nk = c.tracks.reduce((a, t) => a + t.keys.length, 0), nl = new Set(c.tracks.map((t) => t.layer)).size;
  note(st, T`${nl} เลเยอร์ · ${c.tracks.length} คุณสมบัติ · ${nk} คีย์เฟรม · ${c.events.length} เหตุการณ์`).style.padding = '0 2px 8px';
  chips(st, [
    [T`ทำสำเนาคลิป`, () => dupClip(c), false, 'copy'], [T`เปลี่ยนชื่อ`, () => renameClip(c), false, 'edit'],
    [T`ล้างคีย์ทั้งหมด`, async () => { if (await confirmBox(T`ล้างคีย์ทั้งหมด?`, T`คีย์เฟรมทุกอันในคลิป “${c.name}” จะถูกลบ (ย้อนกลับได้ด้วย Ctrl+Z)`, T`ล้าง`, true)) { c.tracks = []; ed.selKeys.clear(); commit(); } }, false, 'trash'],
    clips().length > 1 && [T`ลบคลิป`, () => deleteClip(c), false, 'trash'],
  ]);
}
function setMode(c, m) {
  if (c.mode === m) return;
  // keep what is on screen: convert every numeric key between absolute values and offsets from the layer's base value
  for (const tr of c.tracks) { const L = studio.byId(tr.layer); if (!L || !isNum(tr.prop)) continue; const b = A.getV(L, tr.prop); for (const k of tr.keys) k.v = m === 'add' ? k.v - b : k.v + b; }
  c.mode = m; commit();
}

/* ---------------------------------------------------------------- triggers */
const animBinds = (c) => studio.hand().binds.filter((b) => b.action && b.action.type === 'app' && String(b.action.cmd || '').startsWith('anim:') && b.action.cmd.endsWith(':' + c.id));
const verbName = (v) => (A.ANIM_VERBS().find((x) => x[0] === v) || ['', v])[1];
// every clip driven by the hand, with its pose: one pose per clip lets several animations run from different hand shapes
const srcName = (s) => (A.DRIVES().find((d) => d[0] === s) || ['', s])[1];
function handClipsOverview(parent, c) {
  const list = clips().filter((x) => x.drive && x.drive.src !== 'none');
  if (!list.length && c.drive.src === 'none') return;
  const box = el('div', 'hand-clips');
  box.appendChild(el('div', 'hc-cap', `${icon('hand')}<span>${esc(T`คลิปที่คุมด้วยมือ`)} · ${list.length}</span>`));
  const clash = (a, b) => a.drive.src === b.drive.src && (a.drive.gest || '') === (b.drive.gest || '') && (a.drive.side === 'any' || b.drive.side === 'any' || a.drive.side === b.drive.side);
  for (const x of list) {
    const D = x.drive, bad = list.some((y) => y !== x && clash(x, y));
    const r = el('div', 'hc-row' + (x === c ? ' on' : '') + (bad ? ' bad' : ''), `<b>${esc(x.name)}</b><small>${esc(srcName(D.src))} · ${esc(D.gest ? gestureName(D.gest) : T`ทุกท่า`)}${D.grab ? ' · ' + esc(T`จับแล้วลาก`) : ''}</small>${bad ? `<i title="${esc(T`ท่าและค่าซ้ำกับอีกคลิป — มือเดียวจะเลื่อนทั้งสองคลิปพร้อมกัน`)}">⚠</i>` : ''}`);
    if (x !== c) { r.onclick = () => switchClip(x.id); r.title = T`ไปที่คลิปนี้`; }
    box.appendChild(r);
  }
  if (list.some((x) => list.some((y) => y !== x && clash(x, y)))) box.appendChild(el('div', 'panel-note', esc(T`⚠ มีคลิปที่ใช้ท่าและค่าเดียวกัน — ตั้ง “ทำงานเฉพาะท่ามือ” ให้ต่างกัน เพื่อให้แต่ละท่าคุมคนละคลิป`)));
  const b = el('button', 'chip', `${icon('plus')}<span>${esc(T`คลิปใหม่ คุมด้วยท่าอื่น`)}</span>`);
  b.onclick = () => {
    const used = new Set(list.map((x) => x.drive.gest || '')), pick = ['fist', 'pinch', 'palm', 'peace', 'point', 'thumbup'].find((g) => !used.has(g)) || '';
    const n = A.newClip(T`แอนิเมชัน ${clips().length + 1}`); n.drive = { ...n.drive, src: c.drive.src !== 'none' ? c.drive.src : 'handx', side: c.drive.side || 'any', gest: pick, grab: true };
    clips().push(n); switchClip(n.id); ensureHands(); commit();
    toast(T`สร้างคลิปใหม่ที่คุมด้วยท่า “${gestureName(pick)}” แล้ว — ใส่คีย์เฟรมให้มันได้เลย`);
  };
  const w = el('div', 'chips'); w.style.marginTop = '6px'; w.appendChild(b); box.appendChild(w);
  parent.appendChild(box);
}
function ensureHands() { const h = studio.hand(); if (!h.on) { h.on = true; studio.applyHandCfg(); studio.touch(); bus.emit('hand:cfg'); toast(T`เปิดการจับมือแล้ว`); } }
function addBind(c, gesture, verb, hold) {
  const h = studio.hand();
  h.binds.push({ id: A.uid(), on: true, gesture, hand: 'any', hold, mode: verb === 'hold' ? 'hold' : 'once', every: 500, action: { type: 'app', cmd: `anim:${verb}:${c.id}` } });
  ensureHands(); studio.touch(); bus.emit('hand:cfg'); dirty.side = true;
}
function renderTrigTab(body, c) {
  const h = studio.hand();
  /* gestures */
  const g = sec(body, 'hand', T`ท่ามือ → เล่นคลิปนี้`);
  if (!h.on) { note(g, T`การจับมือยังปิดอยู่ — ท่ามือจะสั่งคลิปได้เมื่อเปิด`).style.padding = '0 2px 6px'; chips(g, [[T`เปิดการจับมือ`, () => { ensureHands(); dirty.side = true; }, false, 'hand']]).style.marginBottom = '6px'; }
  const list = animBinds(c);
  if (!list.length) note(g, T`ยังไม่มีท่ามือที่สั่งคลิปนี้ — ใช้ท่าทั้งหมดในระบบท่ามือของคุณได้ รวมถึงท่าที่อัดเอง ⭐`).style.padding = '0 2px 8px';
  for (const b of list) {
    const verb = b.action.cmd.split(':')[1];
    const r = el('div', 'bind' + (b.on ? '' : ' off'), `<span class="b-emo">${esc(gestureEmoji(b.gesture) || '❔')}</span><span class="b-main"><b>${esc(gestureName(b.gesture).replace(/^\S+\s/, ''))}</b><small>${esc(verbName(verb))}${b.hold ? ' · ' + T`ค้าง ${b.hold / 1000} s` : ''}</small></span><input type="checkbox"><button class="icon-btn" title="${T`ลบ`}">${icon('x')}</button>`);
    r.dataset.id = b.id;
    const cb = r.querySelector('input'); cb.checked = b.on; cb.onchange = () => { b.on = cb.checked; studio.touch(); r.classList.toggle('off', !b.on); };
    r.querySelector('button').onclick = (e) => { e.stopPropagation(); h.binds.splice(h.binds.indexOf(b), 1); studio.touch(); bus.emit('hand:cfg'); dirty.side = true; };
    r.onclick = (e) => { if (!e.target.closest('input, button')) editBind(b); };
    g.appendChild(r);
  }
  g.appendChild(el('div', 'ap-cat', esc(T`เพิ่มด่วน`)));
  chips(g, [
    [T`🖐️ แบมือค้าง = เล่นขณะค้าง`, () => addBind(c, 'palm', 'hold', 300)],
    [T`👍 ยกนิ้วโป้ง = เล่น`, () => addBind(c, 'thumbup', 'play', 600)],
    [T`✌️ ชูสองนิ้ว = เล่น/หยุด`, () => addBind(c, 'peace', 'toggle', 600)],
    [T`✊ กำมือ = หยุด`, () => addBind(c, 'fist', 'stop', 600)],
    [T`➡️ ปัดขวา = เล่น`, () => addBind(c, 'swipe-right', 'play', 0)],
    ...customList().slice(0, 4).map((p) => [`⭐ ${p.name} = ${T`เล่น`}`, () => addBind(c, 'c:' + p.id, 'play', 600)]),
  ]);
  chips(g, [[T`กำหนดเอง…`, () => { ensureHands(); editBind(null, { gesture: 'palm', hold: 300, mode: 'once', action: { type: 'app', cmd: `anim:play:${c.id}` } }); }, false, 'plus']]).style.marginTop = '6px';
  note(g, T`“เล่นขณะค้างท่า” = ทำท่าค้างไว้แอนิเมชันเดินหน้า เลิกทำท่าแล้วเล่นย้อนกลับ · ท่ามือเหล่านี้จะเห็นในแท็บมือด้วย`);

  /* hand-driven time */
  const D = c.drive;
  const dv = sec(body, 'radar', T`ควบคุมเวลาด้วยมือ (สด)`);
  select(dv, T`ใช้ค่าจาก`, D.src, A.DRIVES(), (v) => { D.src = v; if (v !== 'none' && !isFaceDrive(v)) ensureHands(); commit(); });
  if (D.src !== 'none') {
    if (D.src !== 'spread') select(dv, T`มือ`, D.side, [['any', T`มือไหนก็ได้`], ['right', T`มือขวา`], ['left', T`มือซ้าย`]], (v) => { D.side = v; commit(); });
    // only while the hand makes this pose (any other pose = "hand not seen")
    select(dv, T`ทำงานเฉพาะท่ามือ`, D.gest || '', [['', T`ทุกท่า`], ...gestureList().filter((g) => !g[0].startsWith('swipe')).map((g) => [g[0], g[1] + ' ' + g[2]]), ...customList().map((p) => ['c:' + p.id, '⭐ ' + p.name]), ...pairList().map((g) => [g, gestureName(g)]), ...faceExprList().map((g) => [g[0], g[1] + ' ' + g[2]])], (v) => { D.gest = v; commit(); });
    chips(dv, [
      [T`จับแล้วลาก (ไม่กระโดด)`, () => { D.grab = !D.grab; commit(); }, !!D.grab, 'hand'],
      [T`ตั้งเร็ว: กำมือแล้วเลื่อน`, () => { D.gest = 'fist'; D.grab = true; D.lost = 'hold'; commit(); }, false, 'bolt'],
      [T`ตั้งเร็ว: จีบนิ้วแล้วเลื่อน`, () => { D.gest = 'pinch'; D.grab = true; D.lost = 'hold'; commit(); }, false, 'bolt'],
    ]).style.margin = '4px 0 8px';
    if (D.gest || D.grab) note(dv, (D.gest ? T`เลื่อนเวลาเฉพาะตอนทำท่า “${gestureName(D.gest)}” — ปล่อยท่า = หยุดค้างไว้ตรงนั้น` : '') + (D.grab ? (D.gest ? ' · ' : '') + T`จับแล้วลาก = เวลาเริ่มขยับจากจุดที่อยู่ตอนเริ่มทำท่า ไม่กระโดดไปตามตำแหน่งมือ` : ''));
    slider(dv, T`ค่าต่ำสุด`, () => D.min, (v) => { D.min = Math.min(v, D.max - 1); }, 0, 100, 1, (v) => v + '%');
    slider(dv, T`ค่าสูงสุด`, () => D.max, (v) => { D.max = Math.max(v, D.min + 1); }, 0, 100, 1, (v) => v + '%');
    slider(dv, T`ความนุ่มนวล`, () => D.smooth, (v) => { D.smooth = v; }, 0, 100, 5, (v) => (v ? v + '%' : T`ทันที`));
    select(dv, T`เมื่อไม่เห็นมือ`, D.lost, [['hold', T`ค้างไว้ที่เดิม`], ['reset', T`ค่อยๆ กลับจุดเริ่ม`], ['hide', T`ไม่ใช้คลิปนี้`]], (v) => { D.lost = v; commit(); });
    const m = el('div', 'meter-row', `<div class="mt-bar"><i class="mt-r"></i><b class="mt-u"></b><s class="mt-lo"></s><s class="mt-hi"></s></div><span class="mt-t"></span>`); dv.appendChild(m);
    meterUpd = () => {
      const env = { hands: studio.hands, out: studio.out, pair: hands.pair ? hands.pair.g : '' };
      const r = A.driveRaw(D, env), u = r === null ? null : clamp(((r * 100 - D.min) / Math.max(1, D.max - D.min)), 0, 1);
      const seen = r !== null || (D.gest && A.driveRaw({ ...D, gest: '' }, env) !== null);
      m.querySelector('.mt-r').style.left = (r === null ? -10 : clamp(r, 0, 1) * 100) + '%';
      m.querySelector('.mt-u').style.width = (u === null ? 0 : (D.invert ? 1 - u : u) * 100) + '%';
      m.querySelector('.mt-lo').style.left = D.min + '%'; m.querySelector('.mt-hi').style.left = D.max + '%';
      m.querySelector('.mt-t').textContent = r === null ? (seen ? T`รอท่า ${gestureName(D.gest)}` : T`ไม่เห็นมือ`) : `${Math.round(r * 100)}% → ${fmtT((D.invert ? 1 - u : u) * c.dur, c)}`;
    };
    chips(dv, [
      [T`กลับทิศ`, () => { D.invert = !D.invert; commit(); }, D.invert],
      [T`ตั้งค่าต่ำสุดจากมือตอนนี้`, () => { const r = A.driveRaw({ ...D, gest: '' }, { hands: studio.hands, out: studio.out }); if (r === null) { toast(T`ยังไม่เห็นมือ`, { kind: 'err' }); return; } D.min = clamp(Math.round(r * 100), 0, D.max - 1); commit(); }],
      [T`ตั้งค่าสูงสุดจากมือตอนนี้`, () => { const r = A.driveRaw({ ...D, gest: '' }, { hands: studio.hands, out: studio.out }); if (r === null) { toast(T`ยังไม่เห็นมือ`, { kind: 'err' }); return; } D.max = clamp(Math.round(r * 100), D.min + 1, 100); commit(); }],
      [T`ลองในโหมดนี้`, () => { ed.driveTest = !ed.driveTest; dirty.side = true; }, ed.driveTest, 'play'],
    ]).style.marginTop = '6px';
    note(dv, T`เวลาของคลิปเลื่อนตามมือแบบสด เช่น ยกมือสูง = สติกเกอร์ใหญ่ขึ้น · ระหว่างนี้คลิปจะไม่เล่นเองตามเวลา`);
    handClipsOverview(dv, c);
  } else { note(dv, T`ให้ตำแหน่ง การจีบนิ้ว หรือระยะห่างของมือ เป็นตัวเลื่อนเวลาของแอนิเมชันแทนการเล่นตามเวลา`); handClipsOverview(dv, c); }

  /* hotkey */
  const hk = sec(body, 'keyboard', T`คีย์ลัด`);
  const hr = row(hk, T`คีย์`, `<label class="field"><input type="text" readonly placeholder="${T`ยังไม่ได้ตั้ง`}"></label><button class="pill-btn small" data-cap>${T`จับคีย์`}</button>${c.hot ? `<button class="icon-btn" data-clr title="${T`ล้าง`}">${icon('x')}</button>` : ''}`);
  const hi = hr.querySelector('input'), cap = hr.querySelector('[data-cap]'); hi.value = c.hot || '';
  cap.onclick = () => {
    cap.classList.add('primary'); cap.textContent = T`กดคีย์ที่ต้องการ…`;
    const on = (e) => { e.preventDefault(); e.stopPropagation(); if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return; removeEventListener('keydown', on, true); if (e.key !== 'Escape') { c.hot = comboOf(e); commit(); } else dirty.side = true; };
    addEventListener('keydown', on, true);
  };
  const clr = hr.querySelector('[data-clr]'); if (clr) clr.onclick = () => { c.hot = ''; commit(); };
  select(hk, T`ทำอะไร`, c.hotVerb, A.ANIM_VERBS(), (v) => { c.hotVerb = v; commit(); });
  note(hk, T`ทำงานเมื่อหน้าต่าง Prism Cam ถูกเลือกอยู่และไม่ได้อยู่ในโหมดแอนิเมชัน · “เล่นขณะค้าง” = กดค้างไว้`);

  /* automatic */
  const au = sec(body, 'clock', T`อัตโนมัติ`);
  chips(au, [[T`เล่นทันทีเมื่อเปิดซีนนี้`, () => { c.auto = !c.auto; commit(); }, c.auto, 'play']]);
  select(au, T`เมื่อจบให้เล่นต่อ`, c.next, [['', T`ไม่มี`], ...clips().filter((x) => x !== c).map((x) => [x.id, x.name])], (v) => { c.next = v; commit(); });
  const from = clips().filter((x) => x.next === c.id);
  if (from.length) note(au, T`คลิปนี้เล่นต่อจาก: ${from.map((x) => x.name).join(', ')}`);

  /* events */
  const ev = sec(body, 'bolt', T`เหตุการณ์บนไทม์ไลน์ (มาโคร)`);
  note(ev, T`สั่งงานเมื่อหัวเล่นวิ่งผ่านเวลาที่กำหนด — สลับซีน ถ่ายภาพ ซ่อน/แสดงเลเยอร์ เล่นคลิปอื่น กดคีย์ลัด หรือรันมาโคร`).style.padding = '0 2px 8px';
  for (const e of [...c.events].sort((a, b) => a.t - b.t)) {
    const r = el('div', 'bind' + (ed.selEv.has(e) ? ' sel' : ''), `<span class="b-emo">⚡</span><span class="b-main"><b>${esc(fmtT(e.t, c))}</b><small>${esc(actionLabel(e.action) || '—')}${e.action && e.action.type !== 'app' ? ' <i class="b-pc">PC</i>' : ''}</small></span><button class="icon-btn" data-go title="${T`ไปที่เวลานี้`}">${icon('locate')}</button><button class="icon-btn" data-rm title="${T`ลบ`}">${icon('x')}</button>`);
    r.querySelector('[data-go]').onclick = (x) => { x.stopPropagation(); setT(e.t, false); };
    r.querySelector('[data-rm]').onclick = (x) => { x.stopPropagation(); c.events.splice(c.events.indexOf(e), 1); commit(); };
    r.onclick = (x) => { if (!x.target.closest('button')) editEvent(c, e); };
    ev.appendChild(r);
  }
  chips(ev, [[T`เพิ่มเหตุการณ์ที่หัวเล่น`, () => editEvent(c, null), false, 'plus']]).style.marginTop = '6px';
}
function editEvent(c, orig) {
  const e = orig ? JSON.parse(JSON.stringify(orig)) : { id: A.uid(), t: tNow(), action: { type: 'app', cmd: 'snap' } };
  const opt = (list, v) => list.map(([val, n]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(n)}</option>`).join('');
  const types = [['app', T`คำสั่งใน Prism Cam`], ['key', T`กดคีย์ / คีย์ลัด`], ['macro', T`มาโคร (หลายขั้นตอน)`], ['text', T`พิมพ์ข้อความ`]];
  htmlBox(`<h3>${orig ? T`แก้ไขเหตุการณ์` : T`เพิ่มเหตุการณ์`}</h3>
    <div class="bind-form wide">
      <div class="rowf"><span>${T`เวลา (วินาที)`}</span><label class="field"><input type="number" step="0.01" min="0" data-f="t"></label></div>
      <div class="rowf"><span>${T`คำสั่ง`}</span><label class="field"><select data-f="type">${opt(types, e.action.type)}</select></label></div>
      <div data-params></div>
    </div>
    <div class="modal-btns"><button class="pill-btn" data-x>${T`ยกเลิก`}</button><button class="pill-btn" data-test>${T`ทดสอบ`}</button><button class="pill-btn primary" data-ok>${T`บันทึก`}</button></div>`,
  (m, close) => {
    const q = (s) => m.querySelector(s), params = q('[data-params]');
    q('[data-f=t]').value = +e.t.toFixed(3);
    const draw = () => {
      const a = e.action;
      if (a.type === 'app') { params.innerHTML = `<div class="rowf"><span>${T`ทำอะไร`}</span><label class="field"><select>${opt(appCmds().filter((x) => x[0] !== 'anim:play:' + c.id), a.cmd || 'snap')}</select></label></div>`; const s = params.querySelector('select'); a.cmd = s.value; s.onchange = () => { a.cmd = s.value; }; }
      else if (a.type === 'key') { params.innerHTML = `<div class="rowf"><span>${T`คีย์`}</span><label class="field"><input type="text" spellcheck="false" placeholder="ctrl+shift+m"></label></div>`; const i = params.querySelector('input'); i.value = a.keys || ''; i.oninput = () => { a.keys = i.value.trim().toLowerCase(); }; }
      else if (a.type === 'macro') { params.innerHTML = `<label class="field area"><textarea rows="5" spellcheck="false" placeholder="ctrl+c&#10;wait 200&#10;type ${T`สวัสดี`}"></textarea></label><div class="panel-note">${T`บรรทัดละหนึ่งขั้นตอน: คีย์ลัด (ctrl+c) · wait 300 · type ข้อความ · down shift / up shift · click left|right|double · scroll 3 · open โปรแกรม`}</div>`; const ta = params.querySelector('textarea'); ta.value = a.script || ''; ta.oninput = () => { a.script = ta.value; }; }
      else { params.innerHTML = `<label class="field area"><textarea rows="3" spellcheck="false"></textarea></label>`; const ta = params.querySelector('textarea'); ta.value = a.text || ''; ta.oninput = () => { a.text = ta.value; }; }
      if (a.type !== 'app') params.appendChild(el('div', 'panel-note', T`คำสั่งนี้สั่งงานเครื่อง จึงทำงานเฉพาะเมื่อเปิดสวิตช์ “ควบคุมเครื่องนี้”`));
      params.querySelectorAll('input, textarea').forEach((x) => x.addEventListener('keydown', (k) => k.stopPropagation()));
    };
    q('[data-f=type]').onchange = (x) => { e.action = { type: x.target.value }; draw(); };
    q('[data-x]').onclick = () => close(null);
    q('[data-test]').onclick = () => runAction(e.action);
    q('[data-ok]').onclick = () => { e.t = clamp(parseFloat(q('[data-f=t]').value) || 0, 0, c.dur); close(e); };
    draw();
  }).then((res) => {
    if (!res) return;
    const i = orig ? c.events.indexOf(orig) : -1;
    if (i >= 0) c.events[i] = res; else c.events.push(res);
    ed.selEv = new Set([res]); commit();
  });
}

/* ================================================================== timeline */
const TL = { RH: 26, RUL: 30, PAD: 16, rows: [], W: 0, H: 0, dpr: 1, drag: null, gr: null, valEls: [] };
const X = (t) => TL.PAD + (t - ed.scroll) * ed.zoom;
const TX = (x) => (x - TL.PAD) / ed.zoom + ed.scroll;
function sizeCanvas() {
  if (!tlBody) return;
  const w = tlCw.clientWidth, h = tlBody.clientHeight; if (!w || !h) return;
  TL.dpr = devicePixelRatio || 1; TL.W = w; TL.H = h;
  tlCw.style.height = h + 'px';
  tlCv.width = Math.round(w * TL.dpr); tlCv.height = Math.round(h * TL.dpr); tlCv.style.width = w + 'px'; tlCv.style.height = h + 'px';
}
function fitZoom() { const c = clip(); if (!c || !TL.W) return; ed.zoom = clamp((TL.W - TL.PAD * 2 - 24) / Math.max(0.2, c.dur), 8, 2400); ed.scroll = 0; dirty.tl = true; }
function zoomAt(f, x) { const t = TX(x); ed.zoom = clamp(ed.zoom * f, 8, 2400); ed.scroll = Math.max(0, t - (x - TL.PAD) / ed.zoom); dirty.tl = true; }
function buildRows() {
  const c = clip(); TL.rows = []; if (!c) return;
  TL.rows.push({ kind: 'ev' });
  const order = Object.keys(A.PROPS), S = selL();
  for (const { L, d } of studio.tree()) { // layers inside an animation area are listed under it, indented
    const trs = c.tracks.filter((t) => t.layer === L.id).sort((a, b) => order.indexOf(a.prop) - order.indexOf(b.prop));
    if (ed.onlyAnim && !trs.length && L !== S) continue;
    TL.rows.push({ kind: 'layer', L, trs, d });
    if (ed.expanded.has(L.id)) for (const tr of trs) TL.rows.push({ kind: 'track', L, tr });
  }
}
function renderList() {
  dirty.list = false; buildRows();
  const c = clip(), S = selL(); TL.valEls = [];
  const h = [`<div class="tl-lh"><span>${T`เลเยอร์ / คุณสมบัติ`}</span><button class="icon-btn${ed.onlyAnim ? ' on' : ''}" data-h="only" title="${T`แสดงเฉพาะเลเยอร์ที่มีแอนิเมชัน`}">${icon('anim')}</button><button class="icon-btn" data-h="all" title="${T`กาง / หุบทั้งหมด`}">${icon('chev')}</button></div>`];
  TL.rows.forEach((r, i) => {
    if (r.kind === 'ev') h.push(`<div class="tl-r ev" data-i="${i}">${icon('bolt')}<span class="tl-n">${T`เหตุการณ์ (มาโคร)`}</span><button class="icon-btn" data-act="evadd" title="${T`เพิ่มเหตุการณ์ที่หัวเล่น`}">${icon('plus')}</button></div>`);
    else if (r.kind === 'layer') {
      const L = r.L, open = ed.expanded.has(L.id);
      h.push(`<div class="tl-r ly${L === S ? ' sel' : studio.selection().includes(L) ? ' sel2' : ''}${L.vis ? '' : ' off'}${L.type === 'area' ? ' is-area' : ''}" data-i="${i}" data-lid="${L.id}"${r.d ? ` style="--dp:${r.d}"` : ''}><button class="tl-x${open ? ' open' : ''}${r.trs.length ? '' : ' none'}" data-act="exp">${icon('caret')}</button><span class="l-ico">${icon(studio.TYPE_ICON[L.type])}</span><span class="tl-n">${esc(L.name)}${r.trs.length ? `<small>${r.trs.length}</small>` : ''}</span><button class="icon-btn" data-act="vis" title="${T`แสดง / ซ่อน`}">${icon(L.vis ? 'eye' : 'eyeoff')}</button><button class="icon-btn" data-act="prop" title="${T`เพิ่มคุณสมบัติที่จะทำแอนิเมชัน`}">${icon('plus')}</button></div>`);
    } else {
      const p = A.PROPS[r.tr.prop] || { label: r.tr.prop }, k = A.keyAt(c, r.tr, tNow());
      h.push(`<div class="tl-r tk${ed.selTracks.has(r.tr.id) ? ' on' : ''}${r.tr.mute ? ' mute' : ''}" data-i="${i}" style="--gc:${colOf(r.tr.prop)}"><button class="kd${k ? ' on' : ' tr'}" data-act="key" title="${T`ใส่ / เอาคีย์เฟรมออกที่เวลานี้`}"></button><span class="tl-n">${esc(p.label)}</span><span class="tl-v" data-act="val"></span><button class="icon-btn" data-act="mute" title="${T`ปิด / เปิดแถวนี้ชั่วคราว`}">${icon(r.tr.mute ? 'eyeoff' : 'eye')}</button><button class="icon-btn" data-act="rm" title="${T`ลบแถวนี้ทั้งแถว`}">${icon('x')}</button></div>`);
    }
  });
  tlList.innerHTML = h.join('');
  tlList.style.height = TL.RUL + TL.rows.length * TL.RH + 'px';
  tlList.querySelectorAll('.tl-r.tk').forEach((rowEl) => { const r = TL.rows[+rowEl.dataset.i]; TL.valEls.push({ el: rowEl.querySelector('.tl-v'), kd: rowEl.querySelector('.kd'), r }); });
  updVals();
}
function updVals() {
  dirty.vals = false;
  const c = clip(); if (!c) return;
  for (const { el: e, kd, r } of TL.valEls) {
    const v = A.evalTrack(r.tr, tNow()), p = A.PROPS[r.tr.prop];
    const txt = p && p.type === 'color' ? '' : A.fmtV(r.tr.prop, v);
    if (e._t !== txt) { e._t = txt; e.textContent = txt; }
    if (p && p.type === 'color') e.style.setProperty('--sw', v);
    const on = !!A.keyAt(c, r.tr, tNow()); if (kd._on !== on) { kd._on = on; kd.className = 'kd' + (on ? ' on' : ' tr'); }
  }
  for (const u of sideUpd) u();
}
function listEvents() {
  tlList.addEventListener('click', (e) => {
    const c = clip(); if (!c) return;
    const hb = e.target.closest('[data-h]');
    if (hb) { if (hb.dataset.h === 'only') ed.onlyAnim = !ed.onlyAnim; else { const all = TL.rows.filter((r) => r.kind === 'layer' && r.trs.length); const open = all.some((r) => !ed.expanded.has(r.L.id)); for (const r of all) open ? ed.expanded.add(r.L.id) : ed.expanded.delete(r.L.id); } dirty.list = dirty.tl = true; return; }
    const rowEl = e.target.closest('.tl-r'); if (!rowEl) return;
    const r = TL.rows[+rowEl.dataset.i], act = e.target.closest('[data-act]'), a = act && act.dataset.act;
    if (r.kind === 'ev') { if (a === 'evadd') editEvent(c, null); return; }
    if (a === 'exp') { if (ed.expanded.has(r.L.id)) ed.expanded.delete(r.L.id); else ed.expanded.add(r.L.id); dirty.list = dirty.tl = true; return; }
    if (a === 'vis') { const G = studio.selection().includes(r.L) && studio.selection().length > 1 ? studio.selection() : [r.L]; if (e.altKey) studio.solo(G); else studio.setVis(G, !r.L.vis); dirty.list = true; return; }
    if (a === 'prop') { propMenu(r.L, act); return; }
    if (r.kind === 'track') {
      if (a === 'key') { toggleKey(c, r.L, r.tr.prop); return; }
      if (a === 'rm') { c.tracks.splice(c.tracks.indexOf(r.tr), 1); commit(); return; }
      if (a === 'mute') { r.tr.mute = !r.tr.mute; commit(); return; }
      if (e.ctrlKey || e.shiftKey) { if (ed.selTracks.has(r.tr.id)) ed.selTracks.delete(r.tr.id); else ed.selTracks.add(r.tr.id); }
      else ed.selTracks = new Set([r.tr.id]);
    }
    fromTL = true;
    if (r.kind === 'layer' && (e.ctrlKey || e.metaKey)) studio.select(r.L.id, 'toggle');
    else if (r.kind === 'layer' && e.shiftKey) studio.select(r.L.id, 'range');
    else if (studio.selected() !== r.L || studio.selection().length > 1) studio.select(r.L.id);
    fromTL = false;
    dirty.list = dirty.tl = true;
  });
  tlList.addEventListener('dblclick', (e) => { const rowEl = e.target.closest('.tl-r.ly'); if (rowEl && !e.target.closest('button')) { const r = TL.rows[+rowEl.dataset.i]; studio.renameLayer(r.L); } });
  // layer rows: drag them (several at once) into an animation area, or to another place in the order
  tlList.addEventListener('pointerdown', (e) => {
    const rowEl = e.target.closest('.tl-r.ly'); if (!rowEl || e.target.closest('button, [data-act]')) return;
    const r = TL.rows[+rowEl.dataset.i]; if (r && r.L) studio.dragLayers(e, r.L, rowEl);
  });
  tlList.addEventListener('contextmenu', (e) => {
    const rowEl = e.target.closest('.tl-r.ly'); if (!rowEl) return;
    e.preventDefault(); const r = TL.rows[+rowEl.dataset.i]; if (!r || !r.L) return;
    if (!studio.selection().includes(r.L)) { fromTL = true; studio.select(r.L.id); fromTL = false; }
    studio.layerMenu(r.L, e.clientX, e.clientY);
  });
  // value scrubbing in the list
  tlList.addEventListener('pointerdown', (e) => {
    const v = e.target.closest('[data-act=val]'); if (!v || e.button !== 0) return;
    const r = TL.rows[+v.closest('.tl-r').dataset.i], c = clip(), p = A.PROPS[r.tr.prop]; if (!p || p.type !== 'num') return;
    v.setPointerCapture(e.pointerId); const x0 = e.clientX, v0 = A.evalTrack(r.tr, tNow()); let moved = false;
    document.body.classList.add('scrubbing');
    v.onpointermove = (ev) => { const dx = ev.clientX - x0; if (Math.abs(dx) > 1) moved = true; if (!moved) return; setValue(c, r.L, r.tr.prop, v0 + dx * p.step * (ev.shiftKey ? 10 : 1) * (ev.altKey ? 0.1 : 1), true); };
    v.onpointerup = () => { v.onpointermove = v.onpointerup = null; document.body.classList.remove('scrubbing'); if (moved) commit(); else { promptBox(p.label, String(p.pct ? Math.round(v0 * 1000) / 10 : Math.round(v0 * 100) / 100), T`ตกลง`).then((s) => { let n = parseFloat(s); if (!Number.isFinite(n)) return; if (p.pct) n /= 100; setValue(c, r.L, r.tr.prop, n, false); }); } };
  });
}
function propMenu(L, anchor) {
  const c = clip(), r = anchor.getBoundingClientRect();
  const items = [];
  for (const [g, gl] of A.GROUPS()) {
    const list = A.propsFor(L).filter((p) => p.group === g && !A.findTrack(c, L.id, p.key)); if (!list.length) continue;
    items.push('-'); for (const p of list) items.push({ icon: 'key', label: `${gl} · ${p.label}`, run: () => { A.setKey(c, A.ensureTrack(c, L.id, p.key), tNow(), dispV(c, L, p.key)); autoExpand(L.id); if (studio.selected() !== L) studio.select(L.id); commit(); } });
  }
  items.shift();
  ctxMenu(r.left, r.bottom + 4, items.length ? items : [{ icon: 'check', label: T`ทุกคุณสมบัติมีแถวแล้ว`, run: () => {} }], T`เพิ่มคีย์เฟรมให้ “${L.name}”`);
}

/* ---------------------------------------------------------------- drawing */
const pal = () => (theme.dark
  ? { alt: 'rgba(255,255,255,.035)', sel: 'rgba(124,140,255,.16)', line: 'rgba(255,255,255,.07)', line2: 'rgba(255,255,255,.16)', ink: '#eef1ff', ink3: '#8690bd', key: '#eef1ff', keyS: '#0e1228', hot: '#ff8fb8', shade: 'rgba(0,0,0,.28)', rul: 'rgba(30,36,76,.92)', box: 'rgba(124,140,255,.18)' }
  : { alt: 'rgba(255,255,255,.28)', sel: 'rgba(124,140,255,.13)', line: 'rgba(70,80,130,.09)', line2: 'rgba(70,80,130,.2)', ink: '#232a47', ink3: '#7b84a6', key: '#ffffff', keyS: '#4a5376', hot: '#ff5f9a', shade: 'rgba(70,80,130,.09)', rul: 'rgba(255,255,255,.82)', box: 'rgba(124,140,255,.15)' });
function tickStep(c) { for (const s of [1 / c.fps, 2 / c.fps, 5 / c.fps, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60]) if (s * ed.zoom >= 64) return s; return 120; }
const fmtTick = (t) => { const r = Math.round(t * 1000) / 1000; return r >= 60 ? `${Math.floor(r / 60)}:${String(Math.round(r % 60)).padStart(2, '0')}` : `${+r.toFixed(2)}s`; };
function keyShape(g, x, y, r, e) {
  g.beginPath();
  if (e === 'hold') g.rect(x - r * 0.78, y - r * 0.78, r * 1.56, r * 1.56);
  else if (e === 'linear') g.arc(x, y, r * 0.86, 0, 6.2832);
  else { g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); }
}
function drawTL() {
  dirty.tl = false;
  const c = clip(), g = tctx; if (!c || !TL.W) return;
  const p = pal(), W = TL.W, H = TL.H, st = tlBody.scrollTop;
  g.setTransform(TL.dpr, 0, 0, TL.dpr, 0, 0); g.clearRect(0, 0, W, H);
  const step0 = tickStep(c), t0 = Math.max(0, Math.floor(TX(0) / step0) * step0), t1 = TX(W);
  // grid
  g.lineWidth = 1;
  const minor = ed.zoom / c.fps >= 7 ? 1 / c.fps : step0 / 4;
  g.strokeStyle = p.line; g.beginPath();
  for (let t = Math.max(0, Math.floor(TX(0) / minor) * minor); t <= t1; t += minor) { const x = Math.round(X(t)) + 0.5; g.moveTo(x, TL.RUL); g.lineTo(x, H); }
  g.stroke();
  g.strokeStyle = p.line2; g.beginPath();
  for (let t = t0; t <= t1; t += step0) { const x = Math.round(X(t)) + 0.5; g.moveTo(x, TL.RUL); g.lineTo(x, H); }
  g.stroke();
  // past the end of the clip
  const xe = X(c.dur); if (xe < W) { g.fillStyle = p.shade; g.fillRect(Math.max(0, xe), TL.RUL, W - Math.max(0, xe), H - TL.RUL); }
  if (ed.view === 'graph') drawGraph(c, p, W, H); else drawDope(c, p, W, H, st);
  // ruler
  g.fillStyle = p.rul; g.fillRect(0, 0, W, TL.RUL);
  g.strokeStyle = p.line2; g.beginPath(); g.moveTo(0, TL.RUL - 0.5); g.lineTo(W, TL.RUL - 0.5); g.stroke();
  g.fillStyle = p.ink3; g.font = '600 10.5px "IBM Plex Sans Thai", sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.strokeStyle = p.line2; g.beginPath();
  for (let t = Math.max(0, Math.floor(TX(0) / minor) * minor); t <= t1; t += minor) { const x = Math.round(X(t)) + 0.5; g.moveTo(x, TL.RUL - 5); g.lineTo(x, TL.RUL); }
  g.stroke();
  for (let t = t0; t <= t1 + 1e-6; t += step0) { const x = Math.round(X(t)) + 0.5; g.fillRect(x - 0.5, TL.RUL - 10, 1, 10); g.fillText(fmtTick(t), x + 4, 11); }
  // clip end handle
  if (xe > -10 && xe < W + 10) { g.fillStyle = p.ink3; g.beginPath(); g.moveTo(xe, TL.RUL - 1); g.lineTo(xe - 7, TL.RUL - 12); g.lineTo(xe + 7, TL.RUL - 12); g.closePath(); g.fill(); g.fillRect(xe - 1, TL.RUL, 2, H); }
  // playhead
  const xp = X(tNow());
  if (xp > -20 && xp < W + 20) {
    const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, '#7c8cff'); grd.addColorStop(1, '#ff9ec7');
    g.fillStyle = grd; g.fillRect(Math.round(xp) - 1, TL.RUL - 2, 2, H);
    const lab = fmtT(tNow(), c); g.font = '700 10.5px "IBM Plex Sans Thai", sans-serif'; const tw = g.measureText(lab).width + 12, lx = clamp(xp, tw / 2 + 2, W - tw / 2 - 2);
    g.fillStyle = '#7c8cff'; g.beginPath(); g.roundRect(lx - tw / 2, 3, tw, 17, 8.5); g.fill();
    g.beginPath(); g.moveTo(xp - 5, 19); g.lineTo(xp + 5, 19); g.lineTo(xp, 25); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(lab, lx, 12);
  }
  // box selection
  const d = TL.drag;
  if (d && d.kind === 'box' && d.moved) { const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1); g.fillStyle = p.box; g.strokeStyle = '#7c8cff'; g.lineWidth = 1; g.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)); g.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)); }
}
function drawDope(c, p, W, H, st) {
  const g = tctx, RH = TL.RH, S = selL();
  const first = Math.max(0, Math.floor((st) / RH)), last = Math.min(TL.rows.length - 1, Math.ceil((st + H) / RH));
  for (let i = first; i <= last; i++) {
    const r = TL.rows[i], y = TL.RUL + i * RH - st; if (y + RH < TL.RUL || y > H) continue;
    const ym = y + RH / 2;
    if ((r.kind === 'layer' && r.L === S) || (r.kind === 'track' && ed.selTracks.has(r.tr.id))) { g.fillStyle = p.sel; g.fillRect(0, y, W, RH); }
    else if (i % 2) { g.fillStyle = p.alt; g.fillRect(0, y, W, RH); }
    if (r.kind === 'ev') {
      for (const e of c.events) {
        const x = X(e.t); if (x < -10 || x > W + 10) continue;
        const on = ed.selEv.has(e);
        g.fillStyle = on ? p.hot : '#ffb35c'; g.beginPath(); g.moveTo(x - 6, ym - 8); g.lineTo(x + 6, ym - 8); g.lineTo(x + 6, ym + 1); g.lineTo(x, ym + 8); g.lineTo(x - 6, ym + 1); g.closePath(); g.fill();
        g.fillStyle = '#fff'; g.font = '700 9px sans-serif'; g.textAlign = 'center'; g.fillText('⚡', x, ym - 1);
      }
    } else if (r.kind === 'layer') {
      const ts = new Set(); for (const tr of r.trs) for (const k of tr.keys) ts.add(k.t);
      if (r.trs.length) {
        const sp = barSpan(c, r.L.id), on = ed.selBars.has(r.L.id), xa = X(sp.a), w = Math.max(4, X(sp.b) - xa);
        g.fillStyle = on ? (theme.dark ? 'rgba(124,140,255,.45)' : 'rgba(124,140,255,.38)') : (theme.dark ? 'rgba(124,140,255,.22)' : 'rgba(124,140,255,.18)');
        g.beginPath(); g.roundRect(xa - 3, ym - 7, w + 6, 14, 6); g.fill();
        if (on) { g.lineWidth = 1.5; g.strokeStyle = '#7c8cff'; g.stroke(); g.fillStyle = '#7c8cff'; if (sp.b > sp.a) { g.beginPath(); g.roundRect(xa - 4, ym - 8, 4, 16, 2); g.roundRect(xa + w, ym - 8, 4, 16, 2); g.fill(); } }
      }
      for (const t of ts) { const x = X(t); if (x < -8 || x > W + 8) continue; const sel = r.trs.some((tr) => tr.keys.some((k) => k.t === t && ed.selKeys.has(k))); keyShape(g, x, ym, 5, 'ease'); g.fillStyle = sel ? p.hot : p.ink3; g.fill(); }
    } else {
      const tr = r.tr, col = colOf(tr.prop), ks = tr.keys;
      g.globalAlpha = tr.mute ? 0.35 : 1;
      for (let j = 0; j < ks.length - 1; j++) {
        const a = X(ks[j].t), b = X(ks[j + 1].t); if (b < 0 || a > W) continue;
        if (ks[j].e === 'hold') { g.strokeStyle = col; g.lineWidth = 2; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(a, ym); g.lineTo(b, ym); g.stroke(); g.setLineDash([]); }
        else { g.fillStyle = col + '44'; g.fillRect(a, ym - 3, b - a, 6); g.fillStyle = col; g.fillRect(a, ym - 0.75, b - a, 1.5); }
      }
      for (const k of ks) {
        const x = X(k.t); if (x < -8 || x > W + 8) continue;
        const on = ed.selKeys.has(k);
        keyShape(g, x, ym, on ? 7 : 6, k.e);
        g.fillStyle = on ? p.hot : p.key; g.fill(); g.lineWidth = 1.6; g.strokeStyle = on ? '#fff' : col; g.stroke();
        if (A.PROPS[tr.prop] && A.PROPS[tr.prop].type === 'color') { g.beginPath(); g.arc(x, ym, 2.5, 0, 6.283); g.fillStyle = k.v; g.fill(); }
      }
      g.globalAlpha = 1;
    }
  }
  if (TL.rows.length <= 1) { g.fillStyle = p.ink3; g.font = '12.5px "IBM Plex Sans Thai", sans-serif'; g.textAlign = 'center'; g.fillText(T`เพิ่มเลเยอร์จากแถบซ้าย แล้วเลือกเลเยอร์เพื่อเริ่มทำแอนิเมชัน`, W / 2, TL.RUL + 60); }
  else if (!c.tracks.length) { g.fillStyle = p.ink3; g.font = '12.5px "IBM Plex Sans Thai", sans-serif'; g.textAlign = 'center'; g.fillText(T`เลือกเลเยอร์ เลื่อนหัวเล่น แล้วลากเลเยอร์บนเวที — คีย์เฟรมจะเกิดขึ้นเอง (หรือกด K / ใช้พรีเซ็ต)`, W / 2, Math.min(H - 20, TL.RUL + TL.rows.length * RH + 34 - st)); }
}
/* graph editor */
// curves in the graph: chosen rows, rows holding selected keys, and every row of every selected layer
const GPAL = ['#7c8cff', '#ff6b8b', '#2ec4a7', '#ffb547', '#b06bff', '#38b6ff', '#ff8f3d', '#8bd450', '#ff5fd2', '#4dd0e1', '#e05d5d', '#9aa3ff'];
function graphAll(c) {
  const ok = (t) => isNum(t.prop) && t.keys.length, keyTr = new Set(selected(c).map((x) => x.tr));
  const lays = new Set(studio.selection().map((l) => l.id)); const L = selL(); if (L) lays.add(L.id);
  let list = c.tracks.filter((t) => ok(t) && (ed.selTracks.has(t.id) || keyTr.has(t) || lays.has(t.layer)));
  if (!list.length && !lays.size) list = c.tracks.filter(ok);
  const order = studio.tree().map((r) => r.L.id), po = Object.keys(A.PROPS);
  return list.sort((x, y) => order.indexOf(x.layer) - order.indexOf(y.layer) || po.indexOf(x.prop) - po.indexOf(y.prop)).slice(0, 24);
}
const graphTracks = (c) => graphAll(c).filter((t) => !ed.gHide.has('L:' + t.layer) && !ed.gHide.has('P:' + t.prop));
const GDASH = [[], [7, 4], [2, 3], [10, 3, 2, 3], [5, 2], [1, 4]];
// line style: by property when several layers are shown (colour already tells the layer apart)
function gDash(c, tr) { const all = graphAll(c); if (new Set(all.map((t) => t.layer)).size < 2) return []; const ps = [...new Set(all.map((t) => t.prop))]; return GDASH[ps.indexOf(tr.prop) % GDASH.length]; }
const short = (s, n = 16) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// a curve's colour: by property when one layer is shown, by layer when several are
function gColor(c, tr) {
  const all = graphAll(c), lays = [...new Set(all.map((t) => t.layer))];
  return lays.length > 1 ? GPAL[lays.indexOf(tr.layer) % GPAL.length] : colOf(tr.prop);
}
const gName = (tr) => { const L = studio.byId(tr.layer); return (L ? L.name : '?') + ' · ' + ((A.PROPS[tr.prop] || {}).label || tr.prop); };
// value range: curves of the same property share one scale (easy to compare), other properties get their own
function graphRanges(c, list) {
  if (TL.gr) return TL.gr;
  const byProp = new Map();
  for (const tr of list) {
    let mn = Infinity, mx = -Infinity;
    for (const k of tr.keys) { mn = Math.min(mn, k.v); mx = Math.max(mx, k.v); }
    const a = tr.keys[0].t, b = tr.keys[tr.keys.length - 1].t;
    for (let i = 0; i <= 120 && b > a; i++) { const v = A.evalTrack(tr, a + (b - a) * i / 120); mn = Math.min(mn, v); mx = Math.max(mx, v); }
    const o = byProp.get(tr.prop) || [Infinity, -Infinity]; byProp.set(tr.prop, [Math.min(o[0], mn), Math.max(o[1], mx)]);
  }
  const m = new Map();
  for (const tr of list) {
    let [mn, mx] = byProp.get(tr.prop);
    if (mx - mn < 1e-6) { const d = Math.max(1, Math.abs(mn) * 0.2); mn -= d; mx += d; }
    const pd = (mx - mn) * 0.12; m.set(tr, [mn - pd, mx + pd]);
  }
  return m;
}
const gTop = () => TL.RUL + 14 + (TL.legH || 0), gBot = () => TL.H - 14;
const GY = (v, r) => gBot() - (v - r[0]) / (r[1] - r[0]) * (gBot() - gTop());
const GV = (y, r) => r[0] + (gBot() - y) / (gBot() - gTop()) * (r[1] - r[0]);
function handlesOf(c, list) { // eslint-disable-line
  const out = [];
  for (const tr of list) for (let j = 0; j < tr.keys.length - 1; j++) {
    const a = tr.keys[j], b = tr.keys[j + 1];
    if (!(ed.selKeys.has(a) || ed.selKeys.has(b) || (!ed.selKeys.size && tr.keys.length <= 6 && list.length <= 4))) continue;
    if (!(A.isEditableEase(a.e) || a.e === 'linear') || Math.abs(b.v - a.v) < 1e-9) continue;
    const cp = a.e === 'linear' ? [1 / 3, 1 / 3, 2 / 3, 2 / 3] : A.cpOf(a);
    out.push({ tr, a, b, cp });
  }
  return out;
}
function drawGraph(c, p, W) {
  const g = tctx, all = graphAll(c), list = all.filter((t) => !ed.gHide.has(t.id));
  // legend in one row: a chip per layer (its colour) and a chip per property (its line style) — click = show / hide, Alt+click = only that one
  TL.legend = []; TL.legH = 0;
  const lays = [...new Set(all.map((t) => t.layer))], props0 = [...new Set(all.map((t) => t.prop))];
  if (all.length > 1) {
    g.font = '600 10.5px "IBM Plex Sans Thai", sans-serif'; g.textBaseline = 'middle';
    let x = 8, y = TL.RUL + 6; const h = 18, dark = theme.dark;
    const chip = (key, label, draw) => {
      const w = g.measureText(label).width + (draw ? 34 : 24);
      if (x + w > W - 8 && x > 8) { x = 8; y += h + 4; }
      const off = ed.gHide.has(key);
      g.globalAlpha = off ? 0.38 : 1; g.fillStyle = dark ? 'rgba(30,36,76,.9)' : 'rgba(255,255,255,.9)';
      g.beginPath(); g.roundRect(x, y, w, h, 9); g.fill(); g.strokeStyle = p.line2; g.lineWidth = 1; g.stroke();
      draw(x + 8, y + h / 2);
      g.fillStyle = p.ink; g.textAlign = 'left'; g.fillText(label, x + (draw ? 30 : 20), y + h / 2 + 0.5);
      g.globalAlpha = 1; TL.legend.push({ x, y, w, h, key }); x += w + 5;
    };
    if (lays.length > 1) for (const id of lays) { const L = studio.byId(id), col = gColor(c, all.find((t) => t.layer === id)); chip('L:' + id, short(L ? L.name : '?'), (cx, cy) => { g.fillStyle = col; g.beginPath(); g.roundRect(cx, cy - 5, 16, 10, 5); g.fill(); }); }
    if (lays.length > 1) x += 6;
    if (props0.length > 1 || lays.length > 1) for (const pr of props0) {
      const tr = all.find((t) => t.prop === pr), col = lays.length > 1 ? p.ink : gColor(c, tr), dash = gDash(c, tr);
      chip('P:' + pr, (A.PROPS[pr] || {}).label || pr, (cx, cy) => { g.strokeStyle = col; g.lineWidth = 2.2; g.setLineDash(dash); g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + 18, cy); g.stroke(); g.setLineDash([]); });
    }
    TL.legH = y + h + 6 - TL.RUL;
  }
  if (!list.length) { g.fillStyle = p.ink3; g.font = '12.5px "IBM Plex Sans Thai", sans-serif'; g.textAlign = 'center'; g.fillText(all.length ? T`ซ่อนทุกเส้นอยู่ — คลิกป้ายด้านบนเพื่อแสดง` : T`เลือกเลเยอร์ คีย์เฟรม หรือแถวคุณสมบัติที่เป็นตัวเลข เพื่อดูกราฟ · เลือกหลายอัน = เห็นทุกเส้นพร้อมกัน`, W / 2, TL.RUL + TL.legH + 60); return; }
  const R = graphRanges(c, list), props = new Set(list.map((t) => t.prop)), oneProp = props.size === 1;
  // value grid (labels when every curve is the same property, so they share one scale)
  g.font = '10px "IBM Plex Sans Thai", sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(gTop() + (gBot() - gTop()) * i / 4) + 0.5;
    g.strokeStyle = p.line; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    if (oneProp) { const r = R.get(list[0]); g.fillStyle = p.ink3; g.fillText(A.fmtV(list[0].prop, GV(y, r)), 4, y - 7); }
  }
  if (!oneProp) { g.fillStyle = p.ink3; g.fillText(T`คุณสมบัติต่างกันแสดงคนละสเกล · ชนิดเดียวกันใช้สเกลเดียวกัน`, 4, gTop() - 6); }
  const selTr = new Set(selected(c).map((x) => x.tr)), focus = selTr.size > 0;
  const multiSel = ed.selKeys.size > 1;
  if (multiSel) { g.fillStyle = p.ink3; g.textAlign = 'right'; g.fillText(T`ลากคีย์ = ขยับทุกคีย์ที่เลือก · ลากจุดจับ = ความโค้งเดียวกันทุกคีย์ที่เลือก`, W - 6, gTop() - 6); g.textAlign = 'left'; }
  // curves: the ones holding selected keys bold, the others lighter
  for (const tr of list) {
    const r = R.get(tr), col = gColor(c, tr), on = !focus || selTr.has(tr);
    g.globalAlpha = on ? 1 : 0.35; g.strokeStyle = col; g.lineWidth = on ? 2.4 : 1.6; g.setLineDash(gDash(c, tr)); g.beginPath();
    for (let x = 0; x <= W; x += 2) { const t = clamp(TX(x), 0, Math.max(c.dur, tr.keys[tr.keys.length - 1].t)); const y = GY(A.evalTrack(tr, t), r); x ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
  }
  // a name tag at the end of each curve (only while few curves are shown — the legend names them otherwise)
  if (list.length > 1 && list.length <= 4) {
    g.font = '600 10px "IBM Plex Sans Thai", sans-serif'; g.textBaseline = 'middle';
    const used = [];
    for (const tr of list) {
      const k = tr.keys[tr.keys.length - 1], r = R.get(tr), col = gColor(c, tr), label = short(gName(tr), 26), w = g.measureText(label).width + 10;
      let x = Math.min(W - w - 4, X(k.t) + 10), y = clamp(GY(k.v, r), gTop() + 8, gBot() - 8);
      while (used.some((u) => Math.abs(u.y - y) < 15 && Math.abs(u.x - x) < Math.max(u.w, w))) y += 15; // don't stack tags on each other
      used.push({ x, y, w });
      g.globalAlpha = !focus || selTr.has(tr) ? 1 : 0.5; g.fillStyle = col; g.beginPath(); g.roundRect(x, y - 8, w, 16, 8); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.save(); g.beginPath(); g.rect(x + 5, y - 8, w - 10, 16); g.clip(); g.fillText(label, x + 5, y + 0.5); g.restore(); g.globalAlpha = 1;
    }
  }
  for (const h of handlesOf(c, list)) {
    const r = R.get(h.tr), dt = h.b.t - h.a.t, dv = h.b.v - h.a.v;
    const p1 = [X(h.a.t + h.cp[0] * dt), GY(h.a.v + h.cp[1] * dv, r)], p2 = [X(h.a.t + h.cp[2] * dt), GY(h.a.v + h.cp[3] * dv, r)];
    g.strokeStyle = p.ink3; g.lineWidth = 1.2; g.beginPath(); g.moveTo(X(h.a.t), GY(h.a.v, r)); g.lineTo(p1[0], p1[1]); g.moveTo(X(h.b.t), GY(h.b.v, r)); g.lineTo(p2[0], p2[1]); g.stroke();
    for (const q of [p1, p2]) { g.beginPath(); g.arc(q[0], q[1], 4.5, 0, 6.283); g.fillStyle = p.key; g.fill(); g.lineWidth = 2; g.strokeStyle = gColor(c, h.tr); g.stroke(); }
  }
  for (const tr of list) {
    const r = R.get(tr), col = gColor(c, tr);
    for (const k of tr.keys) { const on = ed.selKeys.has(k); keyShape(g, X(k.t), GY(k.v, r), on ? 7 : 6, k.e); g.fillStyle = on ? p.hot : p.key; g.fill(); g.lineWidth = 1.8; g.strokeStyle = on ? '#fff' : col; g.stroke(); }
  }
}

/* --------------------------------------------------------------- canvas input */
function hitDope(c, x, y) {
  const st = tlBody.scrollTop, i = Math.floor((y - TL.RUL + st) / TL.RH), r = TL.rows[i]; if (!r) return { row: null, i };
  if (r.kind === 'ev') { const e = c.events.find((ev) => Math.abs(X(ev.t) - x) < 7); return { row: r, i, ev: e }; }
  if (r.kind === 'track') { let best = null, bd = 8; for (const k of r.tr.keys) { const d = Math.abs(X(k.t) - x); if (d < bd) { bd = d; best = k; } } return { row: r, i, key: best, tr: r.tr }; }
  const sp = r.trs.length ? barSpan(c, r.L.id) : null;
  if (sp && ed.selBars.has(r.L.id) && sp.b > sp.a) { // a selected bar: its ends stretch / squeeze it
    if (Math.abs(x - X(sp.b)) < 6) return { row: r, i, bar: r.L.id, edge: 1 };
    if (Math.abs(x - X(sp.a)) < 6) return { row: r, i, bar: r.L.id, edge: -1 };
  }
  const ts = r.trs.flatMap((tr) => tr.keys).filter((k) => Math.abs(X(k.t) - x) < 7);
  if (ts.length && !(sp && ed.selBars.has(r.L.id))) { const t = ts[0].t; return { row: r, i, group: r.trs.flatMap((tr) => tr.keys.filter((k) => Math.abs(k.t - t) < 1e-6)) }; }
  if (sp && x >= X(sp.a) - 4 && x <= X(sp.b) + 4) return { row: r, i, bar: r.L.id };
  return { row: r, i };
}
function hitGraph(c, x, y) {
  const list = graphTracks(c), R = graphRanges(c, list);
  for (const h of handlesOf(c, list)) {
    const r = R.get(h.tr), dt = h.b.t - h.a.t, dv = h.b.v - h.a.v;
    for (const n of [0, 1]) { const hx = X(h.a.t + h.cp[n * 2] * dt), hy = GY(h.a.v + h.cp[n * 2 + 1] * dv, r); if (Math.hypot(hx - x, hy - y) < 8) return { handle: h, n }; }
  }
  for (const tr of list) { const r = R.get(tr); for (const k of tr.keys) if (Math.hypot(X(k.t) - x, GY(k.v, r) - y) < 8) return { key: k, tr }; }
  return {};
}
function canvasEvents() {
  const cv = tlCv;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener('pointerdown', (e) => {
    const c = clip(); if (!c || (e.button !== 0 && e.button !== 1)) return;
    const [x, y] = pos(e); cv.setPointerCapture(e.pointerId); closePop();
    if (e.button === 1) { TL.drag = { kind: 'pan', x0: x, s0: ed.scroll }; return; }
    if (y < TL.RUL) {
      if (Math.abs(x - X(c.dur)) < 7) TL.drag = { kind: 'dur' };
      else { TL.drag = { kind: 'scrub' }; setT(TX(x)); }
      return;
    }
    const add = e.shiftKey || e.ctrlKey;
    if (ed.view === 'graph') {
      const lg = (TL.legend || []).find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      if (lg) { // legend chip: show / hide this curve · Alt = only this one (again = all)
        const pre = lg.key.slice(0, 2), mates = (TL.legend || []).filter((b) => b.key.startsWith(pre)).map((b) => b.key);
        if (e.altKey) { const solo = mates.every((k) => k === lg.key || ed.gHide.has(k)) && !ed.gHide.has(lg.key); for (const k of mates) { if (solo || k === lg.key) ed.gHide.delete(k); else ed.gHide.add(k); } }
        else if (ed.gHide.has(lg.key)) ed.gHide.delete(lg.key); else ed.gHide.add(lg.key);
        dirty.tl = true; return;
      }
      const h = hitGraph(c, x, y);
      TL.gr = graphRanges(c, graphTracks(c)); // freeze the value range while dragging
      if (h.handle) { TL.drag = { kind: 'handle', h: h.handle, n: h.n }; return; }
      if (h.key) {
        if (add) { if (ed.selKeys.has(h.key)) ed.selKeys.delete(h.key); else ed.selKeys.add(h.key); } else if (!ed.selKeys.has(h.key)) ed.selKeys = new Set([h.key]);
        const items = selected(c).filter(({ tr }) => TL.gr.has(tr)).map(({ k, tr }) => ({ k, tr, t0: k.t, v0: k.v, r: TL.gr.get(tr) }));
        TL.drag = { kind: 'gkeys', x0: x, y0: y, items, moved: false }; dirtyAll(); return;
      }
      TL.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, add, moved: false }; return;
    }
    const h = hitDope(c, x, y);
    if (h.ev) {
      if (add) { if (ed.selEv.has(h.ev)) ed.selEv.delete(h.ev); else ed.selEv.add(h.ev); } else if (!ed.selEv.has(h.ev)) { ed.selEv = new Set([h.ev]); ed.selKeys.clear(); }
      TL.drag = { kind: 'keys', x0: x, items: [], evs: [...ed.selEv].map((ev) => ({ ev, t0: ev.t })), moved: false }; dirtyAll(); return;
    }
    if (h.bar) {
      if (h.edge && ed.selBars.has(h.bar)) { // stretch every selected bar from the same end
        const items = [...ed.selBars].map((id) => { const sp = barSpan(c, id); return sp && sp.b > sp.a ? { sp, keys: barKeys(c, id).map((k) => ({ k, t0: k.t })) } : null; }).filter(Boolean);
        TL.drag = { kind: 'stretch', edge: h.edge, x0: x, items, moved: false }; return;
      }
      if (add) selectBar(c, h.bar, true); else if (!ed.selBars.has(h.bar)) selectBar(c, h.bar, false);
      TL.drag = { kind: 'keys', x0: x, items: selected(c).map(({ k, tr }) => ({ k, tr, t0: k.t })), evs: [], moved: false, anchor: null, bar: h.bar };
      dirtyAll(); return;
    }
    const hitKeys = h.key ? [h.key] : h.group || null;
    if (hitKeys) {
      const allSel = hitKeys.every((k) => ed.selKeys.has(k));
      if (add) { for (const k of hitKeys) allSel ? ed.selKeys.delete(k) : ed.selKeys.add(k); }
      else if (!allSel) { ed.selKeys = new Set(hitKeys); ed.selEv.clear(); ed.selBars.clear(); }
      if (h.row && h.row.L && studio.selected() !== h.row.L) { fromTL = true; studio.select(h.row.L.id); fromTL = false; }
      if (e.altKey) { // alt + drag: duplicate the selection and move the copies
        const fresh = new Set();
        for (const { k, tr } of selected(c)) { const n = { ...k, cp: k.cp ? k.cp.slice() : undefined }; if (!n.cp) delete n.cp; tr.keys.push(n); fresh.add(n); }
        ed.selKeys = fresh;
      }
      TL.drag = { kind: 'keys', x0: x, items: selected(c).map(({ k, tr }) => ({ k, tr, t0: k.t })), evs: [...ed.selEv].map((ev) => ({ ev, t0: ev.t })), moved: false, anchor: hitKeys[0] };
      dirtyAll(); return;
    }
    TL.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, add, moved: false, row: h.row };
  });
  cv.addEventListener('pointermove', (e) => {
    const c = clip(), d = TL.drag, [x, y] = pos(e);
    if (!d) { // hover cursor
      if (!c) return;
      let cur = '';
      if (y < TL.RUL) cur = Math.abs(x - X(c.dur)) < 7 ? 'ew-resize' : 'col-resize';
      else if (ed.view === 'graph') { const h = hitGraph(c, x, y); cur = h.handle || h.key ? 'grab' : ''; }
      else { const h = hitDope(c, x, y); cur = h.edge ? 'ew-resize' : h.key || h.group || h.ev || h.bar ? 'grab' : ''; }
      if (cv.style.cursor !== cur) cv.style.cursor = cur;
      return;
    }
    if (!c) return;
    if (d.kind === 'pan') { ed.scroll = Math.max(0, d.s0 - (x - d.x0) / ed.zoom); dirty.tl = true; return; }
    if (d.kind === 'scrub') { setT(TX(x)); autoScroll(x); return; }
    if (d.kind === 'dur') { c.dur = Math.max(1 / c.fps, A.snapT(c, TX(x))); if (tNow() > c.dur) setT(c.dur); dirty.tl = dirty.top = true; return; }
    if (d.kind === 'box') { d.x1 = x; d.y1 = y; d.moved = d.moved || Math.hypot(x - d.x0, y - d.y0) > 3; dirty.tl = true; return; }
    if (d.kind === 'stretch') {
      let dt = (x - d.x0) / ed.zoom; if (Math.abs(x - d.x0) > 2) d.moved = true; if (!d.moved) return;
      if (ed.snap) dt = Math.round(dt * c.fps) / c.fps;
      const min = 1 / c.fps;
      for (const it of d.items) {
        const { a, b } = it.sp;
        if (d.edge > 0) { const nb = Math.max(a + min, b + dt), f = (nb - a) / (b - a); for (const q of it.keys) q.k.t = a + (q.t0 - a) * f; }
        else { const na = clamp(a + dt, 0, b - min), f = (b - na) / (b - a); for (const q of it.keys) q.k.t = b - (b - q.t0) * f; }
      }
      c.tracks.forEach(A.sortKeys); dirty.tl = dirty.vals = dirty.path = true; return;
    }
    if (d.kind === 'keys') {
      let dt = (x - d.x0) / ed.zoom; if (Math.abs(x - d.x0) > 2) d.moved = true; if (!d.moved) return;
      const minT = Math.min(...d.items.map((i) => i.t0), ...d.evs.map((i) => i.t0));
      dt = Math.max(-minT, dt);
      if (ed.snap) { // frames, and the playhead as a magnet
        const at = (d.anchor ? d.items.find((i) => i.k === d.anchor) : d.items[0] || d.evs[0]); const a0 = at ? at.t0 : 0;
        let nt = A.snapT(c, a0 + dt); if (Math.abs(X(nt) - X(tNow())) < 7) nt = tNow(); dt = nt - a0;
      }
      for (const it of d.items) it.k.t = Math.max(0, it.t0 + dt);
      for (const it of d.evs) it.ev.t = Math.max(0, it.t0 + dt);
      for (const tr of new Set(d.items.map((i) => i.tr))) A.sortKeys(tr);
      dirty.tl = dirty.vals = dirty.path = true; return;
    }
    if (d.kind === 'gkeys') {
      if (Math.hypot(x - d.x0, y - d.y0) > 2) d.moved = true; if (!d.moved) return;
      let dx = x - d.x0, dy = y - d.y0; if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const du = -dy / (gBot() - gTop());
      for (const it of d.items) { let t = Math.max(0, it.t0 + dx / ed.zoom); if (ed.snap) t = A.snapT(c, t); it.k.t = t; it.k.v = it.v0 + du * (it.r[1] - it.r[0]); }
      for (const tr of new Set(d.items.map((i) => i.tr))) A.sortKeys(tr);
      dirty.tl = dirty.vals = dirty.path = true; return;
    }
    if (d.kind === 'handle') {
      const h = d.h, r = TL.gr.get(h.tr), dt = h.b.t - h.a.t, dv = h.b.v - h.a.v;
      const u = clamp((TX(x) - h.a.t) / dt, 0, 1), v = (GV(y, r) - h.a.v) / dv;
      const cp = (h.a.e === 'linear' ? [1 / 3, 1 / 3, 2 / 3, 2 / 3] : (A.cpOf(h.a) || [0.25, 0.1, 0.25, 1])).slice();
      cp[d.n * 2] = +u.toFixed(3); cp[d.n * 2 + 1] = +clamp(v, -3, 4).toFixed(3);
      h.a.e = 'bezier'; h.a.cp = cp; h.cp = cp;
      if (ed.selKeys.has(h.a) && ed.selKeys.size > 1) for (const { k, tr } of selected(c)) { // the same curve shape on every selected key
        if (k === h.a || tr.keys.indexOf(k) === tr.keys.length - 1) continue; k.e = 'bezier'; k.cp = cp.slice();
      }
      dirty.tl = dirty.vals = dirty.path = true; if (ceDraw) dirty.side = true;
    }
  });
  const end = (e) => {
    const c = clip(), d = TL.drag; TL.drag = null; TL.gr = null; if (!d || !c) return;
    if (d.kind === 'box') {
      if (!d.moved) { // a plain click on empty space
        if (!d.add) { ed.selKeys.clear(); ed.selEv.clear(); ed.selBars.clear(); }
        if (d.row && d.row.L) { if (studio.selected() !== d.row.L) { fromTL = true; studio.select(d.row.L.id); fromTL = false; } if (d.row.kind === 'track') ed.selTracks = new Set([d.row.tr.id]); }
        dirtyAll(); return;
      }
      const t0 = TX(Math.min(d.x0, d.x1)), t1 = TX(Math.max(d.x0, d.x1)), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      if (!d.add) { ed.selKeys.clear(); ed.selEv.clear(); ed.selBars.clear(); }
      if (ed.view === 'graph') {
        const list = graphTracks(c), R = graphRanges(c, list);
        for (const tr of list) for (const k of tr.keys) { const ky = GY(k.v, R.get(tr)); if (k.t >= t0 && k.t <= t1 && ky >= y0 && ky <= y1) ed.selKeys.add(k); }
      } else {
        const st = tlBody.scrollTop;
        TL.rows.forEach((r, i) => {
          const ym = TL.RUL + i * TL.RH - st + TL.RH / 2; if (ym < y0 - TL.RH / 2 || ym > y1 + TL.RH / 2) return;
          if (r.kind === 'ev') { for (const ev of c.events) if (ev.t >= t0 && ev.t <= t1) ed.selEv.add(ev); }
          else if (r.kind === 'layer') { const sp = barSpan(c, r.L.id); if (sp && sp.b >= t0 && sp.a <= t1) { ed.selBars.add(r.L.id); for (const k of barKeys(c, r.L.id)) ed.selKeys.add(k); } } // the box touches a bar → the whole bar
          else for (const k of r.tr.keys) if (k.t >= t0 && k.t <= t1) ed.selKeys.add(k);
        });
        syncStage();
      }
      dirtyAll(); return;
    }
    if (d.kind === 'keys' || d.kind === 'gkeys') {
      if (d.moved) { const mx = Math.max(0, ...c.tracks.flatMap((t) => t.keys.map((k) => k.t))); if (mx > c.dur) c.dur = A.snapT(c, mx); dedupe(c); commit(); }
      else if (e && !e.shiftKey && !e.ctrlKey && d.items.length > 1 && d.anchor) { ed.selKeys = new Set(d.items.filter((i) => Math.abs(i.k.t - d.anchor.t) < 1e-6).map((i) => i.k)); dirtyAll(); }
      else dirtyAll();
      return;
    }
    if (d.kind === 'stretch') { if (d.moved) { for (const it of d.items) for (const q of it.keys) q.k.t = A.snapT(c, q.k.t); c.tracks.forEach(A.sortKeys); dedupe(c); const mx = Math.max(0, ...c.tracks.flatMap((t) => t.keys.map((k) => k.t))); if (mx > c.dur) c.dur = A.snapT(c, mx); commit(); } return; }
    if (d.kind === 'handle' || d.kind === 'dur') commit();
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', () => end(null));
  cv.addEventListener('dblclick', (e) => {
    const c = clip(); if (!c || ed.view === 'graph') return;
    const [x, y] = pos(e); if (y < TL.RUL) return;
    const h = hitDope(c, x, y), t = A.snapT(c, clamp(TX(x), 0, c.dur));
    if (h.ev) { editEvent(c, h.ev); return; }
    if (!h.row) return;
    if (h.row.kind === 'ev') { setT(t, false); editEvent(c, null); return; }
    if (h.row.kind === 'track') { const k = A.setKey(c, h.row.tr, t, A.evalTrack(h.row.tr, t)); if (k) { ed.selKeys = new Set([k]); commit(); } }
    else if (h.row.kind === 'layer') { autoExpand(h.row.L.id); setT(t, false); if (studio.selected() !== h.row.L) studio.select(h.row.L.id); addKeyAll(); }
  });
  cv.addEventListener('contextmenu', (e) => {
    e.preventDefault(); const c = clip(); if (!c) return;
    const [x, y] = pos(e);
    if (ed.view === 'dope') { const h = hitDope(c, x, y); const ks = h.key ? [h.key] : h.group; if (ks && !ks.every((k) => ed.selKeys.has(k))) { ed.selKeys = new Set(ks); dirtyAll(); } }
    const n = ed.selKeys.size;
    ctxMenu(e.clientX, e.clientY, [
      n && { icon: 'curve', label: T`การเคลื่อนไหว: นุ่มนวล`, run: () => setEase('sineInOut') },
      n && { icon: 'curve', label: T`การเคลื่อนไหว: เร่งเข้า-ชะลอออก`, run: () => setEase('cubicInOut') },
      n && { icon: 'curve', label: T`การเคลื่อนไหว: เด้งเกิน`, run: () => setEase('backOut') },
      n && { icon: 'curve', label: T`การเคลื่อนไหว: เส้นตรง`, run: () => setEase('linear') },
      n && { icon: 'curve', label: T`การเคลื่อนไหว: ค้าง (กระโดด)`, run: () => setEase('hold') },
      n && { icon: 'key', label: T`แก้การเคลื่อนไหวละเอียด…`, run: () => { ed.tab = 'keys'; dirty.side = true; } },
      n && '-',
      n && { icon: 'copy', label: T`คัดลอก (Ctrl+C)`, run: () => copyKeys(false) },
      n && { icon: 'scissors', label: T`ตัด (Ctrl+X)`, run: () => copyKeys(true) },
      clipboard && { icon: 'paste', label: clipboard.clip ? T`วางคลิป (Ctrl+V)` : T`วางที่หัวเล่น (Ctrl+V)`, run: pasteKeys },
      !n && { icon: 'copy', label: T`คัดลอกทั้งคลิป`, run: () => copyClip() },
      n > 1 && { icon: 'reverse', label: T`กลับลำดับเวลา`, run: reverseSel },
      n > 1 && { icon: 'stretch', label: T`ยืด / หดเวลา…`, run: stretchSel },
      { icon: 'check', label: T`เลือกคีย์ทั้งหมด`, run: selectAllKeys },
      (n || ed.selEv.size) && '-',
      (n || ed.selEv.size) && { icon: 'trash', label: T`ลบที่เลือก`, danger: true, run: deleteSel },
      ...(n > 1 ? ['-', ...VALUE_TOOLS().map(([k, ic, label]) => ({ icon: ic, label, run: () => valueTool(k) }))] : []),
    ], n ? T`${n} คีย์ที่เลือก` : T`ไทม์ไลน์`);
  });
  cv.addEventListener('wheel', (e) => {
    const [x] = pos(e);
    if (e.ctrlKey) { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0022), x); return; }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { e.preventDefault(); ed.scroll = Math.max(0, ed.scroll + (e.deltaX || e.deltaY) / ed.zoom); dirty.tl = true; }
  }, { passive: false });
}
// two keys on the same frame of the same row: the one that was dragged there wins
function dedupe(c) {
  for (const tr of c.tracks) { const seen = new Map(); for (const k of tr.keys) { const f = Math.round(k.t * c.fps); const o = seen.get(f); if (o && !ed.selKeys.has(o)) tr.keys.splice(tr.keys.indexOf(o), 1); else if (o) { tr.keys.splice(tr.keys.indexOf(k), 1); continue; } seen.set(f, k); } }
}
function autoScroll(x) { if (x > TL.W - 30) ed.scroll += 12 / ed.zoom; else if (x < 20 && ed.scroll > 0) ed.scroll = Math.max(0, ed.scroll - 12 / ed.zoom); }

/* =============================================================== motion path */
// onion skin: the selected layers as faint ghosts where they are at the keyframes just before (blue) and after (pink) the playhead
function drawOnion() {
  const c = clip(); if (!c) return;
  const t0 = tNow(), k = studio.out().w / Math.max(1, ov.clientWidth), add = c.mode === 'add';
  const lays = studio.selection().length ? studio.selection() : selL() ? [selL()] : [];
  for (const L of lays.slice(0, 12)) {
    if (L.hand && L.hand.on) continue;
    const trs = c.tracks.filter((t) => t.layer === L.id && !t.mute); if (!trs.length) continue;
    const times = [...new Set(trs.flatMap((t) => t.keys.map((q) => q.t)))].sort((a, b) => a - b);
    const prev = times.filter((t) => t < t0 - 1e-4).slice(-2), next = times.filter((t) => t > t0 + 1e-4).slice(0, 2);
    const val = (key, t) => { const tr = trs.find((x) => x.prop === key); if (!tr) return A.getV(L, key); const v = A.evalTrack(tr, t); return add && isNum(key) ? A.getV(L, key) + v : v; };
    const src = studio.sourceOf(L);
    const ghost = (t, i, n, col) => {
      const V = { sc: val('sc', t), sx: val('sx', t), sy: val('sy', t) }, kx = A.kxOf(V), ky = A.kyOf(V);
      const x = val('x', t), y = val('y', t), w = val('w', t) * kx, h = val('h', t) * ky, rot = val('rot', t) * Math.PI / 180;
      if (![x, y, w, h, rot].every(Number.isFinite)) return;
      const fade = 1 - i / (n + 0.5);
      octx.save(); octx.translate(x, y); octx.rotate(rot);
      if (src) { octx.globalAlpha = 0.28 * fade; try { const cr = L.crop || { l: 0, t: 0, r: 0, b: 0 }, sw = src.videoWidth || src.naturalWidth, sh = src.videoHeight || src.naturalHeight; octx.drawImage(src, cr.l * sw, cr.t * sh, sw * (1 - cr.l - cr.r), sh * (1 - cr.t - cr.b), -w / 2, -h / 2, w, h); } catch { /* not ready */ } }
      octx.globalAlpha = 0.9 * fade; octx.fillStyle = col.replace('A', String(0.16 * fade)); octx.fillRect(-w / 2, -h / 2, w, h);
      octx.setLineDash([6 * k, 5 * k]); octx.lineWidth = 2 * k; octx.strokeStyle = col.replace('A', '0.95'); octx.strokeRect(-w / 2, -h / 2, w, h); octx.setLineDash([]);
      octx.font = `600 ${11 * k}px "IBM Plex Sans Thai", sans-serif`; octx.textAlign = 'left'; octx.textBaseline = 'top';
      const label = fmtT(t, c), tw = octx.measureText(label).width + 10 * k;
      octx.fillStyle = col.replace('A', '0.95'); octx.fillRect(-w / 2, -h / 2 - 18 * k, tw, 16 * k); octx.fillStyle = '#fff'; octx.fillText(label, -w / 2 + 5 * k, -h / 2 - 16 * k);
      octx.restore();
    };
    prev.slice().reverse().forEach((t, i) => ghost(t, i, prev.length, 'rgba(90,170,255,A)'));
    next.forEach((t, i) => ghost(t, i, next.length, 'rgba(255,110,170,A)'));
  }
}
function drawPath() {
  dirty.path = false;
  if (!ov) return;
  const o = studio.out();
  if (ov.width !== o.w || ov.height !== o.h) { ov.width = o.w; ov.height = o.h; }
  octx.clearRect(0, 0, o.w, o.h);
  if (ed.mode && ed.onion) drawOnion();
  if (!ed.mode || !ed.path) return;
  const c = clip(), L = selL(); if (!c || !L || (L.hand && L.hand.on)) return;
  const tx = A.findTrack(c, L.id, 'x'), ty = A.findTrack(c, L.id, 'y'); if (!tx && !ty) return;
  const add = c.mode === 'add', k = o.w / Math.max(1, ov.clientWidth);
  const pos = (t) => [tx ? (add ? L.x : 0) + A.evalTrack(tx, t) : L.x, ty ? (add ? L.y : 0) + A.evalTrack(ty, t) : L.y];
  const n = Math.min(900, Math.max(2, Math.ceil(c.dur * c.fps)));
  octx.lineCap = 'round'; octx.lineJoin = 'round';
  octx.beginPath(); for (let i = 0; i <= n; i++) { const [x, y] = pos(c.dur * i / n); i ? octx.lineTo(x, y) : octx.moveTo(x, y); }
  octx.lineWidth = 5 * k; octx.strokeStyle = 'rgba(14,18,40,.35)'; octx.stroke();
  octx.lineWidth = 2 * k; octx.strokeStyle = 'rgba(255,255,255,.9)'; octx.setLineDash([7 * k, 6 * k]); octx.stroke(); octx.setLineDash([]);
  octx.fillStyle = 'rgba(255,255,255,.75)';
  const every = Math.max(1, Math.round(n / 120));
  for (let i = 0; i <= n; i += every) { const [x, y] = pos(c.dur * i / n); octx.beginPath(); octx.arc(x, y, 1.6 * k, 0, 6.283); octx.fill(); }
  const ts = new Set([...(tx ? tx.keys : []), ...(ty ? ty.keys : [])].map((q) => q.t));
  for (const t of ts) { const [x, y] = pos(t), r = 6 * k; octx.beginPath(); octx.moveTo(x, y - r); octx.lineTo(x + r, y); octx.lineTo(x, y + r); octx.lineTo(x - r, y); octx.closePath(); octx.fillStyle = '#fff'; octx.fill(); octx.lineWidth = 2 * k; octx.strokeStyle = '#7c8cff'; octx.stroke(); }
  const [cx, cy] = pos(tNow()); octx.beginPath(); octx.arc(cx, cy, 8 * k, 0, 6.283); octx.lineWidth = 3 * k; octx.strokeStyle = '#ff9ec7'; octx.stroke();
}

/* ======================================================================= loop */
let raf = 0, lastT = -1, frameN = 0;
function loop() {
  cancelAnimationFrame(raf);
  const tick = () => {
    if (!ed.mode) { raf = 0; return; }
    raf = requestAnimationFrame(tick); frameN++;
    const p = P(), c = clip();
    if (p && c) {
      if (p.t !== lastT) { lastT = p.t; dirty.tl = dirty.path = dirty.top = true; if (!p.playing || frameN % 2 === 0) dirty.vals = true; if (p.playing && TL.W) { const x = X(p.t); if (x > TL.W - 24 || x < 0) ed.scroll = Math.max(0, p.t - 24 / ed.zoom); } }
      if (p.playing !== top._pl) { top._pl = p.playing; dirty.top = true; }
    }
    if (dirty.side) renderSide();
    if (dirty.list) renderList();
    if (dirty.vals) updVals();
    if (dirty.tl) drawTL();
    if (dirty.path) drawPath();
    if (dirty.top) syncTop();
    if (ceDraw && frameN % 2 === 0) ceDraw();
    if (meterUpd && frameN % 3 === 0) meterUpd();
  };
  raf = requestAnimationFrame(tick);
}

/* =================================================================== keyboard */
addEventListener('keydown', (e) => {
  if (!ed.mode || e.target.closest('input, textarea, select') || !$('modal').classList.contains('hidden')) return;
  const k = e.key, lk = k.toLowerCase(), c = clip(); if (!c) return;
  let ok = true;
  if (k === ' ') togglePlay();
  else if (k === 'Home') setT(0);
  else if (k === 'End') setT(c.dur);
  else if (k === ',' || k === '<') step(e.shiftKey ? -10 : -1);
  else if (k === '.' || k === '>') step(e.shiftKey ? 10 : 1);
  else if ((k === 'ArrowLeft' || k === 'ArrowRight') && (ed.selKeys.size || ed.selEv.size) && !e.ctrlKey) {
    const d = (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1) / c.fps;
    for (const { k: key } of selected(c)) key.t = Math.max(0, A.snapT(c, key.t + d)); for (const ev of ed.selEv) ev.t = Math.max(0, ev.t + d);
    c.tracks.forEach(A.sortKeys); clearTimeout(c._nt); c._nt = setTimeout(() => commit(), 300); dirtyAll();
  }
  else if ((k === 'ArrowLeft' || k === 'ArrowRight') && !selL()) step((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
  else if (lk === 'j' && !e.ctrlKey) jumpKey(-1);
  else if (lk === 'l' && !e.ctrlKey) jumpKey(1);
  else if (lk === 'k' && !e.ctrlKey) addKeyAll();
  else if (lk === 'g' && !e.ctrlKey) { ed.view = ed.view === 'graph' ? 'dope' : 'graph'; dirtyAll(); }
  else if ((k === 'Delete' || k === 'Backspace') && (ed.selKeys.size || ed.selEv.size)) deleteSel();
  // mouse over the stage with no keyframes selected: Ctrl+C / X / V work on the layers themselves
  else if (e.ctrlKey && ['c', 'x', 'v'].includes(lk) && studio.overStage() && !ed.selKeys.size && !ed.selEv.size) ok = false;
  else if (e.ctrlKey && lk === 'c') copyKeys(false);
  else if (e.ctrlKey && lk === 'x' && ed.selKeys.size) copyKeys(true);
  else if (e.ctrlKey && lk === 'v' && clipboard) pasteKeys();
  else if (k === 'F2' && !selL()) renameClip(c);
  else if (e.ctrlKey && lk === 'a') selectAllKeys();
  else if (k === 'Escape' && (ed.selKeys.size || ed.selEv.size)) { ed.selKeys.clear(); ed.selEv.clear(); ed.selBars.clear(); dirtyAll(); }
  else ok = false;
  if (ok) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
// clip hotkeys (live mode)
const held = new Map();
addEventListener('keydown', (e) => {
  if (ed.mode || e.repeat || (e.target.closest && e.target.closest('input, textarea, select')) || !$('modal').classList.contains('hidden')) return;
  const combo = comboOf(e); if (!combo) return;
  for (const c of clips()) if (c.hot && c.hot === combo) { A.command(scene(), c.hotVerb || 'play', c.id, 'start', liveEnv); if (c.hotVerb === 'hold') held.set(e.code, c.id); e.preventDefault(); }
});
addEventListener('keyup', (e) => { const id = held.get(e.code); if (id) { held.delete(e.code); A.command(scene(), 'hold', id, 'end', liveEnv); } });

/* ========================================================================= boot */
export function startAnim() {
  // saves made before this rule: put single start keys into place once
  for (const sc of studio.scenes()) A.clipsOf(sc).forEach(A.fixClip);
  let baked = 0; for (const sc of studio.scenes()) baked += bakeStatic(sc);
  if (baked) { studio.rebaseNow(); studio.refreshAll(); }
  const dock = $('dock');
  const b = el('button', 'dock-btn', `${icon('anim')}<em>${T`แอนิเมชัน (โหมดแก้ไข)`}</em>`); b.id = 'dock-anim';
  dock.append(el('i', 'dock-sep'), b);
  b.onclick = () => (ed.mode ? exit() : enter());
  for (const s of studio.scenes()) for (const c of s.clips || []) A.fixClip(c);
  // gesture bindings / timeline events → clips
  bus.on('cmd', (cmd, phase) => {
    if (typeof cmd !== 'string' || !cmd.startsWith('anim:')) return;
    const [, verb, id] = cmd.split(':');
    if (ed.mode && id !== ed.clipId) return; // while editing only the clip on the timeline listens
    A.command(scene(), verb, id, phase || 'start', ed.mode ? { fire: null } : liveEnv);
    dirty.top = true;
  });
  bus.on('anim:event', runAction);
  bus.on('anim:open', (id) => { if (!ed.mode) enter(); if (clips().some((c) => c.id === id)) switchClip(id); dirtyAll(); });
  bus.on('select', () => { if (!ed.mode) return; const L = selL(); if (L && !fromTL) autoExpand(L.id); dirtyAll(); });
  bus.on('renamed', () => { if (ed.mode) dirtyAll(); });
  bus.on('studio:refresh', () => {
    if (!ed.mode) return;
    clips().forEach(A.fixClip);
    if (!clip()) { if (!clips().length) clips().push(A.newClip(T`แอนิเมชัน 1`)); ed.clipId = clips()[0].id; }
    pruneSel(); dirtyAll();
  });
  bus.on('added', () => { if (ed.mode) dirtyAll(); });
  bus.on('hand:binds', () => { if (ed.mode) dirty.side = true; });
  bus.on('hand:cfg', () => { if (ed.mode && ed.tab === 'trig') dirty.side = true; });
  bus.on('theme', () => { if (ed.mode) dirtyAll(); });
  addEventListener('resize', () => { if (ed.mode) { placeTop(); document.body.style.setProperty('--tl-h', Math.min(ed.tlH, Math.round(innerHeight * 0.62)) + 'px'); dirtyAll(); } });
}
export const anim = { enter, exit, get on() { return ed.mode; } };
