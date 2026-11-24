'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const diag = require('./lib/diagnose');
const { readJarMeta } = require('./lib/jarmeta');
/* GPU rendering is ON by default (software rendering made the UI slow). It can be switched off in Settings if a driver misbehaves. */
try {
  const early = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'CrystalLauncher', 'config.json'), 'utf8'));
  if (early && early.hwAccel === false) app.disableHardwareAcceleration();
} catch {}
process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'crystal-crash.log'), String(err && err.stack || err) + '\n'); } catch {}
});

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES = 'https://resources.download.minecraft.net/';
const LIBRARIES = 'https://libraries.minecraft.net/';
const JAVA_RUNTIME_ALL = 'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

const ROOT = path.join(app.getPath('appData'), 'CrystalLauncher');
const MC = path.join(ROOT, 'minecraft');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const INSTANCES_PATH = path.join(ROOT, 'instances.json');
const STATS_PATH = path.join(ROOT, 'stats.json');

const MODRINTH_SEARCH = 'https://api.modrinth.com/v2/search';
// CurseForge requests go through the Crystal Launcher Cloudflare Worker.
const CF_PROXY_BASE = 'https://crystal-cf-proxy.vansh123456789-minecraft.workers.dev';
const NEWS_URL = 'https://launchercontent.mojang.com/v2/javaPatchNotes.json';
const NEWS_BASE = 'https://launchercontent.mojang.com';
const CONTENT_TYPES = ['modpack', 'mod', 'shader', 'resourcepack', 'datapack'];
const EXTERNAL_HOSTS = ['modrinth.com', 'www.modrinth.com', 'minecraft.net', 'www.minecraft.net', 'mclo.gs', 'www.curseforge.com', 'curseforge.com'];

const DEFAULTS = {
  username: 'Player', welcomed: false, accountType: 'offline', ram: 3072, java: '', version: '',
  width: 1280, height: 720, customRes: false, effects: true, loader: 'vanilla', jvmArgs: '',
  hwAccel: true, minimizeOnLaunch: false, accent: 'violet', display: 'dark'
};

let win = null;
let child = null;
let running = false;
let manifestCache = null;
let killedByUser = false;
let gameTail = [];          // last lines of game output, for crash analysis
let lastCrash = null;       // { text, reportPath } of the most recent crash

function readConfig() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
  catch { return Object.assign({}, DEFAULTS); }
}
function writeConfig(c) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

function readInstances() {
  try { return JSON.parse(fs.readFileSync(INSTANCES_PATH, 'utf8')); }
  catch { return []; }
}
function writeInstances(list) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(INSTANCES_PATH, JSON.stringify(list, null, 2));
}
/* an instance id is 12 hex chars; refuse anything else so a bad id can never point outside the instances folder */
function instDir(id) {
  if (!/^[a-f0-9]{12}$/.test(String(id))) throw new Error('Invalid instance id');
  return path.join(MC, 'instances', String(id));
}
function genId() {
  return crypto.randomBytes(6).toString('hex');
}

function createWindow() {
  /*
   * The window is deliberately NOT transparent. On Windows, transparent frameless
   * windows lose native minimize / maximize / snap behaviour, which is what made the
   * minimize button unreliable before. An opaque frameless window keeps all of it.
   */
  win = new BrowserWindow({
    width: 1120, height: 740, minWidth: 920, minHeight: 620,
    ...(process.platform === 'win32'
      ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0b0b14', symbolColor: '#dcdcea', height: 38 } }
      : { frame: false }),
    transparent: false, backgroundColor: '#0b0b14',
    resizable: true, minimizable: true, maximizable: true, fullscreenable: true,
    show: false, title: 'Crystal Launcher',
    icon: path.join(__dirname, 'ui', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'ui', 'index.html')).catch(e => {
    try { fs.appendFileSync(path.join(os.tmpdir(), 'crystal-crash.log'), 'loadFile failed: ' + e.message + '\n'); } catch {}
  });
  win.once('ready-to-show', () => win.show());
  const pushState = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('win:state', { maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
  };
  win.on('maximize', pushState);
  win.on('unmaximize', pushState);
  win.on('enter-full-screen', pushState);
  win.on('leave-full-screen', pushState);
  win.on('closed', () => { win = null; });
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 3000);
}

/* window controls: always act on the window that sent the message */
const senderWin = (e) => BrowserWindow.fromWebContents(e.sender);
ipcMain.on('win:min', (e) => { const w = senderWin(e); if (w) w.minimize(); });
ipcMain.on('win:overlay', (e, color) => {
  const w = senderWin(e);
  if (!w || !/^#[0-9a-fA-F]{6}$/.test(String(color))) return;
  try { if (process.platform === 'win32') w.setTitleBarOverlay({ color: String(color), symbolColor: '#dcdcea', height: 38 }); } catch {}
});
ipcMain.on('win:max', (e) => {
  const w = senderWin(e);
  if (!w) return;
  if (w.isFullScreen()) w.setFullScreen(false);
  else if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on('win:fullscreen', (e) => { const w = senderWin(e); if (w) w.setFullScreen(!w.isFullScreen()); });
ipcMain.on('win:close', (e) => { const w = senderWin(e); if (w) w.close(); });
ipcMain.handle('win:state', (e) => {
  const w = senderWin(e);
  return { maximized: !!(w && w.isMaximized()), fullscreen: !!(w && w.isFullScreen()) };
});
ipcMain.handle('sys:mem', () => Math.floor(os.totalmem() / (1024 * 1024)));

/* ------------------------------------------------------------ stats ---- */

function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function readStats() {
  try {
    const s = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
    return { days: s.days || {}, last: s.last || 0 };
  } catch { return { days: {}, last: 0 }; }
}
function addPlaySeconds(sec) {
  if (!(sec > 0)) return;
  const s = readStats();
  const k = dayKey(new Date());
  s.days[k] = (s.days[k] || 0) + sec;
  s.last = sec;
  const keys = Object.keys(s.days).sort();
  while (keys.length > 120) delete s.days[keys.shift()];
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(s));
}
ipcMain.handle('stats:get', () => {
  const s = readStats();
  const now = new Date();
  const mondayOffset = (now.getDay() + 6) % 7;
  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset + i);
    week.push(s.days[dayKey(d)] || 0);
  }
  return { week, today: mondayOffset, last: s.last || 0 };
});

/* ---------------------------------------------- hub, news, external ---- */

const netCache = new Map();
async function cached(key, ttlMs, producer) {
  const hit = netCache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await producer();
  netCache.set(key, { t: Date.now(), v });
  return v;
}

ipcMain.handle('net:modrinth', async (_e, o) => {
  o = o || {};
  const limit = Math.max(1, Math.min(30, Number(o.limit) || 3));
  const index = ['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(o.index) ? o.index : 'downloads';
  const query = String(o.query || '').slice(0, 80);
  const offset = Math.max(0, Math.min(1000, Math.floor(Number(o.offset) || 0)));
  const type = CONTENT_TYPES.includes(o.type) ? o.type : 'modpack';
  const facets = [['project_type:' + type]];
  const mv = String(o.mcVersion || '');
  if (/^[0-9A-Za-z.\-_]{1,24}$/.test(mv)) facets.push(['versions:' + mv]);
  const LOADERS = ['fabric', 'quilt', 'forge', 'neoforge'];
  const wanted = (Array.isArray(o.loaders) ? o.loaders : [o.loader]).map(x => String(x || '')).filter(x => LOADERS.includes(x));
  if (wanted.length && (type === 'mod' || type === 'modpack')) {
    const g = [];
    for (const l of wanted) { g.push('categories:' + l); if (l === 'quilt' && type === 'mod') g.push('categories:fabric'); }
    facets.push([...new Set(g)]);
  }
  for (const c of (Array.isArray(o.categories) ? o.categories : []).slice(0, 8)) {
    if (/^[a-z0-9\-]{1,30}$/.test(String(c))) facets.push(['categories:' + c]);
  }
  try {
    const items = await cached(`mr|${query}|${index}|${limit}|${offset}|${JSON.stringify(facets)}`, 10 * 60 * 1000, async () => {
      const url = MODRINTH_SEARCH + `?limit=${limit}&offset=${offset}&index=${index}&query=${encodeURIComponent(query)}` +
        '&facets=' + encodeURIComponent(JSON.stringify(facets));
      const data = await fetchJson(url);
      return (data.hits || []).map(h => ({
        slug: String(h.slug || ''),
        type,
        title: String(h.title || ''),
        description: String(h.description || ''),
        icon: String(h.icon_url || ''),
        banner: String(h.featured_gallery || (h.gallery && h.gallery[0]) || ''),
        author: String(h.author || ''),
        downloads: Number(h.downloads) || 0,
        color: typeof h.color === 'number' ? '#' + h.color.toString(16).padStart(6, '0').slice(-6) : ''
      }));
    });
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('net:categories', async (_e, type) => {
  try {
    const all = await cached('cats', 6 * 60 * 60 * 1000, () => fetchJson('https://api.modrinth.com/v2/tag/category'));
    const t = CONTENT_TYPES.includes(type) ? type : 'mod';
    return { ok: true, items: all.filter(c => c && c.project_type === t && c.header === 'categories' && /^[a-z0-9\-]{1,30}$/.test(String(c.name))).map(c => String(c.name)) };
  } catch (e) { return { ok: false, error: e.message, items: [] }; }
});

ipcMain.handle('net:news', async () => {
  try {
    const items = await cached('news', 30 * 60 * 1000, async () => {
      const data = await fetchJson(NEWS_URL);
      return (data.entries || [])
        .slice()
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
        .slice(0, 6)
        .map(n => {
          let image = '';
          try { if (n.image && n.image.url) image = new URL(n.image.url, NEWS_BASE).href; } catch {}
          return { title: String(n.title || n.version || 'Minecraft'), version: String(n.version || ''), type: String(n.type || ''), date: String(n.date || ''), image };
        });
    });
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open:external', (_e, url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:' && EXTERNAL_HOSTS.includes(u.hostname)) shell.openExternal(u.href);
  } catch {}
});

const sha1File = (p) => new Promise((res, rej) => {
  const h = crypto.createHash('sha1');
  fs.createReadStream(p).on('data', d => h.update(d))
    .on('end', () => res(h.digest('hex'))).on('error', rej);
});

/* splits a string into arguments like a shell would: spaces separate, quotes group (and are removed) */
function splitArgs(str) {
  const out = [];
  let cur = '', quote = '', has = false;
  for (const ch of String(str || '')) {
    if (quote) { if (ch === quote) quote = ''; else cur += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; }
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* streams a URL to disk. Rejects on HTTP errors (with .status), dropped connections and stalls. */
function fetchToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    const hdr = { 'User-Agent': 'CrystalLauncher/2.3.4' };
    let requestUrl = url;
    // The Worker injects the private API key before forwarding to edge.forgecdn.net.
    try {
      const parsed = new URL(url);
      if (/(^|\.)forgecdn\.net$/.test(parsed.hostname)) {
        requestUrl = CF_PROXY_BASE + '/cdn' + parsed.pathname + parsed.search;
      }
    } catch {}
    const req = https.get(requestUrl, { headers: hdr }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchToFile(new URL(res.headers.location, url).href, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        const e = new Error('HTTP ' + res.statusCode + ' ' + url);
        e.status = res.statusCode;
        e.retryAfter = Number(res.headers['retry-after']) || 0;
        return reject(e);
      }
      const out = fs.createWriteStream(dest);
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        out.destroy();
        try { fs.unlinkSync(dest); } catch {}
        reject(e);
      };
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('connection dropped')));
      res.on('close', () => { if (res.complete === false) fail(new Error('connection dropped')); });
      out.on('error', fail);
      out.on('finish', () => out.close(() => { if (!settled) { settled = true; resolve(); } }));
      res.pipe(out);
    });
    req.on('error', reject);
    // no data for 30s = stalled: give up on this attempt so a retry can start
    req.setTimeout(30000, () => req.destroy(new Error('download stalled')));
  });
}

/*
 * Download with verification. Writes to a .part file and only renames it into place
 * once the sha1 matches, so a half-finished file is never mistaken for a good one.
 * Retries with backoff; 404/403/410 are not retried (retrying cannot help);
 * 429 honours Retry-After.
 */
async function download(url, dest, sha1, attempt = 0) {
  const tmp = dest + '.part';
  try {
    if (sha1 && fs.existsSync(dest) && await sha1File(dest) === sha1) return;
    if (!sha1 && fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fetchToFile(url, tmp);
    if (sha1) {
      const got = await sha1File(tmp);
      if (got !== sha1) { try { fs.unlinkSync(tmp); } catch {} throw new Error('sha1 mismatch for ' + path.basename(dest)); }
    }
    await fsp.rename(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if ([403, 404, 410].includes(e.status)) throw e;
    if (attempt < 3) {
      const wait = e.status === 429 ? Math.min(60000, Math.max(2, e.retryAfter || 2) * 1000 * (attempt + 1)) : 500 * 2 ** attempt;
      await sleep(wait);
      return download(url, dest, sha1, attempt + 1);
    }
    throw e;
  }
}

function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'CrystalLauncher/2.0', 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchJson(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      res.setEncoding('utf8');
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
  });
}

const osName = () => process.platform === 'win32' ? 'windows'
  : process.platform === 'darwin' ? 'osx' : 'linux';

function ruleAllows(rules, features) {
  if (!rules || !rules.length) return true;
  let allow = false;
  for (const r of rules) {
    const o = r.os || {};
    let match = true;
    if (o.name && o.name !== osName()) match = false;
    if (o.arch) {
      const a = process.arch === 'x64' ? 'x86_64' : process.arch === 'ia32' ? 'x86' : 'arm64';
      if (o.arch !== a) match = false;
    }
    if (o.version && !new RegExp(o.version).test(os.release())) match = false;
    if (r.features) for (const k in r.features)
      if (Boolean(features[k]) !== Boolean(r.features[k])) match = false;
    if (match) allow = r.action === 'allow';
  }
  return allow;
}

function mavenPath(name) {
  const p = name.split(':');
  const [group, artifact, version, classifier] = p;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? '-' + classifier : ''}.jar`;
}

function mergeInherits(child, parent) {
  const merged = Object.assign({}, parent, child);
  merged.libraries = (parent.libraries || []).concat(child.libraries || []);
  const pa = parent.arguments || {};
  const ca = child.arguments || {};
  merged.arguments = {
    jvm: (pa.jvm || []).concat(ca.jvm || []),
    game: (pa.game || []).concat(ca.game || [])
  };
  merged.mainClass = child.mainClass || parent.mainClass;
  merged.downloads = child.downloads || parent.downloads;
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.javaVersion = child.javaVersion || parent.javaVersion;
  merged.logging = child.logging || parent.logging;
  return merged;
}

function offlineUuid(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function extractNatives(jar, dir, excludes) {
  const zip = new AdmZip(jar);
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if ((excludes || ['META-INF/']).some(e => entry.entryName.startsWith(e))) continue;
    const out = path.join(dir, path.basename(entry.entryName));
    if (fs.existsSync(out)) continue;
    fs.writeFileSync(out, entry.getData());
  }
}

function javaMajor(p) {
  const r = spawnSync(p, ['-version'], { encoding: 'utf8' });
  const txt = (r.stderr || '') + (r.stdout || '');
  const m = txt.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  const major = parseInt(m[1], 10);
  return major === 1 ? parseInt(m[2] || '0', 10) : major;
}

function findJava() {
  const out = [];
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  const roots = [
    'C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft\\jdk', 'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft', '/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'
  ];
  for (const r of roots) {
    try {
      for (const d of fs.readdirSync(r)) {
        const p = path.join(r, d, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
        if (fs.existsSync(p)) candidates.push(p);
      }
    } catch {}
  }
  for (const c of candidates) {
    try { const m = javaMajor(c); if (m > 0) out.push({ path: c, major: m }); } catch {}
  }
  if (process.platform === 'win32') {
    const w = spawnSync('where', ['java'], { encoding: 'utf8' });
    for (const line of (w.stdout || '').split(/\r?\n/)) {
      const p = line.trim();
      if (p && fs.existsSync(p)) { try { out.push({ path: p, major: javaMajor(p) }); } catch {} }
    }
  }
  return out.sort((a, b) => b.major - a.major);
}

/*
 * Pick the Java that fits a Minecraft version. Old Minecraft/Forge (Java 8) breaks on newer
 * Javas, so those need exactly 8. Newer versions take the exact major, or a slightly newer one.
 */
function pickJava(found, need) {
  const exact = found.find(j => j.major === need);
  if (exact) return exact;
  if (need <= 8) return null;
  return found.filter(j => j.major > need && j.major <= need + 4).sort((a, b) => a.major - b.major)[0] || null;
}

function runtimePlatformKey() {
  if (process.platform === 'win32') return process.arch === 'ia32' ? 'windows-x86' : (process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64');
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return process.arch === 'x64' ? 'linux' : 'linux-i386';
}

async function ensureRuntime(component, send, log) {
  const runtimeRoot = path.join(ROOT, 'runtimes', component);
  const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
  const binDir = process.platform === 'darwin'
    ? path.join(runtimeRoot, component, 'jre.bundle', 'Contents', 'Home', 'bin')
    : path.join(runtimeRoot, component, 'bin');
  const existing = path.join(binDir, exeName);
  // a marker is written only after every file downloaded, so an interrupted install is redone
  const marker = path.join(runtimeRoot, '.complete');
  if (fs.existsSync(existing) && fs.existsSync(marker)) return existing;

  log('Fetching Java runtime list…');
  const all = await fetchJson(JAVA_RUNTIME_ALL);
  const plat = all[runtimePlatformKey()] || {};
  const entries = plat[component];
  if (!entries || !entries.length || !entries[0].manifest) {
    throw new Error('No bundled Java runtime available for ' + component + ' on this platform.');
  }
  const manifest = await fetchJson(entries[0].manifest.url);
  const files = manifest.files || {};
  const tasks = [];
  for (const rel of Object.keys(files)) {
    const f = files[rel];
    const dest = path.join(runtimeRoot, component, rel.split('/').join(path.sep));
    if (f.type === 'directory') { fs.mkdirSync(dest, { recursive: true }); continue; }
    if (f.type === 'file' && f.downloads && f.downloads.raw) {
      tasks.push({ url: f.downloads.raw.url, dest, sha1: f.downloads.raw.sha1, exec: !!f.executable });
    }
  }
  send('progress', { done: 0, total: tasks.length, phase: 'Downloading Java runtime' });
  let done = 0, cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const t = tasks[cursor++];
      await download(t.url, t.dest, t.sha1);
      if (t.exec && process.platform !== 'win32') { try { fs.chmodSync(t.dest, 0o755); } catch {} }
      done++;
      if (done % 10 === 0 || done === tasks.length) send('progress', { done, total: tasks.length, phase: 'Downloading Java runtime' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, tasks.length) }, worker));
  if (!fs.existsSync(existing)) throw new Error('Java runtime download finished but java executable not found.');
  fs.writeFileSync(marker, new Date().toISOString());
  return existing;
}

async function resolveLoaderVersion(loader, mcVersion, gameDir, send, log, javaForInstaller) {
  if (loader === 'fabric' || loader === 'quilt') {
    const base = loader === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3';
    const loaders = await fetchJson(`${base}/versions/loader/${mcVersion}`);
    if (!loaders || !loaders.length) throw new Error((loader === 'fabric' ? 'Fabric' : 'Quilt') + ' is not available for Minecraft ' + mcVersion);
    const pick = loaders.find(l => l.loader && l.loader.stable) || loaders[0];
    const lv = pick.loader.version;
    const profile = await fetchJson(`${base}/versions/loader/${mcVersion}/${lv}/profile/json`);
    log('Using ' + (loader === 'fabric' ? 'Fabric' : 'Quilt') + ' loader ' + lv);
    return profile;
  }

  let installerUrl, label;
  if (loader === 'forge') {
    log('Looking up Forge build for ' + mcVersion + '…');
    const promo = await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    const rec = (promo.promos || {})[mcVersion + '-recommended'] || (promo.promos || {})[mcVersion + '-latest'];
    if (!rec) throw new Error('No Forge build found for Minecraft ' + mcVersion);
    label = mcVersion + '-' + rec;
    installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${label}/forge-${label}-installer.jar`;
  } else if (loader === 'neoforge') {
    log('Looking up NeoForge build for ' + mcVersion + '…');
    const meta = await fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
    const prefix = mcVersion.replace(/^1\./, '') + '.';
    const matches = (meta.versions || []).filter(v => v.startsWith(prefix));
    if (!matches.length) throw new Error('No NeoForge build found for Minecraft ' + mcVersion);
    label = matches[matches.length - 1];
    installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${label}/neoforge-${label}-installer.jar`;
  } else {
    throw new Error('Unknown mod loader: ' + loader);
  }

  log('Downloading ' + loader + ' installer ' + label + '…');
  const installerPath = path.join(os.tmpdir(), `${loader}-${label}-installer.jar`);
  await download(installerUrl, installerPath);

  const versionsDir = path.join(MC, 'versions');
  fs.mkdirSync(versionsDir, { recursive: true });
  const before = new Set(fs.readdirSync(versionsDir));

  log('Running the ' + loader + ' installer (this can take a minute)…');
  const res = spawnSync(javaForInstaller, ['-jar', installerPath, '--installClient', MC], { cwd: MC });
  if (res.status !== 0) {
    const out = (res.stdout ? res.stdout.toString() : '') + (res.stderr ? res.stderr.toString() : '');
    throw new Error(loader + ' installer failed: ' + out.slice(-500));
  }

  const after = fs.readdirSync(versionsDir);
  const idDir = after.find(d => !before.has(d)) || after.find(d => d.toLowerCase().includes(loader));
  if (!idDir) throw new Error(loader + ' installer ran but no new version profile was found.');
  const jsonPath = path.join(versionsDir, idDir, idDir + '.json');
  if (!fs.existsSync(jsonPath)) throw new Error('Missing version file after ' + loader + ' install: ' + jsonPath);
  log('Installed ' + loader + ' profile: ' + idDir);
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('config:set', (_e, c) => {
  writeConfig(Object.assign(readConfig(), c));
  if (c && 'autoLaunch' in c) { try { app.setLoginItemSettings({ openAtLogin: !!c.autoLaunch }); } catch {} }
  return true;
});
ipcMain.handle('java:detect', () => findJava());

const RUNTIME_LABEL = {
  'jre-legacy': ['Java 8', 'Legacy'], 'java-runtime-alpha': ['Java 16', 'Alpha'], 'java-runtime-beta': ['Java 17', 'Beta'],
  'java-runtime-gamma': ['Java 17', 'Gamma'], 'java-runtime-gamma-snapshot': ['Java 17', 'Gamma snapshot'],
  'java-runtime-delta': ['Java 21', 'Delta'], 'java-runtime-epsilon': ['Java 25', 'Epsilon']
};
async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    await Promise.all(ents.map(async (e) => {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { try { total += (await fsp.stat(full)).size; } catch {} }
    }));
  }
  return total;
}
ipcMain.handle('java:managed', async () => {
  const base = path.join(ROOT, 'runtimes');
  let names = [];
  try { names = fs.readdirSync(base); } catch {}
  const out = [];
  for (const n of names) {
    if (!/^[a-z0-9\-]+$/.test(n)) continue;
    const dir = path.join(base, n);
    const [major, label] = RUNTIME_LABEL[n] || ['Java', n];
    let ver = '';
    try {
      const rel = fs.readFileSync(path.join(dir, n, 'release'), 'utf8').match(/JAVA_VERSION="([^"]+)"/);
      if (rel) ver = rel[1];
    } catch {}
    out.push({ component: n, title: major, label, version: ver, complete: fs.existsSync(path.join(dir, '.complete')), size: await dirSize(dir) });
  }
  return out;
});
ipcMain.handle('java:install', async (e, component) => {
  if (!RUNTIME_LABEL[String(component)]) return { ok: false, error: 'Unknown Java runtime' };
  const w = senderWin(e);
  const send = (_ch, d) => { if (w && !w.isDestroyed()) w.webContents.send('java:progress', Object.assign({ component }, d)); };
  try {
    await ensureRuntime(String(component), send, () => {});
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('java:remove', (_e, component) => {
  if (!/^[a-z0-9\-]+$/.test(String(component))) return false;
  try { fs.rmSync(path.join(ROOT, 'runtimes', String(component)), { recursive: true, force: true }); return true; } catch { return false; }
});

ipcMain.handle('storage:info', async () => {
  let free = 0, total = 0;
  try { const st = fs.statfsSync(ROOT.length ? (fs.existsSync(ROOT) ? ROOT : app.getPath('appData')) : app.getPath('appData')); free = st.bavail * st.bsize; total = st.blocks * st.bsize; } catch {}
  const parts = [
    ['assets', 'Assets', path.join(MC, 'assets'), true], ['libraries', 'Libraries', path.join(MC, 'libraries'), true],
    ['versions', 'Minecraft versions', path.join(MC, 'versions'), true], ['runtimes', 'Java runtimes', path.join(ROOT, 'runtimes'), false]
  ];
  const items = [];
  for (const [key, label, dir, required] of parts) items.push({ key, label, path: dir, required, size: await dirSize(dir) });
  const insts = [];
  for (const i of readInstances()) { try { insts.push({ id: i.id, name: i.name, size: await dirSize(instDir(i.id)) }); } catch {} }
  return { root: ROOT, free, total, items, instances: insts };
});
ipcMain.handle('pick:dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick:file', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('open:folder', (_e, p) => {
  const target = p ? path.resolve(String(p)) : MC;
  if (target === ROOT || target.startsWith(ROOT + path.sep)) shell.openPath(target);
});

ipcMain.handle('versions:list', async () => {
  if (!manifestCache) manifestCache = await fetchJson(MANIFEST_URL);
  return manifestCache.versions
    .filter(v => v.type === 'release' || v.type === 'snapshot')
    .slice(0, 400)
    .map(v => ({ id: v.id, type: v.type, url: v.url }));
});

ipcMain.handle('instances:list', () => readInstances());

function createInstanceRecord(data) {
  const list = readInstances();
  const name = String(data.name || 'New Instance').trim().slice(0, 24) || 'New Instance';
  const palette = ['#7ef9ff', '#a78bfa', '#ff9ee6', '#8ef0a8', '#ffd27e', '#ff8e8e'];
  const inst = {
    id: genId(),
    name,
    icon: name.charAt(0).toUpperCase() || 'N',
    color: palette[list.length % palette.length],
    version: data.version,
    loader: data.loader || 'vanilla',
    createdAt: Date.now(),
    lastPlayed: null,
    playtimeSeconds: 0
  };
  list.push(inst);
  writeInstances(list);
  fs.mkdirSync(path.join(MC, 'instances', inst.id), { recursive: true });
  return inst;
}

ipcMain.handle('instances:create', (_e, data) => createInstanceRecord(data));

/* ------------------------- install a mod / shader / resource pack / data pack ---- */

const CONTENT_DIRS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };

ipcMain.handle('instances:worlds', (_e, id) => {
  try {
    const saves = path.join(MC, 'instances', String(id).replace(/[^A-Za-z0-9]/g, ''), 'saves');
    return fs.readdirSync(saves, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
});

/* newest release of a project that fits the instance */
async function pickVersion(slugOrId, inst, type) {
  const q = ['game_versions=' + encodeURIComponent(JSON.stringify([inst.version]))];
  if (type === 'mod') {
    const loaders = inst.loader === 'quilt' ? ['quilt', 'fabric'] : [inst.loader];
    q.push('loaders=' + encodeURIComponent(JSON.stringify(loaders)));
  }
  const vers = await fetchJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(slugOrId)}/version?` + q.join('&'));
  if (!Array.isArray(vers) || !vers.length) return null;
  return vers.find(v => v.version_type === 'release') || vers[0];
}
const primaryFile = (ver) => (ver.files || []).find(f => f.primary) || (ver.files || [])[0];


/* ------------------------------------------------------ CurseForge ---- */
const CF_CLASS = { modpack: 4471, mod: 6, resourcepack: 12, shader: 6552, datapack: 6945 };
const CF_LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
function cfGet(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = https.get(CF_PROXY_BASE + pathAndQuery, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'CrystalLauncher/2.3.4' }
    }, (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) { res.resume(); return reject(new Error('CurseForge proxy rejected the request. Check the Worker secret and deployment.')); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('CurseForge proxy HTTP ' + res.statusCode)); }
      res.setEncoding('utf8'); let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('CurseForge request timed out')));
  });
}
ipcMain.handle('cf:test', async () => {
  try { await cfGet('/v1/games/432'); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('net:curseforge', async (_e, o) => {
  o = o || {};
  const type = CF_CLASS[o.type] ? o.type : 'mod';
  const q = new URLSearchParams({ gameId: '432', classId: String(CF_CLASS[type]), pageSize: String(Math.max(1, Math.min(30, Number(o.limit) || 24))), sortField: '2', sortOrder: 'desc' });
  const query = String(o.query || '').slice(0, 80);
  if (query) { q.set('searchFilter', query); q.set('sortField', '1'); }
  const mv = String(o.mcVersion || '');
  if (/^[0-9A-Za-z.\-_]{1,24}$/.test(mv)) q.set('gameVersion', mv);
  const l = (Array.isArray(o.loaders) ? o.loaders : []).map(x => CF_LOADER[x]).filter(Boolean);
  if (l.length === 1 && type === 'mod') q.set('modLoaderType', String(l[0]));
  try {
    const data = await cfGet('/v1/mods/search?' + q.toString());
    const items = (data.data || []).map(m => ({
      slug: String(m.id), source: 'curseforge', type,
      title: String(m.name || ''), description: String(m.summary || ''),
      icon: String((m.logo && m.logo.thumbnailUrl) || ''), banner: String((m.screenshots && m.screenshots[0] && m.screenshots[0].thumbnailUrl) || ''),
      author: String((m.authors && m.authors[0] && m.authors[0].name) || ''), downloads: Number(m.downloadCount) || 0, color: ''
    }));
    return { ok: true, items };
  } catch (e) { return { ok: false, error: e.message }; }
});
function cfPost(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(CF_PROXY_BASE + pathname, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Accept': 'application/json',
        'User-Agent': 'CrystalLauncher/2.3.4'
      }
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('CurseForge proxy HTTP ' + res.statusCode)); }
      res.setEncoding('utf8'); let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('CurseForge request timed out')));
    req.end(data);
  });
}
const cfSafeName = (n) => { n = path.basename(String(n || '')).replace(/[<>:"|?*\x00-\x1f]/g, '_'); if (!n || n === '.' || n === '..') throw new Error('Bad file name from CurseForge.'); return n; };
const cfHostOk = (u) => { try { return /(^|\.)forgecdn\.net$/.test(new URL(u).hostname); } catch { return false; } };
const normName = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/* When an author blocks third-party downloads we never work around it. We only use the same
   project's own Modrinth page if it has a matching name, otherwise the user gets a link. */
async function cfFallbackModrinth(mod, inst, type) {
  try {
    if (!mod || !mod.slug) return null;
    const proj = await fetchJson('https://api.modrinth.com/v2/project/' + encodeURIComponent(mod.slug));
    if (!proj || normName(proj.title) !== normName(mod.name)) return null;
    const ver = await pickVersion(mod.slug, inst, type);
    const f = ver && primaryFile(ver);
    if (!f || new URL(f.url).hostname !== 'cdn.modrinth.com') return null;
    return { url: f.url, sha1: f.hashes && f.hashes.sha1, name: cfSafeName(f.filename), via: 'Modrinth' };
  } catch { return null; }
}
async function cfPlanFile(file, mod, inst, type) {
  if (file.downloadUrl && cfHostOk(file.downloadUrl)) {
    return { url: file.downloadUrl, sha1: ((file.hashes || []).find(h => h.algo === 1) || {}).value, name: cfSafeName(file.fileName) };
  }
  const alt = await cfFallbackModrinth(mod, inst, type);
  if (alt) return alt;
  return { blocked: { name: (mod && mod.name) || file.displayName || file.fileName, url: (mod && mod.links && mod.links.websiteUrl) || '' } };
}
async function cfBestFile(modId, inst, type) {
  const q = new URLSearchParams({ gameVersion: inst.version, pageSize: '30' });
  if (type === 'mod' && CF_LOADER[inst.loader]) q.set('modLoaderType', String(CF_LOADER[inst.loader]));
  const data = await cfGet(`/v1/mods/${encodeURIComponent(modId)}/files?` + q.toString());
  const files = (data.data || []).filter(f => f.isAvailable !== false);
  return files.find(x => x.releaseType === 1) || files[0] || null;
}

async function installCurseForge(inst, type, id, destDir, send) {
  send({ done: 0, total: 0, phase: 'Finding a compatible version…' });
  const top = await cfBestFile(id, inst, type);
  if (!top) throw new Error(`No CurseForge file for Minecraft ${inst.version}` + (type === 'mod' ? ` on ${inst.loader}.` : '.'));
  const plan = [], blocked = [], warnings = [];
  const seen = new Set([Number(id)]);
  const queue = [{ file: top, modId: Number(id), depth: 0 }];
  while (queue.length && plan.length + blocked.length < 30) {
    checkAbort();
    const { file, modId, depth } = queue.shift();
    let mod = null;
    try { mod = (await cfGet('/v1/mods/' + modId)).data; } catch {}
    const r = await cfPlanFile(file, mod, inst, type);
    if (r.blocked) blocked.push(r.blocked); else plan.push(Object.assign(r, { root: depth === 0 }));
    if (type !== 'mod' || depth >= 3) continue;
    for (const dep of file.dependencies || []) {
      if (dep.relationType !== 3 || seen.has(dep.modId)) continue;   // 3 = required
      seen.add(dep.modId);
      try {
        const df = await cfBestFile(dep.modId, inst, 'mod');
        if (df) queue.push({ file: df, modId: dep.modId, depth: depth + 1 });
        else warnings.push('No compatible file for required mod #' + dep.modId + '.');
      } catch { warnings.push('Could not look up required mod #' + dep.modId + '.'); }
    }
  }
  fs.mkdirSync(destDir, { recursive: true });
  let done = 0;
  send({ done, total: plan.length, phase: 'Downloading' });
  for (const t of plan) {
    checkAbort();
    const dest = path.join(destDir, t.name);
    if (path.dirname(dest) !== destDir) throw new Error('Unsafe file name.');
    await download(t.url, dest, t.sha1);
    done++;
    send({ done, total: plan.length, phase: 'Downloading' });
    if (t.via) warnings.push(t.name + ' came from ' + t.via + ' because CurseForge blocks its download.');
  }
  return { ok: true, files: plan.map(p => p.name), extras: plan.filter(p => !p.root).length, warnings, blocked, folder: path.relative(path.resolve(MC, 'instances', inst.id), destDir).split(path.sep).join('/') };
}

async function installCfModpack(packId, nameHint, send) {
  let inst = null;
  const tmp = path.join(os.tmpdir(), 'crystal-' + genId() + '.zip');
  try {
    send({ done: 0, total: 0, phase: 'Finding the latest version…' });
    const list = (await cfGet(`/v1/mods/${encodeURIComponent(packId)}/files?pageSize=20`)).data || [];
    const file = list.filter(f => f.isAvailable !== false).find(f => f.releaseType === 1) || list[0];
    if (!file) throw new Error('This modpack has no downloadable file.');
    if (!file.downloadUrl || !cfHostOk(file.downloadUrl)) throw new Error('The author blocked downloading this modpack outside CurseForge. Get it from its CurseForge page and use Import instead.');
    send({ done: 0, total: 0, phase: 'Downloading modpack…' });
    await download(file.downloadUrl, tmp, ((file.hashes || []).find(h => h.algo === 1) || {}).value);

    const zip = new AdmZip(tmp);
    const me = zip.getEntry('manifest.json');
    if (!me) throw new Error('Not a CurseForge modpack (no manifest.json).');
    const man = JSON.parse(me.getData().toString('utf8'));
    const mc = man.minecraft && man.minecraft.version;
    if (!mc) throw new Error('Modpack does not say which Minecraft version it needs.');
    const ml = ((man.minecraft.modLoaders || []).find(m => m.primary) || (man.minecraft.modLoaders || [])[0] || {}).id || '';
    const loader = /^neoforge/i.test(ml) ? 'neoforge' : /^forge/i.test(ml) ? 'forge' : /^fabric/i.test(ml) ? 'fabric' : /^quilt/i.test(ml) ? 'quilt' : 'vanilla';
    if (!manifestCache) manifestCache = await fetchJson(MANIFEST_URL);
    if (!manifestCache.versions.some(v => v.id === mc)) throw new Error('Minecraft ' + mc + ' is not available.');

    inst = createInstanceRecord({ name: nameHint || man.name || 'Modpack', version: mc, loader });
    const dir = path.resolve(MC, 'instances', inst.id);

    send({ done: 0, total: 0, phase: 'Copying config files…' });
    const prefix = String(man.overrides || 'overrides').replace(/\/?$/, '/');
    for (const en of zip.getEntries()) {
      if (en.isDirectory || !en.entryName.startsWith(prefix)) continue;
      const dest = safeJoin(dir, en.entryName.slice(prefix.length));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, en.getData());
    }

    const refs = (man.files || []).filter(f => f.required !== false);
    send({ done: 0, total: refs.length, phase: 'Looking up mods' });
    const fileInfo = [];
    for (let i = 0; i < refs.length; i += 100) {
      checkAbort();
      const r = await cfPost('/v1/mods/files', { fileIds: refs.slice(i, i + 100).map(f => f.fileID) });
      fileInfo.push(...(r.data || []));
    }
    const byId = new Map(fileInfo.map(f => [f.id, f]));
    const blockedMods = [];
    const tasks = [];
    for (const ref of refs) {
      const f = byId.get(ref.fileID);
      if (!f) { blockedMods.push({ modId: ref.projectID, file: { fileName: 'file ' + ref.fileID } }); continue; }
      if (f.downloadUrl && cfHostOk(f.downloadUrl)) {
        const name = cfSafeName(f.fileName);
        const sub = /\.zip$/i.test(name) ? 'resourcepacks' : 'mods';
        tasks.push({ url: f.downloadUrl, dest: path.join(dir, sub, name), sha1: ((f.hashes || []).find(h => h.algo === 1) || {}).value });
      } else blockedMods.push({ modId: ref.projectID, file: f });
    }

    let done = 0, cursor = 0;
    const total = tasks.length;
    send({ done, total, phase: 'Downloading mods' });
    const worker = async () => {
      while (cursor < tasks.length) {
        checkAbort();
        const t = tasks[cursor++];
        await download(t.url, t.dest, t.sha1);
        done++;
        send({ done, total, phase: 'Downloading mods' });
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, tasks.length) }, worker));

    const blocked = [];
    let viaModrinth = 0;
    if (blockedMods.length) {
      send({ done, total, phase: 'Checking blocked mods' });
      const ids = [...new Set(blockedMods.map(b => b.modId))];
      const mods = new Map();
      for (let i = 0; i < ids.length; i += 100) {
        try { const r = await cfPost('/v1/mods', { modIds: ids.slice(i, i + 100) }); (r.data || []).forEach(m => mods.set(m.id, m)); } catch {}
      }
      for (const b of blockedMods) {
        checkAbort();
        const mod = mods.get(b.modId);
        const alt = await cfFallbackModrinth(mod, inst, 'mod');
        if (alt) { await download(alt.url, path.join(dir, 'mods', alt.name), alt.sha1); viaModrinth++; }
        else blocked.push({ name: (mod && mod.name) || b.file.fileName, url: (mod && mod.links && mod.links.websiteUrl) || '' });
      }
    }
    return { ok: true, instance: inst, version: mc, loader, mods: tasks.length + viaModrinth, blocked };
  } catch (e) {
    if (inst) {
      writeInstances(readInstances().filter(i => i.id !== inst.id));
      try { fs.rmSync(path.join(MC, 'instances', inst.id), { recursive: true, force: true }); } catch {}
    }
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

ipcMain.handle('content:install', async (_e, opts) => {
  if (installing) return { ok: false, error: 'Another install is already running.' };
  opts = opts || {};
  const type = String(opts.type || '');
  const slug = String(opts.slug || '');
  if (!['mod', 'resourcepack', 'shader', 'datapack'].includes(type)) return { ok: false, error: 'Unknown content type.' };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) return { ok: false, error: 'Invalid project id.' };
  const inst = readInstances().find(i => i.id === opts.instanceId);
  if (!inst) return { ok: false, error: 'Pick an instance first.' };
  if (type === 'mod' && (!inst.loader || inst.loader === 'vanilla')) {
    return { ok: false, error: `"${inst.name}" is a Vanilla instance and can't load mods. Make a Fabric, Quilt, Forge or NeoForge instance.` };
  }

  const gameDir = path.resolve(MC, 'instances', inst.id);
  let destDir;
  if (type === 'datapack') {
    const world = String(opts.world || '');
    if (!world || /[\\/]/.test(world) || world === '.' || world === '..') return { ok: false, error: 'Pick a world for this data pack.' };
    const worldDir = path.join(gameDir, 'saves', world);
    if (!fs.existsSync(worldDir)) return { ok: false, error: 'That world does not exist.' };
    destDir = path.join(worldDir, 'datapacks');
  } else {
    destDir = path.join(gameDir, CONTENT_DIRS[type]);
  }

  installing = true;
  installAbort = false;
  const send = (d) => { if (win && !win.isDestroyed()) win.webContents.send('install:progress', d); };
  try {
    if (opts.source === 'curseforge') return await installCurseForge(inst, type, slug, destDir, send);
    send({ done: 0, total: 0, phase: 'Finding a compatible version…' });
    const top = await pickVersion(slug, inst, type);
    if (!top) throw new Error(`No version of this is available for Minecraft ${inst.version}` + (type === 'mod' ? ` on ${inst.loader}.` : '.'));

    /* collect the file plus (for mods) every required dependency */
    const plan = [];
    const warnings = [];
    const seen = new Set([top.project_id]);
    const queue = [{ ver: top, depth: 0 }];
    while (queue.length && plan.length < 30) {
      checkAbort();
      const { ver, depth } = queue.shift();
      const f = primaryFile(ver);
      if (!f) { warnings.push('A version had no file.'); continue; }
      let host = '';
      try { host = new URL(f.url).hostname; } catch {}
      if (host !== 'cdn.modrinth.com') throw new Error('Unexpected download host.');
      const name = path.basename(String(f.filename || '')).replace(/[<>:"|?*\x00-\x1f]/g, '_');
      if (!name || name === '.' || name === '..') throw new Error('Bad file name from Modrinth.');
      plan.push({ url: f.url, sha1: f.hashes && f.hashes.sha1, name, label: ver.name || name, root: depth === 0 });
      if (type !== 'mod' || depth >= 4) continue;
      for (const dep of ver.dependencies || []) {
        if (dep.dependency_type !== 'required' || !dep.project_id || seen.has(dep.project_id)) continue;
        seen.add(dep.project_id);
        try {
          let dv = null;
          if (dep.version_id) dv = await fetchJson(`https://api.modrinth.com/v2/version/${encodeURIComponent(dep.version_id)}`);
          else dv = await pickVersion(dep.project_id, inst, 'mod');
          if (dv) queue.push({ ver: dv, depth: depth + 1 });
          else warnings.push('Could not find a compatible required mod (' + dep.project_id + ').');
        } catch { warnings.push('Could not look up a required mod (' + dep.project_id + ').'); }
      }
    }

    fs.mkdirSync(destDir, { recursive: true });
    let done = 0;
    send({ done, total: plan.length, phase: 'Downloading' });
    for (const t of plan) {
      checkAbort();
      const dest = path.join(destDir, t.name);
      if (path.dirname(dest) !== destDir) throw new Error('Unsafe file name.');
      await download(t.url, dest, t.sha1);
      done++;
      send({ done, total: plan.length, phase: 'Downloading' });
    }
    return { ok: true, files: plan.map(p => p.name), extras: plan.filter(p => !p.root).length, warnings, folder: path.relative(gameDir, destDir).split(path.sep).join('/') };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    installing = false;
  }
});

/* ------------------------------------------------ manage installed content ---- */

const MANAGE_LOADERS = { resourcepack: ['minecraft'], shader: ['iris', 'optifine', 'canvas', 'vanilla'] };
const manageDir = (inst, type) => path.join(instDir(inst.id), CONTENT_DIRS[type]);
const instById = (id) => readInstances().find(i => i.id === id);

/* only plain .jar/.zip file names (optionally .disabled), never a path */
function safeContentName(n) {
  n = String(n || '');
  if (n !== path.basename(n) || n.startsWith('.') || !/\.(jar|zip)(\.disabled)?$/i.test(n)) throw new Error('Bad file name.');
  return n;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'User-Agent': 'CrystalLauncher/2.2', 'Accept': 'application/json' }
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode })); }
      res.setEncoding('utf8');
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
    req.end(data);
  });
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

const fileInfoCache = new Map();   // "path|size|mtime" -> { sha1, meta }
const knownHash = new Map();       // sha1 -> { project, version } | null (not on Modrinth)

ipcMain.handle('content:list', async (_e, o) => {
  try {
    const type = String((o && o.type) || '');
    if (!CONTENT_DIRS[type]) return { ok: false, error: 'Unknown type.' };
    const inst = instById(o.instanceId);
    if (!inst) return { ok: false, error: 'Instance not found.' };
    const dir = manageDir(inst, type);
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && /\.(jar|zip)(\.disabled)?$/i.test(d.name)).map(d => d.name); } catch {}

    const items = [];
    await pool(names, 4, async (name) => {
      const full = path.join(dir, name);
      const st = await fsp.stat(full);
      const key = `${full}|${st.size}|${st.mtimeMs}`;
      let info = fileInfoCache.get(key);
      if (!info) {
        info = { sha1: await sha1File(full), meta: null };
        if (type === 'mod') { try { info.meta = readJarMeta(new AdmZip(full)); } catch { info.meta = null; } }
        fileInfoCache.set(key, info);
      }
      const enabled = !/\.disabled$/i.test(name);
      const base = name.replace(/\.disabled$/i, '').replace(/\.(jar|zip)$/i, '');
      items.push({
        file: name, enabled, size: st.size, sha1: info.sha1,
        name: (info.meta && info.meta.name) || base, version: (info.meta && info.meta.version) || '',
        modId: (info.meta && info.meta.id) || '', depends: (info.meta && info.meta.depends) || [],
        source: 'local', title: '', icon: '', slug: '', projectId: '', versionId: ''
      });
    });

    /* who is this on Modrinth? one request for all hashes (sha1 lookup, like Prism does) */
    let offline = false;
    const unknown = items.filter(i => !knownHash.has(i.sha1)).map(i => i.sha1);
    if (unknown.length) {
      try {
        const found = await postJson('https://api.modrinth.com/v2/version_files', { hashes: unknown, algorithm: 'sha1' });
        const projIds = [...new Set(Object.values(found).map(v => v.project_id))];
        const projects = {};
        for (let k = 0; k < projIds.length; k += 100) {
          const chunk = projIds.slice(k, k + 100);
          const list = await fetchJson('https://api.modrinth.com/v2/projects?ids=' + encodeURIComponent(JSON.stringify(chunk)));
          for (const p of list) projects[p.id] = p;
        }
        for (const h of unknown) {
          const v = found[h];
          knownHash.set(h, v ? { version: { id: v.id, name: v.version_number, project_id: v.project_id }, project: projects[v.project_id] || null } : null);
        }
      } catch { offline = true; }
    }
    for (const it of items) {
      const k = knownHash.get(it.sha1);
      if (!k) continue;
      it.source = 'modrinth';
      it.projectId = k.version.project_id;
      it.versionId = k.version.id;
      if (k.project) { it.title = k.project.title || ''; it.icon = k.project.icon_url || ''; it.slug = k.project.slug || ''; }
      if (it.title) it.name = it.title;
      if (k.version.name) it.version = k.version.name;
    }

    /* which enabled mods need which (by mod id) */
    const byId = new Map(items.filter(i => i.modId).map(i => [i.modId, i]));
    for (const it of items) it.neededBy = [];
    for (const it of items) {
      if (!it.enabled) continue;
      for (const d of it.depends) { const t = byId.get(d); if (t && t !== it) t.neededBy.push(it.name); }
    }
    items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return { ok: true, items, offline };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('content:toggle', (_e, o) => {
  try {
    if (!CONTENT_DIRS[o.type]) throw new Error('Unknown type.');
    const inst = instById(o.instanceId);
    if (!inst) throw new Error('Instance not found.');
    const dir = manageDir(inst, o.type);
    const name = safeContentName(o.file);
    const wasDisabled = /\.disabled$/i.test(name);
    const next = wasDisabled ? name.replace(/\.disabled$/i, '') : name + '.disabled';
    if (fs.existsSync(path.join(dir, next))) throw new Error('A file named ' + next + ' already exists.');
    fs.renameSync(path.join(dir, name), path.join(dir, next));
    return { ok: true, file: next, enabled: wasDisabled };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('content:remove', (_e, o) => {
  try {
    if (!CONTENT_DIRS[o.type]) throw new Error('Unknown type.');
    const inst = instById(o.instanceId);
    if (!inst) throw new Error('Instance not found.');
    fs.unlinkSync(path.join(manageDir(inst, o.type), safeContentName(o.file)));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* newest compatible version for every identified file (Modrinth's hash-update endpoint, as Prism uses) */
ipcMain.handle('content:updates', async (_e, o) => {
  try {
    const type = String((o && o.type) || '');
    if (!CONTENT_DIRS[type]) throw new Error('Unknown type.');
    const inst = instById(o.instanceId);
    if (!inst) throw new Error('Instance not found.');
    const hashes = (Array.isArray(o.files) ? o.files : []).map(f => String(f.sha1 || '')).filter(h => /^[a-f0-9]{40}$/.test(h));
    if (!hashes.length) return { ok: true, updates: {} };
    const loaders = type === 'mod' ? (inst.loader === 'quilt' ? ['quilt', 'fabric'] : [inst.loader]) : MANAGE_LOADERS[type];
    const body = { hashes, algorithm: 'sha1', game_versions: [inst.version] };
    if (type !== 'mod' || (loaders[0] && loaders[0] !== 'vanilla')) body.loaders = loaders;
    const res = await postJson('https://api.modrinth.com/v2/version_files/update', body);
    const updates = {};
    for (const h of hashes) {
      const v = res[h];
      if (!v) continue;
      const f = primaryFile(v);
      if (!f || (f.hashes && f.hashes.sha1 === h)) continue;           // already the newest file
      updates[h] = { versionId: v.id, version: v.version_number || v.name || '', filename: f.filename };
    }
    return { ok: true, updates };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* download the new file first, delete the old one only after that worked (a failure leaves things as they were) */
ipcMain.handle('content:update', async (_e, o) => {
  if (installing) return { ok: false, error: 'Another install is already running.' };
  installing = true;
  try {
    if (!CONTENT_DIRS[o.type]) throw new Error('Unknown type.');
    const inst = instById(o.instanceId);
    if (!inst) throw new Error('Instance not found.');
    const dir = manageDir(inst, o.type);
    const oldName = safeContentName(o.file);
    if (!fs.existsSync(path.join(dir, oldName))) throw new Error('That file is gone.');
    if (!/^[A-Za-z0-9]{8}$/.test(String(o.versionId))) throw new Error('Bad version id.');
    const ver = await fetchJson('https://api.modrinth.com/v2/version/' + o.versionId);
    const f = primaryFile(ver);
    if (!f || new URL(f.url).hostname !== 'cdn.modrinth.com') throw new Error('Unexpected download host.');
    let newName = path.basename(String(f.filename)).replace(/[<>:"|?*\x00-\x1f]/g, '_');
    if (!newName || newName.startsWith('.')) throw new Error('Bad file name from Modrinth.');
    const wasDisabled = /\.disabled$/i.test(oldName);
    const finalName = newName + (wasDisabled ? '.disabled' : '');
    const dest = path.join(dir, finalName);
    if (path.dirname(dest) !== dir) throw new Error('Unsafe file name.');
    await download(f.url, dest, f.hashes && f.hashes.sha1);
    if (finalName !== oldName) { try { fs.unlinkSync(path.join(dir, oldName)); } catch {} }
    return { ok: true, file: finalName };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { installing = false; }
});

/* ------------------------------------------- install modpack (.mrpack) ---- */

const MODPACK_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
let installing = false;
let installAbort = false;
const checkAbort = () => { if (installAbort) throw new Error('Install cancelled.'); };
ipcMain.handle('install:cancel', () => { installAbort = true; return true; });

/* join a path from inside a downloaded pack, refusing anything that escapes the instance folder */
function safeJoin(base, rel) {
  const full = path.resolve(base, String(rel).split('/').join(path.sep));
  if (full === base || !full.startsWith(base + path.sep)) throw new Error('Unsafe path in modpack: ' + rel);
  return full;
}

const installProgress = (d) => { if (win && !win.isDestroyed()) win.webContents.send('install:progress', d); };

/* tries each mirror in order (the .mrpack format lists fallbacks), like Prism does */
async function downloadAny(urls, dest, sha1) {
  let last;
  for (const u of urls) {
    try { return await download(u, dest, sha1); } catch (e) { last = e; checkAbort(); }
  }
  throw last || new Error('No download link.');
}

/*
 * Installs a Modrinth .mrpack (a zip) from disk into a brand-new instance.
 * On any failure (or cancel) the half-built instance is removed again.
 */
async function installMrpackFile(zipPath, nameHint, send) {
  let inst = null;
  try {
    const zip = new AdmZip(zipPath);
    const idxEntry = zip.getEntry('modrinth.index.json');
    if (!idxEntry) throw new Error('Not a valid Modrinth modpack (no modrinth.index.json).');
    const index = JSON.parse(idxEntry.getData().toString('utf8'));
    if (index.game && index.game !== 'minecraft') throw new Error('This pack is not for Minecraft.');
    const deps = index.dependencies || {};
    const mc = deps.minecraft;
    if (!mc) throw new Error('Modpack does not say which Minecraft version it needs.');
    const loader = deps['fabric-loader'] ? 'fabric' : deps['quilt-loader'] ? 'quilt'
      : deps.neoforge ? 'neoforge' : deps.forge ? 'forge' : 'vanilla';

    if (!manifestCache) manifestCache = await fetchJson(MANIFEST_URL);
    if (!manifestCache.versions.some(v => v.id === mc)) throw new Error('Minecraft ' + mc + ' is not available.');

    inst = createInstanceRecord({ name: nameHint || index.name || 'Modpack', version: mc, loader });
    const dir = path.resolve(MC, 'instances', inst.id);

    send({ done: 0, total: 0, phase: 'Copying config files…' });
    for (const prefix of ['overrides/', 'client-overrides/']) {
      for (const en of zip.getEntries()) {
        if (en.isDirectory || !en.entryName.startsWith(prefix)) continue;
        const dest = safeJoin(dir, en.entryName.slice(prefix.length));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, en.getData());
      }
    }

    const tasks = [];
    for (const f of index.files || []) {
      if (f.env && f.env.client === 'unsupported') continue;
      const dest = safeJoin(dir, f.path);
      const urls = (f.downloads || []).map(u => String(u).trim().replace(/ /g, '%20')).filter(u => {
        try { const x = new URL(u); return x.protocol === 'https:' && MODPACK_HOSTS.includes(x.hostname); } catch { return false; }
      });
      if (!urls.length) throw new Error('No trusted download link for ' + f.path);
      tasks.push({ urls, dest, sha1: f.hashes && f.hashes.sha1 });
    }

    let done = 0, cursor = 0;
    send({ done, total: tasks.length, phase: 'Downloading mods' });
    const worker = async () => {
      while (cursor < tasks.length) {
        checkAbort();
        const t = tasks[cursor++];
        await downloadAny(t.urls, t.dest, t.sha1);
        done++;
        send({ done, total: tasks.length, phase: 'Downloading mods' });
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, tasks.length) }, worker));

    return { ok: true, instance: inst, version: mc, loader, mods: tasks.length };
  } catch (e) {
    if (inst) {
      writeInstances(readInstances().filter(i => i.id !== inst.id));
      try { fs.rmSync(path.join(MC, 'instances', inst.id), { recursive: true, force: true }); } catch {}
    }
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('modpack:install', async (_e, opts) => {
  if (installing) return { ok: false, error: 'Another install is already running.' };
  const slug = String((opts && opts.slug) || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) return { ok: false, error: 'Invalid modpack id.' };
  installing = true;
  installAbort = false;
  if (opts && opts.source === 'curseforge') {
    try { return await installCfModpack(slug, (opts && opts.title) || '', installProgress); }
    finally { installing = false; }
  }
  const tmp = path.join(os.tmpdir(), 'crystal-' + genId() + '.mrpack');
  try {
    installProgress({ done: 0, total: 0, phase: 'Finding the latest version…' });
    const vers = await fetchJson(`https://api.modrinth.com/v2/project/${slug}/version`);
    const isPack = (f) => /\.mrpack$/i.test(String(f.filename || ''));
    const ver = (Array.isArray(vers) ? vers : []).find(v => (v.files || []).some(isPack));
    if (!ver) throw new Error('This modpack has no installable version.');
    const file = ver.files.find(f => f.primary && isPack(f)) || ver.files.find(isPack);
    if (new URL(file.url).hostname !== 'cdn.modrinth.com') throw new Error('Unexpected download host.');
    installProgress({ done: 0, total: 0, phase: 'Downloading modpack…' });
    await download(file.url, tmp, file.hashes && file.hashes.sha1);
    return await installMrpackFile(tmp, (opts && opts.title) || '', installProgress);
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    installing = false;
    try { fs.unlinkSync(tmp); } catch {}
  }
});

/* import a .mrpack the user already has on disk */
ipcMain.handle('modpack:import-file', async () => {
  if (installing) return { ok: false, error: 'Another install is already running.' };
  const r = await dialog.showOpenDialog(win, { title: 'Import a Modrinth modpack', properties: ['openFile'], filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  installing = true;
  installAbort = false;
  try {
    const name = path.basename(r.filePaths[0]).replace(/\.mrpack$/i, '');
    return await installMrpackFile(r.filePaths[0], name, installProgress);
  } finally { installing = false; }
});

/* ------------------------------------------- instance copy and settings ---- */

ipcMain.handle('instances:copy', async (_e, id) => {
  try {
    const src = instById(id);
    if (!src) throw new Error('Instance not found.');
    const copy = createInstanceRecord({ name: (src.name + ' copy').slice(0, 24), version: src.version, loader: src.loader });
    const list = readInstances();
    const rec = list.find(i => i.id === copy.id);
    if (src.settings) rec.settings = JSON.parse(JSON.stringify(src.settings));
    writeInstances(list);
    try {
      await fsp.cp(instDir(src.id), instDir(copy.id), { recursive: true, force: true });
    } catch (e) {
      writeInstances(readInstances().filter(i => i.id !== copy.id));
      try { fs.rmSync(instDir(copy.id), { recursive: true, force: true }); } catch {}
      throw e;
    }
    return { ok: true, instance: rec };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* per-instance overrides; anything left empty falls back to the global setting */
ipcMain.handle('instances:settings', (_e, { id, settings }) => {
  const list = readInstances();
  const inst = list.find(i => i.id === id);
  if (!inst) return null;
  const st = settings || {};
  const num = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : 0; };
  const clean = {
    ram: num(st.ram, 512, 65536),
    width: num(st.width, 320, 7680),
    height: num(st.height, 240, 4320),
    java: String(st.java || '').trim().slice(0, 500),
    jvmArgs: String(st.jvmArgs || '').trim().slice(0, 600)
  };
  if (!clean.width || !clean.height) { clean.width = 0; clean.height = 0; }
  inst.settings = clean;
  writeInstances(list);
  return inst;
});

ipcMain.handle('instances:delete', (_e, id) => {
  const list = readInstances().filter(i => i.id !== id);
  writeInstances(list);
  try { fs.rmSync(instDir(id), { recursive: true, force: true }); } catch {}
  return true;
});

ipcMain.handle('instances:rename', (_e, { id, name }) => {
  const list = readInstances();
  const inst = list.find(i => i.id === id);
  if (inst) { inst.name = (name || inst.name).trim() || inst.name; inst.icon = inst.name.charAt(0).toUpperCase(); writeInstances(list); }
  return inst;
});

ipcMain.handle('open:instance-folder', (_e, id) => {
  try { shell.openPath(instDir(id)); } catch {}
});

ipcMain.handle('kill', () => {
  killedByUser = true;
  if (child) { try { child.kill(); } catch {} }
  running = false;
});

/* ----------------------------------------------------- crash helper ---- */

function newestFile(dir, test, sinceMs) {
  try {
    return fs.readdirSync(dir).filter(test)
      .map(f => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter(x => x.t >= sinceMs).sort((a, b) => b.t - a.t)[0] || null;
  } catch { return null; }
}
const readHead = (p, max) => { try { return fs.readFileSync(p, 'utf8').slice(0, max); } catch { return ''; } };

function buildCrash(gameDir, launchStart, code) {
  const since = launchStart - 5000;
  const report = newestFile(path.join(gameDir, 'crash-reports'), f => /\.txt$/i.test(f), since);
  const hs = newestFile(gameDir, f => /^hs_err_pid\d+\.log$/i.test(f), since);
  const tail = gameTail.join('\n');
  const reportText = report ? readHead(report.f, 60000) : '';
  const hsText = hs ? readHead(hs.f, 20000) : '';
  const all = [tail, reportText, hsText].filter(Boolean).join('\n\n');
  lastCrash = { text: all, reportPath: report ? report.f : (hs ? hs.f : null) };
  return { code, diagnoses: diag.diagnose(all), hasReport: !!lastCrash.reportPath };
}

ipcMain.handle('crash:open-report', () => {
  if (lastCrash && lastCrash.reportPath && fs.existsSync(lastCrash.reportPath)) { shell.showItemInFolder(lastCrash.reportPath); return true; }
  return false;
});

/* sends the (scrubbed) log to mclo.gs and returns the share link. Only ever called from a button click. */
ipcMain.handle('crash:upload', () => new Promise((resolve) => {
  if (!lastCrash || !lastCrash.text) return resolve({ ok: false, error: 'There is no log to upload.' });
  const text = diag.redact(lastCrash.text.slice(-1500000), [lastCrash.secret]);
  const body = 'content=' + encodeURIComponent(text);
  const req = https.request('https://api.mclo.gs/1/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'CrystalLauncher/2.2' }
  }, (res) => {
    res.setEncoding('utf8');
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const j = JSON.parse(d);
        if (j.success && /^https:\/\/mclo\.gs\//.test(String(j.url))) return resolve({ ok: true, url: j.url });
        resolve({ ok: false, error: String(j.error || 'The log service refused the upload.') });
      } catch { resolve({ ok: false, error: 'Unexpected reply from the log service.' }); }
    });
  });
  req.on('error', (e) => resolve({ ok: false, error: e.message }));
  req.setTimeout(20000, () => req.destroy(new Error('Upload timed out.')));
  req.end(body);
}));


/* ------------------------------------------------------- servers ---- */
function mcVarInt(n) { const b = []; do { let t = n & 127; n >>>= 7; if (n) t |= 128; b.push(t); } while (n); return Buffer.from(b); }
function mcStr(str) { const d = Buffer.from(str, 'utf8'); return Buffer.concat([mcVarInt(d.length), d]); }
function mcPacket(id, data) { const body = Buffer.concat([mcVarInt(id), data]); return Buffer.concat([mcVarInt(body.length), body]); }
function motdText(m) {
  if (!m) return '';
  if (typeof m === 'string') return m.replace(/§./g, '');
  let t = typeof m.text === 'string' ? m.text : '';
  if (Array.isArray(m.extra)) t += m.extra.map(motdText).join('');
  return t.replace(/§./g, '');
}
function splitHost(addr) {
  const a = String(addr || '').trim();
  const m = a.match(/^(.+?):(\d{1,5})$/);
  return m ? { host: m[1], port: parseInt(m[2], 10) } : { host: a, port: 25565 };
}
ipcMain.handle('servers:ping', (_e, addr) => new Promise((resolve) => {
  const { host, port } = splitHost(addr);
  if (!host) return resolve({ online: false });
  const net = require('net');
  const started = Date.now();
  let buf = Buffer.alloc(0), done = false;
  const sock = net.connect({ host, port, timeout: 5000 });
  const finish = (r) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(r); };
  sock.on('connect', () => {
    const hs = Buffer.concat([mcVarInt(767), mcStr(host), Buffer.from([port >> 8, port & 255]), mcVarInt(1)]);
    sock.write(Buffer.concat([mcPacket(0, hs), mcPacket(0, Buffer.alloc(0))]));
  });
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    try {
      let o = 0;
      const rv = () => { let n = 0, sh = 0, b; do { if (o >= buf.length) throw new Error('more'); b = buf[o++]; n |= (b & 127) << sh; sh += 7; } while (b & 128); return n; };
      const len = rv(); const end = o + len;
      if (buf.length < end) return;
      rv(); const sl = rv();
      if (buf.length < o + sl) return;
      const j = JSON.parse(buf.slice(o, o + sl).toString('utf8'));
      finish({
        online: true, ping: Date.now() - started, motd: motdText(j.description).trim(),
        version: (j.version && j.version.name) || '', players: j.players ? j.players.online : 0, max: j.players ? j.players.max : 0
      });
    } catch (e) { if (e.message !== 'more') finish({ online: false }); }
  });
  sock.on('timeout', () => finish({ online: false }));
  sock.on('error', () => finish({ online: false }));
  setTimeout(() => finish({ online: false }), 7000);
}));

ipcMain.handle('launch', async (_e, opts) => {
  if (running) return { ok: false, error: 'Already running' };
  const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };
  const log = (t) => send('log', t);

  try {
    running = true;
    killedByUser = false;
    gameTail = [];
    lastCrash = null;
    const cfg = Object.assign(readConfig(), opts || {});
    const joinServer = cfg.server ? splitHost(cfg.server) : null;
    delete cfg.server;
    writeConfig(cfg);
    const username = (cfg.username || '').trim() || 'Player';
    const instanceId = cfg.instanceId || null;
    if (instanceId) instDir(instanceId);            // refuses anything that is not a real instance id

    /* per-instance overrides sit on top of the global settings */
    let extraJvm = String(cfg.jvmArgs || '');
    if (instanceId) {
      const own = readInstances().find(i => i.id === instanceId);
      const st = (own && own.settings) || {};
      if (st.ram) cfg.ram = st.ram;
      if (st.java) cfg.java = st.java;
      if (st.width && st.height) { cfg.width = st.width; cfg.height = st.height; cfg.customRes = true; }
      if (st.jvmArgs) extraJvm += ' ' + st.jvmArgs;
    }

    log('Resolving version ' + cfg.version + '…');
    if (!manifestCache) manifestCache = await fetchJson(MANIFEST_URL);
    const entry = manifestCache.versions.find(v => v.id === cfg.version);
    if (!entry) throw new Error('Unknown version');

    let version = await fetchJson(entry.url);

    const gameDir = instanceId ? instDir(instanceId) : MC;
    const libDir = path.join(MC, 'libraries');
    const assetsDir = path.join(MC, 'assets');
    const nativesDir = path.join(MC, 'natives', cfg.version);
    const versionDir = path.join(MC, 'versions', cfg.version);
    fs.rmSync(nativesDir, { recursive: true, force: true });
    fs.mkdirSync(versionDir, { recursive: true });
    fs.mkdirSync(gameDir, { recursive: true });

    let javaPath = cfg.java;
    const need = (version.javaVersion && version.javaVersion.majorVersion) || 8;
    const component = (version.javaVersion && version.javaVersion.component) || (need >= 17 ? 'java-runtime-gamma' : 'jre-legacy');
    if (javaPath) {
      // a Java chosen in settings must actually run and be new enough, or the game dies with an obscure error
      const major = fs.existsSync(javaPath) ? javaMajor(javaPath) : 0;
      if (!major) throw new Error('The Java you selected cannot be run: ' + javaPath + '. Clear it in Settings to use automatic Java.');
      if (major < need) throw new Error(`Minecraft ${cfg.version} needs Java ${need} or newer, but the Java you selected is Java ${major}. Clear it in Settings to use automatic Java.`);
    } else {
      const pick = pickJava(findJava(), need);
      if (pick) {
        javaPath = pick.path;
      } else {
        log(`No Java ${need} found — downloading a matching runtime automatically…`);
        javaPath = await ensureRuntime(component, send, log);
      }
    }
    log('Using Java: ' + javaPath);

    const loader = cfg.loader || 'vanilla';
    if (loader !== 'vanilla') {
      const childJson = await resolveLoaderVersion(loader, cfg.version, gameDir, send, log, javaPath);
      version = mergeInherits(childJson, version);
    }

    const clientJar = path.join(versionDir, cfg.version + '.jar');
    await download(version.downloads.client.url, clientJar, version.downloads.client.sha1);

    const classpath = [];
    const tasks = [];
    const nativeJars = [];
    for (const lib of version.libraries || []) {
      if (!ruleAllows(lib.rules, {})) continue;
      const dl = lib.downloads || {};
      const isNative = Boolean(lib.natives && lib.natives[osName()]) || /:natives-/.test(lib.name);
      if (isNative) {
        let art = null;
        if (lib.natives && lib.natives[osName()] && dl.classifiers)
          art = dl.classifiers[lib.natives[osName()].replace('${arch}', process.arch === 'ia32' ? '32' : '64')];
        if (!art) art = dl.artifact;
        if (art) {
          const dest = path.join(libDir, art.path || mavenPath(lib.name));
          tasks.push({ url: art.url, dest, sha1: art.sha1, critical: true, name: lib.name });
          nativeJars.push({ dest, exclude: (lib.extract && lib.extract.exclude) || ['META-INF/'] });
        }
        continue;
      }
      if (dl.artifact) {
        const dest = path.join(libDir, dl.artifact.path || mavenPath(lib.name));
        tasks.push({ url: dl.artifact.url, dest, sha1: dl.artifact.sha1, critical: true, name: lib.name });
        classpath.push(dest);
      } else if (lib.name) {
        const p = mavenPath(lib.name);
        const dest = path.join(libDir, p);
        const base = lib.url || LIBRARIES;
        tasks.push({ url: base.replace(/\/?$/, '/') + p, dest, critical: true, name: lib.name });
        classpath.push(dest);
      }
    }
    classpath.push(clientJar);

    const assetNames = [];
    if (version.assetIndex) {
      const idxPath = path.join(assetsDir, 'indexes', version.assetIndex.id + '.json');
      await download(version.assetIndex.url, idxPath, version.assetIndex.sha1);
      const objects = JSON.parse(fs.readFileSync(idxPath, 'utf8')).objects || {};
      for (const name in objects) {
        const o = objects[name];
        tasks.push({
          url: RESOURCES + o.hash.slice(0, 2) + '/' + o.hash,
          dest: path.join(assetsDir, 'objects', o.hash.slice(0, 2), o.hash),
          sha1: o.hash
        });
        assetNames.push(name);
      }
    }

    const total = tasks.length;
    let done = 0;
    const failedTasks = [];
    send('progress', { done, total, phase: 'Downloading ' + total + ' files' });
    let cursor = 0;
    const worker = async () => {
      while (cursor < tasks.length) {
        const t = tasks[cursor++];
        try { await download(t.url, t.dest, t.sha1); }
        catch (e) { t.error = e; failedTasks.push(t); }
        done++;
        if (done % 8 === 0 || done === total)
          send('progress', { done, total, phase: 'Downloading' + (failedTasks.length ? ` (${failedTasks.length} failed)` : '') });
      }
    };
    await Promise.all(Array.from({ length: Math.min(24, tasks.length) }, worker));

    /* second chance for anything that failed (busy servers recover), gently this time */
    if (failedTasks.length) {
      log(`${failedTasks.length} file(s) failed — retrying…`);
      const again = failedTasks.splice(0).filter(t => !(t.error && [403, 404, 410].includes(t.error.status)) || t.critical);
      let c2 = 0;
      const worker2 = async () => {
        while (c2 < again.length) {
          const t = again[c2++];
          try { await sleep(300); await download(t.url, t.dest, t.sha1); t.error = null; }
          catch (e) { t.error = e; failedTasks.push(t); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, again.length) }, worker2));
    }
    const missingCritical = failedTasks.filter(t => t.critical);
    if (missingCritical.length) {
      const names = missingCritical.slice(0, 3).map(t => t.name || path.basename(t.dest)).join(', ');
      throw new Error(`Could not download ${missingCritical.length} required file(s) (${names}${missingCritical.length > 3 ? ', …' : ''}). Check your internet connection and try again.`);
    }
    if (failedTasks.length) log(`Warning: ${failedTasks.length} optional file(s) (sounds/textures) could not be downloaded. The game will still start.`);

    for (const n of nativeJars) {
      if (fs.existsSync(n.dest)) { try { extractNatives(n.dest, nativesDir, n.exclude); } catch { log('native extract failed: ' + n.dest); } }
    }

    if (version.assetIndex && ['legacy', 'pre-1.6'].includes(version.assetIndex.id)) {
      const vdir = path.join(assetsDir, 'virtual', version.assetIndex.id);
      const idxPath = path.join(assetsDir, 'indexes', version.assetIndex.id + '.json');
      const objects = JSON.parse(fs.readFileSync(idxPath, 'utf8')).objects || {};
      for (const name of assetNames) {
        const h = objects[name].hash;
        const src = path.join(assetsDir, 'objects', h.slice(0, 2), h);
        const dst = path.join(vdir, name);
        if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
      }
    }

    let logConfig = '';
    if (version.logging && version.logging.client && version.logging.client.file) {
      logConfig = path.join(versionDir, 'log4j.xml');
      await download(version.logging.client.file.url, logConfig, version.logging.client.file.sha1);
    }

    const cpSep = process.platform === 'win32' ? ';' : ':';
    const subs = {
      auth_player_name: username,
      version_name: cfg.version,
      game_directory: gameDir,
      assets_root: assetsDir,
      assets_index_name: version.assetIndex ? version.assetIndex.id : 'legacy',
      auth_uuid: offlineUuid(username),
      auth_access_token: crypto.randomBytes(16).toString('hex'),
      clientid: '0', auth_xuid: '0',
      user_type: 'legacy',
      version_type: version.type || 'release',
      natives_directory: nativesDir,
      launcher_name: 'CrystalLauncher',
      launcher_version: '2.0',
      classpath,
      classpath_separator: cpSep,
      library_directory: libDir,
      resolution_width: String(cfg.width || 1280),
      resolution_height: String(cfg.height || 720),
      path: logConfig
    };

    const features = { has_custom_resolution: !!cfg.customRes, is_quick_play_multiplayer: !!joinServer };
    if (joinServer) subs.quickPlayMultiplayer = joinServer.host + ':' + joinServer.port;
    const fill = (s) => String(s).replace(/\$\{([a-z_]+)\}/gi, (m, k) => {
      const v = subs[k];
      if (Array.isArray(v)) return v.join(subs.classpath_separator);
      return (k in subs ? v : '');
    });

    const args = [];
    const ram = Math.max(1024, Math.min(32768, Number(cfg.ram) || 3072));
    args.push(`-Xmx${ram}M`, `-Xms${Math.round(ram / 2)}M`);
    args.push('-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4', '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32', '-XX:MaxTenuringThreshold=1', '-Dusing.aikars.flags=https://mcflags.emc.gs');

    /* your own JVM arguments go right after the defaults so they can override them */
    for (const a of splitArgs(extraJvm)) args.push(a);

    const jvm = (version.arguments && version.arguments.jvm) || [];
    for (const a of jvm) {
      if (typeof a === 'string') args.push(fill(a));
      else if (ruleAllows(a.rules, features)) {
        const vals = Array.isArray(a.value) ? a.value : [a.value];
        for (const v of vals) args.push(fill(v));
      }
    }

    args.push(version.mainClass);
    if (version.arguments && version.arguments.game) {
      for (const a of version.arguments.game) {
        if (typeof a === 'string') args.push(fill(a));
        else if (ruleAllows(a.rules, features)) {
          const vals = Array.isArray(a.value) ? a.value : [a.value];
          for (const v of vals) args.push(fill(v));
        }
      }
    } else if (version.minecraftArguments) {
      for (const a of version.minecraftArguments.split(' ')) args.push(fill(a));
    }
    if (joinServer && !args.includes('--quickPlayMultiplayer')) args.push('--server', joinServer.host, '--port', String(joinServer.port));
    if (joinServer) log('Joining server ' + joinServer.host + ':' + joinServer.port);

    log('Starting Minecraft…');
    send('progress', { done: total, total, phase: 'Launching' });

    const launchStart = Date.now();
    child = spawn(javaPath, args, { cwd: gameDir, windowsHide: true });
    const onOut = (d) => {
      const txt = d.toString().trimEnd();
      log(txt);
      for (const l of txt.split(/\r?\n/)) gameTail.push(l);
      if (gameTail.length > 900) gameTail.splice(0, gameTail.length - 700);
    };
    child.stdout.on('data', onOut);
    child.stderr.on('data', onOut);
    child.on('error', e => log('spawn error: ' + e.message));
    const hideWhilePlaying = !!readConfig().minimizeOnLaunch;
    if (hideWhilePlaying) setTimeout(() => { try { if (win && running) win.minimize(); } catch {} }, 4000);
    child.on('close', (code) => {
      running = false;
      if (hideWhilePlaying) { try { if (win && win.isMinimized()) win.restore(); } catch {} }
      const elapsed = Math.max(0, Math.round((Date.now() - launchStart) / 1000));
      if (!readConfig().disablePlaytime) { try { addPlaySeconds(elapsed); } catch {} }
      if (instanceId) {
        const list = readInstances();
        const inst = list.find(i => i.id === instanceId);
        if (inst) {
          if (!readConfig().disablePlaytime) inst.playtimeSeconds = (inst.playtimeSeconds || 0) + elapsed;
          inst.lastPlayed = Date.now();
          writeInstances(list);
        }
      }
      log(`Game exited (code ${code}).`);
      let crash = null;
      if (code !== 0 && !killedByUser) {
        try { crash = buildCrash(gameDir, launchStart, code); if (lastCrash) lastCrash.secret = subs.auth_access_token; } catch {}
      }
      send('done', { code, crash });
    });

    return { ok: true };
  } catch (e) {
    running = false;
    send('done', { code: -1 });
    return { ok: false, error: e.message };
  }
});

app.setAppUserModelId('ai.crystal.launcher');

/* installed-app behaviour: only one launcher window at a time */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(createWindow);
}
app.on('window-all-closed', () => app.quit());
