/* J.Law Notepad — offline-first. Local data lives in IndexedDB; cloud sync is optional & non-blocking. */
(() => {
'use strict';
const CFG = Object.assign({ SUPABASE_URL:'', SUPABASE_ANON_KEY:'', TABLE:'notepad_data', ROW_ID:'main', POLL_MS:30000 }, window.APP_CONFIG || {});
const CLOUD = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const THEME_KEY = 'notepad_theme_v1', LEGACY_KEY = 'notepad_data_v1';
const S = { notes: [], folders: [], deleted: {}, activeFolderId: 'all', activeNoteId: null, theme: 'dark' };

const editor = $('editor'), titleEl = $('noteTitle'), listEl = $('notesList'), searchEl = $('noteSearch');
const isMobile = () => matchMedia('(max-width:1023px)').matches;
const nowISO = () => new Date().toISOString();
const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const activeNote = () => S.notes.find((n) => n.id === S.activeNoteId);

/* ---------- Storage: IndexedDB (falls back to localStorage) ---------- */
let _db;
const idb = () => _db || (_db = new Promise((res, rej) => {
  try { const r = indexedDB.open('jl-notepad', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }));
async function kvGet(k) {
  try { const db = await idb(); return await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  catch (e) { try { const s = localStorage.getItem('jl:' + k); return s ? JSON.parse(s) : undefined; } catch (_) { return undefined; } }
}
async function kvSet(k, v) {
  try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); }); return true; }
  catch (e) { try { localStorage.setItem('jl:' + k, JSON.stringify(v)); return true; } catch (_) { return false; } }
}
const snapshot = () => ({ v: 2, notes: S.notes, folders: S.folders, deleted: S.deleted, activeFolderId: S.activeFolderId, activeNoteId: S.activeNoteId });
const cloudPayload = () => ({ notes: S.notes, folders: S.folders, deleted: S.deleted });   // 主題/UI 狀態不上雲

function normalize(o) {
  o = o || {};
  S.notes = (Array.isArray(o.notes) ? o.notes : []).filter((n) => n && n.id).map((n) => ({
    id: n.id, title: n.title || '無標題', content: n.content || '', pinned: !!n.pinned, folderId: n.folderId || null, lastSaved: n.lastSaved || nowISO() }));
  S.folders = Array.isArray(o.folders) ? o.folders.filter((f) => f && f.id) : [];
  S.deleted = o.deleted && typeof o.deleted === 'object' ? o.deleted : {};
  const ids = new Set(S.folders.map((f) => f.id));
  S.notes.forEach((n) => { if (n.folderId && !ids.has(n.folderId)) n.folderId = null; });
  S.activeFolderId = o.activeFolderId || 'all';
  if (S.activeFolderId !== 'all' && S.activeFolderId !== 'uncategorized' && !ids.has(S.activeFolderId)) S.activeFolderId = 'all';
  S.activeNoteId = o.activeNoteId || null;
}

/* ---------- Sanitizer (cloud / import / paste are untrusted) ---------- */
function sanitize(html) {
  const t = document.createElement('template'); t.innerHTML = html || '';
  const f = t.content;
  f.querySelectorAll('script,style,iframe,object,embed,link,meta,form,base,noscript,svg').forEach((e) => e.remove());
  f.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || (n === 'contenteditable' && !el.matches('.checklist-item,.checklist-text'))) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'src') && /^\s*(javascript|vbscript):/i.test(a.value)) el.removeAttribute(a.name);
    }
    if (el.tagName === 'A') { el.target = '_blank'; el.rel = 'noopener noreferrer'; }
  });
  return f;
}

/* ---------- Toast ---------- */
function toast(msg, o = {}) {
  const box = $('toasts');
  while (box.children.length >= 3) box.firstChild.remove();
  const el = document.createElement('div');
  el.className = 'toast glass ' + (o.type || 'info');
  const ic = document.createElement('i'); ic.textContent = o.type === 'error' ? '✕' : o.type === 'success' ? '✓' : 'i';
  const sp = document.createElement('span'); sp.textContent = msg;
  el.append(ic, sp);
  let timer; const kill = () => { clearTimeout(timer); if (!el.isConnected) return; el.classList.remove('show'); el.classList.add('hide'); setTimeout(() => el.remove(), 380); };
  if (o.action) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn primary'; b.textContent = o.action.label; b.onclick = () => { o.action.fn(); kill(); }; el.append(b); }
  box.append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  timer = setTimeout(kill, o.duration || (o.action ? 5000 : 2800));
  return { dismiss: kill };
}

/* ---------- Overlay + dialog (replaces alert/confirm/prompt) ---------- */
const openOv = (el) => { el.classList.add('open'); };
const closeOv = (el) => { el.classList.remove('open'); };
let dlgDone = null;
function dialog(o) {
  closeSheets();
  return new Promise((resolve) => {
    $('dlgTitle').textContent = o.title || '';
    const m = $('dlgMsg'); m.textContent = o.message || ''; m.classList.toggle('hidden', !o.message);
    const inp = $('dlgInput'); inp.classList.toggle('hidden', !o.input);
    inp.value = o.value || ''; inp.placeholder = o.placeholder || ''; inp.type = o.inputType || 'text';
    const ch = $('dlgChoices'); ch.innerHTML = '';
    const close = (v) => { dlgDone = null; closeOv($('dlg')); resolve(v); };
    (o.choices || []).forEach((c) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (c.danger ? ' danger' : ''); b.textContent = c.label; b.onclick = () => close(c.value); ch.append(b); });
    const act = $('dlgActions'); act.innerHTML = '';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn ghost'; cancel.textContent = o.cancel || '取消';
    cancel.onclick = () => close(o.input ? null : o.choices ? null : false);
    act.append(cancel);
    if (!o.choices) { const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'btn ' + (o.danger ? 'danger' : 'primary'); ok.textContent = o.ok || '確定';
      ok.onclick = () => close(o.input ? inp.value : true); act.append(ok);
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } }; }
    dlgDone = () => cancel.click();
    openOv($('dlg'));
    if (o.input) setTimeout(() => { inp.focus(); inp.select(); }, 120);
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('dlg').classList.contains('open') && dlgDone) dlgDone();
  else if ($('findModal').classList.contains('open')) closeOv($('findModal'));
  else closeSheets();
});
$('dlg').addEventListener('click', (e) => { if (e.target === $('dlg') && dlgDone) dlgDone(); });
$('findModal').addEventListener('click', (e) => { if (e.target === $('findModal')) closeOv($('findModal')); });

/* ---------- Sheet ---------- */
function openSheet() { $('sheetBackdrop').classList.add('open'); $('sheet').classList.add('open'); }
function closeSheets() { $('sheetBackdrop').classList.remove('open'); $('sheet').classList.remove('open'); }
$('sheetBackdrop').addEventListener('click', closeSheets);

/* ---------- Theme ---------- */
function applyTheme() {
  const light = S.theme === 'light';
  document.documentElement.classList.toggle('light', light);
  $('btnTheme').textContent = light ? '☀️' : '🌙';
  document.querySelector('meta[name=theme-color]').content = light ? '#eef2ff' : '#070b1a';
}
function toggleTheme() { S.theme = S.theme === 'dark' ? 'light' : 'dark'; try { localStorage.setItem(THEME_KEY, S.theme); } catch (_) {} applyTheme(); }

/* ---------- Views (mobile slide / desktop split) ---------- */
function setMode(m) {
  document.body.classList.toggle('mode-editor', m === 'editor');
  document.body.classList.toggle('mode-list', m !== 'editor');
  hideImgOverlay(); closeSheets();
}
function showList() {
  commit();
  if (isMobile() && history.state && history.state.ed) history.back(); else setMode('list');
}
function showEditor() {
  if (isMobile() && !(history.state && history.state.ed)) history.pushState({ ed: 1 }, '');
  setMode('editor');
}
window.addEventListener('popstate', () => { if (document.body.classList.contains('mode-editor')) { commit(); setMode('list'); } });

/* ---------- Status ---------- */
const setStatus = (t) => { $('saveStatus').textContent = t; };
const savedLabel = () => (!CLOUD ? '已儲存於本機' : navigator.onLine ? '已儲存' : '已儲存（離線）');

/* ---------- Persist ---------- */
let dirty = false, dirtyVer = 0, saveT, syncT;
function persist() {
  dirty = true; dirtyVer++;
  clearTimeout(saveT); saveT = setTimeout(flushLocal, 400);
  if (CLOUD) { clearTimeout(syncT); syncT = setTimeout(syncNow, 2500); }
}
async function flushLocal() { clearTimeout(saveT); const ok = await kvSet('state', snapshot()); setStatus(ok ? savedLabel() : '⚠ 本機儲存失敗（空間不足？）'); if (!ok) toast('本機儲存失敗，請先匯出備份', { type: 'error' }); }

/* ---------- Editor state ---------- */
let loaded = { id: null, title: '', html: '' };
function loadActive() {
  const n = activeNote(); if (!n) return;
  titleEl.value = n.title || '';
  editor.replaceChildren(sanitize(n.content));
  editor.querySelectorAll('.checklist-item').forEach((it) => { const cb = it.querySelector('input'); if (cb) { cb.checked = cb.checked || it.classList.contains('checked'); it.classList.toggle('checked', cb.checked); } });
  loaded = { id: n.id, title: titleEl.value, html: editor.innerHTML };
  countChars(); hideImgOverlay();
}
function commit() {         // editor → state (only bumps timestamp when really changed)
  const n = activeNote(); if (!n || loaded.id !== n.id) return false;
  const html = editor.innerHTML, title = titleEl.value;
  if (html === loaded.html && title === loaded.title) return false;
  n.title = title.trim() || '無標題'; n.content = html; n.lastSaved = nowISO();
  loaded = { id: n.id, title, html }; plainCache.delete(n.id);
  return true;
}
let inputT;
function onInput() {
  countChars(); setStatus('儲存中…');
  clearTimeout(inputT);
  inputT = setTimeout(() => { if (commit()) { persist(); renderList(); } else setStatus(savedLabel()); }, 450);
}
function countChars() { $('charCount').textContent = '字數: ' + (editor.textContent || '').replace(/\s+/g, '').length; }
editor.addEventListener('input', onInput);
titleEl.addEventListener('input', onInput);
titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); editor.focus(); } });

/* ---------- List / folders ---------- */
const plainCache = new Map();
function plain(n) {
  const k = n.lastSaved + '|' + n.content.length, c = plainCache.get(n.id);
  if (c && c.k === k) return c.t;
  const t = document.createElement('template'); t.innerHTML = n.content;
  const s = (t.content.textContent || '').replace(/\s+/g, ' ').trim();
  plainCache.set(n.id, { k, t: s }); return s;
}
function fmtDate(iso) {
  const d = new Date(iso), n = new Date(), p = (x) => String(x).padStart(2, '0');
  return d.toDateString() === n.toDateString() ? p(d.getHours()) + ':' + p(d.getMinutes()) : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function renderFolders() {
  const cnt = { all: S.notes.length, uncategorized: 0 }; S.folders.forEach((f) => (cnt[f.id] = 0));
  S.notes.forEach((n) => { if (n.folderId) cnt[n.folderId]++; else cnt.uncategorized++; });
  const item = (id, label, extra = '') => `<button type="button" class="pill-item${S.activeFolderId === id ? ' active' : ''}" data-fid="${esc(id)}">${esc(label)} <small>${cnt[id] || 0}</small>${S.activeFolderId === id ? extra : ''}</button>`;
  const tools = '<span class="x" data-fa="rename">✎</span><span class="x" data-fa="delete">×</span>';
  $('folderItems').innerHTML = item('all', '全部') + item('uncategorized', '未分類') + S.folders.map((f) => item(f.id, f.name, tools)).join('');
  requestAnimationFrame(moveThumb);
}
function moveThumb() {
  const a = $('folderItems').querySelector('.active'), th = $('folderThumb'); if (!a) return;
  th.style.width = a.offsetWidth + 'px'; th.style.transform = `translateX(${a.offsetLeft}px)`;
  const nav = $('folderNav'), l = a.offsetLeft - 12, r = a.offsetLeft + a.offsetWidth + 12;
  if (l < nav.scrollLeft) nav.scrollTo({ left: l, behavior: 'smooth' }); else if (r > nav.scrollLeft + nav.clientWidth) nav.scrollTo({ left: r - nav.clientWidth, behavior: 'smooth' });
}
function renderList() {
  renderFolders();
  const q = searchEl.value.trim().toLowerCase();
  const rows = S.notes.filter((n) => {
    if (S.activeFolderId === 'uncategorized' ? n.folderId : (S.activeFolderId !== 'all' && n.folderId !== S.activeFolderId)) return false;
    return !q || n.title.toLowerCase().includes(q) || plain(n).toLowerCase().includes(q);
  }).sort((a, b) => (b.pinned - a.pinned) || (a.lastSaved < b.lastSaved ? 1 : -1));
  if (!rows.length) { listEl.innerHTML = '<div class="empty">' + (q ? '找不到符合的筆記' : '尚無筆記') + '</div>'; return; }
  const fname = (id) => (S.folders.find((f) => f.id === id) || {}).name || '';
  listEl.innerHTML = rows.map((n) => {
    const p = plain(n); let snip = p.slice(0, 90);
    if (q) { const i = p.toLowerCase().indexOf(q); if (i >= 0) snip = (i > 12 ? '…' : '') + p.slice(Math.max(0, i - 12), i + q.length + 40); }
    return `<div class="note-card glass${n.id === S.activeNoteId ? ' active' : ''}" data-id="${esc(n.id)}">
      <div class="main"><div class="t">${n.pinned ? '📌 ' : ''}${esc(n.title)}</div>
      <div class="m">${n.folderId ? esc(fname(n.folderId)) + ' · ' : ''}${fmtDate(n.lastSaved)}</div>
      ${snip ? '<div class="p">' + esc(snip) + '</div>' : ''}</div>
      <div class="acts"><button type="button" class="btn ghost" data-a="pin" aria-label="置頂">${n.pinned ? '📌' : '📍'}</button><button type="button" class="btn ghost" data-a="del" aria-label="刪除">🗑</button></div></div>`;
  }).join('');
}
let listT; searchEl.addEventListener('input', () => { clearTimeout(listT); listT = setTimeout(renderList, 150); });
listEl.addEventListener('click', (e) => {
  const card = e.target.closest('.note-card'); if (!card) return;
  const id = card.dataset.id, a = e.target.closest('[data-a]');
  if (a && a.dataset.a === 'pin') return togglePin(id);
  if (a && a.dataset.a === 'del') return askDelete(id);
  openNote(id);
});
$('folderItems').addEventListener('click', (e) => {
  const fa = e.target.closest('[data-fa]'), b = e.target.closest('[data-fid]'); if (!b) return;
  const id = b.dataset.fid;
  if (fa) { e.stopPropagation(); return fa.dataset.fa === 'rename' ? renameFolder(id) : deleteFolder(id); }
  S.activeFolderId = id; renderList(); persist();
});

/* ---------- Folders ---------- */
async function createFolder() {
  const name = await dialog({ title: '新增資料夾', input: true, placeholder: '資料夾名稱', ok: '建立' });
  if (!name || !name.trim()) return;
  const f = { id: uid('folder'), name: name.trim(), createdAt: nowISO() };
  S.folders.push(f); S.activeFolderId = f.id; renderList(); persist(); toast('已建立「' + f.name + '」', { type: 'success' });
}
async function renameFolder(id) {
  const f = S.folders.find((x) => x.id === id); if (!f) return;
  const name = await dialog({ title: '重新命名', input: true, value: f.name });
  if (!name || !name.trim() || name.trim() === f.name) return;
  f.name = name.trim(); renderList(); persist(); toast('已重新命名', { type: 'success' });
}
async function deleteFolder(id) {
  const f = S.folders.find((x) => x.id === id); if (!f) return;
  if (!(await dialog({ title: '刪除資料夾？', message: '「' + f.name + '」內的筆記會移到「未分類」。', ok: '刪除', danger: true }))) return;
  const t = nowISO(); S.notes.forEach((n) => { if (n.folderId === id) { n.folderId = null; n.lastSaved = t; } });
  S.folders = S.folders.filter((x) => x.id !== id); S.deleted[id] = t;
  if (S.activeFolderId === id) S.activeFolderId = 'all';
  renderList(); persist(); toast('已刪除資料夾');
}
async function moveNote(id) {
  const n = S.notes.find((x) => x.id === id); if (!n) return;
  if (!S.folders.length) { if (await dialog({ title: '尚無資料夾', message: '要現在建立一個嗎？', ok: '建立' })) createFolder(); return; }
  const v = await dialog({ title: '移至資料夾', choices: [{ label: '未分類', value: '' }].concat(S.folders.map((f) => ({ label: f.name, value: f.id }))) });
  if (v === null) return;
  n.folderId = v || null; n.lastSaved = nowISO(); renderList(); persist(); toast('已移動', { type: 'success' });
}

/* ---------- Notes ---------- */
function openNote(id) {
  if (S.activeNoteId !== id) commit();
  S.activeNoteId = id; loadActive(); renderList(); showEditor();
}
function newNote(focus = true, silent = false) {
  commit();
  const f = S.activeFolderId;
  const n = { id: uid('note'), title: '新筆記', content: '', pinned: false, folderId: f !== 'all' && f !== 'uncategorized' ? f : null, lastSaved: nowISO() };
  searchEl.value = ''; S.notes.unshift(n); S.activeNoteId = n.id;
  loadActive(); renderList(); persist(); if (!silent) showEditor();
  if (focus) setTimeout(() => { titleEl.focus(); titleEl.select(); }, 360);
}
function togglePin(id) {
  const n = S.notes.find((x) => x.id === id); if (!n) return;
  n.pinned = !n.pinned; n.lastSaved = nowISO(); renderList(); persist(); toast(n.pinned ? '已置頂' : '已取消置頂', { type: 'success' });
}
let lastDeleted = null;
async function askDelete(id) {
  const n = S.notes.find((x) => x.id === id); if (!n) return;
  if (!(await dialog({ title: '刪除筆記？', message: '「' + n.title + '」刪除後可在數秒內復原。', ok: '刪除', danger: true }))) return;
  const i = S.notes.indexOf(n); lastDeleted = { n: JSON.parse(JSON.stringify(n)), i };
  S.notes.splice(i, 1); S.deleted[id] = nowISO();
  if (!S.notes.length) newNote(false, true);
  if (S.activeNoteId === id) { S.activeNoteId = S.notes[0] ? S.notes[0].id : null; if (S.activeNoteId) loadActive(); else { editor.replaceChildren(); titleEl.value = ''; loaded = { id: null, title: '', html: '' }; } if (isMobile()) showList(); }
  renderList(); persist();
  toast('已刪除', { action: { label: '復原', fn: undoDelete } });
}
function undoDelete() {
  if (!lastDeleted) return;
  const { n, i } = lastDeleted; lastDeleted = null;
  delete S.deleted[n.id]; n.lastSaved = nowISO();
  S.notes.splice(Math.min(i, S.notes.length), 0, n); S.activeNoteId = n.id; loadActive(); renderList(); persist(); toast('已復原', { type: 'success' });
}
async function clearNote() {
  if (!editor.textContent.trim() && !editor.querySelector('img')) return toast('內容已是空白');
  if (!(await dialog({ title: '清空內容？', message: '這則筆記的內文會被清空。', ok: '清空', danger: true }))) return;
  const prev = editor.innerHTML; editor.innerHTML = ''; onInput();
  toast('已清空', { action: { label: '復原', fn: () => { editor.innerHTML = prev; onInput(); } } });
}

/* ---------- Formatting ---------- */
function exec(cmd, val) { editor.focus(); document.execCommand(cmd, false, val); onInput(); }
function changeSize(d) { let c = parseInt(document.queryCommandValue('fontSize'), 10) || 3; exec('fontSize', Math.min(7, Math.max(1, c + d))); }
const checkHTML = (t) => '<div class="checklist-item" contenteditable="false"><input type="checkbox"><div class="checklist-text" contenteditable="true">' + (t || '') + '</div></div>';
function insertCheck() { editor.focus(); document.execCommand('insertHTML', false, checkHTML('') + '<div><br></div>'); setTimeout(() => { const t = editor.querySelectorAll('.checklist-text'); if (t.length) t[t.length - 1].focus(); }, 30); onInput(); }
let savedRange = null;
function saveSel() { const s = getSelection(); if (s && s.rangeCount) { const r = s.getRangeAt(0); if (editor.contains(r.commonAncestorContainer)) savedRange = r.cloneRange(); } }
function restoreSel() { if (savedRange && editor.contains(savedRange.commonAncestorContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); } }
async function insertLink() {
  saveSel();
  const url = await dialog({ title: '插入連結', input: true, inputType: 'url', placeholder: 'https://', ok: '插入' });
  if (!url || !url.trim()) return;
  editor.focus(); restoreSel();
  let u = url.trim(); if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  if (/^(javascript|vbscript):/i.test(u)) return toast('不支援的連結', { type: 'error' });
  exec('createLink', u);
}
const bar = $('formatBar');
bar.addEventListener('pointerdown', (e) => { if (!e.target.closest('.image-btn')) e.preventDefault(); else saveSel(); }); // keep selection & keyboard
bar.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.cmd) return exec(b.dataset.cmd, b.dataset.val);
  const a = b.dataset.act;
  if (a === 'size+') changeSize(1); else if (a === 'size-') changeSize(-1); else if (a === 'check') insertCheck(); else if (a === 'link') insertLink();
});
editor.addEventListener('change', (e) => { const cb = e.target; if (cb.matches && cb.matches('.checklist-item input')) {
  const it = cb.closest('.checklist-item'); it.classList.toggle('checked', cb.checked); cb.toggleAttribute('checked', cb.checked); onInput(); } });
editor.addEventListener('keydown', (e) => {
  const tx = e.target.closest && e.target.closest('.checklist-text'); if (!tx) return;
  const it = tx.closest('.checklist-item');
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = document.createElement('template'); t.innerHTML = checkHTML(''); const ni = t.content.firstElementChild; it.after(ni); ni.querySelector('.checklist-text').focus(); onInput(); }
  else if (e.key === 'Backspace' && !tx.textContent.length) { e.preventDefault(); const pv = it.previousElementSibling; it.remove(); const p = pv && pv.querySelector && pv.querySelector('.checklist-text'); (p || editor).focus(); onInput(); }
});

/* ---------- Paste / images ---------- */
editor.addEventListener('paste', (e) => {
  const cd = e.clipboardData; if (!cd) return;
  for (const it of cd.items) if (it.type.startsWith('image')) { e.preventDefault(); saveSel(); return addImage(it.getAsFile()); }
  e.preventDefault();
  const html = cd.getData('text/html'), text = cd.getData('text');
  if (html) {
    const f = sanitize(html), d = document.createElement('div'); d.append(f);
    const keep = new Set(['style', 'color', 'size', 'href', 'target', 'rel', 'src', 'alt', 'checked', 'type']);
    d.querySelectorAll('*').forEach((el) => [...el.attributes].forEach((a) => { if (!keep.has(a.name.toLowerCase())) el.removeAttribute(a.name); }));
    document.execCommand('insertHTML', false, d.innerHTML);
  } else if (/^https?:\/\/\S+$/i.test(text.trim())) document.execCommand('insertHTML', false, '<a href="' + esc(text.trim()) + '" target="_blank" rel="noopener noreferrer">' + esc(text.trim()) + '</a>');
  else document.execCommand('insertText', false, text);
  onInput();
});
$('imageUpload').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) addImage(f); setTimeout(() => (e.target.value = ''), 100); });
function addImage(file) {
  if (!file) return toast('讀取圖片失敗', { type: 'error' });
  const url = URL.createObjectURL(file), img = new Image();
  img.onerror = () => { URL.revokeObjectURL(url); toast('圖片格式不支援（請改用 JPG/PNG）', { type: 'error' }); };
  img.onload = () => {
    try {
      let w = img.naturalWidth, h = img.naturalHeight; const M = 1200;
      if (w > M || h > M) { if (w > h) { h = Math.round(h * M / w); w = M; } else { w = Math.round(w * M / h); h = M; } }
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
      const png = /png|webp|gif/i.test(file.type); if (!png) { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); }
      x.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
      const el = document.createElement('img'); el.src = png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.8); el.alt = 'image';
      insertNode(el); onInput(); toast('已插入圖片', { type: 'success' });
    } catch (err) { toast('圖片處理失敗', { type: 'error' }); }
  };
  img.src = url;
}
function insertNode(node) {
  const s = getSelection(); let r = null;
  if (s && s.rangeCount && editor.contains(s.getRangeAt(0).commonAncestorContainer)) r = s.getRangeAt(0).cloneRange();
  else if (savedRange && editor.contains(savedRange.commonAncestorContainer)) r = savedRange.cloneRange();
  if (!r) { r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); }
  editor.focus(); r.deleteContents(); r.insertNode(node);
  const a = document.createRange(); a.setStartAfter(node); a.collapse(true); s.removeAllRanges(); s.addRange(a); savedRange = a.cloneRange();
}
let selImg = null;
const ov = $('imgOverlay');
function hideImgOverlay() { if (selImg) selImg.classList.remove('selected'); selImg = null; ov.classList.remove('open'); }
editor.addEventListener('click', (e) => {
  const a = e.target.closest('a'); if (a && a.href) { e.preventDefault(); window.open(a.href, '_blank', 'noopener,noreferrer'); return; }
  if (e.target.tagName !== 'IMG') return hideImgOverlay();
  hideImgOverlay(); selImg = e.target; selImg.classList.add('selected');
  const box = $('editorContainer'), ir = selImg.getBoundingClientRect(), cr = box.getBoundingClientRect();
  let top = ir.top - cr.top + box.scrollTop - 46; if (ir.top - cr.top < 50) top = ir.bottom - cr.top + box.scrollTop + 6;
  ov.style.top = Math.max(0, top) + 'px'; ov.style.left = Math.max(4, Math.min(ir.left - cr.left, box.clientWidth - 300)) + 'px'; ov.classList.add('open');
});
document.addEventListener('click', (e) => { if (!editor.contains(e.target) && !ov.contains(e.target)) hideImgOverlay(); });
ov.addEventListener('click', (e) => { const b = e.target.closest('[data-size]'); if (b && selImg) { selImg.style.width = b.dataset.size; hideImgOverlay(); onInput(); } });
$('imgDel').addEventListener('click', () => { if (selImg) { selImg.remove(); hideImgOverlay(); onInput(); toast('已刪除圖片'); } });

/* ---------- Find & replace ---------- */
let findRange = null;
const textNodes = () => { const out = [], w = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) out.push(n); return out; };
function findNext() {
  const q = $('findInput').value.toLowerCase(); if (!q) return;
  const nodes = textNodes(); let started = !findRange;
  const hit = (node, from) => { const i = node.nodeValue.toLowerCase().indexOf(q, from); if (i < 0) return null; const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + q.length); return r; };
  let r = null;
  for (const node of nodes) {
    if (!started) { if (node === findRange.endContainer) { started = true; r = hit(node, findRange.endOffset); if (r) break; } continue; }
    r = hit(node, 0); if (r) break;
  }
  if (!r && findRange) for (const node of nodes) { r = hit(node, 0); if (r) break; }
  if (r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); findRange = r; try { r.startContainer.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} $('findResult').textContent = '找到'; }
  else { findRange = null; $('findResult').textContent = '查無結果'; }
}
function replaceOne() {
  const q = $('findInput').value, s = getSelection();
  if (q && s.rangeCount && s.toString().toLowerCase() === q.toLowerCase()) { document.execCommand('insertText', false, $('replaceInput').value); findRange = null; onInput(); }
  findNext();
}
function replaceAll() {
  const q = $('findInput').value, rep = $('replaceInput').value; if (!q) return;
  const low = q.toLowerCase(); let count = 0;
  textNodes().forEach((node) => {
    const t = node.nodeValue, l = t.toLowerCase(); if (!l.includes(low)) return;
    let out = '', pos = 0, i; while ((i = l.indexOf(low, pos)) !== -1) { out += t.slice(pos, i) + rep; pos = i + q.length; count++; }
    node.nodeValue = out + t.slice(pos);
  });
  findRange = null; if (count) onInput();
  $('findResult').textContent = count ? '已取代 ' + count + ' 處' : '查無結果'; toast(count ? '已取代 ' + count + ' 處' : '查無結果', { type: count ? 'success' : 'info' });
}
const openFind = () => { closeSheets(); openOv($('findModal')); setTimeout(() => $('findInput').focus(), 120); };
$('findNext').onclick = findNext; $('findRep').onclick = replaceOne; $('findAll').onclick = replaceAll; $('findClose').onclick = () => closeOv($('findModal'));

/* ---------- Export / import ---------- */
function download(name, blob) { const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); }
const stamp = () => new Date().toISOString().slice(0, 10);
const safeName = (s) => (s || 'note').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
async function openExport() {
  const v = await dialog({ title: '匯出', choices: [{ label: '全部筆記 JSON 備份', value: 'json' }, { label: '目前筆記 PDF', value: 'pdf' }, { label: '目前筆記 HTML（單檔）', value: 'html' }] });
  if (v === 'json') { commit(); download('notepad_' + stamp() + '.json', new Blob([JSON.stringify({ version: 2, exportDate: nowISO(), notes: S.notes, folders: S.folders, activeFolderId: S.activeFolderId }, null, 2)], { type: 'application/json' })); toast('已匯出 JSON', { type: 'success' }); }
  else if (v === 'html') exportHTML(); else if (v === 'pdf') exportPDF();
}
function exportHTML() {
  commit(); const n = activeNote(); if (!n) return;
  const doc = '<!DOCTYPE html><html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(n.title) + '</title><style>body{font:16px/1.75 system-ui,-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1b2140}img{max-width:100%;height:auto}.checklist-item{display:flex;gap:.5rem}.checked .checklist-text{text-decoration:line-through;opacity:.5}</style></head><body><h1>' + esc(n.title) + '</h1>' + n.content + '</body></html>';
  download(safeName(n.title) + '.html', new Blob([doc], { type: 'text/html;charset=utf-8' })); toast('已匯出 HTML', { type: 'success' });
}
const loaders = {};
const loadScript = (src) => loaders[src] || (loaders[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { delete loaders[src]; rej(new Error(src)); }; document.head.append(s); }));
async function exportPDF() {          // html2canvas 轉圖 → 支援中文，不依賴內建字型
  commit(); const n = activeNote(); if (!n) return;
  if (!editor.textContent.trim() && !editor.querySelector('img')) return toast('沒有內容可匯出');
  const t = toast('產生 PDF…', { duration: 20000 });
  const page = document.createElement('div');
  page.style.cssText = 'position:fixed;left:-10000px;top:0;width:720px;padding:40px;background:#fff;color:#111;font:16px/1.75 system-ui,-apple-system,"PingFang TC","Microsoft JhengHei","Noto Sans TC",sans-serif;word-break:break-word';
  const h = document.createElement('h1'); h.textContent = n.title; h.style.cssText = 'font-size:26px;margin:0 0 18px'; page.append(h);
  const body = document.createElement('div'); body.append(sanitize(n.content)); page.append(body);
  page.querySelectorAll('img').forEach((i) => (i.style.maxWidth = '100%')); page.querySelectorAll('a').forEach((a) => (a.style.color = '#2563eb'));
  document.body.append(page);
  try {
    await Promise.all([loadScript('./vendor/html2canvas.min.js'), loadScript('./vendor/jspdf.umd.min.js')]);
    const canvas = await window.html2canvas(page, { scale: 2, backgroundColor: '#fff', useCORS: true });
    const { jsPDF } = window.jspdf, pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const pw = 210, ph = 297, sliceH = Math.floor(canvas.width * ph / pw);
    for (let y = 0, i = 0; y < canvas.height; y += sliceH, i++) {
      const hh = Math.min(sliceH, canvas.height - y), c = document.createElement('canvas'); c.width = canvas.width; c.height = hh;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, hh); x.drawImage(canvas, 0, y, canvas.width, hh, 0, 0, canvas.width, hh);
      if (i) pdf.addPage(); pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, hh * pw / canvas.width);
    }
    pdf.save(safeName(n.title) + '.pdf'); t.dismiss(); toast('PDF 已下載', { type: 'success' });
  } catch (e) { t.dismiss(); toast('PDF 產生失敗', { type: 'error' }); } finally { page.remove(); }
}
$('fileImport').addEventListener('change', (e) => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  const r = new FileReader(); r.onerror = () => toast('讀取失敗', { type: 'error' });
  r.onload = async () => {
    let d; try { d = JSON.parse(r.result); } catch (_) { return toast('匯入失敗：不是有效的 JSON', { type: 'error' }); }
    if (!d || !Array.isArray(d.notes)) return toast('格式不符', { type: 'error' });
    let mode = 'overwrite';
    if (S.notes.length) {
      mode = await dialog({ title: '匯入 ' + d.notes.length + ' 則筆記', message: '目前有 ' + S.notes.length + ' 則筆記。', choices: [{ label: '合併（保留兩邊）', value: 'merge' }, { label: '覆蓋全部', value: 'overwrite', danger: true }] });
      if (!mode) return toast('已取消');
    }
    const inc = d.notes.filter((n) => n && n.id).map((n) => Object.assign({}, n, { lastSaved: nowISO() }));
    if (mode === 'overwrite') { S.notes.forEach((n) => (S.deleted[n.id] = nowISO())); S.notes = inc; if (Array.isArray(d.folders)) S.folders = d.folders; }
    else { const m = new Map(S.notes.map((n) => [n.id, n])); inc.forEach((n) => { m.set(n.id, n); delete S.deleted[n.id]; }); S.notes = [...m.values()];
      if (Array.isArray(d.folders)) { const fm = new Map(S.folders.map((f) => [f.id, f])); d.folders.forEach((f) => f && f.id && fm.set(f.id, f)); S.folders = [...fm.values()]; } }
    inc.forEach((n) => delete S.deleted[n.id]);
    normalize(snapshot()); S.activeNoteId = S.notes[0] && S.notes[0].id; plainCache.clear(); renderAll(); persist(); toast(mode === 'merge' ? '已合併匯入' : '已覆蓋匯入', { type: 'success' });
  };
  r.readAsText(file, 'UTF-8');
});

/* ---------- Cloud sync (REST, optional, never blocks UI) ---------- */
async function api(path, opts = {}) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(CFG.SUPABASE_URL + '/rest/v1/' + path, Object.assign({}, opts, { signal: ctl.signal, headers: Object.assign({ apikey: CFG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, opts.headers) }));
    if (!r.ok) throw new Error('HTTP ' + r.status); return r;
  } finally { clearTimeout(to); }
}
function mergeData(L, R) {
  R = R || {}; const rn = R.notes || [], rf = R.folders || [], rd = R.deleted || {};
  const del = Object.assign({}, rd); let push = false, changed = false;
  for (const k in L.deleted) if (!del[k] || del[k] < L.deleted[k]) { del[k] = L.deleted[k]; push = true; }
  for (const k in rd) if (!L.deleted[k] || L.deleted[k] < rd[k]) changed = true;
  const cutoff = new Date(Date.now() - 90 * 864e5).toISOString(); for (const k in del) if (del[k] < cutoff) delete del[k];
  const best = new Map(), take = (n) => { if (!n || !n.id) return; if (del[n.id] && del[n.id] >= n.lastSaved) return; const c = best.get(n.id); if (!c || n.lastSaved > c.lastSaved) best.set(n.id, n); };
  rn.forEach(take); L.notes.forEach(take);
  const rm = new Map(rn.map((n) => [n.id, n])), lm = new Map(L.notes.map((n) => [n.id, n]));
  for (const n of best.values()) { const r = rm.get(n.id), l = lm.get(n.id); if (!r || r.lastSaved < n.lastSaved) push = true; if (!l || l.lastSaved < n.lastSaved) changed = true; }
  for (const id of lm.keys()) if (!best.has(id)) changed = true;
  for (const id of rm.keys()) if (!best.has(id)) push = true;
  const fm = new Map(); rf.forEach((f) => f && f.id && !del[f.id] && fm.set(f.id, f)); L.folders.forEach((f) => !del[f.id] && fm.set(f.id, f));
  const lf = new Set(L.folders.map((f) => f.id)), rfs = new Set(rf.map((f) => f.id));
  for (const id of fm.keys()) { if (!rfs.has(id)) push = true; if (!lf.has(id)) changed = true; }
  for (const id of lf) if (!fm.has(id)) changed = true;
  return { data: { notes: [...best.values()], folders: [...fm.values()], deleted: del }, push, changed };
}
let syncing = false;
async function syncNow() {
  if (!CLOUD || !navigator.onLine || syncing) return;
  syncing = true; const v0 = dirtyVer;
  try {
    if (commit()) { persist(); }
    await flushLocal(); setStatus('同步中…');
    const rows = await (await api(CFG.TABLE + '?id=eq.' + encodeURIComponent(CFG.ROW_ID) + '&select=data,updated_at')).json();
    const row = rows[0], m = mergeData(cloudPayload(), row && row.data);
    if (m.changed) applyMerged(m.data);
    if (m.push || dirty || !row) await api(CFG.TABLE + '?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ id: CFG.ROW_ID, data: m.data, updated_at: nowISO() }) });
    if (dirtyVer === v0) dirty = false;
    setStatus('已同步 ' + new Date().toTimeString().slice(0, 5));
  } catch (e) { setStatus('已儲存於本機（尚未同步）'); }
  finally { syncing = false; }
}
function applyMerged(d) {
  const focused = document.activeElement === titleEl || editor.contains(document.activeElement);
  const cur = activeNote();
  S.notes = d.notes.map((n) => (focused && cur && n.id === cur.id ? cur : n)); S.folders = d.folders; S.deleted = d.deleted;
  const ids = new Set(S.folders.map((f) => f.id)); S.notes.forEach((n) => { if (n.folderId && !ids.has(n.folderId)) n.folderId = null; });
  if (S.activeFolderId !== 'all' && S.activeFolderId !== 'uncategorized' && !ids.has(S.activeFolderId)) S.activeFolderId = 'all';
  const before = S.activeNoteId, prev = cur && cur.lastSaved;
  if (!activeNote()) { S.activeNoteId = S.notes[0] ? S.notes[0].id : null; }
  const now = activeNote();
  if (!focused && now && (now.id !== before || now.lastSaved !== prev)) loadActive();
  renderList(); kvSet('state', snapshot()); toast('已同步其他裝置的更新');
}
if (CLOUD) {
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, CFG.POLL_MS);
  window.addEventListener('online', () => { setStatus('已連線，同步中…'); syncNow(); });
  window.addEventListener('focus', syncNow);
}
window.addEventListener('offline', () => setStatus(CLOUD ? '離線（資料保存在本機）' : savedLabel()));
const flushAll = () => { if (commit()) persist(); flushLocal(); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { flushAll(); if (CLOUD && dirty) syncNow(); } else syncNow(); });
window.addEventListener('pagehide', flushAll);

/* ---------- Keyboard-aware viewport (iOS) ---------- */
function setupViewport() {
  const root = document.documentElement, vv = window.visualViewport;
  const apply = () => { if (!vv) return; root.style.setProperty('--app-h', vv.height + 'px'); root.classList.toggle('kb', window.innerHeight - vv.height - vv.offsetTop > 80); if (vv.offsetTop) scrollTo(0, 0); setTimeout(moveThumb, 0); };
  if (vv) { vv.addEventListener('resize', apply); vv.addEventListener('scroll', apply); } addEventListener('resize', apply); apply();
}

/* ---------- Service worker ---------- */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => { const w = reg.installing; if (w) w.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) toast('有新版本可用', { action: { label: '重新整理', fn: () => location.reload() }, duration: 8000 }); }); });
  }).catch(() => {});
}

/* ---------- Wire up ---------- */
$('btnTheme').onclick = toggleTheme; $('btnNew').onclick = $('btnNewTop').onclick = () => newNote(true);
$('btnAddFolder').onclick = createFolder; $('btnBack').onclick = showList; $('btnFind').onclick = openFind; $('btnMore').onclick = openSheet;
$('sheet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sheet]'); if (!b) return; const a = b.dataset.sheet, id = S.activeNoteId;
  closeSheets();
  if (a === 'pin' && id) togglePin(id); else if (a === 'move' && id) moveNote(id); else if (a === 'export') openExport();
  else if (a === 'import') $('fileImport').click(); else if (a === 'clear') clearNote(); else if (a === 'delete' && id) askDelete(id);
});
function renderAll() {
  applyTheme();
  if (!S.notes.length) { newNote(false, true); setMode(isMobile() ? 'list' : 'editor'); return; }
  if (!activeNote()) S.activeNoteId = S.notes[0].id;
  renderList(); loadActive(); setMode(isMobile() ? 'list' : 'editor');
}
async function init() {
  try { S.theme = localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch (_) {}
  setupViewport(); registerSW();
  let raw = await kvGet('state');
  if (!raw) { try { raw = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'); } catch (_) {} }   // 舊版資料遷移
  normalize(raw); renderAll(); setStatus(savedLabel());
  if (!raw) flushLocal();
  syncNow();
}
init().catch((e) => { console.error(e); normalize(null); renderAll(); });
})();
