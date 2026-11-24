'use strict';
/*
 * Turns a Minecraft crash (game output + crash report text) into plain-language causes and fixes.
 * Pure function, no I/O, so it is easy to test. Rules are ordered most-specific first.
 */

const lines = (text) => String(text || '').split(/\r?\n/);
const uniq = (a) => [...new Set(a)];

const RULES = [
  {
    id: 'wrong-java',
    test: (t) => /UnsupportedClassVersionError/i.test(t) || /requires Java (\d+)/i.test(t),
    build: (t) => {
      let need = 0;
      const m = t.match(/class file version (\d+)\.\d+/i);
      if (m) need = parseInt(m[1], 10) - 44;
      const r = t.match(/requires Java (\d+)/i);
      if (!need && r) need = parseInt(r[1], 10);
      return {
        title: 'Wrong Java version',
        detail: need ? `Something in this game was built for Java ${need} or newer, but an older Java is being used.` : 'The Java being used does not match what this game or one of its mods needs.',
        fixes: ['Open Settings and clear the Java path so the launcher picks or downloads the right Java automatically.'].concat(need ? [`Make sure the Java in use is version ${need} or newer.`] : [])
      };
    }
  },
  {
    id: 'heap-reserve',
    test: (t) => /Could not reserve enough space for (object )?heap|Invalid maximum heap size|Invalid initial heap size|Could not create the Java Virtual Machine|Error occurred during initialization of VM/i.test(t),
    build: () => ({
      title: 'Not enough memory to start',
      detail: 'Java could not reserve the amount of memory you asked for. This happens when the memory slider is higher than what your PC can spare, or when a 32-bit Java is used.',
      fixes: ['Lower the Memory slider in Settings (4 GB is plenty for most setups).', 'Close other programs, then try again.']
    })
  },
  {
    id: 'oom',
    test: (t) => /java\.lang\.OutOfMemoryError|GC overhead limit exceeded/i.test(t),
    build: (t) => {
      const thread = /unable to create native thread/i.test(t);
      return {
        title: 'Out of memory',
        detail: thread ? 'Java could not create another thread, usually because the PC is out of free memory.' : 'The game ran out of memory it was allowed to use.',
        fixes: thread
          ? ['Close other programs and try again.', 'Lower the Memory slider a little; a smaller heap leaves room for threads.']
          : ['Raise the Memory slider in Settings or in this instance\'s settings (modpacks often need 6 GB or more).', 'Lower the render distance in game, or remove heavy mods.']
      };
    }
  },
  {
    id: 'fabric-deps',
    test: (t) => /Incompatible mods? found|Mod resolution failed|Could not find required mod|Mod resolution encountered an incompatible|requires (any )?version [^\n]+ of (fabric|minecraft|fabricloader)/i.test(t),
    build: (t) => {
      const hits = lines(t).filter(l => /(requires|depends on|incompatible|could not find required mod|Install )/i.test(l) && /(mod|fabric|install|requires)/i.test(l)).map(l => l.replace(/^[\s\-•*]+/, '').trim()).filter(l => l.length > 8 && l.length < 220 && !/Exception|Error:/.test(l));
      const missingApi = /fabric-api|fabric api/i.test(t);
      return {
        title: 'A mod is missing something it needs',
        detail: 'Fabric/Quilt refused to start because one or more mods need another mod (or a different Minecraft version) than what is installed.',
        fixes: (missingApi ? ['Install Fabric API from the Discover page (Mods tab) into this instance.'] : [])
          .concat(['Open Manage for this instance and check the mods listed below; update or remove the ones that do not match.'])
          .concat(uniq(hits).slice(0, 4))
      };
    }
  },
  {
    id: 'forge-deps',
    test: (t) => /Missing or unsupported mandatory dependencies|ModLoadingException|Mod ID: '[^']+', Requested by:/i.test(t),
    build: (t) => {
      const need = [];
      const re = /Mod ID: '([^']+)', Requested by: '([^']+)'(?:, Expected range: '([^']+)')?/g;
      let m;
      while ((m = re.exec(t)) && need.length < 5) need.push(`${m[2]} needs ${m[1]}${m[3] ? ' ' + m[3] : ''}`);
      return {
        title: 'A mod is missing a required mod',
        detail: 'Forge/NeoForge could not load the mods because a dependency is missing or the wrong version.',
        fixes: need.length ? uniq(need) : ['Check which mod is named in the crash report and install or update what it needs.']
      };
    }
  },
  {
    id: 'mixin',
    test: (t) => /Mixin apply failed|MixinApplyError|InvalidInjectionException|Critical injection failure|MixinTransformerError|Mixin transformation of/i.test(t),
    build: (t) => {
      const mods = uniq([...t.matchAll(/([\w.\-]+)\.mixins?\.json/gi)].map(m => m[1]).filter(n => !/^(mixins|fabric|minecraft)$/i.test(n))).slice(0, 4);
      return {
        title: 'A mod failed to patch the game',
        detail: 'A mod tried to change Minecraft and could not. This is almost always a mod built for a different Minecraft version, or two mods that conflict.' + (mods.length ? ` Mentioned: ${mods.join(', ')}.` : ''),
        fixes: ['Update the mods named above (use Check for updates in Manage).', 'If you added a mod just before this, remove it and try again.']
      };
    }
  },
  {
    id: 'missing-class',
    test: (t) => /NoSuchMethodError|NoClassDefFoundError|NoSuchFieldError|ClassNotFoundException|AbstractMethodError/.test(t),
    build: (t) => {
      const api = /net[./]fabricmc[./]fabric[./]api/.test(t);
      return {
        title: api ? 'Fabric API is missing' : 'A mod does not match this game version',
        detail: api ? 'A mod is asking for Fabric API, which is not installed in this instance.' : 'A mod is calling code that does not exist. It was built for another Minecraft version or loader, or a library it relies on is missing.',
        fixes: api ? ['Install Fabric API from the Discover page (Mods tab) into this instance.']
          : ['Make sure every mod is made for this instance\'s Minecraft version and loader.', 'Use Check for updates in Manage, or remove the mod that appears in the crash report.']
      };
    }
  },
  {
    id: 'corrupt-zip',
    test: (t) => /ZipException|zip END header not found|invalid LOC header|Error in opening zip file|zip file is empty|invalid CEN header|invalid END header/i.test(t),
    build: (t) => {
      const f = t.match(/(?:opening zip file|ZipException:[^\n]*?)[: ]+([^\n]*?\.(?:jar|zip))/i) || t.match(/([^\s"']+\.(?:jar|zip))/i);
      return {
        title: 'A file is damaged',
        detail: 'Java could not read a .jar or .zip file, usually because a download was cut off.' + (f ? ` File: ${f[1]}` : ''),
        fixes: ['Remove the damaged mod/pack in Manage and install it again.', 'If it is a game file, delete the folder named after the Minecraft version in the launcher\'s "versions" folder so it downloads again.']
      };
    }
  },
  {
    id: 'natives',
    test: (t) => /UnsatisfiedLinkError|Failed to locate library|Failed to load library|lwjgl[^\n]*(not found|could not be loaded)/i.test(t),
    build: () => ({
      title: 'A game library could not be loaded',
      detail: 'The game could not load its native files (LWJGL). Antivirus software sometimes quarantines them, or the files were damaged.',
      fixes: ['Add the launcher\'s data folder (AppData › CrystalLauncher) to your antivirus exceptions.', 'Launch once more; the launcher re-extracts the native files every start.']
    })
  },
  {
    id: 'gpu',
    test: (t) => /GLFW error 65542|GLFW error 65543|WGL: The driver does not appear to support OpenGL|Pixel format not accelerated|no OpenGL context|GL_INVALID_|OpenGL.{0,40}(not supported|unavailable)|(atio6axx|atioglxx|nvoglv(32|64)|ig\d+icd(32|64)|igxelpicd64|ig9icd(32|64)|amdxx64)\.dll/i.test(t),
    build: () => ({
      title: 'Graphics driver problem',
      detail: 'Minecraft could not start OpenGL, or the graphics driver crashed.',
      fixes: ['Update your graphics driver from the NVIDIA, AMD or Intel website.', 'On a laptop, make sure Java uses the dedicated GPU (Windows Settings › Graphics).', 'Turn off shaders or overlay programs (Discord, MSI Afterburner, OBS) and try again.']
    })
  },
  {
    id: 'native-crash',
    test: (t) => /A fatal error has been detected by the Java Runtime Environment|EXCEPTION_ACCESS_VIOLATION|SIGSEGV|Problematic frame/i.test(t),
    build: () => ({
      title: 'Java crashed',
      detail: 'The Java process itself crashed (not just the game). This points to a driver, an overlay program, or a bad mod.',
      fixes: ['Update your graphics driver.', 'Close overlay programs (Discord, OBS, MSI Afterburner) and try again.', 'If you just added mods, remove them one at a time to find the cause.']
    })
  }
];

/* rules that should not be reported together with a more specific one */
const SUPPRESS = { gpu: ['native-crash'], 'fabric-deps': ['missing-class'], 'forge-deps': ['missing-class'], mixin: ['missing-class'] };

function diagnose(text) {
  const t = String(text || '');
  const matched = RULES.filter(r => { try { return r.test(t); } catch { return false; } });
  const ids = new Set(matched.map(r => r.id));
  const out = [];
  for (const r of matched) {
    if (Object.keys(SUPPRESS).some(k => ids.has(k) && SUPPRESS[k].includes(r.id) && k !== r.id)) continue;
    out.push(Object.assign({ id: r.id }, r.build(t)));
    if (out.length >= 3) break;
  }
  return out;
}

/* scrub things people would not want public in a shared log */
function redact(text, extra) {
  let t = String(text || '');
  t = t.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\r\n"']+/gi, '$1<user>');
  t = t.replace(/(\/home\/|\/Users\/)[^\/\r\n"']+/g, '$1<user>');
  t = t.replace(/--accessToken\s+\S+/gi, '--accessToken <hidden>');
  for (const x of extra || []) if (x && x.length > 5) t = t.split(x).join('<hidden>');
  return t;
}

module.exports = { diagnose, redact, RULES };
