// Hand tracking manager: feeds camera frames to the worker, keeps a stable "track" per hand, smooths the 21 landmarks
// (One Euro filter), predicts them forward to hide the model's latency, and turns finger poses into named gestures.
import { needAi, dropAi, aiOptions, aiInfo, onAi } from './ai.js';
import { api, native, bus, T } from './core.js';
import { faceExprName, faceExprEmoji } from './facedefs.js';
import { predict, trainedSet, customList, customPairList, predictPair, trainedPairSet } from './handml.js';
const log = (m) => { try { if (native) api.invoke('app:log', m); } catch { /* */ } };

export const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
export const TIPS = [4, 8, 12, 16, 20];
// id · emoji · label   (static poses first, then motion gestures)
export const gestureList = () => [
  ['palm', '🖐️', T`แบมือ`], ['fist', '✊', T`กำมือ`], ['point', '☝️', T`ชี้นิ้ว`], ['peace', '✌️', T`ชูสองนิ้ว`],
  ['three', '3️⃣', T`ชูสามนิ้ว`], ['four', '4️⃣', T`ชูสี่นิ้ว`], ['thumbup', '👍', T`ยกนิ้วโป้ง`], ['thumbdown', '👎', T`คว่ำนิ้วโป้ง`],
  ['ok', '👌', T`ท่าโอเค`], ['pinch', '🤏', T`จีบนิ้ว`], ['rock', '🤘', T`ท่าร็อก`], ['love', '🤟', T`ท่ารักเธอ`], ['call', '🤙', T`ท่าโทรศัพท์`], ['gun', '👉', T`ท่าตัว L`],
  ['swipe-left', '⬅️', T`ปัดมือไปซ้าย`], ['swipe-right', '➡️', T`ปัดมือไปขวา`], ['swipe-up', '⬆️', T`ปัดมือขึ้น`], ['swipe-down', '⬇️', T`ปัดมือลง`],
];
export const STATIC = () => gestureList().filter((g) => !g[0].startsWith('swipe')).map((g) => g[0]);
// two-hand poses: both hands together make one sign (built-in ones work from rules, and can be taught for accuracy)
const PAIRS = () => [['pair:heart', '🫶', T`หัวใจสองมือ`], ['pair:pray', '🙏', T`พนมมือ`]];
export const pairList = () => [...PAIRS().map((g) => g[0]), ...customPairList().map((c) => 'pair:c:' + c.id)];
export const gestureName = (id) => {
  id = String(id);
  if (id === 'none') return '💤 ' + T`ไม่มีท่า`;
  if (id === 'pair:none') return '💤 ' + T`สองมือไม่ได้ทำท่า`;
  if (id.startsWith('f:')) return faceExprName(id) || T`ท่าที่ลบไปแล้ว`;
  if (id.startsWith('pair:c:')) { const p = customPairList().find((x) => 'pair:c:' + x.id === id); return p ? '👐 ' + p.name : T`ท่าที่ลบไปแล้ว`; }
  if (id.startsWith('pair:')) { const g = PAIRS().find((x) => x[0] === id); return g ? `${g[1]} ${g[2]}` : ''; }
  if (id.startsWith('c:')) { const p = customList().find((x) => 'c:' + x.id === id); return p ? '⭐ ' + p.name : T`ท่าที่ลบไปแล้ว`; }
  const g = gestureList().find((x) => x[0] === id); return g ? `${g[1]} ${g[2]}` : '';
};
export const gestureEmoji = (id) => {
  id = String(id);
  if (id === 'none' || id === 'pair:none') return '💤';
  if (id.startsWith('f:')) return faceExprEmoji(id);
  if (id.startsWith('pair:c:')) return '👐';
  if (id.startsWith('pair:')) { const g = PAIRS().find((x) => x[0] === id); return g ? g[1] : ''; }
  if (id.startsWith('c:')) return '⭐';
  const g = gestureList().find((x) => x[0] === id); return g ? g[1] : '';
};

/* ------------------------------------------------------------ two-hand poses */
// both hands' 21 points in picture space, placed relative to the point between the palms and scaled by hand size;
// the hand further left in the picture always comes first
export function pairFeatures(ta, tb, out = new Float32Array(84)) {
  const ar = hands.ar, [a, b] = palmOf(ta.lm)[0] <= palmOf(tb.lm)[0] ? [ta, tb] : [tb, ta];
  const pa = palmOf(a.lm), pb = palmOf(b.lm), cx = (pa[0] + pb[0]) / 2 * ar, cy = (pa[1] + pb[1]) / 2;
  const sz = (h) => Math.hypot((h.lm[0] - h.lm[27]) * ar, h.lm[1] - h.lm[28]);
  const scale = Math.max(1e-3, (sz(a) + sz(b)) / 2);
  let k = 0;
  for (const h of [a, b]) for (let i = 0; i < 21; i++) { out[k++] = (h.lm[i * 3] * ar - cx) / scale; out[k++] = (h.lm[i * 3 + 1] - cy) / scale; }
  return out;
}
const P = (f, h, i) => [f[h * 42 + i * 2], f[h * 42 + i * 2 + 1]];
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
function pairRule(f) {
  // 🫶 index tips meet at the top, thumb tips meet at the bottom, with a gap (the heart) between the hands
  const i0 = P(f, 0, 8), i1 = P(f, 1, 8), t0 = P(f, 0, 4), t1 = P(f, 1, 4), w0 = P(f, 0, 0), w1 = P(f, 1, 0);
  if (dist(i0, i1) < 0.55 && dist(t0, t1) < 0.55 && (i0[1] + i1[1]) / 2 < (t0[1] + t1[1]) / 2 - 0.35 && dist(w0, w1) > 0.6) return 'pair:heart';
  // 🙏 palms together, fingers up
  const m0 = P(f, 0, 12), m1 = P(f, 1, 12), c0 = P(f, 0, 9), c1 = P(f, 1, 9);
  if (dist(c0, c1) < 0.55 && dist(m0, m1) < 0.45 && (m0[1] + m1[1]) / 2 < (w0[1] + w1[1]) / 2 - 0.6) return 'pair:pray';
  return '';
}
export const pair = { g: '', raw: '', n: 0, since: 0, conf: null, ids: [], f: new Float32Array(84), live: false, recent: [] };
function updatePair(ts) {
  const fresh = hands.tracks.filter((t) => t.seen === ts).sort((x, y) => x.born - y.born);
  let g = '';
  pair.live = fresh.length >= 2;
  if (pair.live) {
    pairFeatures(fresh[0], fresh[1], pair.f); pair.ids = [fresh[0].id, fresh[1].id];
    pair.recent.push(Float32Array.from(pair.f)); while (pair.recent.length > 12) pair.recent.shift();
    g = pairRule(pair.f);
    const pr = predictPair(pair.f);
    pair.conf = pr ? pr.conf : null; pair.pred = pr ? pr.label : '';
    if (pr) {
      const sure = !pr.far && pr.conf >= (pr.label === pair.g || (pr.label === 'pair:none' && !pair.g) ? 0.45 : 0.6);
      if (sure) g = pr.label === 'pair:none' ? '' : pr.label;
      else if (trainedPairSet().has(g)) g = '';
    }
  } else { pair.ids = []; pair.conf = null; pair.recent.length = 0; }
  if (g === pair.raw) pair.n++; else { pair.raw = g; pair.n = 1; }
  if (g !== pair.g && (g ? pair.n >= 3 : pair.n >= 4)) { const prev = pair.g; pair.g = g; pair.since = ts; bus.emit('hand:pair', g, prev); }
}

const cfg = { hands: 2, gpu: true, smooth: 50, predict: 70, swap: false, poses: [] };
let busy = false, nextId = 1, resN = 0, resT = 0;
export const hands = { state: 'off', delegate: '', err: '', tracks: [], fps: 0, ms: 0, ar: 16 / 9, last: 0, training: false, pair: null };

const alpha = (dt, fc) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
const d3 = (w, a, b) => Math.hypot(w[a * 3] - w[b * 3], w[a * 3 + 1] - w[b * 3 + 1], w[a * 3 + 2] - w[b * 3 + 2]);
const cosAt = (w, a, b, c) => { // angle between a→b and b→c
  const ux = w[b * 3] - w[a * 3], uy = w[b * 3 + 1] - w[a * 3 + 1], uz = w[b * 3 + 2] - w[a * 3 + 2];
  const vx = w[c * 3] - w[b * 3], vy = w[c * 3 + 1] - w[b * 3 + 1], vz = w[c * 3 + 2] - w[b * 3 + 2];
  return (ux * vx + uy * vy + uz * vz) / (Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz) || 1);
};

export function setHandOptions(o) {
  const was = { hands: cfg.hands, gpu: cfg.gpu };
  Object.assign(cfg, o);
  if (hands.state === 'ready' && (was.hands !== cfg.hands || was.gpu !== cfg.gpu)) aiOptions('hand', { hands: cfg.hands, gpu: cfg.gpu });
}
// the hand model lives in the shared AI worker (ai.js / ai-worker.js)
function start() { hands.state = 'loading'; hands.err = ''; needAi('hand', { hands: cfg.hands, gpu: cfg.gpu }); syncState(); }
function syncState() {
  const i = aiInfo('hand'), was = hands.state;
  if (hands.state === 'off' && i.state === 'off') return;
  hands.state = i.state; hands.delegate = i.delegate || ''; hands.err = i.err || '';
  if (i.state !== 'ready') busy = false;
  if (was !== hands.state) { if (hands.state === 'ready') log(`hand tracker ready (${hands.delegate})`); else if (hands.state === 'failed') log(`hand tracker FAILED ${hands.err}`); bus.emit('hand:state'); }
}
bus.on('ai:state', (m) => { if (m === 'hand') syncState(); });
onAi('hand', (r, ts) => { busy = false; hands.ms += (r.ms - hands.ms) * 0.2; if (hands.state === 'ready') onResult({ ts, hands: r.hands }); });
// drop hands that have not been seen for a while (also when the camera stopped sending pictures)
export function pruneHands(now) {
  for (let i = hands.tracks.length - 1; i >= 0; i--) if (now - hands.tracks[i].seen > 500) { const [tr] = hands.tracks.splice(i, 1); bus.emit('hand:lost', tr); }
  if (hands.tracks.length < 2 && pair.g) { const prev = pair.g; pair.g = pair.raw = ''; pair.n = 0; pair.live = false; bus.emit('hand:pair', '', prev); }
}
export function stopHands() {
  dropAi('hand');
  for (const tr of hands.tracks) bus.emit('hand:lost', tr);
  pair.g = pair.raw = ''; pair.n = 0; pair.live = false;
  hands.tracks.length = 0; hands.state = 'off'; hands.fps = 0; busy = false; bus.emit('hand:state');
}
export function retryHands() { stopHands(); }

// called every frame while hand tracking is on: starts the model; true once it can take pictures
// (the picture itself is sent by the studio together with the face job — see trackAi in studio.js)
export function handsReady() {
  if (hands.state === 'off') start();
  return hands.state === 'ready';
}

/* ----------------------------------------------------------------- tracks */
function newTrack(h, ts) {
  const lm = new Float32Array(h.lm);
  return {
    id: nextId++, side: 'R', sideScore: 0, born: ts, t: ts, seen: ts, lm, w: new Float32Array(h.w), fdx: new Float32Array(42), vel: new Float32Array(42),
    p: new Float32Array(42), palm: [0, 0], size: 0.2, ang: 0, ext: [false, false, false, false, false], pin: false, pinM: false, pinch: 1, pinchM: 1,
    g: '', gRaw: '', gN: 0, gSince: ts, gLost: 0, hist: [], swipeAt: 0, fresh: true,
    sn: new Float32Array(63), recent: [], conf: null, pred: '',
  };
}
const palmOf = (lm) => [(lm[0] + lm[15] + lm[27] + lm[39] + lm[51]) / 5, (lm[1] + lm[16] + lm[28] + lm[40] + lm[52]) / 5];

function onResult(d) {
  const ts = d.ts, list = d.hands;
  hands.last = ts;
  resN++; if (ts - resT >= 1000) { hands.fps = Math.round(resN * 1000 / (ts - resT)); resN = 0; resT = ts; }
  // match detections to the existing tracks (nearest palm first)
  const pairs = [];
  list.forEach((h, hi) => { const c = palmOf(h.lm); hands.tracks.forEach((tr, ti) => { const q = palmOf(tr.lm), dist = Math.hypot((c[0] - q[0]) * hands.ar, c[1] - q[1]); if (dist < 0.35) pairs.push([dist, hi, ti]); }); });
  pairs.sort((a, b) => a[0] - b[0]);
  const usedH = new Set(), usedT = new Set();
  for (const [, hi, ti] of pairs) { if (usedH.has(hi) || usedT.has(ti)) continue; usedH.add(hi); usedT.add(ti); update(hands.tracks[ti], list[hi], ts); }
  list.forEach((h, hi) => { if (usedH.has(hi)) return; const tr = newTrack(h, ts); hands.tracks.push(tr); update(tr, h, ts); });
  for (let i = hands.tracks.length - 1; i >= 0; i--) if (ts - hands.tracks[i].seen > 320) { const [tr] = hands.tracks.splice(i, 1); bus.emit('hand:lost', tr); }
  updatePair(ts);
  bus.emit('hand:result', ts);
}

function update(tr, h, ts) {
  const dt = Math.min(0.2, Math.max(1 / 120, (ts - tr.t) / 1000)), s = cfg.smooth / 100;
  const minCut = 3.2 - 2.6 * s, beta = 34 - 26 * s, ad = alpha(dt, 1.2), lm = tr.lm, raw = h.lm;
  if (tr.fresh) tr.fresh = false;
  else for (let i = 0; i < 21; i++) for (let c = 0; c < 2; c++) {
    const j = i * 3 + c, k = i * 2 + c, prev = lm[j], x = raw[j];
    tr.fdx[k] += ad * ((x - prev) / dt - tr.fdx[k]);
    const xf = prev + alpha(dt, minCut + beta * Math.abs(tr.fdx[k])) * (x - prev);
    tr.vel[k] += 0.55 * ((xf - prev) / dt - tr.vel[k]);
    lm[j] = xf; lm[j + 2] = raw[j + 2];
  }
  for (let i = 0; i < 63; i++) tr.w[i] += 0.6 * (h.w[i] - tr.w[i]);
  tr.t = tr.seen = ts;
  // MediaPipe names the hand as if the picture were mirrored; a raw camera picture is not, so its "Left" is the user's right hand
  const right = (h.label === 'Left') !== !!cfg.swap;
  tr.sideScore += ((right ? 1 : -1) * (0.4 + h.score * 0.6) - tr.sideScore) * (ts - tr.born < 200 ? 0.6 : 0.15);
  tr.side = tr.sideScore >= 0 ? 'R' : 'L';
  // the hand's shape as if it were a right hand: what the personal model learns from and is asked about
  const mx = tr.side === 'L' ? -1 : 1;
  for (let i = 0; i < 21; i++) { tr.sn[i * 3] = tr.w[i * 3] * mx; tr.sn[i * 3 + 1] = tr.w[i * 3 + 1]; tr.sn[i * 3 + 2] = tr.w[i * 3 + 2]; }
  tr.recent.push({ ts, w: Float32Array.from(tr.sn) }); while (tr.recent.length > 12) tr.recent.shift();
  classify(tr, ts);
  swipe(tr, ts);
}

/* --------------------------------------------------------------- gestures */
function fingers(tr) {
  const w = tr.w, e = tr.ext, pw = d3(w, 5, 17) || 0.08;
  for (let f = 1; f < 5; f++) {
    const m = 1 + f * 4, c = cosAt(w, m, m + 1, m + 3);
    e[f] = c > (e[f] ? 0.15 : 0.45) && d3(w, m + 3, 0) > d3(w, m + 1, 0) * (e[f] ? 0.95 : 1.05);
  }
  e[0] = d3(w, 4, 5) > pw * (e[0] ? 0.55 : 0.68) && cosAt(w, 2, 3, 4) > 0.3;
  tr.pinch = d3(w, 4, 8) / pw; tr.pinchM = d3(w, 4, 12) / pw;
  tr.pin = tr.pinch < (tr.pin ? 0.46 : 0.3) && d3(w, 8, 5) > pw * 0.45;
  tr.pinM = !tr.pin && tr.pinchM < (tr.pinM ? 0.46 : 0.3) && d3(w, 12, 9) > pw * 0.45;
  return pw;
}
// (shape matching lives in handml.js)
const _norm = (w, side, pw) => { const o = new Array(63), sx = side === 'L' ? -1 : 1; for (let i = 0; i < 21; i++) { o[i * 3] = (w[i * 3] - w[0]) / pw * sx; o[i * 3 + 1] = (w[i * 3 + 1] - w[1]) / pw; o[i * 3 + 2] = (w[i * 3 + 2] - w[2]) / pw; } return o; };


function classify(tr, ts) {
  const pw = fingers(tr), e = tr.ext, lm = tr.lm;
  let g = '';
  if (!g) {
    const key = (e[0] ? 'T' : '') + (e[1] ? 'I' : '') + (e[2] ? 'M' : '') + (e[3] ? 'R' : '') + (e[4] ? 'P' : '');
    if (tr.pin) g = e[2] && e[3] && e[4] ? 'ok' : 'pinch';
    else if (key === 'T') { const dx = (lm[12] - lm[6]) * hands.ar, dy = lm[13] - lm[7], len = Math.hypot(dx, dy) || 1; g = -dy > len * 0.6 ? 'thumbup' : dy > len * 0.6 ? 'thumbdown' : ''; }
    else g = { '': 'fist', I: 'point', TI: 'gun', IM: 'peace', TIM: 'three', IMR: 'three', IMRP: 'four', TIMRP: 'palm', IP: 'rock', TIP: 'love', TP: 'call' }[key] || '';
  }
  // the user's own taught poses win whenever the personal model is sure; poses it was never taught still come from the rules
  const pr = predict(tr.sn);
  tr.conf = pr ? pr.conf : null; tr.pred = pr ? pr.label : '';
  if (pr) {
    const sure = !pr.far && pr.conf >= (pr.label === tr.g || (pr.label === 'none' && !tr.g) ? 0.45 : 0.6);
    if (sure) g = pr.label === 'none' ? '' : pr.label;
    else if (trainedSet().has(g)) g = '';
  }
  if (g === tr.gRaw) tr.gN++; else { tr.gRaw = g; tr.gN = 1; }
  if (g !== tr.g && (g ? tr.gN >= 3 : tr.gN >= 5)) { const prev = tr.g; tr.g = g; tr.gSince = ts; bus.emit('hand:gesture', tr, g, prev); }
}
function swipe(tr, ts) {
  const c = palmOf(tr.lm), hst = tr.hist;
  hst.push([ts, c[0] * hands.ar, c[1]]);
  while (hst.length && ts - hst[0][0] > 260) hst.shift();
  const open = tr.ext[1] + tr.ext[2] + tr.ext[3] + tr.ext[4] >= 3;
  if (!open || ts - tr.swipeAt < 750 || hst.length < 4 || ts - hst[0][0] < 120) return;
  const dx = hst[hst.length - 1][1] - hst[0][1], dy = hst[hst.length - 1][2] - hst[0][2];
  let dir = '';
  if (Math.abs(dx) > 0.26 && Math.abs(dx) > Math.abs(dy) * 2) dir = (dx < 0) !== !!cfg.swap ? 'swipe-right' : 'swipe-left'; // raw camera picture: the user's right is the picture's left
  else if (Math.abs(dy) > 0.24 && Math.abs(dy) > Math.abs(dx) * 2) dir = dy < 0 ? 'swipe-up' : 'swipe-down';
  if (dir) { tr.swipeAt = ts; hst.length = 0; bus.emit('hand:swipe', tr, dir); }
}

/* ------------------------------------------------- per-frame predicted pose */
// Landmarks describe a frame that is already a few tens of milliseconds old. Lead them along their velocity so that
// things attached to the hand sit on the hand in the picture being drawn right now.
export function poseHands(now) {
  const k = cfg.predict / 100;
  for (const tr of hands.tracks) {
    const lead = Math.min(0.07, Math.max(0, (now - tr.t) / 1000)) * k, p = tr.p, lm = tr.lm;
    for (let i = 0; i < 21; i++) { p[i * 2] = lm[i * 3] + tr.vel[i * 2] * lead; p[i * 2 + 1] = lm[i * 3 + 1] + tr.vel[i * 2 + 1] * lead; }
    tr.palm[0] = (p[0] + p[10] + p[18] + p[26] + p[34]) / 5; tr.palm[1] = (p[1] + p[11] + p[19] + p[27] + p[35]) / 5;
    const ux = (p[18] - p[0]) * hands.ar, uy = p[19] - p[1];
    tr.size = Math.max(Math.hypot(ux, uy), Math.hypot((p[10] - p[34]) * hands.ar, p[11] - p[35]) * 1.25); // in units of picture height
    tr.ang = Math.atan2(ux, -uy); // 0 = fingers pointing up, clockwise positive
  }
}
// 'any' | 'left' | 'right' → track (the hand that has been visible longest wins for 'any')
export function pickHand(side) {
  let best = null;
  for (const tr of hands.tracks) { if ((side === 'left' && tr.side !== 'L') || (side === 'right' && tr.side !== 'R')) continue; if (!best || tr.born < best.born) best = tr; }
  return best;
}

hands.pair = pair;
