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
  const siblings = path.dirname(pluginRoot);
  // Captures any `plugins/<name>/` written immediately before the script path,
  // which is how a doc names a script belonging to somebody else. Without it
  // every match resolved to the file's own plugin, and hook-io.js, cli.js,
  // config.js and patterns.js each exist in more than one plugin here by
  // design, so a doc citing guardrails/scripts/hook-io.js from inside
  // build-loop resolved to build-loop's copy and reported a missing edge to
  // the wrong target.
  const re = /(?:plugins\/([\w.-]+)\/)?scripts\/([\w.-]+)\.js/g;
  for (const block of codeBlocks(content)) {
    let m;
    while ((m = re.exec(block)) !== null) {
      const [, namedPlugin, script] = m;
      const owner = namedPlugin ? path.join(siblings, namedPlugin) : pluginRoot;
      const candidate = path.join(owner, 'scripts', `${script}.js`);
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

// A hooks.json names the scripts it runs, in a `command` string built around
// ${CLAUDE_PLUGIN_ROOT}. That is as literal a reference as a require(), and
// the file is itself a mapped target, so leaving it out meant every hook
// registration edit kept producing the drift line this replaces.
function hooksJsonRefs(filePath, content) {
  if (path.basename(filePath) !== 'hooks.json') return [];
  const pluginRoot = pluginRootFor(filePath);
  if (!pluginRoot) return [];
  let parsed;
  try { parsed = JSON.parse(content); } catch (_) { return []; }
  const found = [];
  const re = /(?:hooks|scripts)\/([\w.-]+)\.js/g;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const value of Object.values(node)) {
      if (typeof value === 'string') {
        let m;
        while ((m = re.exec(value)) !== null) {
          const dir = value.slice(0, m.index + m[0].length).includes('scripts/') ? 'scripts' : 'hooks';
          const candidate = path.join(pluginRoot, dir, `${m[1]}.js`);
          try {
            if (fs.statSync(candidate).isFile()) found.push(candidate);
          } catch (_) { /* names something that is not here */ }
        }
        re.lastIndex = 0;
      } else walk(value);
    }
  };
  walk(parsed);
  return found;
}

function extractRefs(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  let refs = [];
  if (ext === '.js') refs = jsRequires(filePath, content);
  else if (ext === '.md') refs = markdownScriptRefs(filePath, content);
  else if (ext === '.json') refs = hooksJsonRefs(filePath, content);
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

// Identity carries the repo, because the name does not carry it and two roots
// routinely hold the same name. SCHEMA-DEPS.md introduced the {repo}:{name} key
// for exactly this: comparing on plugin and target alone lets an edge recorded
// against work's `capture` silently absorb a brand-new call to personal's
// `capture`, which is the missed dependent this hook exists to catch.
const bareName = (e) => e.target || e.skill || '';
const edgeId = (e, fallbackRepo) => {
  const repo = e.repo || fallbackRepo || '';
  const name = bareName(e);
  if (!name) return '';
  return `${repo}:${e.plugin ? `${e.plugin}/` : ''}${name}`;
};

// Does a recorded edge point at this entry?
//
// Two forms have to match, per the ordered lookup in SCHEMA-DEPS.md. The exact
// key is the normal case. The bare form, repo and name with no plugin, is what
// a map written before v3 stores, and treating one as unrecorded reports an
// edge that is already there, reintroducing the false alarms this release
// removes. Both forms still require the repo to agree.
function edgeMatches(edge, entry, entryRepo) {
  const repo = edge.repo || entryRepo || '';
  if (repo !== (entry.repo || '')) return false;
  if (bareName(edge) !== bareName(entry)) return false;
  if (!edge.plugin) return true;                    // pre-v3 or unqualified: name and repo agree, so it points here
  return edge.plugin === (entry.plugin || '');
}

// References the file makes that the entry does not record. See the header for
// why the opposite direction is deliberately not computed.
function unrecorded(deps, entry, refPaths, home = os.homedir()) {
  const edges = entry.depends_on || [];
  const out = [];
  for (const refPath of refPaths) {
    const hit = entryByPath(deps, refPath, home);
    if (!hit) continue;            // not a mapped target, so not a missing edge
    if (edges.some((e) => edgeMatches(e, hit.entry, entry.repo))) continue;
    const id = edgeId(hit.entry, entry.repo);
    if (!id) continue;
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

  // Every path that goes round again comes through here, so there is no way to
  // retry without both checking the deadline and pausing first.
  //
  // queue.js carries this same helper and the same comment, because it hit this
  // exact fault first: a retry that jumped back to the top skipped both checks
  // and the loop spun at full CPU with no exit. This file reproduced it on two
  // branches, and a lock directory that cannot be removed, one owned by another
  // user or sitting under a read-only parent, is enough to trigger it.
  //
  // It is worse here than in queue.js. hook-io.js clears its stdin timeout
  // before calling the handler, so a spinning hook has nothing else to stop it:
  // every file edit would leave a runaway process behind.
  const waitOrGiveUp = () => {
    if (Date.now() > deadline) return false;
    // Busy-wait rather than async: a hook is a short-lived process and the
    // window being covered is one small write.
    const until = Date.now() + 25;
    while (Date.now() < until) { /* pause */ }
    return true;
  };

  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      let age = null;
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch (_) { /* unreadable; treat as fresh */ }
      if (age !== null && age > LOCK_STALE_MS) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); }
        catch (_) { /* cannot clear it, so fall through and let the deadline end this */ }
      }
      if (!waitOrGiveUp()) return false;
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
