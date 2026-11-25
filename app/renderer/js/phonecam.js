// Prism Cam — phones as cameras. The phone opens a page that Prism Cam serves over HTTPS on the home Wi-Fi (phone.rs)
// and sends its camera here over WebRTC; this module is the receiving side, the QR dialog and the phone's panel.
// A phone layer is a normal camera layer with `phone: <phone id>`, so everything a webcam can do (hands, face,
// AI background, effects, animation) works on it. Settings per phone: project.phones[pid] = { name, want, c }
// (kept up to date from what the phone reports — the phone is the source of truth for what its camera really does).
import { api, native, bus, T, lang, toast, htmlBox, esc, recall, remember } from './core.js';
import { icon } from './icons.js';

const rnd = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'[b % 56]).join(''); };
const dlog = (m) => { if (native) api.invoke('app:log', 'phone: ' + m).catch(() => {}); };
const KEY = 'prismcam.phonekey';
function key() { let k = recall(KEY, ''); if (!/^[A-Za-z0-9]{20,64}$/.test(k)) { k = rnd(24); remember(KEY, k); } return k; }

export const phones = new Map(); // pid → { pid, video, stream, pc, dc, st: wait|hello|live|lost|off, info, rx, away, name }
let H = null;                    // studio hooks: project(), used() → Set of pids in any scene, addLayer(pid, name), saveSoon(), name(pid)
let srv = null, starting = null, dialogOpen = false, stopT = 0;

function entry(pid) {
  let e = phones.get(pid);
  if (!e) {
    const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.autoplay = true;
    e = { pid, video, stream: null, pc: null, dc: null, st: 'wait', info: null, rx: null, away: false, name: '', gen: 0, unused: 0 };
    phones.set(pid, e);
  }
  return e;
}
export const phoneVideo = (pid) => entry(pid).video;
export const phoneOf = (pid) => phones.get(pid) || null;
const prefs = (pid) => { const p = H.project(); p.phones ||= {}; return (p.phones[pid] ||= { name: '', want: null, c: null }); };
export const phoneName = (pid) => { const e = phones.get(pid); return (H && H.project().phones && H.project().phones[pid] && H.project().phones[pid].name) || (e && e.name) || T`มือถือ`; };

/* ------------------------------------------------------------------ status */
// what a phone layer shows while there is no picture (also used in the panel)
export function phoneStatus(pid) {
  const e = phones.get(pid);
  if (!native) return T`มือถือเป็นกล้องใช้ได้ในโปรแกรม Prism Cam (ไม่ใช่หน้าตัวอย่างในเบราว์เซอร์)`;
  if (!e || e.st === 'wait') return T`รอมือถือ — เปิดหน้า Prism Cam บนมือถือ (ดับเบิลคลิกเพื่อดู QR)`;
  if (e.st === 'off') return T`มือถือหลุด — เปิดหน้า Prism Cam บนมือถืออีกครั้ง (ดับเบิลคลิกเพื่อดู QR)`;
  if (e.st === 'lost') return T`สัญญาณมือถือหลุด — กำลังต่อใหม่…`;
  if (e.st === 'hello') return T`กำลังเชื่อมต่อกับมือถือ…`;
  if (e.away) return T`มือถือออกจากหน้า Prism Cam — กลับไปเปิดหน้าเว็บบนมือถือเพื่อส่งภาพต่อ`;
  if (e.info && e.info.paused) return T`มือถือหยุดส่งภาพชั่วคราว`;
  if (e.info && !e.info.cam) return T`กล้องมือถือยังไม่เปิด — ดูที่หน้าจอมือถือ`;
  return T`กำลังรอภาพจากมือถือ…`;
}
// the picture is shown only while it is really live (a frozen last frame would look like a working camera)
function refreshVideo(e) {
  const show = e.st === 'live' && e.stream && !e.away && !(e.info && e.info.paused);
  const want = show ? e.stream : null;
  if (e.video.srcObject !== want) { e.video.srcObject = want; if (want) e.video.play().catch(() => {}); }
}
const changed = (e) => bus.emit('phone:change', e);

/* ------------------------------------------------------------------ server */
export async function ensureServer() {
  if (!native) return { ok: false, reason: 'browser' };
  if (srv) return srv;
  if (!starting) starting = api.invoke('phone:start', { token: key() }).then((r) => { starting = null; srv = r && r.ok ? r : null; if (!srv) dlog('server failed ' + JSON.stringify(r)); return r || { ok: false }; }, (err) => { starting = null; return { ok: false, reason: String(err) }; });
  return starting;
}
// studio calls this after every runtime sync: run the page server while a scene uses a phone (or the dialog is open)
export function phoneNeed(used) {
  if (!native || !H) return;
  const now = Date.now();
  for (const e of phones.values()) {
    if (used.has(e.pid)) { e.unused = 0; continue; }
    if (!e.unused) e.unused = now;
  }
  clearTimeout(stopT);
  if (used.size || dialogOpen) { if (!srv && !starting) ensureServer().then((r) => { if (!r.ok && used.size) toast(failText(r), { kind: 'err' }); }); }
  if (!dialogOpen) stopT = setTimeout(() => sweepUnused(), 16000);
}
// a phone whose layers were deleted (and not brought back with Ctrl+Z within 15 s) is let go
function sweepUnused() {
  if (!H || dialogOpen) return;
  const used = H.used();
  for (const e of [...phones.values()]) if (!used.has(e.pid) && e.unused && Date.now() - e.unused > 15000) { tell(e.pid, { t: 'bye', why: 'removed' }); closePc(e); phones.delete(e.pid); }
  if (!used.size && srv) { api.invoke('phone:stop').catch(() => {}); srv = null; dlog('server stopped (no phone layers)'); }
}
function failText(r) {
  return ({ port: T`เปิดการเชื่อมต่อมือถือไม่ได้ — พอร์ต 8543–8552 ถูกโปรแกรมอื่นใช้อยู่ทั้งหมด`, cert: T`เปิดการเชื่อมต่อมือถือไม่ได้ — สร้างใบรับรองความปลอดภัยไม่สำเร็จ`, browser: T`มือถือเป็นกล้องใช้ได้ในโปรแกรม Prism Cam (ไม่ใช่หน้าตัวอย่างในเบราว์เซอร์)` })[r && r.reason] || T`เปิดการเชื่อมต่อมือถือไม่ได้`;
}

/* --------------------------------------------------------------- messages */
function tell(pid, m) { // to the phone: the data channel when open (instant), else its long poll
  const e = phones.get(pid);
  if (e && e.dc && e.dc.readyState === 'open' && m.t !== 'answer' && m.t !== 'cfg') { try { e.dc.send(JSON.stringify(m)); return; } catch { /* fall back */ } }
  if (native) api.invoke('phone:send', { pid, m }).catch(() => {});
}
export function phoneSet(pid, k, v) { tell(pid, { t: 'set', k, v }); }
function onMsg(pid, m) {
  if (!H || !m || typeof m !== 'object' || !/^[a-z0-9]{6,24}$/.test(pid)) return;
  const used = H.used(), known = used.has(pid);
  if (m.t === 'hello') {
    if (!known && !dialogOpen && !m.join) { api.invoke('phone:send', { pid, m: { t: 'bye', why: 'removed' } }).catch(() => {}); return; } // deleted earlier, reconnecting by itself
    const e = entry(pid);
    // the page only lost its link to the page server (the picture may still flow): keep showing it
    const live = !!(e.pc && e.pc.connectionState === 'connected');
    e.name = String(m.name || '').slice(0, 40); if (!live) e.st = 'hello'; e.away = false; e.unused = 0;
    const P = prefs(pid); if (!P.name) { P.name = e.name || T`มือถือ`; H.saveSoon(); }
    if (!known) { H.addLayer(pid, P.name); toast(T`เชื่อมมือถือ “${P.name}” แล้ว — เพิ่มเป็นเลเยอร์กล้องให้แล้ว`); }
    dlog(`${pid} hello name=${e.name} join=${!!m.join} known=${known}`);
    api.invoke('phone:send', { pid, m: { t: 'cfg', lang, host: (srv && srv.host) || '', want: P.want, c: P.c, name: P.name, live } }).catch(() => {});
    changed(e);
    return;
  }
  const e = phones.get(pid); if (!e) return;
  if (m.t === 'offer') answer(e, m);
  else if (m.t === 'state') {
    const first = !e.info;
    e.info = m; refreshVideo(e);
    const P = prefs(pid), w = JSON.stringify(m.want || null), c = JSON.stringify(m.c || null);
    if (JSON.stringify(P.want) !== w || JSON.stringify(P.c) !== c) { P.want = m.want || null; P.c = m.c || null; H.saveSoon(); }
    if (first) dlog(`${pid} camera ${m.w}x${m.h}@${m.fps} facing=${m.facing} devs=${(m.devs || []).length} caps=${Object.keys(m.caps || {}).join('+')}`);
    if (m.bat && m.bat.level <= 15 && !m.bat.charging && !e.batWarned) { e.batWarned = true; toast(T`แบตมือถือ “${phoneName(pid)}” เหลือ ${m.bat.level}% — เสียบชาร์จไว้`, { kind: 'warn' }); }
    bus.emit('phone:state', e);
  } else if (m.t === 'away') { e.away = !!m.hidden; refreshVideo(e); changed(e); dlog(`${pid} away=${e.away}`); }
  else if (m.t === 'err') { dlog(`${pid} error ${m.what} ${m.name}`); if (m.what === 'camera') toast(T`มือถือ “${phoneName(pid)}” เปิดกล้องไม่ได้ — ดูวิธีแก้ที่หน้าจอมือถือ`, { kind: 'err' }); }
  else if (m.t === 'bye' || m.t === 'gone') {
    closePc(e); e.st = 'off'; refreshVideo(e); changed(e); dlog(`${pid} ${m.t}`);
    if (known) toast(T`มือถือ “${phoneName(pid)}” หลุดการเชื่อมต่อ`, { kind: 'warn' });
  }
}
function closePc(e) {
  clearTimeout(e.lostT);
  if (e.pc) { try { e.pc.close(); } catch { /* */ } }
  e.pc = null; e.dc = null; e.stream = null; e.rx = null;
}
// WebRTC starts every call at ~300 kbit/s and climbs for ~20 s (the picture starts blurry). On a home network that is
// far too careful: the answer tells the phone to start near the quality it was set to and never fall below a floor.
function boost(sdp, want) {
  const h = (want && want.h) || 1080, fps = (want && want.fps) || 30, q = { save: 0.45, auto: 1, high: 1.8 }[(want && want.q) || 'auto'] || 1;
  const max = Math.round(({ 720: 3500, 1080: 7000, 1440: 12000, 2160: 20000 }[h] || 6000) * q * (fps > 30 ? 1.4 : 1));
  const start = Math.min(Math.round(max * 0.6), 6000), min = Math.min(800, Math.round(max * 0.25));
  const add = `x-google-start-bitrate=${start};x-google-min-bitrate=${min}`; // no max here: the phone sets it per quality and may raise it later
  const lines = sdp.split(/\r?\n/).filter(Boolean), out = [];
  let video = false; const pts = new Set();
  for (const l of lines) { if (l.startsWith('m=')) video = l.startsWith('m=video'); const m = video && /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i.exec(l); if (m) pts.add(m[1]); }
  video = false;
  for (const l of lines) {
    if (l.startsWith('m=')) video = l.startsWith('m=video');
    const f = video && /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (f && pts.has(f[1]) && !l.includes('x-google-')) { out.push(`${l};${add}`); continue; }
    out.push(l);
    const r = video && /^a=rtpmap:(\d+) /.exec(l);
    if (r && pts.has(r[1]) && !lines.some((x) => x.startsWith(`a=fmtp:${r[1]} `))) out.push(`a=fmtp:${r[1]} ${add}`);
  }
  return out.join('\r\n') + '\r\n';
}
const gathered = (pc, ms) => new Promise((res) => {
  if (pc.iceGatheringState === 'complete') { res(); return; }
  const to = setTimeout(res, ms);
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(to); res(); } });
});
async function answer(e, m) {
  closePc(e);
  let pc;
  try { pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' }); } catch (err) { dlog('no WebRTC ' + err); return; }
  e.pc = pc; e.gen = m.gen; e.st = 'hello'; changed(e);
  pc.ontrack = (ev) => { if (e.pc !== pc) return; e.stream = (ev.streams && ev.streams[0]) || new MediaStream([ev.track]); refreshVideo(e); };
  pc.ondatachannel = (ev) => {
    if (e.pc !== pc) return;
    const dc = ev.channel; e.dc = dc;
    dc.onmessage = (x) => { let d = null; try { d = JSON.parse(x.data); } catch { return; } if (e.pc === pc) onMsg(e.pid, d); };
  };
  pc.onconnectionstatechange = () => {
    if (e.pc !== pc) return;
    const s = pc.connectionState;
    clearTimeout(e.lostT);
    if (s === 'connected') { e.st = 'live'; refreshVideo(e); changed(e); dlog(`${e.pid} connected`); }
    else if (s === 'failed') { e.st = 'lost'; refreshVideo(e); changed(e); dlog(`${e.pid} failed`); }
    else if (s === 'disconnected') e.lostT = setTimeout(() => { if (e.pc === pc && pc.connectionState !== 'connected') { e.st = 'lost'; refreshVideo(e); changed(e); dlog(`${e.pid} disconnected`); } }, 2500);
  };
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: String(m.sdp || '') });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc, 2500);
    if (e.pc !== pc) return;
    let sdp = pc.localDescription.sdp; try { sdp = boost(sdp, prefs(e.pid).want); } catch { /* send it as it is */ }
    await api.invoke('phone:send', { pid: e.pid, m: { t: 'answer', sdp, gen: m.gen } });
  } catch (err) { dlog(`${e.pid} answer failed ${err}`); }
}
// receiving numbers, once a second while connected
async function statsTick() {
  for (const e of phones.values()) {
    if (!e.pc || e.st !== 'live') continue;
    try {
      const r = await e.pc.getStats(); let x = null, rtt = 0;
      r.forEach((s) => { if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) x = s; if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && s.currentRoundTripTime) rtt = s.currentRoundTripTime; });
      if (!x) continue;
      const p = e.rxRaw, dt = p ? (x.timestamp - p.timestamp) / 1000 : 0;
      e.rx = { w: x.frameWidth || 0, h: x.frameHeight || 0, fps: Math.round(x.framesPerSecond || 0), kbps: p && dt > 0 ? Math.round(((x.bytesReceived - p.bytesReceived) * 8) / dt / 1000) : 0, rtt: Math.round(rtt * 1000), lost: p ? Math.max(0, (x.packetsLost || 0) - (p.packetsLost || 0)) : 0, codec: '' };
      if (x.codecId && r.get(x.codecId)) e.rx.codec = String(r.get(x.codecId).mimeType || '').replace(/^video\//, '');
      e.rxRaw = { timestamp: x.timestamp, bytesReceived: x.bytesReceived, packetsLost: x.packetsLost || 0 };
      bus.emit('phone:stats', e);
    } catch { /* closed meanwhile */ }
  }
}
export function initPhones(hooks) {
  H = hooks;
  api.on('phone:msg', (p) => { try { onMsg(String((p && p.pid) || ''), p && p.m); } catch (err) { console.error('phone', err); } });
  setInterval(statsTick, 1000);
}
// the link a phone opens (test hook phoneurl, and the dialog)
export async function phoneLink() {
  const r = await ensureServer(); if (!r.ok) return { ok: false, reason: r.reason };
  const ip = ((r.ips || [])[0] || {}).ip || '';
  return { ok: true, url: `https://${ip}:${r.port}/?k=${key()}`, ips: r.ips };
}
export function closePhones() { for (const e of phones.values()) closePc(e); }

/* ---------------------------------------------------------------- dialog */
const FW_URL_OK = /^\d+\.\d+\.\d+\.\d+$/;
export async function openPhoneDialog() {
  if (!native) { toast(T`มือถือเป็นกล้องใช้ได้ในโปรแกรม Prism Cam (ไม่ใช่หน้าตัวอย่างในเบราว์เซอร์)`, { kind: 'err' }); return; }
  if (dialogOpen) return;
  dialogOpen = true; clearTimeout(stopT);
  const r = await ensureServer();
  if (!r.ok) { dialogOpen = false; toast(failText(r), { kind: 'err' }); return; }
  const ips = (r.ips || []).filter((x) => FW_URL_OK.test(x.ip));
  let off = () => {};
  await htmlBox(`
    <div class="phone-dlg">
      <h3>${icon('phone')}<span>${T`ใช้มือถือเป็นกล้อง`}</span></h3>
      <div class="pd-fwbar hidden" id="pd-fwbar"><span></span><button class="pill-btn primary small" id="pd-fwgo">${icon('shield')}<span>${T`อนุญาตเลย`}</span></button></div>
      <div class="pd-grid">
        <div class="pd-qr"><div class="pd-code" id="pd-code"></div><code id="pd-url"></code>
          <div class="pd-acts"><button class="chip" id="pd-copy">${icon('copy')}<span>${T`คัดลอกลิงก์`}</span></button></div>
          ${ips.length > 1 ? `<label class="field pd-ip"><select id="pd-ip">${ips.map((x) => `<option value="${esc(x.ip)}">${esc(x.ip)}${x.name ? ' · ' + esc(x.name) : ''}</option>`).join('')}</select></label>` : ''}
        </div>
        <ol class="pd-steps">
          <li>${T`ต่อมือถือกับ <b>Wi-Fi วงเดียวกับคอม</b>`}</li>
          <li>${T`เปิดแอปกล้องของมือถือ แล้วสแกน QR นี้`}</li>
          <li>${T`ถ้าขึ้นเตือน “การเชื่อมต่อไม่เป็นส่วนตัว” — <b>Android:</b> กด “ขั้นสูง” → “ไปยัง…” · <b>iPhone:</b> กด “แสดงรายละเอียด” → “เยี่ยมชมเว็บไซต์นี้”`}<small>${T`เตือนเพราะใบรับรองสร้างขึ้นในคอมเครื่องนี้เอง ภาพส่งตรงในบ้าน ไม่ออกอินเทอร์เน็ต — ต้องกดแค่ครั้งแรก`}</small></li>
          <li>${T`กด “เริ่มส่งภาพ” แล้วอนุญาตให้ใช้กล้อง — ภาพจะขึ้นเป็นเลเยอร์ใหม่ทันที`}</li>
        </ol>
      </div>
      <div class="pd-list" id="pd-list"></div>
      <details class="pd-help"><summary>${T`ต่อไม่ติด?`}</summary>
        <ul>
          <li>${T`มือถือต้องอยู่ Wi-Fi เดียวกับคอม (ไม่ใช่ Wi-Fi สำหรับแขก และไม่ใช่เน็ตมือถือ)`}</li>
          <li>${T`ถ้ามีหลายเครือข่าย ลองเลือกที่อยู่อื่นในช่องใต้ QR`}</li>
          <li>${T`ถ้าตอนแรก Windows ถามเรื่องไฟร์วอลล์แล้วกดยกเลิกไป มือถือจะเข้าไม่ได้ — กดปุ่มนี้เพื่ออนุญาต (Windows จะถามสิทธิ์ผู้ดูแลหนึ่งครั้ง)`}
            <button class="chip" id="pd-fw">${icon('shield')}<span>${T`อนุญาตใน Windows Firewall`}</span></button></li>
          <li>${T`ลิงก์เดิมหลุดไปให้คนอื่น? เปลี่ยนรหัส แล้วมือถือทุกเครื่องต้องสแกนใหม่`} <button class="chip" id="pd-newkey">${icon('refresh')}<span>${T`เปลี่ยนรหัสเชื่อมต่อ`}</span></button></li>
        </ul>
      </details>
      <div class="modal-btns"><button class="pill-btn primary" data-x>${T`เสร็จแล้ว`}</button></div>
    </div>`, (m, close) => {
    let ip = ips.length ? (ips.find((x) => x.ip === recall('prismcam.phoneip', '')) || ips[0]).ip : '';
    const url = () => `https://${ip}:${srv ? srv.port : r.port}/?k=${key()}`;
    const draw = async () => {
      const u = url();
      m.querySelector('#pd-url').textContent = ip ? u : T`คอมเครื่องนี้ไม่ได้ต่อเครือข่าย — ต่อ Wi-Fi หรือสาย LAN ก่อน`;
      const q = ip ? await api.invoke('phone:qr', u).catch(() => null) : null;
      const box = m.querySelector('#pd-code'); if (!box) return;
      box.innerHTML = q && q.ok ? q.svg : `<span class="muted">${T`ไม่มีที่อยู่ในเครือข่าย`}</span>`;
    };
    draw();
    const sel = m.querySelector('#pd-ip');
    if (sel) { sel.value = ip; sel.onchange = () => { ip = sel.value; remember('prismcam.phoneip', ip); draw(); }; }
    m.querySelector('#pd-copy').onclick = () => { if (!ip) return; navigator.clipboard.writeText(url()).then(() => toast(T`คัดลอกลิงก์แล้ว — ส่งไปเปิดบนมือถือได้`), () => toast(T`คัดลอกไม่สำเร็จ`, { kind: 'err' })); };
    // Windows Firewall: a rule that blocks Prism Cam (made when its first question was dismissed) keeps every phone out
    const bar = m.querySelector('#pd-fwbar');
    const fwCheck = async () => {
      const f = await api.invoke('phone:fw').catch(() => null);
      if (!bar.isConnected) return;
      bar.classList.toggle('hidden', !(f && f.ok && f.need));
      bar.classList.toggle('bad', !!(f && f.blocked));
      if (f && f.need) bar.querySelector('span').textContent = f.blocked ? T`Windows Firewall กำลังบล็อก Prism Cam — มือถือจะเข้าไม่ได้จนกว่าจะอนุญาต (กดยืนยันสิทธิ์ผู้ดูแลหนึ่งครั้ง)` : T`ยังไม่ได้อนุญาต Prism Cam ใน Windows Firewall — ถ้า Windows ถาม ให้กดอนุญาต หรือกดปุ่มนี้`;
    };
    const fwFix = async (b) => {
      b.disabled = true;
      const x = await api.invoke('phone:fwFix').catch(() => ({ ok: false }));
      b.disabled = false;
      toast(x && x.ok ? T`อนุญาต Prism Cam ใน Windows Firewall แล้ว — ลองสแกนอีกครั้ง` : x && x.reason === 'denied' ? T`ยกเลิกแล้ว — ไม่ได้เปลี่ยนไฟร์วอลล์` : T`ตั้งค่าไฟร์วอลล์ไม่สำเร็จ`, { kind: x && x.ok ? '' : 'err' });
      fwCheck();
    };
    fwCheck();
    m.querySelector('#pd-fwgo').onclick = (ev) => fwFix(ev.currentTarget);
    m.querySelector('#pd-fw').onclick = (ev) => fwFix(ev.currentTarget);
    m.querySelector('#pd-newkey').onclick = async () => {
      if (!(await confirmBoxInline(m))) return;
      for (const e of phones.values()) tell(e.pid, { t: 'bye', why: 'stop' });
      remember(KEY, rnd(24));
      const x = await api.invoke('phone:start', { token: key() }).catch(() => null);
      if (x && x.ok) srv = x;
      draw(); toast(T`เปลี่ยนรหัสแล้ว — สแกน QR ใหม่บนมือถือทุกเครื่อง`);
    };
    const list = () => {
      const el = m.querySelector('#pd-list'); if (!el) { off(); return; }
      const used = H.used(), rows = [...phones.values()].filter((e) => used.has(e.pid));
      el.innerHTML = rows.length ? `<h4>${T`มือถือในงานนี้`}</h4>` + rows.map((e) => `<div class="pd-row"><i class="pd-dot ${e.st === 'live' ? 'ok' : e.st === 'hello' || e.st === 'lost' ? 'wait' : ''}"></i><b>${esc(phoneName(e.pid))}</b><small>${esc(e.st === 'live' && e.rx && e.rx.w ? `${e.rx.w}×${e.rx.h} · ${e.rx.fps} fps` : phoneStatus(e.pid))}</small></div>`).join('') : `<p class="muted">${T`ยังไม่มีมือถือเชื่อมต่อ — สแกน QR ด้านบน`}</p>`;
    };
    list();
    const fn = () => list();
    bus.on('phone:change', fn); bus.on('phone:stats', fn);
    off = () => { bus.off('phone:change', fn); bus.off('phone:stats', fn); };
    m.querySelector('[data-x]').onclick = () => close(null);
  });
  off();
  dialogOpen = false;
  if (H) phoneNeed(H.used());
}
// a second modal would replace this one: ask inside the dialog instead
function confirmBoxInline(m) {
  return new Promise((res) => {
    const host = m.querySelector('.pd-help'); if (!host) { res(false); return; }
    const d = document.createElement('div'); d.className = 'pd-confirm';
    d.innerHTML = `<span>${T`มือถือทุกเครื่องที่ต่ออยู่จะหลุด และต้องสแกน QR ใหม่ — เปลี่ยนรหัสไหม?`}</span><button class="chip" data-n>${T`ยกเลิก`}</button><button class="chip on" data-y>${T`เปลี่ยนรหัส`}</button>`;
    host.appendChild(d);
    d.querySelector('[data-n]').onclick = () => { d.remove(); res(false); };
    d.querySelector('[data-y]').onclick = () => { d.remove(); res(true); };
  });
}

/* ------------------------------------------------------------------ panel */
// the phone section of a phone layer's property panel. Built from what the phone says it can do; numbers refresh
// live, the controls rebuild only when that list changes (never while a slider is being dragged).
const MODE = () => ({ continuous: T`อัตโนมัติ`, 'single-shot': T`ครั้งเดียว`, manual: T`ปรับเอง`, none: T`ปิด` });
const fmtExp = (v) => { const s = v / 10000; return s >= 0.5 ? s.toFixed(1) + ' s' : '1/' + Math.round(1 / s) + ' s'; };
export function phonePanel(sec, L, onQr) {
  const pid = L.phone, root = document.createElement('div'); root.className = 'phone-panel'; sec.appendChild(root);
  let sig = '', drag = false, lastSend = 0, pendT = 0;
  const e0 = () => phones.get(pid);
  const send = (k, v, now) => { // sliders: at most ~20 messages a second, the last value always goes out
    clearTimeout(pendT);
    const t = performance.now();
    if (now || t - lastSend > 50) { lastSend = t; phoneSet(pid, k, v); }
    else pendT = setTimeout(() => { lastSend = performance.now(); phoneSet(pid, k, v); }, 55);
  };
  const statusLine = () => {
    const e = e0(), s = root.querySelector('.pp-st'); if (!s) return;
    const live = e && e.st === 'live' && !e.away && !(e.info && e.info.paused);
    const rx = e && e.rx, inf = e && e.info;
    let txt = live && rx && rx.w ? `${rx.w}×${rx.h} · ${rx.fps} fps · ${(rx.kbps / 1000).toFixed(1)} Mbps${rx.rtt ? ` · ${rx.rtt} ms` : ''}` : phoneStatus(pid);
    if (live && inf && inf.enc && inf.enc.lim && inf.enc.lim !== 'none') txt += ' · ' + (inf.enc.lim === 'cpu' ? T`มือถือทำงานหนัก/ร้อน ภาพจึงลดลง` : inf.enc.lim === 'bandwidth' ? T`Wi-Fi ไม่พอ ภาพจึงลดลง` : T`ภาพถูกลดลง`);
    if (inf && inf.bat) txt += ` · ${T`แบต`} ${inf.bat.level}%${inf.bat.charging ? '⚡' : ''}`;
    s.querySelector('span').textContent = txt;
    s.querySelector('i').className = 'pd-dot ' + (live ? 'ok' : e && (e.st === 'hello' || e.st === 'lost') ? 'wait' : '');
  };
  const build = () => {
    const e = e0(), inf = (e && e.info) || {}, cp = inf.caps || {}, set = inf.set || {}, w = inf.want || (prefs(pid).want) || {};
    const live = !!(e && e.st === 'live');
    const val = (k, d) => (set[k] !== undefined ? set[k] : inf.c && inf.c[k] !== undefined ? inf.c[k] : d);
    root.innerHTML = '';
    const el = (tag, cls, html) => { const x = document.createElement(tag); if (cls) x.className = cls; if (html !== undefined) x.innerHTML = html; root.appendChild(x); return x; };
    el('div', 'pp-st', '<i class="pd-dot"></i><span></span>');
    const chips = (items) => {
      const d = el('div', 'chips');
      for (const [label, run, on, ico, dis, tip] of items) { const b = document.createElement('button'); b.className = 'chip' + (on ? ' on' : ''); b.innerHTML = (ico ? icon(ico) : '') + `<span>${esc(label)}</span>`; if (tip) b.title = tip; b.disabled = !!dis; b.onclick = run; d.appendChild(b); }
      return d;
    };
    const head = (t) => el('div', 'pp-h', esc(t));
    const slider = (label, k, c, v, fmt) => {
      const d = el('div', 'sl', `<span>${esc(label)}</span><input type="range" min="${c.min}" max="${c.max}" step="${c.step || (c.max - c.min) / 100}"><output></output>`);
      const inp = d.querySelector('input'), o = d.querySelector('output');
      const show = (x) => { o.textContent = fmt(x); inp.style.setProperty('--p', ((x - c.min) / (c.max - c.min || 1)) * 100 + '%'); };
      inp.value = v; show(+v); inp.disabled = !live;
      inp.oninput = () => { show(+inp.value); send(k, +inp.value); };
      inp.onchange = () => send(k, +inp.value, true);
      inp.addEventListener('pointerdown', () => { drag = true; addEventListener('pointerup', () => { drag = false; setTimeout(refresh, 250); }, { once: true, capture: true }); });
      return d;
    };
    if (!live) {
      el('div', 'panel-note', esc(phoneStatus(pid)));
      chips([[T`แสดง QR สำหรับเชื่อมมือถือ`, () => onQr(), false, 'phone']]);
      return;
    }
    const fr = inf.facing === 'user';
    chips([
      [fr ? T`ใช้กล้องหลัง` : T`ใช้กล้องหน้า`, () => phoneSet(pid, 'flip', 1), false, 'flip'],
      'torch' in cp && [T`ไฟฉาย`, () => phoneSet(pid, 'torch', !set.torch), !!set.torch, 'bolt'],
      [inf.paused ? T`ส่งภาพต่อ` : T`หยุดส่งชั่วคราว`, () => phoneSet(pid, 'paused', !inf.paused), !!inf.paused, inf.paused ? 'play' : 'pause'],
      [inf.dim ? T`เปิดจอมือถือ` : T`ปิดจอมือถือ (ประหยัดแบต)`, () => phoneSet(pid, 'dim', !inf.dim), !!inf.dim, 'moon'],
    ].filter(Boolean));
    if ((inf.devs || []).length > 1) {
      head(T`กล้อง / เลนส์`);
      chips(inf.devs.map((d) => [d.label, () => phoneSet(pid, 'dev', d.id), d.id === inf.dev, d.facing === 'user' ? 'face' : 'camera']));
    }
    if (cp.zoom) {
      const z = cp.zoom, zv = val('zoom', z.min);
      head(T`ซูม (เลนส์มือถือ)`);
      slider(T`ซูม`, 'zoom', z, zv, (x) => (+x).toFixed(1) + '×');
      chips([[z.min < 0.99 ? `${(+z.min).toFixed(1)}×` : '', z.min], ['1×', 1], ['2×', 2], ['3×', 3], ['5×', 5]].filter(([l, v]) => l && v >= z.min - 1e-6 && v <= z.max + 1e-6).map(([l, v]) => [l, () => phoneSet(pid, 'zoom', v), Math.abs(zv - v) < 0.05]));
    }
    const mx = inf.max || {}; // what this camera can give (0 = unknown → allowed)
    head(T`ความละเอียด`);
    chips([[720, '720p'], [1080, '1080p'], [1440, '1440p'], [2160, '4K']].map(([v, l]) => [l, () => phoneSet(pid, 'h', v), w.h === v, null, mx.long && mx.long < v * 16 / 9 * 0.95, mx.long && mx.long < v * 16 / 9 * 0.95 ? T`กล้องนี้ทำไม่ได้` : '']));
    head(T`ความลื่น`);
    chips([[30, '30 fps'], [60, '60 fps']].map(([v, l]) => [l, () => phoneSet(pid, 'fps', v), w.fps === v, null, v === 60 && mx.fps && mx.fps < 59, v === 60 && mx.fps && mx.fps < 59 ? T`กล้องนี้ทำไม่ได้` : '']));
    head(T`คุณภาพการส่ง`);
    chips([['save', T`ประหยัด (Wi-Fi ช้า)`], ['auto', T`ปกติ`], ['high', T`สูงสุด`]].map(([v, l]) => [l, () => phoneSet(pid, 'q', v), w.q === v]));
    chips([['balanced', T`สมดุล`], ['smooth', T`เน้นลื่น`], ['sharp', T`เน้นคมชัด`]].map(([v, l]) => [l, () => phoneSet(pid, 'pref', v), w.pref === v, null, false, T`เมื่อ Wi-Fi ไม่พอ: ลดความคมเพื่อให้ลื่น หรือลดความลื่นเพื่อให้คม`])).style.marginTop = '6px';
    const fine = ['focusMode', 'focusDistance', 'exposureMode', 'exposureCompensation', 'exposureTime', 'iso', 'whiteBalanceMode', 'colorTemperature', 'brightness', 'contrast', 'saturation', 'sharpness'].some((k) => k in cp);
    if (fine) {
      const det = document.createElement('details'); det.className = 'pp-fine'; det.open = recall('prismcam.phoneFine', '') === '1';
      det.innerHTML = `<summary>${esc(T`ปรับละเอียด — โฟกัส แสง สี`)}</summary>`;
      det.ontoggle = () => remember('prismcam.phoneFine', det.open ? '1' : '');
      root.appendChild(det);
      const into = (fn) => { const keep = root.appendChild.bind(root); root.appendChild = (x) => det.appendChild(x); try { fn(); } finally { root.appendChild = keep; } };
      into(() => {
        const modes = (k) => Array.isArray(cp[k]) && cp[k].length > 1 && chips(cp[k].map((m) => [MODE()[m] || m, () => phoneSet(pid, k, m), val(k) === m]));
        if (cp.focusMode || cp.focusDistance) {
          head(T`โฟกัส`); modes('focusMode');
          if (cp.focusDistance) slider(T`ระยะโฟกัส`, 'focusDistance', cp.focusDistance, val('focusDistance', cp.focusDistance.min), (x) => (+x).toFixed(2));
          chips([[T`โฟกัสกลางภาพ`, () => phoneSet(pid, 'focusAt', { x: 0.5, y: 0.5 }), false, 'focus']]);
        }
        if (cp.exposureMode || cp.exposureCompensation || cp.exposureTime || cp.iso) {
          head(T`แสง`); modes('exposureMode');
          if (cp.exposureCompensation) slider(T`ชดเชยแสง`, 'exposureCompensation', cp.exposureCompensation, val('exposureCompensation', 0), (x) => (x > 0 ? '+' : '') + (+x).toFixed(1));
          if (cp.exposureTime) slider(T`ชัตเตอร์`, 'exposureTime', cp.exposureTime, val('exposureTime', cp.exposureTime.min), fmtExp);
          if (cp.iso) slider('ISO', 'iso', cp.iso, val('iso', cp.iso.min), (x) => Math.round(x));
        }
        if (cp.whiteBalanceMode || cp.colorTemperature) {
          head(T`สมดุลแสงขาว`); modes('whiteBalanceMode');
          if (cp.colorTemperature) slider(T`อุณหภูมิสี`, 'colorTemperature', cp.colorTemperature, val('colorTemperature', cp.colorTemperature.min), (x) => Math.round(x) + 'K');
        }
        const looks = [['brightness', T`ความสว่าง`], ['contrast', T`คอนทราสต์`], ['saturation', T`ความอิ่มสี`], ['sharpness', T`ความคม`]].filter(([k]) => cp[k]);
        if (looks.length) { head(T`ปรับภาพในกล้อง`); for (const [k, l] of looks) slider(l, k, cp[k], val(k, (cp[k].min + cp[k].max) / 2), (x) => (+x).toFixed(cp[k].step < 1 ? 1 : 0)); }
        chips([[T`คืนค่าอัตโนมัติทั้งหมด`, () => phoneSet(pid, 'reset', 1), false, 'refresh']]).style.marginTop = '8px';
      });
    } else if (!cp.zoom) el('div', 'panel-note', esc(T`มือถือ/เบราว์เซอร์นี้ไม่ให้ปรับซูม โฟกัส หรือแสงจากหน้าเว็บ — ใช้ “ซูมดิจิทัล” ด้านล่างแทน`));
    chips([[T`ต่อมือถือเพิ่ม / แสดง QR`, () => onQr(), false, 'phone'], [T`ตัดการเชื่อมต่อ`, () => { tell(pid, { t: 'bye', why: 'stop' }); const e = e0(); if (e) { closePc(e); e.st = 'off'; refreshVideo(e); changed(e); } }, false, 'x']]).style.marginTop = '10px';
  };
  const signature = () => {
    const e = e0(), i = (e && e.info) || {};
    return JSON.stringify([e && e.st, e && e.away, i.paused, i.dim, i.facing, i.dev, i.want, Object.keys(i.caps || {}), (i.devs || []).map((d) => d.id), i.set && i.set.torch, i.set && i.set.focusMode, i.set && i.set.exposureMode, i.set && i.set.whiteBalanceMode, i.set && i.set.zoom, lang]);
  };
  const refresh = () => {
    if (!root.isConnected) { bus.off('phone:change', refresh); bus.off('phone:state', refresh); bus.off('phone:stats', statusLine); return; }
    const s = signature();
    if (s !== sig && !drag) { sig = s; build(); }
    statusLine();
  };
  bus.on('phone:change', refresh); bus.on('phone:state', refresh); bus.on('phone:stats', statusLine);
  refresh();
}
