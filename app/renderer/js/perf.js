// Prism Cam — speed on weak PCs (integrated graphics, e.g. Ryzen 5500GT / Intel UHD):
//  · render scale: the scene is drawn into a smaller canvas (the picture keeps its layout, it is just fewer pixels)
//  · light mode ("โหมดเครื่องเบา"): smaller render, AI / hand tracking less often, no animated glass
//  · auto quality: drops the render scale one step when the PC falls behind, raises it again when it has room
//  · GPU converter: the graphics chip turns the scene into the NV12 picture the virtual camera needs
//    (and scales it back to full size), so the CPU moves 1.4 MB per frame instead of 3.7 MB and converts nothing
//  · timings for the speed panel (click the fps number in the status bar)
import { api, native, bus, T, toast } from './core.js';

const KEY = 'prismcam.perf';
const SCALES = [1, 0.75, 0.5];
let saved = null; try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* storage unavailable */ }

export const perf = {
  lite: !!(saved && saved.lite), auto: saved ? saved.auto !== false : true, gpuOn: saved ? saved.gpu !== false : true,
  level: 0, cap30: false,                     // auto-quality step (index into SCALES)
  ms: { draw: 0, seg: 0, send: 0 }, // smoothed cost per frame in ms
  fps: 0, sent: 0, cpu: -1, path: '', igpu: '', firstRun: !saved,
};
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ lite: perf.lite, auto: perf.auto, gpu: perf.gpuOn })); } catch { /* */ } };
const applyClass = () => document.documentElement.classList.toggle('lite', perf.lite);
applyClass();

// 60 fps project on a PC that can't keep up → draw at 30 for now (auto quality), before lowering the resolution
export const liveFps = (fps) => (perf.cap30 && fps > 30 ? 30 : fps);
export function resetCap() { if (perf.cap30) { perf.cap30 = false; bus.emit('perf'); } }
export const renderScale = () => SCALES[Math.max(perf.lite ? 1 : 0, perf.level)];
// how often the AI background runs (every n-th frame) and the minimum gap between hand-tracking frames
export const segEvery = (fps = 30) => (perf.lite || perf.level >= 2 ? 3 : 2) * (fps > 30 ? 2 : 1); // ≈ 15 / 10 masks a second at any frame rate
export const handGap = () => (perf.lite || perf.level >= 2 ? 66 : 32);

export function setLite(on, quiet) {
  on = !!on; if (on === perf.lite) return;
  perf.lite = on; perf.level = 0; save(); applyClass(); bus.emit('perf');
  if (!quiet) toast(on ? T`เปิดโหมดเครื่องเบาแล้ว — ภาพลื่นขึ้น ความคมชัดลดลงเล็กน้อย` : T`ปิดโหมดเครื่องเบาแล้ว`);
}
export function setAuto(on) { perf.auto = !!on; if (!perf.auto && perf.level) { perf.level = 0; bus.emit('perf'); } save(); }
export function setGpu(on, quiet) { on = !!on; if (on === perf.gpuOn) return; perf.gpuOn = on; save(); if (!quiet) toast(T`มีผลเมื่อเปิดโปรแกรมใหม่`); }

export const ema = (k, v) => { perf.ms[k] = perf.ms[k] ? perf.ms[k] * 0.9 + v * 0.1 : v; };

/* ------------------------------------------------------------ auto quality */
// Called once per drawn frame. Judges the PC once a second:
//   behind = fewer than 85 % of the wanted frames, the frame work eats > 80 % of the frame time, or the whole PC is > 92 % busy
//   room   = frame work < 35 % of the frame time and the PC below 75 % — for 10 s in a row
let winT = 0, winN = 0, sentN = 0, bad = 0, good = 0, warned = false;
let calmUntil = performance.now() + 10000; // start-up (WebView, camera opening) always spikes the CPU
export const calm = (ms = 5000) => { calmUntil = Math.max(calmUntil, performance.now() + ms); };
export const countSent = () => { sentN++; };
export function frameDone(now, fps) {
  const target = liveFps(fps);
  winN++;
  if (!winT) { winT = now; return; }
  const dt = now - winT; if (dt < 1000) return;
  perf.fps = Math.round(winN * 1000 / dt); perf.sent = Math.round(sentN * 1000 / dt); winT = now; winN = sentN = 0;
  if (native) api.invoke('perf:cpu').then((c) => { if (typeof c === 'number') perf.cpu = c; }, () => {});
  bus.emit('perf:tick');
  if (!perf.auto || now < calmUntil) { bad = good = 0; return; }
  const budget = 1000 / target, work = perf.ms.draw + perf.ms.send;
  const behind = perf.fps < target * 0.85 || work > budget * 0.8 || perf.cpu > 92;
  const room = perf.fps >= target * 0.95 && work < budget * 0.35 && perf.cpu >= 0 && perf.cpu < 75;
  bad = behind ? bad + 1 : 0; good = room ? good + 1 : 0;
  const lo = perf.lite ? 1 : 0;
  if (bad >= 3 && fps > 30 && !perf.cap30) {
    perf.cap30 = true; bad = good = 0; bus.emit('perf');
    api.invoke('app:log', `perf: auto 60 → 30 fps fps=${perf.fps} work=${work.toFixed(1)}ms cpu=${perf.cpu}`).catch(() => {});
    toast(T`เครื่องไม่ไหวที่ 60 fps — ลดเหลือ 30 fps ชั่วคราว`);
  } else if (bad >= 3 && Math.max(lo, perf.level) < SCALES.length - 1) {
    perf.level = Math.max(lo, perf.level) + 1; bad = good = 0; bus.emit('perf');
    api.invoke('app:log', `perf: auto down → scale ${renderScale()} fps=${perf.fps} work=${work.toFixed(1)}ms cpu=${perf.cpu}`).catch(() => {});
    if (!warned) { warned = true; toast(T`เครื่องทำงานหนัก — ลดความละเอียดภาพลงให้ชั่วคราวเพื่อให้ภาพลื่น`); }
  } else if (good >= 10 && perf.level > lo) {
    perf.level--; bad = good = 0; bus.emit('perf');
    api.invoke('app:log', `perf: auto up → scale ${renderScale()}`).catch(() => {});
  } else if (good >= 10 && perf.cap30 && work < 500 / fps) {
    perf.cap30 = false; bad = good = 0; bus.emit('perf');
    api.invoke('app:log', 'perf: auto back to 60 fps').catch(() => {});
  }
}

/* ------------------------------------------------- integrated GPU detection */
export function detectIgpu() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    const e = gl && gl.getExtension('WEBGL_lose_context'); if (e) e.loseContext();
    // integrated chips: AMD "Radeon(TM) Graphics" / "Radeon Vega", Intel UHD / HD / Iris; discrete cards carry a model number (RX 6600, GTX, RTX, Arc A…)
    const igpu = /Radeon\(TM\) Graphics|Radeon Graphics|Vega \d|Intel\(R\) (U?HD|Iris)|Intel.*(UHD|HD Graphics|Iris)/i.test(name) && !/\bRX\b|Arc/i.test(name);
    perf.igpu = name.replace(/^ANGLE \(|\)$/g, '');
    return igpu;
  } catch { return false; }
}

/* ------------------------------------------------------- GPU NV12 converter */
// One WebGL2 pass renders a (w/4) × (h·1.5) RGBA target whose bytes ARE the NV12 picture: the top h rows pack four
// Y values per texel, the bottom h/2 rows pack two U/V pairs. The source is sampled with linear filtering, so a
// smaller scene canvas comes out scaled to the full output size. Same BT.601 limited-range maths as vcam_host::push.
const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;
const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex; uniform vec2 uOut;
out vec4 o;
vec3 px(vec2 q){ return texture(uTex, q / uOut).rgb * 255.; }
float Y(vec3 c){ return 16. + floor((47. * c.r + 157. * c.g + 16. * c.b + 128.) / 256.); }
float U(vec3 c){ return clamp(128. + floor((-26. * c.r - 87. * c.g + 112. * c.b + 128.) / 256.), 0., 255.); }
float V(vec3 c){ return clamp(128. + floor((112. * c.r - 102. * c.g - 10. * c.b + 128.) / 256.), 0., 255.); }
void main(){
  vec2 f = floor(gl_FragCoord.xy);
  float x0 = f.x * 4.;
  if (f.y < uOut.y) {
    float y = f.y + .5;
    o = vec4(Y(px(vec2(x0 + .5, y))), Y(px(vec2(x0 + 1.5, y))), Y(px(vec2(x0 + 2.5, y))), Y(px(vec2(x0 + 3.5, y)))) / 255.;
  } else {
    float y = (f.y - uOut.y) * 2. + 1.;      // between the two rows of the 2×2 block → linear sampling averages them
    vec3 a = px(vec2(x0 + 1., y)), b = px(vec2(x0 + 3., y));
    o = vec4(U(a), V(a), U(b), V(b)) / 255.;
  }
}`;
let G = null, gpuDead = false;
const EMPTY = new Uint8Array(0);
function initGpu() {
  const cv = document.createElement('canvas');
  const gl = cv.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false, depth: false, stencil: false });
  if (!gl) return null;
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
  gl.bindAttribLocation(pr, 0, 'p'); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
  gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.uniform1i(gl.getUniformLocation(pr, 'uTex'), 0);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
  cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); G = null; });
  // two pixel-pack buffers: frame N is read back asynchronously while frame N+1 renders — a plain readPixels would
  // make the page wait for the graphics chip every frame (≈ 6–8 ms measured on an RX 6600)
  return { cv, gl, uOut: gl.getUniformLocation(pr, 'uOut'), buf: null, pbo: [gl.createBuffer(), gl.createBuffer()], slot: 0, fence: [null, null], size: [0, 0] };
}
// scene canvas → NV12 bytes at w×h (the full output size) of the PREVIOUS call's picture (one frame late),
// [] while the first one is still on its way, or null when the GPU path is not usable
export function nv12(src, w, h) {
  if (!perf.gpuOn || gpuDead || w % 4 || h % 2 || w * h > 1920 * 1080) return null;
  try {
    if (!G) G = initGpu();
    if (!G) { gpuDead = true; return null; }
    const { cv, gl } = G;
    if (gl.isContextLost()) { G = null; return null; }
    const tw = w / 4, th = h * 3 / 2, n = w * h * 3 / 2;
    if (cv.width !== tw || cv.height !== th) { cv.width = tw; cv.height = th; }
    if (!G.buf || G.buf.length !== n) G.buf = new Uint8Array(n);
    // 1. collect the frame queued last time, if the graphics chip has finished it
    let out = EMPTY;
    const prev = G.slot ^ 1, f = G.fence[prev];
    if (f) {
      const st = gl.clientWaitSync(f, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
        gl.deleteSync(f); G.fence[prev] = null;
        if (G.size[prev] === n) {
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, G.pbo[prev]);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, G.buf);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          out = G.buf;
        }
      } else if (st === gl.WAIT_FAILED) throw new Error('fence wait failed');
      else return EMPTY; // still busy: skip this frame rather than wait
    }
    // 2. convert this frame and queue its read-back
    gl.viewport(0, 0, tw, th);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.uniform2f(G.uOut, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const s = G.slot;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, G.pbo[s]);
    if (G.size[s] !== n) { gl.bufferData(gl.PIXEL_PACK_BUFFER, n, gl.STREAM_READ); G.size[s] = n; }
    gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    G.fence[s] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    G.slot ^= 1;
    const err = gl.getError(); if (err) throw new Error('gl error ' + err);
    perf.path = 'gpu';
    return out;
  } catch (err) {
    gpuDead = true; G = null; perf.path = 'cpu';
    api.invoke('app:log', 'perf: GPU converter off — ' + err).catch(() => {});
    return null;
  }
}
