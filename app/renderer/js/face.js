// Face tracking: MediaPipe face landmarker (478 points + 52 expression scores) running in the shared AI worker.
// Keeps one stable "track" per face, smooths the points (One Euro filter, like the hands), leads them forward to hide
// the model's latency, works out the head angles, and turns expressions into named face gestures (facedefs.js).
// placeFaces() puts every face into scene pixels for the studio (stickers, face paint, avatars, drives, commands).
import { api, native, bus } from './core.js';
import { needAi, dropAi, aiOptions, aiInfo, onAi } from './ai.js';
import { hands } from './hands.js';

const log = (m) => { try { if (native) api.invoke('app:log', m); } catch { /* */ } };
export const FACE_DEF = { faces: 1, smooth: 50, predict: 60, sens: 50, gpu: true, mesh: false, off: false }; // off = face tracking switched off by the user (saves CPU / GPU)
const cfg = { ...FACE_DEF };
// per person / PC (not per project, like the hand profiles): swapped eyes, and the calibrated "resting face"
// calib = { bs: { blendshape -> resting score }, yaw, pitch (raw picture radians), at }
const PKEY = 'prismcam.face';
export const facePerson = { swap: false, calib: null };
try { Object.assign(facePerson, JSON.parse(localStorage.getItem(PKEY) || '{}') || {}); } catch { /* */ }
export function saveFacePerson() { try { localStorage.setItem(PKEY, JSON.stringify(facePerson)); } catch { /* */ } }
export const face = { state: 'off', delegate: '', err: '', tracks: [], ms: 0, fps: 0, ar: 16 / 9, last: 0 };
let nextId = 1, resN = 0, resT = 0, bsIdx = null;
const gone = []; // faces that just went out of sight ({ lm, seen }): two hands in front of the face can hide it for a moment

export function setFaceOptions(o) {
  Object.assign(cfg, o);
  cfg.faces = Math.max(1, Math.min(4, Math.round(cfg.faces || 1)));
  // compare with what the worker was last told (idempotent: called every 20 frames)
  const w = aiInfo('face').opts || {};
  if (face.state === 'ready' && (w.faces !== cfg.faces || (w.gpu !== false) !== (cfg.gpu !== false))) aiOptions('face', { faces: cfg.faces, gpu: cfg.gpu !== false });
}
export const faceCfg = () => cfg;
function syncState() {
  const i = aiInfo('face'), was = face.state, wasD = face.delegate;
  face.state = i.state; face.delegate = i.delegate || ''; face.err = i.err || '';
  if (was === 'ready' && face.state === 'ready' && wasD !== face.delegate) log(`face tracker now on ${face.delegate}`);
  if (i.state === 'off') face.tracks.length = 0;
  if (was !== face.state) { if (face.state === 'ready') log(`face tracker ready (${face.delegate})`); else if (face.state === 'failed') log(`face tracker FAILED ${face.err}`); bus.emit('face:state'); }
}
bus.on('ai:state', (m) => { if (m === 'face') syncState(); });
// called every frame while something uses the face: starts the model; true once it can take pictures
export function facesReady() {
  needAi('face', { faces: cfg.faces, gpu: cfg.gpu !== false });
  if (face.state === 'off') syncState();
  return face.state === 'ready';
}
export function stopFaces() { dropAi('face'); face.tracks.length = 0; face.fps = 0; }

/* ------------------------------------------------------------------ results */
const alpha = (dt, fc) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
const NP = 478;
function newTrack(f, ts) {
  return { id: nextId++, born: ts, t: ts, seen: ts, lm: Float32Array.from(f.lm), fdx: new Float32Array(NP * 2), vel: new Float32Array(NP * 2), p: new Float32Array(NP * 2), bs: {}, fresh: true,
    corr: 0, ear: [0.3, 0.3], earMax: [0.25, 0.25], ex: {}, exOn: new Set() };
}
const cen = (lm) => [lm[1 * 3], lm[1 * 3 + 1]]; // nose tip
onAi('face', (r, ts) => {
  if (face.state !== 'ready') return;
  if (r.names && !bsIdx) { bsIdx = {}; r.names.forEach((n, i) => { bsIdx[n] = i; }); }
  face.ms += (r.ms - face.ms) * (r.ms < face.ms ? 0.4 : 0.2); face.last = ts;
  resN++; if (ts - resT >= 1000) { face.fps = Math.round(resN * 1000 / (ts - resT)); resN = 0; resT = ts; }
  const list = r.faces, pairs = [];
  list.forEach((f, fi) => { const c = cen(f.lm); face.tracks.forEach((tr, ti) => { const q = cen(tr.lm), d = Math.hypot((c[0] - q[0]) * face.ar, c[1] - q[1]); if (d < 0.3) pairs.push([d, fi, ti]); }); });
  pairs.sort((a, b) => a[0] - b[0]);
  const usedF = new Set(), usedT = new Set();
  for (const [, fi, ti] of pairs) { if (usedF.has(fi) || usedT.has(ti)) continue; usedF.add(fi); usedT.add(ti); update(face.tracks[ti], list[fi], ts); }
  list.forEach((f, fi) => { if (usedF.has(fi)) return; const tr = newTrack(f, ts); face.tracks.push(tr); update(tr, f, ts); });
  for (let i = face.tracks.length - 1; i >= 0; i--) if (ts - face.tracks[i].seen > 450) { const [t] = face.tracks.splice(i, 1); gone.push({ lm: t.lm, seen: t.seen }); }
  while (gone.length && (gone.length > 4 || ts - gone[0].seen > 1500)) gone.shift();
  bus.emit('face:result', ts);
});
const BS = ['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'mouthPucker', 'cheekPuff',
  'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookDownLeft', 'mouthFunnel'];
function update(tr, f, ts) {
  const dt = Math.min(0.2, Math.max(1 / 120, (ts - tr.t) / 1000)), s = cfg.smooth / 100;
  const minCut = 3.0 - 2.4 * s, beta = 30 - 22 * s, ad = alpha(dt, 1.2), lm = tr.lm, raw = f.lm;
  if (tr.fresh) tr.fresh = false;
  else for (let i = 0; i < NP; i++) {
    for (let c = 0; c < 2; c++) {
      const j = i * 3 + c, k = i * 2 + c, prev = lm[j], x = raw[j];
      tr.fdx[k] += ad * ((x - prev) / dt - tr.fdx[k]);
      const xf = prev + alpha(dt, minCut + beta * Math.abs(tr.fdx[k])) * (x - prev);
      tr.vel[k] += 0.5 * ((xf - prev) / dt - tr.vel[k]);
      lm[j] = xf;
    }
    lm[i * 3 + 2] += 0.6 * (raw[i * 3 + 2] - lm[i * 3 + 2]);
  }
  if (bsIdx) for (const n of BS) { const v = f.bs[bsIdx[n]] || 0; tr.bs[n] = tr.bs[n] === undefined ? v : tr.bs[n] + (v - tr.bs[n]) * 0.6; }
  // which blendshape eye is the picture's left eye? (decided from the eyelid gap itself, see eyes())
  const earL = ear(lm, 33, 133, 159, 145), earR = ear(lm, 362, 263, 386, 374);
  tr.ear[0] += (earL - tr.ear[0]) * 0.6; tr.ear[1] += (earR - tr.ear[1]) * 0.6;
  for (let e = 0; e < 2; e++) tr.earMax[e] = Math.max(tr.ear[e], tr.earMax[e] * 0.999); // open-eye reference, slowly forgets
  const b1 = tr.bs.eyeBlinkLeft || 0, b2 = tr.bs.eyeBlinkRight || 0;
  tr.corr = tr.corr * 0.995 + (b1 - b2) * (tr.ear[1] - tr.ear[0]);
  tr.t = tr.seen = ts;
}
const ear = (lm, a, b, top, bot) => Math.hypot(lm[top * 3] - lm[bot * 3], (lm[top * 3 + 1] - lm[bot * 3 + 1]) / face.ar) / (Math.hypot(lm[a * 3] - lm[b * 3], (lm[a * 3 + 1] - lm[b * 3 + 1]) / face.ar) || 1);
// how closed each eye of the PICTURE is (0 open … 1 closed): [picture-left eye, picture-right eye]
function eyes(tr) {
  const b1 = bsv(tr, 'eyeBlinkLeft'), b2 = bsv(tr, 'eyeBlinkRight');
  return eyeFlip(tr) ? [b1, b2] : [b2, b1]; // MediaPipe's "Left" is the person's left eye = the picture's right, unless the eyelids say otherwise
}
// true = MediaPipe's "Left" eye is the picture's left one (learned from the eyelids; the user's "swap eyes" flips it)
const eyeFlip = (tr) => (tr.corr > 0.02) !== !!facePerson.swap;
// a blendshape score with the person's resting face taken out (0 at rest ... 1 at full)
function bsv(tr, n) {
  const v = tr.bs[n] || 0, c = facePerson.calib, b = c && c.bs ? Math.min(0.6, c.bs[n] || 0) : 0;
  return b > 0.01 ? Math.max(0, (v - b) / (1 - b)) : v;
}
// head turn / nod in the RAW picture (radians; yaw > 0 = nose to the picture's right, pitch > 0 = up)
function rawAngles(lm) {
  const dx = Math.hypot(lm[454 * 3] - lm[234 * 3], (lm[454 * 3 + 1] - lm[234 * 3 + 1]) / face.ar) || 1e-3;
  const dy = Math.hypot((lm[152 * 3] - lm[10 * 3]) * face.ar, lm[152 * 3 + 1] - lm[10 * 3 + 1]) / face.ar || 1e-3;
  return [Math.atan2(lm[454 * 3 + 2] - lm[234 * 3 + 2], dx), Math.atan2(lm[10 * 3 + 2] - lm[152 * 3 + 2], dy)];
}

/* -------------------------------------------------------------- calibration */
// "fit to your face": the person looks at the camera with a resting face for `ms`; the average expression scores
// and head angle become their zero point (some resting faces read as a slight smile, a camera above the screen
// reads as "looking down"). Resolves { ok, n } (n = pictures used, -1 = cancelled). onTick(0..1, oneFaceSeen).
const CAL_BS = ['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'mouthPucker', 'cheekPuff'];
let calStop = null;
export function calibrateFace(ms = 3000, onTick = () => {}) {
  if (calStop) calStop(-1);
  return new Promise((done) => {
    const sum = {}, ang = [0, 0]; let n = 0, t0 = 0;
    const end = (res) => { bus.off('face:result', tick); calStop = null; done(res); };
    const tick = () => {
      const tr = face.tracks[0];
      if (!tr || face.tracks.length !== 1) { n = 0; t0 = 0; for (const k in sum) sum[k] = 0; ang[0] = ang[1] = 0; onTick(0, false); return; } // start over: exactly one face
      if (!t0) t0 = performance.now();
      for (const k of CAL_BS) sum[k] = (sum[k] || 0) + (tr.bs[k] || 0);
      const a = rawAngles(tr.lm); ang[0] += a[0]; ang[1] += a[1]; n++;
      const p = (performance.now() - t0) / ms; onTick(Math.min(1, p), true);
      if (p < 1) return;
      if (n < 8) { end({ ok: false, n }); return; }
      const bs = {}; for (const k of CAL_BS) bs[k] = +(sum[k] / n).toFixed(3);
      facePerson.calib = { bs, yaw: +(ang[0] / n).toFixed(4), pitch: +(ang[1] / n).toFixed(4), at: Date.now() };
      saveFacePerson(); log(`face calibrated n=${n} ${JSON.stringify(facePerson.calib)}`);
      end({ ok: true, n });
    };
    calStop = (n) => end({ ok: false, n });
    bus.on('face:result', tick);
  });
}
export const cancelFaceCalib = () => { if (calStop) calStop(-1); };
export function clearFaceCalib() { facePerson.calib = null; saveFacePerson(); log('face calibration cleared'); }

/* --------------------------------------------------------- scene placement */
// mapper(u, v) → [x, y]: a point of the picture (0..1) on the stage. flipH: the source is shown mirrored.
// Returns, per face, its 478 points on stage and everything the studio needs.
const FS = [], fsPool = new Map();
export const sceneFaces = FS;
export function placeFaces(now, mapper, flipH, flipV) {
  FS.length = 0;
  const k = cfg.predict / 100;
  for (const tr of face.tracks) {
    let F = fsPool.get(tr.id);
    if (!F) { F = { id: tr.id, tr, p: new Float32Array(NP * 2), z: new Float32Array(NP), born: tr.born }; fsPool.set(tr.id, F); }
    const lead = Math.min(0.07, Math.max(0, (now - tr.t) / 1000)) * k, lm = tr.lm, p = F.p;
    for (let i = 0; i < NP; i++) {
      const [x, y] = mapper(lm[i * 3] + tr.vel[i * 2] * lead, lm[i * 3 + 1] + tr.vel[i * 2 + 1] * lead);
      p[i * 2] = x; p[i * 2 + 1] = y; F.z[i] = lm[i * 3 + 2];
    }
    // right vector: from the scene-left eye to the scene-right eye (the raw picture's right is the person's left)
    let rx = p[263 * 2] - p[33 * 2], ry = p[263 * 2 + 1] - p[33 * 2 + 1]; if (flipH) { rx = -rx; ry = -ry; }
    F.roll = Math.atan2(ry, rx);
    F.w = Math.hypot(p[454 * 2] - p[234 * 2], p[454 * 2 + 1] - p[234 * 2 + 1]);
    F.h = Math.hypot(p[152 * 2] - p[10 * 2], p[152 * 2 + 1] - p[10 * 2 + 1]);
    F.size = Math.max(8, Math.hypot(F.w, F.h * 0.8));
    // head turn from the depth of the face sides / forehead vs chin (x-units; z is in the same scale as x).
    // ryaw / rpitch = the real angle to the camera (stickers squash with it); yaw / pitch = from the person's
    // calibrated resting pose (expressions, characters, drives)
    const [ya, pa] = rawAngles(lm), cal = facePerson.calib, sx = flipH ? -1 : 1, sy = flipV ? -1 : 1;
    F.ryaw = ya * sx; F.rpitch = pa * sy; // yaw > 0 = nose towards the stage's right, pitch > 0 = looking up
    F.yaw = (ya - (cal ? cal.yaw || 0 : 0)) * sx; F.pitch = (pa - (cal ? cal.pitch || 0 : 0)) * sy;
    F.cx = (p[234 * 2] + p[454 * 2]) / 2; F.cy = (p[10 * 2 + 1] + p[152 * 2 + 1]) / 2;
    const e = eyes(tr); F.eyeL = flipH ? e[1] : e[0]; F.eyeR = flipH ? e[0] : e[1]; // closedness of the scene-left / scene-right eye
    const b = tr.bs;
    const v = (n) => bsv(tr, n);
    F.mouth = v('jawOpen'); F.smile = (v('mouthSmileLeft') + v('mouthSmileRight')) / 2;
    F.brow = Math.max(v('browInnerUp'), (v('browOuterUpLeft') + v('browOuterUpRight')) / 2);
    F.blink = (F.eyeL + F.eyeR) / 2; F.kiss = v('mouthPucker'); F.puff = v('cheekPuff');
    // where the eyes look, −1 … 1 (stage left / right, down / up)
    let gx = ((b.eyeLookOutLeft || 0) - (b.eyeLookInLeft || 0) + (b.eyeLookInRight || 0) - (b.eyeLookOutRight || 0)) / 2; // > 0 = towards the picture's right
    if (eyeFlip(tr)) gx = -gx; if (flipH) gx = -gx;
    F.gx = Math.max(-1, Math.min(1, gx)); F.gy = Math.max(-1, Math.min(1, (b.eyeLookUpLeft || 0) - (b.eyeLookDownLeft || 0)));
    F.tr = tr; F.flipH = !!flipH;
    expressions(F, now);
    FS.push(F);
  }
  if (fsPool.size > 8) for (const id of [...fsPool.keys()]) if (!face.tracks.some((t) => t.id === id)) fsPool.delete(id);
  FS.sort((a, b) => a.born - b.born);
  return FS;
}
export const P = (F, i) => [F.p[i * 2], F.p[i * 2 + 1]];
const mid = (F, a, b) => [(F.p[a * 2] + F.p[b * 2]) / 2, (F.p[a * 2 + 1] + F.p[b * 2 + 1]) / 2];
// the point a layer sits on, on stage
export function faceAnchor(F, pt) {
  const fl = F.flipH; // the raw picture's left eye / cheek (33, 468, 50) is on the stage's left unless the source is mirrored
  switch (pt) {
    case 'eyes': { const a = mid(F, 33, 133), b = mid(F, 362, 263); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    case 'eyeL': case 'eyeR': return P(F, (pt === 'eyeL') !== !!fl ? 468 : 473);
    case 'cheekL': case 'cheekR': return P(F, (pt === 'cheekL') !== !!fl ? 50 : 280);
    case 'nose': return P(F, 1);
    case 'under': return P(F, 164);
    case 'mouth': return mid(F, 13, 14);
    case 'chin': return P(F, 152);
    case 'forehead': return P(F, 151);
    case 'top': return P(F, 10);
    case 'face': return [F.cx, F.cy];
    default: return [F.cx, F.cy];
  }
}

/* -------------------------------------------------------------- expressions */
// on: score above `on` × sensitivity for `need` ms; off again below 75 % of that
const NEED = { 'f:eyes': 400, 'f:winkL': 130, 'f:winkR': 130 };
function expressions(F, now) {
  const tr = F.tr, k = 1.25 - (cfg.sens / 100) * 0.5, deg = 180 / Math.PI;
  const userL = F.flipH ? F.eyeL : F.eyeR, userR = F.flipH ? F.eyeR : F.eyeL; // the person's own left / right eye (the raw picture is not mirrored)
  const v = {
    'f:smile': F.smile / (0.5 * k), 'f:mouth': F.mouth / (0.4 * k), 'f:brow': F.brow / (0.55 * k), 'f:kiss': F.kiss / (0.6 * k), 'f:puff': F.puff / (0.45 * k),
    'f:eyes': Math.min(F.eyeL, F.eyeR) / (0.55 * k),
    'f:winkL': userR < 0.35 ? userL / (0.55 * k) : 0, 'f:winkR': userL < 0.35 ? userR / (0.55 * k) : 0,
    'f:turnL': -F.yaw * deg / (22 * k), 'f:turnR': F.yaw * deg / (22 * k), 'f:up': F.pitch * deg / (18 * k), 'f:down': -F.pitch * deg / (15 * k),
    'f:tiltL': -F.roll * deg / (18 * k), 'f:tiltR': F.roll * deg / (18 * k),
    'f:cover': handNear(F, 'cover'), 'f:hush': handNear(F, 'hush'),
  };
  if (F.smile > 0.4) v['f:mouth'] *= 0.6; // a big smile opens the jaw a little — not "mouth open"
  for (const id in v) {
    const on = tr.exOn.has(id), x = v[id];
    if (!on && x >= 1) { const t = tr.ex[id] || (tr.ex[id] = now); if (now - t >= (NEED[id] || 60)) { tr.exOn.add(id); tr.ex[id] = now; bus.emit('face:expr', id, true, F); } }
    else if (!on) delete tr.ex[id];
    else if (x < 0.75) { tr.exOn.delete(id); delete tr.ex[id]; bus.emit('face:expr', id, false, F); }
  }
}
// a hand on the face: palm over the eyes (cover) or an index finger tip on the lips (hush); hand points are picture 0..1
function handNear(F, what) {
  const lm = F.tr.lm, ar = face.ar, fw = Math.hypot((lm[454 * 3] - lm[234 * 3]) * ar, lm[454 * 3 + 1] - lm[234 * 3 + 1]);
  for (const h of hands.tracks) {
    if (what === 'cover') {
      const ex = (lm[33 * 3] + lm[263 * 3]) / 2, ey = (lm[33 * 3 + 1] + lm[263 * 3 + 1]) / 2;
      const d = Math.hypot((h.palm[0] - ex) * ar, h.palm[1] - ey);
      if (h.size > fw * 0.35 && d < fw * 0.45) return 1.2;
    } else {
      const mx = (lm[13 * 3] + lm[14 * 3]) / 2, my = (lm[13 * 3 + 1] + lm[14 * 3 + 1]) / 2;
      if (Math.hypot((h.p[16] - mx) * ar, h.p[17] - my) < fw * 0.14 && h.g === 'point') return 1.2;
    }
  }
  return 0;
}
/* ------------------------------------------------------- hands near the face */
// Is a hand gesture made at a spot of the face? (bindings: "hand position"). Hand and face points are raw picture
// 0..1; distances in picture heights (x × aspect). Zones with two sides (eyes, ears, cheeks) take one hand per side
// when two hands are asked for; a face hidden by the hands still counts for 1.5 s (its last points).
const midp = (lm, a, b) => [(lm[a * 3] + lm[b * 3]) / 2, (lm[a * 3 + 1] + lm[b * 3 + 1]) / 2];
const pt = (lm, i, dy = 0) => [lm[i * 3], lm[i * 3 + 1] + dy];
const ZONE = {
  eyes: [0.5, (lm) => [midp(lm, 33, 133), midp(lm, 362, 263)]],
  ears: [0.45, (lm) => [pt(lm, 234), pt(lm, 454)]],
  cheeks: [0.38, (lm) => [pt(lm, 50), pt(lm, 280)]],
  mouth: [0.45, (lm) => [midp(lm, 13, 14)]],
  chin: [0.45, (lm, fh) => [pt(lm, 152, fh * 0.1)]],
  top: [0.65, (lm, fh) => [pt(lm, 10, -fh * 0.35)]],
  face: [0.75, (lm) => [[(lm[234 * 3] + lm[454 * 3]) / 2, (lm[10 * 3 + 1] + lm[152 * 3 + 1]) / 2]]],
};
// the face points a "hold" ring is drawn around on the preview, per zone
export const ZONE_RING = { eyes: [468, 473], ears: [234, 454], cheeks: [50, 280], mouth: [13], chin: [152], top: [10], face: [1] };
export function handsNearFace(list, zone, now) {
  const Z = ZONE[zone]; if (!Z) return true;
  const ar = face.ar, faces = face.tracks.length ? face.tracks.map((t) => t.lm) : gone.filter((g) => now - g.seen < 1500).map((g) => g.lm);
  for (const lm of faces) {
    const fw = Math.hypot((lm[454 * 3] - lm[234 * 3]) * ar, lm[454 * 3 + 1] - lm[234 * 3 + 1]), fh = Math.abs(lm[152 * 3 + 1] - lm[10 * 3 + 1]);
    const pts = Z[1](lm, fh), r = Z[0] * fw;
    const near = (h, p) => { // palm, thumb tip, index tip, middle tip
      for (const [x, y] of [h.palm, [h.p[8], h.p[9]], [h.p[16], h.p[17]], [h.p[24], h.p[25]]]) if (Math.hypot((x - p[0]) * ar, y - p[1]) < r) return true;
      return false;
    };
    if (list.length < 2) { if (list[0] && pts.some((p) => near(list[0], p))) return true; }
    else if (pts.length === 2) { const [a, b] = list; if ((near(a, pts[0]) && near(b, pts[1])) || (near(a, pts[1]) && near(b, pts[0]))) return true; }
    else if (list.every((h) => near(h, pts[0]))) return true;
  }
  return false;
}
// is the face gesture `id` showing right now on any face → the time it started, else 0
export function faceExprSince(id) {
  let best = 0;
  for (const tr of face.tracks) if (tr.exOn.has(id)) { const t = tr.ex[id] || 0; if (!best || t < best) best = t; }
  return best;
}
// a raw 0..1 value for animation drives (null = no face)
export function faceDrive(src, o) {
  const F = FS[0]; if (!F) return null;
  const c = (x) => Math.max(0, Math.min(1, x)), deg = 180 / Math.PI;
  switch (src) {
    case 'fyaw': return c((F.yaw * deg / 50 + 1) / 2);
    case 'fpitch': return c((F.pitch * deg / 35 + 1) / 2);
    case 'froll': return c((F.roll * deg / 40 + 1) / 2);
    case 'fmouth': return c(F.mouth / 0.8);
    case 'fsmile': return c(F.smile);
    case 'fblink': return c(F.blink);
    case 'fbrow': return c(F.brow / 0.8);
    case 'fx': return c(F.cx / o.w);
    case 'fy': return c(1 - F.cy / o.h);
    case 'fsize': return c(F.w / o.w / 0.5);
  }
  return null;
}
