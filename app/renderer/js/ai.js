// AI manager: one worker (ai-worker.js) holds every model; models load only when something uses them and are closed
// again when nothing has used them for a while. Pictures travel in "lanes": one picture in flight per lane
// ('track' = the hand + face picture, 'seg:<layer>' = background removal for that layer), so a slow model never
// queues up frames. Each lane slows itself down when the worker needs longer than the gap between pictures.
import { api, native, bus } from './core.js';
import { perf } from './perf.js';

const log = (m) => { try { if (native) api.invoke('app:log', m); } catch { /* */ } };
const st = {};          // model → { state: 'off'|'loading'|'ready'|'failed', delegate, err, opts, used }
const handlers = {};    // model → fn(result, ts)
const lanes = new Map(); // key → { busy, at, grabbing, last, ms }
let worker = null;

export const aiState = (m) => (st[m] ? st[m].state : 'off');
export const aiInfo = (m) => st[m] || { state: 'off', delegate: '', err: '' };
export const onAi = (m, fn) => { handlers[m] = fn; };
const set = (m, patch) => { st[m] = { ...(st[m] || { state: 'off', delegate: '', err: '', opts: {} }), ...patch }; bus.emit('ai:state', m); };

function ensureWorker() {
  if (worker) return;
  worker = new Worker(new URL('./ai-worker.js', import.meta.url)); // classic worker (see ai-worker.js)
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.t === 'ready') { if (aiState(d.model) === 'loading' || aiState(d.model) === 'ready') { set(d.model, { state: 'ready', delegate: d.delegate }); log(`ai ${d.model} ready (${d.delegate})`); } }
    else if (d.t === 'fail') { if (aiState(d.model) === 'off') return; set(d.model, { state: 'failed', err: d.err }); log(`ai ${d.model} FAILED ${d.err}`); } // a model switched off meanwhile stays off
    else if (d.t === 'res') {
      // time per picture; the first pictures of a model are slow (warm-up) and must not hold the lane back for long:
      // a faster picture pulls the average down quickly, a slower one pushes it up gently
      const L = lanes.get(d.key); if (L) { L.busy = false; const ms = (d.hand ? d.hand.ms : 0) + (d.face ? d.face.ms : 0) + (d.seg ? d.seg.ms || 0 : 0); if (++L.n > 2) L.ms = L.ms ? L.ms + (ms - L.ms) * (ms < L.ms ? 0.5 : 0.15) : ms; }
      if (d.hand && handlers.hand) handlers.hand(d.hand, d.ts);
      if (d.face && handlers.face) handlers.face(d.face, d.ts);
      if (d.seg && handlers.seg) handlers.seg(d.seg, d.ts);
    }
  };
  worker.onerror = (e) => {
    const err = String(e.message || e);
    for (const m of Object.keys(st)) if (st[m].state === 'loading' || st[m].state === 'ready') set(m, { state: 'failed', err });
    log(`ai worker error ${err}`);
    try { worker.terminate(); } catch { /* */ } worker = null; lanes.clear();
  };
}
// start a model (no-op when it is already loading / ready / failed); returns its state
export function needAi(m, opts = {}) {
  const s = aiState(m);
  if (st[m]) st[m].used = performance.now();
  if (s !== 'off') return s;
  try { ensureWorker(); } catch (err) { set(m, { state: 'failed', err: String(err) }); return 'failed'; }
  set(m, { state: 'loading', delegate: '', err: '', opts: { ...opts }, used: performance.now() });
  worker.postMessage({ t: 'init', model: m, opts });
  return 'loading';
}
export function dropAi(m) {
  if (aiState(m) === 'off') return;
  set(m, { state: 'off', delegate: '', err: '' });
  if (worker) worker.postMessage({ t: 'close', model: m });
  // nothing left: free the worker (wasm, GPU contexts) completely
  if (worker && !Object.values(st).some((x) => x.state !== 'off')) { worker.terminate(); worker = null; lanes.clear(); }
}
export function aiOptions(m, opts) {
  if (!st[m]) return;
  st[m].opts = { ...st[m].opts, ...opts };
  if (worker && st[m].state === 'ready') worker.postMessage({ t: 'opt', model: m, opts });
}
// models in `models` nobody asked for in `idleMs` are closed (needAi() refreshes `used`)
export function pruneAi(now, models, idleMs = 30000) {
  for (const m of models) if (st[m] && (st[m].state === 'ready' || st[m].state === 'failed') && now - (st[m].used || 0) > idleMs) { dropAi(m); log(`ai ${m} closed (not used)`); }
}
// the gap a lane waits between pictures: the wanted rate, stretched when the worker is slower than that
// (never more than 1.3 × its own time per picture) and when the PC is already behind (auto quality stepped down)
export function laneGap(key, base) {
  const L = lanes.get(key), slow = perf.level >= 1 ? 1.3 : 1;
  return Math.max(base * slow, L && L.ms ? L.ms * 1.3 : 0);
}
export const laneMs = (key) => { const L = lanes.get(key); return L ? L.ms : 0; };

// send one picture of `el` to the worker for the jobs { hand, face, seg: layerId } → true when a picture went out
export function feedAi(key, el, now, jobs, { maxW = 640, gap = 33 } = {}) {
  if (!worker) return false;
  let L = lanes.get(key); if (!L) { L = { busy: false, at: 0, grabbing: false, last: 0, ms: 0, n: 0 }; lanes.set(key, L); }
  if (L.busy && now - L.at > 2500) L.busy = false; // the worker never answered: do not stall forever
  if (L.busy || L.grabbing) return false;
  if (now - L.last < laneGap(key, gap)) return false;
  const vw = el.videoWidth || el.naturalWidth || el.width || 0, vh = el.videoHeight || el.naturalHeight || el.height || 0;
  if (!vw || !vh) return false;
  const k = Math.min(1, maxW / vw);
  L.grabbing = true; L.last = now;
  createImageBitmap(el, { resizeWidth: Math.max(1, Math.round(vw * k)), resizeHeight: Math.max(1, Math.round(vh * k)), resizeQuality: 'low' })
    .then((bmp) => { if (!worker) { bmp.close(); return; } L.busy = true; L.at = now; worker.postMessage({ t: 'frame', bmp, ts: now, key, ...jobs }, [bmp]); }, () => {})
    .finally(() => { L.grabbing = false; });
  return true;
}
