// Teaching mode: the app asks for one pose at a time, a coach card on the stage counts down and records while the
// user moves the hand around, then reports how well each pose can be told apart. F9 (or Ctrl+Shift+F9 from any
// app) fixes a wrong guess on the spot by asking which pose the hand is really making.
import { api, bus, T, toast, htmlBox, esc, $ } from './core.js';
import { hands, STATIC, pairList, gestureName, gestureEmoji, pickHand } from './hands.js';
import { addSamples, sampleCount, customList, analyze, modelReady, pairModelReady, prof, saveProfiles, MIN_SAMPLES } from './handml.js';
import { studio } from './studio.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const coach = $('hand-coach');
const rec = { on: false, got: [] };
let wiz = null;
export const training = () => !!wiz;
export const teachList = () => ['none', ...STATIC(), ...customList().map((c) => 'c:' + c.id)];
export const pairTeachList = () => ['pair:none', ...pairList()];

// every fresh tracker result becomes a sample while recording: each visible hand for a one-hand pose,
// or both hands together (only when both are in view) for a two-hand pose
bus.on('hand:result', (ts) => {
  if (!rec.on) return;
  if (rec.pair) { if (hands.pair.live) rec.got.push(Float32Array.from(hands.pair.f)); return; }
  for (const tr of hands.tracks) if (tr.seen === ts && ts - tr.born > 150) rec.got.push(Float32Array.from(tr.sn));
});

const tipFor = (gid) => gid === 'pair:none'
  ? T`ยกสองมือให้อยู่ในภาพ แล้วขยับไปมาแบบไม่ได้ทำท่าอะไร — ทั้งห่างกันและใกล้กัน`
  : gid.startsWith('pair:')
    ? T`ทำท่าด้วยสองมือค้างไว้ แล้วขยับมือทั้งสองช้าๆ ใกล้-ไกลกล้อง เอียงเล็กน้อย — ต้องเห็นทั้งสองมือ`
    : gid === 'none'
  ? T`ปล่อยมือตามสบาย ขยับไปมา งอนิ้วครึ่งๆ หรือทำท่ากึ่งกลางระหว่างท่าต่างๆ — สอนให้รู้ว่าตอนไหน “ไม่ได้ทำท่า”`
  : ['thumbup', 'thumbdown', 'point', 'gun'].includes(gid)
    ? T`ค้างท่าไว้ ขยับมือช้าๆ ใกล้-ไกลกล้อง เอียงได้นิดหน่อย แต่อย่าหมุนจนนิ้วชี้ไปอีกทิศ`
    : T`ค้างท่าไว้ แล้วขยับมือช้าๆ: หมุนข้อมือ เอียงซ้าย-ขวา ใกล้-ไกลกล้อง สลับมือซ้าย-ขวาได้`;

/* ------------------------------------------------------------------ coach card */
function show(o) {
  coach.classList.remove('hidden');
  coach.innerHTML = `
    <div class="hc-top"><span class="hc-step">${esc(o.step || '')}</span>${o.rec ? `<span class="hc-rec"><i></i>${T`กำลังอัด`}</span>` : ''}</div>
    <div class="hc-main"><span class="hc-emo">${esc(o.emoji || '')}</span><div><b>${esc(o.title || '')}</b><p>${esc(o.text || '')}</p></div>${o.big != null ? `<span class="hc-big">${esc(String(o.big))}</span>` : ''}</div>
    ${o.bar != null ? `<div class="hc-bar"><i style="width:${Math.round(Math.min(1, o.bar) * 100)}%"></i></div>` : ''}
    ${o.warn ? `<div class="hc-warn">${esc(o.warn)}</div>` : ''}
    <div class="hc-btns"></div>`;
  const bx = coach.querySelector('.hc-btns');
  for (const [label, fn, primary] of o.buttons || []) { const b = document.createElement('button'); b.className = 'pill-btn small' + (primary ? ' primary' : ''); b.textContent = label; b.onclick = fn; bx.appendChild(b); }
}
const hide = () => { coach.classList.add('hidden'); coach.innerHTML = ''; };

/* ---------------------------------------------------------------- one recording */
async function recordOne(gid, ctl, step) {
  const head = { step, emoji: gestureEmoji(gid), title: gestureName(gid).replace(/^\S+\s/, ''), text: tipFor(gid) };
  const btns = [[T`ข้าม`, () => { ctl.skip = true; }], [T`หยุด`, () => { ctl.stop = true; }]];
  const isPair = gid.startsWith('pair:'), seen = () => (isPair ? hands.tracks.length >= 2 : hands.tracks.length > 0);
  for (let i = 4; i > 0; i--) {
    for (let t = 0; t < 10; t++) {
      if (ctl.stop || ctl.skip) return -1;
      show({ ...head, big: i, warn: seen() ? '' : isPair ? T`ต้องเห็นทั้งสองมือในกล้อง` : T`ยังไม่เห็นมือในกล้อง — ยกมือให้อยู่ในภาพ`, buttons: btns });
      await wait(100);
    }
  }
  rec.got = []; rec.pair = isPair; rec.on = true;
  const t0 = performance.now(), NEED = 110;
  while (!ctl.stop && !ctl.skip) {
    const el = performance.now() - t0;
    if ((el > 4000 && rec.got.length >= NEED) || el > 7000) break;
    show({ ...head, rec: true, bar: Math.min(el / 4000, rec.got.length / NEED), warn: seen() ? '' : isPair ? T`ไม่เห็นครบสองมือ — ช่วงนี้จะไม่ถูกเก็บ` : T`ไม่เห็นมือ — ช่วงนี้จะไม่ถูกเก็บ`, buttons: btns });
    await wait(100);
  }
  rec.on = false;
  if (ctl.stop || ctl.skip) return -1;
  if (rec.got.length) addSamples(gid, rec.got);
  return rec.got.length;
}
function choose(o, opts) { // coach card with buttons → resolves with the chosen key (or a timeout default)
  return new Promise((res) => {
    let done = false, timer = 0;
    const go = (k) => { if (done) return; done = true; clearTimeout(timer); res(k); };
    show({ ...o, buttons: opts.map(([label, k, primary]) => [label, () => go(k), primary]) });
    if (o.auto) timer = setTimeout(() => go(o.auto), o.autoMs || 1500);
  });
}

/* ---------------------------------------------------------------------- wizard */
export async function runWizard(only, intro = !only) {
  if (wiz) return;
  const H = studio.hand();
  if (!H.on) { H.on = true; studio.applyHandCfg(); studio.touch(); bus.emit('hand:cfg'); }
  if (!studio.handSource()) { toast(T`เพิ่มกล้องในซีนนี้ก่อน แล้วค่อยเริ่มสอนท่า`, { kind: 'err' }); return; }
  const ctl = { stop: false, skip: false }; wiz = ctl; hands.training = true; bus.emit('hand:train');
  try {
    for (let t = 0; hands.state !== 'ready' && t < 150 && !ctl.stop; t++) { show({ title: T`กำลังเตรียมการจับมือ…`, buttons: [[T`หยุด`, () => { ctl.stop = true; }]] }); await wait(100); }
    if (hands.state !== 'ready') { if (!ctl.stop) toast(T`โหลดโมเดลมือไม่สำเร็จ`, { kind: 'err' }); return; }
    const steps = only || teachList();
    if (intro) {
      const two = steps[0] && steps[0].startsWith('pair:');
      const go = await choose({ emoji: two ? '👐' : '✋', title: two ? T`สอนท่าสองมือ` : T`ปรับให้เข้ากับมือคุณ`, text: (two ? T`ใช้ทั้งสองมือ ให้กล้องเห็นครบ · ` : '') + T`จะถามทีละท่า ${steps.length} ท่า ท่าละประมาณ 8 วินาที: นับถอยหลัง 4 วินาที แล้วอัดขณะที่คุณค้างท่าและขยับมือไปมา ท่าไหนไม่ใช้ กด “ข้าม” ได้` }, [[T`เริ่มเลย`, 'go', true], [T`ยกเลิก`, 'stop']]);
      if (go !== 'go') return;
    }
    for (let i = 0; i < steps.length && !ctl.stop;) {
      const gid = steps[i], step = T`ท่าที่ ${i + 1} / ${steps.length}`;
      ctl.skip = false;
      const n = await recordOne(gid, ctl, step);
      if (ctl.stop) break;
      if (n < 0) { i++; continue; } // skipped
      const head = { step, emoji: gestureEmoji(gid), title: gestureName(gid).replace(/^\S+\s/, '') };
      if (n < 50) {
        const r = await choose({ ...head, text: T`เก็บได้แค่ ${n} ตัวอย่าง — กล้องอาจไม่ค่อยเห็นมือ ลองยกมือให้ชัดขึ้นแล้วอัดใหม่` }, [[T`อัดอีกครั้ง`, 'again', true], [T`ข้าม`, 'next'], [T`หยุด`, 'stop']]);
        if (r === 'stop') break; if (r === 'next') i++;
        continue;
      }
      const r = await choose({ ...head, text: T`✓ เก็บได้ ${n} ตัวอย่าง (รวม ${sampleCount(gid)})`, auto: 'next', autoMs: 1400 }, [[T`อัดซ้ำ`, 'again'], [T`ถัดไป`, 'next', true], [T`หยุด`, 'stop']]);
      if (r === 'stop') break; if (r === 'next') i++;
    }
  } finally { rec.on = false; hide(); wiz = null; hands.training = false; bus.emit('hand:train'); bus.emit('hand:cfg'); }
  await report();
}

/* ---------------------------------------------------------------------- report */
export async function report() {
  if (!modelReady() && !pairModelReady()) {
    const taught = teachList().filter((g) => sampleCount(g) >= MIN_SAMPLES).length;
    if (taught < 2) toast(T`ต้องสอนอย่างน้อย 2 ท่า (รวม “ไม่มีท่า”) ระบบถึงจะเริ่มใช้ท่าที่สอน`);
    return;
  }
  toast(T`กำลังตรวจความแม่นยำ…`);
  const res = await analyze(); if (!res) return;
  const bad = res.filter((r) => r.acc < 0.85);
  const rows = res.map((r) => `<div class="acc-row${r.acc < 0.85 ? ' bad' : ''}"><span class="b-emo">${esc(gestureEmoji(r.gid))}</span><span class="b-main"><b>${esc(gestureName(r.gid).replace(/^\S+\s/, ''))}</b><small>${r.n} ${T`ตัวอย่าง`}${r.acc < 0.85 && r.with ? ' · ' + T`มักถูกทายเป็น ${gestureName(r.with)}` : ''}</small></span><span class="acc-val">${Math.round(r.acc * 100)}%</span></div>`).join('');
  const again = await htmlBox(`<h3>${T`ผลการสอนท่า`}</h3>
    <p>${bad.length ? T`ท่าที่ขึ้นสีแดงยังแยกกับท่าอื่นได้ไม่ดี — อัดเพิ่มทั้งสองท่าที่สับสนกัน และทำให้ต่างกันชัดขึ้น` : T`ทุกท่าแยกกันได้ดี ✓ ลองทำท่าหน้ากล้องแล้วดูป้ายใต้มือในพรีวิว (มี % ความมั่นใจ)`}</p>
    <div class="acc-list wide">${rows}</div>
    <div class="modal-btns"><button class="pill-btn" data-x>${T`เสร็จ`}</button>${bad.length ? `<button class="pill-btn primary" data-again>${T`อัดท่าที่มีปัญหาเพิ่ม`}</button>` : ''}</div>`,
  (m, close) => { m.querySelector('[data-x]').onclick = () => close(false); const a = m.querySelector('[data-again]'); if (a) a.onclick = () => close(true); });
  if (again) { const set = new Set(); for (const r of bad) { set.add(r.gid); if (r.with) set.add(r.with); } runWizard([...set]); }
}

/* ------------------------------------------------------------------- quick fix */
export async function quickFix() {
  if (wiz || !$('modal').classList.contains('hidden')) return;
  const now = performance.now();
  const snaps = hands.tracks.filter((t) => now - t.seen < 500 && t.recent.length).map((t) => ({ side: t.side, g: t.g, list: t.recent.map((r) => r.w) }));
  if (!snaps.length) { toast(T`ไม่เห็นมือในกล้อง — ทำท่าค้างไว้แล้วกด F9 อีกครั้ง`, { kind: 'err' }); return; }
  // with both hands in view, the pose may be a two-hand one: offer "both hands together" as a choice too
  if (hands.pair && hands.pair.live && hands.pair.recent.length) snaps.push({ pair: true, g: hands.pair.g, list: hands.pair.recent.map((f) => Float32Array.from(f)) });
  let pick = snaps.length > 2 && hands.pair.g ? snaps.length - 1 : 0;
  const grid = (s) => (s.pair ? pairTeachList() : teachList()).map((g) => `<button class="pick fix" data-g="${esc(g)}"><span>${esc(gestureEmoji(g))}</span><small>${esc(gestureName(g).replace(/^\S+\s/, ''))}</small></button>`).join('');
  const res = await htmlBox(`<h3>${T`ท่านี้จริงๆ คือท่าอะไร`}</h3>
    <div class="fix-hands"></div>
    <p class="fix-guess"></p>
    <div class="fix-grid wide"></div>
    <div class="modal-btns"><button class="pill-btn" data-x>${T`ยกเลิก`}</button></div>`,
  (m, close) => {
    const draw = () => {
      const s = snaps[pick], gr = m.querySelector('.fix-grid');
      gr.innerHTML = grid(s);
      gr.querySelectorAll('.fix').forEach((b) => { b.classList.toggle('cur', b.dataset.g === (s.g || (s.pair ? 'pair:none' : 'none'))); b.onclick = () => close(b.dataset.g); });
      m.querySelector('.fix-guess').textContent = T`ระบบทายว่า: ${s.g ? gestureName(s.g) : s.pair ? T`สองมือไม่ได้ทำท่า` : T`ไม่มีท่า`}`;
    };
    if (snaps.length > 1) {
      const box = m.querySelector('.fix-hands'); box.className = 'chips fix-hands';
      snaps.forEach((s, i) => { const b = document.createElement('button'); b.className = 'chip' + (i === pick ? ' on' : ''); b.textContent = s.pair ? T`สองมือรวมกัน` : s.side === 'R' ? T`มือขวา` : T`มือซ้าย`; b.onclick = () => { pick = i; box.querySelectorAll('.chip').forEach((c, j) => c.classList.toggle('on', j === i)); draw(); }; box.appendChild(b); });
    }
    draw();
    m.querySelector('[data-x]').onclick = () => close(null);
  });
  if (!res) return;
  addSamples(res, snaps[pick].list);
  bus.emit('hand:cfg');
  toast((res.startsWith('pair:') ? pairModelReady() : modelReady())
    ? T`เพิ่ม ${snaps[pick].list.length} ตัวอย่างให้ “${gestureName(res)}” แล้ว — ระบบจะจำท่านี้ได้แม่นขึ้น`
    : T`เก็บตัวอย่างไว้แล้ว — สอนให้ครบอย่างน้อย 2 ท่าก่อน ระบบถึงจะเริ่มใช้ท่าที่สอน`);
}
addEventListener('keydown', (e) => {
  if (e.key !== 'F9' || e.ctrlKey || e.altKey || (e.target.closest && e.target.closest('input, textarea, select'))) return;
  e.preventDefault(); quickFix();
});
api.on('hand:fix', () => quickFix());
addEventListener('keydown', (e) => { if (wiz && e.key === 'Escape') wiz.stop = true; }, true);
export { prof };

/* -------------------------------------------------------- mouse pinch calibration */
// Two quick measurements: the thumb-index distance when this person pinches, and when the hand is relaxed open.
// The mouse then presses and releases at distances in between that suit this hand.
export async function calibrateMouse() {
  if (wiz) return;
  if (!studio.handSource()) { toast(T`เพิ่มกล้องในซีนนี้ก่อน แล้วค่อยปรับเทียบเมาส์`, { kind: 'err' }); return; }
  const ctl = { stop: false, skip: false }; wiz = ctl; hands.training = true; bus.emit('hand:train');
  const { pinchDistances } = await import('./handctl.js');
  const step = T`ปรับเทียบเมาส์`, stopBtn = [[T`หยุด`, () => { ctl.stop = true; }]];
  const handNow = () => { const tr = pickHand(studio.hand().mouse.hand || 'any'); return tr && performance.now() - tr.seen < 250 ? tr : null; };
  const measure = async (emoji, title, text) => {
    for (let i = 3; i > 0; i--) for (let t = 0; t < 10; t++) {
      if (ctl.stop) return null;
      show({ step, emoji, title, text, big: i, warn: handNow() ? '' : T`ยังไม่เห็นมือในกล้อง — ยกมือให้อยู่ในภาพ`, buttons: stopBtn });
      await wait(100);
    }
    const vals = [], t0 = performance.now();
    while (performance.now() - t0 < 1500) {
      if (ctl.stop) return null;
      const tr = handNow(); if (tr) vals.push(pinchDistances(tr)[0]);
      show({ step, emoji, title, text, rec: true, bar: (performance.now() - t0) / 1500, buttons: stopBtn });
      await wait(50);
    }
    if (vals.length < 8) return NaN;
    vals.sort((a, b) => a - b); return vals[Math.floor(vals.length / 2)];
  };
  try {
    for (let t = 0; hands.state !== 'ready' && t < 150 && !ctl.stop; t++) { show({ step, title: T`กำลังเตรียมการจับมือ…`, buttons: stopBtn }); await wait(100); }
    if (hands.state !== 'ready') return;
    for (;;) {
      const pinch = await measure('🤏', T`จีบนิ้วโป้งกับนิ้วชี้`, T`แตะปลายนิ้วโป้งกับปลายนิ้วชี้ให้ติดกัน แบบเดียวกับตอนที่จะคลิก แล้วค้างไว้`);
      if (pinch === null) return;
      const open = await measure('🖐️', T`กางนิ้วโป้งกับนิ้วชี้`, T`ปล่อยมือตามสบาย ให้นิ้วโป้งกับนิ้วชี้ห่างกันแบบตอนเลื่อนเมาส์ปกติ`);
      if (open === null) return;
      let why = '';
      if (Number.isNaN(pinch) || Number.isNaN(open)) why = T`กล้องไม่ค่อยเห็นมือ — ยกมือให้ชัดขึ้นแล้วลองใหม่`;
      else if (open - pinch < 0.25 || open < pinch * 1.8) why = T`ระยะตอนจีบกับตอนกางใกล้กันเกินไป — ลองจีบให้ปลายนิ้วติดกัน และกางให้ห่างขึ้น`;
      if (why) {
        const r = await choose({ step, emoji: '⚠️', title: T`ลองอีกครั้ง`, text: why }, [[T`ลองใหม่`, 'again', true], [T`ยกเลิก`, 'stop']]);
        if (r === 'stop') return; continue;
      }
      prof().mouse = { pinch: Math.round(pinch * 1000) / 1000, open: Math.round(open * 1000) / 1000 }; saveProfiles();
      await choose({ step, emoji: '✅', title: T`ปรับเทียบเสร็จแล้ว`, text: T`จีบโป้ง+ชี้ = คลิก / จีบค้าง = ลาก · โป้ง+กลาง = คลิกขวา · โป้ง+นาง แล้วขยับขึ้นลง = เลื่อนหน้า · กำมือ = ยกเมาส์`, auto: 'ok', autoMs: 4500 }, [[T`เริ่มใช้`, 'ok', true]]);
      return;
    }
  } finally { hide(); wiz = null; hands.training = false; bus.emit('hand:train'); bus.emit('hand:cfg'); }
}
