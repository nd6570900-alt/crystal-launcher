'use strict';
/*
 * Reads mod information from a mod jar: its id, display name, version and the mods it depends on.
 * `zip` is any object with getEntry(name) -> { getData() } (adm-zip works). Never throws.
 * Supported: Fabric (fabric.mod.json), Quilt (quilt.mod.json), Forge/NeoForge (mods.toml), old Forge (mcmod.info).
 */

const BUILTIN = new Set(['minecraft', 'java', 'forge', 'neoforge', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt_base', 'fml', 'javafml', 'lowcodefml', 'mclanguage', 'quilted_fabric_api']);

const text = (zip, name) => {
  try { const e = zip.getEntry(name); return e ? e.getData().toString('utf8').replace(/^﻿/, '') : null; } catch { return null; }
};

/* tiny TOML reader: just tables ([[mods]], [[dependencies.x]]) and simple key = value lines */
function parseToml(src) {
  const blocks = [];
  let cur = { header: '', kv: {} };
  blocks.push(cur);
  let skipUntil = null;
  for (const raw of String(src).split(/\r?\n/)) {
    const line = raw.trim();
    if (skipUntil) { if (line.includes(skipUntil)) skipUntil = null; continue; }
    if (!line || line.startsWith('#')) continue;
    const h = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (h) { cur = { header: h[1], kv: {} }; blocks.push(cur); continue; }
    const kv = line.match(/^([A-Za-z0-9_.\-"']+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].replace(/["']/g, '');
    let val = kv[2].trim();
    const multi = val.match(/^("""|''')/);
    if (multi) {
      const rest = val.slice(3);
      if (!rest.includes(multi[1])) skipUntil = multi[1];
      continue;
    }
    val = val.replace(/\s+#.*$/, '');
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    cur.kv[key] = val;
  }
  return blocks;
}

function manifestVersion(zip) {
  const m = text(zip, 'META-INF/MANIFEST.MF');
  const v = m && m.match(/^Implementation-Version:\s*(.+)$/mi);
  return v ? v[1].trim() : '';
}

function fromToml(zip, file) {
  const src = text(zip, file);
  if (!src) return null;
  const blocks = parseToml(src);
  const mod = blocks.find(b => b.header === 'mods');
  if (!mod || !mod.kv.modId) return null;
  const id = mod.kv.modId;
  let version = mod.kv.version || '';
  if (/\$\{.*\}/.test(version)) version = manifestVersion(zip);
  const depends = [];
  for (const b of blocks) {
    const m = b.header.match(/^dependencies\.(.+)$/);
    if (!m || m[1] !== id) continue;
    const required = b.kv.mandatory === 'true' || b.kv.type === 'required';
    const dep = b.kv.modId;
    if (required && dep && !BUILTIN.has(dep.toLowerCase())) depends.push(dep);
  }
  return { loader: file.includes('neoforge') ? 'neoforge' : 'forge', id, name: mod.kv.displayName || id, version, depends };
}

function readJarMeta(zip) {
  try {
    let t = text(zip, 'fabric.mod.json');
    if (t) {
      const j = JSON.parse(t);
      const deps = Object.keys(j.depends || {}).filter(k => !BUILTIN.has(k.toLowerCase()));
      return { loader: 'fabric', id: String(j.id || ''), name: String(j.name || j.id || ''), version: String(j.version || ''), depends: deps };
    }
    t = text(zip, 'quilt.mod.json');
    if (t) {
      const q = (JSON.parse(t).quilt_loader) || {};
      const deps = (q.depends || []).map(d => typeof d === 'string' ? d : (d && d.id)).filter(d => d && !BUILTIN.has(String(d).toLowerCase()));
      return { loader: 'quilt', id: String(q.id || ''), name: String((q.metadata && q.metadata.name) || q.id || ''), version: String(q.version || ''), depends: deps };
    }
    const nf = fromToml(zip, 'META-INF/neoforge.mods.toml') || fromToml(zip, 'META-INF/mods.toml');
    if (nf) return nf;
    t = text(zip, 'mcmod.info');
    if (t) {
      let j = JSON.parse(t);
      if (j && j.modList) j = j.modList;
      const m = Array.isArray(j) ? j[0] : j;
      if (m && m.modid) return { loader: 'forge', id: String(m.modid), name: String(m.name || m.modid), version: String(m.version || ''), depends: (m.requiredMods || m.dependencies || []).map(String).filter(d => !BUILTIN.has(d.toLowerCase())) };
    }
  } catch {}
  return null;
}

module.exports = { readJarMeta, parseToml };
