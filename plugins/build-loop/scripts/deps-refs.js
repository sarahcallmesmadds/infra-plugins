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
//   .js    require() of a relative path that resolves to a file on disk, and a
//          path.join()/path.resolve() built entirely from string literals that
//          resolves to a file on disk. The second form is how every test suite
//          here names the thing it tests: a suite spawns its subject rather than
//          importing it, so `const HOOK = path.join(__dirname, '..', 'plugins',
//          'guardrails', 'hooks', 'bash-guard.js')` is the only place the
//          dependency is written down. Reading only require() left 12 of the 98
//          mapped entries with nothing to find, and an empty result is stamped
//          as confirmed, so the suites that reach across the most plugins were
//          the ones this hook silently did nothing for.
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

// A path assembled from string literals, which is the other half of how a .js
// file names a file it depends on. A test suite spawns its subject as a child
// process rather than importing it, precisely so it exercises the real process
// boundary, so there is no require() anywhere and the only written form of the
// dependency is the path constant:
//
//   const ROOT = path.join(__dirname, '..', 'plugins', 'session');
//   const CLI  = path.join(ROOT, 'scripts', 'cli.js');
//
// Two rules hold this to the same standard as a require(). The first segment
// must be __dirname or a const already resolved by this same rule, and every
// later segment must be a string literal. Then the result must exist on disk.
//
// Anything computed fails the first rule and is dropped rather than guessed at,
// which is what keeps the fixtures out: a temp path starts at os.tmpdir(), a
// call rather than a literal, and the files under it are written during the run
// and are not in the map. deps-watch.test.js is full of them and none resolve.
const JOIN_ARGS = '\\(([^()]*)\\)';
const JOIN_CALL = `path\\.(?:join|resolve)${JOIN_ARGS}`;
const CONST_JOIN = `(?:^|\\n)\\s*const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${JOIN_CALL}`;
const STRING_LIT = /^(['"])([^'"]*)\1$/;

// Returns the resolved path, or null when any segment is not certain.
function resolveJoin(argsSrc, dirname, bindings) {
  const parts = argsSrc.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const [head, ...rest] = parts;
  let base;
  if (head === '__dirname') base = dirname;
  else if (Object.prototype.hasOwnProperty.call(bindings, head)) base = bindings[head];
  else return null;                 // a call, a parameter, a bare literal: not certain
  const segments = [];
  for (const part of rest) {
    const lit = STRING_LIT.exec(part);
    if (!lit) return null;          // one computed segment makes the whole path a guess
    segments.push(lit[2]);
  }
  return path.join(base, ...segments);
}

function jsPathJoins(filePath, content) {
  const dirname = path.dirname(path.resolve(filePath));

  // Collected in source order, so a const built on an earlier one resolves.
  // A binding naming a directory is kept but never reported: ROOT above is not
  // itself a dependency, it is how the next line reaches one.
  const bindings = Object.create(null);
  const bindingRe = new RegExp(CONST_JOIN, 'g');
  let b;
  while ((b = bindingRe.exec(content)) !== null) {
    const resolved = resolveJoin(b[2], dirname, bindings);
    if (resolved !== null) bindings[b[1]] = resolved;
  }

  // Every join anywhere in the file, including inside a require() or a spawn
  // argument list, since where it is written does not change what it names.
  const found = [];
  const callRe = new RegExp(JOIN_CALL, 'g');
  let m;
  while ((m = callRe.exec(content)) !== null) {
    const resolved = resolveJoin(m[1], dirname, bindings);
    if (resolved === null) continue;
    // Both forms, exactly as jsRequires does, because node resolves both and
    // this codebase writes both. Every guardrails hook reaches its modules as
    // `require(path.join(ROOT, 'scripts', 'hook-io'))`, with no extension, and
    // matching only the exact string dropped all 28 of those on this branch:
    // hook-io, config, scan, command and resource-ownership, from bash-guard,
    // read-scan, write-scan, both resource-owner hooks and three cli.js files.
    // They are the densest real edges in the repository and none of them were
    // visible.
    for (const candidate of [resolved, `${resolved}.js`]) {
      try {
        if (fs.statSync(candidate).isFile()) { found.push(candidate); break; }
      } catch (_) { /* try the next form */ }
    }
  }
  return found;
}

// scripts/<name>.js inside a fenced block, resolved against whichever plugin
// the text actually names. A `plugins/<name>/` written in front of it, which is
// what an absolute path to another plugin contains, resolves there. Anything
// else resolves to the file's own plugin, which is the common case: a skill
// invoking scripts/queue.js means its own copy, since a plugin reaching into a
// sibling's scripts/ is the thing hook-io.js exists to avoid.
//
// The distinction is load-bearing here rather than theoretical. hook-io.js,
// cli.js, config.js and patterns.js each exist in more than one plugin by
// design, so resolving every match locally sent a reference to the wrong file
// and reported a missing edge that was not one.
function markdownScriptRefs(filePath, content) {
  const found = [];
  const pluginRoot = pluginRootFor(filePath);
  if (!pluginRoot) return null;          // outside a plugin there is no scripts/ to resolve against
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
  if (path.basename(filePath) !== 'hooks.json') return null;   // a plugin.json carries no references
  const pluginRoot = pluginRootFor(filePath);
  if (!pluginRoot) return null;
  let parsed;
  try { parsed = JSON.parse(content); } catch (_) { return null; }   // unparseable is unchecked, not clean
  const found = [];
  const re = /(?:hooks|scripts)\/([\w.-]+)\.js/g;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const value of Object.values(node)) {
      if (typeof value === 'string') {
        let m;
        while ((m = re.exec(value)) !== null) {
          // Read the folder off the match itself. Searching the text before it
          // meant one command running a scripts/ file and then a hooks/ one
          // classified the second as a script, so it either resolved to
          // nothing and dropped a real edge, or hit a same-named file in
          // scripts/ and credited the wrong target.
          const dir = m[0].startsWith('scripts/') ? 'scripts' : 'hooks';
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

// Returns an array of resolved paths when the file was genuinely read, and
// `null` when nothing could be read from it at all.
//
// THAT DISTINCTION IS THE POINT. Both used to be an empty array, and an empty
// array told the hook the file was checked and clean, so it stamped the entry
// as confirmed. Editing something nothing can be read from, a plugin.json, or a
// SKILL.md living outside any plugin, which is where the documented default
// roots put every one of them, marked the entry current without a single
// reference having been examined. Each later edit re-stamped it, so the entry
// never reported drift again. An unreadable file has to stay drifted: not
// knowing is exactly the state the warning exists to report.
function extractRefs(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  let refs = null;
  if (ext === '.js') refs = [...jsRequires(filePath, content), ...jsPathJoins(filePath, content)];
  else if (ext === '.md') refs = markdownScriptRefs(filePath, content);
  else if (ext === '.json') refs = hooksJsonRefs(filePath, content);
  if (refs === null) return null;
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
  // Unqualified on EITHER side means name and repo agreement is all there is to
  // compare, which is the ordered lookup the schema documents. Tolerating a
  // bare edge but not a bare entry compared 'guardrails' against '' and called
  // a recorded dependency missing. Mixed maps are reachable in ordinary use,
  // because /audit-deps takes an argument and filters its buckets, so a partial
  // run rewrites one entry while leaving the entry it points at in the old form.
  //
  // Where both sides are qualified they must agree, which is what stops this
  // collapsing into "any missing plugin matches anything".
  if (!edge.plugin || !entry.plugin) return true;
  return edge.plugin === entry.plugin;
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
const LOCK_POLL_MS = 25;

// Blocking sleep, the same one queue.js uses and for the same reason: this
// process has nothing else to do while it waits, and the alternative is an
// async rewrite of a hook whose whole job is a short critical section.
//
// It has to be a real sleep rather than a loop on the clock. A loop holds a
// core at full load for the entire wait, and this runs on every Write and Edit
// with three sessions contending for the same map, so the cost lands on
// ordinary saves. An earlier version of this helper span, and the comment below
// claimed parity with queue.js while queue.js was already parking the thread.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;

  // Every path that goes round again comes through here, so there is no way to
  // retry without both checking the deadline and pausing first.
  //
  // queue.js carries the same helper, down to the blocking sleep, because it
  // hit this exact fault first: a retry that jumped back to the top skipped
  // both checks and the loop spun at full CPU with no exit. This file
  // reproduced it on two branches, and a lock directory that cannot be removed,
  // one owned by another user or sitting under a read-only parent, is enough to
  // trigger it.
  //
  // It is worse here than in queue.js. hook-io.js clears its stdin timeout
  // before calling the handler, so a spinning hook has nothing else to stop it:
  // every file edit would leave a runaway process behind.
  const waitOrGiveUp = () => {
    if (Date.now() > deadline) return false;
    sleep(LOCK_POLL_MS);
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
// Returns 'bumped', 'unchanged', 'locked', or 'superseded'.
//
// IT WRITES `last_auto_checked`, NEVER `last_updated`. Those are two different
// dates and conflating them broke a second reader. `last_updated` is the human
// and audit review date: /audit-deps compares it against the file's mtime to
// decide an entry is STALE and may need its edges re-inferred, and that skill's
// own failure handling says never to rewrite it unless content actually
// changed. Stamping it here emptied that bucket silently. Extraction cannot see
// a semantic edge, one thing reading a file another writes, so an edit that
// added one left the entry looking freshly reviewed and it never came up again.
// The map-level `last_updated` is left alone for the same reason: an unattended
// machine check is not a revision of the map.
//
// `onBeforeWrite` exists for the race test below and is not used in production.
function bump(key, nowIso, depsPath = DEPS_PATH, { onBeforeWrite } = {}) {
  const lockPath = path.join(path.dirname(depsPath), '.deps.lock');
  if (!acquire(lockPath)) return 'locked';
  try {
    // The lock only stops another hook. /audit-deps rewrites the whole map
    // through the Write tool and takes no lock at all, so if an approved edge
    // change lands between this read and the rename below, renaming would
    // destroy it. Between a machine stamp and the edges a user just approved,
    // the stamp is the expendable one, so compare and yield rather than write.
    const before = fs.statSync(depsPath);
    const raw = fs.readFileSync(depsPath, 'utf8');
    const deps = JSON.parse(raw);
    const targets = deps.targets || deps.skills;
    const entry = targets && targets[key];
    if (!entry) return 'unchanged';
    if (entry.last_auto_checked === nowIso) return 'unchanged';
    entry.last_auto_checked = nowIso;

    if (onBeforeWrite) onBeforeWrite();

    const after = fs.statSync(depsPath);
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) return 'superseded';

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
