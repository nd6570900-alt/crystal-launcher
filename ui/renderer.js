'use strict';
const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------ state ---- */
let versions = [];
let instances = [];
let current = null;
let cfg = {};
let safeRamMax = 16384;
let running = false;
let preparing = false;
let view = 'home';
let logBuf = '';
let logDirty = false;
let newVersion = '';
let newLoader = 'vanilla';
let renameTarget = null;
let deleteTarget = null;
let installing = false;
let installItem = null;
let homeType = 'all';
let discType = 'modpack';
let targetId = '';
let targetWorld = '';
let toastTimer = null;

const GREETINGS = [
  'Time to punch some trees', 'Ready to dig straight down', 'Another day, another creeper',
  'Your world is waiting', 'Let\'s build something great', 'Time to mine some diamonds'
];

/* ---------------------------------------------------------- errors ---- */
let errTimer = 0;
function reportErr(msg) {
  const b = document.getElementById('errbar');
  if (!b) return;
  b.textContent = 'Something went wrong: ' + String(msg).slice(0, 240);
  b.hidden = false;
  clearTimeout(errTimer);
  errTimer = setTimeout(() => { b.hidden = true; }, 9000);
}
function notice(msg) {
  const b = document.getElementById('errbar');
  if (!b) return;
  b.textContent = msg; b.hidden = false;
  clearTimeout(errTimer);
  errTimer = setTimeout(() => { b.hidden = true; }, 7000);
}
window.addEventListener('error', (e) => { console.error(e.error || e.message); reportErr(e.message); });
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); reportErr((e.reason && e.reason.message) || e.reason); });
async function safe(label, fn) {
  try { return await fn(); } catch (e) { console.error(label, e); reportErr(label + ': ' + ((e && e.message) || e)); return undefined; }
}

/* --------------------------------------------------------- helpers ---- */
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function svgUse(id, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', cls || 'i');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', '#' + id);
  s.appendChild(u);
  return s;
}
function cube(color) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'cube');
  s.style.color = color || '#9b8cf8';
  [['t', '12,2 21,7 12,12 3,7'], ['l', '3,7 12,12 12,22 3,17'], ['r', '21,7 12,12 12,22 21,17']].forEach(([c, pts]) => {
    const p = document.createElementNS(SVGNS, 'polygon');
    p.setAttribute('points', pts);
    p.setAttribute('class', c);
    p.setAttribute('fill', 'currentColor');
    s.appendChild(p);
  });
  return s;
}
const httpsOnly = (u) => (typeof u === 'string' && u.startsWith('https://')) ? u : '';
function img(src, alt) {
  const i = document.createElement('img');
  i.loading = 'lazy';
  i.referrerPolicy = 'no-referrer';
  i.alt = alt || '';
  i.src = src;
  i.onerror = () => i.remove();
  return i;
}
const fmtNum = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);
const fmtPlaytime = (sec) => { sec = sec || 0; return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`; };
const fmtShort = (sec) => { sec = sec || 0; const hrs = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); return hrs ? `${hrs}h ${m}m` : `${m}m`; };
const loaderName = (l) => !l || l === 'vanilla' ? 'Vanilla' : l === 'neoforge' ? 'NeoForge' : l.charAt(0).toUpperCase() + l.slice(1);
const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------------------------------------------------- window controls ---- */
if (/Windows/i.test(navigator.userAgent)) document.body.classList.add('native-wc');
$('btnMin').addEventListener('click', () => window.api.min());
$('btnMax').addEventListener('click', () => window.api.max());
$('btnClose').addEventListener('click', () => window.api.close());

function applyWinState(s) {
  const max = !!(s && (s.maximized || s.fullscreen));
  document.body.classList.toggle('maximized', max);
  const ico = $('icoMax');
  ico.innerHTML = max
    ? '<rect x="2.2" y="3.8" width="6" height="6" rx="1.2"/><path d="M4 3.8V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-.8"/>'
    : '<rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.4"/>';
  $('btnMax').title = max ? 'Restore' : 'Maximize';
}
window.api.onWinState(applyWinState);
window.api.winState().then(applyWinState).catch(() => {});
window.addEventListener('keydown', (e) => {
  if (e.key === 'F11') { e.preventDefault(); window.api.toggleFullscreen(); }
  if (e.key === 'Escape') closeModals();
});

/* -------------------------------------------------------- navigation ---- */
function go(name) {
  view = name;
  $('stage').classList.toggle('split', name === 'discover');
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + name));
  document.querySelectorAll('.nav[data-view]').forEach(n => n.classList.toggle('on', n.dataset.view === (name === 'manage' ? 'instances' : name)));
  if (name === 'console') flushLog();
  if (name === 'discover') loadDiscover($('hubSearch').value);
  if (name === 'home') refreshStats();
  if (name === 'changelog') markChangelogSeen();
  if (name === 'servers') loadServers();
}
document.querySelectorAll('.nav[data-view]').forEach(n => n.addEventListener('click', () => go(n.dataset.view)));
$('btnLogo').addEventListener('click', () => go('home'));
$('btnSettings').addEventListener('click', () => openSettings('general'));
$('btnBrowse').addEventListener('click', () => go('instances'));

/* ----------------------------------------------------------- modals ---- */
function openModal(id) {
  document.querySelectorAll('.modal').forEach(m => m.classList.toggle('open', m.id === id));
  $('overlay').classList.add('open');
}
function closeModals() {
  $('overlay').classList.remove('open');
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('open'));
}
$('overlay').addEventListener('mousedown', (e) => { if (e.target === $('overlay')) closeModals(); });
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModals));

/* ------------------------------------------------------------ splash ---- */
let splashBusy = false;
function playSplash() {
  const sp = $('splash');
  if (splashBusy) return;
  if (document.body.classList.contains('reduced')) { sp.hidden = true; return; }
  splashBusy = true;
  sp.hidden = false; sp.classList.remove('out', 'go');
  $('spText').textContent = 'Crystal Launcher ' + APP_VERSION.replace(/\.0$/, '');
  const word = $('spWord');
  word.style.maxWidth = 'none';
  word.style.setProperty('--w', Math.ceil($('spText').getBoundingClientRect().width + 6) + 'px');
  word.style.maxWidth = '';
  setTimeout(() => sp.classList.add('go'), 750);
  setTimeout(() => sp.classList.add('out'), 2350);
  setTimeout(() => { sp.hidden = true; splashBusy = false; }, 2850);
}
function skipSplash() { $('splash').hidden = true; }

/* -------------------------------------------------------------- boot ---- */
async function boot() {
  cfg = (await safe('Loading settings', () => window.api.getConfig())) || {};
  const totalMB = (await safe('Reading memory', () => window.api.getMemory())) || 8192;

  /* memory slider: capped to ~75% of this PC's real RAM */
  safeRamMax = Math.max(2048, Math.min(16384, Math.floor(totalMB * 0.75 / 512) * 512));
  $('ram').max = safeRamMax;
  $('ramMaxLabel').textContent = (safeRamMax / 1024) + ' GB';
  $('ramHint').textContent = `This PC has about ${Math.round(totalMB / 1024)} GB of RAM. The slider stops at ~75% of it so Windows keeps enough for itself.`;
  $('ram').value = Math.min(Math.max(cfg.ram || 3072, 1024), safeRamMax);
  updateRamLabel();

  $('username').value = cfg.username || '';
  $('w').value = cfg.width || 1280;
  $('h').value = cfg.height || 720;
  $('customRes').checked = !!cfg.customRes;
  $('perfMode').checked = cfg.effects === false;
  $('hwAccel').checked = cfg.hwAccel !== false;
  $('minLaunch').checked = !!cfg.minimizeOnLaunch;
  $('autoLaunch').checked = !!cfg.autoLaunch;
  $('noPlaytime').checked = !!cfg.disablePlaytime;
  document.body.classList.toggle('reduced', cfg.effects === false);
  $('javaPath').value = cfg.java || '';
  $('jvmArgs').value = cfg.jvmArgs || '';
  applyAppearance();
  updateGreeting();
  if (cfg.welcomed && cfg.effects !== false) playSplash(); else skipSplash();

  safe('Content hub', () => loadHubHome());
  safe('News', () => loadNews());
  safe('Stats', () => refreshStats());
  if (!cfg.welcomed) await safe('Welcome', () => openWelcome());
  else if (cfg.seenVersion !== APP_VERSION) $('navDot').hidden = false;

  try { versions = await window.api.versions(); } catch { versions = []; setStatus('Could not load the version list (offline?)'); }
  if (!Array.isArray(versions)) versions = [];
  await safe('Instances', () => loadInstances(true));
}

function updateGreeting() {
  const name = ($('username').value || 'Player').trim() || 'Player';
  if (!updateGreeting.phrase) updateGreeting.phrase = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  $('greetTitle').textContent = `${updateGreeting.phrase}, ${name}`;
  $('avatar').textContent = name.charAt(0).toUpperCase();
}

/* --------------------------------------------------------- instances ---- */
async function loadInstances(first) {
  instances = await window.api.listInstances();
  const keep = current && instances.find(i => i.id === current.id);
  current = keep || instances[0] || null;
  renderAll();
  if (first && !instances.length) openCreate();
}

function renderAll() {
  renderSide();
  renderInstList();
  renderInstGrid();
  updateQuick();
  $('tileInst').textContent = String(instances.length);
}

function selectInstance(id) {
  current = instances.find(i => i.id === id) || null;
  renderAll();
}

function renderSide() {
  const box = $('sideInst');
  box.textContent = '';
  instances.forEach(inst => {
    const b = h('button', 'si' + (current && current.id === inst.id ? ' on' : ''));
    b.type = 'button';
    b.title = inst.name;
    b.appendChild(cube(inst.color));
    b.addEventListener('click', () => { selectInstance(inst.id); go('home'); });
    box.appendChild(b);
  });
}

function renderInstList() {
  const box = $('instList');
  box.textContent = '';
  if (!instances.length) {
    const e = h('div', 'empty', 'No instances yet');
    const b = h('button', 'btn primary', 'Create your first instance');
    b.type = 'button';
    b.style.marginTop = '10px';
    b.addEventListener('click', openCreate);
    e.appendChild(h('br'));
    e.appendChild(b);
    box.appendChild(e);
    return;
  }
  instances.forEach((inst, idx) => {
    const r = h('button', 'irow' + (current && current.id === inst.id ? ' on' : ''));
    r.type = 'button';
    const ico = h('div', 'irow-ico'); ico.appendChild(cube(inst.color));
    const txt = h('div', 'irow-txt');
    const nm = h('div', 'irow-name');
    nm.appendChild(h('span', '', inst.name));
    nm.appendChild(h('span', 'pill', loaderName(inst.loader)));
    txt.appendChild(nm);
    txt.appendChild(h('div', 'irow-sub', `${inst.version} · ${fmtPlaytime(inst.playtimeSeconds)}`));
    r.appendChild(ico); r.appendChild(txt); r.appendChild(h('div', 'irow-n', '#' + (idx + 1)));
    r.addEventListener('click', () => selectInstance(inst.id));
    box.appendChild(r);
  });
}

function renderInstGrid() {
  const box = $('instGrid');
  box.textContent = '';
  $('instCount').textContent = instances.length === 1 ? '1 instance' : `${instances.length} instances`;
  instances.forEach(inst => {
    const c = h('div', 'icard' + (current && current.id === inst.id ? ' on' : ''));
    const top = h('div', 'icard-top');
    const ico = h('div', 'icard-ico'); ico.appendChild(cube(inst.color));
    const t = h('div', ''); t.style.minWidth = '0';
    t.appendChild(h('div', 'icard-name', inst.name));
    t.appendChild(h('div', 'icard-sub', `${inst.version} · ${loaderName(inst.loader)}`));
    top.appendChild(ico); top.appendChild(t);

    const meta = h('div', 'icard-meta');
    const m1 = h('span'); m1.append('Played ', h('b', '', fmtPlaytime(inst.playtimeSeconds)));
    const m2 = h('span'); m2.append('Last ', h('b', '', inst.lastPlayed ? fmtDate(inst.lastPlayed) : 'never'));
    meta.append(m1, m2);

    const act = h('div', 'icard-act');
    const play = h('button', 'btn primary'); play.type = 'button';
    play.append(svgUse('i-play'), 'Play');
    play.addEventListener('click', () => { selectInstance(inst.id); go('home'); startPlay(); });
    const man = h('button', 'btn'); man.type = 'button';
    man.append(svgUse('i-library'), 'Manage');
    man.addEventListener('click', () => openManage(inst));
    act.append(play, man);
    const act2 = h('div', 'icard-act two');
    const mk = (icon, title, cls, fn) => {
      const b = h('button', 'ibtn' + (cls ? ' ' + cls : '')); b.type = 'button'; b.title = title;
      b.appendChild(svgUse(icon)); b.addEventListener('click', fn); act2.appendChild(b);
    };
    mk('i-sliders', 'Instance settings', '', () => openIS(inst));
    mk('i-folder', 'Open folder', '', () => window.api.openInstanceFolder(inst.id));
    mk('i-copy', 'Duplicate', '', () => dupInstance(inst));
    mk('i-edit', 'Rename', '', () => openRename(inst));
    mk('i-trash', 'Delete', 'del', () => openDelete(inst));

    c.append(top, meta, act, act2);
    box.appendChild(c);
  });
  const add = h('button', 'icard icard-new'); add.type = 'button';
  add.append(svgUse('i-plus'), 'New instance');
  add.addEventListener('click', openCreate);
  box.appendChild(add);
}

function updateQuick() {
  const ico = $('quickIcon');
  ico.textContent = '';
  if (!current) {
    $('quickName').textContent = 'No instance';
    $('quickSub').textContent = 'Create one to start playing';
    ico.appendChild(cube('#4b4b57'));
    return;
  }
  $('quickName').textContent = current.name;
  $('quickSub').textContent = `${current.version} · ${loaderName(current.loader)}`;
  ico.appendChild(cube(current.color));
}

/* create */
function openCreate() {
  $('newName').value = '';
  $('newSearch').value = '';
  $('showSnaps').checked = false;
  newLoader = 'vanilla';
  document.querySelectorAll('#loaderChips .chip').forEach(c => c.classList.toggle('on', c.dataset.value === 'vanilla'));
  const firstRelease = versions.find(v => v.type === 'release');
  newVersion = firstRelease ? firstRelease.id : '';
  renderVersions();
  openModal('m-create');
  setTimeout(() => $('newName').focus(), 30);
}
function renderVersions() {
  const list = $('newVersionList');
  list.textContent = '';
  const needle = $('newSearch').value.trim().toLowerCase();
  const snaps = $('showSnaps').checked;
  const shown = versions.filter(v => (snaps || v.type === 'release') && (!needle || v.id.toLowerCase().includes(needle))).slice(0, 150);
  if (!shown.length) { list.appendChild(h('div', 'empty', versions.length ? 'No versions match' : 'Version list unavailable — check your internet')); return; }
  shown.forEach(v => {
    const b = h('button', 'vitem' + (v.id === newVersion ? ' on' : '')); b.type = 'button';
    b.appendChild(h('span', '', v.id));
    if (v.type !== 'release') b.appendChild(h('small', '', 'snapshot'));
    b.addEventListener('click', () => { newVersion = v.id; renderVersions(); });
    list.appendChild(b);
  });
}
document.querySelectorAll('#loaderChips .chip').forEach(c => c.addEventListener('click', () => {
  newLoader = c.dataset.value;
  document.querySelectorAll('#loaderChips .chip').forEach(x => x.classList.toggle('on', x === c));
}));
$('newSearch').addEventListener('input', renderVersions);
$('showSnaps').addEventListener('change', renderVersions);
$('btnAddInstance').addEventListener('click', openCreate);
$('btnNewInstance').addEventListener('click', openCreate);
$('btnCreate').addEventListener('click', async () => {
  if (!newVersion) return;
  const name = $('newName').value.trim() || newVersion;
  const inst = await window.api.createInstance({ name, version: newVersion, loader: newLoader });
  instances.push(inst);
  current = inst;
  closeModals();
  renderAll();
});
$('newName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnCreate').click(); });

/* rename */
function openRename(inst) {
  renameTarget = inst;
  $('renameInput').value = inst.name;
  openModal('m-rename');
  setTimeout(() => { $('renameInput').focus(); $('renameInput').select(); }, 30);
}
async function confirmRename() {
  const name = $('renameInput').value.trim();
  if (!renameTarget || !name) return closeModals();
  const updated = await window.api.renameInstance(renameTarget.id, name);
  if (updated) {
    const idx = instances.findIndex(i => i.id === updated.id);
    if (idx >= 0) instances[idx] = updated;
    if (current && current.id === updated.id) current = updated;
  }
  closeModals();
  renderAll();
}
$('btnConfirmRename').addEventListener('click', confirmRename);
$('renameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmRename(); });

/* delete */
function openDelete(inst) {
  deleteTarget = inst;
  $('deleteText').textContent = `"${inst.name}" and all of its saves, mods and worlds will be removed.`;
  openModal('m-delete');
}
$('btnConfirmDelete').addEventListener('click', async () => {
  if (!deleteTarget) return closeModals();
  await window.api.deleteInstance(deleteTarget.id);
  instances = instances.filter(i => i.id !== deleteTarget.id);
  if (current && current.id === deleteTarget.id) current = instances[0] || null;
  deleteTarget = null;
  closeModals();
  renderAll();
});


/* ------------------------------------------------ manage (mods etc.) ---- */
const MG_TYPES = [{ id: 'mod', label: 'Mods' }, { id: 'resourcepack', label: 'Resource packs' }, { id: 'shader', label: 'Shaders' }];
let mgInst = null, mgType = 'mod', mgItems = [], mgUpdates = {}, mgBusy = false, mgPending = null;
const fmtSize = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

function openManage(inst) {
  mgInst = inst; mgType = 'mod'; mgUpdates = {};
  $('mgTitle').textContent = inst.name;
  $('mgSub').textContent = `${inst.version} · ${loaderName(inst.loader)}`;
  $('mgSearch').value = '';
  buildChips($('mgChips'), MG_TYPES, () => mgType, (id) => { mgType = id; mgUpdates = {}; loadManage(); });
  go('manage');
  loadManage();
}
async function loadManage() {
  if (!mgInst) return;
  $('mgStatus').textContent = 'Loading…';
  $('mgUpdateAll').hidden = true;
  const res = await window.api.contentList({ instanceId: mgInst.id, type: mgType });
  if (!res || !res.ok) { mgItems = []; $('mgStatus').textContent = (res && res.error) || 'Could not read this folder.'; renderManage(); return; }
  mgItems = res.items;
  $('mgStatus').textContent = res.offline ? 'Offline: showing file names only.' : `${mgItems.length} item${mgItems.length === 1 ? '' : 's'}`;
  renderManage();
}
function renderManage() {
  const box = $('mgList');
  box.textContent = '';
  const q = $('mgSearch').value.trim().toLowerCase();
  const list = mgItems.filter(i => !q || (i.name + ' ' + i.file).toLowerCase().includes(q));
  if (!list.length) {
    box.appendChild(h('div', 'empty', mgItems.length ? 'Nothing matches.' : `No ${MG_TYPES.find(t => t.id === mgType).label.toLowerCase()} installed yet. Use Add more to find some.`));
  }
  list.forEach(it => {
    const row = h('div', 'mg-row' + (it.enabled ? '' : ' off'));
    const ico = h('div', 'mg-ico');
    const src = httpsOnly(it.icon);
    if (src) ico.appendChild(img(src, '')); else ico.textContent = (it.name || '?').charAt(0).toUpperCase();
    const tx = h('div', 'mg-txt');
    tx.appendChild(h('div', 'mg-name', it.name));
    tx.appendChild(h('div', 'mg-sub', [it.version, fmtSize(it.size)].filter(Boolean).join(' · ')));
    if (it.neededBy && it.neededBy.length) tx.appendChild(h('div', 'mg-need', 'Needed by ' + it.neededBy.slice(0, 3).join(', ') + (it.neededBy.length > 3 ? '…' : '')));
    const badge = h('span', 'mg-badge' + (it.source === 'modrinth' || it.projectId ? ' mr' : ''), it.projectId ? 'Modrinth' : 'Local');
    row.append(ico, tx, badge);
    const upd = mgUpdates[it.sha1];
    if (upd) {
      const b = h('button', 'btn primary', 'Update'); b.type = 'button'; b.title = upd.version || '';
      b.addEventListener('click', () => mgUpdateOne(it, upd));
      row.appendChild(b);
    }
    const sw = h('label', 'switch small'); sw.title = it.enabled ? 'Enabled' : 'Disabled';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = it.enabled;
    sw.append(cb, document.createElement('i'));
    cb.addEventListener('change', () => { cb.checked = it.enabled; mgToggle(it); });
    row.appendChild(sw);
    const del = h('button', 'ibtn del'); del.type = 'button'; del.title = 'Remove'; del.appendChild(svgUse('i-trash'));
    del.addEventListener('click', () => mgRemove(it));
    row.appendChild(del);
    box.appendChild(row);
  });
}
function mgAsk(title, text, label, fn) {
  $('mgcTitle').textContent = title; $('mgcText').textContent = text; $('btnMgConfirm').textContent = label;
  mgPending = fn; openModal('m-mgconfirm');
}
$('btnMgConfirm').addEventListener('click', () => { const f = mgPending; mgPending = null; closeModals(); if (f) f(); });
async function mgToggle(it) {
  const go_ = async () => {
    const r = await window.api.contentToggle({ instanceId: mgInst.id, type: mgType, file: it.file });
    if (!r || !r.ok) { $('mgStatus').textContent = (r && r.error) || 'Could not change that file.'; return; }
    await loadManage();
  };
  if (it.enabled && it.neededBy && it.neededBy.length) {
    mgAsk('Disable ' + it.name + '?', `${it.neededBy.join(', ')} needs it. The game may not start without it.`, 'Disable anyway', go_);
  } else go_();
}
function mgRemove(it) {
  const run = async () => {
    const r = await window.api.contentRemove({ instanceId: mgInst.id, type: mgType, file: it.file });
    if (!r || !r.ok) { $('mgStatus').textContent = (r && r.error) || 'Could not remove that file.'; return; }
    delete mgUpdates[it.sha1];
    await loadManage();
  };
  const need = it.neededBy && it.neededBy.length ? ` ${it.neededBy.join(', ')} needs it.` : '';
  mgAsk('Remove ' + it.name + '?', 'This deletes the file from this instance.' + need, 'Remove', run);
}
async function mgCheck() {
  if (mgBusy) return;
  const files = mgItems.filter(i => i.projectId).map(i => ({ sha1: i.sha1 }));
  if (!files.length) { $('mgStatus').textContent = 'Nothing here can be checked (no Modrinth files).'; return; }
  mgBusy = true; $('mgCheck').disabled = true; $('mgStatus').textContent = 'Checking…';
  const r = await window.api.contentUpdates({ instanceId: mgInst.id, type: mgType, files });
  mgBusy = false; $('mgCheck').disabled = false;
  if (!r || !r.ok) { $('mgStatus').textContent = (r && r.error) || 'Could not check for updates.'; return; }
  mgUpdates = r.updates || {};
  const n = Object.keys(mgUpdates).length;
  $('mgStatus').textContent = n ? `${n} update${n === 1 ? '' : 's'} available` : 'Everything is up to date';
  $('mgUpdateAll').hidden = !n;
  renderManage();
}
async function mgUpdateOne(it, upd) {
  if (mgBusy) return;
  mgBusy = true;
  $('mgStatus').textContent = 'Updating ' + it.name + '…';
  const r = await window.api.contentUpdate({ instanceId: mgInst.id, type: mgType, file: it.file, versionId: upd.versionId });
  mgBusy = false;
  if (!r || !r.ok) { $('mgStatus').textContent = (r && r.error) || 'Update failed.'; return false; }
  delete mgUpdates[it.sha1];
  return true;
}
async function mgUpdateAll() {
  const todo = mgItems.filter(i => mgUpdates[i.sha1]);
  let ok = 0;
  for (const it of todo) { if (await mgUpdateOne(it, mgUpdates[it.sha1])) ok++; else break; }
  await loadManage();
  $('mgStatus').textContent = `Updated ${ok} of ${todo.length}`;
  $('mgUpdateAll').hidden = !Object.keys(mgUpdates).length;
}
$('mgCheck').addEventListener('click', mgCheck);
$('mgUpdateAll').addEventListener('click', mgUpdateAll);
$('mgSearch').addEventListener('input', renderManage);
$('mgBack').addEventListener('click', () => go('instances'));
$('mgFolder').addEventListener('click', () => window.api.openInstanceFolder(mgInst.id));
$('mgMore').addEventListener('click', () => { discType = mgType; F.cats.clear(); loadDiscover.built = false; go('discover'); });

/* ------------------------------------------- instance settings etc. ---- */
let isTarget = null;
function openIS(inst) {
  isTarget = inst;
  const st = inst.settings || {};
  $('isTitle').textContent = inst.name + ' · settings';
  $('isRam').value = st.ram || '';
  $('isJava').value = st.java || '';
  $('isW').value = st.width || '';
  $('isH').value = st.height || '';
  $('isJvm').value = st.jvmArgs || '';
  $('isStatus').textContent = '';
  openModal('m-isettings');
}
$('btnSaveIS').addEventListener('click', async () => {
  if (!isTarget) return closeModals();
  const updated = await window.api.setInstanceSettings(isTarget.id, {
    ram: $('isRam').value, java: $('isJava').value, width: $('isW').value, height: $('isH').value, jvmArgs: $('isJvm').value
  });
  if (!updated) { $('isStatus').textContent = 'Could not save.'; return; }
  const idx = instances.findIndex(i => i.id === updated.id);
  if (idx >= 0) instances[idx] = updated;
  if (current && current.id === updated.id) current = updated;
  closeModals(); renderAll();
});
async function dupInstance(inst) {
  showToast('Duplicating ' + inst.name, 'Copying files…', '', null);
  const r = await window.api.copyInstance(inst.id);
  if (!r || !r.ok) { showToast('Duplicate failed', (r && r.error) || 'Unknown error', 'err', null, 8000); return; }
  instances = await window.api.listInstances();
  renderAll();
  showToast('Duplicated', r.instance.name + ' is ready', 'ok', null, 5000);
}
async function importPack() {
  if (installing) return;
  installing = true;
  installItem = { title: 'modpack file' };
  showToast('Importing modpack', 'Starting…', '', 8);
  let r;
  try { r = await window.api.importMrpack(); } catch (e) { r = { ok: false, error: e.message }; }
  installing = false; installItem = null;
  if (r && r.canceled) { $('toast').hidden = true; return; }
  if (!r || !r.ok) { showToast('Import failed', (r && r.error) || 'Unknown error', 'err', null, 9000); return; }
  instances = await window.api.listInstances();
  renderAll();
  showToast('Imported', `${r.instance.name} · ${r.mods} mods`, 'ok', null, 7000);
}
$('btnImportPack').addEventListener('click', importPack);

/* ------------------------------------------------------ content hub ---- */
function hubCard(item) {
  const c = h('button', 'hcard'); c.type = 'button';
  const banner = h('div', 'hbanner');
  const tint = item.color || '#3a3170';
  banner.style.background = `linear-gradient(135deg, ${tint}, #14141a)`;
  const bsrc = httpsOnly(item.banner) || httpsOnly(item.icon);
  if (bsrc) banner.appendChild(img(bsrc, ''));
  const icon = h('div', 'hicon');
  const isrc = httpsOnly(item.icon);
  if (isrc) icon.appendChild(img(isrc, '')); else icon.textContent = (item.title || '?').charAt(0).toUpperCase();
  banner.appendChild(icon);
  if (item.type) banner.appendChild(h('span', 'tbadge', TYPE_LABEL[item.type] || item.type));

  const body = h('div', 'hbody');
  body.appendChild(h('div', 'htitle', item.title));
  body.appendChild(h('div', 'hdesc', item.description));
  const foot = h('div', 'hfoot');
  foot.appendChild(h('span', '', 'by ' + (item.author || 'unknown')));
  const dl = h('span'); dl.append(svgUse('i-download'), fmtNum(item.downloads));
  foot.appendChild(dl);

  c.append(banner, body, foot);
  c.addEventListener('click', () => openInstall(item));
  return c;
}

const TYPES = [
  { id: 'all', label: 'All' }, { id: 'modpack', label: 'Modpacks' }, { id: 'mod', label: 'Mods' },
  { id: 'shader', label: 'Shaders' }, { id: 'resourcepack', label: 'Resource Packs' }, { id: 'datapack', label: 'Data Packs' }
];
const TYPE_LABEL = { modpack: 'Modpack', mod: 'Mod', shader: 'Shader', resourcepack: 'Resource pack', datapack: 'Data pack' };
const ONE_TYPES = ['modpack', 'mod', 'shader', 'resourcepack', 'datapack'];

/* a random starting point in Modrinth's popular list, so every open shows different things */
const randomOffset = (pageSize, pages) => Math.floor(Math.random() * (pages || 30)) * pageSize;
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function fetchHub(o) {
  const res = await window.api.hub(o);
  return res && res.ok ? res.items : null;
}

function buildChips(box, list, getCur, onPick) {
  box.textContent = '';
  list.forEach(t => {
    const b = h('button', 'tchip' + (t.id === getCur() ? ' on' : ''), t.label);
    b.type = 'button';
    b.addEventListener('click', () => { onPick(t.id); buildChips(box, list, getCur, onPick); });
    box.appendChild(b);
  });
}
buildChips($('homeChips'), TYPES, () => homeType, (id) => { homeType = id; loadHubHome(); });

async function loadHubHome() {
  const box = $('hubHome');
  box.textContent = '';
  for (let i = 0; i < 3; i++) box.appendChild(h('div', 'skel'));
  let items;
  if (homeType === 'all') {
    const parts = await Promise.all(ONE_TYPES.map(t => fetchHub({ type: t, limit: 4, index: 'downloads', offset: randomOffset(4, 20) })));
    const got = parts.filter(Boolean);
    items = got.length ? shuffle(got.flat()) : null;
  } else {
    items = await fetchHub({ type: homeType, limit: 12, index: 'downloads', offset: randomOffset(12) });
  }
  box.textContent = '';
  box.scrollLeft = 0;
  if (!items || !items.length) { box.appendChild(h('div', 'empty', discSource === 'curseforge' ? (hubErr || 'Could not reach CurseForge.') : 'Could not reach Modrinth — check your internet connection.')); return; }
  items.forEach(it => box.appendChild(hubCard(it)));
}
$('btnShuffle').addEventListener('click', loadHubHome);

/* filters (SKLauncher-style side panel) */
const F = { loaders: new Set(), cats: new Set(), version: '' };
const FTYPES = [['modpack', 'Modpack', 'i-pack'], ['mod', 'Mod', 'i-cube'], ['resourcepack', 'Resource Pack', 'i-image'], ['shader', 'Shader', 'i-sun'], ['datapack', 'Data Pack', 'i-archive']];
const FLOADERS = [['fabric', 'Fabric', 'i-fabric', '#e8d44d'], ['quilt', 'Quilt', 'i-quilt', '#b58cff'], ['forge', 'Forge', 'i-anvil', '#6aa3ff'], ['neoforge', 'NeoForge', 'i-neo', '#ff9a3d']];
const catCache = {};

function pill(label, icon, color, on, fn, cls) {
  const b = h('button', 'fpill' + (cls ? ' ' + cls : '') + (on ? ' on' : '')); b.type = 'button';
  if (icon) { const s = svgUse(icon); if (color) s.style.color = color; b.appendChild(s); }
  b.append(label);
  b.addEventListener('click', fn);
  return b;
}
function buildFilters() {
  const t = $('fTypes'); t.textContent = '';
  FTYPES.forEach(([id, label, icon]) => t.appendChild(pill(label, icon, '', discType === id, () => setDiscType(id))));
  $('fLoadersWrap').hidden = !(discType === 'mod' || discType === 'modpack');
  const l = $('fLoaders'); l.textContent = '';
  FLOADERS.forEach(([id, label, icon, color]) => l.appendChild(pill(label, icon, color, F.loaders.has(id), () => {
    F.loaders.has(id) ? F.loaders.delete(id) : F.loaders.add(id);
    buildFilters(); reloadDiscover();
  })));
  $('fVerText').textContent = F.version || 'Any Version';
  renderCats();
}
async function renderCats() {
  const box = $('fCats');
  const type = discType;
  if (!catCache[type]) {
    const r = await safe('Categories', () => window.api.categories(type));
    catCache[type] = (r && r.items) || [];
  }
  if (type !== discType) return;
  box.textContent = '';
  catCache[type].forEach(c => box.appendChild(pill(c.replace(/-/g, ' '), '', '', F.cats.has(c), () => {
    F.cats.has(c) ? F.cats.delete(c) : F.cats.add(c);
    renderCats(); reloadDiscover();
  }, 'cat')));
}
function setDiscType(id) {
  discType = id;
  F.cats.clear();
  if (id !== 'mod' && id !== 'modpack') F.loaders.clear();
  buildFilters();
  reloadDiscover();
}
let discSource = 'modrinth';
let hubErr = '';
const reloadDiscover = () => loadDiscover($('hubSearch').value);

/* game version dropdown */
function renderVerList() {
  const q = $('fVerSearch').value.trim().toLowerCase();
  const box = $('fVerList'); box.textContent = '';
  const mk = (id, label) => {
    const b = h('button', 'dd-item' + ((F.version || '') === id ? ' on' : ''), label); b.type = 'button';
    b.addEventListener('click', () => { F.version = id; $('fVerPanel').hidden = true; buildFilters(); reloadDiscover(); });
    box.appendChild(b);
  };
  if (!q) mk('', 'Any Version');
  versions.filter(v => v.type === 'release' && (!q || v.id.toLowerCase().includes(q))).slice(0, 120).forEach(v => mk(v.id, v.id));
}
$('fVerBtn').addEventListener('click', () => {
  const p = $('fVerPanel'); p.hidden = !p.hidden;
  if (!p.hidden) { $('fVerSearch').value = ''; renderVerList(); setTimeout(() => $('fVerSearch').focus(), 20); }
});
$('fVerSearch').addEventListener('input', renderVerList);
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#fVer')) $('fVerPanel').hidden = true; });
$('fClear').addEventListener('click', () => {
  F.version = ''; F.loaders.clear(); F.cats.clear(); $('matchInst').checked = false; $('hubSearch').value = '';
  buildFilters(); reloadDiscover();
});

async function loadDiscover(query) {
  const box = $('hubGrid');
  const q = (query || '').trim();
  loadDiscover.token = (loadDiscover.token || 0) + 1;
  const token = loadDiscover.token;
  if (!loadDiscover.built) { loadDiscover.built = true; buildFilters(); }

  /* "match my instance" only makes sense for things that go into an instance */
  const canMatch = discType !== 'modpack' && !!current;
  $('matchWrap').hidden = !canMatch;
  if (canMatch) $('matchLabel').textContent = `Only for ${current.name} (${current.version})`;
  const match = canMatch && $('matchInst').checked;
  const loaders = F.loaders.size ? [...F.loaders] : (match && current.loader && current.loader !== 'vanilla' ? [current.loader] : []);
  const filtered = !!(F.version || loaders.length || F.cats.size || match);

  box.textContent = '';
  for (let i = 0; i < 6; i++) box.appendChild(h('div', 'skel'));
  const hubFn = discSource === 'curseforge' ? (async (o) => { const r = await window.api.hubCurse(o); if (r && !r.ok) hubErr = r.error; return r && r.ok ? r.items : null; }) : fetchHub;
  hubErr = '';
  const items = await hubFn({
    type: discType, query: q, limit: 24, index: q ? 'relevance' : 'downloads',
    offset: (q || filtered) ? 0 : randomOffset(24, 20),
    mcVersion: F.version || (match ? current.version : ''), loaders, categories: [...F.cats]
  });
  if (token !== loadDiscover.token) return;
  box.textContent = '';
  if (!items) { box.appendChild(h('div', 'empty', 'Could not reach Modrinth — check your internet connection.')); return; }
  if (!items.length) { box.appendChild(h('div', 'empty', 'Nothing found. Try another search or clear some filters.')); return; }
  items.forEach(it => box.appendChild(hubCard(it)));
}
$('hubSearch').addEventListener('input', debounce((e) => loadDiscover(e.target.value), 380));
$('matchInst').addEventListener('change', () => loadDiscover($('hubSearch').value));

/* ------------------------------------------------- install dialog ---- */
const NOTES = {
  modpack: 'This creates a new instance and downloads the pack\'s mods into it.',
  mod: 'Required mods (like Fabric API) are added automatically.',
  shader: 'Shaders need Iris (Fabric/Quilt) or OptiFine to work in game.',
  resourcepack: 'After installing, turn it on in Options → Resource Packs.',
  datapack: 'It is installed into the world you pick below.'
};

function showToast(title, status, kind, progress, keepMs) {
  const t = $('toast');
  clearTimeout(toastTimer);
  t.hidden = false;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  $('toastT').textContent = title;
  $('toastS').textContent = status;
  $('toastBarWrap').hidden = progress == null;
  if (progress != null) $('toastBar').style.width = progress + '%';
  if (keepMs) toastTimer = setTimeout(() => { t.hidden = true; }, keepMs);
}
$('toast').addEventListener('click', () => {
  if (installing) openModal('m-install');
  $('toast').hidden = true;
});
const installModalOpen = () => $('m-install').classList.contains('open') && $('overlay').classList.contains('open');

function compatible(inst, type) { return !(type === 'mod' && (!inst.loader || inst.loader === 'vanilla')); }

function renderTargets() {
  const box = $('instTargets');
  box.textContent = '';
  if (!instances.length) { box.appendChild(h('div', 'empty', 'Create an instance first.')); return; }
  instances.forEach(inst => {
    const ok = compatible(inst, installItem.type);
    const b = h('button', 'vitem' + (inst.id === targetId ? ' on' : '') + (ok ? '' : ' off')); b.type = 'button';
    b.appendChild(h('span', '', inst.name));
    b.appendChild(h('em', '', `${inst.version} · ${loaderName(inst.loader)}` + (ok ? '' : ' · no mods')));
    b.addEventListener('click', () => { targetId = inst.id; targetWorld = ''; renderTargets(); if (installItem.type === 'datapack') loadWorlds(); });
    box.appendChild(b);
  });
}
async function loadWorlds() {
  const box = $('worldList');
  box.textContent = '';
  const worlds = targetId ? await window.api.worlds(targetId) : [];
  if (!worlds.length) { box.appendChild(h('div', 'empty', 'No worlds in this instance yet. Play it once and create a world, then come back.')); return; }
  if (!worlds.includes(targetWorld)) targetWorld = worlds[0];
  worlds.forEach(w => {
    const b = h('button', 'vitem' + (w === targetWorld ? ' on' : '')); b.type = 'button';
    b.appendChild(h('span', '', w));
    b.addEventListener('click', () => { targetWorld = w; loadWorlds(); });
    box.appendChild(b);
  });
}

function openInstall(item) {
  if (installing) { showToast('Install in progress', 'Wait for the current install to finish (click to view).', '', null, 4000); return; }
  installItem = item;
  const isPack = item.type === 'modpack';
  $('instHead').textContent = 'Install ' + (TYPE_LABEL[item.type] || 'item').toLowerCase();
  const ico = $('instHeroIco');
  ico.textContent = '';
  const src = httpsOnly(item.icon);
  if (src) ico.appendChild(img(src, '')); else ico.textContent = (item.title || '?').charAt(0).toUpperCase();
  $('instTitle').textContent = item.title;
  $('instBy').textContent = `by ${item.author || 'unknown'} · ${fmtNum(item.downloads)} downloads`;
  $('instDesc').textContent = item.description;
  $('instNote').textContent = NOTES[item.type] || '';
  $('instNote').hidden = false;
  $('instBarWrap').hidden = true;
  $('instBlocked').hidden = true;
  $('instBar').style.width = '0%';
  const st = $('instStatus'); st.textContent = ''; st.className = 'status';
  $('btnInstallLabel').textContent = 'Install';
  $('btnInstall').disabled = false;
  delete $('btnInstall').dataset.done;
  $('instCancel').textContent = 'Cancel';
  $('instCancel').disabled = false;

  $('instTargetWrap').hidden = isPack;
  $('worldWrap').hidden = item.type !== 'datapack';
  if (!isPack) {
    const ok = current && compatible(current, item.type);
    targetId = ok ? current.id : ((instances.find(i => compatible(i, item.type)) || instances[0] || {}).id || '');
    targetWorld = '';
    renderTargets();
    if (item.type === 'datapack') loadWorlds();
    $('btnInstall').disabled = !instances.length;
  }
  openModal('m-install');
}

$('instCancel').addEventListener('click', () => {
  if (installing) {
    window.api.cancelInstall();
    $('instCancel').disabled = true;
    $('instStatus').textContent = 'Cancelling…';
  } else closeModals();
});

$('btnInstall').addEventListener('click', async () => {
  const btn = $('btnInstall');
  if (btn.dataset.done) {                        // finished: jump to the instance or just close
    const id = btn.dataset.id;
    delete btn.dataset.done;
    closeModals();
    if (id) { selectInstance(id); go('home'); }
    return;
  }
  if (installing || !installItem) return;
  const item = installItem;
  const isPack = item.type === 'modpack';
  if (!isPack) {
    const inst = instances.find(i => i.id === targetId);
    if (!inst) { $('instStatus').className = 'status err'; $('instStatus').textContent = 'Pick an instance to install into.'; return; }
    if (item.type === 'datapack' && !targetWorld) { $('instStatus').className = 'status err'; $('instStatus').textContent = 'Pick a world first.'; return; }
  }

  installing = true;
  btn.disabled = true;
  $('instCancel').textContent = 'Cancel install';
  $('instCancel').disabled = false;
  $('instNote').hidden = true;
  $('instBarWrap').hidden = false;
  $('btnInstallLabel').textContent = 'Installing…';
  const st = $('instStatus'); st.className = 'status'; st.textContent = 'Starting…';
  $('instBlocked').hidden = true;

  const res = isPack
    ? await window.api.installModpack({ slug: item.slug, source: item.source || 'modrinth', title: item.title })
    : await window.api.installContent({ slug: item.slug, source: item.source || 'modrinth', type: item.type, instanceId: targetId, world: targetWorld });
  installing = false;
  $('instCancel').textContent = 'Close';
  $('instCancel').disabled = false;
  const visible = installModalOpen();

  if (!res.ok) {
    const cancelled = /cancelled/i.test(res.error || '');
    if (visible) {
      st.className = 'status' + (cancelled ? '' : ' err');
      st.textContent = cancelled ? 'Install cancelled.' : 'Install failed: ' + res.error;
      $('instBarWrap').hidden = true;
      btn.disabled = false;
      $('btnInstallLabel').textContent = 'Try again';
    } else showToast(cancelled ? 'Install cancelled' : 'Install failed', res.error, cancelled ? '' : 'err', null, 8000);
    return;
  }

  let msg, id = '';
  if (isPack) {
    instances = await window.api.listInstances();
    current = instances.find(i => i.id === res.instance.id) || current;
    renderAll();
    id = res.instance.id;
    msg = `Installed ${res.mods} mods · Minecraft ${res.version} · ${loaderName(res.loader)}`;
    if (res.blocked && res.blocked.length) msg += ` · ${res.blocked.length} blocked by their authors (links below)`;
  } else {
    const inst = instances.find(i => i.id === targetId);
    msg = `Added to ${inst ? inst.name : 'your instance'} › ${res.folder}`;
    if (res.extras) msg += ` (+${res.extras} required mod${res.extras > 1 ? 's' : ''})`;
    if (res.blocked && res.blocked.length && !(res.files && res.files.length)) msg = 'Blocked by the author: CurseForge does not allow this download outside its site (link below).';
    else if (res.warnings && res.warnings.length) msg += ' — ' + res.warnings[0];
    id = '';
  }
  const bl = $('instBlocked'); bl.textContent = '';
  (res.blocked || []).slice(0, 12).forEach(b => {
    if (!b.url) { bl.appendChild(h('div', 'hint', b.name + ' (no link available)')); return; }
    const a = h('button', 'btn', 'Open ' + b.name); a.type = 'button';
    a.addEventListener('click', () => window.api.openExternal(b.url));
    bl.appendChild(a);
  });
  bl.hidden = !bl.childNodes.length;
  if (visible) {
    $('instBar').style.width = '100%';
    st.className = 'status ok';
    st.textContent = msg;
    btn.disabled = false;
    btn.dataset.done = '1';
    btn.dataset.id = id;
    $('btnInstallLabel').textContent = isPack ? 'Go to instance' : 'Done';
  } else {
    showToast(item.title, '✓ ' + msg, 'ok', null, 9000);
  }
});

window.api.onInstall(({ done, total, phase }) => {
  const pct = total ? (done / total * 100) : 8;
  const text = total ? `${phase} — ${done} / ${total}` : phase;
  $('instBar').style.width = pct.toFixed(1) + '%';
  $('instStatus').textContent = text;
  if (installing && !installModalOpen()) showToast('Installing ' + (installItem ? installItem.title : ''), text + ' · click to view', '', pct);
});

/* ------------------------------------------------------------- news ---- */
async function loadNews() {
  const box = $('newsList');
  const res = await window.api.news();
  box.textContent = '';
  if (!res || !res.ok || !res.items.length) { box.appendChild(h('div', 'hint', 'News unavailable offline.')); return; }
  res.items.slice(0, 4).forEach(n => {
    const b = h('button', 'nitem'); b.type = 'button';
    const th = h('div', 'nthumb');
    const src = httpsOnly(n.image);
    if (src) th.appendChild(img(src, '')); else th.appendChild(svgUse('i-gem'));
    const tx = h('div', 'ntxt');
    tx.appendChild(h('div', 'ntitle', n.title));
    tx.appendChild(h('div', 'ndate', fmtDate(n.date)));
    b.append(th, tx);
    b.addEventListener('click', () => window.api.openExternal('https://www.minecraft.net/en-us/updates'));
    box.appendChild(b);
  });
}

/* ------------------------------------------------------- playtime ---- */
async function refreshStats() {
  let s;
  try { s = await window.api.stats(); } catch { return; }
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const max = Math.max(3600, ...s.week);
  const box = $('bars');
  box.textContent = '';
  s.week.forEach((sec, i) => {
    const col = h('div', 'bcol' + (i === s.today ? ' today' : ''));
    const tr = h('div', 'btrack' + (sec > 0 ? '' : ' zero'));
    tr.title = fmtShort(sec);
    const f = h('div', 'bfill');
    f.style.setProperty('--p', String(Math.min(1, sec / max)));
    tr.appendChild(f);
    col.append(tr, h('div', 'bl', days[i]));
    box.appendChild(col);
  });
  const total = s.week.reduce((a, b) => a + b, 0);
  $('weekHours').textContent = (total / 3600).toFixed(1) + 'h';
  $('tileLast').textContent = fmtShort(s.last);
}

/* ---------------------------------------------------------- playing ---- */
const setStatus = (t) => { $('status').textContent = t; };

function setPlayState() {
  const b = $('play');
  b.classList.toggle('stop', running);
  b.disabled = preparing;
  $('playLabel').textContent = running ? 'Stop' : preparing ? 'Preparing…' : 'Play';
  b.querySelector('use').setAttribute('href', running ? '#i-stop' : '#i-play');
}

let launchServer = '';
async function startPlay() {
  if (running) { window.api.kill(); return; }
  if (preparing) return;
  if (!current) { setStatus('Create or select an instance first'); openCreate(); return; }
  const username = $('username').value.trim();
  if (!username) { setStatus('Enter a username in Settings'); openSettings('general'); $('username').focus(); return; }

  preparing = true;
  setPlayState();
  $('barFill').style.width = '0%';
  setStatus('Preparing…');

  let res;
  try {
    res = await window.api.launch({
      username,
      version: current.version,
      loader: current.loader,
      instanceId: current.id,
      ram: Number($('ram').value),
      java: cfg.java || '',
      width: Number($('w').value) || 1280,
      height: Number($('h').value) || 720,
      customRes: $('customRes').checked,
      jvmArgs: $('jvmArgs').value.trim(),
      server: launchServer
    });
    launchServer = '';
  } catch (e) { launchServer = ''; res = { ok: false, error: e.message }; }

  preparing = false;
  if (!res.ok) {
    running = false;
    setStatus('Failed: ' + res.error);
    pushLog('ERROR: ' + res.error);
  } else {
    running = true;
    setStatus('Running…');
  }
  setPlayState();
}
$('play').addEventListener('click', startPlay);

window.api.onProgress(({ done, total, phase }) => {
  $('barFill').style.width = total ? (done / total * 100).toFixed(1) + '%' : '0%';
  setStatus(`${phase} — ${done} / ${total}`);
});
window.api.onLog(pushLog);
/* ---------------------------------------------------- crash dialog ---- */
function showCrash(crash) {
  $('crashHead').textContent = 'Minecraft crashed';
  $('crashSub').textContent = crash.diagnoses.length
    ? 'Here is what most likely went wrong, and how to fix it:'
    : `Minecraft closed unexpectedly (exit code ${crash.code}). No known cause was recognised. The console or the crash report may show more.`;
  const box = $('crashList');
  box.textContent = '';
  crash.diagnoses.forEach(d => {
    const c = h('div', 'diag');
    c.appendChild(h('b', '', d.title));
    c.appendChild(h('p', '', d.detail));
    if (d.fixes && d.fixes.length) {
      const ul = h('ul');
      d.fixes.forEach(f => ul.appendChild(h('li', '', f)));
      c.appendChild(ul);
    }
    box.appendChild(c);
  });
  $('crashStatus').textContent = '';
  $('crashStatus').className = 'status';
  $('btnCrashReport').hidden = !crash.hasReport;
  $('btnCrashUpload').disabled = false;
  openModal('m-crash');
}
$('btnCrashConsole').addEventListener('click', () => { closeModals(); go('console'); });
$('btnCrashReport').addEventListener('click', () => window.api.openCrashReport());
$('btnCrashUpload').addEventListener('click', async () => {
  const st = $('crashStatus');
  $('btnCrashUpload').disabled = true;
  st.className = 'status'; st.textContent = 'Uploading…';
  const r = await window.api.uploadCrashLog();
  if (r.ok) {
    st.className = 'status ok';
    st.textContent = 'Uploaded: ';
    const a = h('a', '', r.url);
    a.addEventListener('click', () => window.api.openExternal(r.url));
    st.appendChild(a);
    try { navigator.clipboard.writeText(r.url); st.append(' (copied)'); } catch {}
  } else {
    st.className = 'status err';
    st.textContent = 'Upload failed: ' + r.error;
    $('btnCrashUpload').disabled = false;
  }
});

window.api.onDone(async ({ code, crash }) => {
  running = false;
  preparing = false;
  setPlayState();
  $('barFill').style.width = '0%';
  setStatus(code === 0 ? 'Closed' : (crash ? 'Crashed' : 'Stopped'));
  if (crash) showCrash(crash);
  const keepId = current && current.id;
  instances = await window.api.listInstances();
  current = instances.find(i => i.id === keepId) || instances[0] || null;
  renderAll();
  refreshStats();
});

/* ---------------------------------------------------------- console ---- */
function pushLog(t) {
  logBuf += t + '\n';
  if (logBuf.length > 200000) logBuf = logBuf.slice(-150000);
  logDirty = true;
  if (view === 'console') flushLog();
}
function flushLog() {
  if (!logDirty) return;
  const el = $('log');
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.textContent = logBuf;
  if (stick) el.scrollTop = el.scrollHeight;
  logDirty = false;
}
$('btnClear').addEventListener('click', () => { logBuf = ''; logDirty = true; flushLog(); });

/* --------------------------------------------------------- settings ---- */
function updateRamLabel() { $('ramVal').textContent = (Math.round($('ram').value / 1024 * 10) / 10) + ' GB'; }

const persist = debounce(() => {
  window.api.saveConfig({
    username: $('username').value.trim(),
    ram: Number($('ram').value),
    java: cfg.java || '',
    width: Number($('w').value) || 1280,
    height: Number($('h').value) || 720,
    customRes: $('customRes').checked,
    effects: !$('perfMode').checked,
    hwAccel: $('hwAccel').checked,
    minimizeOnLaunch: $('minLaunch').checked,
    autoLaunch: $('autoLaunch').checked,
    disablePlaytime: $('noPlaytime').checked,
    accent: cfg.accent || 'violet',
    display: cfg.display || 'dark',
    jvmArgs: $('jvmArgs').value.trim()
  });
}, 400);

$('username').addEventListener('input', () => { updateGreeting(); persist(); });
$('ram').addEventListener('input', () => { updateRamLabel(); persist(); });
['w', 'h'].forEach(id => $(id).addEventListener('input', persist));
$('jvmArgs').addEventListener('input', persist);
$('customRes').addEventListener('change', persist);
$('hwAccel').addEventListener('change', persist);
$('minLaunch').addEventListener('change', persist);
$('autoLaunch').addEventListener('change', persist);
$('noPlaytime').addEventListener('change', persist);
$('perfMode').addEventListener('change', (e) => {
  document.body.classList.toggle('reduced', e.target.checked);
  persist();
});
$('javaPath').addEventListener('input', (e) => { cfg.java = e.target.value.trim(); persist(); });
$('btnJava').addEventListener('click', async () => {
  const p = await window.api.pickFile();
  if (p) { cfg.java = p; $('javaPath').value = p; persist(); }
});
$('btnDetect').addEventListener('click', async () => {
  $('javaFound').textContent = 'Looking for Java…';
  await new Promise(r => setTimeout(r, 30));
  const found = (await window.api.detectJava()) || [];
  $('javaFound').textContent = found.length ? `Found ${found.length} Java install${found.length === 1 ? '' : 's'}.` : 'No Java found — one will be downloaded automatically when needed.';
  renderJavaFound(found);
});
$('btnFolder').addEventListener('click', () => window.api.openFolder(''));
$('btnFolder2').addEventListener('click', () => window.api.openFolder(''));

/* ------------------------------------------------ settings dialog ---- */
const SET_SECS = {
  general: ['i-gear', 'General', 'General application settings and preferences'],
  appearance: ['i-brush', 'Appearance', 'Customize the look and feel of your launcher'],
  java: ['i-coffee', 'Java Manager', 'Install and manage Java runtimes for Minecraft'],
  storage: ['i-disk', 'Storage', 'See where disk space is used'],
  defaults: ['i-sliders', 'Default Options', 'Defaults used by every instance'],
  about: ['i-info', 'About', 'About Crystal Launcher']
};
function showSec(sec) {
  if (!SET_SECS[sec]) sec = 'general';
  document.querySelectorAll('.sn').forEach(n => n.classList.toggle('on', n.dataset.sec === sec));
  document.querySelectorAll('.set-sec').forEach(n => n.classList.toggle('on', n.dataset.sec === sec));
  const [ico, t, sub] = SET_SECS[sec];
  $('setHeadIco').firstElementChild.setAttribute('href', '#' + ico);
  $('setHeadT').textContent = t;
  $('setHeadS').textContent = sub;
  if (sec === 'java') loadManagedJava();
  if (sec === 'storage') loadStorage();
}
function openSettings(sec) { showSec(sec || 'general'); openModal('m-settings'); }
document.querySelectorAll('.sn').forEach(n => n.addEventListener('click', () => showSec(n.dataset.sec)));
$('setOs').textContent = /Windows/i.test(navigator.userAgent) ? 'Windows' : /Mac/i.test(navigator.userAgent) ? 'macOS' : 'Linux';

/* appearance */
const ACCENTS = [
  ['violet', '#9a8cff', '#7a68f2', 'rgba(94,82,232,.55)', 'rgba(60,90,220,.35)'], ['red', '#ff6161', '#e23b3b', 'rgba(220,60,60,.45)', 'rgba(150,40,90,.35)'],
  ['crimson', '#c8505f', '#a8323f', 'rgba(170,50,70,.45)', 'rgba(110,30,60,.35)'], ['amber', '#f7b93e', '#e09a14', 'rgba(220,150,30,.4)', 'rgba(180,90,30,.3)'],
  ['lime', '#8ef24f', '#62d02a', 'rgba(110,200,50,.4)', 'rgba(40,150,80,.3)'], ['green', '#34c76a', '#1ea652', 'rgba(40,170,90,.42)', 'rgba(20,120,110,.3)'],
  ['mint', '#63c7a0', '#3fa883', 'rgba(60,170,140,.4)', 'rgba(40,120,170,.3)'], ['blue', '#4aa3ff', '#2a82f0', 'rgba(40,120,240,.5)', 'rgba(60,70,220,.35)'],
  ['sand', '#cdb690', '#a99070', 'rgba(170,140,100,.35)', 'rgba(120,100,90,.3)'], ['lilac', '#c78bff', '#a45cf0', 'rgba(160,80,240,.5)', 'rgba(110,70,220,.35)'],
  ['magenta', '#f03cd2', '#c91fae', 'rgba(210,40,180,.5)', 'rgba(130,40,200,.35)'], ['indigo', '#7c8cff', '#5a6af0', 'rgba(70,80,230,.55)', 'rgba(40,60,200,.4)']
];
const DISPLAYS = { dark: ['Dark', '#0d0d16'], oled: ['OLED', '#000000'] };
function applyAppearance() {
  const a = ACCENTS.find(x => x[0] === cfg.accent) || ACCENTS[0];
  const r = document.documentElement.style;
  r.setProperty('--accent', a[1]); r.setProperty('--accent-2', a[2]);
  const oled = cfg.display === 'oled';
  r.setProperty('--glow-a', oled ? 'transparent' : a[3]); r.setProperty('--glow-b', oled ? 'transparent' : a[4]);
  r.setProperty('--bg', oled ? '#000' : '#0a0a12'); r.setProperty('--tb', oled ? '#000' : '#0b0b14');
  r.setProperty('--solid', oled ? '#050507' : '#0f0f19');
  r.setProperty('--panel', oled ? 'rgba(0,0,0,.92)' : 'rgba(13,13,22,.80)'); r.setProperty('--side', oled ? 'rgba(0,0,0,.92)' : 'rgba(12,12,21,.74)');
  try { window.api.setOverlay(oled ? '#000000' : '#0b0b14'); } catch {}
  document.querySelectorAll('.swt').forEach(b => b.classList.toggle('on', b.dataset.id === (cfg.accent || 'violet')));
  document.querySelectorAll('.dm').forEach(b => b.classList.toggle('on', b.dataset.id === (cfg.display || 'dark')));
}
ACCENTS.forEach(a => {
  const b = h('button', 'swt'); b.type = 'button'; b.dataset.id = a[0]; b.title = a[0];
  b.style.background = `linear-gradient(135deg, ${a[2]}, ${a[1]})`;
  b.appendChild(svgUse('i-check'));
  b.addEventListener('click', () => { cfg.accent = a[0]; applyAppearance(); persist(); });
  $('accentSwatches').appendChild(b);
});
Object.keys(DISPLAYS).forEach(id => {
  const b = h('button', 'dm'); b.type = 'button'; b.dataset.id = id;
  const pv = h('div', 'pv'); pv.style.background = DISPLAYS[id][1]; pv.append(h('i'), h('i'), h('i'));
  b.append(pv, DISPLAYS[id][0]);
  b.addEventListener('click', () => { cfg.display = id; applyAppearance(); persist(); });
  $('dModes').appendChild(b);
});

/* java manager */
function renderJavaFound(found) {
  const box = $('javaList');
  box.textContent = '';
  if (!found.length) { box.appendChild(h('div', 'hint', 'Nothing found. That is fine — the launcher downloads the right Java for each version.')); return; }
  found.forEach(f => {
    const row = h('div', 'jrow');
    row.appendChild(h('div', 'jbadge', String(f.major)));
    const t = h('div', 'jtxt'); t.append(h('b', '', 'Java ' + f.major), h('span', '', f.path));
    const use = h('button', 'btn', cfg.java === f.path ? 'In use' : 'Use'); use.type = 'button';
    use.addEventListener('click', () => { cfg.java = f.path; $('javaPath').value = f.path; persist(); renderJavaFound(found); });
    row.append(t, use);
    box.appendChild(row);
  });
}
const JAVA_ALL = [
  ['java-runtime-epsilon', '25', 'Epsilon'], ['java-runtime-delta', '21', 'Delta'], ['java-runtime-gamma', '17', 'Gamma'],
  ['java-runtime-beta', '17', 'Beta'], ['java-runtime-alpha', '16', 'Alpha'], ['jre-legacy', '8', 'Legacy']
];
const javaBusy = {};
async function loadManagedJava() {
  const box = $('javaMgr');
  const list = (await safe('Java list', () => window.api.managedJava())) || [];
  const have = {};
  list.forEach(j => { have[j.component] = j; });
  box.textContent = '';
  JAVA_ALL.forEach(([comp, major, label]) => {
    const j = have[comp];
    const ok = j && j.complete;
    const row = h('div', 'jrow' + (ok ? ' on' : '')); row.dataset.c = comp;
    row.appendChild(h('div', 'jbadge' + (ok ? '' : ' off'), major));
    const t = h('div', 'jtxt');
    const b = h('b', '', `Java ${major} `); b.appendChild(h('em', '', `(${label})`));
    t.append(b, h('span', '', j ? (j.version || (j.complete ? 'installed' : 'incomplete')) + (j.size ? ' · ' + fmtSize(j.size) : '') : 'not installed'));
    row.appendChild(t);
    const mk = (txt, cls, fn) => { const x = h('button', 'btn ' + (cls || ''), txt); x.type = 'button'; x.addEventListener('click', fn); return x; };
    const install = async (btn) => {
      if (javaBusy[comp]) return;
      javaBusy[comp] = true; btn.disabled = true; btn.textContent = '0%';
      const r = await window.api.installJava(comp);
      javaBusy[comp] = false;
      if (!r.ok) pushLog('Java install failed: ' + r.error);
      loadManagedJava();
    };
    if (ok) {
      row.appendChild(h('span', 'jok', '✓ Installed'));
      const rep = mk('Repair', '', () => install(rep));
      let armed = 0;
      const del = mk('', 'danger', async () => {
        if (!armed) { armed = 1; del.textContent = 'Sure?'; setTimeout(() => { armed = 0; del.textContent = ''; del.appendChild(svgUse('i-trash')); }, 3000); return; }
        await window.api.removeJava(comp); loadManagedJava();
      });
      del.title = 'Uninstall'; del.appendChild(svgUse('i-trash'));
      row.append(rep, del);
    } else {
      const ins = mk(j ? 'Repair' : 'Install', 'primary', () => install(ins));
      row.appendChild(ins);
    }
    box.appendChild(row);
  });
}
window.api.onJavaProgress(({ component, done, total }) => {
  if (!total) return;
  const pct = Math.round(done / total * 100) + '%';
  document.querySelectorAll('#javaMgr .jrow').forEach(r => {
    if (r.dataset.c === component) { const bt = r.querySelector('.btn:disabled'); if (bt) bt.textContent = pct; }
  });
});

/* servers */
function srvSave() { window.api.saveConfig({ servers: cfg.servers || [] }); }
let srvEdit = -1;
function renderServers() {
  const list = cfg.servers || [];
  $('srvCount').textContent = list.length + (list.length === 1 ? ' server' : ' servers');
  $('srvHint').textContent = current ? `Join uses your selected instance: ${current.name} (${current.version}).` : 'Create or select an instance to join a server.';
  const box = $('srvList'); box.textContent = '';
  if (!list.length) { box.appendChild(h('div', 'hint', 'No servers yet. Press Add server and type its IP.')); return; }
  list.forEach((sv, idx) => {
    const row = h('div', 'jrow');
    const ico = h('div', 'srv-ico'); ico.appendChild(svgUse('i-server'));
    const dot = h('span', 'srv-dot'); dot.id = 'sd' + idx;
    const t = h('div', 'jtxt'); t.append(h('b', '', sv.name || sv.addr), h('span', '', sv.addr));
    const meta = h('span', 'srv-meta', 'Checking…'); meta.id = 'sm' + idx;
    const join = h('button', 'btn primary', 'Join'); join.type = 'button';
    join.addEventListener('click', () => {
      if (!current) { setStatus('Create or select an instance first'); return; }
      launchServer = sv.addr; go('home'); startPlay();
    });
    const ed = h('button', 'btn', 'Edit'); ed.type = 'button';
    ed.addEventListener('click', () => { srvEdit = idx; $('srvTitle').textContent = 'Edit server'; $('srvName').value = sv.name || ''; $('srvAddr').value = sv.addr; openModal('m-server'); });
    const del = h('button', 'btn danger', ''); del.type = 'button'; del.title = 'Remove'; del.appendChild(svgUse('i-trash'));
    del.addEventListener('click', () => { cfg.servers.splice(idx, 1); srvSave(); renderServers(); pingAll(); });
    row.append(ico, dot, t, meta, join, ed, del);
    box.appendChild(row);
  });
}
async function pingAll() {
  (cfg.servers || []).forEach(async (sv, idx) => {
    const r = await window.api.pingServer(sv.addr).catch(() => ({ online: false }));
    const d = $('sd' + idx), m = $('sm' + idx);
    if (!d || !m) return;
    d.className = 'srv-dot ' + (r.online ? 'up' : 'down');
    m.textContent = r.online ? `${r.players}/${r.max} players · ${r.ping} ms${r.version ? ' · ' + r.version : ''}` : 'Offline';
    m.title = r.motd || '';
  });
}
function loadServers() { renderServers(); pingAll(); }
$('btnSrvAdd').addEventListener('click', () => { srvEdit = -1; $('srvTitle').textContent = 'Add server'; $('srvName').value = ''; $('srvAddr').value = ''; openModal('m-server'); $('srvAddr').focus(); });
$('btnSrvRefresh').addEventListener('click', loadServers);
$('btnSrvSave').addEventListener('click', () => {
  const addr = $('srvAddr').value.trim();
  if (!addr) { $('srvAddr').focus(); return; }
  const entry = { name: $('srvName').value.trim() || addr, addr };
  cfg.servers = cfg.servers || [];
  if (srvEdit >= 0) cfg.servers[srvEdit] = entry; else cfg.servers.push(entry);
  srvSave(); closeModals(); loadServers();
});

/* storage */
async function loadStorage() {
  const info = await safe('Storage', () => window.api.storageInfo());
  if (!info) return;
  $('stPath').value = info.root;
  $('stFree').textContent = info.total ? `${fmtSize(info.free)} free of ${fmtSize(info.total)}` : '';
  const instTotal = info.instances.reduce((a, b) => a + b.size, 0);
  const shared = info.items.filter(i => i.required).reduce((a, b) => a + b.size, 0);
  const rt = (info.items.find(i => i.key === 'runtimes') || { size: 0 }).size;
  const segs = [['Instances', instTotal, '#9a8cff'], ['Shared files', shared, '#f0a43a'], ['Java runtimes', rt, '#4aa3ff'], ['Free', info.free, '#3a3a48']];
  const sum = segs.reduce((a, b) => a + b[1], 0) || 1;
  const bar = $('stBar'); bar.textContent = '';
  segs.forEach(sg => { const i = document.createElement('i'); i.style.width = (sg[1] / sum * 100) + '%'; i.style.background = sg[2]; bar.appendChild(i); });
  const leg = $('stLeg'); leg.textContent = '';
  segs.forEach(sg => { const sp = h('span', '', `${sg[0]} ${fmtSize(sg[1])}`); sp.style.setProperty('--c', sg[2]); leg.appendChild(sp); });
  const rows = (box, list, nameOf, subOf) => {
    box.textContent = '';
    if (!list.length) { box.appendChild(h('div', 'hint', 'Nothing here yet.')); return; }
    list.forEach(it => {
      const row = h('div', 'jrow');
      const t = h('div', 'jtxt'); t.append(h('b', '', nameOf(it)), h('span', '', subOf(it)));
      row.append(t, h('span', 'jsize', fmtSize(it.size)));
      box.appendChild(row);
    });
  };
  rows($('stItems'), info.items, i => i.label, i => i.path);
  rows($('stInst'), info.instances, i => i.name, i => i.id);
}

/* -------------------------------------------------------- changelog ---- */
const APP_VERSION = '2.3.0';
const CHANGELOG = [
  { v: '2.3.0', title: 'SKLauncher 4 look, filters and a much faster UI', latest: true, groups: [
    { k: 'new', t: [
      'New look matching SKLauncher 4: gradient frame, glass panels and pill buttons',
      'Settings are now a dialog with General, Appearance, Java Manager, Storage, Default Options and About',
      'Appearance: Dark or OLED display mode and 12 accent colours',
      'Discover has a Filters panel: content type, game version, mod loaders and categories',
      'Java Manager lists Java found on your PC and the runtimes the launcher downloaded',
      'Storage page shows where your disk space goes',
      'Performance Mode, Hardware Acceleration and Minimize on Launch switches',
      'New intro: typed pixel heading, shooting star and an animated logo splash (skipped in Performance Mode)'
    ] },
    { k: 'improved', t: [
      'Much smoother: the launcher no longer draws in software mode',
      'Window buttons are now the real Windows ones, so minimize, maximize and close always work',
      'The memory slider reads your real RAM (8 GB PC = 6 GB maximum)'
    ] },
    { k: 'fixed', t: [
      'If something inside the launcher fails, a message appears instead of the page going dead'
    ] }
  ] },
  { v: '2.2.0', title: 'Mod manager, crash helper and a sturdier launch', groups: [
    { k: 'new', t: [
      'Manage button on every instance: turn mods, resource packs and shaders on or off, remove them, and check for updates',
      'Warns you before disabling or removing a mod that another mod needs',
      'Crash helper: when the game crashes you get a plain-language cause and fixes, and can upload the log to mclo.gs to share',
      'Instance settings: give one instance its own memory, Java, window size or JVM arguments',
      'Duplicate an instance, and import a .mrpack modpack file from your computer',
      'Global JVM arguments field in Settings'
    ] },
    { k: 'improved', t: [
      'Downloads are verified and retried, with a stall timeout so a bad connection can no longer hang a launch',
      'The right Java version is chosen exactly, and an incomplete Java download is repaired'
    ] },
    { k: 'fixed', t: [
      'Missing game files now stop the launch with a clear message instead of failing silently later'
    ] }
  ] },
  { v: '2.1.0', title: 'Installer, welcome screen and new icon', groups: [
    { k: 'new', t: [
      'Real Windows installer: choose the install folder, see the files being installed, and pick whether to add a Desktop shortcut',
      'Welcome screen on first launch with Play Offline and a player name',
      'New crystal app icon',
      'Changelog in the launcher and on the welcome screen',
      'Switch account button in Settings'
    ] },
    { k: 'improved', t: [
      'Only one launcher window can be open at a time',
      'App renamed to Crystal Launcher everywhere'
    ] }
  ] },
  { v: '2.0.0', title: 'New look and content installer', groups: [
    { k: 'new', t: [
      'Dark redesign with a sidebar, home screen, instances and console pages',
      'Install modpacks, mods, shaders, resource packs and data packs from Modrinth',
      'Explore Content Hub with Shuffle for a fresh set each time',
      'Fabric, Quilt, Forge and NeoForge instances',
      'Java is downloaded automatically when none is installed',
      'Playtime tracking and Minecraft news'
    ] },
    { k: 'improved', t: [
      'Memory slider is capped to about 75% of your RAM for better performance',
      'Lighter UI with no blur or transparency'
    ] },
    { k: 'fixed', t: [
      'Minimize button works again',
      'Close button works while a download is running; installs continue in the background',
      'Mod loader list is readable and rename works'
    ] }
  ] },
  { v: '1.0.0', title: 'First release', groups: [
    { k: 'new', t: [
      'Offline Minecraft launcher with fast parallel downloads',
      'Automatic Java detection and tuned JVM flags'
    ] }
  ] }
];
const KIND_LABEL = { new: 'New', improved: 'Improved', fixed: 'Fixed' };

function renderChangelog(box) {
  box.textContent = '';
  CHANGELOG.forEach(entry => {
    const card = h('div', 'cl-entry');
    const head = h('div', 'cl-head');
    head.appendChild(h('b', null, 'v' + entry.v));
    if (entry.latest) head.appendChild(h('span', 'cl-tag', 'Latest'));
    card.appendChild(head);
    card.appendChild(h('div', 'cl-title', entry.title));
    entry.groups.forEach(g => {
      const grp = h('div', 'cl-group');
      grp.appendChild(h('div', 'cl-kind ' + g.k, KIND_LABEL[g.k]));
      const ul = h('ul');
      g.t.forEach(line => ul.appendChild(h('li', null, line)));
      grp.appendChild(ul);
      card.appendChild(grp);
    });
    box.appendChild(card);
  });
}
renderChangelog($('clList'));
renderChangelog($('wClList'));
$('clVer').textContent = 'v' + APP_VERSION;

function markChangelogSeen() {
  $('navDot').hidden = true;
  if (cfg && cfg.seenVersion !== APP_VERSION) {
    cfg.seenVersion = APP_VERSION;
    window.api.saveConfig({ seenVersion: APP_VERSION });
  }
}
$('btnChanges').addEventListener('click', () => go('changelog'));

/* ---------------------------------------------------- welcome / account ---- */
let welcomeDone = null;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

let typeTimer = 0;
function typeTitle(text) {
  const el = $('wTitle');
  clearInterval(typeTimer);
  el.textContent = '';
  if (!text) return;
  if (document.body.classList.contains('reduced')) { el.textContent = text; return; }
  let i = 0;
  typeTimer = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(typeTimer); }, 42);
}
const WELCOME_TITLES = { main: 'Welcome to Crystal Launcher.', offline: 'Enter your username.', changes: '' };
function welcomeStep(s) {
  typeTitle(WELCOME_TITLES[s] || '');
  $('w-main').classList.toggle('on', s === 'main');
  $('w-offline').classList.toggle('on', s === 'offline');
  $('w-changes').classList.toggle('on', s === 'changes');
  if (s === 'offline') {
    $('wName').value = $('username').value || '';
    setWErr('3 to 16 characters: letters, numbers and _ only.', '');
    setTimeout(() => $('wName').focus(), 40);
  }
}
function setWErr(text, cls) { const n = $('wErr'); n.textContent = text; n.className = 'w-note' + (cls ? ' ' + cls : ''); }

function openWelcome() {
  closeModals();
  document.body.classList.add('welcoming');
  $('welcome').hidden = false;
  $('wCancel').hidden = !cfg.welcomed;
  $('wNote').textContent = 'Offline mode uses a name stored only on this PC. No account is needed.';
  $('wNote').className = 'w-note';
  welcomeStep('main');
  return new Promise(res => { welcomeDone = res; });
}
function closeWelcome() {
  document.body.classList.remove('welcoming');
  $('welcome').hidden = true;
  if (welcomeDone) { const f = welcomeDone; welcomeDone = null; f(); }
}

$('btnMs').addEventListener('click', () => {
  $('wNote').textContent = "Microsoft sign-in isn't available in this version yet. Choose Play Offline to continue.";
  $('wNote').className = 'w-note warn';
});
$('btnOffline').addEventListener('click', () => welcomeStep('offline'));
$('wBack').addEventListener('click', () => welcomeStep('main'));
$('wChanges').addEventListener('click', () => welcomeStep('changes'));
$('wChangesBack').addEventListener('click', () => welcomeStep('main'));
$('wCancel').addEventListener('click', closeWelcome);

function submitWelcomeName() {
  const name = $('wName').value.trim();
  if (!NAME_RE.test(name)) { setWErr('Use 3 to 16 characters: letters, numbers and _ only.', 'err'); $('wName').focus(); return; }
  $('username').value = name;
  cfg.welcomed = true;
  cfg.username = name;
  window.api.saveConfig({ username: name, welcomed: true, accountType: 'offline' });
  updateGreeting();
  playSplash();
  closeWelcome();
}
$('wContinue').addEventListener('click', submitWelcomeName);
$('wName').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitWelcomeName(); });
$('btnSwitch').addEventListener('click', async () => { await openWelcome(); });

boot();


/* CurseForge source (the private API key is held by the Cloudflare Worker) */
function setSource(src) {
  discSource = src;
  $('btnModrinth').classList.toggle('on', src === 'modrinth');
  $('btnCurse').classList.toggle('on', src === 'curseforge');
  if (loadDiscover.built) buildFilters();
  reloadDiscover();
}
$('btnModrinth').addEventListener('click', () => setSource('modrinth'));
$('btnCurse').addEventListener('click', () => setSource('curseforge'));
