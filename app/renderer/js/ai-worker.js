// AI worker (hand landmarks, face landmarks, person segmentation), off the main thread so the studio never stutters.
// ai.js runs two of these: one for the hand model alone, one for face + background removal (see ai.js why).
// This is a CLASSIC worker on purpose — MediaPipe loads its wasm glue with importScripts(), which module workers lack.
const base = new URL('../vendor/mediapipe/', self.location.href).href;
let vision = null, files = null;
// model name → { task, delegate, opts, errs, lastTs }
const M = {};

const MAKE = {
  hand: (v, o, d) => v.HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: base + 'hand_landmarker.task', delegate: d },
    runningMode: 'VIDEO', numHands: o.hands || 2,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  }),
  face: (v, o, d) => v.FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: base + 'face_landmarker.task', delegate: d },
    runningMode: 'VIDEO', numFaces: o.faces || 1,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  }),
  seg: (v, o, d) => v.ImageSegmenter.createFromOptions(files, {
    baseOptions: { modelAssetPath: base + 'selfie_segmenter.tflite', delegate: d },
    runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
  }),
};

// The model can be closed ('close') while it is still loading: every await is followed by a check that this load
// still owns M[name]; a stale load closes what it made and says nothing.
const closeTask = (t) => { if (t) { try { t.close(); } catch { /* */ } } };
async function build(name, gpu, m = M[name]) {
  closeTask(m.task); m.task = null;
  let task = null, delegate = '';
  if (gpu) { try { task = await MAKE[name](vision, m.opts, 'GPU'); delegate = 'GPU'; } catch (err) { console.warn(name + ' GPU delegate failed', err); } }
  if (M[name] !== m) { closeTask(task); return; }
  if (!task) { task = await MAKE[name](vision, m.opts, 'CPU'); delegate = 'CPU'; }
  if (M[name] !== m) { closeTask(task); return; }
  m.task = task; m.delegate = delegate; m.errs = 0;
  postMessage({ t: 'ready', model: name, delegate });
}
async function init(name, o) {
  const m = M[name] = M[name] || { task: null, delegate: '', opts: {}, errs: 0, lastTs: 0 };
  try {
    Object.assign(m.opts, o);
    if (!vision) {
      const v = await import(base + 'vision_bundle.mjs');
      const f = await v.FilesetResolver.forVisionTasks(base + 'wasm');
      if (!vision) { vision = v; files = f; }
    }
    if (M[name] !== m) return;
    await build(name, m.opts.gpu !== false, m);
  } catch (err) { if (M[name] === m) postMessage({ t: 'fail', model: name, err: String(err && err.message || err) }); }
}
// a lost GPU context (driver reset) lands in the catch: after 3 errors in a row rebuild that model on the CPU
function failed(name, err) {
  const m = M[name];
  if (++m.errs === 3 && m.delegate === 'GPU') { console.warn(name + ': GPU failed, switching to CPU', err); m.opts.gpu = false; build(name, false).catch(() => {}); }
}
const stamp = (m, ts) => (m.lastTs = Math.max(m.lastTs + 1, Math.round(ts)));

const pack = (a, n) => { const f = new Float32Array(n * 3); if (a) for (let i = 0; i < n && i < a.length; i++) { f[i * 3] = a[i].x; f[i * 3 + 1] = a[i].y; f[i * 3 + 2] = a[i].z; } return f; };
let bsNames = null; // blendshape names (same order every frame) — sent once

function runHand(bmp, ts, tr) {
  const m = M.hand; if (!m || !m.task) return { ms: 0, hands: [] };
  const t0 = performance.now(), out = [];
  try {
    const r = m.task.detectForVideo(bmp, stamp(m, ts));
    for (let i = 0; i < r.landmarks.length; i++) {
      const h = r.handedness[i] && r.handedness[i][0];
      const o = { label: h ? h.categoryName : '', score: h ? h.score : 0, lm: pack(r.landmarks[i], 21), w: pack(r.worldLandmarks && r.worldLandmarks[i], 21) };
      out.push(o); tr.push(o.lm.buffer, o.w.buffer);
    }
    m.errs = 0;
  } catch (err) { failed('hand', err); }
  return { ms: performance.now() - t0, hands: out };
}
function runFace(bmp, ts, tr) {
  const m = M.face; if (!m || !m.task) return { ms: 0, faces: [] };
  const t0 = performance.now(), out = [];
  let names = null;
  try {
    const r = m.task.detectForVideo(bmp, stamp(m, ts));
    for (let i = 0; i < r.faceLandmarks.length; i++) {
      const cats = r.faceBlendshapes && r.faceBlendshapes[i] ? r.faceBlendshapes[i].categories : [];
      if (!bsNames && cats.length) { bsNames = cats.map((c) => c.categoryName); names = bsNames; }
      const bs = new Float32Array(cats.length); for (let k = 0; k < cats.length; k++) bs[k] = cats[k].score;
      const mx = r.facialTransformationMatrixes && r.facialTransformationMatrixes[i] ? Float32Array.from(r.facialTransformationMatrixes[i].data) : new Float32Array(16);
      const o = { lm: pack(r.faceLandmarks[i], 478), bs, mx };
      out.push(o); tr.push(o.lm.buffer, o.bs.buffer, o.mx.buffer);
    }
    m.errs = 0;
  } catch (err) { failed('face', err); }
  return { ms: performance.now() - t0, faces: out, names };
}
function runSeg(bmp, ts, id, tr) {
  const m = M.seg; if (!m || !m.task) return null;
  const t0 = performance.now();
  let res = null;
  try {
    m.task.segmentForVideo(bmp, stamp(m, ts), (r) => {
      const k = r.confidenceMasks && r.confidenceMasks[r.confidenceMasks.length - 1];
      if (!k) return;
      const f = k.getAsFloat32Array(), n = f.length, bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = f[i] * 255;
      res = { id, bytes, w: k.width, h: k.height };
    });
    m.errs = 0;
  } catch (err) { failed('seg', err); }
  if (res) { res.ms = performance.now() - t0; tr.push(res.bytes.buffer); }
  return res;
}

onmessage = async (e) => {
  const d = e.data;
  if (d.t === 'init') { await init(d.model, d.opts || {}); return; }
  if (d.t === 'close') { const m = M[d.model]; if (m && m.task) { try { m.task.close(); } catch { /* */ } } delete M[d.model]; return; }
  if (d.t === 'opt') {
    const m = M[d.model]; if (!m) return;
    const gpu = d.opts.gpu !== undefined && d.opts.gpu !== m.opts.gpu; Object.assign(m.opts, d.opts);
    if (!m.task) return;
    try {
      if (gpu) await build(d.model, m.opts.gpu);
      else if (d.model === 'hand') await m.task.setOptions({ numHands: m.opts.hands });
      else if (d.model === 'face') await m.task.setOptions({ numFaces: m.opts.faces });
    } catch (err) { postMessage({ t: 'fail', model: d.model, err: String(err && err.message || err) }); }
    return;
  }
  if (d.t !== 'frame') return;
  const bmp = d.bmp, tr = [], res = { t: 'res', ts: d.ts, key: d.key, hand: null, face: null, seg: null };
  if (d.hand) res.hand = runHand(bmp, d.ts, tr);
  if (d.face) res.face = runFace(bmp, d.ts, tr);
  if (d.seg) res.seg = runSeg(bmp, d.ts, d.seg, tr);
  bmp.close();
  postMessage(res, tr);
};
