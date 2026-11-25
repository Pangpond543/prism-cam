// Prism Cam — refracting Prism glass for canvas-drawn panes (lyrics layer).
// Same four layers as the Prism glass theme (prism-glass-theme skill §4), done in one small WebGL pass so it can live
// inside the camera picture: the scene under the pane is copied (in the pane's own frame, so turned layers work),
// lightly frosted, then refracted — bent towards the rim like a thick lens, with a slow liquid ripple (the theme's
// turbulence displacement), a red / blue split at the edges (prism dispersion), the theme's diagonal tint
// (.40 → .10 → .22), a light rim, an inner top line + glow, a drifting specular highlight and a faint rainbow sheen.
// Returns false when WebGL is not available → the caller draws the plain pane.

const VS = `attribute vec2 a; varying vec2 v; void main(){ v = vec2(a.x * .5 + .5, .5 - a.y * .5); gl_Position = vec4(a, 0., 1.); }`;
const FS = `precision highp float;
varying vec2 v;
uniform sampler2D T; uniform vec2 R; uniform float P, RAD, TIME, DARK, TINT, REFR, K, SHEEN;
// colour in the glass (lyrics): shades dark → light (C = new song, O = the one before), where it starts (SRC),
// how far it has spread (SPREAD, follows the loudness), how far the new colours have seeped in (SEEP), water ripples
uniform float INK, SEEP, OLDA, SPREAD; uniform vec3 C0, C1, C2, O0, O1, O2; uniform vec2 SRC; uniform vec2 RIP[3];
float sd(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ return n(p) * .62 + n(p * 2.07 + 7.3) * .38; }
// the theme's five pastels (ice, lilac, rose, mint, cream) as a loop — prism light, never a hard RGB rainbow
vec3 hue(float x){ float t = fract(x) * 5.; vec3 c0 = vec3(.729, .831, 1.), c1 = vec3(.839, .749, 1.), c2 = vec3(1., .761, .871), c3 = vec3(.702, .949, .902), c4 = vec3(1., .89, .741);
  return t < 1. ? mix(c0, c1, t) : t < 2. ? mix(c1, c2, t - 1.) : t < 3. ? mix(c2, c3, t - 2.) : t < 4. ? mix(c3, c4, t - 3.) : mix(c4, c0, t - 4.); }
void main(){
  vec2 px = v * R, c = R * .5, b = c - P, p = px - c;
  float d = sd(p, b, RAD);
  float inside = 1. - smoothstep(-.8, .8, d);
  if (inside <= 0.) { gl_FragColor = vec4(0.); return; }
  vec2 e = vec2(1., 0.);
  vec2 nr = normalize(vec2(sd(p + e.xy, b, RAD) - sd(p - e.xy, b, RAD), sd(p + e.yx, b, RAD) - sd(p - e.yx, b, RAD)) + 1e-5);
  float bevel = max(4. * K, min(min(b.x, b.y) * .85, RAD * 1.25 + 8. * K));
  float edge = clamp(1. + d / bevel, 0., 1.), e3 = edge * edge * edge;
  // refraction: a thick rim bends the picture inwards; the whole sheet ripples slowly
  vec2 q = px / (70. * K);
  vec2 w = vec2(fbm(q + vec2(TIME * .045, 1.7)), fbm(q + vec2(5.2, TIME * .038))) - .5;
  vec2 off = -nr * e3 * REFR + w * REFR * .4;
  // water ripples from the source on heavy beats: a ring that bends the picture as it passes, then calms
  float diag = length(b * 2.), rr0 = length(px - SRC) / diag, rip = 0.;
  vec2 dir = (px - SRC) / max(1., length(px - SRC));
  for (int i = 0; i < 3; i++) {
    float age = RIP[i].x, amp = RIP[i].y;
    if (amp > 0.) { float ring = exp(-pow((rr0 - age * .38) / .05, 2.)), env = amp * exp(-age * 1.25);
      rip += ring * env; off += dir * ring * env * REFR * 1.1 * sin((rr0 - age * .38) * 70.); }
  }
  float disp = REFR * (.06 + .22 * e3);
  vec3 col = vec3(texture2D(T, (px + off + nr * disp) / R).r, texture2D(T, (px + off) / R).g, texture2D(T, (px + off - nr * disp) / R).b);
  // saturate 175 % · brightness 1.05 (theme backdrop-filter)
  float l = dot(col, vec3(.2126, .7152, .0722));
  col = clamp(mix(vec3(l), col, DARK > .5 ? 1.2 : 1.75) * 1.05, 0., 1.);
  // tint: --glass (135°: .40 → .10 @48 % → .22); dark = indigo-tinted glass over a dimmed picture
  float g = clamp((v.x + v.y) * .5, 0., 1.);
  float ta = (g < .48 ? mix(.40, .10, g / .48) : mix(.10, .22, (g - .48) / .52)) * TINT;
  if (DARK > .5) col = mix(col * .42, vec3(.075, .085, .19), clamp(.55 + ta * .8, 0., .9)) + vec3(.47, .53, .86) * .045;
  else col = mix(col, vec3(1.), ta);
  // bevel light from the top-left
  col += dot(nr, normalize(vec2(-.6, -1.))) * e3 * (DARK > .5 ? .10 : .16);
  // prism sheen: faint rainbow sweeping across, stronger near the rim
  float hx = dot(px, vec2(.55, .83)) / (R.x * .9) - TIME * .025;
  col = mix(col, hue(hx), SHEEN * (DARK > .5 ? .45 : 1.) * (.04 + .22 * e3));
  // drifting specular highlight (top-left, out of the box), inner glow, inner top line
  vec2 sc = vec2(R.x * (.28 + .12 * sin(TIME * .21)), -R.y * .25);
  float sp = exp(-dot((px - sc) / vec2(R.x * .55, R.y * 1.05), (px - sc) / vec2(R.x * .55, R.y * 1.05)) * 2.2);
  col += sp * (DARK > .5 ? .12 : .30);
  col += (1. - smoothstep(0., 22. * K, -d)) * (DARK > .5 ? .05 : .12);
  // ink in water: the darkest shade at the source, lighter further out; the edge wanders slowly (two noise layers)
  if (INK > 0.) {
    vec2 qi = px / (120. * K);
    float wob = (fbm(qi + vec2(TIME * .018, -TIME * .013)) - .5) * .6 + (fbm(qi * 2.4 - vec2(TIME * .03, 0.)) - .5) * .2;
    float rr = rr0 + wob * .45;
    float ia = 1. - smoothstep(SPREAD - .3, SPREAD + .14, rr);
    float u1 = clamp(rr / .4, 0., 1.), u2 = clamp((rr - .4) / .6, 0., 1.);
    vec3 nc = rr < .4 ? mix(C0, C1, u1) : mix(C1, C2, u2), oc = rr < .4 ? mix(O0, O1, u1) : mix(O1, O2, u2);
    // a new song's colours seep out from the source, slowly, with the same wandering edge
    float front = SEEP * 1.5 - .2, sp = 1. - smoothstep(front - .25, front + .1, rr + wob * .3);
    col = mix(col, mix(oc, nc, sp), ia * mix(OLDA, 1., sp) * INK);
    col += rip * (DARK > .5 ? .05 : .09);
  }
  float top = 1. - smoothstep(0., 1.6 * K, p.y + b.y);
  col = mix(col, vec3(1.), top * (DARK > .5 ? .35 : .9) * smoothstep(RAD * .7, RAD * 1.2, b.x - abs(p.x)));
  // rim: white 1 → .25 @30 % → .08 @55 % → .85 (mask-composite border of .glass::before)
  float rimA = g < .3 ? mix(1., .25, g / .3) : g < .55 ? mix(.25, .08, (g - .3) / .25) : mix(.08, .85, (g - .55) / .45);
  float rim = 1. - smoothstep(0., 1.3 * K, -d);
  col = mix(col, vec3(1.), rim * rimA * (DARK > .5 ? .55 : .95));
  gl_FragColor = vec4(clamp(col, 0., 1.) * inside, inside);
}`;

let gl = null, cv = null, prog = null, tex = null, U = {}, stage = null, sctx = null, dead = false;
function init() {
  try {
    cv = document.createElement('canvas'); cv.width = cv.height = 4;
    gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('no webgl');
    cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); dead = true; });
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    for (const k of ['T', 'R', 'P', 'RAD', 'TIME', 'DARK', 'TINT', 'REFR', 'K', 'SHEEN', 'INK', 'SEEP', 'OLDA', 'SPREAD', 'C0', 'C1', 'C2', 'O0', 'O1', 'O2', 'SRC', 'RIP']) U[k] = gl.getUniformLocation(prog, k);
    tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    stage = document.createElement('canvas'); sctx = stage.getContext('2d');
  } catch (err) { console.warn('glass', err); dead = true; }
}

/**
 * Draw a refracting glass pane at (x, y, w, h, r) in ctx's current (layer) coordinates.
 * o = { x, y, w, h, r, dark, frost 0..1, unit (local px per "26 px of text"), alpha, time ms, src canvas,
 *       ink?: { a, c: [3 × rgb], o: [3 × rgb], olda, seep, spread, src: [x, y] (layer coords), rip: [[age s, amp] …] } }
 */
export function glassPane(ctx, o) {
  if (dead) return false;
  if (!gl) { init(); if (dead) return false; }
  const m = ctx.getTransform(), k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  const u = o.unit, refr = 15 * u, blur = (1.5 + 15 * o.frost) * u, pad = Math.ceil(refr * 1.6 + blur * 2.2 + 2);
  let W = Math.ceil((o.w + 2 * pad) * k), H = Math.ceil((o.h + 2 * pad) * k);
  const cap = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048), sh = Math.min(1, cap / W, cap / H), kk = k * sh;
  W = Math.max(2, Math.ceil((o.w + 2 * pad) * kk)); H = Math.max(2, Math.ceil((o.h + 2 * pad) * kk));
  if (stage.width !== W || stage.height !== H) { stage.width = W; stage.height = H; } else { sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.clearRect(0, 0, W, H); }
  // the scene under the pane, in the pane's own frame (stage px → layer coords → canvas px)
  const T = m.multiply(new DOMMatrix([1 / kk, 0, 0, 1 / kk, o.x - pad, o.y - pad]));
  try {
    sctx.setTransform(T.inverse()); sctx.filter = blur * kk > 0.4 ? `blur(${(blur * kk).toFixed(2)}px)` : 'none';
    sctx.drawImage(o.src, 0, 0); sctx.filter = 'none';
  } catch { return false; }
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  gl.viewport(0, 0, W, H);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, stage); } catch { return false; }
  gl.uniform1i(U.T, 0); gl.uniform2f(U.R, W, H); gl.uniform1f(U.P, pad * kk); gl.uniform1f(U.RAD, Math.min(o.r, o.h / 2, o.w / 2) * kk);
  gl.uniform1f(U.TIME, (o.time % 1e6) / 1000); gl.uniform1f(U.DARK, o.dark ? 1 : 0); gl.uniform1f(U.TINT, 0.55 + 1.1 * o.frost);
  gl.uniform1f(U.REFR, refr * kk); gl.uniform1f(U.K, u * kk); gl.uniform1f(U.SHEEN, o.sheen ?? 1);
  const I = o.ink;
  gl.uniform1f(U.INK, I ? I.a : 0);
  if (I) {
    const c3 = (loc, c) => gl.uniform3f(loc, c[0] / 255, c[1] / 255, c[2] / 255);
    c3(U.C0, I.c[0]); c3(U.C1, I.c[1]); c3(U.C2, I.c[2]); c3(U.O0, I.o[0]); c3(U.O1, I.o[1]); c3(U.O2, I.o[2]);
    gl.uniform1f(U.SEEP, I.seep); gl.uniform1f(U.OLDA, I.olda); gl.uniform1f(U.SPREAD, I.spread);
    gl.uniform2f(U.SRC, (I.src[0] - (o.x - pad)) * kk, (I.src[1] - (o.y - pad)) * kk);
    const rp = new Float32Array(6); (I.rip || []).slice(0, 3).forEach((r, i) => { rp[i * 2] = r[0]; rp[i * 2 + 1] = r[1]; });
    gl.uniform2fv(U.RIP, rp);
  } else gl.uniform2fv(U.RIP, new Float32Array(6));
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const A = ctx.globalAlpha;
  ctx.save(); ctx.globalAlpha = A * (o.alpha ?? 1); ctx.filter = 'none';
  try { ctx.drawImage(cv, o.x - pad, o.y - pad, o.w + 2 * pad, o.h + 2 * pad); } catch { ctx.restore(); return false; }
  ctx.restore();
  return true;
}
