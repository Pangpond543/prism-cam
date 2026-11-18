// Prism Cam — boot, Prism suite shell (title bar, language, theme, Info / update) and virtual camera control.
import { api, native, bus, T, lang, theme, setTheme, savedTheme, remember, toast, htmlBox, hideCtx, esc, floaty, $ } from './core.js';
import { icon, hydrateIcons } from './icons.js';
import { translateDom } from './i18n.js';
import { startBackground } from './bg.js';
import { startStudio, studio } from './studio.js';
import { startHandUi } from './handui.js';
import { setArmed } from './handctl.js';
import { startAnim } from './anim.js';
import { perf, nv12, ema, countSent, setLite, setGpu, detectIgpu, calm } from './perf.js';
import { startPerfUi, perfReport } from './perfui.js';
import { startSelects } from './select.js';

/* ------------------------------------------------------------ about/update */
const AUTHOR = 'Thanakorn Damrikitjaroen', MODEL = 'Claude Fable 5.2';
const PURPOSE = 'Prism Cam turns your webcam into a glass studio — arrange cameras, pictures and text freely, then send the result to Discord and any other app as a camera.';
async function showInfo() {
  const info = await api.invoke('about:info');
  const link = info.repo ? `https://github.com/${info.repo}` : '';
  htmlBox(`
    <div class="about">
      <div class="prism-logo big"><i></i><i></i><i></i></div>
      <h3>Prism Cam <small>v${esc(info.version)}</small></h3>
      <p class="about-purpose">${esc(PURPOSE)}</p>
      <dl class="kv">
        <dt>${T`เวอร์ชัน`}</dt><dd>${esc(info.version)} · Tauri ${esc(info.tauri)} · Rust</dd>
        <dt>${T`ผู้พัฒนา`}</dt><dd>${AUTHOR}</dd>
        <dt>${T`โมเดล AI ที่สร้าง`}</dt><dd>${MODEL}</dd>
        <dt>GitHub</dt><dd>${link ? `<a href="#" id="about-repo">${esc(link)}</a>` : T`<span class="muted">ยังไม่ได้ตั้งค่าลิงก์</span>`}</dd>
      </dl>
      <div class="about-update" id="about-update"><span class="muted">${link ? T`กดเพื่อตรวจว่ามีเวอร์ชันใหม่บน GitHub หรือไม่` : T`ใส่ชื่อ repository ในไฟล์ prism.config.json (เช่น "owner/prism") เพื่อเปิดใช้การอัปเดต`}</span></div>
      <div class="modal-btns"><button class="pill-btn" data-x>${T`ปิด`}</button><button class="pill-btn primary" id="about-check">${icon('refresh')}<span>${T`ตรวจหาอัปเดต`}</span></button></div>
    </div>`, (m, close) => {
    const box = m.querySelector('#about-update'), btn = m.querySelector('#about-check');
    const say = (html) => { box.innerHTML = html; };
    const why = (r) => ({
      norepo: T`ยังไม่ได้ตั้งค่าลิงก์ GitHub — ใส่ชื่อ repository ในไฟล์ prism.config.json`,
      notfound: T`ไม่พบ repository นี้บน GitHub`, noversion: T`repository นี้ยังไม่มีเลขเวอร์ชัน`,
      network: T`เชื่อมต่อ GitHub ไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองใหม่`, uptodate: T`เป็นเวอร์ชันล่าสุดอยู่แล้ว`,
      extract: T`แตกไฟล์อัปเดตไม่สำเร็จ`, layout: T`ไฟล์อัปเดตมีโครงสร้างไม่ถูกต้อง`, notprism: T`ไฟล์ที่ดาวน์โหลดมาไม่ใช่โปรแกรม Prism`,
      build: T`คอมไพล์เวอร์ชันใหม่ไม่สำเร็จ — ต้องติดตั้ง Rust (cargo) ในเครื่องนี้`,
      noasset: T`เวอร์ชันใหม่ยังไม่มีไฟล์สำหรับอัปเดตอัตโนมัติ — กดลิงก์ GitHub ด้านบนเพื่อดาวน์โหลดเอง`,
    }[r.reason] || T`เกิดข้อผิดพลาดระหว่างอัปเดต`);
    m.querySelector('[data-x]').onclick = () => close(null);
    if (link) m.querySelector('#about-repo').onclick = (e) => { e.preventDefault(); api.invoke('about:openRepo'); };
    const off = api.on('update:step', ({ step, f: frac }) => {
      const label = { download: T`กำลังดาวน์โหลด`, extract: T`กำลังแตกไฟล์`, copy: T`กำลังติดตั้ง`, build: T`กำลังคอมไพล์โปรแกรม (Rust)` }[step] || step;
      say(`<span>${label}${step === 'download' && frac ? ` ${Math.round(frac * 100)}%` : '…'}</span><div class="progress indet"><i></i></div>`);
    });
    const apply = async () => {
      btn.disabled = true;
      say(T`<span>กำลังดาวน์โหลด…</span><div class="progress indet"><i></i></div>`);
      await beforeUpdate();
      const r = await api.invoke('update:apply');
      if (!r.ok) { say(`<span class="bad">${esc(why(r))}</span>`); btn.disabled = false; return; }
      say(`<span class="good">${T`ติดตั้งเวอร์ชัน ${esc(r.version)} แล้ว — เริ่มโปรแกรมใหม่เพื่อใช้งาน`}</span>`);
      btn.innerHTML = T`<span>เริ่มโปรแกรมใหม่</span>`; btn.disabled = false;
      btn.onclick = () => { off(); api.invoke('app:relaunch'); };
    };
    btn.onclick = async () => {
      btn.disabled = true;
      say(T`<span>กำลังตรวจสอบ…</span><div class="progress indet"><i></i></div>`);
      const r = await api.invoke('update:check');
      btn.disabled = false;
      if (!r.ok) { say(`<span class="bad">${esc(why(r))}</span>`); return; }
      if (!r.hasUpdate) { say(`<span class="good">${T`เป็นเวอร์ชันล่าสุดอยู่แล้ว (v${esc(r.current)})`}</span>`); return; }
      say(`<span class="good">${T`มีเวอร์ชันใหม่ v${esc(r.latest)} (ตอนนี้ใช้ v${esc(r.current)})`}</span>`);
      btn.innerHTML = `${icon('download')}<span>${T`อัปเดตเลย`}</span>`;
      btn.onclick = apply;
    };
  });
}
// flush unsaved state and release the camera driver before files are replaced
async function beforeUpdate() { await studio.save(); studio.releaseAll(); if (vcam.on) await stopVcam(); }

/* ---------------------------------------------------------- virtual camera */
const vcam = { on: false, busy: false, last: 0, buf: null, useVF: typeof VideoFrame === 'function', fails: 0 };
function setVcam(on) {
  vcam.on = on; vcam.fails = 0;
  $('btn-vcam').classList.toggle('on', on);
  $('vcam-label').textContent = on ? T`หยุดกล้องเสมือน` : T`เริ่มกล้องเสมือน`;
  $('scene-box').classList.toggle('live', on);
  $('live-badge').classList.toggle('hidden', !on);
}
async function stopVcam() { await api.invoke('vcam:stop').catch(() => {}); setVcam(false); }
const vcamWhy = (r) => ({
  browser: T`กล้องเสมือนใช้ได้เฉพาะในโปรแกรม Prism Cam บน Windows 11`,
  oldwin: T`กล้องเสมือนต้องใช้ Windows 11 ขึ้นไป`,
  nodll: T`ไม่พบไฟล์ไดรเวอร์กล้องเสมือน (prism_vcam.dll) — ลองติดตั้งโปรแกรมใหม่`,
  denied: T`ยกเลิกการติดตั้งกล้องเสมือนแล้ว`,
}[r.reason] || T`เริ่มกล้องเสมือนไม่สำเร็จ` + (r.detail ? ` (${r.detail})` : ''));
async function toggleVcam() {
  if (vcam.on) { await stopVcam(); toast(T`หยุดกล้องเสมือนแล้ว`); return; }
  if (!native) { toast(vcamWhy({ reason: 'browser' }), { kind: 'err' }); return; }
  const o = studio.out();
  let r = await api.invoke('vcam:start', { w: o.w, h: o.h, fps: o.fps });
  if (!r.ok && r.reason === 'setup') {
    const go = await htmlBox(`<h3>${T`ติดตั้งกล้องเสมือนครั้งแรก`}</h3>
      <div class="setup-steps wide">${T`Prism Cam จะลงทะเบียนกล้องชื่อ “Prism Cam” ไว้ใน Windows เพื่อให้ Discord และโปรแกรมอื่นมองเห็น`}<br>${T`Windows จะถามสิทธิ์ผู้ดูแลระบบหนึ่งครั้ง — ทำเพียงครั้งเดียว ไม่ได้ติดตั้งไดรเวอร์ระดับระบบ`}</div>
      <div class="modal-btns"><button class="pill-btn" data-x>${T`ยกเลิก`}</button><button class="pill-btn primary" data-ok>${T`ติดตั้งเลย`}</button></div>`,
    (m, close) => { m.querySelector('[data-x]').onclick = () => close(false); m.querySelector('[data-ok]').onclick = () => close(true); });
    if (!go) return;
    const ins = await api.invoke('vcam:install');
    if (!ins.ok) { toast(vcamWhy(ins), { kind: 'err' }); return; }
    r = await api.invoke('vcam:start', { w: o.w, h: o.h, fps: o.fps });
  }
  if (!r.ok) { toast(vcamWhy(r), { kind: 'err' }); return; }
  setVcam(true); calm();
  toast(T`กล้องเสมือนทำงานแล้ว — เลือกกล้อง “Prism Cam” ใน Discord ได้เลย`);
}
async function grab(c) {
  const w = c.width, h = c.height;
  if (!vcam.buf || vcam.buf.length !== w * h * 4) vcam.buf = new Uint8Array(w * h * 4);
  if (vcam.useVF) {
    try {
      const vf = new VideoFrame(c, { timestamp: Math.round(performance.now() * 1000) });
      try { await vf.copyTo(vcam.buf, { format: 'RGBA' }); } finally { vf.close(); }
      return vcam.buf;
    } catch { vcam.useVF = false; }
  }
  return new Uint8Array(c.getContext('2d').getImageData(0, 0, w, h).data.buffer);
}
bus.on('frame', (c) => {
  if (!vcam.on || vcam.busy) return;
  const o = studio.out(), t0 = performance.now();
  if (t0 - vcam.last < 1000 / 30 - 6) return; // the virtual camera runs at 30 fps (Discord's limit): a 60 fps project sends every other frame
  vcam.busy = true; vcam.last = t0;
  // fast path: the graphics chip converts (and scales the light-mode picture back to full size); else RGBA + Rust converts
  const nv = nv12(c, o.w, o.h);
  if (nv && !nv.length) { ema('send', performance.now() - t0); vcam.busy = false; return; } // first frame still on the graphics chip
  const sent = nv ? api.raw('vcam_frame', nv, { 'x-w': String(o.w), 'x-h': String(o.h), 'x-fmt': 'nv12' })
    : grab(c).then((buf) => { perf.path = 'cpu'; return api.raw('vcam_frame', buf, { 'x-w': String(c.width), 'x-h': String(c.height) }); });
  ema('send', performance.now() - t0);
  sent.then(() => { vcam.fails = 0; countSent(); }, () => { if (++vcam.fails > 90) { setVcam(false); toast(T`กล้องเสมือนหยุดทำงาน`, { kind: 'err' }); } })
    .finally(() => { vcam.busy = false; });
});
bus.on('out', async () => { if (vcam.on) { await stopVcam(); toggleVcam(); } });

/* -------------------------------------------------------------------- boot */
async function boot() {
  translateDom(document.body);
  startSelects();
  hydrateIcons();
  setTheme(savedTheme());
  startBackground($('bg'));
  $('win-min').onclick = () => api.invoke('win:min');
  $('win-max').onclick = () => api.invoke('win:max');
  $('win-close').onclick = async () => { await setArmed(false); await studio.save(); studio.releaseAll(); if (vcam.on) await stopVcam(); if (native) api.invoke('win:close'); else window.close(); };
  $('btn-info').onclick = showInfo;
  $('btn-vcam').onclick = toggleVcam;
  const themeIcon = () => { $('btn-theme').firstElementChild.innerHTML = icon(theme.dark ? 'day' : 'moon'); };
  $('btn-theme').onclick = () => { setTheme(!theme.dark); themeIcon(); };
  themeIcon();
  // language tube: switching reloads the window; the saved project brings everything straight back
  const ls = $('lang-switch');
  ls.dataset.lang = lang;
  ls.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === lang);
    b.onclick = async () => {
      if (b.dataset.lang === lang) return;
      ls.dataset.lang = b.dataset.lang;
      remember('prism.lang', b.dataset.lang);
      await studio.save(); if (vcam.on) await stopVcam();
      setTimeout(() => { if (new URLSearchParams(location.search).has('lang')) location.search = ''; else location.reload(); }, 260);
    };
  });
  // glass specular follows the pointer
  addEventListener('pointermove', (e) => {
    const g = e.target.closest && e.target.closest('.glass'); if (!g) return;
    const r = g.getBoundingClientRect();
    g.style.setProperty('--mx', e.clientX - r.left + 'px'); g.style.setProperty('--my', e.clientY - r.top + 'px');
  });
  addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctx')) hideCtx(); }, true);
  addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea')) e.preventDefault(); });
  // free-floating panes
  floaty($('dock'), $('dock').querySelector('.dock-grip'));
  floaty($('statusbar'), $('statusbar').querySelector('.st-grip'));
  floaty($('panel'), $('panel-handle'));
  await startStudio();
  startHandUi();
  startAnim();
  startPerfUi();
  bus.on('cmd', (c) => { if (c === 'vcam') toggleVcam(); });
  api.invoke('app:ready');
  // first start on a PC with integrated graphics → light mode on (the user can turn it off in the speed panel)
  const igpu = detectIgpu();
  api.invoke('app:log', `perf: gpu="${perf.igpu}" integrated=${igpu} lite=${perf.lite} first=${perf.firstRun}`).catch(() => {});
  if (perf.firstRun && igpu) { setLite(true, true); toast(T`เครื่องนี้ใช้การ์ดจอออนบอร์ด — เปิดโหมดเครื่องเบาให้แล้ว (กดตัวเลข fps ด้านล่างเพื่อปรับ)`); }
  // self-test hook (same idea as Prism Size): PRISM_ACT=shape,text,dark,info … drives the UI on start
  const acts = String((await api.invoke('about:info')).test || '').split(',').filter(Boolean);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const act of acts) {
    if (act === 'en' || act === 'th') { if (lang !== act) { remember('prism.lang', act); location.reload(); return; } }
    else if (act === 'dark' || act === 'light') { setTheme(act === 'dark'); themeIcon(); }
    else if (act === 'info') showInfo();
    else if (act === 'vcam') await toggleVcam();
    else if (act === 'vcamtest') { // open our own virtual camera and report what comes out of it
      await wait(2500);
      try {
        const d = (await navigator.mediaDevices.enumerateDevices()).find((x) => x.kind === 'videoinput' && /prism cam/i.test(x.label));
        if (!d) { toast('vcamtest: camera not listed', { kind: 'err' }); continue; }
        const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: d.deviceId } } });
        const v = document.createElement('video'); v.muted = true; v.srcObject = s; await v.play(); await wait(1500);
        const c = document.createElement('canvas'); c.width = 64; c.height = 36; const x = c.getContext('2d'); x.drawImage(v, 0, 0, 64, 36);
        const px = x.getImageData(0, 0, 64, 36).data; let sum = 0; for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
        toast('vcamtest: ' + v.videoWidth + 'x' + v.videoHeight + ' avg ' + Math.round(sum / (64 * 36 * 3)));
        s.getTracks().forEach((t) => t.stop());
      } catch (err) { toast('vcamtest: ' + err, { kind: 'err' }); }
    }
    else if (act === 'mediatest') { // saved-video round trip: write → stream back from pmedia → the canvas must stay readable (virtual camera)
      const say = (m) => { api.invoke('app:log', 'mediatest: ' + m); toast('mediatest: ' + m); };
      const to = (pr, ms, what) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + what)), ms))]);
      say('start');
      try {
        const cv = document.createElement('canvas'); cv.width = 160; cv.height = 90; const g = cv.getContext('2d');
        const rec = new MediaRecorder(cv.captureStream(30), { mimeType: 'video/webm' }), ch = [];
        rec.ondataavailable = (e) => ch.push(e.data); let i = 0;
        const t = setInterval(() => { g.fillStyle = `hsl(${i++ * 20},80%,55%)`; g.fillRect(0, 0, 160, 90); }, 33);
        rec.start(); await wait(1200); rec.stop(); await to(new Promise((r) => { rec.onstop = r; }), 4000, 'recorder'); clearInterval(t); say('recorded');
        const bytes = new Uint8Array(await new Blob(ch).arrayBuffer()), name = 'selftest.webm';
        const w = await to(api.raw('media_put', bytes, { 'x-name': name, 'x-off': '0' }), 5000, 'put'); say('put ' + JSON.stringify(w));
        if (!w || !w.ok) { say('write failed'); continue; }
        const v = document.createElement('video'); v.muted = true; v.crossOrigin = 'anonymous'; v.src = 'http://pmedia.localhost/' + name;
        v.onerror = () => say('video error ' + (v.error && v.error.code + ' ' + v.error.message));
        await to(v.play(), 6000, 'play'); await wait(600);
        const c2 = document.createElement('canvas'); c2.width = 16; c2.height = 9; const x = c2.getContext('2d'); x.drawImage(v, 0, 0, 16, 9);
        const px = x.getImageData(0, 0, 16, 9).data;
        say(`ok ${v.videoWidth}x${v.videoHeight} bytes=${bytes.length} px=${px[0]},${px[1]},${px[2]}`);
      } catch (err) { say('FAILED ' + err); }
    }
    else if (act === 'dragtest') { // drag two layers onto an area in a throw-away scene, hold 4 s for a screenshot, then remove the scene
      const say = (m) => { api.invoke('app:log', 'dragtest: ' + m); };
      const sc = studio.scenes(), back = sc.indexOf(studio.scene());
      try {
        document.getElementById('scene-add').click(); await wait(200);
        studio.addText('Drag A'); studio.addText('Drag B'); document.querySelector('[data-add="area"]').click(); await wait(300);
        const L = studio.layers(), A = L.find((l) => l.type === 'area'), [a, b] = L.filter((l) => l.type === 'text');
        studio.selectMany([a.id, b.id]); studio.showTab('layers'); await wait(300);
        const src = document.querySelector(`#tab-layers [data-lid="${a.id}"]`), dst = document.querySelector(`#tab-layers [data-lid="${A.id}"]`);
        const s = src.getBoundingClientRect(), t = dst.getBoundingClientRect(), tx = t.left + 70, ty = t.top + t.height / 2;
        src.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: s.left + 50, clientY: s.top + 8 }));
        for (let i = 1; i <= 12; i++) { dispatchEvent(new PointerEvent('pointermove', { clientX: s.left + 50 + (tx - s.left - 50) * i / 12, clientY: s.top + 8 + (ty - s.top - 8) * i / 12 })); await wait(30); }
        say('holding hint=' + (document.querySelector('#drag-ghost .dg-hint') || {}).textContent); await wait(4000);
        dispatchEvent(new PointerEvent('pointerup', { clientX: tx, clientY: ty })); await wait(600);
        say('result kids=' + A.kids.map((k) => k.name).join('/') + ' root=' + studio.layers().map((l) => l.type).join('/'));
      } catch (err) { say('FAILED ' + err); }
      const i = sc.indexOf(studio.scene()); if (i > 0 && studio.scene().layers.some((l) => l.type === 'area')) { sc.splice(i, 1); document.querySelector('#scenes .chip:nth-child(' + (back + 1) + ')')?.click(); }
      studio.refreshAll(); studio.commit(); await studio.save(); say('cleaned scenes=' + sc.length);
    }
    else if (act === 'lite' || act === 'nolite') setLite(act === 'lite', true);
    else if (act.startsWith('click:')) { const el = document.querySelector(act.slice(6)); if (el) el.click(); api.invoke('app:log', 'click ' + act.slice(6) + ' ' + !!el); await wait(700); }
    else if (act === 'logsel') { const L = studio.selected(); api.invoke('app:log', 'sel: ' + (L ? `${L.type} w=${Math.round(L.w)} h=${Math.round(L.h)} x=${Math.round(L.x)}` : 'none')); }
    else if (act.startsWith('key:')) { const k = act.slice(4).split('+'); dispatchEvent(new KeyboardEvent('keydown', { key: k.pop(), ctrlKey: k.includes('ctrl'), shiftKey: k.includes('shift'), bubbles: true })); await wait(400); }
    else if (act.startsWith('wait:')) await wait(+act.slice(5) * 1000);
    else if (act === 'fps60' || act === 'fps30') { const sel = $('out-fps'); sel.value = act.slice(3); sel.dispatchEvent(new Event('change')); await wait(2500); }
    else if (act.startsWith('mime:')) window.__recMime = act.slice(5).replace(/\+/g, ',');
    else if (act === 'codecs') api.invoke('app:log', 'codecs: ' + ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm;codecs=h264', 'video/webm;codecs=av1', 'video/mp4;codecs=avc1', 'video/mp4'].map((m) => m + '=' + MediaRecorder.isTypeSupported(m)).join(' '));
    else if (act.startsWith('rec:')) { bus.emit('cmd', 'rec'); await wait(+act.slice(4) * 1000); bus.emit('cmd', 'rec'); await wait(1500); }
    else if (act === 'gpu' || act === 'nogpu') { if (perf.gpuOn !== (act === 'gpu')) { setGpu(act === 'gpu', true); location.reload(); return; } }
    else if (act === 'perf') { $('st-text').click(); await wait(8000); api.invoke('app:log', 'perf: ' + perfReport().replace(/\n/g, ' | ')); }
    else if (act === 'props') bus.emit('select-tab', 'props');
    else if (act.startsWith('tab:')) studio.showTab(act.slice(4));
    else if (act === 'unguard') { try { localStorage.removeItem('prismCamOpening'); } catch { /* */ } api.invoke('app:log', 'unguard: camera guard cleared'); }
    else if (act === 'clear') { studio.reset(); }
    else if (act.startsWith('chip:')) { const c = [...document.querySelectorAll('#tab-props .chip')].find((x) => x.textContent.trim() === act.slice(5)); if (c) c.click(); await wait(6000); }
    else { const b = document.querySelector('.dock-btn[data-add="' + act + '"]'); if (b) b.click(); await wait(1500); const p = [...document.querySelectorAll(".pick")]; if (p.length) (p.find((x) => /usb/i.test(x.textContent)) || p[p.length - 1]).click(); }
    await wait(350);
  }
}
boot();
