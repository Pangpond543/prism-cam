// i18n audit for Prism Cam: every Thai UI string must have an English entry in lang-en.js.
// usage: node i18n-audit.js <renderer dir>
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
const TH = /[฀-๿]/;
const src = fs.readFileSync(path.join(dir, 'js/lang-en.js'), 'utf8');
const EN = new Function(src.replace(/export const EN =/, 'return') )();
const found = new Map(); // key -> [where]
const loose = [];
const add = (k, w) => { if (!TH.test(k)) return; if (!found.has(k)) found.set(k, []); found.get(k).push(w); };

// scan a JS file: find T`...` templates (with nested ${...}), T('..'), tr('..'), and other Thai literals
function scanJs(file) {
  const s = fs.readFileSync(file, 'utf8'), name = path.basename(file);
  if (name === 'lang-en.js') return;
  let i = 0;
  const lineAt = (p) => s.slice(0, p).split('\n').length;
  // returns [parts[], endIndex] for a template starting at backtick index b
  function tpl(b) {
    const parts = []; let cur = ''; let j = b + 1;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') { cur += s[j] + s[j + 1]; j += 2; continue; }
      if (c === '`') { parts.push(cur); return [parts, j + 1]; }
      if (c === '$' && s[j + 1] === '{') { parts.push(cur); cur = ''; j = expr(j + 2); continue; }
      cur += c; j++;
    }
    return [parts, j];
  }
  function str(q, b) { let j = b + 1, out = ''; while (j < s.length && s[j] !== q) { if (s[j] === '\\') { out += s[j + 1]; j += 2; continue; } out += s[j++]; } return [out, j + 1]; }
  function expr(j) { // skip to matching }, recursing into strings/templates
    let depth = 1;
    while (j < s.length && depth) {
      const c = s[j];
      if (c === '`') { const tagged = /\bT\s*$/.test(s.slice(Math.max(0, j - 3), j)); const [p, e] = tpl(j); handleTpl(p, tagged, j); j = e; continue; }
      if (c === '"' || c === "'") { const [v, e] = str(c, j); handleStr(v, j); j = e; continue; }
      if (c === '{') depth++; else if (c === '}') depth--;
      j++;
    }
    return j;
  }
  function handleTpl(parts, tagged, at) {
    const key = parts.join('{}');
    if (tagged) add(key, `${name}:${lineAt(at)}`);
    else if (TH.test(key)) loose.push(`${name}:${lineAt(at)}  untagged template: ${key.slice(0, 90)}`);
  }
  function handleStr(v, at) {
    if (!TH.test(v)) return;
    const before = s.slice(Math.max(0, at - 6), at);
    if (/\b(T|tr)\($/.test(before)) add(v, `${name}:${lineAt(at)}`);
    else loose.push(`${name}:${lineAt(at)}  plain string: ${v.slice(0, 90)}`);
  }
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2) + 2; continue; }
    if (c === '`') { const tagged = /\bT\s*$/.test(s.slice(Math.max(0, i - 3), i)); const [p, e] = tpl(i); handleTpl(p, tagged, i); i = e; continue; }
    if (c === '"' || c === "'") { const [v, e] = str(c, i); handleStr(v, i); i = e; continue; }
    i++;
  }
}
for (const f of fs.readdirSync(path.join(dir, 'js'))) if (f.endsWith('.js')) scanJs(path.join(dir, 'js', f));

// index.html: text nodes + title + placeholder/aria attributes
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
for (const m of html.matchAll(/>([^<>]+)</g)) { const k = m[1].trim(); if (k) add(k, 'index.html'); }
const attrs = {};
for (const m of html.matchAll(/\s([a-z-]+)="([^"]*[฀-๿][^"]*)"/g)) { (attrs[m[1]] ||= []).push(m[2]); if (m[1] === 'title') add(m[2], 'index.html title'); }

const missing = [...found].filter(([k]) => EN[k] === undefined);
const enThai = Object.entries(EN).filter(([, v]) => TH.test(v.replace(/ภาษา/g, '')));
console.log('Thai keys used:', found.size, ' EN entries:', Object.keys(EN).length);
console.log('\n=== MISSING English (' + missing.length + ') ===');
for (const [k, w] of missing) console.log(JSON.stringify(k), '  @', w.slice(0, 2).join(', '));
console.log('\n=== Thai text not passed through T/tr (' + loose.length + ') ===');
for (const l of loose) console.log(l);
console.log('\n=== HTML attributes with Thai (non-title are NOT translated by translateDom) ===');
for (const [a, v] of Object.entries(attrs)) if (a !== 'title') console.log(a, v);
console.log('\n=== English values still containing Thai ===');
for (const [k, v] of enThai) console.log(JSON.stringify(k), '->', JSON.stringify(v));
// placeholder-count mismatch
console.log('\n=== {} count mismatch ===');
for (const [k] of found) if (EN[k] !== undefined) { const a = (k.match(/\{\}/g) || []).length, b = (EN[k].match(/\{\d*\}/g) || []).length; if (a !== b) console.log(JSON.stringify(k), a, b); }
