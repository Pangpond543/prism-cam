// Prism Cam — glass dropdown for every <select> in the app (status bar, property panel, hand tab, animation …).
// The native <select> stays in the page (hidden) as the source of truth, so every existing `se.value` / `onchange`
// keeps working: this file only draws a button + a frosted list, and writes the choice back with input/change events.
// New selects are picked up automatically (MutationObserver), and code that sets `select.value` updates the button.
import { icon } from './icons.js';

let pop = null, popSel = null, active = -1;

// keep the button in step when code changes the value (no event fires for that)
for (const prop of ['value', 'selectedIndex']) {
  const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
  Object.defineProperty(HTMLSelectElement.prototype, prop, { ...d, set(v) { d.set.call(this, v); if (this._gs) this._gs(); } });
}

function label(se) { const o = se.options[se.selectedIndex]; return o ? o.textContent : ''; }

function enhance(se) {
  if (se._gs || se.multiple || se.size > 1 || se.closest('.gs-off')) return;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'gs-btn';
  btn.innerHTML = `<span class="gs-txt"></span><i class="gs-car">${icon('chev')}</i>`;
  se.classList.add('gs-native'); se.tabIndex = -1;
  se.after(btn);
  const txt = btn.firstElementChild;
  se._gs = () => { txt.textContent = label(se); btn.disabled = se.disabled; btn.title = se.title || (se.closest('[title]') || {}).title || ''; };
  se._gs();
  se.addEventListener('change', se._gs);
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (popSel === se) close(); else open(se, btn); });
  const fld = se.closest('.field');
  if (fld) fld.addEventListener('click', (e) => { if (e.target !== btn && !btn.contains(e.target) && !btn.disabled) { e.preventDefault(); btn.click(); } });
  btn.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) && popSel !== se) { e.preventDefault(); open(se, btn); }
  });
}

function choose(se, i) {
  if (i < 0 || i >= se.options.length || se.options[i].disabled) return;
  const changed = se.selectedIndex !== i;
  se.selectedIndex = i;
  close();
  if (changed) { se.dispatchEvent(new Event('input', { bubbles: true })); se.dispatchEvent(new Event('change', { bubbles: true })); }
}

function open(se, btn) {
  close();
  popSel = se; btn.classList.add('open');
  pop = document.createElement('div');
  pop.className = 'glass gs-pop';
  let html = '';
  const opt = (o, i) => `<button type="button" class="gs-opt${i === se.selectedIndex ? ' on' : ''}" data-i="${i}"${o.disabled ? ' disabled' : ''}><span>${escape(o.textContent)}</span>${i === se.selectedIndex ? icon('check') : ''}</button>`;
  let i = 0;
  for (const ch of se.children) {
    if (ch.tagName === 'OPTGROUP') { html += `<div class="gs-grp">${escape(ch.label)}</div>`; for (const o of ch.children) html += opt(o, i++); }
    else if (ch.tagName === 'OPTION') html += opt(ch, i++);
  }
  pop.innerHTML = html;
  document.body.appendChild(pop);
  // place under the button (or above it when there is no room), at least as wide as the button
  const r = btn.getBoundingClientRect(), field = btn.closest('.field') || btn, fr = field.getBoundingClientRect();
  pop.style.minWidth = Math.max(fr.width, 150) + 'px';
  const h = Math.min(pop.scrollHeight, 340), below = innerHeight - r.bottom - 12, up = below < Math.min(h, 220) && r.top > below;
  pop.style.maxHeight = Math.max(120, Math.min(340, up ? r.top - 16 : below)) + 'px';
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, fr.left)) + 'px';
  if (up) { pop.style.bottom = (innerHeight - fr.top + 6) + 'px'; pop.classList.add('up'); } else pop.style.top = (fr.bottom + 6) + 'px';
  active = se.selectedIndex;
  const cur = pop.querySelector('.gs-opt.on'); if (cur) cur.scrollIntoView({ block: 'nearest' });
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  pop.addEventListener('click', (e) => { const b = e.target.closest('.gs-opt'); if (b && !b.disabled) choose(se, +b.dataset.i); });
  pop.addEventListener('pointermove', (e) => { const b = e.target.closest('.gs-opt'); if (b) mark(+b.dataset.i, false); });
}
function mark(i, scroll = true) {
  if (!pop) return;
  active = i;
  pop.querySelectorAll('.gs-opt').forEach((b) => b.classList.toggle('hot', +b.dataset.i === i));
  const b = pop.querySelector(`.gs-opt[data-i="${i}"]`); if (b && scroll) b.scrollIntoView({ block: 'nearest' });
}
function close() {
  if (pop) { pop.remove(); pop = null; }
  if (popSel) { const b = popSel.nextElementSibling; if (b && b.classList.contains('gs-btn')) b.classList.remove('open'); }
  popSel = null;
}
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function startSelects(root = document.body) {
  root.querySelectorAll('select').forEach(enhance);
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.tagName === 'SELECT') enhance(n); else if (n.querySelector) n.querySelectorAll('select').forEach(enhance);
      if (popSel && !popSel.isConnected) close(); // the panel was rebuilt under an open list
    }
  }).observe(root, { childList: true, subtree: true });
  // a press on the list itself must NOT close it here — the click that follows is what picks the option
  addEventListener('pointerdown', (e) => { if (pop && !e.target.closest('.gs-btn, .gs-pop')) close(); }, true);
  addEventListener('resize', close);
  addEventListener('wheel', (e) => { if (pop && !pop.contains(e.target)) close(); }, { passive: true, capture: true });
  addEventListener('keydown', (e) => {
    if (!pop || !popSel) return;
    const n = popSel.options.length;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      let i = active; do { i = (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; } while (popSel.options[i].disabled && i !== active);
      mark(i);
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); choose(popSel, active); }
    else if (e.key.length === 1) { // type a letter → jump to the first option starting with it
      const k = e.key.toLowerCase(), opts = [...popSel.options];
      const j = opts.findIndex((o, i) => i > active && o.textContent.trim().toLowerCase().startsWith(k));
      const f = j >= 0 ? j : opts.findIndex((o) => o.textContent.trim().toLowerCase().startsWith(k));
      if (f >= 0) mark(f);
    }
  }, true);
}
