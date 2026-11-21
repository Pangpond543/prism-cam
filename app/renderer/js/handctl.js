// Hand control: gesture → command bindings, macros, and the hand-driven mouse.
// Commands that touch the PC (keys, mouse, opening programs) only run while the user has armed "control this PC";
// commands that stay inside Prism Cam (scenes, snapshot …) always run.
import { api, native, bus, T, toast } from './core.js';
import { hands, pickHand } from './hands.js';
import { studio } from './studio.js';
import { prof } from './handml.js';
import { faceExprSince, handsNearFace } from './face.js';

export const ctl = { armed: false, mouse: false };
let warnAt = 0, mouseTrack = null;

export async function setArmed(on) {
  if (on && !native) { toast(T`การควบคุมเครื่องใช้ได้เฉพาะในโปรแกรม Prism Cam บน Windows`, { kind: 'err' }); return; }
  if (native) await api.invoke('input:arm', !!on).catch(() => {});
  ctl.armed = !!on;
  if (!on) { ctl.mouse = false; endMouse(); for (const s of bs.values()) s.fired = false; }
  bus.emit('hand:ctl');
}
export function setMouse(on) {
  if (on && !ctl.armed) { toast(T`เปิดสวิตช์ “ควบคุมเครื่องนี้” ก่อน แล้วจึงเปิดโหมดเมาส์`, { kind: 'err' }); return; }
  ctl.mouse = !!on;
  if (!on) endMouse();
  else {
    studio.hand().on = true;
    if (!(prof() && prof().mouse)) import('./handtrain.js').then((m) => m.calibrateMouse()); // first time: measure this hand's pinch
    else toast(T`โหมดเมาส์ทำงานแล้ว — จีบโป้ง+ชี้ = คลิก · โป้ง+กลาง = คลิกขวา · โป้ง+นาง = เลื่อน · กำมือ = ยกเมาส์`);
  }
  bus.emit('hand:ctl'); bus.emit('hand:cfg');
}
api.on('input:panic', () => { ctl.armed = false; ctl.mouse = false; endMouse(); bus.emit('hand:ctl'); toast(T`หยุดการควบคุมเครื่องแล้ว (Ctrl+Shift+F12)`); });

function run(steps) {
  if (!steps.length) return;
  if (!ctl.armed) { const now = performance.now(); if (now - warnAt > 6000) { warnAt = now; toast(T`คำสั่งนี้ต้องเปิดสวิตช์ “ควบคุมเครื่องนี้” ในแท็บมือก่อน`, { kind: 'err' }); } return; }
  api.invoke('input:run', steps).then((r) => { if (r && !r.ok && r.reason === 'key') toast(T`ไม่รู้จักชื่อคีย์: ${r.detail}`, { kind: 'err' }); else if (r && !r.ok && r.reason === 'open') toast(T`เปิดไม่ได้: ${r.detail}`, { kind: 'err' }); }, () => {});
}

/* ------------------------------------------------------------------ macros */
// one step per line:  ctrl+c · wait 300 · type hello · down shift · up shift · click left · scroll -3 · open notepad.exe
export function parseMacro(script) {
  const out = [];
  for (const raw of String(script || '').split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const sp = line.search(/\s/), head = (sp < 0 ? line : line.slice(0, sp)).toLowerCase(), rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    if (head === 'wait' || head === 'รอ') out.push({ k: 'wait', n: Math.max(0, parseFloat(rest) || 0) });
    else if (head === 'type' || head === 'พิมพ์') out.push({ k: 'text', v: rest });
    else if (head === 'down' || head === 'กดค้าง') out.push({ k: 'down', v: rest });
    else if (head === 'up' || head === 'ปล่อย') out.push({ k: 'up', v: rest });
    else if (head === 'click' || head === 'คลิก') out.push({ k: 'click', v: { right: 'right', ขวา: 'right', middle: 'middle', กลาง: 'middle', double: 'double', สองครั้ง: 'double' }[rest.toLowerCase()] || 'left' });
    else if (head === 'scroll' || head === 'เลื่อน') out.push({ k: 'scroll', n: parseFloat(rest) || 0 });
    else if (head === 'open' || head === 'เปิด') out.push({ k: 'open', v: rest });
    else out.push({ k: 'keys', v: line });
  }
  return out;
}

/* ---------------------------------------------------------------- bindings */
const bs = new Map(); // binding id → { fired, last }
const sideOk = (tr, side) => side === 'any' || !side || (side === 'left' ? tr.side === 'L' : tr.side === 'R');
export function fire(b, phase = 'start') {
  const a = b.action || {};
  if (phase !== 'end') bus.emit('hand:fired', b);
  if (a.type === 'key') { if (!a.keys) return; run([{ k: phase === 'end' ? 'up' : b.mode === 'hold' ? 'down' : 'keys', v: a.keys }]); return; }
  if (phase === 'end') { if (a.type === 'app' && String(a.cmd || '').startsWith('anim:')) bus.emit('cmd', a.cmd, 'end'); return; }
  if (a.type === 'text') run([{ k: 'text', v: a.text || '' }]);
  else if (a.type === 'macro') run(parseMacro(a.script));
  else if (a.type === 'open') run([{ k: 'open', v: a.path || '', a: a.args || '' }]);
  else if (a.type === 'mouse') run(a.btn === 'scrollup' ? [{ k: 'scroll', n: 3 }] : a.btn === 'scrolldown' ? [{ k: 'scroll', n: -3 }] : [{ k: 'click', v: a.btn || 'left' }]);
  else if (a.type === 'app') {
    if (a.cmd === 'mouse') setMouse(!ctl.mouse);
    else if (a.cmd === 'arm-off') setArmed(false);
    else if (a.cmd) bus.emit('cmd', a.cmd);
  }
}
function tickBinds(now) {
  for (const tr of hands.tracks) tr.hold = 0;
  hands.faceHold = null; // { k: 0..1, zone } — the preview draws a ring around that spot of the face
  if (hands.training) { for (const [id, s] of bs) if (s.fired) { s.fired = false; const b = studio.hand().binds.find((x) => x.id === id); if (b && b.mode === 'hold') fire(b, 'end'); } return; } // never fire commands while teaching gestures
  for (const b of studio.hand().binds) {
    if (!b.on || !b.gesture || b.gesture.startsWith('swipe')) continue;
    const s = bs.get(b.id) || bs.set(b.id, { fired: false, last: 0 }).get(b.id);
    if (b.gesture.startsWith('f:')) { // a face gesture (expression / head move / hand on the face)
      const since = faceExprSince(b.gesture);
      if (since) { const held = now - since; if (!s.fired) { if (held >= (b.hold || 0)) { s.fired = true; s.last = now; fire(b, 'start'); } } else if (b.mode === 'repeat' && now - s.last >= Math.max(120, b.every || 500)) { s.last = now; fire(b, 'repeat'); } }
      else if (s.fired) { s.fired = false; if (b.mode === 'hold') fire(b, 'end'); }
      continue;
    }
    // two-hand poses come from the pair detector (the hand-side choice does not apply); one-hand poses from a track,
    // or from two tracks making the same pose ("both hands"); "hand position" also asks for the spot of the face
    const isPair = b.gesture.startsWith('pair:'), pr = isPair && hands.pair && hands.pair.g === b.gesture ? hands.pair : null, near = b.near || '';
    let list = null;
    if (pr) list = hands.tracks.filter((t) => pr.ids.includes(t.id));
    else if (!isPair) {
      const ts = hands.tracks.filter((t) => t.g === b.gesture && t !== mouseTrack && now - t.seen < 400 && (b.hand === 'both' || sideOk(t, b.hand)));
      if (b.hand === 'both') list = ts.length >= 2 ? ts.slice(0, 2) : null;
      else { const t = near ? ts.find((x) => handsNearFace([x], near, now)) : ts[0]; list = t ? [t] : null; }
    }
    if (list && near && (list.length > 1 || pr) && !handsNearFace(list, near, now)) list = null;
    // a gesture at the face toggles things (glasses on / off): after it fired, wait a moment before it can again
    if (list && !s.fired && (near || b.hand === 'both') && now - s.last < 1200) list = null;
    if (list && list.length) {
      const held = now - (pr ? pr.since : Math.max(...list.map((t) => t.gSince))), need = b.hold || 0;
      if (!s.fired) {
        if (need >= 250) { for (const t of list) t.hold = Math.max(t.hold, held / need); if (near && (!hands.faceHold || hands.faceHold.k < held / need)) hands.faceHold = { k: Math.min(1, held / need), zone: near }; }
        if (held >= need) { s.fired = true; s.last = now; fire(b, 'start'); }
      } else if (b.mode === 'repeat' && now - s.last >= Math.max(120, b.every || 500)) { s.last = now; fire(b, 'repeat'); }
    } else if (s.fired) { s.fired = false; if (b.mode === 'hold') fire(b, 'end'); }
  }
}
bus.on('hand:swipe', (tr, dir) => { if (tr === mouseTrack || hands.training) return; for (const b of studio.hand().binds) if (b.on && b.gesture === dir && sideOk(tr, b.hand)) fire(b, 'start'); });

/* ------------------------------------------------------------------- mouse */
// A detector made only for the mouse — it never looks at emoji gestures. It measures, in 3D and relative to the
// palm length (so distance from the camera does not matter), how far the thumb tip is from the index, middle and
// ring finger tips:
//   thumb + index  → left button (short pinch = click, hold = drag, two quick pinches = double click)
//   thumb + middle → right click
//   thumb + ring   → scroll: move the hand up / down while pinching
//   fist           → lift the mouse: the cursor stays put while the hand moves, and carries on from there
// Press and release use different distances (and a release has to last a moment), so a held pinch does not drop.
const FING = [8, 12, 16];
const ms = {
  on: false, x: 0.5, y: 0.5, base: [0, 0], d: [1, 1, 1], held: -1, cand: -1, candN: 0, relT: 0, clutch: false, fistN: 0, openN: 0,
  pressAt: 0, pressHand: null, sy: null, acc: 0, trId: 0,
};
export const mouseView = { tr: null, d: ms.d, press: 0.3, release: 0.5, held: -1, clutch: false, state: '' };
hands.mouseView = mouseView; // the stage overlay draws the pinch meter from this
const dd = (w, a, b) => Math.hypot(w[a * 3] - w[b * 3], w[a * 3 + 1] - w[b * 3 + 1], w[a * 3 + 2] - w[b * 3 + 2]);
export function pinchDistances(tr, out = [0, 0, 0]) {
  const w = tr.w, palm = dd(w, 0, 9) || 0.08;
  for (let i = 0; i < 3; i++) out[i] = dd(w, 4, FING[i]) / palm;
  return out;
}
const curled = (w, tip, mcp) => dd(w, tip, 0) < dd(w, mcp, 0) * 1.12;
const isFist = (w) => curled(w, 8, 5) && curled(w, 12, 9) && curled(w, 16, 13) && curled(w, 20, 17);
// press / release distances from this person's calibration (or sensible defaults), shifted by the sensitivity slider
export function thresholds() {
  const c = (prof() && prof().mouse) || { pinch: 0.14, open: 0.95 }, M = studio.hand().mouse, k = (M.sens ?? 50) / 100;
  const span = Math.max(0.2, c.open - c.pinch);
  return { press: c.pinch + span * (0.18 + 0.3 * k), release: c.pinch + span * (0.38 + 0.3 * k) };
}
function release(now) {
  if (ms.held === 0) run([{ k: 'mup', v: 'left' }]);
  ms.held = -1; ms.relT = 0; ms.sy = null; ms.freezeUntil = now + 140; // the opening fingers nudge the hand: hold still a moment
}
function endMouse() {
  hands.zone = null; mouseTrack = null; mouseView.tr = null;
  if (ms.held === 0 && ctl.armed) api.invoke('input:run', [{ k: 'mup', v: 'left' }]).catch(() => {});
  ms.held = -1; ms.cand = -1; ms.candN = 0; ms.sy = null; ms.clutch = false;
  if (ms.on) { ms.on = false; if (native) api.invoke('input:pointer', { on: false }).catch(() => {}); }
}
// the hand left (or was never really there): let go of the cursor and any held button right away
function lostHand() {
  if (ms.held === 0) run([{ k: 'mup', v: 'left' }]);
  ms.held = -1; ms.cand = -1; ms.candN = 0; ms.sy = null; mouseView.tr = null;
  if (ms.on) { ms.on = false; api.invoke('input:pointer', { on: false }).catch(() => {}); }
}
let lastRes = 0;
function tickMouse(now) {
  if (!ctl.mouse || !ctl.armed || hands.training) { if (ms.on || hands.zone) endMouse(); return; }
  const M = studio.hand().mouse, z = Math.min(0.95, Math.max(0.2, M.zone / 100)), x0 = 0.5 - z / 2, y0 = 0.5 - z / 2;
  { const sx = (M.mirror ? 1 : -1) * ms.base[0] * z, sy = -ms.base[1] * z; hands.zone = [x0 + sx, y0 + sy, x0 + z + sx, y0 + z + sy]; }
  // only a hand that is fresh (seen in the last few frames) and has been there a moment may drive the cursor
  let tr = pickHand(M.hand);
  if (tr && (now - tr.seen > 160 || now - tr.born < 220)) tr = null;
  mouseTrack = tr;
  if (!tr) { lostHand(); return; }
  if (tr.id !== ms.trId) { ms.trId = tr.id; ms.d = [1, 1, 1]; ms.held = -1; ms.cand = -1; }
  const th = thresholds();
  // finger measurements: once per tracker result (the frame clock may run faster than the tracker)
  if (tr.seen !== lastRes) {
    lastRes = tr.seen;
    const raw = pinchDistances(tr);
    for (let i = 0; i < 3; i++) ms.d[i] += (raw[i] - ms.d[i]) * 0.6;
    const fist = isFist(tr.w);
    ms.fistN = fist ? ms.fistN + 1 : 0; ms.openN = fist ? 0 : ms.openN + 1;
    if (!ms.clutch && ms.fistN >= 3 && ms.held < 0) ms.clutch = true;
    else if (ms.clutch && ms.openN >= 3) ms.clutch = false;
    if (ms.held >= 0) { // holding: let go only after the fingers have clearly opened for a moment
      if (ms.d[ms.held] > th.release) { ms.relT ||= now; if (now - ms.relT >= 90) release(now); } else ms.relT = 0;
    } else if (!ms.clutch) { // free: the closest finger under the press distance — and clearly closer than the others — presses
      let f = 0; for (let i = 1; i < 3; i++) if (ms.d[i] < ms.d[f]) f = i;
      const others = Math.min(...ms.d.filter((_, i) => i !== f));
      const ok = ms.d[f] < th.press && ms.d[f] < others * 0.75 && (f !== 0 || M.click) && (f !== 1 || M.rclick) && (f !== 2 || M.scroll);
      if (ok && f === ms.cand) ms.candN++; else { ms.cand = ok ? f : -1; ms.candN = ok ? 1 : 0; }
      if (ms.candN >= 2) {
        ms.held = f; ms.cand = -1; ms.candN = 0; ms.pressAt = now; ms.pressHand = null; ms.relT = 0;
        if (f === 0) run([{ k: 'mdown', v: 'left' }]);
        else if (f === 1) run([{ k: 'click', v: 'right' }]);
        else { ms.sy = null; ms.acc = 0; }
      }
    }
  }
  Object.assign(mouseView, { tr, d: ms.d, press: th.press, release: th.release, held: ms.held, clutch: ms.clutch, state: ms.clutch ? 'lift' : ['left', 'right', 'scroll'][ms.held] || 'hover' });
  // cursor anchor: the index + middle knuckles — they barely move while the fingertips pinch
  const px = (tr.p[10] + tr.p[18]) / 2, py = (tr.p[11] + tr.p[19]) / 2;
  let nx = (px - x0) / z, ny = (py - y0) / z;
  if (M.mirror) nx = 1 - nx;
  if (ms.held === 2) { // scroll: vertical hand travel → wheel notches
    if (ms.sy === null) { ms.sy = py; ms.acc = 0; }
    ms.acc += (ms.sy - py) / z * 45; ms.sy = py;
    const n = Math.trunc(ms.acc); if (n) { ms.acc -= n; run([{ k: 'scroll', n }]); }
  }
  // Short freezes (scrolling, right click, the moment of a click, the moment after letting go) only stop the cursor;
  // they never move the hand↔screen mapping, so the dashed frame keeps matching the hand. Only a fist ("lift the
  // mouse") moves the mapping on purpose — and the frame on the preview moves with it.
  const freeze = ms.held === 2 || ms.held === 1 || now < (ms.freezeUntil || 0)
    || (ms.held === 0 && now - ms.pressAt < 400 && (ms.pressHand ||= [nx, ny]) && Math.hypot(nx - ms.pressHand[0], ny - ms.pressHand[1]) < 0.015); // a click, not a drag (yet)
  const lx = x0 / z, ly = y0 / z, cl = (v, a) => Math.min(a, Math.max(-a, v));
  if (ms.clutch) { ms.base[0] = cl(ms.x - nx, lx); ms.base[1] = cl(ms.y - ny, ly); } // frame stays inside the picture
  else if (!freeze) { ms.x = Math.min(1, Math.max(0, nx + ms.base[0])); ms.y = Math.min(1, Math.max(0, ny + ms.base[1])); }
  const sx = (M.mirror ? 1 : -1) * ms.base[0] * z, sy = -ms.base[1] * z;
  hands.zone = [x0 + sx, y0 + sy, x0 + z + sx, y0 + z + sy];
  ms.on = true;
  api.invoke('input:pointer', { on: true, x: ms.x, y: ms.y, glide: 6 + M.glide * 0.9 }).catch(() => {});
}

bus.on('hand:tick', (now) => { tickMouse(now); tickBinds(now); });
bus.on('hand:lost', (tr) => { if (tr === mouseTrack) mouseTrack = null; });
