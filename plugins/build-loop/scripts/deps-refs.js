// deps-refs.js — read what a file actually calls, and compare it to DEPS.json.
//
// Why this exists. The drift warning in the session brief compared a file's
// modification time against the date its DEPS.json entry was last confirmed.
// Any edit tripped it: a typo, a comment, a test tweak. On 2026-08-07 it
// reported 12 changed targets and all 12 already recorded the right
// dependencies, so the warning was noise every time it had ever fired. A signal
// that is always wrong trains you to skip it, and the edit that genuinely moves
// a dependency produces an identical-looking line.
//
// So this reads references instead of dates.
//
// THE ONE DIRECTION IT REPORTS. It reports a reference the file makes that the
// map does not record. It never reports the reverse, and that asymmetry is
// deliberate rather than unfinished:
//
//   - A call with no recorded edge is dangerous. /flag-issue reads the map to
//     decide what else a fix puts at risk, so a missing edge means a dependent
//     never gets reviewed. Silence is the failure.
//   - A recorded edge with no visible call is usually correct. Plenty of real
//     dependencies are semantic, "apply-fix reads what flag-issue wrote", and
//     nothing in either file names the other. Extraction cannot see those.
//     Reporting them as removed would recreate the false alarms this replaces.
//
// Which means a clean result here says "nothing new appeared", never "the map
// is complete". /audit-deps remains the thing that judges completeness.
//
// WHAT COUNTS AS A REFERENCE. Only what is mechanically certain, because a
// guess here costs the same trust the timestamp check already spent:
//
//   .js    require() of a relative path that resolves to a file on disk.
//   .md    scripts/<name>.js appearing inside a fenced code block, which is how
//          a skill invokes one. Prose is excluded on purpose. queue.js mentions
//          roots.js in a line comment and does not call it; matching that would
//          have manufactured exactly the false positive being removed here.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEPS_PATH = path.join(os.homedir(), '.claude', 'build-loop', 'DEPS.json');

function expandHome(value, home = os.homedir()) {
  if (typeof value !== 'string' || !value) return null;
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

// Fenced code blocks only. A skill calls a script inside a block and talks
// about it in prose, and only the first is evidence of a dependency.
function codeBlocks(content) {
  const out = [];
  const lines = content.split('\n');
  let open = false;
  let buffer = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (open) { out.push(buffer.join('\n')); buffer = []; }
      open = !open;
      continue;
    }
    if (open) buffer.push(line);
  }
  return out;
}

// Every relative require() in a .js file, resolved against the file's own
// directory. An unresolvable specifier is dropped rather than guessed at:
// a bare 'fs' or a package name is not a target in this map.
function jsRequires(filePath, content) {
  const found = [];
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    const base = spec.startsWith('/') ? spec : path.resolve(path.dirname(filePath), spec);
    for (const candidate of [base, `${base}.js`]) {
      try {
        if (fs.statSync(candidate).isFile()) { found.push(candidate); break; }
      } catch (_) { /* try the next form */ }
    }
  }
  return found;
}

// scripts/<name>.js inside a fenced block. The prefix is whatever the skill
// wrote in front of it, an absolute path or ${CLAUDE_PLUGIN_ROOT}, and either
// way the plugin that owns the script is the one being resolved against:
// a skill invoking scripts/queue.js means its own plugin's copy, since a
// plugin reaching into a sibling's scripts/ is the thing hook-io.js exists to
// avoid.
function markdownScriptRefs(filePath, content) {
  const found = [];
  const pluginRoot = pluginRootFor(filePath);
  if (!pluginRoot) return found;
  const re = /scripts\/([\w.-]+)\.js/g;
  for (const block of codeBlocks(content)) {
    let m;
    while ((m = re.exec(block)) !== null) {
      const candidate = path.join(pluginRoot, 'scripts', `${m[1]}.js`);
      try {
        if (fs.statSync(candidate).isFile()) found.push(candidate);
      } catch (_) { /* names a script that is not here; not this map's business */ }
    }
  }
  return found;
}

// Walk up to the directory holding .claude-plugin, which is what makes a
// directory a plugin rather than a folder that looks like one.
function pluginRootFor(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  const stop = path.parse(dir).root;
  while (dir && dir !== stop) {
    try {
      if (fs.statSync(path.join(dir, '.claude-plugin')).isDirectory()) return dir;
    } catch (_) { /* keep walking */ }
    dir = path.dirname(dir);
  }
  return null;
}

function extractRefs(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  let refs = [];
  if (ext === '.js') refs = jsRequires(filePath, content);
  else if (ext === '.md') refs = markdownScriptRefs(filePath, content);
  // A file never depends on itself. require('./x') from x.js is not a thing,
  // but a markdown file naming its own plugin's script it happens to live
  // beside is, and self-edges are not what the map records.
  const self = path.resolve(filePath);
  return [...new Set(refs.map((r) => path.resolve(r)))].filter((r) => r !== self);
}

// Entries are matched by path rather than by rebuilding a composite key.
// The key rules in SCHEMA-DEPS.md have three fallback forms and a documented
// ambiguity case; a second implementation of them here would be a second thing
// to keep in step. The path is already in the entry and is unambiguous.
function entryByPath(deps, filePath, home = os.homedir()) {
  const want = path.resolve(filePath);
  const targets = (deps && (deps.targets || deps.skills)) || {};
  for (const [key, entry] of Object.entries(targets)) {
    if (!entry || typeof entry !== 'object') continue;
    const p = expandHome(entry.path, home);
    if (p && path.resolve(p) === want) return { key, entry };
  }
  return null;
}

const edgeId = (e) => `${e.plugin ? `${e.plugin}/` : ''}${e.target || e.skill || ''}`;

// References the file makes that the entry does not record. See the header for
// why the opposite direction is deliberately not computed.
function unrecorded(deps, entry, refPaths, home = os.homedir()) {
  const recorded = new Set((entry.depends_on || []).map(edgeId));
  const out = [];
  for (const refPath of refPaths) {
    const hit = entryByPath(deps, refPath, home);
    if (!hit) continue;            // not a mapped target, so not a missing edge
    const id = edgeId(hit.entry);
    if (!id || recorded.has(id)) continue;
    if (out.some((o) => o.id === id)) continue;
    out.push({ id, key: hit.key, path: refPath });
  }
  return out;
}

// --- writing -------------------------------------------------------------
//
// Three sessions run against this machine at once, and /audit-deps rewrites the
// whole file while this bumps one field of it. A lock directory is the same
// primitive queue.js uses and is atomic on every filesystem that matters; a
// stale one is taken over rather than deadlocked on, because a map that cannot
// be written is worse than one written a second late.

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;

function acquire(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      let age = 0;
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch (_) { continue; }
      if (age > LOCK_STALE_MS) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch (_) { /* someone beat us to it */ }
        continue;
      }
      if (Date.now() > deadline) return false;
      // Busy-wait rather than async: a hook is a short-lived process and the
      // window being covered is one small write.
      const until = Date.now() + 25;
      while (Date.now() < until) { /* spin */ }
    }
  }
}

// Records that this entry was confirmed against the file as it now stands.
// Returns 'bumped', 'unchanged', or 'locked'.
function bump(key, nowIso, depsPath = DEPS_PATH) {
  const lockPath = path.join(path.dirname(depsPath), '.deps.lock');
  if (!acquire(lockPath)) return 'locked';
  try {
    const deps = JSON.parse(fs.readFileSync(depsPath, 'utf8'));
    const targets = deps.targets || deps.skills;
    const entry = targets && targets[key];
    if (!entry) return 'unchanged';
    if (entry.last_updated === nowIso) return 'unchanged';
    entry.last_updated = nowIso;
    deps.last_updated = nowIso;
    const tmp = `${depsPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(deps, null, 2)}\n`);
    fs.renameSync(tmp, depsPath);       // atomic replace, never a partial file
    return 'bumped';
  } catch (_) {
    return 'unchanged';
  } finally {
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch (_) { /* nothing to undo */ }
  }
}

module.exports = {
  DEPS_PATH,
  bump,
  codeBlocks,
  entryByPath,
  expandHome,
  extractRefs,
  pluginRootFor,
  unrecorded,
};
