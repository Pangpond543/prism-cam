// "Hand" tab: tracking switch and status, things that ride the hand, gesture → command bindings, custom poses,
// and the PC-control switches (arm, hand mouse).
import { api, native, bus, T, toast, htmlBox, promptBox, confirmBox, ctxMenu, esc, $ } from './core.js';
import { icon } from './icons.js';
import { hands, gestureList, gestureName, gestureEmoji, retryHands, pairList } from './hands.js';
import { ctl, setArmed, setMouse, fire } from './handctl.js';
import { store, prof, loadProfiles, saveProfiles, newProfile, setActive, removeProfile, customList, customPairList, pairModelReady, addCustom, removeCustom, sampleCount, clearClass, modelReady, exportProfile, importProfile, resetToDefaults, MIN_SAMPLES } from './handml.js';
import { runWizard, report, teachList, pairTeachList, quickFix } from './handtrain.js';
import { studio } from './studio.js';
import { ANIM_VERBS } from './anim-core.js';

const uid = () => Math.random().toString(36).slice(2, 9);
const H = () => studio.hand();
const changed = () => { studio.applyHandCfg(); studio.touch(); };

/* ----------------------------------------------------------------- labels */
export const appCmds = () => [
  ['scene-next', T`ซีนถัดไป`], ['scene-prev', T`ซีนก่อนหน้า`],
  ...studio.scenes().map((s, i) => ['scene:' + i, T`ไปซีน “${s.name}”`]),
  ['snap', T`ถ่ายภาพนิ่ง`], ['rec', T`เริ่ม / หยุดอัดวิดีโอ`], ['vcam', T`เปิด / ปิดกล้องเสมือน`],
  ['mouse', T`เปิด / ปิดโหมดเมาส์`], ['fx-clear', T`ล้างภาพวาดกลางอากาศ`], ['arm-off', T`หยุดควบคุมเครื่อง`],
  ...studio.allLayers().map((l) => ['layer:' + l.id, T`ซ่อน / แสดงเลเยอร์ “${l.name}”`]),
  ...studio.allLayers().flatMap((l) => [['layer-show:' + l.id, T`แสดงเลเยอร์ “${l.name}”`], ['layer-hide:' + l.id, T`ซ่อนเลเยอร์ “${l.name}”`]]),
  ...studio.allLayers().filter((l) => l.type === 'area' && l.slides && l.slides.on).flatMap((l) => [['slide-next:' + l.id, T`สไลด์ถัดไปใน “${l.name}”`], ['slide-prev:' + l.id, T`สไลด์ก่อนหน้าใน “${l.name}”`]]),
  ...studio.scenes().flatMap((s) => (s.clips || []).flatMap((c) => ANIM_VERBS().map(([v, n]) => [`anim:${v}:${c.id}`, `🎬 ${n} “${c.name}”`]))),
];
const mouseBtns = () => [['left', T`คลิกซ้าย`], ['right', T`คลิกขวา`], ['double', T`ดับเบิลคลิก`], ['middle', T`คลิกปุ่มกลาง`], ['scrollup', T`เลื่อนขึ้น`], ['scrolldown', T`เลื่อนลง`]];
const actTypes = () => [['key', T`กดคีย์ / คีย์ลัด`], ['macro', T`มาโคร (หลายขั้นตอน)`], ['text', T`พิมพ์ข้อความ`], ['open', T`เปิดโปรแกรม / ไฟล์ / เว็บ`], ['mouse', T`ปุ่มเมาส์`], ['app', T`คำสั่งใน Prism Cam`]];
const KEY_PRESETS = () => [[T`เล่น / หยุดเพลง`, 'mediaplaypause'], [T`เพลงถัดไป`, 'medianext'], [T`เพลงก่อนหน้า`, 'mediaprev'], [T`เพิ่มเสียง`, 'volumeup'], [T`ลดเสียง`, 'volumedown'], [T`ปิดเสียง`, 'volumemute'], ['Alt+Tab', 'alt+tab'], ['Win+D', 'win+d'], ['Ctrl+C', 'ctrl+c'], ['Ctrl+V', 'ctrl+v'], ['PrtSc', 'printscreen']];
export function actionLabel(a) {
  if (!a) return '';
  if (a.type === 'key') { const p = KEY_PRESETS().find((x) => x[1] === a.keys); return p ? p[0] : (a.keys || '').split('+').map((k) => k.length > 1 ? k[0].toUpperCase() + k.slice(1) : k.toUpperCase()).join(' + '); }
  if (a.type === 'macro') return T`มาโคร ${(a.script || '').split('\n').filter((l) => l.trim()).length} ขั้นตอน`;
  if (a.type === 'text') return T`พิมพ์ “${(a.text || '').slice(0, 18)}”`;
  if (a.type === 'open') return T`เปิด ${(a.path || '').split(/[\\/]/).pop().slice(0, 22)}`;
  if (a.type === 'mouse') return (mouseBtns().find((x) => x[0] === a.btn) || ['', ''])[1];
  if (a.type === 'app') return (appCmds().find((x) => x[0] === a.cmd) || ['', T`คำสั่งที่ไม่มีแล้ว`])[1];
  return '';
}
const needsArm = (a) => a && a.type !== 'app';
const allGestures = () => [...gestureList().map((g) => [g[0], `${g[1]} ${g[2]}`]), ...customList().map((p) => ['c:' + p.id, '⭐ ' + p.name]), ...pairList().map((g) => [g, gestureName(g)])];

// keyboard event → "ctrl+shift+a"
const CODE = { Enter: 'enter', NumpadEnter: 'enter', Escape: 'esc', Space: 'space', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', ArrowLeft: 'left', ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', PrintScreen: 'printscreen', Minus: 'minus', Equal: 'plus', Comma: 'comma', Period: 'period', CapsLock: 'capslock', Pause: 'pause' };
export function comboOf(e) {
  const c = e.code;
  let k = /^Key[A-Z]$/.test(c) ? c[3].toLowerCase() : /^Digit\d$/.test(c) ? c[5] : /^F\d{1,2}$/.test(c) ? c.toLowerCase() : /^Numpad\d$/.test(c) ? 'numpad' + c[6] : CODE[c] || '';
  if (!k && e.key.length === 1 && !/[+\s]/.test(e.key)) k = e.key.toLowerCase();
  if (!k) return '';
  return [e.ctrlKey && 'ctrl', e.shiftKey && 'shift', e.altKey && 'alt', e.metaKey && 'win', k].filter(Boolean).join('+');
}

/* ------------------------------------------------------------ small builders */
const el = (tag, cls, html) => { const d = document.createElement(tag); if (cls) d.className = cls; if (html !== undefined) d.innerHTML = html; return d; };
function sec(root, ico, title, toggle) {
  const s = el('div', 'sec', `<h4>${icon(ico)}<span>${esc(title)}</span>${toggle ? '<label><input type="checkbox"></label>' : ''}</h4>`);
  root.appendChild(s);
  if (toggle) { const cb = s.querySelector('input'); cb.checked = toggle.get(); cb.onchange = () => toggle.set(cb.checked); }
  return s;
}
function slider(parent, label, obj, key, min, max, step, fmt, done) {
  const d = el('div', 'sl', `<span>${esc(label)}</span><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`);
  const inp = d.querySelector('input'), o = d.querySelector('output');
  const show = () => { inp.value = obj[key]; o.textContent = fmt ? fmt(obj[key]) : obj[key]; inp.style.setProperty('--p', ((obj[key] - min) / (max - min)) * 100 + '%'); };
  inp.oninput = () => { obj[key] = +inp.value; show(); if (done) done(); };
  inp.onchange = changed;
  show(); parent.appendChild(d);
}
function pickRow(parent, label, value, opts, set) {
  const d = el('div', 'rowf', `<span>${esc(label)}</span><label class="field"><select>${opts.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join('')}</select></label>`);
  const s = d.querySelector('select'); s.value = value; s.onchange = () => set(s.value);
  parent.appendChild(d); return s;
}
function chips(parent, items, cls = 'chips') {
  const d = el('div', cls);
  for (const it of items) { if (!it) continue; const [label, run, on, ico] = it; const b = el('button', 'chip' + (on ? ' on' : ''), (ico ? icon(ico) : '') + `<span>${esc(label)}</span>`); b.onclick = run; d.appendChild(b); }
  parent.appendChild(d); return d;
}
const note = (parent, html) => { const n = el('div', 'panel-note', html); parent.appendChild(n); return n; };

/* -------------------------------------------------------------------- tab */
let statusEl = null;
function statusText() {
  const h = H();
  if (!h.on) return T`ปิดอยู่`;
  if (hands.state === 'failed') return T`โหลดโมเดลมือไม่สำเร็จ` + (hands.err ? ` (${hands.err.slice(0, 60)})` : '');
  if (hands.state !== 'ready') return studio.handSource() ? T`กำลังโหลดโมเดลมือ…` : T`รอกล้อง — เพิ่มกล้องในซีนนี้ก่อน`;
  if (!studio.handSource()) return T`รอกล้อง — เพิ่มกล้องในซีนนี้ก่อน`;
  const live = hands.tracks.map((t) => `${t.side === 'R' ? T`ขวา` : T`ซ้าย`}${t.g ? ' ' + gestureEmoji(t.g) : ''}`).join(' · ');
  return `${hands.delegate} · ${hands.fps} ${T`ครั้ง/วินาที`} · ${Math.round(hands.ms)} ms` + (live ? ` · ${live}` : ` · ${T`ยังไม่เห็นมือ`}`);
}
setInterval(() => { if (statusEl && statusEl.isConnected) statusEl.textContent = statusText(); }, 300);

export function renderHand() {
  const root = $('tab-hand'), h = H(), keep = $('panel-body').scrollTop;
  root.innerHTML = '';

  /* tracking */
  const tk = sec(root, 'hand', T`การจับมือ`, { get: () => h.on, set: (v) => { h.on = v; if (!v && ctl.mouse) setMouse(false); changed(); renderHand(); } });
  statusEl = el('div', 'hand-status', esc(statusText())); tk.appendChild(statusEl);
  if (h.on) {
    if (hands.state === 'failed') chips(tk, [[T`ลองใหม่`, () => { retryHands(); renderHand(); }, false, 'refresh']]).style.margin = '6px 0';
    const media = studio.allLayers().filter((l) => ['camera', 'video', 'screen', 'image'].includes(l.type));
    pickRow(tk, T`ดูมือจาก`, media.some((l) => l.id === h.src) ? h.src : '', [['', T`อัตโนมัติ (กล้องตัวแรก)`], ...media.map((l) => [l.id, l.name])], (v) => { h.src = v; changed(); });
    chips(tk, [
      [T`1 มือ`, () => { h.n = 1; changed(); renderHand(); }, h.n === 1], [T`2 มือ`, () => { h.n = 2; changed(); renderHand(); }, h.n === 2],
      ['GPU', () => { h.gpu = true; changed(); renderHand(); }, h.gpu], ['CPU', () => { h.gpu = false; changed(); renderHand(); }, !h.gpu],
    ], 'grid4').style.margin = '8px 0 6px';
    slider(tk, T`ความนิ่ง`, h, 'smooth', 0, 100, 5, (v) => v + '%', () => studio.applyHandCfg());
    slider(tk, T`ชดเชยหน่วง`, h, 'predict', 0, 100, 5, (v) => v + '%', () => studio.applyHandCfg());
    chips(tk, [
      [T`โครงมือในพรีวิว`, () => { h.overlay = !h.overlay; changed(); renderHand(); }, h.overlay],
      [T`สลับมือซ้าย-ขวา`, () => { h.swap = !h.swap; changed(); renderHand(); }, h.swap],
    ]).style.marginTop = '6px';
    note(tk, T`ความนิ่งสูง = มือไม่สั่นแต่ตามช้าลงเล็กน้อย · ชดเชยหน่วง = ให้ของที่ติดมือเกาะมือสนิทขณะขยับเร็ว · โครงมือในพรีวิวไม่ถูกส่งออกกล้องเสมือน`);
  }

  /* teach the gestures to this person's hands */
  renderTeach(root);

  /* things that ride the hand */
  const at = sec(root, 'sparkle', T`ของลอยตามมือ`);
  chips(at, [
    [T`เอฟเฟกต์มือ`, () => { studio.addHandFx(); renderHand(); }, false, 'wand'],
    [T`ข้อความติดมือ`, () => { studio.addHandText(T`สวัสดี!`); renderHand(); }, false, 'text'],
    [T`สติกเกอร์ติดมือ`, async () => { await studio.addHandSticker(); renderHand(); }, false, 'sticker'],
  ]);
  note(at, T`เลเยอร์ใดก็ติดมือได้ — เลือกเลเยอร์ แล้วเปิด “ติดตามมือ” ในแท็บปรับแต่ง (เลือกจุดบนมือ หมุน/ย่อขยายตามมือ หรือให้โผล่เฉพาะตอนทำท่าที่กำหนด)`);

  /* gesture → command */
  const bd = sec(root, 'sliders', T`ท่ามือ → คำสั่ง`);
  if (!h.binds.length) note(bd, T`ยังไม่มีคำสั่ง — ผูกท่ามือกับคีย์ลัด มาโคร การเปิดโปรแกรม หรือคำสั่งใน Prism Cam`).style.padding = '0 2px 8px';
  for (const b of h.binds) {
    const row = el('div', 'bind' + (b.on ? '' : ' off'), `<span class="b-emo">${esc(gestureEmoji(b.gesture) || '❔')}</span><span class="b-main"><b>${esc(gestureName(b.gesture).replace(/^\S+\s/, ''))}</b><small>${esc(actionLabel(b.action))}${needsArm(b.action) ? ' <i class="b-pc">PC</i>' : ''}</small></span><input type="checkbox" title="${T`เปิด / ปิดคำสั่งนี้`}"><button class="icon-btn" title="${T`ลบ`}">${icon('x')}</button>`);
    row.dataset.id = b.id;
    const cb = row.querySelector('input'); cb.checked = b.on;
    cb.onchange = () => { b.on = cb.checked; changed(); row.classList.toggle('off', !b.on); };
    row.querySelector('button').onclick = (e) => { e.stopPropagation(); h.binds.splice(h.binds.indexOf(b), 1); changed(); renderHand(); };
    row.onclick = (e) => { if (!e.target.closest('input, button')) editBind(b); };
    bd.appendChild(row);
  }
  chips(bd, [
    [T`เพิ่มคำสั่ง`, () => editBind(null), false, 'plus'],
    [T`เพิ่มชุดตัวอย่าง`, addSamples],
  ]).style.marginTop = '8px';


  /* control this PC */
  const pc = sec(root, 'shield', T`ควบคุมเครื่องนี้`, { get: () => ctl.armed, set: async (v) => { await setArmed(v); renderHand(); } });
  note(pc, ctl.armed
    ? T`<b>เปิดอยู่</b> — ท่ามือสั่งคีย์บอร์ดและเมาส์ของเครื่องนี้ได้ · กด <kbd>Ctrl+Shift+F12</kbd> เพื่อหยุดทันทีจากทุกโปรแกรม`
    : T`ปิดอยู่ — คำสั่งที่กดคีย์ คลิกเมาส์ หรือเปิดโปรแกรมจะยังไม่ทำงาน (ต้องเปิดใหม่ทุกครั้งที่เริ่มโปรแกรม เพื่อความปลอดภัย)`).style.padding = '0 2px 6px';
  if (ctl.armed) {
    const M = h.mouse;
    chips(pc, [[ctl.mouse ? T`ปิดโหมดเมาส์` : T`เปิดโหมดเมาส์`, () => { setMouse(!ctl.mouse); renderHand(); }, ctl.mouse, 'locate']]).style.margin = '4px 0 8px';
    pickRow(pc, T`มือที่ใช้`, M.hand, [['any', T`มือไหนก็ได้`], ['right', T`มือขวา`], ['left', T`มือซ้าย`]], (v) => { M.hand = v; changed(); });
    slider(pc, T`พื้นที่ขยับ`, M, 'zone', 25, 90, 5, (v) => v + '%');
    slider(pc, T`ความลื่นเคอร์เซอร์`, M, 'glide', 0, 100, 5, (v) => v + '%');
    M.sens ??= 50;
    slider(pc, T`ความไวการจีบ`, M, 'sens', 0, 100, 5, (v) => v + '%');
    chips(pc, [
      [T`🤏 โป้ง+ชี้ = คลิก/ลาก`, () => { M.click = !M.click; changed(); renderHand(); }, M.click],
      [T`โป้ง+กลาง = คลิกขวา`, () => { M.rclick = !M.rclick; changed(); renderHand(); }, M.rclick],
      [T`โป้ง+นาง = เลื่อนหน้า`, () => { M.scroll = !M.scroll; changed(); renderHand(); }, M.scroll],
      [T`กลับซ้าย-ขวา`, () => { M.mirror = !M.mirror; changed(); renderHand(); }, !M.mirror],
    ]).style.marginTop = '6px';
    const c = prof().mouse;
    chips(pc, [[c ? T`ปรับเทียบระยะจีบใหม่` : T`ปรับเทียบระยะจีบ`, () => import('./handtrain.js').then((m) => m.calibrateMouse()), !c, 'hand']]).style.marginTop = '6px';
    note(pc, (c ? T`ปรับเทียบแล้ว (จีบ ${Math.round(c.pinch * 100)} · กาง ${Math.round(c.open * 100)})` : T`ยังไม่ได้ปรับเทียบ — ใช้ค่ากลาง`) + ' · ' + T`ความไวสูง = จีบไม่ต้องแน่นก็กดติด · หลอดเหนือมือในพรีวิวบอกระยะจีบ: เส้นทึบ = จุดกด เส้นประ = จุดปล่อย`);
    note(pc, T`จีบค้างแล้วขยับ = ลากของ · กำมือ = ยกเมาส์ (ย้ายมือได้โดยเคอร์เซอร์อยู่ที่เดิม กรอบเส้นประจะย้ายตามมือ) · ขยับเมาส์จริงเมื่อไร มือจะหยุดคุมให้ทันที`);
  }
  $('panel-body').scrollTop = keep;
}

function addSamples() {
  const h = H(), have = (g, cmd) => h.binds.some((b) => b.gesture === g && b.action && (b.action.cmd === cmd || b.action.keys === cmd));
  const add = (gesture, hold, action, mode = 'once') => { if (!have(gesture, action.cmd || action.keys)) h.binds.push({ id: uid(), on: true, gesture, hand: 'any', hold, mode, every: 500, action }); };
  add('swipe-right', 0, { type: 'app', cmd: 'scene-next' });
  add('swipe-left', 0, { type: 'app', cmd: 'scene-prev' });
  add('peace', 1000, { type: 'app', cmd: 'snap' });
  add('call', 1000, { type: 'app', cmd: 'mouse' });
  add('thumbup', 800, { type: 'key', keys: 'mediaplaypause' });
  add('rock', 800, { type: 'key', keys: 'volumemute' });
  changed(); renderHand();
  toast(T`เพิ่มชุดตัวอย่างแล้ว — แตะแต่ละรายการเพื่อแก้ไข`);
}

/* ------------------------------------------------------ hand profile / teaching */
let teachOpen = false;
function renderTeach(root) {
  const p = prof();
  const s = sec(root, 'wand', T`ปรับให้เข้ากับมือคุณ`, { get: () => p.on, set: (v) => { p.on = v; saveProfiles(); setActive(p.id); renderHand(); } });
  const head = el('div', 'rowf', `<span>${T`โปรไฟล์`}</span>`);
  const sel = el('label', 'field', `<select>${store.profiles.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>`);
  const se = sel.querySelector('select'); se.value = p.id; se.onchange = () => { setActive(se.value); renderHand(); studio.refreshProps(); };
  const more = el('button', 'icon-btn', icon('sliders')); more.title = T`จัดการโปรไฟล์`;
  more.onclick = (e) => profileMenu(e.clientX, e.clientY);
  head.append(sel, more); s.appendChild(head);
  const list = teachList(), taught = list.filter((g) => sampleCount(g) >= MIN_SAMPLES).length;
  note(s, !p.on ? T`ปิดอยู่ — ใช้กฎสำเร็จรูปแยกท่า` : modelReady() ? T`<b>ใช้งานอยู่</b> · สอนแล้ว ${taught} / ${list.length} ท่า · ท่าที่ยังไม่สอนจะใช้กฎสำเร็จรูป` : T`ยังไม่ได้สอน — กดปุ่มด้านล่าง แอปจะถามทีละท่าให้คุณทำตาม (ประมาณ 2–3 นาที)`).style.padding = '0 2px 8px';
  chips(s, [
    [T`ปรับให้เข้ากับมือคุณ (ทีละขั้น)`, () => runWizard(), false, 'hand'],
    [T`สอนท่าสองมือ`, () => runWizard(pairTeachList(), true), false, 'hand'],
    (modelReady() || pairModelReady()) && [T`ตรวจความแม่นยำ`, () => report(), false, 'check'],
    [teachOpen ? T`ซ่อนรายละเอียด` : T`ดูรายท่า`, () => { teachOpen = !teachOpen; renderHand(); }],
  ]);
  if (teachOpen) {
    const box = el('div', 'teach-list');
    const pl = pairTeachList();
    for (const g of [...list, ...pl]) {
      if (g === pl[0]) box.appendChild(el('div', 'teach-head', esc(T`ท่าสองมือ`) + `<small>${esc(T`🫶 หัวใจ และ 🙏 พนมมือ ใช้ได้ทันทีโดยไม่ต้องสอน · สอนเพื่อให้แม่นขึ้น`)}</small>`));
      const n = sampleCount(g), custom = /^(pair:)?c:/.test(g);
      const row = el('div', 'bind teach', `<span class="b-emo">${esc(gestureEmoji(g))}</span><span class="b-main"><b>${esc(gestureName(g).replace(/^\S+\s/, ''))}</b><small><i class="t-bar"><i style="width:${Math.min(100, n / 1.2)}%"></i></i>${n} ${T`ตัวอย่าง`}</small></span>`);
      const recb = el('button', 'icon-btn', icon('record')); recb.title = T`อัดท่านี้`; recb.onclick = () => runWizard([g]); row.appendChild(recb);
      if (n || custom) { const del = el('button', 'icon-btn', icon('x')); del.title = custom ? T`ลบท่านี้` : T`ล้างตัวอย่างของท่านี้`; del.onclick = async () => { if (!(await confirmBox(custom ? T`ลบท่านี้` : T`ล้างตัวอย่าง`, gestureName(g), T`ลบ`, true))) return; if (custom) removeCustom(g); else clearClass(g); renderHand(); studio.refreshProps(); }; row.appendChild(del); }
      box.appendChild(row);
    }
    s.appendChild(box);
    chips(s, [[T`เพิ่มท่าใหม่ของฉัน`, () => newPose(), false, 'plus'], [T`เพิ่มท่าสองมือของฉัน`, () => newPose('pair'), false, 'plus']]).style.marginTop = '8px';
  }
  note(s, T`ระบบทายท่าผิด? ทำท่านั้นค้างไว้แล้วกด <kbd>F9</kbd> (หรือ <kbd>Ctrl+Shift+F9</kbd> จากโปรแกรมอื่น) แล้วเลือกท่าที่ถูก — ระบบจะจำทันที`);
}
async function newPose(kind) {
  const two = kind === 'pair';
  const name = await promptBox(two ? T`ตั้งชื่อท่าสองมือ` : T`ตั้งชื่อท่าใหม่`, two ? T`ท่าสองมือ ${customPairList().length + 1}` : T`ท่าที่ ${customList().length + 1}`, T`ต่อไป`);
  if (!name) return;
  const g = addCustom(name, kind);
  // a new two-hand pose is told apart from "two hands doing nothing" — make sure that one has been taught too
  if (two && sampleCount('pair:none') < MIN_SAMPLES) { teachOpen = true; renderHand(); studio.refreshProps(); runWizard(['pair:none', g], true); return; }
  teachOpen = true; renderHand(); studio.refreshProps();
  runWizard([g]);
}
function profileMenu(x, y) {
  const p = prof();
  ctxMenu(x, y, [
    { icon: 'plus', label: T`โปรไฟล์ใหม่ (สำหรับคนอื่น)`, run: async () => { const n = await promptBox(T`ชื่อโปรไฟล์`, T`มือของ…`, T`สร้าง`); if (n) { setActive(newProfile(n.slice(0, 30)).id); renderHand(); } } },
    { icon: 'edit', label: T`เปลี่ยนชื่อ`, run: async () => { const n = await promptBox(T`เปลี่ยนชื่อ`, p.name, T`บันทึก`); if (n) { p.name = n.slice(0, 30); saveProfiles(); renderHand(); } } },
    { icon: 'download', label: T`ส่งออกเป็นไฟล์`, run: () => doExport(p) },
    { icon: 'folder', label: T`นำเข้าจากไฟล์`, run: doImport },
    { icon: 'refresh', label: T`ใช้ท่าพื้นฐานเริ่มต้น`, run: async () => {
      if (!(await confirmBox(T`ใช้ท่าพื้นฐานเริ่มต้น`, T`แทนตัวอย่างของท่าพื้นฐาน (แบมือ กำมือ ชี้นิ้ว … หัวใจ พนมมือ) ใน “${p.name}” ด้วยชุดเริ่มต้นที่มากับโปรแกรม — ท่าที่คุณเพิ่มเองจะยังอยู่`, T`ใช้ชุดเริ่มต้น`))) return;
      if (await resetToDefaults()) { toast(T`ใช้ท่าพื้นฐานเริ่มต้นแล้ว — ถ้าท่าไหนยังทายผิด ทำท่านั้นค้างไว้แล้วกด F9`); renderHand(); studio.refreshProps(); }
      else toast(T`โหลดท่าพื้นฐานเริ่มต้นไม่สำเร็จ`, { kind: 'err' });
    } },
    '-',
    { icon: 'trash', label: T`ลบโปรไฟล์นี้`, danger: true, run: async () => { if (await confirmBox(T`ลบโปรไฟล์`, T`ลบ “${p.name}” และท่าที่สอนไว้ทั้งหมด?`, T`ลบ`, true)) { removeProfile(p.id); renderHand(); } } },
  ], p.name);
}
async function doExport(p) {
  const data = exportProfile(p);
  if (native) {
    const r = await api.invoke('hand:export', { name: p.name, data }).catch(() => null);
    if (r && r.ok) toast(T`บันทึกแล้ว: ${r.path}`, { label: T`เปิดโฟลเดอร์`, action: () => api.invoke('media:reveal', r.path) });
    else toast(T`บันทึกไฟล์ไม่สำเร็จ`, { kind: 'err' });
  } else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); a.download = p.name + '.prismhand.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
}
function doImport() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try { const p = importProfile(await f.text()); toast(T`นำเข้าโปรไฟล์ “${p.name}” แล้ว`); renderHand(); studio.refreshProps(); }
    catch { toast(T`ไฟล์นี้ไม่ใช่โปรไฟล์มือของ Prism Cam`, { kind: 'err' }); }
  };
  inp.click();
}

/* ------------------------------------------------------ skeleton toggle on stage */
function skeletonMenu(x, y) {
  const h = H(), fx = studio.allLayers().find((l) => l.type === 'handfx');
  ctxMenu(x, y, [
    { icon: h.overlay ? 'eye' : 'eyeoff', label: (h.overlay ? '✓ ' : '') + T`โครงมือในพรีวิว (ไม่ออกกล้อง)`, run: () => toggleOverlay() },
    fx && { icon: fx.fx.skel ? 'eye' : 'eyeoff', label: (fx.fx.skel ? '✓ ' : '') + T`โครงมือนีออน (ออกกล้อง)`, run: () => { fx.fx.skel = !fx.fx.skel; studio.touch(); studio.refreshProps(); } },
    '-',
    { icon: 'hand', label: T`ตั้งค่ามือ…`, run: () => studio.showTab('hand') },
  ].filter(Boolean), T`โครงมือ`);
}
function toggleOverlay() { const h = H(); h.overlay = !h.overlay; changed(); renderHand(); syncStageBtn(); toast(h.overlay ? T`แสดงโครงมือในพรีวิว` : T`ซ่อนโครงมือในพรีวิว (กด H เพื่อเปิดอีกครั้ง)`); }
function syncStageBtn() { const b = $('hand-btn'), h = H(); b.classList.toggle('hidden', !h.on); b.classList.toggle('off', !h.overlay); }

/* ------------------------------------------------------------ binding editor */
export function editBind(orig, preset) {
  const h = H();
  const b = orig ? JSON.parse(JSON.stringify(orig)) : { id: uid(), on: true, gesture: 'peace', hand: 'any', hold: 600, mode: 'once', every: 500, action: { type: 'key', keys: '' }, ...(preset || {}) };
  const opt = (list, v) => list.map(([val, n]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(n)}</option>`).join('');
  htmlBox(`<h3>${orig ? T`แก้ไขคำสั่ง` : T`เพิ่มคำสั่ง`}</h3>
    <div class="bind-form wide">
      <div class="rowf"><span>${T`ท่ามือ`}</span><label class="field"><select data-f="gesture">${opt(allGestures(), b.gesture)}</select></label></div>
      <div class="rowf"><span>${T`มือ`}</span><label class="field"><select data-f="hand">${opt([['any', T`มือไหนก็ได้`], ['right', T`มือขวา`], ['left', T`มือซ้าย`]], b.hand)}</select></label></div>
      <div class="rowf" data-static><span>${T`ค้างท่า`}</span><label class="field"><select data-f="hold">${opt([['0', T`ทันที`], ['300', '0.3 s'], ['600', '0.6 s'], ['1000', '1 s'], ['1500', '1.5 s'], ['2000', '2 s']], String(b.hold))}</select></label></div>
      <div class="rowf" data-static><span>${T`การทำงาน`}</span><label class="field"><select data-f="mode">${opt([['once', T`ครั้งเดียวต่อการทำท่า`], ['repeat', T`ทำซ้ำขณะค้างท่า`], ['hold', T`ค้างไว้จนเลิกทำท่า (คีย์ / แอนิเมชัน)`]], b.mode)}</select></label></div>
      <div class="rowf"><span>${T`คำสั่ง`}</span><label class="field"><select data-f="type">${opt(actTypes(), b.action.type)}</select></label></div>
      <div data-params></div>
    </div>
    <div class="modal-btns"><button class="pill-btn" data-x>${T`ยกเลิก`}</button><button class="pill-btn" data-test>${T`ทดสอบ`}</button><button class="pill-btn primary" data-ok>${T`บันทึก`}</button></div>`,
  (m, close) => {
    const q = (s) => m.querySelector(s), params = q('[data-params]');
    const drawParams = () => {
      const a = b.action; params.innerHTML = '';
      if (a.type === 'key') {
        params.innerHTML = `<div class="rowf"><span>${T`คีย์`}</span><label class="field"><input type="text" spellcheck="false" placeholder="ctrl+shift+m"></label><button class="pill-btn small" data-cap>${T`จับคีย์`}</button></div><div class="chips" data-pre></div>`;
        const inp = params.querySelector('input'), cap = params.querySelector('[data-cap]');
        inp.value = a.keys || ''; inp.oninput = () => { a.keys = inp.value.trim().toLowerCase(); };
        let capturing = false;
        const onKey = (e) => { if (!capturing) return; e.preventDefault(); e.stopPropagation(); const c = comboOf(e); if (!c) return; a.keys = c; inp.value = c; stop(); };
        const stop = () => { capturing = false; cap.classList.remove('primary'); cap.textContent = T`จับคีย์`; removeEventListener('keydown', onKey, true); };
        cap.onclick = () => { if (capturing) { stop(); return; } capturing = true; cap.classList.add('primary'); cap.textContent = T`กดคีย์ที่ต้องการ…`; addEventListener('keydown', onKey, true); };
        const pre = params.querySelector('[data-pre]');
        for (const [label, keys] of KEY_PRESETS()) { const c = el('button', 'chip', `<span>${esc(label)}</span>`); c.onclick = () => { a.keys = keys; inp.value = keys; }; pre.appendChild(c); }
      } else if (a.type === 'macro') {
        params.innerHTML = `<label class="field area"><textarea spellcheck="false" rows="6" placeholder="ctrl+c&#10;wait 200&#10;alt+tab&#10;ctrl+v&#10;type ${T`สวัสดี`}"></textarea></label><div class="panel-note">${T`บรรทัดละหนึ่งขั้นตอน: คีย์ลัด (ctrl+c) · wait 300 · type ข้อความ · down shift / up shift · click left|right|double · scroll 3 · open โปรแกรม`}</div>`;
        const ta = params.querySelector('textarea'); ta.value = a.script || ''; ta.oninput = () => { a.script = ta.value; };
      } else if (a.type === 'text') {
        params.innerHTML = `<label class="field area"><textarea spellcheck="false" rows="3"></textarea></label>`;
        const ta = params.querySelector('textarea'); ta.value = a.text || ''; ta.oninput = () => { a.text = ta.value; };
      } else if (a.type === 'open') {
        params.innerHTML = `<div class="rowf"><span>${T`ที่อยู่`}</span><label class="field"><input type="text" spellcheck="false" placeholder="notepad.exe · C:\\…\\app.exe · https://…"></label><button class="pill-btn small" data-pick>${T`เลือกไฟล์`}</button></div><div class="rowf"><span>${T`ตัวเลือกเสริม`}</span><label class="field"><input type="text" spellcheck="false" data-args></label></div>`;
        const inp = params.querySelector('input'), ar = params.querySelector('[data-args]');
        inp.value = a.path || ''; inp.oninput = () => { a.path = inp.value.trim(); };
        ar.value = a.args || ''; ar.oninput = () => { a.args = ar.value; };
        params.querySelector('[data-pick]').onclick = async () => { if (!native) { toast(T`เลือกไฟล์ได้เฉพาะในโปรแกรม Prism Cam`, { kind: 'err' }); return; } const r = await api.invoke('input:pick').catch(() => null); if (r && r.ok) { a.path = r.path; inp.value = r.path; } };
      } else if (a.type === 'mouse') {
        params.innerHTML = `<div class="rowf"><span>${T`ปุ่ม`}</span><label class="field"><select>${opt(mouseBtns(), a.btn || 'left')}</select></label></div>`;
        const s = params.querySelector('select'); a.btn = s.value; s.onchange = () => { a.btn = s.value; };
      } else {
        params.innerHTML = `<div class="rowf"><span>${T`ทำอะไร`}</span><label class="field"><select>${opt(appCmds(), a.cmd || 'scene-next')}</select></label></div>`;
        const s = params.querySelector('select'); a.cmd = s.value; s.onchange = () => { a.cmd = s.value; sync(); };
      }
      if (needsArm(a)) { const n = el('div', 'panel-note', T`คำสั่งนี้สั่งงานเครื่อง จึงทำงานเฉพาะเมื่อเปิดสวิตช์ “ควบคุมเครื่องนี้”`); params.appendChild(n); }
    };
    const sync = () => {
      const sw = b.gesture.startsWith('swipe');
      m.querySelectorAll('[data-static]').forEach((r) => { r.style.display = sw ? 'none' : ''; });
      const mode = q('[data-f=mode]');
      const anim = b.action.type === 'app' && String(b.action.cmd || '').startsWith('anim:');
      mode.querySelector('option[value=hold]').disabled = b.action.type !== 'key' && !anim;
      if (b.action.type !== 'key' && !anim && b.mode === 'hold') { b.mode = 'once'; mode.value = 'once'; }
      if (anim && String(b.action.cmd).startsWith('anim:hold:') && b.mode !== 'hold') { b.mode = 'hold'; mode.value = 'hold'; }
    };
    q('[data-f=gesture]').onchange = (e) => { b.gesture = e.target.value; sync(); };
    q('[data-f=hand]').onchange = (e) => { b.hand = e.target.value; };
    q('[data-f=hold]').onchange = (e) => { b.hold = +e.target.value; };
    q('[data-f=mode]').onchange = (e) => { b.mode = e.target.value; };
    q('[data-f=type]').onchange = (e) => { b.action = { type: e.target.value }; drawParams(); sync(); };
    q('[data-x]').onclick = () => close(null);
    q('[data-test]').onclick = () => { toast(T`จะทำงานในอีก 2 วินาที…`); setTimeout(() => { fire({ ...b, mode: 'once' }, 'start'); }, 2000); };
    q('[data-ok]').onclick = () => {
      const a = b.action;
      if ((a.type === 'key' && !a.keys) || (a.type === 'open' && !a.path) || (a.type === 'macro' && !(a.script || '').trim()) || (a.type === 'text' && !a.text)) { toast(T`ยังไม่ได้ใส่รายละเอียดคำสั่ง`, { kind: 'err' }); return; }
      close(b);
    };
    drawParams(); sync();
  }).then((res) => {
    if (!res) return;
    const i = orig ? h.binds.indexOf(orig) : -1;
    if (i >= 0) h.binds[i] = res; else h.binds.push(res);
    changed(); renderHand(); bus.emit('hand:binds');
  });
}

/* ------------------------------------------------------------------- boot */
export async function startHandUi() {
  bus.on('hand:edit-bind', (preset) => editBind(null, preset));
  await loadProfiles();
  // poses saved by the first version (one snapshot each, inside the project) move into the profile as named poses
  const old = H().poses || [];
  if (old.length) {
    const p = prof();
    for (const o of old) if (!p.custom.some((c) => c.id === o.id)) p.custom.push({ id: o.id, name: String(o.name || '').slice(0, 24) || 'pose' });
    H().poses = []; studio.touch(); saveProfiles();
    toast(T`ย้ายท่าที่บันทึกไว้เข้าโปรไฟล์มือแล้ว — อัดท่าเหล่านั้นใหม่อีกครั้งในแท็บมือ`);
  }
  renderHand(); syncStageBtn(); studio.refreshProps();
  for (const ev of ['hand:cfg', 'hand:ctl', 'hand:state']) bus.on(ev, () => { syncStageBtn(); if ($('tab-hand').classList.contains('active') || ev !== 'hand:state') renderHand(); });
  $('hand-btn').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); skeletonMenu(r.left, r.bottom + 6); };
  addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'h' || e.ctrlKey || e.altKey || e.metaKey || (e.target.closest && e.target.closest('input, textarea, select')) || !$('modal').classList.contains('hidden')) return;
    if (H().on) toggleOverlay();
  });
  bus.on('hand:fired', (b) => { // flash the row and say what ran, so a gesture never fires silently
    const row = document.querySelector(`.bind[data-id="${b.id}"]`);
    if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
    hands.note = { t: performance.now(), text: `${gestureEmoji(b.gesture)} ${actionLabel(b.action)}` };
    const n = $('hand-note'); n.textContent = hands.note.text; n.classList.remove('hidden', 'show'); void n.offsetWidth; n.classList.add('show');
  });
  document.querySelectorAll('#panel-tabs .tab').forEach((t) => t.addEventListener('click', () => { if (t.dataset.tab === 'hand') renderHand(); }));
}
export { confirmBox };
