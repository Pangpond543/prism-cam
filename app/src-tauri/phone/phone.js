// Prism Cam phone page: sends this phone's camera to Prism Cam on the PC over WebRTC (same Wi-Fi, nothing leaves
// the home network). Hand-shake: fetch to the PC (/api/hello · /api/send · long poll /api/poll); once connected the
// controls also travel over a WebRTC data channel. Everything the PC can change (lens, size, zoom, focus …) can be
// changed here too, and both sides always show the same values (the phone reports its state after every change).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join(''); };
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
  const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ------------------------------------------------------------ language */
  const TX = {
    th: {
      flip: 'สลับกล้อง', torch: 'ไฟฉาย', pause: 'หยุดส่ง', resume: 'ส่งต่อ', dim: 'ปิดจอ', more: 'ตั้งค่า', settings: 'ตั้งค่ากล้อง',
      dimmed: 'แตะ 2 ครั้งเพื่อเปิดจอ — ยังส่งภาพอยู่', start: 'เริ่มส่งภาพ',
      startT: 'ส่งกล้องมือถือเครื่องนี้ไปที่ Prism Cam', startH: 'กดแล้วอนุญาตให้ใช้กล้อง — ภาพส่งไปที่คอมผ่าน Wi-Fi บ้านโดยตรง ไม่ผ่านอินเทอร์เน็ต',
      conn: 'กำลังเชื่อมต่อกับคอม…', live: 'กำลังส่งภาพไปที่ {}', liveAny: 'กำลังส่งภาพไปที่ Prism Cam', paused: 'หยุดส่งภาพชั่วคราว (ปิดกล้องอยู่)',
      re: 'สัญญาณหลุด — กำลังต่อใหม่…', nopc: 'ติดต่อคอมไม่ได้ — กำลังลองใหม่…', nopcH: 'เปิด Prism Cam ในคอมไว้ และต่อ Wi-Fi วงเดียวกับคอม',
      badKey: 'ลิงก์นี้ใช้ไม่ได้แล้ว', badKeyH: 'สแกน QR ใหม่จาก Prism Cam ในคอม (ปุ่ม “มือถือเป็นกล้อง”)',
      other: 'หน้านี้เปิดส่งภาพอยู่ในอีกแท็บ', useHere: 'ใช้แท็บนี้แทน',
      removed: 'Prism Cam ในคอมเลิกใช้มือถือเครื่องนี้แล้ว', join: 'ต่อกับ Prism Cam อีกครั้ง', stopped: 'หยุดเชื่อมต่อแล้ว',
      noSupport: 'เบราว์เซอร์นี้เปิดกล้องไม่ได้', noSupportH: 'เปิดลิงก์นี้ใน Chrome (Android) หรือ Safari (iPhone) — แอปสแกน QR บางตัวเปิดในเบราว์เซอร์ของตัวเองซึ่งใช้กล้องไม่ได้',
      denied: 'ยังไม่ได้อนุญาตให้ใช้กล้อง', deniedH: 'Android: แตะไอคอนข้างช่องที่อยู่ → สิทธิ์ → กล้อง → อนุญาต\niPhone: แตะ “aA” ข้างช่องที่อยู่ → การตั้งค่าเว็บไซต์ → กล้อง → อนุญาต\nแล้วกดลองใหม่',
      busy: 'กล้องถูกแอปอื่นใช้อยู่', busyH: 'ปิดแอปกล้องหรือวิดีโอคอลอื่นก่อน แล้วกดลองใหม่', nocam: 'ไม่พบกล้องในมือถือเครื่องนี้', camFail: 'เปิดกล้องไม่ได้', retry: 'ลองใหม่',
      lost: 'กล้องหยุดทำงาน — กำลังเปิดใหม่…',
      lens: 'กล้อง / เลนส์', front: 'กล้องหน้า', back: 'กล้องหลัง', cam: 'กล้อง', res: 'ความละเอียด', fps: 'ความลื่น', fpsN: '{} fps',
      q: 'คุณภาพการส่ง', qSave: 'ประหยัด (Wi-Fi ช้า)', qAuto: 'ปกติ', qHigh: 'สูงสุด', pref: 'เมื่อ Wi-Fi ไม่พอ', pBal: 'สมดุล', pSmooth: 'เน้นลื่น', pSharp: 'เน้นคมชัด',
      focus: 'โฟกัส', fDist: 'ระยะโฟกัส', tapFocus: 'แตะที่ภาพเพื่อโฟกัสจุดนั้น · ใช้สองนิ้วถ่าง/หุบเพื่อซูม',
      expo: 'แสง', eComp: 'ชดเชยแสง', eTime: 'ความเร็วชัตเตอร์', iso: 'ISO', wb: 'สมดุลแสงขาว', wbTemp: 'อุณหภูมิสี',
      look: 'ปรับภาพ', bright: 'ความสว่าง', contrast: 'คอนทราสต์', sat: 'ความอิ่มสี', sharp: 'ความคม',
      mAuto: 'อัตโนมัติ', mOnce: 'ครั้งเดียว', mManual: 'ปรับเอง', mNone: 'ปิด',
      reset: 'คืนค่าอัตโนมัติทั้งหมด', info: 'สถานะ', iSend: 'กำลังส่ง', iEnc: 'ตัวเข้ารหัส', iLimit: 'ภาพลดลงเพราะ', lCpu: 'มือถือทำงานหนัก/ร้อน', lBw: 'Wi-Fi ไม่พอ', lOther: 'อื่น ๆ', iBat: 'แบตเตอรี่', charging: 'กำลังชาร์จ',
      name: 'ชื่อมือถือเครื่องนี้ (แสดงใน Prism Cam)', save: 'บันทึก', disconnect: 'หยุดเชื่อมต่อ', noFine: 'มือถือ/เบราว์เซอร์นี้ไม่ให้ปรับโฟกัส แสง หรือซูมจากหน้าเว็บ — ปรับซูมแบบดิจิทัลได้ที่ Prism Cam ในคอม',
      wake: 'ตั้งมือถือไม่ให้ล็อกจอเอง ระหว่างส่งภาพ', lowBat: 'แบตเหลือน้อย — เสียบชาร์จไว้',
    },
    en: {
      flip: 'Switch', torch: 'Light', pause: 'Pause', resume: 'Resume', dim: 'Screen off', more: 'Settings', settings: 'Camera settings',
      dimmed: 'Double-tap to turn the screen on — still sending', start: 'Start sending',
      startT: 'Send this phone’s camera to Prism Cam', startH: 'Tap, then allow the camera — the picture goes straight to the PC over your home Wi-Fi, never over the internet',
      conn: 'Connecting to the PC…', live: 'Sending to {}', liveAny: 'Sending to Prism Cam', paused: 'Paused (camera off)',
      re: 'Signal lost — reconnecting…', nopc: 'Can’t reach the PC — retrying…', nopcH: 'Keep Prism Cam open on the PC and use the same Wi-Fi as the PC',
      badKey: 'This link no longer works', badKeyH: 'Scan the QR code again in Prism Cam on the PC (“Phone as camera”)',
      other: 'This page is sending from another tab', useHere: 'Use this tab instead',
      removed: 'Prism Cam on the PC stopped using this phone', join: 'Connect to Prism Cam again', stopped: 'Disconnected',
      noSupport: 'This browser can’t open the camera', noSupportH: 'Open this link in Chrome (Android) or Safari (iPhone) — some QR apps open links in their own browser, which can’t use the camera',
      denied: 'Camera permission not given', deniedH: 'Android: tap the icon next to the address → Permissions → Camera → Allow\niPhone: tap “aA” next to the address → Website Settings → Camera → Allow\nthen tap Try again',
      busy: 'Another app is using the camera', busyH: 'Close the other camera or video-call app, then tap Try again', nocam: 'No camera found on this phone', camFail: 'Can’t open the camera', retry: 'Try again',
      lost: 'The camera stopped — reopening…',
      lens: 'Camera / lens', front: 'Front camera', back: 'Back camera', cam: 'Camera', res: 'Resolution', fps: 'Smoothness', fpsN: '{} fps',
      q: 'Sending quality', qSave: 'Saver (slow Wi-Fi)', qAuto: 'Normal', qHigh: 'Best', pref: 'When Wi-Fi is short', pBal: 'Balanced', pSmooth: 'Keep smooth', pSharp: 'Keep sharp',
      focus: 'Focus', fDist: 'Focus distance', tapFocus: 'Tap the picture to focus there · pinch with two fingers to zoom',
      expo: 'Exposure', eComp: 'Exposure compensation', eTime: 'Shutter speed', iso: 'ISO', wb: 'White balance', wbTemp: 'Colour temperature',
      look: 'Picture', bright: 'Brightness', contrast: 'Contrast', sat: 'Saturation', sharp: 'Sharpness',
      mAuto: 'Auto', mOnce: 'Once', mManual: 'Manual', mNone: 'Off',
      reset: 'Reset everything to auto', info: 'Status', iSend: 'Sending', iEnc: 'Encoder', iLimit: 'Picture reduced because of', lCpu: 'phone busy / hot', lBw: 'Wi-Fi too slow', lOther: 'other', iBat: 'Battery', charging: 'charging',
      name: 'Name of this phone (shown in Prism Cam)', save: 'Save', disconnect: 'Disconnect', noFine: 'This phone / browser doesn’t let a web page change focus, exposure or zoom — use the digital zoom in Prism Cam on the PC',
      wake: 'Keep the phone from locking its screen while sending', lowBat: 'Battery low — plug in the charger',
    },
  };
  let L = /^th/i.test(navigator.language || '') ? 'th' : 'en';
  const t = (k, v) => { const s = (TX[L] && TX[L][k]) || TX.en[k] || k; return v === undefined ? s : s.replace('{}', v); };
  function applyLang(l) {
    if (l !== 'th' && l !== 'en') return;
    L = l; document.documentElement.lang = l;
    document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
    bar(); setConn(S.conn); if (!$('sheet').classList.contains('hidden')) sheet();
    if (S.msgK) msg(...S.msgK);
  }

  /* --------------------------------------------------------------- state */
  const qs = new URLSearchParams(location.search);
  const K = (qs.get('k') || '').replace(/[^A-Za-z0-9]/g, '');
  let PID = store.get('pc.pid', '');
  if (!/^[a-z0-9]{12}$/.test(PID)) { PID = rnd(12); store.set('pc.pid', PID); }
  const SID = rnd(12); // this page; a second tab of the same phone takes over and this one is told so
  const WANT0 = { facing: 'environment', dev: '', h: 1080, fps: 30, q: 'auto', pref: 'balanced' };
  const S = {
    started: false, stopped: false, join: false, helloOk: false, conn: 'idle', pcName: '', msgK: null,
    stream: null, track: null, pc: null, dc: null, sender: null, gen: 0, facing: '', devs: [],
    want: { ...WANT0, ...readJson('pc.want') }, c: readJson('pc.fine'), paused: false, dim: false, bat: null, enc: null, opening: null,
  };
  let NAME = store.get('pc.name', '');
  function readJson(k) { try { const v = JSON.parse(store.get(k, '{}')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
  const saveWant = () => store.set('pc.want', JSON.stringify(S.want));
  const saveFine = () => store.set('pc.fine', JSON.stringify(S.c));
  async function guessName() {
    if (NAME) return NAME;
    let m = '';
    try { if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) m = (await navigator.userAgentData.getHighEntropyValues(['model'])).model || ''; } catch { /* */ }
    const ua = navigator.userAgent;
    if (!m) m = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : (/Android[^;]*;\s*([^;)]+?)\s*(Build|\))/.exec(ua) || [])[1] || '';
    if (!m || m === 'K') m = /Android/.test(ua) ? 'Android' : (L === 'th' ? 'มือถือ' : 'Phone');
    return m.slice(0, 40);
  }

  /* --------------------------------------------------------------- network */
  async function post(path, body, timeout = 10000) {
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k: K, pid: PID, sid: SID, ...body }), cache: 'no-store', signal: ac.signal });
      return r.status;
    } catch { return 0; } finally { clearTimeout(to); }
  }
  // to the PC: over the data channel when it is open (fast), else through the page server
  function send(m) {
    if (S.dc && S.dc.readyState === 'open') { try { S.dc.send(JSON.stringify(m)); return; } catch { /* fall back */ } }
    post('/api/send', { m });
  }
  async function hello() {
    const r = await post('/api/hello', { name: await guessName(), ua: navigator.userAgent, join: S.join });
    if (r === 200) { S.helloOk = true; S.join = false; return 'ok'; }
    return r === 403 ? 'key' : 'net';
  }
  let looping = false;
  async function loop() {
    if (looping) return; looping = true;
    let fails = 0;
    try {
      while (S.started && !S.stopped) {
        if (!S.helloOk) {
          const h = await hello();
          if (h === 'key') { stopAll(); msg('badKey', 'badKeyH'); return; }
          if (h !== 'ok') { fails++; setConn('nopc'); await sleep(Math.min(5000, 1000 * fails)); continue; }
          fails = 0; S.cfgWait = setTimeout(() => { if (!S.pc && S.track) connect(); }, 5000); // an older PC page that never answers
        }
        let r = null;
        const ac = new AbortController(), to = setTimeout(() => ac.abort(), 30000);
        try { r = await fetch(`/api/poll?k=${K}&pid=${PID}&sid=${SID}`, { cache: 'no-store', signal: ac.signal }); } catch { r = null; } finally { clearTimeout(to); }
        if (!S.started || S.stopped) break;
        if (!r) { fails++; setConn('nopc'); await sleep(Math.min(5000, 800 * fails)); S.helloOk = false; continue; }
        if (r.status === 403) { stopAll(); msg('badKey', 'badKeyH'); return; }
        if (r.status === 409) { stopAll(); msg('other', '', 'useHere', () => begin(true)); return; }
        if (r.status === 404) { S.helloOk = false; continue; } // Prism Cam restarted or forgot this phone
        if (!r.ok) { await sleep(1500); continue; }
        fails = 0;
        let j = null; try { j = await r.json(); } catch { /* */ }
        for (const m of (j && j.m) || []) onMsg(m);
      }
    } finally { looping = false; }
  }

  function onMsg(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'cfg') {
      clearTimeout(S.cfgWait);
      if (m.lang) applyLang(m.lang);
      S.pcName = String(m.host || '').slice(0, 40);
      let reopen = false;
      if (m.want && typeof m.want === 'object') {
        const w = clean(m.want);
        reopen = ['facing', 'dev', 'h', 'fps'].some((k) => k in w && w[k] !== S.want[k]);
        Object.assign(S.want, w); saveWant();
      }
      if (m.c && typeof m.c === 'object') { S.c = { ...m.c }; saveFine(); }
      if (typeof m.name === 'string' && m.name && !store.get('pc.name', '')) NAME = m.name.slice(0, 40);
      (async () => {
        if (!S.paused && (reopen || !S.track || S.track.readyState === 'ended')) await openCam().catch(camErr);
        else if (S.track) await reapply();
        // only the page server hiccuped and both sides still see the picture flowing: keep the running connection
        // (after Prism Cam restarted it says live: false → connect again at once, don't wait for the old one to time out)
        if (m.live && S.pc && S.pc.connectionState === 'connected' && !reopen) { sendState(); return; }
        connect();
      })();
    } else if (m.t === 'answer') {
      if (S.pc && m.gen === S.gen && S.pc.signalingState === 'have-local-offer') S.pc.setRemoteDescription({ type: 'answer', sdp: String(m.sdp || '') }).catch(() => retry(1500));
    } else if (m.t === 'set') setCtl(String(m.k || ''), m.v);
    else if (m.t === 'redo') connect();
    else if (m.t === 'bye') { stopAll(); msg(m.why === 'stop' ? 'stopped' : 'removed', '', 'join', () => begin(true)); }
  }
  function clean(w) {
    const o = {};
    if (w.facing === 'user' || w.facing === 'environment') o.facing = w.facing;
    if (typeof w.dev === 'string') o.dev = w.dev.slice(0, 200);
    if ([480, 720, 1080, 1440, 2160].includes(+w.h)) o.h = +w.h;
    if (+w.fps === 30 || +w.fps === 60) o.fps = +w.fps;
    if (['save', 'auto', 'high'].includes(w.q)) o.q = w.q;
    if (['balanced', 'smooth', 'sharp'].includes(w.pref)) o.pref = w.pref;
    return o;
  }

  /* ---------------------------------------------------------------- camera */
  const FINE = ['zoom', 'torch', 'focusMode', 'focusDistance', 'exposureMode', 'exposureCompensation', 'exposureTime', 'iso', 'whiteBalanceMode', 'colorTemperature', 'brightness', 'contrast', 'saturation', 'sharpness'];
  const caps = () => { const tr = S.track; if (!tr || !tr.getCapabilities) return {}; let c = {}; try { c = tr.getCapabilities() || {}; } catch { /* */ } const o = {}; for (const k of FINE) if (c[k] !== undefined && c[k] !== false && !(Array.isArray(c[k]) && !c[k].length) && !(c[k] && c[k].max !== undefined && c[k].max <= c[k].min)) o[k] = c[k]; return o; };
  const rawCaps = () => { try { return (S.track && S.track.getCapabilities && S.track.getCapabilities()) || {}; } catch { return {}; } };
  const settings = () => { const tr = S.track; let s = {}; try { s = (tr && tr.getSettings && tr.getSettings()) || {}; } catch { /* */ } return s; };
  const base = () => ({ width: { ideal: Math.round(S.want.h * 16 / 9) }, height: { ideal: S.want.h }, frameRate: { ideal: S.want.fps } });
  const gum = (video) => Promise.race([navigator.mediaDevices.getUserMedia({ video, audio: false }), sleep(15000).then(() => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); })]);
  function stopTrack() {
    if (S.stream) S.stream.getTracks().forEach((x) => { x.onended = null; x.stop(); });
    S.stream = null; S.track = null;
  }
  // one opening at a time: taps on "switch" while a camera is still opening wait for it
  function openCam(exactFacing) {
    const p = (S.opening || Promise.resolve()).then(() => runOpen(exactFacing));
    const q = p.catch(() => {});
    S.opening = q; q.then(() => { if (S.opening === q) S.opening = null; });
    return p;
  }
  async function runOpen(exactFacing) {
      const w = S.want, v = base();
      if (w.dev) v.deviceId = { exact: w.dev }; else v.facingMode = exactFacing ? { exact: w.facing } : { ideal: w.facing };
      stopTrack(); // most phones can only run one camera at a time
      let s;
      try { s = await gum(v); }
      catch (e) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
        try { s = await gum({ ...base(), facingMode: { ideal: w.facing } }); } // a lens that is gone / a size it can't give
        catch { s = await gum({ facingMode: { ideal: w.facing } }); }
        w.dev = ''; saveWant();
      }
      if (!S.started || S.stopped || S.paused) { s.getTracks().forEach((x) => x.stop()); return; }
      S.stream = s; S.track = s.getVideoTracks()[0];
      const tr = S.track;
      tr.onended = () => { if (S.track === tr) camLost(); };
      hint();
      const pv = $('pv'); if (!S.dim) { pv.srcObject = s; pv.play().catch(() => {}); }
      const st = settings();
      await listDevs();
      const d = S.devs.find((x) => x.id === st.deviceId);
      S.facing = st.facingMode === 'user' || st.facingMode === 'environment' ? st.facingMode : d ? d.facing : w.facing;
      pv.classList.toggle('mirror', S.facing === 'user');
      if (S.sender) { await S.sender.replaceTrack(tr).catch(() => {}); setEnc(); }
      await reapply();
      bar(); sendState(); if (!$('sheet').classList.contains('hidden') && !dragging) sheet();
  }
  async function listDevs() {
    let list = [];
    try { list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { /* */ }
    const n = { user: 0, environment: 0, '': 0 };
    S.devs = list.map((d) => {
      const l = d.label || '';
      const facing = /front|user|selfie|หน้า|facing front/i.test(l) ? 'user' : /back|rear|environment|หลัง|facing back/i.test(l) ? 'environment' : '';
      n[facing]++;
      const generic = !l || /^camera\d*\s*\d+,\s*facing/i.test(l) || /^camera\s*\d+$/i.test(l);
      return { id: d.deviceId, facing, label: generic ? `${facing === 'user' ? t('front') : facing === 'environment' ? t('back') : t('cam')} ${n[facing]}` : l.slice(0, 60) };
    });
    // a single front / back lens needs no number
    for (const d of S.devs) if (/ 1$/.test(d.label) && S.devs.filter((x) => x.facing === d.facing).length === 1) d.label = d.label.slice(0, -2);
  }
  // fine controls (zoom, focus …) that this camera supports are put back after every reopen
  async function reapply() {
    const cp = caps(), set = {};
    for (const k of Object.keys(S.c)) if (k in cp) set[k] = S.c[k];
    fixModes(set, cp);
    if (!Object.keys(set).length || !S.track) return;
    try { await S.track.applyConstraints({ ...base(), advanced: [set] }); } catch { /* not supported: ignore */ }
  }
  function fixModes(set, cp) { // manual values need their mode switched to manual in the same call
    const man = (mk) => Array.isArray(cp[mk]) && cp[mk].includes('manual');
    if ('focusDistance' in set && set.focusMode !== 'manual') { if (man('focusMode')) set.focusMode = 'manual'; else delete set.focusDistance; }
    if (('exposureTime' in set || 'iso' in set) && set.exposureMode !== 'manual') { if (man('exposureMode')) set.exposureMode = 'manual'; else { delete set.exposureTime; delete set.iso; } }
    if ('colorTemperature' in set && set.whiteBalanceMode !== 'manual') { if (man('whiteBalanceMode')) set.whiteBalanceMode = 'manual'; else delete set.colorTemperature; }
    if (set.focusMode && set.focusMode !== 'manual') delete set.focusDistance;
    if (set.exposureMode && set.exposureMode !== 'manual') { delete set.exposureTime; delete set.iso; }
    if (set.whiteBalanceMode && set.whiteBalanceMode !== 'manual') delete set.colorTemperature;
  }
  const pend = {}; let applying = false;
  function fine(k, v) { pend[k] = v; if (!applying) flush(); }
  async function flush() {
    applying = true;
    try {
      while (Object.keys(pend).length && S.track) {
        const cp = caps(), now = { ...pend }; for (const k of Object.keys(pend)) delete pend[k];
        for (const k of Object.keys(now)) if (!(k in cp)) delete now[k];
        // switching a mode back to auto drops the manual value that belonged to it
        if (now.focusMode && now.focusMode !== 'manual') delete S.c.focusDistance;
        if (now.exposureMode && now.exposureMode !== 'manual') { delete S.c.exposureTime; delete S.c.iso; }
        if (now.whiteBalanceMode && now.whiteBalanceMode !== 'manual') delete S.c.colorTemperature;
        const all = { ...S.c, ...now }; fixModes(all, cp);
        try { await S.track.applyConstraints({ ...base(), advanced: [all] }); Object.assign(S.c, now); fixModes(S.c, cp); saveFine(); } catch { /* unsupported value */ }
      }
    } finally { applying = false; }
    zoomUi(); bar(); sendStateSoon();
  }
  function camLost() {
    S.track = null; setConn('re', t('lost'));
    if (S.started && !S.stopped && !S.paused && !document.hidden) setTimeout(() => openCam().catch(camErr), 600);
  }
  function camErr(e) {
    const n = e && e.name;
    send({ t: 'err', what: 'camera', name: String(n || e) });
    if (n === 'NotAllowedError' || n === 'SecurityError') msg('denied', 'deniedH', 'retry', () => begin(false));
    else if (n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError') msg('busy', 'busyH', 'retry', () => begin(false));
    else if (n === 'NotFoundError' || n === 'OverconstrainedError') msg('nocam', '', 'retry', () => begin(false));
    else msg('camFail', String((e && e.message) || n || ''), 'retry', () => begin(false));
  }
  function hint() { if (S.track) try { S.track.contentHint = S.want.pref === 'smooth' ? 'motion' : S.want.pref === 'sharp' ? 'detail' : ''; } catch { /* */ } }

  /* ---------------------------------------------------------------- WebRTC */
  const bitrate = () => {
    const b = { 480: 1500, 720: 3500, 1080: 7000, 1440: 12000, 2160: 20000 }[S.want.h] || 6000;
    return Math.round(b * ({ save: 0.45, auto: 1, high: 1.8 }[S.want.q] || 1) * (S.want.fps > 30 ? 1.4 : 1)) * 1000;
  };
  async function setEnc() {
    const sd = S.sender; if (!sd || !sd.getParameters) return;
    const p = sd.getParameters();
    if (!p.encodings || !p.encodings.length) return; // not negotiated yet: called again once connected
    p.encodings[0].maxBitrate = bitrate(); p.encodings[0].maxFramerate = S.want.fps; p.encodings[0].scaleResolutionDownBy = 1;
    const dp = { smooth: 'maintain-framerate', sharp: 'maintain-resolution' }[S.want.pref] || 'balanced';
    try { p.degradationPreference = dp; await sd.setParameters(p); }
    catch { // older browsers: without degradationPreference
      try { const p2 = sd.getParameters(); if (p2.encodings && p2.encodings.length) { Object.assign(p2.encodings[0], { maxBitrate: bitrate(), maxFramerate: S.want.fps }); await sd.setParameters(p2); } } catch { /* keep defaults */ }
    }
  }
  const gathered = (pc, ms) => new Promise((res) => {
    if (pc.iceGatheringState === 'complete') { res(); return; }
    const to = setTimeout(res, ms);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(to); res(); } });
  });
  function preferH264(tr) { // phones encode H.264 on their video chip: less heat, better picture than software VP8
    try {
      if (!tr.setCodecPreferences || !window.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities || !RTCRtpSender.getCapabilities) return;
      const can = (RTCRtpSender.getCapabilities('video') || {}).codecs || [];
      if (!can.some((c) => /h264/i.test(c.mimeType))) return;
      const cs = (RTCRtpReceiver.getCapabilities('video') || {}).codecs || [];
      const h = cs.filter((c) => /h264/i.test(c.mimeType)); if (!h.length) return;
      tr.setCodecPreferences([...h, ...cs.filter((c) => !/h264/i.test(c.mimeType))]);
    } catch { /* default order */ }
  }
  function closePc() {
    clearTimeout(S.tmo); clearTimeout(S.rt);
    if (S.pc) { try { S.pc.close(); } catch { /* */ } }
    S.pc = null; S.dc = null; S.sender = null;
  }
  function retry(ms, ifStill) {
    clearTimeout(S.rt);
    S.rt = setTimeout(() => { if (ifStill && S.pc && S.pc.connectionState === 'connected') return; if (S.started && !S.stopped && S.helloOk) connect(); }, ms);
  }
  async function connect() {
    if (!S.started || S.stopped) return;
    closePc();
    const gen = ++S.gen;
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' }); } catch { msg('noSupport', 'noSupportH'); return; }
    S.pc = pc;
    const dc = pc.createDataChannel('ctl', { ordered: true }); S.dc = dc;
    dc.onopen = () => sendState();
    dc.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch { /* */ } };
    const tr = pc.addTransceiver(S.track || 'video', S.stream ? { direction: 'sendonly', streams: [S.stream] } : { direction: 'sendonly' });
    S.sender = tr.sender; preferH264(tr);
    pc.onconnectionstatechange = () => {
      if (S.pc !== pc) return;
      const st = pc.connectionState;
      if (st === 'connected') { clearTimeout(S.tmo); setConn(S.paused ? 'paused' : 'live'); setEnc(); sendState(); }
      else if (st === 'failed') { setConn('re'); retry(800); }
      else if (st === 'disconnected') { setConn('re'); retry(4000, true); } // often comes back by itself
    };
    setConn(S.paused ? 'paused' : 'conn');
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc, 2500);
      if (S.pc !== pc) return;
      const r = await post('/api/send', { m: { t: 'offer', sdp: pc.localDescription.sdp, gen } });
      if (r === 404) { S.helloOk = false; return; } // the loop says hello again, the PC answers with cfg → connect
      if (r !== 200) { retry(2000); return; }
    } catch { retry(2000); return; }
    S.tmo = setTimeout(() => { if (S.pc === pc && pc.connectionState !== 'connected') connect(); }, 15000);
  }

  /* ----------------------------------------------------------------- state */
  function stateMsg() {
    const st = settings(), set = {};
    for (const k of FINE) if (st[k] !== undefined) set[k] = st[k];
    const rc = rawCaps(), max = { long: Math.max((rc.width || {}).max || 0, (rc.height || {}).max || 0), fps: Math.round((rc.frameRate || {}).max || 0) };
    return { t: 'state', caps: caps(), max, set, c: S.c, w: st.width || 0, h: st.height || 0, fps: Math.round(st.frameRate || 0), facing: S.facing, dev: st.deviceId || '', devs: S.devs, want: S.want, paused: S.paused, dim: S.dim, bat: S.bat, enc: S.enc, name: NAME, cam: !!S.track };
  }
  function sendState() { clearTimeout(S.stT); if (S.helloOk) send(stateMsg()); }
  function sendStateSoon() { clearTimeout(S.stT); S.stT = setTimeout(sendState, 150); }
  setInterval(async () => { // sending numbers for both screens, every 2 s while connected
    const pc = S.pc; if (!pc || pc.connectionState !== 'connected') return;
    try {
      const r = await pc.getStats(S.sender && S.sender.track ? S.sender.track : null);
      r.forEach((x) => { if (x.type === 'outbound-rtp' && (x.kind === 'video' || x.mediaType === 'video')) S.enc = { w: x.frameWidth || 0, h: x.frameHeight || 0, fps: Math.round(x.framesPerSecond || 0), lim: x.qualityLimitationReason || '', impl: x.encoderImplementation || '', br: Math.round((x.targetBitrate || 0) / 1000) }; });
    } catch { /* */ }
    if (S.dc && S.dc.readyState === 'open') sendState();
    if (!$('sheet').classList.contains('hidden') && !dragging) infoUi();
  }, 2000);

  /* ------------------------------------------------------------- controls */
  async function setCtl(k, v) {
    if (k === 'facing' && (v === 'user' || v === 'environment')) { S.want.facing = v; S.want.dev = ''; saveWant(); await reopen(true); }
    else if (k === 'flip') { S.want.facing = S.facing === 'user' ? 'environment' : 'user'; S.want.dev = ''; saveWant(); await reopen(true); }
    else if (k === 'dev' && typeof v === 'string') { const d = S.devs.find((x) => x.id === v); if (!d) return; S.want.dev = v; if (d.facing) S.want.facing = d.facing; saveWant(); await reopen(); }
    else if (k === 'h' || k === 'fps') {
      const w = clean({ [k]: v }); if (!(k in w)) return;
      S.want[k] = w[k]; saveWant();
      // first try to change the running camera (no flicker); reopen it only when that didn't give what was asked
      let ok = false;
      if (S.track && !S.paused) {
        try {
          await S.track.applyConstraints({ ...base(), advanced: [S.c] });
          const s = settings();
          ok = k === 'fps' ? Math.abs((s.frameRate || 0) - w.fps) < 3 : Math.min(s.width || 0, s.height || 0) >= w.h * 0.9;
        } catch { ok = false; }
      }
      if (!ok && !S.paused) await reopen();
      setEnc(); sendState();
    } else if (k === 'q' || k === 'pref') { const w = clean({ [k]: v }); if (!(k in w)) return; S.want[k] = w[k]; saveWant(); hint(); setEnc(); sendState(); }
    else if (k === 'paused') setPaused(!!v);
    else if (k === 'dim') setDim(!!v);
    else if (k === 'name' && typeof v === 'string') { NAME = v.trim().slice(0, 40); store.set('pc.name', NAME); sendState(); }
    else if (k === 'reset') { S.c = {}; saveFine(); await reopen(); }
    else if (k === 'focusAt' && v && typeof v === 'object') focusAt(clampN(+v.x || 0.5, 0, 1), clampN(+v.y || 0.5, 0, 1));
    else if (FINE.includes(k)) fine(k, typeof v === 'boolean' ? v : typeof v === 'string' ? v : +v);
    if (!$('sheet').classList.contains('hidden') && !dragging) sheet();
  }
  async function reopen(exact) {
    if (S.paused) { sendState(); return; }
    try { await openCam(exact); } catch (e) {
      if (exact) { try { await openCam(false); return; } catch (e2) { camErr(e2); return; } }
      camErr(e);
    }
  }
  async function setPaused(p) {
    if (p === S.paused) return;
    S.paused = p;
    if (p) { if (S.sender) await S.sender.replaceTrack(null).catch(() => {}); stopTrack(); $('pv').srcObject = null; setConn('paused'); }
    else { setConn(S.pc && S.pc.connectionState === 'connected' ? 'live' : 'conn'); await reopen(); if (S.pc && S.pc.connectionState !== 'connected') connect(); }
    bar(); sendState();
  }
  function setDim(d) {
    if (d === S.dim) return;
    S.dim = d; $('dimmer').classList.toggle('hidden', !d);
    const pv = $('pv');
    if (d) pv.srcObject = null; else if (S.stream) { pv.srcObject = S.stream; pv.play().catch(() => {}); }
    bar(); sendState();
  }
  let lastTap = 0;
  $('dimmer').addEventListener('pointerdown', (e) => { e.preventDefault(); const n = Date.now(); if (n - lastTap < 400) setDim(false); lastTap = n; });

  /* -------------------------------------------------- bar, zoom, gestures */
  function bar() {
    const cp = caps(), on = !!S.track;
    $('b-flip').disabled = !S.started || S.paused || S.stopped;
    const tb = $('b-torch'); tb.classList.toggle('hidden', !('torch' in cp)); tb.classList.toggle('on', !!(settings().torch)); tb.disabled = !on;
    const pb = $('b-pause'); pb.disabled = !S.started || S.stopped; pb.classList.toggle('on', S.paused); pb.querySelector('span').textContent = t(S.paused ? 'resume' : 'pause');
    pb.querySelector('svg').innerHTML = S.paused ? '<path d="M8 5l11 7-11 7z"/>' : '<path d="M9 6v12M15 6v12"/>';
    $('b-dim').disabled = !S.started || S.stopped;
    zoomUi();
  }
  function zoomUi() {
    const z = caps().zoom, zb = $('zoombar');
    zb.classList.toggle('hidden', !z || S.paused || !S.track);
    if (!z) return;
    const v = settings().zoom || S.c.zoom || z.min, r = $('zoom');
    r.min = z.min; r.max = z.max; r.step = z.step || 0.01;
    if (!zDrag) r.value = v;
    $('zoom-o').textContent = (+v).toFixed(v < 10 ? 1 : 0) + '×';
    zb.querySelectorAll('.zq').forEach((b) => {
      const zv = b.dataset.z === 'min' ? z.min : +b.dataset.z;
      b.classList.toggle('hidden', b.dataset.z === 'min' ? z.min >= 0.99 : zv < z.min - 1e-6 || zv > z.max + 1e-6);
      b.classList.toggle('on', Math.abs(v - zv) < 0.05);
    });
  }
  let zDrag = false;
  $('zoom').addEventListener('input', () => { zDrag = true; const v = +$('zoom').value; $('zoom-o').textContent = v.toFixed(1) + '×'; fine('zoom', v); });
  $('zoom').addEventListener('change', () => { zDrag = false; });
  $('zoombar').addEventListener('click', (e) => { const b = e.target.closest('.zq'); if (!b) return; const z = caps().zoom; if (z) fine('zoom', b.dataset.z === 'min' ? z.min : clampN(+b.dataset.z, z.min, z.max)); });
  const tag = (s) => { const el = $('zoomtag'); el.textContent = s; el.classList.remove('hidden'); clearTimeout(tag.t); tag.t = setTimeout(() => el.classList.add('hidden'), 900); };
  // pinch = zoom, tap = focus at that spot
  const pts = new Map(); let pinch = null, tapAt = null;
  const view = $('view');
  view.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { const [a, b] = [...pts.values()]; const z = caps().zoom; pinch = z ? { d: Math.hypot(a.x - b.x, a.y - b.y), z0: settings().zoom || S.c.zoom || 1, z } : null; tapAt = null; }
    else if (pts.size === 1) tapAt = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  view.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) { const [a, b] = [...pts.values()]; const v = clampN(pinch.z0 * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(10, pinch.d), pinch.z.min, pinch.z.max); fine('zoom', +v.toFixed(2)); tag(v.toFixed(1) + '×'); }
    if (tapAt && Math.hypot(e.clientX - tapAt.x, e.clientY - tapAt.y) > 12) tapAt = null;
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (tapAt && !pts.size && Date.now() - tapAt.t < 350 && S.track) {
      const r = $('pv').getBoundingClientRect(), s = settings(), vw = s.width || 16, vh = s.height || 9;
      const k = Math.min(r.width / vw, r.height / vh), w = vw * k, h = vh * k, x0 = r.left + (r.width - w) / 2, y0 = r.top + (r.height - h) / 2;
      let x = (tapAt.x - x0) / w; const y = (tapAt.y - y0) / h;
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) { if (S.facing === 'user') x = 1 - x; focusAt(x, y); ring(tapAt.x - r.left, tapAt.y - r.top); }
    }
    tapAt = null;
  };
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
  function ring(x, y) { const el = $('ring'); el.style.left = x + 'px'; el.style.top = y + 'px'; el.classList.remove('hidden'); clearTimeout(ring.t); ring.t = setTimeout(() => el.classList.add('hidden'), 900); }
  async function focusAt(x, y) {
    if (!S.track) return;
    const cp = caps(), set = { ...S.c, pointsOfInterest: [{ x, y }] };
    if (Array.isArray(cp.focusMode) && cp.focusMode.includes('single-shot')) set.focusMode = 'single-shot';
    else if (Array.isArray(cp.focusMode) && cp.focusMode.includes('continuous')) set.focusMode = 'continuous';
    delete set.focusDistance;
    try { await S.track.applyConstraints({ ...base(), advanced: [set] }); } catch { /* the phone can't focus on a point */ }
    if (S.c.focusMode === 'manual') { delete S.c.focusMode; delete S.c.focusDistance; saveFine(); }
    sendStateSoon();
  }
  $('b-flip').onclick = () => setCtl('flip');
  $('b-torch').onclick = () => fine('torch', !settings().torch);
  $('b-pause').onclick = () => setPaused(!S.paused);
  $('b-dim').onclick = () => setDim(true);
  $('b-more').onclick = () => { const sh = $('sheet'); if (sh.classList.contains('hidden')) { sh.classList.remove('hidden'); sheet(); } else sh.classList.add('hidden'); };
  $('sh-x').onclick = () => $('sheet').classList.add('hidden');

  /* ----------------------------------------------------------- settings */
  let dragging = false;
  $('sh-body').addEventListener('pointerdown', (e) => { if (e.target.matches('input[type=range]')) dragging = true; });
  addEventListener('pointerup', () => { if (dragging) { dragging = false; setTimeout(() => { if (!$('sheet').classList.contains('hidden')) sheet(); }, 300); } });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const modeName = (m) => ({ continuous: t('mAuto'), 'single-shot': t('mOnce'), manual: t('mManual'), none: t('mNone') }[m] || m);
  const fmtExp = (v) => { const s = v / 10000; return s >= 0.5 ? s.toFixed(1) + ' s' : '1/' + Math.round(1 / s) + ' s'; };
  function sheet() {
    const b = $('sh-body'), cp = caps(), st = settings(), w = S.want;
    const top = b.scrollTop;
    const chips = (k, items) => `<div class="chips">${items.map(([v, label, on, dis]) => `<button class="chip${on ? ' on' : ''}" data-k="${k}" data-v="${esc(v)}"${dis ? ' disabled' : ''}>${esc(label)}</button>`).join('')}</div>`;
    const slider = (k, label, c, v, fmt = (x) => (+x).toFixed(c.step && c.step < 1 ? 1 : 0)) => `<div class="sl"><span>${esc(label)}</span><output data-o="${k}">${esc(fmt(v))}</output><input type="range" data-s="${k}" min="${c.min}" max="${c.max}" step="${c.step || (c.max - c.min) / 100}" value="${v}"></div>`;
    const val = (k, d) => (st[k] !== undefined ? st[k] : S.c[k] !== undefined ? S.c[k] : d);
    let h = '';
    if (S.devs.length > 1) h += `<div class="grp"><h4>${t('lens')}</h4>${chips('dev', S.devs.map((d) => [d.id, d.label, d.id === st.deviceId]))}</div>`;
    const rc = rawCaps(), long = Math.max((rc.width || {}).max || 0, (rc.height || {}).max || 0);
    h += `<div class="grp"><h4>${t('res')}</h4>${chips('h', [[720, '720p'], [1080, '1080p'], [1440, '1440p'], [2160, '4K']].map(([v, l]) => [v, l, w.h === v, long && long < v * 16 / 9 * 0.95]))}`;
    const fmax = (rc.frameRate || {}).max || 0;
    h += `<h4 style="margin-top:12px">${t('fps')}</h4>${chips('fps', [[30, t('fpsN', 30), w.fps === 30], [60, t('fpsN', 60), w.fps === 60, fmax && fmax < 59]])}</div>`;
    h += `<div class="grp"><h4>${t('q')}</h4>${chips('q', [['save', t('qSave'), w.q === 'save'], ['auto', t('qAuto'), w.q === 'auto'], ['high', t('qHigh'), w.q === 'high']])}`;
    h += `<h4 style="margin-top:12px">${t('pref')}</h4>${chips('pref', [['balanced', t('pBal'), w.pref === 'balanced'], ['smooth', t('pSmooth'), w.pref === 'smooth'], ['sharp', t('pSharp'), w.pref === 'sharp']])}</div>`;
    if (cp.zoom) h += `<div class="grp"><h4>Zoom</h4>${slider('zoom', 'Zoom', cp.zoom, val('zoom', cp.zoom.min), (x) => (+x).toFixed(1) + '×')}</div>`;
    let any = !!cp.zoom || 'torch' in cp;
    if (cp.focusMode || cp.focusDistance) {
      any = true;
      h += `<div class="grp"><h4>${t('focus')}</h4>`;
      if (Array.isArray(cp.focusMode) && cp.focusMode.length > 1) h += chips('focusMode', cp.focusMode.map((m) => [m, modeName(m), val('focusMode') === m]));
      if (cp.focusDistance) h += slider('focusDistance', t('fDist'), cp.focusDistance, val('focusDistance', cp.focusDistance.min), (x) => (+x).toFixed(2));
      h += `<p class="note">${t('tapFocus')}</p></div>`;
    }
    if (cp.exposureMode || cp.exposureCompensation || cp.exposureTime || cp.iso) {
      any = true;
      h += `<div class="grp"><h4>${t('expo')}</h4>`;
      if (Array.isArray(cp.exposureMode) && cp.exposureMode.length > 1) h += chips('exposureMode', cp.exposureMode.map((m) => [m, modeName(m), val('exposureMode') === m]));
      if (cp.exposureCompensation) h += slider('exposureCompensation', t('eComp'), cp.exposureCompensation, val('exposureCompensation', 0), (x) => (x > 0 ? '+' : '') + (+x).toFixed(1));
      if (cp.exposureTime) h += slider('exposureTime', t('eTime'), cp.exposureTime, val('exposureTime', cp.exposureTime.min), fmtExp);
      if (cp.iso) h += slider('iso', t('iso'), cp.iso, val('iso', cp.iso.min), (x) => Math.round(x));
      h += '</div>';
    }
    if (cp.whiteBalanceMode || cp.colorTemperature) {
      any = true;
      h += `<div class="grp"><h4>${t('wb')}</h4>`;
      if (Array.isArray(cp.whiteBalanceMode) && cp.whiteBalanceMode.length > 1) h += chips('whiteBalanceMode', cp.whiteBalanceMode.map((m) => [m, modeName(m), val('whiteBalanceMode') === m]));
      if (cp.colorTemperature) h += slider('colorTemperature', t('wbTemp'), cp.colorTemperature, val('colorTemperature', cp.colorTemperature.min), (x) => Math.round(x) + ' K');
      h += '</div>';
    }
    const looks = [['brightness', t('bright')], ['contrast', t('contrast')], ['saturation', t('sat')], ['sharpness', t('sharp')]].filter(([k]) => cp[k]);
    if (looks.length) { any = true; h += `<div class="grp"><h4>${t('look')}</h4>${looks.map(([k, l]) => slider(k, l, cp[k], val(k, (cp[k].min + cp[k].max) / 2))).join('')}</div>`; }
    if (!any) h += `<div class="grp"><p class="note">${t('noFine')}</p></div>`;
    if (any) h += `<div class="grp"><button class="btn small" data-k="reset" data-v="1">${t('reset')}</button></div>`;
    h += `<div class="grp"><h4>${t('info')}</h4><dl class="kv" id="sh-info"></dl>${'wakeLock' in navigator ? '' : `<p class="note">${t('wake')}</p>`}</div>`;
    h += `<div class="grp"><h4>${t('name')}</h4><div class="name-row"><input id="sh-name" maxlength="40" value="${esc(NAME)}"><button class="btn small" id="sh-save">${t('save')}</button></div></div>`;
    h += `<div class="grp"><button class="btn danger" id="sh-stop">${t('disconnect')}</button></div>`;
    b.innerHTML = h; b.scrollTop = top;
    infoUi();
    b.querySelectorAll('[data-k]').forEach((el) => { el.onclick = () => { const k = el.dataset.k, v = el.dataset.v; setCtl(k, ['h', 'fps'].includes(k) ? +v : v); }; });
    b.querySelectorAll('[data-s]').forEach((el) => {
      const k = el.dataset.s, c = cp[k], o = b.querySelector(`[data-o="${k}"]`);
      const fmt = k === 'exposureTime' ? fmtExp : k === 'zoom' ? (x) => (+x).toFixed(1) + '×' : k === 'colorTemperature' ? (x) => Math.round(x) + ' K' : k === 'iso' ? (x) => Math.round(x) : k === 'exposureCompensation' ? (x) => (x > 0 ? '+' : '') + (+x).toFixed(1) : (x) => (+x).toFixed(c && c.step && c.step < 1 ? (k === 'focusDistance' ? 2 : 1) : 0);
      el.oninput = () => { o.textContent = fmt(+el.value); fine(k, +el.value); };
    });
    $('sh-save').onclick = () => setCtl('name', $('sh-name').value);
    $('sh-stop').onclick = () => { post('/api/bye', {}); stopAll(); msg('stopped', '', 'join', () => begin(true)); $('sheet').classList.add('hidden'); };
  }
  function infoUi() {
    const el = $('sh-info'); if (!el) return;
    const st = settings(), e = S.enc, rows = [];
    if (e && e.w) rows.push([t('iSend'), `${e.w}×${e.h} · ${e.fps} fps${e.br ? ` · ${(e.br / 1000).toFixed(1)} Mbps` : ''}`]);
    else if (st.width) rows.push([t('cam'), `${st.width}×${st.height} · ${Math.round(st.frameRate || 0)} fps`]);
    if (e && e.impl) rows.push([t('iEnc'), e.impl]);
    if (e && e.lim && e.lim !== 'none') rows.push([t('iLimit'), e.lim === 'cpu' ? t('lCpu') : e.lim === 'bandwidth' ? t('lBw') : t('lOther')]);
    if (S.bat) rows.push([t('iBat'), `${S.bat.level}%${S.bat.charging ? ' · ' + t('charging') : ''}`]);
    el.innerHTML = rows.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('');
  }

  /* --------------------------------------------------------------- status */
  function setConn(c, text) {
    S.conn = c;
    const label = text || { idle: '', conn: t('conn'), live: S.pcName ? t('live', S.pcName) : t('liveAny'), paused: t('paused'), re: t('re'), nopc: t('nopc') }[c] || '';
    $('sub').textContent = label + (S.bat && S.bat.level <= 15 && !S.bat.charging && c === 'live' ? ' · ' + t('lowBat') : '');
    $('dot').className = 'dot ' + ({ live: 'ok', paused: 'wait', conn: 'wait', re: 'wait', nopc: 'err' }[c] || '');
    if (c === 'nopc' && S.started && !S.stopped && !S.msgK) $('sub').textContent = t('nopc') + ' ' + t('nopcH');
  }
  function msg(k, h, btn, fn) {
    S.msgK = [k, h, btn, fn];
    $('msg').classList.remove('hidden');
    const p = $('msg-t'); p.textContent = t(k);
    if (h) { const s = document.createElement('small'); s.textContent = TX.en[h] ? t(h) : h; p.appendChild(s); }
    const b = $('msg-b'); b.classList.toggle('hidden', !btn); if (btn) { b.textContent = t(btn); b.onclick = fn; }
  }
  function hideMsg() { S.msgK = null; $('msg').classList.add('hidden'); }

  /* ------------------------------------------------------------- life cycle */
  let wake = null;
  async function lockWake() {
    try { if ('wakeLock' in navigator && !wake && document.visibilityState === 'visible') { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch { /* not allowed now: tried again on the next tap */ }
  }
  addEventListener('pointerdown', () => { if (S.started && !wake) lockWake(); }, { passive: true });
  function stopAll() {
    S.stopped = true; S.started = false; S.helloOk = false; clearTimeout(S.cfgWait);
    closePc(); stopTrack(); $('pv').srcObject = null; setDim(false);
    setConn('idle'); bar();
    if (wake) { wake.release().catch(() => {}); wake = null; }
  }
  async function begin(join) {
    hideMsg();
    S.stopped = false; S.started = true; S.join = S.join || !!join; S.helloOk = false; S.paused = false;
    store.set('pc.auto', '1');
    setConn('conn'); bar(); lockWake();
    try { await openCam(); } catch (e) { S.started = false; camErr(e); bar(); return; }
    loop();
  }
  document.addEventListener('visibilitychange', () => {
    if (!S.started || S.stopped) return;
    send({ t: 'away', hidden: document.hidden });
    if (document.hidden) return;
    lockWake();
    if (!S.paused && (!S.track || S.track.readyState === 'ended')) openCam().catch(camErr);
    if (S.pc && ['failed', 'closed'].includes(S.pc.connectionState)) connect();
  });
  addEventListener('pagehide', (e) => { if (S.started && !e.persisted) try { navigator.sendBeacon('/api/bye', JSON.stringify({ k: K, pid: PID, sid: SID })); } catch { /* */ } });
  addEventListener('pageshow', (e) => { if (e.persisted && S.started) { S.helloOk = false; if (!S.track) openCam().catch(camErr); loop(); } });
  if (navigator.getBattery) navigator.getBattery().then((b) => { const u = () => { S.bat = { level: Math.round(b.level * 100), charging: !!b.charging }; setConn(S.conn); sendStateSoon(); }; b.addEventListener('levelchange', u); b.addEventListener('chargingchange', u); u(); }).catch(() => {});

  applyLang(L);
  bar();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) msg('noSupport', 'noSupportH');
  else if (!K) msg('badKey', 'badKeyH');
  else if (store.get('pc.auto', '') === '1') begin(false); // reopened page / reload: carry on by itself
  else msg('startT', 'startH', 'start', () => begin(true));
})();
