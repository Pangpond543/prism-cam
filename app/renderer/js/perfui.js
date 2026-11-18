// Prism Cam — speed panel: opens from the fps number in the status bar. Light mode / auto quality switches, live
// timings per part of the frame, and "copy" so a friend can paste the numbers into a chat.
import { bus, T, toast, esc, $ } from './core.js';
import { icon } from './icons.js';
import { perf, renderScale, liveFps, setLite, setAuto, setGpu } from './perf.js';
import { hands } from './hands.js';
import { studio } from './studio.js';

let pop = null;
const ms = (v) => (v ? v.toFixed(1) : '0') + ' ms';
function rows() {
  const o = studio.out(), s = renderScale(), ow = Math.round(o.w * s), oh = Math.round(o.h * s);
  return [
    [T`ภาพที่วาดได้`, `${perf.fps} / ${liveFps(o.fps)} fps` + (liveFps(o.fps) < o.fps ? ` (${T`ลดจาก`} ${o.fps})` : ''), perf.fps && perf.fps < liveFps(o.fps) * 0.85 ? 'bad' : liveFps(o.fps) < o.fps ? 'warn' : ''],
    [T`ส่งให้กล้องเสมือน`, perf.sent ? `${perf.sent} fps` : T`ยังไม่ได้เปิด`, ''],
    [T`ความละเอียดที่วาด`, `${ow} × ${oh}` + (s < 1 ? ` (${Math.round(s * 100)}%)` : ''), s < 1 ? 'warn' : ''],
    [T`CPU ทั้งเครื่อง`, perf.cpu >= 0 ? `${perf.cpu}%` : '—', perf.cpu > 85 ? 'bad' : perf.cpu > 65 ? 'warn' : ''],
    [T`วาดภาพ`, ms(perf.ms.draw), perf.ms.draw > 1000 / o.fps * 0.7 ? 'bad' : ''],
    [T`AI ลบพื้นหลัง`, perf.ms.seg ? ms(perf.ms.seg) : T`ไม่ได้ใช้`, ''],
    [T`จับมือ`, hands.state === 'ready' ? ms(hands.ms) : T`ไม่ได้ใช้`, ''],
    [T`แปลงภาพส่ง Discord`, perf.sent ? `${ms(perf.ms.send)} · ${perf.path === 'gpu' ? T`การ์ดจอ` : 'CPU'}` : '—', ''],
    [T`การ์ดจอ`, perf.igpu || '—', ''],
  ];
}
export const perfReport = () => `Prism Cam ${T`ความเร็ว`}\n` + rows().map(([k, v]) => `${k}: ${v}`).join('\n') + `\n${T`โหมดเครื่องเบา`}: ${perf.lite ? 'on' : 'off'} · ${T`ปรับคุณภาพอัตโนมัติ`}: ${perf.auto ? 'on' : 'off'}`;

function fill() {
  if (!pop) return;
  pop.querySelector('.pf-rows').innerHTML = rows().map(([k, v, c]) => `<div class="pf-row ${c}"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
}
function close() { if (pop) { pop.remove(); pop = null; } }
function open() {
  if (pop) { close(); return; }
  pop = document.createElement('div');
  pop.className = 'glass perf-pop';
  pop.innerHTML = `<h4>${icon('bolt')}<span>${T`ความเร็ว`}</span><button class="icon-btn" data-x title="${T`ปิด`}">${icon('x')}</button></h4>
    <label class="pf-opt"><input type="checkbox" data-k="lite"><span><b>${T`โหมดเครื่องเบา`}</b><small>${T`สำหรับเครื่องการ์ดจอออนบอร์ด — วาดภาพเล็กลง, AI และการจับมือทำงานถี่น้อยลง, ปิดเอฟเฟกต์กระจกเบลอ`}</small></span></label>
    <label class="pf-opt"><input type="checkbox" data-k="auto"><span><b>${T`ปรับคุณภาพอัตโนมัติ`}</b><small>${T`ถ้าเครื่องตามไม่ทัน จะลดความละเอียดลงเอง แล้วเพิ่มกลับเมื่อเครื่องว่าง`}</small></span></label>
    <label class="pf-opt"><input type="checkbox" data-k="gpu"><span><b>${T`ใช้การ์ดจอแปลงภาพ`}</b><small>${T`ให้การ์ดจอเตรียมภาพที่ส่งไป Discord แทน CPU — ปิดเฉพาะเมื่อภาพในกล้องเสมือนผิดปกติ`}</small></span></label>
    <div class="pf-rows"></div>
    <div class="modal-btns"><button class="pill-btn small" data-copy>${icon('copy')}<span>${T`คัดลอกข้อมูล`}</span></button></div>`;
  document.body.appendChild(pop);
  const ck = (k) => pop.querySelector(`[data-k="${k}"]`);
  ck('lite').checked = perf.lite; ck('auto').checked = perf.auto; ck('gpu').checked = perf.gpuOn;
  ck('lite').onchange = (e) => setLite(e.target.checked);
  ck('auto').onchange = (e) => setAuto(e.target.checked);
  ck('gpu').onchange = (e) => setGpu(e.target.checked);
  pop.querySelector('[data-x]').onclick = close;
  pop.querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(perfReport()).then(() => toast(T`คัดลอกข้อมูลความเร็วแล้ว — วางในแชทได้เลย`), () => {});
  const r = $('st-text').getBoundingClientRect();
  pop.style.left = Math.max(12, Math.min(innerWidth - 352, r.left + r.width / 2 - 170)) + 'px';
  pop.style.bottom = Math.max(12, innerHeight - r.top + 12) + 'px';
  fill();
}
export function startPerfUi() {
  const st = $('st-text');
  st.classList.add('clickable'); st.title = T`กดเพื่อดูความเร็วและเปิดโหมดเครื่องเบา`;
  st.onclick = open;
  bus.on('perf:tick', fill);
  bus.on('perf', () => { if (pop) pop.querySelector('[data-k="lite"]').checked = perf.lite; fill(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop) close(); });
  addEventListener('pointerdown', (e) => { if (pop && !pop.contains(e.target) && e.target !== st) close(); }, true);
}
