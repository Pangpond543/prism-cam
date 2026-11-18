// Personal gesture models. The user teaches poses with their own hands and a k-nearest-neighbour classifier names
// them. Two models live side by side:
//   one hand  — sample = the hand's 3D shape (MediaPipe world landmarks, left hands mirrored to look like right hands)
//   two hands — sample = both hands' points placed relative to each other (pose ids start with "pair:")
// Profiles belong to the person, not to a project.
import { api, native, T } from './core.js';

const KEY = 'prismcam.hands', CAP = 300, MIN = 20, K = 7;
export const DIM = 79, PDIM = 84;
const uid = () => Math.random().toString(36).slice(2, 9);
export const store = { v: 1, active: '', profiles: [] };
const models = { single: null, pair: null };
let saveT = 0;

/* --------------------------------------------------------------- profiles */
export const prof = () => store.profiles.find((p) => p.id === store.active) || store.profiles[0];
export function newProfile(name) { const p = { id: uid(), name, on: true, custom: [], data: {} }; store.profiles.push(p); return p; }
export async function loadProfiles() {
  let json = null;
  if (native) { const r = await api.invoke('hand:load').catch(() => null); json = r && r.ok ? r.data : null; }
  else { try { json = localStorage.getItem(KEY); } catch { /* */ } }
  try { const o = JSON.parse(json); if (o && Array.isArray(o.profiles)) { store.profiles = o.profiles; store.active = o.active || ''; } } catch { /* first run / corrupt → fresh */ }
  for (const p of store.profiles) { p.custom ||= []; p.data ||= {}; if (p.on === undefined) p.on = true; }
  if (!store.profiles.length) store.active = newProfile(T`มือของฉัน`).id;
  if (!store.profiles.some((p) => p.id === store.active)) store.active = store.profiles[0].id;
  // first start (or a profile that was never taught): begin with the basic poses that ship with the app
  const only = store.profiles.length === 1 && store.profiles[0];
  if (only && !only.custom.length && !Object.keys(only.data).length && await useDefaults(only)) saveProfiles();
  rebuild();
}
// Basic poses taught by the author (built-in poses only, no custom ones) — app/renderer/data/default-hands.json.
let defaults = null;
async function readDefaults() {
  if (!defaults) defaults = fetch("data/default-hands.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return defaults;
}
// copy the default samples of every built-in pose into profile p (custom poses and their samples stay)
export async function useDefaults(p = prof()) {
  const d = await readDefaults();
  if (!d || typeof d.data !== "object") return false;
  for (const [g, a] of Object.entries(d.data)) if (!/^(pair:)?c:/.test(g) && Array.isArray(a)) p.data[g] = a.slice(0, CAP);
  return true;
}
export async function resetToDefaults() { const ok = await useDefaults(); rebuild(); saveProfiles(); return ok; }
export function saveProfiles() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const json = JSON.stringify(store);
    if (native) api.invoke('hand:save', json).catch(() => {}); else { try { localStorage.setItem(KEY, json); } catch { /* */ } }
  }, 500);
}
export function setActive(id) { store.active = id; rebuild(); saveProfiles(); }
export function removeProfile(id) {
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (!store.profiles.length) newProfile(T`มือของฉัน`);
  if (!store.profiles.some((p) => p.id === store.active)) store.active = store.profiles[0].id;
  rebuild(); saveProfiles();
}
// custom poses: { id, name, kind: 'pair' | undefined } → gid "c:id" (one hand) or "pair:c:id" (two hands)
export const customGid = (c) => (c.kind === 'pair' ? 'pair:c:' : 'c:') + c.id;
export const customList = () => (prof() ? prof().custom.filter((c) => c.kind !== 'pair') : []);
export const customPairList = () => (prof() ? prof().custom.filter((c) => c.kind === 'pair') : []);
export function addCustom(name, kind) { const c = { id: uid(), name: name.slice(0, 24) }; if (kind === 'pair') c.kind = 'pair'; prof().custom.push(c); saveProfiles(); return customGid(c); }
export function removeCustom(gid) { const p = prof(); p.custom = p.custom.filter((c) => customGid(c) !== gid); delete p.data[gid]; rebuild(); saveProfiles(); }
export const sampleCount = (gid) => { const p = prof(); return p && p.data[gid] ? p.data[gid].length : 0; };
export function addSamples(gid, list) { // one hand: side-normalised world landmarks (63) · two hands: pairFeatures (84)
  const p = prof(), a = p.data[gid] || (p.data[gid] = []);
  for (const w of list) a.push(Array.from(w, (v) => Math.round(v * 1e4) / 1e4));
  while (a.length > CAP) a.splice(Math.floor(Math.random() * a.length), 1); // keep a spread from every session
  rebuild(); saveProfiles();
}
export function clearClass(gid) { delete prof().data[gid]; rebuild(); saveProfiles(); }
export function exportProfile(p) { return JSON.stringify({ prismHandProfile: 1, name: p.name, custom: p.custom, data: p.data, mouse: p.mouse }); }
export function importProfile(json) {
  const o = JSON.parse(json);
  if (!o || o.prismHandProfile !== 1 || typeof o.data !== 'object') throw new Error('format');
  const p = newProfile(String(o.name || T`โปรไฟล์ที่นำเข้า`).slice(0, 30));
  p.custom = Array.isArray(o.custom) ? o.custom.filter((c) => c && c.id && c.name) : [];
  if (o.mouse && o.mouse.pinch < o.mouse.open) p.mouse = { pinch: +o.mouse.pinch, open: +o.mouse.open };
  for (const [g, a] of Object.entries(o.data)) if (Array.isArray(a)) p.data[g] = a.filter((s) => Array.isArray(s) && s.length === (g.startsWith('pair:') ? PDIM : 63)).slice(0, CAP);
  store.active = p.id; rebuild(); saveProfiles();
  return p;
}

/* --------------------------------------------------------------- features */
// hand-local frame: y = wrist → middle knuckle, x = across the knuckles, z = palm normal; all scaled by palm length.
// Shape (60) + fingertip spreads (10) is rotation-free; the frame axes in camera space (9) keep 👍 apart from 👎.
const TIPS = [4, 8, 12, 16, 20];
export function features(w, out = new Float32Array(DIM)) {
  const x0 = w[0], y0 = w[1], z0 = w[2];
  let ux = w[27] - x0, uy = w[28] - y0, uz = w[29] - z0;
  const size = Math.hypot(ux, uy, uz) || 1e-3; ux /= size; uy /= size; uz /= size;
  let vx = w[15] - w[51], vy = w[16] - w[52], vz = w[17] - w[53];
  const d = vx * ux + vy * uy + vz * uz; vx -= d * ux; vy -= d * uy; vz -= d * uz;
  const vn = Math.hypot(vx, vy, vz) || 1e-3; vx /= vn; vy /= vn; vz /= vn;
  const zx = vy * uz - vz * uy, zy = vz * ux - vx * uz, zz = vx * uy - vy * ux;
  let k = 0;
  for (let i = 1; i < 21; i++) {
    const px = w[i * 3] - x0, py = w[i * 3 + 1] - y0, pz = w[i * 3 + 2] - z0;
    out[k++] = (px * vx + py * vy + pz * vz) / size; out[k++] = (px * ux + py * uy + pz * uz) / size; out[k++] = (px * zx + py * zy + pz * zz) / size;
  }
  for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) { const i = TIPS[a] * 3, j = TIPS[b] * 3; out[k++] = Math.hypot(w[i] - w[j], w[i + 1] - w[j + 1], w[i + 2] - w[j + 2]) / size; }
  out[k++] = ux; out[k++] = uy; out[k++] = uz; out[k++] = vx; out[k++] = vy; out[k++] = vz; out[k++] = zx; out[k++] = zy; out[k++] = zz;
  return out;
}
const same = (v, out) => { out.set(v); return out; };

/* ----------------------------------------------------------------- models */
function build(kind) {
  const p = prof(), pair = kind === 'pair', dim = pair ? PDIM : DIM, feat = pair ? same : features;
  const classes = Object.keys(p.data).filter((g) => g.startsWith('pair:') === pair && p.data[g].length >= MIN
    && (!/^(pair:)?c:/.test(g) || p.custom.some((c) => customGid(c) === g)));
  if (classes.length < 2) return null;
  let n = 0; for (const g of classes) n += p.data[g].length;
  const X = new Float32Array(n * dim), y = new Uint16Array(n), f = new Float32Array(dim), w = new Float32Array(pair ? PDIM : 63);
  let r = 0;
  classes.forEach((g, c) => { for (const s of p.data[g]) { w.set(s); feat(w, f); X.set(f, r * dim); y[r++] = c; } });
  const mean = new Float32Array(dim), inv = new Float32Array(dim);
  for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) mean[j] += X[i * dim + j] / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) { const t = X[i * dim + j] - mean[j]; inv[j] += t * t / n; }
  for (let j = 0; j < dim; j++) inv[j] = 1 / Math.max(0.03, Math.sqrt(inv[j]));
  for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) X[i * dim + j] = (X[i * dim + j] - mean[j]) * inv[j];
  const m = { classes, X, y, n, dim, mean, inv, feat, q: new Float32Array(dim), reject: Infinity };
  // "too far from anything taught" radius: 95th percentile nearest-neighbour distance among the samples, with headroom
  const ds = [], q = new Float32Array(dim), step = Math.max(1, Math.floor(n / 150));
  for (let i = 0; i < n; i += step) { q.set(X.subarray(i * dim, i * dim + dim)); ds.push(near(m, q, i, 3)[0].d); }
  ds.sort((a, b) => a - b);
  m.reject = Math.max(2.5, ds[Math.floor(ds.length * 0.95)] * 2.2);
  return m;
}
function rebuild() {
  const p = prof();
  models.single = p && p.on ? build('single') : null;
  models.pair = p && p.on ? build('pair') : null;
}
// k nearest samples to standardised v (skipping samples near index `skip`, i.e. the same recording moment)
function near(m, v, skip = -1, gap = 0) {
  const { X, y, n, dim } = m, kk = Math.min(K, n - 1), best = [];
  let worst = Infinity;
  for (let i = 0, o = 0; i < n; i++, o += dim) {
    if (skip >= 0 && Math.abs(i - skip) <= gap && y[i] === y[skip]) continue;
    let s = 0;
    for (let j = 0; j < dim; j++) { const t = X[o + j] - v[j]; s += t * t; }
    if (best.length < kk || s < worst) {
      let at = best.length; while (at > 0 && best[at - 1].s > s) at--;
      best.splice(at, 0, { s, i }); if (best.length > kk) best.pop();
      worst = best.length === kk ? best[kk - 1].s : Infinity;
    }
  }
  return best.map((b) => ({ d: Math.sqrt(b.s), c: y[b.i] }));
}
function vote(m, nb) {
  const v = new Float32Array(m.classes.length); let tot = 0;
  for (const b of nb) { const w = 1 / (b.d + 0.35); v[b.c] += w; tot += w; }
  let c = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[c]) c = i;
  return { c, conf: tot ? v[c] / tot : 0 };
}
function ask(m, sample) {
  if (!m) return null;
  const q = m.feat(sample, m.q);
  for (let j = 0; j < m.dim; j++) q[j] = (q[j] - m.mean[j]) * m.inv[j];
  const nb = near(m, q), { c, conf } = vote(m, nb);
  return { label: m.classes[c], conf, far: nb[0].d > m.reject };
}
export const modelReady = () => !!models.single;
export const pairModelReady = () => !!models.pair;
export const trainedSet = () => new Set(models.single ? models.single.classes : []);
export const trainedPairSet = () => new Set(models.pair ? models.pair.classes : []);
// one hand: side-normalised world landmarks → { label, conf, far } (label 'none' = "not a pose")
export const predict = (w) => ask(models.single, w);
// two hands: pairFeatures → { label, conf, far } (label 'pair:none' = "the two hands are not making a pose")
export const predictPair = (f) => ask(models.pair, f);
// leave-one-out check: how often each taught pose is recognised, and what it is mistaken for
export async function analyze() {
  const out = [];
  for (const m of [models.single, models.pair]) {
    if (!m) continue;
    const { classes, y, n, X, dim } = m, idx = classes.map(() => []);
    for (let i = 0; i < n; i++) idx[y[i]].push(i);
    const q = new Float32Array(dim);
    for (let c = 0; c < classes.length; c++) {
      const mix = new Array(classes.length).fill(0), list = idx[c], step = Math.max(1, Math.floor(list.length / 60));
      let ok = 0, tot = 0;
      for (let t = 0; t < list.length; t += step) {
        const i = list[t]; q.set(X.subarray(i * dim, i * dim + dim));
        const r = vote(m, near(m, q, i, 6)).c; tot++; if (r === c) ok++; else mix[r]++;
      }
      let b = -1, bv = 0; mix.forEach((v, j) => { if (v > bv) { bv = v; b = j; } });
      out.push({ gid: classes[c], n: list.length, acc: tot ? ok / tot : 1, with: b >= 0 ? classes[b] : '', withRate: tot ? bv / tot : 0 });
      await new Promise((r) => setTimeout(r, 0)); // keep the preview running while this works
    }
  }
  return out.length ? out : null;
}
export const MIN_SAMPLES = MIN;
