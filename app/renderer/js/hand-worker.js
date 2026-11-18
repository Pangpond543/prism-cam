// Hand tracking worker: runs the MediaPipe hand landmark model off the main thread so the studio never stutters.
// This is a CLASSIC worker on purpose — MediaPipe loads its wasm glue with importScripts(), which module workers lack.
let lm = null, delegate = '', opts = { hands: 2, gpu: true }, lastTs = 0, files = null, Hand = null, errs = 0;
const base = new URL('../vendor/mediapipe/', self.location.href).href;

async function make(d) {
  return Hand.createFromOptions(files, {
    baseOptions: { modelAssetPath: base + 'hand_landmarker.task', delegate: d },
    runningMode: 'VIDEO', numHands: opts.hands,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
}
async function build(gpu) {
  if (lm) { try { lm.close(); } catch { /* */ } lm = null; }
  if (gpu) { try { lm = await make('GPU'); delegate = 'GPU'; } catch (err) { console.warn('hand GPU delegate failed', err); } }
  if (!lm) { lm = await make('CPU'); delegate = 'CPU'; }
  errs = 0;
  postMessage({ t: 'ready', delegate });
}
async function init(o) {
  try {
    Object.assign(opts, o);
    if (!Hand) {
      const m = await import(base + 'vision_bundle.mjs');
      Hand = m.HandLandmarker;
      files = await m.FilesetResolver.forVisionTasks(base + 'wasm');
    }
    await build(opts.gpu);
  } catch (err) { postMessage({ t: 'fail', err: String(err && err.message || err) }); }
}
const pack = (a) => { const f = new Float32Array(63); if (a) for (let i = 0; i < 21; i++) { f[i * 3] = a[i].x; f[i * 3 + 1] = a[i].y; f[i * 3 + 2] = a[i].z; } return f; };

onmessage = async (e) => {
  const d = e.data;
  if (d.t === 'init') { await init(d); return; }
  if (d.t === 'opt') {
    const gpu = d.gpu !== opts.gpu; Object.assign(opts, { hands: d.hands, gpu: d.gpu });
    if (!lm) return;
    try { if (gpu) await build(opts.gpu); else await lm.setOptions({ numHands: opts.hands }); } catch (err) { postMessage({ t: 'fail', err: String(err && err.message || err) }); }
    return;
  }
  if (d.t !== 'frame') return;
  const bmp = d.bmp;
  if (!lm) { bmp.close(); postMessage({ t: 'res', ts: d.ts, ms: 0, hands: [] }); return; }
  const t0 = performance.now(), out = [], tr = [];
  try {
    const ts = Math.max(lastTs + 1, Math.round(d.ts)); lastTs = ts;
    const r = lm.detectForVideo(bmp, ts);
    for (let i = 0; i < r.landmarks.length; i++) {
      const h = r.handedness[i] && r.handedness[i][0];
      const o = { label: h ? h.categoryName : '', score: h ? h.score : 0, lm: pack(r.landmarks[i]), w: pack(r.worldLandmarks && r.worldLandmarks[i]) };
      out.push(o); tr.push(o.lm.buffer, o.w.buffer);
    }
    errs = 0;
  } catch (err) {
    // a lost GPU context (driver reset) lands here: rebuild on the CPU instead of dying
    if (++errs === 3 && delegate === 'GPU') { console.warn('hand tracker: GPU failed, switching to CPU', err); opts.gpu = false; build(false).catch(() => {}); }
  }
  bmp.close();
  postMessage({ t: 'res', ts: d.ts, ms: performance.now() - t0, hands: out }, tr);
};
