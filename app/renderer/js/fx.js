// Per-layer GPU effects: chroma key, AI background removal / blur. Each processed layer owns a small WebGL canvas
// whose output (premultiplied RGBA) is drawn into the 2D scene like any other image.
const VS = `attribute vec2 p; varying vec2 uv; void main(){ uv = p * .5 + .5; uv.y = 1. - uv.y; gl_Position = vec4(p, 0., 1.); }`;
const FS = `precision mediump float;
varying vec2 uv;
uniform sampler2D uTex, uMask;
uniform vec2 uPx;
uniform float uKeyOn, uSim, uSmooth, uSpill, uAi, uBlur, uInvert;
uniform vec3 uKey;
vec2 cbcr(vec3 c){ return vec2(-.168736 * c.r - .331264 * c.g + .5 * c.b, .5 * c.r - .418688 * c.g - .081312 * c.b); }
void main(){
  vec4 c = texture2D(uTex, uv);
  float a = 1.;
  if (uKeyOn > .5) {
    float d = distance(cbcr(c.rgb), cbcr(uKey));
    a = smoothstep(uSim, uSim + uSmooth + .001, d);
    // spill: pull the key hue out of the edges
    float mx = max(uKey.r, max(uKey.g, uKey.b));
    vec3 kd = step(mx - .001, uKey);
    float other = dot(c.rgb, 1. - kd) / max(1., dot(1. - kd, vec3(1.)));
    float kv = dot(c.rgb, kd) / max(1., dot(kd, vec3(1.)));
    c.rgb -= kd * max(0., kv - other) * uSpill;
  }
  if (uAi > .5) {
    // soften the low-res mask a little
    float m = (texture2D(uMask, uv).r * 2. + texture2D(uMask, uv + uPx * 3.).r + texture2D(uMask, uv - uPx * 3.).r
      + texture2D(uMask, uv + vec2(uPx.x, -uPx.y) * 3.).r + texture2D(uMask, uv + vec2(-uPx.x, uPx.y) * 3.).r) / 6.;
    if (uInvert > .5) m = 1. - m;
    m = smoothstep(.3, .7, m);
    if (uAi < 1.5) a *= m;
    else {
      vec3 b = vec3(0.); float n = 0.;
      for (int i = 0; i < 24; i++) {
        float t = float(i) + .5, r = sqrt(t / 24.), th = t * 2.39996;
        b += texture2D(uTex, uv + vec2(cos(th), sin(th)) * r * uBlur * uPx).rgb; n += 1.;
      }
      c.rgb = mix(b / n, c.rgb, m);
    }
  }
  gl_FragColor = vec4(c.rgb * a, a);
}`;

const hex = (s) => { const n = parseInt(String(s).slice(1), 16) || 0; return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

export function createProc() {
  const cv = document.createElement('canvas');
  const gl = cv.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(o)); return o; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr); gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.bindAttribLocation(pr, 0, 'p'); gl.linkProgram(pr); gl.useProgram(pr);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const U = {}; for (const n of ['uTex', 'uMask', 'uPx', 'uKeyOn', 'uSim', 'uSmooth', 'uSpill', 'uAi', 'uBlur', 'uInvert', 'uKey']) U[n] = gl.getUniformLocation(pr, n);
  const tex = (unit) => {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  };
  const tSrc = tex(0), tMask = tex(1);
  gl.activeTexture(gl.TEXTURE1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([255]));
  gl.uniform1i(U.uTex, 0); gl.uniform1i(U.uMask, 1);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  return {
    canvas: cv,
    setMask(bytes, w, h) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tMask); gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes); },
    // src: video / image element · L: layer settings → returns the canvas (same aspect as the source)
    render(src, sw, sh2, L, hasMask) {
      if (gl.isContextLost()) return null; // the driver reset this context: fall back to the plain video until the layer is rebuilt
      const k = Math.min(1, 1280 / sw), w = Math.max(2, Math.round(sw * k)), h = Math.max(2, Math.round(sh2 * k));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tSrc);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); } catch { return null; }
      gl.uniform2f(U.uPx, 1 / w, 1 / h);
      gl.uniform1f(U.uKeyOn, L.key.on ? 1 : 0);
      gl.uniform3fv(U.uKey, hex(L.key.color));
      gl.uniform1f(U.uSim, L.key.sim / 250); gl.uniform1f(U.uSmooth, L.key.smooth / 250); gl.uniform1f(U.uSpill, L.key.spill / 100);
      const ai = hasMask ? (L.ai.mode === 'remove' ? 1 : L.ai.mode === 'blur' ? 2 : 0) : 0;
      gl.uniform1f(U.uAi, ai); gl.uniform1f(U.uBlur, L.ai.blur); gl.uniform1f(U.uInvert, L.ai.invert ? 1 : 0);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return cv;
    },
    dispose() { const e = gl.getExtension('WEBGL_lose_context'); if (e) e.loseContext(); },
  };
}

/* ---------------------------------------------------------------- AI person segmentation (MediaPipe, bundled offline) */
let seg = null, segLoading = null, segFailed = false, lastTs = 0;
export const segState = () => (seg ? 'ready' : segFailed ? 'failed' : segLoading ? 'loading' : 'idle');
export function loadSegmenter() {
  if (seg || segFailed) return Promise.resolve(seg);
  if (!segLoading) {
    segLoading = (async () => {
      try {
        const base = new URL('../vendor/mediapipe/', import.meta.url).href;
        const { FilesetResolver, ImageSegmenter } = await import(base + 'vision_bundle.mjs');
        const files = await FilesetResolver.forVisionTasks(base + 'wasm');
        const make = (delegate) => ImageSegmenter.createFromOptions(files, {
          baseOptions: { modelAssetPath: base + 'selfie_segmenter.tflite', delegate },
          runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
        });
        try { seg = await make('GPU'); } catch { seg = await make('CPU'); }
      } catch (err) { console.error('segmenter', err); segFailed = true; }
      return seg;
    })();
  }
  return segLoading;
}
// → {bytes,w,h} person-confidence mask, or null if not ready
export function segment(src, out) {
  if (!seg) return null;
  const ts = Math.max(lastTs + 1, Math.round(performance.now())); lastTs = ts;
  let res = null;
  try {
    seg.segmentForVideo(src, ts, (r) => {
      const m = r.confidenceMasks && r.confidenceMasks[r.confidenceMasks.length - 1];
      if (!m) return;
      const f = m.getAsFloat32Array(), n = f.length;
      const bytes = out && out.bytes && out.bytes.length === n ? out.bytes : new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = f[i] * 255;
      res = { bytes, w: m.width, h: m.height };
    });
  } catch (err) { console.warn('segment', err); }
  return res;
}
