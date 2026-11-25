// Prism Cam — lyrics layer ("เนื้อเพลง"): what is playing on this PC (Windows media controls: Spotify, YouTube in a
// browser, …) + synced lyrics (LRCLIB, cached on disk; the user's own .lrc wins), drawn on the scene canvas in four
// styles with Prism glass. Native side: src-tauri/src/media.rs. Everything here is drawn by hand on the 2D canvas
// (the scene is one canvas), so every movement is a time-based ease computed per frame — no DOM, no CSS transitions.
import { api, bus, T } from './core.js';
import { glassPane } from './glass.js';

export const LY_DEF = { style: 'karaoke', bg: 'glass', frost: 35, font: 'Anuphan', weight: 500, color: '', next: true, art: true, offset: 0, app: '',
  disc: true, title: true, ink: 'cover', inkA: 65, react: 60, ripple: true, c1: '#4b2fb0', c2: '#ff9ec7' };
export const LY_FONTS = ['Anuphan', 'IBM Plex Sans Thai', 'Noto Sans Thai', 'Prompt', 'Bai Jamjuree'];
export const userFonts = []; // [{ family, file }] — the user's own font files (<data>/fonts)

const cl = (x) => (x < 0 ? 0 : x > 1 ? 1 : x), eo = (x) => 1 - Math.pow(1 - cl(x), 3), ss = (x) => { x = cl(x); return x * x * (3 - 2 * x); }, lp = (a, b, k) => a + (b - a) * k;

/* ------------------------------------------------------------- now playing */
export const music = { ok: true, none: true, ad: false, fake: false, key: '', title: '', artist: '', album: '', app: '', appId: '', playing: false, pos: 0, at: 0, dur: 0, apps: [], artImg: null, ly: null, pausedAt: 0, demo: false };
let timer = 0, want = '', busy = false;
export const musicPos = (now = performance.now()) => (music.playing ? music.pos + (now - music.at) : music.pos);
/** poll the PC's player once a second while a lyrics layer is in the scene */
export function musicNeed(on, app = '') {
  if (app !== want) { want = app; music.key = ''; }
  if (on && !timer) { timer = setInterval(poll, 1000); poll(); } else if (!on && timer) { clearInterval(timer); timer = 0; }
}
async function poll() {
  if (busy || music.fake) return; busy = true;
  try {
    const r = await api.invoke('music:now', { app: want });
    if (!r || r.ok === false) { if (music.ok) { music.ok = false; bus.emit('music'); } return; }
    music.ok = true; music.apps = r.apps || [];
    const now = performance.now();
    if (r.none || !r.title) { if (!music.none) { music.none = true; music.playing = false; music.key = ''; bus.emit('music'); } return; }
    const key = (r.artist || '') + '\u0001' + r.title;
    if (key !== music.key) { // a new song
      // Spotify Free plays ads as "songs" by the artist "Spotify" — they never go on camera
      Object.assign(music, { key, none: false, ad: r.artist === 'Spotify' || /^(advertisement|โฆษณา)$/i.test(r.title), title: r.title, artist: r.artist || '', album: r.album || '', app: r.app || '', appId: r.appId || '', dur: r.durMs || 0, artImg: null, ly: { state: 'loading' }, pos: r.posMs || 0, at: now, playing: !!r.playing, pausedAt: now, demo: false });
      loadLyrics(key); loadArt(key, 0); bus.emit('music');
      return;
    }
    music.none = false; if (r.durMs) music.dur = r.durMs;
    if (!!r.playing !== music.playing) { music.playing = !!r.playing; music.pos = r.posMs; music.at = now; if (!music.playing) music.pausedAt = now; bus.emit('music'); }
    else if (Math.abs(r.posMs - musicPos(now)) > 700) { music.pos = r.posMs; music.at = now; } // seek, or our clock drifted
    if (music.ly && music.ly.state === 'net' && now - music.ly.t > 30000) loadLyrics(key); // came back online?
  } catch { music.ok = false; } finally { busy = false; }
}
async function loadLyrics(key, force = false) {
  const r = await api.invoke('music:lyrics', { title: music.title, artist: music.artist, album: music.album, durMs: music.dur, force });
  if (music.key !== key) return;
  let ly;
  if (!r || r.ok === false) ly = { state: r && r.reason === 'net' ? 'net' : 'none', t: performance.now() };
  else if (r.synced) { const lines = parseLrc(r.synced, music.dur); ly = lines.some((l) => !l.gap) ? { state: 'ok', source: r.source, lines } : { state: 'none' }; }
  else if (r.plain) ly = { state: 'plain', source: r.source };
  else ly = { state: 'none' };
  music.ly = ly; bus.emit('music');
}
async function loadArt(key, n) {
  const r = await api.invoke('music:art', { app: want });
  if (music.key !== key) return;
  if (r && r.ok && r.url) { const im = new Image(); im.onload = () => { if (music.key === key) { music.artImg = im; bus.emit('music'); } }; im.src = r.url; }
  else if (n < 2) setTimeout(() => loadArt(key, n + 1), 1500); // players often set the cover a moment after the title
}
/* ------------------------------------------------------------- loudness */
// the player's own peak meter (media.rs `level`), 20× a second, only while a lyrics layer with colour / ripples is
// drawn (inkOf marks `levelWanted`); stops by itself 2 s after nobody asks
Object.assign(music, { lvl: 0, avg: 0, beats: 0, amp: 0, whole: false });
let lvTimer = 0, lvBusy = false, levelWanted = 0;
function wantLevel(now) {
  levelWanted = now;
  if (!lvTimer && music.ok && !music.none && !music.fake) lvTimer = setInterval(pollLevel, 50);
}
async function pollLevel() {
  if (performance.now() - levelWanted > 2000 || music.none) { clearInterval(lvTimer); lvTimer = 0; return; }
  if (lvBusy) return; lvBusy = true;
  try {
    const r = await api.invoke('music:level', { app: music.appId || want });
    if (r && r.ok) { music.lvl = r.lvl; music.avg = r.avg; music.whole = r.whole; if (r.beats !== music.beats) { music.beats = r.beats; music.amp = r.amp; } }
  } catch { /* */ } finally { lvBusy = false; }
}
// the sample song / browser preview / lyfake: a soft made-up pulse (~128 bpm), so colours and ripples can be tried without music
function levelOf(S, now) {
  if (S.fakeLevel) { const b = now / 937.5, ph = b - Math.floor(b); return { lvl: 0.34 + 0.32 * Math.pow(1 - ph, 5) + 0.06 * Math.sin(now / 2300), beats: Math.floor(b / 2), amp: 0.8 }; }
  return { lvl: music.lvl, beats: music.beats, amp: music.amp };
}

export function lyricsReload() { if (!music.key) return; music.ly = { state: 'loading' }; bus.emit('music'); loadLyrics(music.key, true); }
/** the user's own lyrics for the song playing now ('' = remove them, back to LRCLIB) */
export async function lyricsOwn(lrc) {
  if (!music.key) return false;
  const r = await api.invoke('music:lyricsPut', { title: music.title, artist: music.artist, lrc });
  if (r && r.ok) { music.ly = { state: 'loading' }; bus.emit('music'); loadLyrics(music.key); }
  return !!(r && r.ok);
}
export const looksLrc = (s) => /\[\d+:\d+(\.\d+)?\]/.test(String(s || ''));

/* ------------------------------------------------------------- the user's fonts */
export async function loadUserFonts() {
  const r = await api.invoke('font:list');
  if (!r || !r.ok) return;
  for (const file of r.fonts || []) await addFontFile(file, null);
}
// family = file name without the extension ("My Font.ttf" → "My Font"); bytes come from disk when not given
export async function addFontFile(file, bytes) {
  const family = file.replace(/\.(ttf|otf|woff2?)$/i, '').trim();
  if (userFonts.some((f) => f.family === family)) return family;
  try {
    const buf = bytes || await api.invoke('font:get', file);
    if (!buf || !(buf.byteLength || buf.length)) return null;
    const face = new FontFace(family, buf instanceof ArrayBuffer || ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf).buffer);
    await face.load(); document.fonts.add(face);
    userFonts.push({ family, file });
    return family;
  } catch (err) { api.invoke('app:log', 'font ' + file + ' ' + err); return null; }
}
export async function removeFontFile(family) {
  const i = userFonts.findIndex((f) => f.family === family); if (i < 0) return;
  await api.invoke('font:del', userFonts[i].file);
  for (const f of document.fonts) if (f.family.replace(/"/g, '') === family) document.fonts.delete(f);
  userFonts.splice(i, 1);
}

/* ---------------------------------------------------------------- LRC */
const segW = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
const segG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'grapheme' }) : null;
const graphemes = (s) => (segG ? [...segG.segment(s)].length : [...s].length);
const TIME = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
const sec = (m, s) => (+m * 60 + +String(s).replace(':', '.')) * 1000;
/** LRC text → [{ t, end, text, wt? } | { t, end, gap: true }], times in ms. `<mm:ss.xx>` word stamps (enhanced LRC) are kept. */
export function parseLrc(text, durMs = 0) {
  let off = 0; const raw = [];
  for (const line of String(text).split(/\r?\n/)) {
    const mo = line.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i); if (mo) { off = +mo[1]; continue; }
    const ts = [...line.matchAll(TIME)]; if (!ts.length) continue;
    const body = line.replace(TIME, '');
    for (const m of ts) raw.push({ t: sec(m[1], m[2]), body });
  }
  raw.sort((a, b) => a.t - b.t);
  const end = (i) => (i + 1 < raw.length ? raw[i + 1].t - off : Math.max(durMs || 0, raw[i].t - off + 5000));
  let lines = [];
  raw.forEach((r, i) => {
    const t = Math.max(0, r.t - off), e = end(i);
    let wt = null, txt = r.body;
    if (/<\d+:\d+(?:\.\d+)?>/.test(txt)) { // enhanced LRC: <00:12.30>word <00:12.80>word
      wt = []; const parts = txt.split(/<(\d+):(\d+(?:\.\d+)?)>/);
      for (let k = 1; k + 2 <= parts.length; k += 3) { const s = parts[k + 2]; if (s) wt.push({ s, a: Math.max(0, sec(parts[k], parts[k + 1]) - off) }); }
      if (parts[0].trim()) wt.unshift({ s: parts[0], a: t });
      txt = wt.map((w) => w.s).join('');
    }
    txt = txt.replace(/\s+/g, ' ').trim();
    if (!txt || /^[♪♫\s]+$/.test(txt)) lines.push({ t, end: e, gap: true });
    else lines.push({ t, end: e, text: txt, wt });
  });
  // a long instrumental after a sung line (no empty line in the file): dots, so the old line doesn't hang there
  const more = [];
  for (const l of lines) {
    more.push(l);
    if (!l.gap) { const sing = singSpan(l); if (l.end - l.t - sing > 6500) { more.push({ t: l.t + sing + 1500, end: l.end, gap: true }); l.end = l.t + sing + 1500; } }
  }
  lines = more;
  if (lines.length && lines[0].t > 3500) lines.unshift({ t: 0, end: lines[0].t, gap: true });
  // short pauses are not worth dots: the line before simply lasts a little longer; two gaps in a row = one
  const outL = [];
  for (const l of lines) {
    const prev = outL[outL.length - 1];
    if (l.gap && (l.end - l.t < 3000 || (prev && prev.gap))) { if (prev) prev.end = l.end; else if (l.end - l.t >= 3000) outL.push(l); continue; }
    outL.push(l);
  }
  return outL;
}
function singSpan(l) { // how long the words of a line take (lines often start well before the next one)
  let g = 0; for (const ch of segG ? [...segG.segment(l.text)].map((x) => x.segment) : [...l.text]) g += /[฀-๿]/.test(ch) ? 150 : /\s/.test(ch) ? 30 : 70;
  return Math.min((l.end - l.t) * 0.9, g + 700);
}
/** words of a line with their times: [{ s, a, b }] */
function wordsOf(l) {
  if (l._w) return l._w;
  let ws;
  if (l.gap) { const d = l.end - l.t - 600; ws = [0, 1, 2].map((k) => ({ s: '●', a: l.t + 300 + d * k / 3, b: l.t + 300 + d * (k + 1) / 3, dot: true })); }
  else if (l.wt && l.wt.length) { ws = l.wt.map((w, k) => ({ s: w.s, a: w.a, b: k + 1 < l.wt.length ? l.wt[k + 1].a : Math.min(l.end, w.a + Math.max(400, graphemes(w.s) * 160)) })); }
  else {
    const parts = [];
    for (const g of segW ? segW.segment(l.text) : l.text.split(/(\s+)/).map((segment) => ({ segment, isWordLike: !/^\s*$/.test(segment) }))) {
      const s = g.segment; if (!s) continue;
      if (parts.length && (!g.isWordLike || /^\s+$/.test(s))) parts[parts.length - 1] += s; else parts.push(s); // spaces / punctuation ride on the word before
    }
    const wt = parts.map((p) => Math.max(1, graphemes(p.trim()) || 1)), tot = wt.reduce((a, b) => a + b, 0), sing = singSpan(l);
    let c = 0; ws = parts.map((s, k) => { const a = l.t + sing * c / tot; c += wt[k]; return { s, a, b: l.t + sing * c / tot }; });
  }
  l._w = ws; return ws;
}
function lineAt(lines, pos) { let lo = 0, hi = lines.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (lines[m].t <= pos) { r = m; lo = m + 1; } else hi = m - 1; } return r; }

/* ---------------------------------------------------------------- demo song */
// made-up lines, so the look can be tuned without music playing (and for the self-test)
const DEMO = parseLrc(['[00:00.40]แสงไฟในเมือง ยังไม่หลับ', '[00:04.00]ฉันเดินตามจังหวะ ของหัวใจ', '[00:07.60]ปล่อยให้เพลง พาฉันไปไกล', '[00:11.20]ไม่ต้องรีบร้อน อะไร', '[00:14.80]แค่ฟังเสียงลม ก็พอ', '[00:18.40]'].join('\n'), 19000);
const DEMO_LEN = 19000;
function source(now) {
  if (music.none && music.demo) return { title: T`เพลงตัวอย่าง`, artist: 'Prism Cam', album: '', app: '', lines: DEMO, state: 'ok', pos: (now % DEMO_LEN), dur: DEMO_LEN, playing: true, live: true, art: null, fakeLevel: true };
  const has = music.ok && !music.none && !!music.key && !music.ad, ly = music.ly || {};
  return { title: music.title, artist: music.artist, album: music.album, app: music.app, lines: ly.state === 'ok' ? ly.lines : null, state: ly.state || 'loading', pos: musicPos(now), dur: music.dur, playing: music.playing, live: has && (music.playing || now - music.pausedAt < 1500), art: music.artImg, fakeLevel: !music.ok || music.fake };
}

/* ---------------------------------------------------------------- drawing */
const st = new Map(); // layer id → { vis, last, c, p, tc, jump, w0, w1, tw, spin }
const layCache = new Map(); // font|text → { w, ws: [{ s, x, w }] }
const fontsAsked = new Set();
function fontOf(Y, size, wMin = 0) {
  const f = `${Math.max(wMin, Y.weight || 500)} ${Math.max(4, size).toFixed(1)}px "${Y.font}", "IBM Plex Sans Thai", sans-serif`;
  const k = `${Math.max(wMin, Y.weight || 500)} 40px "${Y.font}"`;
  if (!fontsAsked.has(k)) { fontsAsked.add(k); document.fonts.load(k, 'กขabc').then(() => layCache.clear()).catch(() => {}); }
  return f;
}
function layoutLine(ctx, font, l) {
  const ws = wordsOf(l), key = font + '|' + l.t + '|' + (l.text || '●');
  let L = layCache.get(key);
  if (!L) {
    ctx.font = font; let x = 0; const gap = l.gap ? ctx.measureText(' ').width * 1.6 : 0;
    L = { font, ws: ws.map((w, k) => { const ww = ctx.measureText(w.s).width; const r = { s: w.s, x, w: ww, a: w.a, b: w.b }; x += ww + (k < ws.length - 1 ? gap : 0); return r; }) };
    L.w = x; if (layCache.size > 400) layCache.clear(); layCache.set(key, L);
  }
  return L;
}
const infoLine = (S) => ({ t: -1, end: -1, text: '♪ ' + S.title + (S.artist ? ' · ' + S.artist : ''), _w: [{ s: '♪ ' + S.title + (S.artist ? ' · ' + S.artist : ''), a: -1e9, b: -1e9 + 1 }] });
// automatic colour: dark ink when what is behind the text (after the glass tint) is bright, white otherwise —
// eased, so a bright shirt walking behind it doesn't make the words blink
function colors(Y, R) {
  if (Y.color) { const c = Y.color; return { on: c, off: hexA(c, 0.32), mid: hexA(c, 0.62), glow: Y.bg === 'none' }; }
  const k = R ? R.ink : Y.bg === 'glass' ? 1 : 0, m = (a, b) => Math.round(lp(a, b, k));
  const rgb = `${m(255, 42)},${m(255, 35)},${m(255, 82)}`;
  return { on: `rgb(${rgb})`, off: `rgba(${rgb},${lp(0.36, 0.3, k).toFixed(2)})`, mid: `rgba(${rgb},${lp(0.66, 0.62, k).toFixed(2)})`, glow: Y.bg === 'none' && k < 0.5 };
}
const probe = (() => { try { const c = document.createElement('canvas'); c.width = 16; c.height = 4; return c.getContext('2d', { willReadFrequently: true }); } catch { return null; } })();
// how bright the scene is under the box (sampled twice a second, before the glass is drawn)
function sense(R, E, Y, x, y, w, h, now) {
  if (Y.color || !probe || now - (R.sensed || 0) < 500) return;
  R.sensed = now;
  const m = E.ctx.getTransform(), pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => [m.a * px + m.c * py + m.e, m.b * px + m.d * py + m.f]);
  const sx = Math.max(0, Math.min(...pts.map((p) => p[0]))), sy = Math.max(0, Math.min(...pts.map((p) => p[1])));
  const ex = Math.min(E.canvas.width, Math.max(...pts.map((p) => p[0]))), ey = Math.min(E.canvas.height, Math.max(...pts.map((p) => p[1])));
  if (ex - sx < 2 || ey - sy < 2) return;
  try {
    probe.clearRect(0, 0, 16, 4); probe.drawImage(E.canvas, sx, sy, ex - sx, ey - sy, 0, 0, 16, 4);
    const d = probe.getImageData(0, 0, 16, 4).data; let lum = 0;
    for (let i = 0; i < d.length; i += 4) lum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    lum /= d.length / 4;
    const f = cl((Y.frost ?? 35) / 100), a = E.lite ? 0.33 + 0.4 * f : 0.25 * (0.55 + 1.1 * f) + 0.06;
    const seen = Y.bg === 'glass' ? Math.min(1, lum * 1.05) * (1 - a) + a : Y.bg === 'dark' ? lum * 0.55 * (1 - Math.min(0.92, a * 0.7 + 0.22)) + 0.33 * Math.min(0.92, a * 0.7 + 0.22) : lum;
    const tinted = R.inkLum != null && Y.bg !== 'none' ? lp(seen, R.inkLum, R.inkMix || 0) : seen; // the colour in the glass decides too
    R.inkT = Y.bg === 'none' ? (seen > 0.72 ? 1 : 0) : ss((tinted - 0.5) / 0.16);
    if (R.ink == null) R.ink = R.inkT;
  } catch { /* the canvas can't be read (tainted) — keep the last guess */ }
}
function hexA(h, a) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return `rgba(255,255,255,${a})`; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }

/* ---------------------------------------------------------- colours in the glass */
// shades are worked out ONCE per song / per colour pair (cached); the shader only blends three of them
const toHsl = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let h = 0, s = 0;
  if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
  return [h, s, l]; };
const toRgb = ([h, s, l]) => { const f = (n) => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }; return [f(0), f(8), f(4)]; };
const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0x8ea2ff; return [n >> 16, (n >> 8) & 255, n & 255]; };
const lumOf = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const hueMix = (a, b, k) => { let d = b - a; if (d > 0.5) d -= 1; if (d < -0.5) d += 1; return (a + d * k + 1) % 1; };
// dark (where it starts) → middle → light (far out); the middle sits between them in hue, a little more saturated
function shades(dark, light) {
  const [h0, s0, l0] = toHsl(dark), [h2, s2, l2] = toHsl(light);
  const c0 = toRgb([h0, Math.min(1, Math.max(0.35, s0 * 1.1)), Math.min(0.3, Math.max(0.13, l0))]);
  const c2 = toRgb([h2, Math.max(0.42, s2), Math.min(0.8, Math.max(0.62, l2))]);
  const c1 = toRgb([hueMix(h0, h2, 0.5), Math.min(0.72, Math.max(0.45, (s0 + s2) * 0.5)), 0.45]);
  const c = [c0, c1, c2];
  return { c, lum: 0.55 * lumOf(c0) + 0.3 * lumOf(c1) + 0.15 * lumOf(c2) };
}
const palProbe = (() => { try { const c = document.createElement('canvas'); c.width = c.height = 24; return c.getContext('2d', { willReadFrequently: true }); } catch { return null; } })();
/** the cover's darkest rich colour + its brightest vivid one → three shades (once per picture) */
function coverPalette(im) {
  if (im._pal !== undefined) return im._pal;
  im._pal = null;
  try {
    palProbe.clearRect(0, 0, 24, 24); palProbe.drawImage(im, 0, 0, 24, 24);
    const d = palProbe.getImageData(0, 0, 24, 24).data, px = [];
    for (let i = 0; i < d.length; i += 4) { const rgb = [d[i], d[i + 1], d[i + 2]], [h, s, l] = toHsl(rgb); px.push({ rgb, h, s, l }); }
    const avg = (arr) => { const n = arr.length || 1, r = arr.reduce((a, p) => [a[0] + p.rgb[0], a[1] + p.rgb[1], a[2] + p.rgb[2]], [0, 0, 0]); return r.map((v) => v / n); };
    const top = (score) => px.map((p) => [score(p), p]).sort((a, b) => b[0] - a[0]).slice(0, 48).filter((x) => x[0] > 0).map((x) => x[1]);
    let dark = top((p) => (p.s > 0.12 && p.l > 0.05 && p.l < 0.6 ? p.s * Math.pow(1 - p.l, 2) : 0));
    if (dark.length < 6) dark = top((p) => 1 - p.l); // a black-and-white cover: just its darkest part
    let light = top((p) => (p.s > 0.15 ? p.s * (1 - Math.abs(p.l - 0.62) * 1.4) : 0));
    if (light.length < 6) light = top((p) => p.l);
    im._pal = { ...shades(avg(dark), avg(light)), key: 'cover:' + im.src.length + ':' + im.src.slice(-24) };
  } catch { /* */ }
  return im._pal;
}
const pairCache = new Map();
function pairPalette(a, b) { const k = 'pair:' + a + b; let p = pairCache.get(k); if (!p) { p = { ...shades(hexRgb(a), hexRgb(b)), key: k }; pairCache.set(k, p); } return p; }
export function paletteFor(Y, S) {
  const mode = Y.ink || 'cover';
  if (mode === 'off' || Y.bg === 'none') return null;
  if (mode === 'custom') return pairPalette(Y.c1 || LY_DEF.c1, Y.c2 || LY_DEF.c2);
  return (S.art && coverPalette(S.art)) || pairPalette(LY_DEF.c1, LY_DEF.c2); // no cover yet: Prism violet → pink
}
/** per layer: which colours, how far they have spread (eased like water), seeping of a new song's colours, ripples */
function inkOf(R, Y, S, now, dt, src) {
  const P = paletteFor(Y, S);
  if (!P) { R.palKey = ''; R.palTo = null; R.palFrom = null; R.inkMix = 0; return null; }
  if (P.key !== R.palKey) { R.palFrom = R.palTo; R.palTo = P; R.palKey = P.key; R.palT0 = now; }
  const lv = levelOf(S, now);
  if (!S.fakeLevel) wantLevel(now);
  // loudness → reach, normalised to how loud this song has been lately (quiet and loud songs both move)
  R.gmax = Math.max(lv.lvl, (R.gmax || 0.25) * Math.exp(-dt / 6000));
  const norm = cl(lv.lvl / Math.max(0.12, R.gmax)), react = cl((Y.react ?? 60) / 100);
  const target = S.playing ? 0.34 + 0.95 * react * norm : 0.26;
  R.spread = R.spread == null ? 0.05 : R.spread + (target - R.spread) * (1 - Math.exp(-dt / 1400)); // slow, like water
  if (Y.ripple !== false && lv.beats !== R.beats) { if (R.beats != null && S.playing) R.rips.unshift({ t: now, a: 0.35 + 0.65 * cl(lv.amp) }); R.beats = lv.beats; }
  R.rips = R.rips.filter((r) => now - r.t < 3200).slice(0, 3);
  const a = cl((Y.inkA ?? 65) / 100) * (Y.bg === 'dark' ? 0.8 : 0.9);
  R.inkLum = P.lum; R.inkMix = Math.min(0.85, a * cl(R.spread * 1.4));
  return { a, c: P.c, o: (R.palFrom || P).c, olda: R.palFrom ? 1 : 0, seep: ss((now - R.palT0) / 4500), spread: R.spread, src, rip: R.rips.map((r) => [(now - r.t) / 1000, r.a]) };
}

/* ---------------------------------------------------------------- the record */
// a vinyl record: grooves, two still light wedges (the light doesn't turn with it), the cover as the label (turning)
function drawDisc(ctx, cx, cy, r, S, R, E) {
  const ang = R.spin / 3200 * Math.PI * 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.38)'; ctx.shadowBlur = r * 0.3 * E.rs; ctx.shadowOffsetY = r * 0.08 * E.rs;
  ctx.fillStyle = '#131218'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = Math.max(0.6 / E.rs, r * 0.012);
  for (let i = 0; i < 8; i++) { ctx.strokeStyle = `rgba(255,255,255,${i % 2 ? 0.07 : 0.035})`; ctx.beginPath(); ctx.arc(cx, cy, r * (0.44 + i * 0.066), 0, Math.PI * 2); ctx.stroke(); }
  const g = ctx.createConicGradient(-0.9, cx, cy);
  [[0, 0], [0.07, 0.2], [0.15, 0], [0.5, 0], [0.57, 0.14], [0.65, 0], [1, 0]].forEach(([o, a]) => g.addColorStop(o, `rgba(255,255,255,${a})`));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang); ctx.beginPath(); ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2); ctx.clip();
  if (S.art) { const im = S.art, k = Math.max(0.8 * r / im.naturalWidth, 0.8 * r / im.naturalHeight); ctx.drawImage(im, -im.naturalWidth * k / 2, -im.naturalHeight * k / 2, im.naturalWidth * k, im.naturalHeight * k); }
  else { const c = ctx.createConicGradient(0, 0, 0); ['#ffb6d5', '#9fd6ff', '#c6b3ff', '#ffe39a', '#ffb6d5'].forEach((x, i) => c.addColorStop(i / 4, x)); ctx.fillStyle = c; ctx.fillRect(-r, -r, 2 * r, 2 * r); }
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = r * 0.02; ctx.beginPath(); ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#ece9f4'; ctx.beginPath(); ctx.arc(cx, cy, r * 0.05, 0, Math.PI * 2); ctx.fill();
  const lw = Math.max(0.8 / E.rs, r * 0.02);
  ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(cx, cy, r - lw, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}
/** "♪ title · artist" (one line, squeezed to fit) */
function drawTitle(ctx, Y, S, col, x, y, size, maxW, align, E) {
  const t = (S.title || '') + (S.artist ? '  ·  ' + S.artist : '');
  if (!t.trim()) return;
  ctx.save(); ctx.font = fontOf(Y, size, 500); ctx.textBaseline = 'middle'; ctx.textAlign = align; ctx.fillStyle = col.mid;
  if (col.glow) { ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 0.6 * size * E.rs; }
  ctx.fillText('♪ ' + t, x, y, Math.max(1, maxW)); ctx.restore();
}

/** one line of words. mode: 'karaoke' | 'fade' | 'still' (all in the "on" colour) | 'preview' (the next line, not sung yet) */
function drawLine(ctx, E, lay, o) {
  const { x, y, sc, alpha = 1, blur = 0, mode, pos, settle = 1, fixed, col, left, s } = o;
  if (!lay || alpha <= 0.004 || sc <= 0.001) return;
  ctx.save();
  ctx.translate(x, y); ctx.scale(sc, sc);
  const a0 = ctx.globalAlpha * alpha;
  ctx.font = lay.font; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  if (col.glow) { ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 0.5 * s * E.rs * sc; }
  const x0 = left ? 0 : -lay.w / 2, lineBlur = !E.lite && blur > 0.25 ? blur : 0;
  for (const w of lay.ws) {
    const p = fixed != null ? fixed : cl((pos - w.a) / Math.max(1, w.b - w.a));
    const wx = x0 + w.x;
    let ga = a0, dy = 0, wb = lineBlur;
    if (mode === 'karaoke') {
      if (p <= 0) ctx.fillStyle = col.off; else if (p >= 1) ctx.fillStyle = col.on;
      else { const g = ctx.createLinearGradient(wx, 0, wx + w.w, 0), f = p * 1.3 - 0.15; g.addColorStop(cl(f - 0.15), col.on); g.addColorStop(cl(f + 0.15), col.off); ctx.fillStyle = g; }
      dy = -0.11 * s * Math.sin(Math.PI * p);
    } else if (mode === 'fade') {
      const e = fixed != null ? fixed : ss((pos - w.a + 0.07 * (w.b - w.a) + 60) / Math.max(1, w.b - w.a + 120));
      ga = a0 * lp(0.45, 0.22 + 0.78 * e, settle); dy = (1 - e) * 0.27 * s * settle;
      if (!E.lite) wb = Math.max(lineBlur, (1 - e) * 0.13 * s * settle);
      ctx.fillStyle = col.on;
    } else if (mode === 'preview') { ctx.fillStyle = o.karaoke ? col.off : col.on; ga = o.karaoke ? a0 : a0 * 0.45; }
    else ctx.fillStyle = col.on;
    if (ga <= 0.004) continue;
    ctx.globalAlpha = ga;
    ctx.filter = wb > 0.25 ? `blur(${(wb * E.rs * sc).toFixed(2)}px)` : 'none';
    const singing = (mode === 'karaoke' || mode === 'fade') && fixed == null && p > 0 && p < 1 && !E.lite;
    if (singing) { // the word being sung glows softly (Prism violet light), swelling and fading with the word
      ctx.save(); ctx.shadowColor = `rgba(199,155,255,${(0.85 * Math.sin(Math.PI * p)).toFixed(3)})`; ctx.shadowBlur = 0.55 * s * E.rs * sc; ctx.shadowOffsetY = 0;
      ctx.fillText(w.s, wx, dy); ctx.restore();
    } else ctx.fillText(w.s, wx, dy);
  }
  ctx.filter = 'none';
  ctx.restore();
}

/** frosted Prism glass: a blurred copy of what is already drawn under it + a light / dark tint + the rainbow edge */
function pane(ctx, E, Y, x, y, w, h, r, k, ink = null) {
  if (Y.bg === 'none') return;
  const f = cl((Y.frost ?? 35) / 100), dark = Y.bg === 'dark', u = k / 26;
  const P = new Path2D(); P.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2));
  const A = ctx.globalAlpha;
  if (!E.lite) { // the theme's long blue-violet shadow (two layers), only outside the glass
    ctx.save(); const O = new Path2D(); O.rect(x - w, y - h * 4, w * 3, h * 9); O.addPath(P); ctx.clip(O, 'evenodd'); ctx.fillStyle = '#000';
    for (const [c, b, oy] of dark ? [['rgba(0,0,0,.42)', 46, 18], ['rgba(0,0,0,.25)', 14, 5]] : [['rgba(86,104,168,.30)', 46, 18], ['rgba(86,104,168,.20)', 14, 5]]) {
      ctx.shadowColor = c; ctx.shadowBlur = b * u * E.rs; ctx.shadowOffsetY = oy * u * E.rs; ctx.fill(P);
    }
    ctx.restore();
    // real glass: refraction, dispersion, rim light, specular (glass.js, WebGL)
    if (A > 0.01 && glassPane(ctx, { x, y, w, h, r, dark, frost: f, unit: u, time: E.now, src: E.canvas, ink })) return;
  }
  // light mode / no WebGL: a plain tinted pane with the same rim
  const a = 0.18 + 0.4 * f;
  ctx.save(); ctx.fillStyle = dark ? `rgba(24,22,48,${Math.min(0.95, a + 0.3)})` : `rgba(255,255,255,${Math.min(0.92, a + 0.15)})`; ctx.fill(P);
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  [[0, 1], [0.3, 0.25], [0.55, 0.08], [1, 0.85]].forEach(([o, al]) => g.addColorStop(o, `rgba(255,255,255,${dark ? al * 0.55 : al})`));
  ctx.strokeStyle = g; ctx.lineWidth = Math.max(1 / E.rs, 1.2 * u); ctx.stroke(P); ctx.restore();
}

function stOf(L) { let R = st.get(L.id); if (!R) { R = { ink: null, inkT: 0, sensed: 0, rips: [], spinV: 0, vis: 0, last: 0, c: -2, p: -2, tc: 0, jump: false, w0: 0, w1: 0, tw: 0, spin: 0 }; st.set(L.id, R); } return R; }
/** current line index (−1 = before the first) → remembers the change time for the transitions */
function track(R, c, now) { if (c !== R.c) { R.jump = R.c === -2 || Math.abs(c - R.c) !== 1; R.p = R.c; R.c = c; R.tc = now; } return eo((now - R.tc) / 850); }

/**
 * draw a lyrics layer at the layer's transform (centre = 0,0, box L.w × L.h)
 * E = { canvas, rs, lite, selected }
 */
export function drawLyrics(ctx, L, now, E) {
  const Y = L.ly || (L.ly = { ...LY_DEF });
  const R = stOf(L), S = source(now);
  const dt = Math.min(120, Math.max(0, now - (R.last || now))); R.last = now;
  R.vis += ((S.live ? 1 : 0) - R.vis) * Math.min(1, dt / 280);
  if (R.vis < 0.01) { if (E.selected) hint(ctx, L, E, S); return; }
  R.spinV += ((S.playing ? 1 : 0) - R.spinV) * Math.min(1, dt / 700); R.spin += dt * R.spinV; R.dt = dt; // the record spins up / slows down
  if (R.ink != null) R.ink += (R.inkT - R.ink) * Math.min(1, dt / 400); else R.ink = Y.bg === 'glass' ? 1 : 0;
  E.ctx = ctx; E.now = now;
  const pos = S.pos - (Y.offset || 0);
  ctx.save(); ctx.globalAlpha *= ss(R.vis);
  try {
    if (Y.style === 'scroll') drawScroll(ctx, L, Y, R, S, pos, now, E);
    else if (Y.style === 'card') drawCard(ctx, L, Y, R, S, pos, now, E);
    else drawSub(ctx, L, Y, R, S, pos, now, E);
  } finally { ctx.restore(); }
}

// nothing to show yet: a quiet dashed box + one line (only while the layer is selected, so the camera stays clean)
function hint(ctx, L, E, S) {
  ctx.save();
  ctx.globalAlpha *= 0.85; ctx.setLineDash([10, 8]); ctx.lineWidth = 2 / E.rs; ctx.strokeStyle = 'rgba(255,255,255,.6)';
  ctx.beginPath(); ctx.roundRect(-L.w / 2, -L.h / 2, L.w, L.h, Math.min(24, L.h / 2)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `500 ${Math.max(12, Math.min(26, L.h / 5, L.w / 26))}px "IBM Plex Sans Thai", sans-serif`;
  ctx.fillText(!music.ok ? T`เนื้อเพลงใช้ได้ในโปรแกรม Prism Cam เท่านั้น` : S.title && !S.live ? T`หยุดเพลงอยู่ — กดเล่นต่อแล้วเนื้อเพลงจะขึ้น` : T`เปิดเพลงใน Spotify หรือ YouTube แล้วเนื้อเพลงจะขึ้นตรงนี้`, 0, 0, L.w - 20);
  ctx.restore();
}

/* karaoke / fade: the current line, the next one small under it; at each change the small one floats up and grows.
   Optional: the spinning record on the left (its colour seeps into the glass) and "♪ title · artist" above the words. */
function drawSub(ctx, L, Y, R, S, pos, now, E) {
  const lines = S.lines, nextOn = Y.next !== false, discOn = Y.disc !== false, titleOn = Y.title !== false;
  const s = L.h / ((nextOn ? 3.46 : 2.29) + (titleOn ? 0.72 : 0)), padX = 1.08 * s, padT = 0.46 * s;
  const D = discOn ? Math.min(L.h - 0.7 * s, 3.1 * s) : 0, lead = discOn ? 0.5 * s + D + 0.55 * s : padX;
  const font = fontOf(Y, s), kara = Y.style !== 'fade';
  let c, a, cur, nxt, prev;
  if (lines) { c = lineAt(lines, pos); a = track(R, c, now); cur = lines[c] || null; nxt = lines[c + 1] || null; prev = R.p >= 0 ? lines[R.p] : null; }
  else { c = -1; a = track(R, -1, now); cur = infoLine(S); nxt = null; prev = null; } // no lyrics: title · artist
  const lc = cur && layoutLine(ctx, font, cur), ln = nextOn && nxt ? layoutLine(ctx, font, nxt) : null, lpv = prev && a < 1 ? layoutLine(ctx, font, prev) : null;
  const inner = Math.max(s, L.w - lead - padX), fit = (l) => (l ? Math.min(1, inner / Math.max(1, l.w)) : 1);
  let tW = 0;
  if (titleOn && lines) { ctx.font = fontOf(Y, 0.42 * s, 500); tW = ctx.measureText('♪ ' + (S.title || '') + (S.artist ? '  ·  ' + S.artist : '')).width; }
  // the glass grows / shrinks with the line (eased, never jumps)
  const target = Math.min(L.w, Math.max(s * 3, Math.max(lc ? lc.w * fit(lc) : 0, ln ? ln.w * fit(ln) * 0.54 : 0, Math.min(inner, tW)) + lead + padX));
  if (Math.abs(target - R.w1) > 0.5) { R.w0 = R.tw ? lp(R.w0, R.w1, eo((now - R.tw) / 800)) : target; R.w1 = target; R.tw = now; }
  const pw = lp(R.w0, R.w1, eo((now - R.tw) / 800)), px0 = -pw / 2, textW = Math.max(s, pw - lead - padX), xc = px0 + lead + textW / 2, dcx = px0 + 0.5 * s + D / 2;
  sense(R, E, Y, px0, -L.h / 2, pw, L.h, now);
  const ink = inkOf(R, Y, S, now, R.dt || 16, discOn ? [dcx, 0] : [px0 + padX * 0.6, 0]);
  pane(ctx, E, Y, px0, -L.h / 2, pw, L.h, 0.85 * s, s, ink);
  const col = colors(Y, R);
  if (discOn) drawDisc(ctx, dcx, 0, D / 2, S, R, E);
  const y0 = -L.h / 2 + padT + (titleOn ? 0.72 * s : 0), curC = lines ? y0 + 0.75 * s : (titleOn ? 0.36 * s : 0), nextC = y0 + 2.03 * s, enterC = y0 + 3.16 * s, goneC = y0 - 0.25 * s;
  const mode = lines ? (kara ? 'karaoke' : 'fade') : 'still', base = { s, col, pos, mode, x: xc };
  // the words live inside the glass (right of the record): the old line slides out under the top edge, the new one rises in
  ctx.save();
  if (Y.bg !== 'none') { const C = new Path2D(); C.roundRect(px0, -L.h / 2, pw, L.h, Math.min(0.85 * s, L.h / 2)); ctx.clip(C); }
  if (discOn) { ctx.beginPath(); ctx.rect(px0 + lead - 0.3 * s, -L.h, pw, L.h * 2); ctx.clip(); }
  if (titleOn && lines) drawTitle(ctx, Y, S, col, xc, -L.h / 2 + padT + 0.3 * s, 0.42 * s, textW, 'center', E);
  const gapPulse = (l) => (l && l.gap ? 1 + 0.06 * Math.sin(now / 260) : 1);
  if (R.jump || !nextOn) { // first line, a seek, or no "next" row: the line rises into place
    if (lpv) drawLine(ctx, E, lpv, { ...base, y: curC - 0.62 * s * a, sc: fit(lpv), alpha: 1 - a, blur: 0.23 * s * a, fixed: 1 });
    drawLine(ctx, E, lc, { ...base, y: curC + 0.62 * s * (1 - a), sc: fit(lc) * gapPulse(cur), alpha: a, blur: 0.23 * s * (1 - a), settle: a });
    if (ln) drawLine(ctx, E, ln, { ...base, mode: 'preview', karaoke: kara, y: lp(enterC, nextC, a), sc: lp(0.42, 0.54, a) * fit(ln), alpha: a, blur: 0.15 * s * (1 - a) });
  } else {
    if (lpv) drawLine(ctx, E, lpv, { ...base, y: lp(curC, goneC, a), sc: lp(1, 0.9, a) * fit(lpv), alpha: 1 - a, blur: 0.23 * s * a, fixed: 1 });
    drawLine(ctx, E, lc, { ...base, y: lp(nextC, curC, a), sc: lp(0.54, 1, a) * fit(lc) * gapPulse(cur), settle: a });
    if (ln) drawLine(ctx, E, ln, { ...base, mode: 'preview', karaoke: kara, y: lp(enterC, nextC, a), sc: lp(0.42, 0.54, a) * fit(ln), alpha: a, blur: 0.15 * s * (1 - a) });
  }
  ctx.restore();
}

/* scroll: the whole list glides up; lines further from the current one get smaller, fainter and softer.
   Optional: the record on the left, "♪ title · artist" as a still header. */
function drawScroll(ctx, L, Y, R, S, pos, now, E) {
  const discOn = Y.disc !== false, titleOn = Y.title !== false;
  const LH = L.h / (titleOn ? 5.2 : 4.55), s = LH * 0.5, pad = s * 1.1, font = fontOf(Y, s);
  const D = discOn ? Math.min(L.h * 0.42, L.w * 0.3) : 0, lead = discOn ? pad * 0.8 + D + pad * 0.9 : pad, dcx = -L.w / 2 + pad * 0.8 + D / 2;
  sense(R, E, Y, -L.w / 2, -L.h / 2, L.w, L.h, now);
  const ink = inkOf(R, Y, S, now, R.dt || 16, discOn ? [dcx, 0] : [-L.w / 2 + pad, 0]);
  const col = colors(Y, R);
  pane(ctx, E, Y, -L.w / 2, -L.h / 2, L.w, L.h, 1.6 * s, s * 1.2, ink);
  if (discOn) drawDisc(ctx, dcx, 0, D / 2, S, R, E);
  ctx.save(); const P = new Path2D(); P.roundRect(-L.w / 2, -L.h / 2, L.w, L.h, Math.min(s * 2, L.h / 2)); ctx.clip(P);
  const lines = S.lines, inner = L.w - lead - pad, x0 = -L.w / 2 + lead;
  const listTop = -L.h / 2 + (titleOn ? 1.05 * LH : 0), fullH = L.h / 2 - listTop, cy = (listTop + L.h / 2) / 2;
  if (titleOn && lines) drawTitle(ctx, Y, S, col, x0, -L.h / 2 + 0.62 * LH, 0.78 * s, inner, 'left', E);
  if (!lines) {
    const l = infoLine(S), lay = layoutLine(ctx, font, l);
    drawLine(ctx, E, lay, { s, col, x: x0, y: 0, sc: Math.min(1, inner / Math.max(1, lay.w)), mode: 'still', left: true });
    ctx.restore(); return;
  }
  ctx.beginPath(); ctx.rect(-L.w, listTop, L.w * 2, fullH); ctx.clip();
  const c = lineAt(lines, pos), a = eo((now - (track(R, c, now), R.tc)) / 700), v = R.jump ? c : c - 1 + a;
  for (let j = Math.floor(v) - 3; j <= Math.ceil(v) + 3; j++) {
    if (j < 0 || j >= lines.length) continue;
    const d = Math.abs(j - v), y = cy + (j - v) * LH, edge = cl((fullH / 2 - Math.abs(y - cy)) / (0.28 * fullH));
    const lay = layoutLine(ctx, font, lines[j]);
    drawLine(ctx, E, lay, { s, col, pos, x: x0, y, left: true, sc: (1 - Math.min(d, 1.5) * 0.2) * Math.min(1, inner / Math.max(1, lay.w)) * (lines[j].gap && j === c ? 1 + 0.06 * Math.sin(now / 260) : 1),
      alpha: Math.max(0, 1 - d * 0.5) * edge, blur: Math.min(d, 2) * 0.055 * s, mode: 'fade', fixed: j < c ? 1 : j > c ? 0 : undefined });
  }
  ctx.restore();
}

/* mini card: the spinning record, title, artist, the line being sung, a progress bar */
function drawCard(ctx, L, Y, R, S, pos, now, E) {
  const u = L.h / 82, W = L.w, H = L.h, x0 = -W / 2, y0 = -H / 2, discOn = Y.disc !== false && Y.art !== false;
  const dcx = x0 + 12 * u + 29 * u;
  sense(R, E, Y, x0, y0, W, H, now);
  const ink = inkOf(R, Y, S, now, R.dt || 16, discOn ? [dcx, 0] : [x0 + 14 * u, 0]);
  const col = colors(Y, R);
  pane(ctx, E, Y, x0, y0, W, H, 22 * u, 26 * u, ink);
  let tx = x0 + 12 * u;
  if (discOn) { drawDisc(ctx, dcx, 0, 29 * u, S, R, E); tx = x0 + 12 * u + 58 * u + 12 * u; }
  const tw = Math.max(10 * u, W / 2 - 14 * u - tx);
  ctx.save(); ctx.beginPath(); ctx.rect(tx, y0, tw + 2 * u, H); ctx.clip();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  if (col.glow) { ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 6 * u * E.rs; }
  ctx.font = fontOf(Y, 13 * u, 500); ctx.fillStyle = col.on;
  const title = S.title || '', tW = ctx.measureText(title).width;
  ctx.fillText(title, tx, -22 * u, tw - 18 * u);
  // three bars that dance while it plays
  const bx = tx + Math.min(tW, tw - 18 * u) + 7 * u;
  for (let i = 0; i < 3; i++) { const hgt = (S.playing ? 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(now / 150 + i * 1.7)) : 0.3) * 11 * u; ctx.fillStyle = col.on; ctx.beginPath(); ctx.roundRect(bx + i * 5 * u, -22 * u + 5.5 * u - hgt, 3 * u, hgt, 1.5 * u); ctx.fill(); }
  ctx.font = fontOf(Y, 11 * u, 0); ctx.fillStyle = col.mid;
  ctx.fillText(S.artist || S.app || '', tx, -8 * u, tw);
  ctx.restore();
  // the line being sung: old one rises away, new one comes up
  const font = fontOf(Y, 16 * u);
  ctx.save(); ctx.beginPath(); ctx.rect(tx, y0, tw + 2 * u, H); ctx.clip();
  const lines = S.lines;
  if (lines) {
    const c = lineAt(lines, pos), a = track(R, c, now), cur = lines[c], prev = R.p >= 0 && a < 1 ? lines[R.p] : null;
    const fit = (l) => Math.min(1, tw / Math.max(1, l.w));
    if (prev) { const l = layoutLine(ctx, font, prev); drawLine(ctx, E, l, { s: 16 * u, col, pos, x: tx, y: 9 * u - 16 * u * a, sc: fit(l), alpha: 1 - a, blur: 6 * u * a, mode: 'fade', fixed: 1, left: true }); }
    if (cur) { const l = layoutLine(ctx, font, cur); drawLine(ctx, E, l, { s: 16 * u, col, pos, x: tx, y: 9 * u + 16 * u * (1 - a), sc: fit(l) * (cur.gap ? 1 + 0.06 * Math.sin(now / 260) : 1), alpha: a, blur: 6 * u * (1 - a), mode: Y.cardFill ? 'karaoke' : 'fade', settle: 1, left: true }); }
  } else if (S.album) { ctx.font = fontOf(Y, 12 * u, 0); ctx.fillStyle = col.off; ctx.textBaseline = 'middle'; ctx.fillText(S.album, tx, 9 * u, tw); }
  ctx.restore();
  // progress
  const by = 22 * u, p = S.dur ? cl(S.pos / S.dur) : 0;
  ctx.save(); ctx.fillStyle = col.off; ctx.beginPath(); ctx.roundRect(tx, by, tw, 3 * u, 1.5 * u); ctx.fill();
  ctx.fillStyle = col.on; ctx.beginPath(); ctx.roundRect(tx, by, Math.max(3 * u, tw * p), 3 * u, 1.5 * u); ctx.fill(); ctx.restore();
}

/** short status text for the properties panel */
export function musicStatus() {
  if (!music.ok) return T`อ่านเพลงที่กำลังเล่นไม่ได้ (ใช้ได้ในโปรแกรม Prism Cam บน Windows 10/11)`;
  if (music.none) return music.demo ? T`กำลังแสดงเพลงตัวอย่าง — เปิดเพลงจริงเมื่อไรจะเปลี่ยนเป็นเพลงนั้นเอง` : T`ยังไม่มีเพลงเล่นในเครื่อง — เปิดเพลงใน Spotify, YouTube หรือโปรแกรมเล่นเพลงอื่น`;
  if (music.ad) return T`โฆษณาของ Spotify — ซ่อนไว้ก่อน เพลงถัดไปจะขึ้นเอง`;
  const who = `${music.title}${music.artist ? ' · ' + music.artist : ''}${music.app ? ' (' + music.app + ')' : ''}`;
  const ly = (music.ly || {}).state;
  const tail = { loading: T`กำลังหาเนื้อเพลง…`, ok: (music.ly.source === 'file' ? T`ใช้เนื้อเพลงของคุณ` : T`พบเนื้อเพลงตรงจังหวะ (LRCLIB)`), none: T`ไม่พบเนื้อเพลงของเพลงนี้ — แสดงชื่อเพลงแทน`, plain: T`เพลงนี้มีแต่เนื้อร้อง ไม่มีจังหวะ — แสดงชื่อเพลงแทน`, net: T`ต่อเน็ตไม่ได้ — จะลองหาเนื้อเพลงใหม่เอง` }[ly] || '';
  return (music.playing ? '▶ ' : '❚❚ ') + who + ' — ' + tail;
}
/** test hook: pretend this song is playing (real LRCLIB lookup, our own clock) — never touches the user's player */
export async function fakeSong(artist, title, durMs = 0, fromMs = 0) {
  music.fake = true;
  Object.assign(music, { ok: true, none: false, ad: false, key: artist + '\u0001' + title, title, artist, album: '', app: 'test', dur: durMs, pos: fromMs, at: performance.now(), playing: true, artImg: null, ly: { state: 'loading' } });
  bus.emit('music'); await loadLyrics(music.key);
  return music.ly;
}
export const forgetLyricsLayer = (id) => st.delete(id);
