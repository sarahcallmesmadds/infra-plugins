// One handoff per thread: finding a thread, reading its rules, saving it, and
// the one-time migration that turns a folder of session handoffs into threads.
//
// Two problems were filed against the older behaviour and both come from the
// same place. Every wrap wrote a new document named after that session, so one
// subject piled up dozens of them. And every handoff written from the home
// directory pooled its rules with every other, so a pickup of any thread printed
// hundreds of rules belonging to other work.
//
// A thread fixes both. It is one central handoff, declared in threads.json,
// rewritten in place at each wrap, and the only authority for its own rules.
// Nothing here pools across documents.
//
// Scope, stated because it is a deliberate boundary rather than an omission:
// threads are for the home scope only, meaning central handoffs whose working
// directory resolves to the home directory. Every other scope keeps the older
// pool, retirement and `target` behaviour unchanged. Both bug reports were
// about the home scope, and migrating every scope at once was measured at 27
// scopes and 167 rules nobody had asked to change.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const handoffs = require('./handoffs');
const registryMod = require('./registry');
const config = require('./config');
const { lockLost, refreshLock } = require('./index-lock');

function rev(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function fileRev(file) {
  try { return rev(fs.readFileSync(file)); } catch (_) { return null; }
}

function homeScope(home) {
  return handoffs.scopeKey(home);
}

// Whether a handoff was written from the home directory itself. Compared as
// real paths, not by `scopeKey`, which groups a repository's directories
// together: where the home directory is itself a git checkout, that grouping
// made a handoff from `~/notes` count as home, so it could be saved as a
// thread and bind as one. Repository grouping stays where it is meant to be,
// in the pooled rules of everything that is not a thread.
const { isHomeDir } = handoffs;

function inHomeScope(text, home) {
  return isHomeDir(handoffs.handoffDir(text), home);
}

// Whether a handoff could be a thread, which is the question every broken or
// uncertain case comes down to. A project handoff kept beside its work never
// is. A central one is ruled out only when its own document can be read and
// names a working directory outside home. Anything that cannot be told, an
// unreadable file or one with no Working directory line, counts as possibly a
// thread, which is the side that refuses to write and refuses to call it
// merely pooled.
//
// One rule, used by target, find and constraints alike. Handling each case
// where it came up is how the three drifted apart.
//
// Judged by where the file really is, never by the kind an index entry claims:
// a declared thread is always `HANDOFF-<slug>.md` directly in the handoffs
// folder (registry.js refuses any other path), so a file anywhere else, a
// project, an archived copy or a pause note, can never be one. Checked on the
// path as written and on its real path, and either is enough: comparing real
// paths alone let a central HANDOFF-x.md that is a symlink to an archived
// copy look safe to write through, and comparing written paths alone let a
// home reached through a symlink make a central file look like a project.
function threadShaped(file, home) {
  const root = handoffs.handoffRoot(home);
  const at = (p, r) => path.dirname(p) === r && /^HANDOFF-.+\.md$/.test(path.basename(p));
  return at(path.resolve(file), path.resolve(root))
    || at(handoffs.resolvePath(file), handoffs.resolvePath(root));
}

function couldBeThread(file, home) {
  if (!threadShaped(file, home)) return false;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return true; }
  if (!handoffs.handoffDir(text)) return true;
  return inHomeScope(text, home);
}

// The question asked of the name rather than of whatever file it resolves to.
// A declared thread always lives at the central file named for its slug, and
// the index can point that same slug at a project elsewhere. While the thread
// list is broken, the project answer would otherwise stand in for the thread.
function slugCouldBeThread(slug, home) {
  const key = handoffs.slugify(slug);
  if (!key) return false;
  const central = path.join(handoffs.handoffRoot(home), `HANDOFF-${key}.md`);
  return fs.existsSync(central) && couldBeThread(central, home);
}

// Whether a project's name is taken by a thread, so `target` records it as
// `<name>-project` instead. While the thread list cannot be read, a name with
// a central file that could be a thread counts as taken.
function projectNameShadowed(slug, home) {
  const reg = registryMod.readRegistry(home);
  if (reg.state === 'ok') return Boolean(registryMod.declaredBySlug(reg.registry, slug));
  if (reg.state === 'invalid') return slugCouldBeThread(slug, home);
  return false;
}

// The index name for a project whose folder name is taken by a thread: the
// first free one of `<name>-project`, `<name>-project-2`, ... A name is free
// when no thread could be it, no central handoff has it, and the index does
// not already point it at another live document. A folder really named
// `<name>-project` took the name otherwise, and the two projects overwrote
// each other's entry at every wrap, each losing its rules in turn. An entry
// this project already holds is kept, so the name is stable across wraps.
// The stem is cut before the suffix goes on: slugify's 60-character limit
// cut the suffix off instead, which gave back the thread's own name.
function projectKey(name, target, home = os.homedir(), index = handoffs.readIndex(home)) {
  const base = handoffs.slugify(name);
  const stem = base.slice(0, 60 - '-project-99'.length).replace(/-+$/, '');
  const mine = new RegExp(`^${stem.replace(/[^a-z0-9]/g, '\\$&')}-project(-\\d+)?$`);
  for (const [k, e] of Object.entries(index)) {
    if (mine.test(k) && e && typeof e.path === 'string' && samePath(e.path, target)) return k;
  }
  const root = handoffs.handoffRoot(home);
  for (let n = 1; n < 100; n += 1) {
    const k = n === 1 ? `${stem}-project` : `${stem}-project-${n}`;
    if (projectNameShadowed(k, home) || fs.existsSync(path.join(root, `HANDOFF-${k}.md`))) continue;
    if (liveOtherEntry(index[k], target)) continue;
    return k;
  }
  return null;
}

// Whether the index gives this name to a different project that holds it by
// assignment rather than by its own folder name, which is what projectKey
// hands out. A plain project named like that must not take it over, or the
// assigned one drops out of every pool at the next wrap; it gets a numbered
// name instead. Two folders that simply share a name still replace each
// other's entry, exactly as in 0.8.
function assignedElsewhere(key, target, home = os.homedir(), index = handoffs.readIndex(home)) {
  const e = index[key];
  if (!liveOtherEntry(e, target) || typeof e.path !== 'string') return false;
  return handoffs.slugify(path.basename(path.dirname(e.path))) !== key;
}

function freeNumbered(key, target, home = os.homedir(), index = handoffs.readIndex(home)) {
  const stem = key.slice(0, 60 - '-99'.length).replace(/-+$/, '');
  for (let n = 2; n < 100; n += 1) {
    const k = `${stem}-${n}`;
    const e = index[k];
    if (e && typeof e.path === 'string' && samePath(e.path, target)) return k;
    if (liveOtherEntry(e, target) || projectNameShadowed(k, home)) continue;
    if (fs.existsSync(path.join(handoffs.handoffRoot(home), `HANDOFF-${k}.md`))) continue;
    return k;
  }
  return null;
}

// Moves a project's index entry off a name a thread has taken, onto its
// `-project` name. The upgrade case: a 0.8 index already maps the name to the
// project, migrate plan refuses the name while it does, and forgetting the
// entry instead left the project in no pool until its next wrap, which reads
// the pool before it records anything and so dropped every rule.
function rekeyProject(slug, home = os.homedir()) {
  const key = handoffs.slugify(slug);
  return handoffs.mutateIndex(home, (index, saveIndex) => {
    const entry = index[key];
    if (!entry || typeof entry.path !== 'string') return { rekeyed: false, reason: `nothing is recorded for "${key}"` };
    if (threadShaped(entry.path, home) || entry.path.startsWith(`${handoffs.handoffRoot(home)}${path.sep}`)) {
      return { rekeyed: false, reason: `"${key}" is recorded for ${entry.path}, which is not a project handoff` };
    }
    const to = projectKey(key, entry.path, home, Object.fromEntries(Object.entries(index).filter(([k]) => k !== key)));
    if (!to) return { rekeyed: false, reason: `no free name for ${entry.path}` };
    const next = { ...index, [to]: entry };
    delete next[key];
    if (!saveIndex(next)) return { rekeyed: false, reason: 'the index could not be written' };
    return { rekeyed: true, from: key, to, path: entry.path };
  }, { refused: (reason) => ({ rekeyed: false, reason: handoffs.lockReason(reason) }) });
}

// The first sentence under "What was worked on", for the list a wrap picks a
// thread from. Short on purpose: it is a label, not a summary.
function subjectOf(text) {
  const m = text.match(/^#{2,6}\s*What was worked on\s*$([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/mi);
  if (!m) return null;
  const body = m[1].trim().replace(/\s+/g, ' ');
  if (!body) return null;
  const sentence = body.match(/^.*?[.!?](?=\s|$)/);
  return (sentence ? sentence[0] : body).slice(0, 240);
}

// Writes beside the target and renames over it, so a reader sees the old
// document or the new one and never half of one. Returns the rev of what is on
// disk afterwards, read back rather than assumed.
//
// `guard` runs immediately before the rename, after the possibly slow write of
// the temporary file. The lock is checked there rather than earlier because a
// lock taken over during that write belongs to another session by the time the
// rename happens, and renaming then overwrites that session's work.
function atomicWrite(target, content, guard = () => {}) {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    guard();
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* nothing else to try */ }
    throw e;
  }
  return fileRev(target);
}

// Throws if this process no longer holds the handoff lock. Passed as the guard
// to every rename made under it.
function holdingLock(home) {
  return () => {
    if (lockLost(handoffs.indexLockPath(home))) throw new Error('the handoff lock was taken over by another session');
  };
}

function lockRefusalReason(reason) {
  return reason === 'reentrant' ? 'busy' : reason;
}

// ------------------------------------------------------------ resolution ----

// What a slug refers to. The one lookup `find`, `constraints`, `threads` and
// `save` all use, so they cannot disagree about which document a slug means.
function resolve(slug, home = os.homedir()) {
  const reg = registryMod.readRegistry(home);
  const mode = reg.state === 'ok' ? 'threads' : (reg.state === 'absent' ? 'pre-migration' : 'invalid');
  const out = { slug: String(slug || ''), mode, errors: reg.errors };
  const declared = reg.state === 'ok' ? registryMod.declaredBySlug(reg.registry, slug) : null;

  if (declared) {
    // A link whose target is gone reads as absent to existsSync, which would
    // send someone to recreate the file rather than fix the link. Counted as
    // there and unreadable instead.
    let linked = false;
    try { linked = fs.lstatSync(declared.path).isSymbolicLink(); } catch (_) { /* nothing there */ }
    const exists = fs.existsSync(declared.path) || linked;
    const threadRev = exists ? fileRev(declared.path) : null;
    const result = {
      ...out,
      slug: declared.slug,
      kind: 'thread',
      path: declared.path,
      exists,
      rev: threadRev,
      // There and unreadable: said here, so `find` does not hand a wrap a
      // null revision for it to fail on one step later.
      unreadable: exists && threadRev === null,
      generation: reg.registry.generation,
      conflicts: [],
    };
    // A slug that is a declared thread and also indexed at a different real
    // document is two answers to one question. Reported, never picked between.
    const indexed = handoffs.readIndex(home)[declared.slug];
    if (liveOtherEntry(indexed, declared.path)) {
      result.conflicts.push({ slug: declared.slug, indexed: indexed.path, declared: declared.path });
    }
    return result;
  }

  const found = handoffs.findHandoff(slug, home);
  if (!found) return { ...out, kind: null, path: null, exists: false, conflicts: [] };
  // After migration a central document written from the home directory that is
  // not declared is history: readable, binding nothing. Everything else keeps
  // the older behaviour whatever mode this is, because threads are a home-scope
  // change and nothing outside that scope was migrated.
  let text = '';
  let unreadable = null;
  try { text = fs.readFileSync(found.path, 'utf8'); } catch (e) { unreadable = e.message; }
  const central = found.kind === 'central' || found.kind === 'archived' || found.kind === 'pause';
  const history = mode === 'threads' && central && inHomeScope(text, home);
  return {
    ...out,
    kind: history ? 'history' : found.kind,
    path: found.path,
    exists: true,
    rev: fileRev(found.path),
    dir: handoffs.handoffDir(text),
    unreadable,
    conflicts: [],
  };
}

function samePath(a, b) {
  return handoffs.resolvePath(a) === handoffs.resolvePath(b);
}

// Whether an index entry still stands for some other document. Not a bare
// existence check: an entry recorded moments ago by a wrap still writing, or
// one whose disk is not mounted, fails `existsSync` and is exactly the entry
// that must not be overwritten, because it is the only record of where that
// handoff went. Only an entry the index itself would prune counts as free.
function liveOtherEntry(entry, target) {
  if (!entry) return false;
  // A hand-edited entry whose path is not a string would throw inside the
  // path comparison and take find, save and declare down with it. Counted as
  // live, which is the side that refuses.
  if (typeof entry.path !== 'string') return true;
  if (!entry.path || samePath(entry.path, target)) return false;
  return handoffs.entryState(entry) !== 'gone';
}

function listThreads(home = os.homedir()) {
  const reg = registryMod.readRegistry(home);
  if (reg.state !== 'ok') return { mode: reg.state === 'absent' ? 'pre-migration' : 'invalid', errors: reg.errors, threads: [] };
  const threads = reg.registry.threads.map((t) => {
    let text = null;
    let mtime = null;
    let unreadable = null;
    try { text = fs.readFileSync(t.path, 'utf8'); mtime = fs.statSync(t.path).mtimeMs; } catch (e) {
      if (!(e && e.code === 'ENOENT')) unreadable = e.message;
      // A link whose target is gone is there and broken, not missing.
      else {
        try { if (fs.lstatSync(t.path).isSymbolicLink()) unreadable = 'it is a symbolic link whose target is gone'; } catch (_) { /* missing */ }
      }
    }
    return {
      slug: t.slug,
      path: t.path,
      exists: text !== null || unreadable !== null,
      unreadable,
      rev: text === null ? null : rev(text),
      mtime,
      subject: text === null ? null : subjectOf(text),
    };
  });
  threads.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return {
    mode: 'threads', generation: reg.registry.generation, pending: reg.registry.pending.length, threads,
  };
}

// ----------------------------------------------------------------- rules ----

// The rules that bind a thread: the live bullets in its own file, nothing else.
//
// Before migration this returns `mode: 'pre-migration'` and the caller keeps
// the older pooled answer, so an upgrade alone changes nothing anybody sees.
function threadConstraints({ slug, home = os.homedir() }) {
  const reg = registryMod.readRegistry(home);
  if (reg.state === 'absent') return { mode: 'pre-migration' };
  if (reg.state === 'invalid') {
    // A project handoff kept beside its work can never be a thread, so a
    // broken thread list is no reason to withhold its answer. Anything that
    // might be a thread is refused, because which it is cannot be read.
    // The same goes for a central handoff whose own document says it was
    // written outside home: a thread never is.
    // Only something provably outside home gets the pooled answer here. A
    // home handoff of any kind, archived included, is history or a thread once
    // threads exist, and with the list unreadable the pool would count every
    // thread's rules as binding.
    const found = handoffs.findHandoff(slug, home);
    let foundText = null;
    try { foundText = found ? fs.readFileSync(found.path, 'utf8') : null; } catch (_) { /* unknown: refused below */ }
    // The pool is built from the document's own Working directory, so that is
    // the folder judged, and the same one handed back for the scan. Where the
    // file sits proves nothing: a project's HANDOFF.md whose header names home
    // would otherwise pass on its location and then be pooled with home, which
    // with the list unreadable counts every thread's rules as binding. A
    // folder sharing home's scope is refused for the same reason. Unreadable,
    // or no Working directory line, is refused too, because it cannot be told.
    const foundDir = foundText !== null ? handoffs.handoffDir(foundText) : null;
    const provablyOutside = Boolean(found && foundDir)
      && handoffs.scopeKey(foundDir) !== handoffs.scopeKey(home);
    if (provablyOutside && !slugCouldBeThread(slug, home)) {
      return { mode: 'pooled', kind: found.kind, path: found.path, dir: foundDir, unreadable: null };
    }
    return { mode: 'invalid', refused: 'registry-invalid', errors: reg.errors, path: registryMod.registryPath(home) };
  }
  // Half a migration is neither the old answer nor the new one, so it is not
  // offered as either for anything in the home scope. The pending rules are
  // named so nobody mistakes the refusal for an empty list. Handoffs outside
  // the home scope were never part of the migration and are answered as usual.
  const early = registryMod.declaredBySlug(reg.registry, slug) ? null : resolve(slug, home);
  if (early && early.kind !== 'history') {
    return { mode: 'pooled', kind: early.kind, path: early.path, dir: early.dir, unreadable: early.unreadable };
  }
  if (reg.registry.pending.length) {
    return {
      mode: 'threads',
      refused: 'migration-unfinished',
      pending: reg.registry.pending.filter((p) => p.slug === registryMod.declaredBySlug(reg.registry, slug)?.slug),
      pendingTotal: reg.registry.pending.length,
    };
  }
  const declared = registryMod.declaredBySlug(reg.registry, slug);
  if (!declared) {
    const r = resolve(slug, home);
    // Only an undeclared home handoff is history. A project handoff, or a
    // central one written from anywhere else, still gets the older pooled
    // answer for its own working directory, exactly as before migration.
    if (r.kind === 'history') return { mode: 'threads', kind: 'history', path: r.path, binding: false, constraints: [] };
    return { mode: 'pooled', kind: r.kind, path: r.path, dir: r.dir, unreadable: r.unreadable };
  }
  let text;
  try { text = fs.readFileSync(declared.path, 'utf8'); } catch (e) {
    return {
      mode: 'threads',
      refused: e && e.code === 'ENOENT' ? 'declared-missing' : 'declared-unreadable',
      path: declared.path,
      slug: declared.slug,
      detail: e.message,
    };
  }
  // A declared thread whose document says it was written somewhere other than
  // home is a hand edit that makes a project's rules look like a thread's.
  // Refused, never read as binding.
  if (!handoffs.handoffDir(text)) {
    return { mode: 'threads', refused: 'declared-no-directory', path: declared.path, slug: declared.slug };
  }
  if (!inHomeScope(text, home)) {
    return { mode: 'threads', refused: 'declared-out-of-scope', path: declared.path, slug: declared.slug };
  }
  const { live, retired } = handoffs.bulletsIn(text);
  const constraints = live.map((c) => ({ text: c, from: declared.slug, path: declared.path }));
  return {
    mode: 'threads',
    kind: 'thread',
    binding: true,
    slug: declared.slug,
    path: declared.path,
    rev: rev(text),
    generation: reg.registry.generation,
    constraints,
    retiredHere: retired,
    nearDuplicates: handoffs.nearDuplicateConstraints(constraints),
  };
}

// ------------------------------------------------------------------ save ----

function refuse(reason, detail, extra = {}) {
  return { saved: false, declared: false, indexUpdated: false, reason, detail, ...extra };
}

// The only way a thread's document is written.
//
// The model writes the whole new handoff to a draft file, then this swaps it in
// only if the thread is still at the revision the session started from. That
// check and the write happen under one lock, which is the part a timestamp
// comparison followed by a separate write could never give: another session
// could always land between the two.
//
// Everything that can be refused is refused before anything is written, and the
// result reports each part on its own, because "saved" and "the index knows"
// and "declared as a thread" can each fail without the others.
function saveThread({
  slug, from, base, generation, create = false, home = os.homedir(), now = Date.now(),
}) {
  const key = String(slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!key) return refuse('bad-input', 'no thread slug given');
  if (!from) return refuse('bad-input', 'no draft file given (--from)');
  if (base === undefined || base === null || base === '') return refuse('bad-input', 'no base revision given (--base <rev> or --base none)');
  if (!Number.isInteger(generation)) return refuse('bad-input', 'no generation given (--generation N)');

  const protection = config.loadProtection(home);
  if (!protection.ok) return refuse('config-invalid', protection.errors.join('; '), { draft: from });

  let draft;
  try { draft = fs.readFileSync(from, 'utf8'); } catch (e) {
    return refuse('draft-missing', `the draft at ${from} could not be read: ${e.message}`);
  }
  if (!draft.trim()) return refuse('draft-missing', `the draft at ${from} is empty`);
  if (!inHomeScope(draft, home)) {
    return refuse('out-of-scope',
      handoffs.handoffDir(draft)
        ? 'threads are for handoffs written from the home directory; the draft\'s **Working directory:** line names somewhere else'
        : 'the draft has no **Working directory:** line, and a thread\'s must name the home directory',
      { draft: from });
  }

  const pre = registryMod.readRegistry(home);
  if (pre.state === 'absent') {
    return refuse('pre-migration', 'threads are not set up yet, so central handoffs are still written the older way (cli.js target)', { draft: from });
  }
  if (pre.state === 'invalid') return refuse('registry-invalid', pre.errors.join('; '), { draft: from });

  const target = create
    ? path.join(handoffs.handoffRoot(home), `HANDOFF-${key}.md`)
    : (registryMod.declaredBySlug(pre.registry, key) || {}).path;
  if (!target) return refuse('not-declared', `${key} is not a declared thread`, { draft: from });
  if (config.isProtected(protection, target, home)) return refuse('protected', `${target} is protected`, { draft: from });

  return handoffs.mutateIndex(home, (index, saveIndex) => {
    // Everything checked again under the lock, because every answer above was
    // given without it and another session may have changed any of them since.
    const reg = registryMod.readRegistry(home);
    if (reg.state === 'absent') {
      return refuse('pre-migration', 'the thread list was removed while this waited, so threads are not set up', { draft: from });
    }
    if (reg.state !== 'ok') return refuse('registry-invalid', reg.errors.join('; '), { draft: from });
    // Protection too: an entry added while this waited is honoured now.
    const protectionNow = config.loadProtection(home);
    if (!protectionNow.ok) return refuse('config-invalid', protectionNow.errors.join('; '), { draft: from });
    if (config.isProtected(protectionNow, target, home)) return refuse('protected', `${target} is protected`, { draft: from });
    if (reg.registry.pending.length) {
      return refuse('migration-unfinished', 'a migration is part way through; run cli.js migrate finish first', { draft: from });
    }
    if (reg.registry.generation !== generation) {
      return refuse('generation',
        `this draft was prepared under thread list generation ${generation} and the list is now at ${reg.registry.generation}`,
        { draft: from });
    }
    const declared = registryMod.declaredBySlug(reg.registry, key);
    if (create && declared) return refuse('already-declared', `${key} is already a declared thread`, { draft: from });
    if (!create && (!declared || !samePath(declared.path, target))) {
      return refuse('not-declared', `${key} is no longer declared at ${target}`, { draft: from });
    }

    // A link whose target is gone counts as there, as resolve counts it, so
    // it falls through to the unreadable refusal instead of "not there".
    let linked = false;
    try { linked = fs.lstatSync(target).isSymbolicLink(); } catch (_) { /* nothing there */ }
    const exists = fs.existsSync(target) || linked;
    if (!create && !exists) return refuse('declared-missing', `the declared thread file ${target} is not there`, { draft: from });
    if (create && exists) {
      return refuse('name-taken', `${target} already exists as a handoff that is not a thread; choose another name, or adopt it with cli.js declare ${key}`, { draft: from });
    }
    // The index is the only record of where a project handoff kept outside the
    // configured roots went. A new thread must not take its slug and cut it off.
    const indexed = index[key];
    // For a new thread any live entry is a claim, including one for this very
    // path: a wrap that recorded it moments ago and has not written yet would
    // otherwise write over the thread as soon as it finished.
    const claimed = indexed && indexed.path && handoffs.entryState(indexed) !== 'gone';
    if (create && claimed) {
      return refuse('name-taken', `${key} already names ${indexed.path}; choose another name`, { draft: from });
    }
    const current = exists ? fileRev(target) : 'none';
    // Present and unreadable is its own answer. Reported as a conflict it told
    // the wrap to re-read and merge a file nobody can read.
    if (current === null) return refuse('unreadable', `${target} is there and could not be read`, { draft: from });
    if (current !== base) {
      return refuse('conflict',
        'the thread changed since this session read it; re-read it, merge this session into it, and save again',
        { draft: from, currentRev: current, base });
    }
    if (lockLost(handoffs.indexLockPath(home))) return refuse('lock-lost', 'the handoff lock was taken over', { draft: from });

    let written;
    try {
      written = atomicWrite(target, draft, holdingLock(home));
    } catch (e) {
      const still = fileRev(target);
      // Only claimed when checked: the document is still what it was. For a
      // new thread there was no previous document, so none is claimed
      // unchanged; `nothingWritten` says the path is still empty instead.
      return refuse('write-failed', e.message, {
        draft: from,
        previousUnchanged: exists ? still === current : false,
        nothingWritten: !exists && still === null,
        path: target,
      });
    }
    const saved = written === rev(draft);

    let declaredOk = !create;
    if (create && saved) {
      try {
        registryMod.writeRegistryUnlocked({
          ...reg.registry,
          threads: [...reg.registry.threads, { slug: key, path: target }],
        }, home, holdingLock(home));
        declaredOk = true;
      } catch (_) {
        declaredOk = false;
      }
    }

    // Left alone when it names some other document that still exists: that
    // entry may be the only way to find it, and `resolve` reports the clash.
    let indexUpdated = false;
    const indexConflict = liveOtherEntry(indexed, target) ? indexed.path : null;
    if (saved && !indexConflict) {
      index[key] = { path: target, kind: 'central', recorded_at: new Date(now).toISOString() };
      indexUpdated = saveIndex(index);
    }

    return {
      saved,
      declared: declaredOk,
      indexUpdated,
      path: target,
      slug: key,
      rev: written,
      previousRev: exists ? current : null,
      generation,
      // Why the index was not updated, when that is the reason: the slug is
      // recorded against another handoff, which `find` will report as a
      // conflict. Said here, at the one moment it can still be dealt with.
      indexConflict,
      ...(saved ? {} : { reason: 'verify-failed', detail: 'what is on disk is not the draft', draft: from }),
      ...(create && saved && !declaredOk
        ? { reason: 'not-declared-yet', detail: `saved, but not added to the thread list; run cli.js declare ${key}` }
        : {}),
    };
  }, {
    mayCreate: true,
    refused: (reason) => refuse(lockRefusalReason(reason), handoffs.lockReason(reason), { draft: from }),
  });
}

// Adds an existing central handoff to the thread list. The retry for a save
// that wrote the document and could not declare it, and the way to promote one
// history document on purpose.
function declareThread({ slug, home = os.homedir() }) {
  const key = String(slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const target = path.join(handoffs.handoffRoot(home), `HANDOFF-${key}.md`);
  const protection = config.loadProtection(home);
  if (!protection.ok) return { declared: false, reason: 'config-invalid', detail: protection.errors.join('; ') };
  if (config.isProtected(protection, target, home)) return { declared: false, reason: 'protected', detail: target };
  let text;
  try { text = fs.readFileSync(target, 'utf8'); } catch (_) {
    return { declared: false, reason: 'missing', detail: `${target} is not there` };
  }
  if (!inHomeScope(text, home)) return { declared: false, reason: 'out-of-scope', detail: target };

  return handoffs.mutateIndex(home, () => {
    // The file is checked again under the lock: it may have been removed or
    // rewritten while this waited, and declaring it anyway leaves a thread
    // every later pickup refuses.
    let now;
    try { now = fs.readFileSync(target, 'utf8'); } catch (_) {
      return { declared: false, reason: 'missing', detail: `${target} is not there` };
    }
    if (!inHomeScope(now, home)) return { declared: false, reason: 'out-of-scope', detail: target };
    const protectionNow = config.loadProtection(home);
    if (!protectionNow.ok) return { declared: false, reason: 'config-invalid', detail: protectionNow.errors.join('; ') };
    if (config.isProtected(protectionNow, target, home)) return { declared: false, reason: 'protected', detail: target };
    const reg = registryMod.readRegistry(home);
    if (reg.state !== 'ok') return { declared: false, reason: reg.state === 'absent' ? 'pre-migration' : 'registry-invalid', detail: reg.errors.join('; ') };
    if (registryMod.declaredBySlug(reg.registry, key)) return { declared: true, slug: key, path: target, already: true };
    if (reg.registry.pending.length) {
      return { declared: false, reason: 'migration-unfinished', detail: 'a migration is part way through; run cli.js migrate finish first' };
    }
    if (liveOtherEntry(handoffs.readIndex(home)[key], target)) {
      return { declared: false, reason: 'name-taken', detail: `the index already gives ${key} to another handoff` };
    }
    try {
      registryMod.writeRegistryUnlocked({ ...reg.registry, threads: [...reg.registry.threads, { slug: key, path: target }] }, home, holdingLock(home));
    } catch (e) {
      return { declared: false, reason: 'write-failed', detail: e.message };
    }
    return { declared: true, slug: key, path: target };
  }, { mayCreate: true, refused: (reason) => ({ declared: false, reason: lockRefusalReason(reason), detail: handoffs.lockReason(reason) }) });
}

// ------------------------------------------------------------- migration ----

const MANIFEST_KIND = 'session-threads-migration';

// What changes if these documents become the home threads. Writes nothing.
//
// Both directions are computed. `lost` is every rule binding today that no
// declared thread holds. `gained` is every rule a thread holds that does not
// bind today, which is how a rule retired elsewhere would otherwise come back
// silently the moment its old carrier is declared. And each thread's own count
// is shown beside today's, because narrowing each thread to its own rules is
// the point of the change and is approved once, explicitly, rather than being
// read off a total.
function migratePlan({ slugs, home = os.homedir(), now = Date.now() }) {
  // Where home is itself a git checkout, every folder inside it shares home's
  // pool, so "the rules of the home directory" and "the rules of that
  // checkout" cannot be told apart, and a thread boundary drawn there keeps
  // cutting pools in half. Refused rather than half supported.
  // The same decision readRegistry makes, so the two cannot disagree.
  if (registryMod.homeIsCheckout(home)) {
    return { ok: false, reason: 'home-is-a-checkout', detail: 'the home directory is itself a git checkout, which threads do not support' };
  }
  const reg = registryMod.readRegistry(home);
  if (reg.state === 'ok') {
    return { ok: false, reason: 'already-migrated', detail: `${registryMod.registryPath(home)} already declares threads. New threads are added by save --create or declare.` };
  }
  if (reg.state === 'invalid') return { ok: false, reason: 'registry-invalid', detail: reg.errors.join('; ') };
  const protection = config.loadProtection(home);
  if (!protection.ok) return { ok: false, reason: 'config-invalid', detail: protection.errors.join('; ') };

  const list = (slugs || []).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return { ok: false, reason: 'bad-input', detail: 'name the threads: migrate plan --threads a-thread,b-thread' };

  const root = handoffs.handoffRoot(home);
  const threads = [];
  const problems = [];
  const seen = new Set();
  for (const s of list) {
    const found = handoffs.findHandoff(s, home);
    const key = handoffs.slugify(s);
    if (!found) { problems.push(`${s}: no handoff found`); continue; }
    if (path.dirname(found.path) !== root || found.kind !== 'central') {
      // A project the index knows by this name, from before threads existed:
      // moving its entry keeps it in its pool, where forgetting it did not.
      const indexedHere = handoffs.readIndex(home)[key];
      const project = indexedHere && samePath(indexedHere.path, found.path) && !String(found.path).startsWith(`${root}${path.sep}`);
      problems.push(project
        ? `${s}: the index maps it to the project handoff ${found.path}; run cli.js rekey ${key} to move that entry to its own name, then plan again`
        : `${s}: ${found.path} is not an open central handoff (archived and project handoffs cannot be threads)`);
      continue;
    }
    // The thread list only ever names the central file for a slug, so a slug
    // the index maps to some other file cannot become a thread under that name.
    if (!samePath(found.path, path.join(root, `HANDOFF-${key}.md`))) {
      problems.push(`${s}: the index maps it to ${found.path}, not HANDOFF-${key}.md; run cli.js reconcile`);
      continue;
    }
    // findHandoff skips an entry whose file is not there right now, such as
    // one on a volume that is not mounted, and falls through to the central
    // file. resolve still counts that entry as live, so without this the
    // thread would be reported as a conflict at every find after migration.
    const indexed = handoffs.readIndex(home)[key];
    if (liveOtherEntry(indexed, path.join(root, `HANDOFF-${key}.md`))) {
      problems.push(`${s}: the index still maps it to ${typeof indexed.path === 'string' ? indexed.path : 'a malformed entry'}, which is not reachable now; run cli.js reconcile`);
      continue;
    }
    if (config.isProtected(protection, found.path, home)) { problems.push(`${s}: ${found.path} is protected`); continue; }
    let text;
    try { text = fs.readFileSync(found.path, 'utf8'); } catch (e) {
      problems.push(`${s}: ${found.path} could not be read: ${e.message}`);
      continue;
    }
    if (!inHomeScope(text, home)) { problems.push(`${s}: its working directory is not the home directory`); continue; }
    if (seen.has(found.path) || threads.some((t) => t.slug === key)) { problems.push(`${s}: named twice`); continue; }
    seen.add(found.path);
    threads.push({ slug: key, path: found.path, rev: rev(text), live: handoffs.bulletsIn(text).live });
  }
  if (problems.length) return { ok: false, reason: 'bad-threads', detail: problems.join('\n') };

  const before = handoffs.carriedConstraints({ cwd: home, home, includeThreads: true });
  // A handoff that is listed and cannot be read is missing from both the rule
  // comparison and the fingerprint, so the plan would be approved against less
  // than is there. Refused rather than planned around, wherever it belongs:
  // its Working directory cannot be read either, so whether it is home's is
  // not known, and ignoring other projects' unreadable files ignores it too.
  if (before.unreadable && before.unreadable.length) {
    return { ok: false, reason: 'unreadable', detail: `these handoffs could not be read: ${before.unreadable.join(', ')}` };
  }
  if (before.truncated) return { ok: false, reason: 'truncated', detail: 'the home scan hit its ceiling, so today\'s rules are not fully known' };
  if (before.gitDegraded) return { ok: false, reason: 'git-degraded', detail: `git scoping is degraded (${before.gitDegraded})` };

  const norm = handoffs.normalizeConstraint;
  const beforeSet = new Map(before.constraints.map((c) => [norm(c.text), c]));
  // Every thread holding each rule, not the first. A gained rule marked drop
  // has to leave every thread that carries it, or it keeps binding in the
  // second one.
  const afterSet = new Map();
  for (const t of threads) {
    for (const c of t.live) {
      const k = norm(c);
      if (!afterSet.has(k)) afterSet.set(k, { text: c, threads: [] });
      if (!afterSet.get(k).threads.includes(t.slug)) afterSet.get(k).threads.push(t.slug);
    }
  }

  const lost = [...beforeSet.entries()].filter(([k]) => !afterSet.has(k))
    .map(([, c]) => ({ text: c.text, from: c.from, disposition: null }));
  const gained = [...afterSet.entries()].filter(([k]) => !beforeSet.has(k))
    .map(([, c]) => ({ text: c.text, threads: c.threads, disposition: null }));

  const scanned = before.scanned.filter((d) => d.matched);
  const fingerprint = rev(JSON.stringify(scanned.map((d) => [d.path, fileRev(d.path), d.mtime])));

  return {
    ok: true,
    manifest: {
      kind: MANIFEST_KIND,
      version: 1,
      createdAt: new Date(now).toISOString(),
      home: homeScope(home),
      threads: threads.map((t) => ({ slug: t.slug, path: t.path, rev: t.rev })),
      perThread: threads.map((t) => ({ slug: t.slug, bindingToday: beforeSet.size, bindingAfter: new Set(t.live.map(norm)).size })),
      lost,
      gained,
      fingerprint,
      scannedDocuments: scanned.length,
    },
  };
}

const LOST_OK = /^(retire|shared:done|thread:[a-z0-9-]+)$/;
const GAINED_OK = /^(keep|drop)$/;

function checkShape(manifest) {
  const problems = [];
  for (const k of ['threads', 'lost', 'gained']) {
    if (!Array.isArray(manifest[k])) problems.push(`${k} must be a list`);
  }
  if (problems.length) return problems;
  manifest.threads.forEach((t, i) => {
    if (!t || typeof t.slug !== 'string' || typeof t.path !== 'string') problems.push(`thread ${i + 1} needs a slug and a path`);
  });
  manifest.lost.forEach((r, i) => {
    if (!r || typeof r.text !== 'string') problems.push(`lost ${i + 1} has no text`);
  });
  manifest.gained.forEach((r, i) => {
    if (!r || typeof r.text !== 'string') problems.push(`gained ${i + 1} has no text`);
    else if (!Array.isArray(r.threads) || !r.threads.every((x) => typeof x === 'string')) problems.push(`gained ${i + 1} has no list of threads`);
    // Checked here, as the lost side is: a thread name not in the plan was
    // otherwise caught only when the list was written, and reported as a
    // failed write, which reads as a disk problem rather than a bad plan.
    else if (!r.threads.every((x) => manifest.threads.some((t) => t && t.slug === x))) problems.push(`gained ${i + 1} names a thread that is not in this plan`);
  });
  if (typeof manifest.fingerprint !== 'string') problems.push('fingerprint is missing');
  return problems;
}

function checkDispositions(manifest) {
  const problems = [];
  const slugs = new Set(manifest.threads.map((t) => t.slug));
  manifest.lost.forEach((row, i) => {
    const d = row.disposition;
    if (typeof d !== 'string' || !LOST_OK.test(d)) problems.push(`lost ${i + 1} ("${row.text.slice(0, 60)}"): needs retire, shared:done, or thread:<slug>`);
    else if (d.startsWith('thread:') && !slugs.has(d.slice(7))) problems.push(`lost ${i + 1}: ${d.slice(7)} is not one of the threads being declared`);
  });
  manifest.gained.forEach((row, i) => {
    if (typeof row.disposition !== 'string' || !GAINED_OK.test(row.disposition)) problems.push(`gained ${i + 1} ("${row.text.slice(0, 60)}"): needs keep or drop`);
  });
  return problems;
}

function sameRows(a, b, field) {
  // Raw text, not normalized: a plan edited from `a - b` to `a\n- b` is the
  // same rule to the normalizer and two bullets once it is written.
  const key = (r) => `${r.text}\u0000${[].concat(r[field]).join(',')}`;
  const x = a.map(key).sort();
  const y = b.map(key).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// Commit first, then write. The thread list is written before any thread file
// is touched, and from that moment the home pool no longer binds, so none of
// the writes that follow can reorder a pool that still matters. Writing the
// assignments first was the other order, and it reintroduced the defect the
// whole change exists to remove: saving an older thread made it the newest
// document and revived a rule a newer one had retired.
function migrateApply({
  manifestPath, acceptNarrowing = false, sessionsRestarted = false, home = os.homedir(), now = Date.now(),
}) {
  if (!acceptNarrowing) {
    return { committed: false, reason: 'narrowing-not-accepted', detail: 'each thread will bind only its own rules; pass --accept-narrowing once you have read perThread' };
  }
  if (!sessionsRestarted) {
    return { committed: false, reason: 'sessions', detail: 'finish or restart every session in Claude Code and Codex first, then pass --confirm-sessions-restarted' };
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {
    return { committed: false, reason: 'manifest', detail: `could not read ${manifestPath}: ${e.message}` };
  }
  if (!manifest || manifest.kind !== MANIFEST_KIND || manifest.version !== 1) {
    return { committed: false, reason: 'manifest', detail: `${manifestPath} is not a migration plan` };
  }
  // Shape first, so a hand-edited plan is refused in words rather than
  // crashing inside the locked region.
  const shape = checkShape(manifest);
  if (shape.length) return { committed: false, reason: 'manifest', detail: shape.join('\n') };
  const problems = checkDispositions(manifest);
  if (problems.length) return { committed: false, reason: 'dispositions', detail: problems.join('\n') };

  return handoffs.mutateIndex(home, () => {
    const fresh = migratePlan({ slugs: manifest.threads.map((t) => t.slug), home, now });
    if (!fresh.ok) return { committed: false, reason: fresh.reason, detail: fresh.detail };
    const m = fresh.manifest;
    if (m.fingerprint !== manifest.fingerprint
      || !sameRows(m.lost, manifest.lost, 'from')
      || !sameRows(m.gained, manifest.gained, 'threads')
      || JSON.stringify(m.threads) !== JSON.stringify(manifest.threads)) {
      return { committed: false, reason: 'changed-since-plan', detail: 'handoffs changed after the plan was made; run migrate plan again and review the new rows' };
    }

    const pending = [
      ...manifest.lost.filter((r) => r.disposition.startsWith('thread:'))
        .map((r) => ({ kind: 'add', slug: r.disposition.slice(7), text: r.text })),
      ...manifest.gained.filter((r) => r.disposition === 'drop')
        .flatMap((r) => r.threads.map((slug) => ({ kind: 'drop', slug, text: r.text }))),
    ];
    // Never reused. A plain counter would restart at 1 if the list were ever
    // deleted and made again, and a draft from the first list would then pass
    // the second list's check.
    // To redo a migration, delete threads.json, which returns everything to
    // the older behaviour, and plan again. There is deliberately no in-place
    // replace: it would need its own review of a thread list against another.
    const generation = Math.max(1, Math.floor(now / 1000));
    try {
      registryMod.writeRegistryUnlocked({
        version: 1,
        generation,
        migratedAt: new Date(now).toISOString(),
        threads: manifest.threads.map((t) => ({ slug: t.slug, path: t.path })),
        pending,
      }, home, holdingLock(home));
    } catch (e) {
      return { committed: false, reason: 'write-failed', detail: `the thread list was not written: ${e.message}` };
    }

    const finished = finishPendingLocked(home);
    return { committed: true, generation, ...finished };
  }, {
    mayCreate: true,
    refused: (reason) => ({ committed: false, reason: lockRefusalReason(reason), detail: handoffs.lockReason(reason) }),
  });
}

// Add a bullet at the end of the constraints section, making the section if a
// thread has none.
function insertBullet(text, bullet) {
  // A document written with CRLF keeps CRLF, or the new line is the only one
  // that differs and every later diff shows it.
  if (text.includes('\r\n')) return insertBullet(text.replace(/\r\n/g, '\n'), bullet).replace(/\n/g, '\r\n');
  const line = `- ${bullet}`;
  const re = /^#{2,6}\s*Constraints still in force\s*$/mi;
  const m = re.exec(text);
  if (!m) {
    const heading = /^## /m.exec(text.slice(1));
    const block = `## Constraints still in force\n${line}\n\n`;
    if (!heading) return `${text.replace(/\s*$/, '')}\n\n${block}`;
    const at = heading.index + 1;
    return text.slice(0, at) + block + text.slice(at);
  }
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const next = /^#{1,6}\s/m.exec(rest);
  const end = next ? start + next.index : text.length;
  const section = text.slice(start, end);
  const lines = section.split('\n');
  let last = -1;
  lines.forEach((l, i) => { if (l.trim().startsWith('- ')) last = i; });
  if (last === -1) lines.splice(1, 0, line);
  else lines.splice(last + 1, 0, line);
  return text.slice(0, start) + lines.join('\n') + text.slice(end);
}

function dropBullet(text, bullet) {
  if (text.includes('\r\n')) {
    const r = dropBullet(text.replace(/\r\n/g, '\n'), bullet);
    return { text: r.text.replace(/\n/g, '\r\n'), removed: r.removed };
  }
  const want = handoffs.normalizeConstraint(bullet);
  const re = /^#{2,6}\s*Constraints still in force\s*$/mi;
  const m = re.exec(text);
  if (!m) return { text, removed: false };
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const next = /^#{1,6}\s/m.exec(rest);
  const end = next ? start + next.index : text.length;
  const lines = text.slice(start, end).split('\n');
  const kept = lines.filter((l) => !(l.trim().startsWith('- ') && handoffs.normalizeConstraint(l.trim().slice(2)) === want));
  return { text: text.slice(0, start) + kept.join('\n') + text.slice(end), removed: kept.length !== lines.length };
}

// Must be called holding the lock. Writes each pending item into its thread,
// removing it from the list only after the write is read back, so a failure
// part way leaves exactly the unwritten items pending.
function finishPendingLocked(home) {
  const applied = [];
  const failures = [];
  for (;;) {
    // Each item is a read and two writes, and a long list can outlast the
    // lock's staleness threshold without this.
    refreshLock(handoffs.indexLockPath(home));
    const reg = registryMod.readRegistry(home);
    if (reg.state !== 'ok') {
      failures.push({ error: `the thread list cannot be read: ${reg.errors.join('; ')}` });
      break;
    }
    if (!reg.registry.pending.length) break;
    const item = reg.registry.pending[0];
    const t = registryMod.declaredBySlug(reg.registry, item.slug);
    try {
      // Read again for every item: a protection added while earlier items
      // were being written has to hold for the later ones.
      const protection = config.loadProtection(home);
      if (!protection.ok) throw new Error(`protected handoffs could not be read: ${protection.errors.join('; ')}`);
      if (config.isProtected(protection, t.path, home)) throw new Error(`${t.path} is protected`);
      if (lockLost(handoffs.indexLockPath(home))) throw new Error('the handoff lock was taken over');
      const text = fs.readFileSync(t.path, 'utf8');
      const live = handoffs.bulletsIn(text).live.map(handoffs.normalizeConstraint);
      const has = live.includes(handoffs.normalizeConstraint(item.text));
      let next = text;
      if (item.kind === 'add' && !has) next = insertBullet(text, item.text);
      if (item.kind === 'drop' && has) next = dropBullet(text, item.text).text;
      if (next !== text) {
        const written = atomicWrite(t.path, next, holdingLock(home));
        if (written !== rev(next)) throw new Error(`${t.path} did not read back as written`);
      }
      registryMod.writeRegistryUnlocked({ ...reg.registry, pending: reg.registry.pending.slice(1) }, home, holdingLock(home));
      applied.push(item);
    } catch (e) {
      failures.push({ ...item, error: e.message });
      break;
    }
  }
  const after = registryMod.readRegistry(home);
  if (after.state !== 'ok' && !failures.length) failures.push({ error: 'the thread list cannot be read after writing' });
  return { applied, failures, remaining: after.state === 'ok' ? after.registry.pending.length : null };
}

function migrateFinish({ home = os.homedir() } = {}) {
  const reg = registryMod.readRegistry(home);
  if (reg.state !== 'ok') return { finished: false, reason: reg.state === 'absent' ? 'pre-migration' : 'registry-invalid', detail: reg.state === 'absent' ? 'threads are not set up, so there is nothing to finish' : reg.errors.join('; ') };
  return handoffs.mutateIndex(home, () => {
    const r = finishPendingLocked(home);
    return { finished: r.failures.length === 0 && r.remaining === 0, ...r };
  }, {
    mayCreate: true,
    refused: (reason) => ({ finished: false, reason: lockRefusalReason(reason), detail: handoffs.lockReason(reason) }),
  });
}

module.exports = {
  rev,
  inHomeScope,
  isHomeDir,
  couldBeThread,
  threadShaped,
  projectNameShadowed,
  projectKey,
  assignedElsewhere,
  freeNumbered,
  rekeyProject,
  slugCouldBeThread,
  resolve,
  listThreads,
  threadConstraints,
  saveThread,
  declareThread,
  migratePlan,
  migrateApply,
  migrateFinish,
  insertBullet,
  dropBullet,
  subjectOf,
  MANIFEST_KIND,
};
