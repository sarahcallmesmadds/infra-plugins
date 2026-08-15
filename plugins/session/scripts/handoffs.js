// Where handoff documents live, how they are found, and how old ones get out
// of the way.
//
// `wrap` writes them and `pickup` reads them, and both used to carry their own
// copy of the search order. They drifted, which is the ordinary fate of a rule
// written down twice. The order lives here now and both skills point at it.
//
// The previous version of this was a bash script at
// ~/.claude/skills/wrap/archive-stale-handoffs.sh. It is node here for two
// reasons: a plugin cannot assume anything exists under ~/.claude/skills (on
// this machine that directory does not exist at all, because everything is
// installed from marketplaces), and a shell script that moves files is
// unpleasant to test without actually moving files.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./config');
const { withIndexLock, warnUnprotectedWrite } = require('./index-lock');

const DEFAULT_STALE_DAYS = 30;

function handoffRoot(home = os.homedir()) {
  return path.join(home, '.planning', 'handoffs');
}

// The lock covering every read-then-write of the index.
//
// Next to the file it protects, so two homes lock independently and the tests
// can drive contention inside a throwaway one.
function indexLockPath(home = os.homedir()) {
  return path.join(handoffRoot(home), '.index.lock');
}

function archiveRoot(home = os.homedir()) {
  return path.join(handoffRoot(home), 'archived');
}

// The per-project directory Claude Code keeps transcripts and memory in.
//
// The slug is the working directory with every character outside [A-Za-z0-9]
// replaced by a hyphen. That is not a guess: it was checked against a captured
// SessionStart event, whose cwd
//   /private/tmp/claude-501/-Users-sarahmadden/3667d77f-.../scratchpad/capture
// produced the transcript directory
//   -private-tmp-claude-501--Users-sarahmadden-3667d77f-...-scratchpad-capture
// including the doubled hyphen where the path itself contained one.
//
// Returns null when the directory is absent. A project that has never had a
// memory directory is the normal case for most people using this plugin, and
// `wrap` must not create one; that is the harness's to own, not this plugin's.
function memoryDir(cwd, home = os.homedir()) {
  if (!cwd) return null;
  const slug = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(home, '.claude', 'projects', slug, 'memory');
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch (_) {
    return null;
  }
}

// Where `wrap` should write, given where it is standing.
//
// A directory with its own work scope gets its handoff alongside the work, so
// it travels with the repository and `pickup <repo-name>` finds it. Anything
// else goes to the central folder under a topic slug, so that home directory
// sessions do not scatter HANDOFF.md files across the home directory or,
// worse, overwrite one another. That second failure is why the central path
// is keyed by topic rather than being a single file.
function writeTarget(cwd, topicSlug, home = os.homedir()) {
  const isProjectRoot = cwd
    && cwd !== home
    && ['.git', 'package.json', '.planning', 'pyproject.toml', 'Cargo.toml', 'go.mod']
      .some((marker) => {
        try { return fs.existsSync(path.join(cwd, marker)); } catch (_) { return false; }
      });

  if (isProjectRoot) {
    // Slugified, not the raw basename. `pickup` runs whatever it is given
    // through slugify before looking, so a directory named `My.Repo` printed a
    // pickup line of `/pickup My.Repo` that then searched for `my-repo` and
    // found nothing. The two have to agree, so only one of them decides.
    return { path: path.join(cwd, 'HANDOFF.md'), slug: slugify(path.basename(cwd)), kind: 'project' };
  }
  const slug = slugify(topicSlug) || 'session';
  return { path: path.join(handoffRoot(home), `HANDOFF-${slug}.md`), slug, kind: 'central' };
}

// ---------------------------------------------------------------------------
// The index, and why guessing cannot replace it.
//
// A central handoff is findable by name because this decides its filename. A
// project handoff is not: it goes next to the work, and the work can be
// anywhere. Reconstructing that path from a slug means guessing the parent
// directory, and the first version guessed `~/Projects`, which meant the
// headline loop silently failed for anyone whose repositories live somewhere
// else. Wrap wrote the file and reported success, pickup looked in one place
// and reported that nothing existed. Both were working as written.
//
// Guessing more directories does not fix that, it just moves the line between
// people it works for and people it does not. The writer is the only thing that
// knows where the file went, so the writer records it.
//
// `projectRoots` in the config is not a retreat from that. It is a list the user
// states rather than one this file invents, it defaults to the single `~/Projects`
// that was hardcoded, and it exists for the two cases the index cannot cover: a
// person whose code has never been under `~/Projects`, and a repo moved between
// two roots after its entry was written. The index stays the authority on where
// a handoff actually is.
//
// The index is a convenience, never an authority. Every lookup checks the file
// is still there, so a moved or deleted project degrades to "not found"
// instead of to a confident path that resolves to nothing.
//
// Degrading to "not found" is correct and was also how a stale entry became
// indistinguishable from a handoff that never existed. `staleRecord` below
// reports the recorded path on a miss so the failure can name it, without
// `findHandoff` ever handing back a path that resolves to nothing.

function indexPath(home = os.homedir()) {
  return path.join(handoffRoot(home), 'index.json');
}

function readIndex(home = os.homedir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(home), 'utf8'));
    return raw && typeof raw.handoffs === 'object' && raw.handoffs ? raw.handoffs : {};
  } catch (_) {
    return {};
  }
}

// Record where a handoff went, so it can be found by name later.
//
// Called with the intended path, before the file necessarily exists. That is
// deliberate: an entry pointing at a file that was never written costs nothing,
// because every read verifies existence, whereas an entry that was never
// written costs the whole lookup.
//
// The read and the write are one locked region. Separately they were the bug
// that unlisted 13 of 47 handoffs: two sessions wrapping at once both read the
// index, both added their own entry, and the second rename discarded the
// first. See `index-lock.js` for why the atomic rename in `writeIndex` did not
// already cover this.
function recordHandoff({ slug, target, kind, home = os.homedir(), now = Date.now() }) {
  if (!slug || !target) return null;
  // The one caller that always writes, so it is the one allowed to create the
  // handoffs folder. Recording a handoff on a machine that has never had one is
  // the whole job, not a side effect of looking.
  return mutateIndex(home, (handoffs, save) => {
    handoffs[slugify(slug)] = { path: target, kind: kind || 'project', recorded_at: new Date(now).toISOString() };
    return save(handoffs) ? handoffs : null;
  }, { mayCreate: true });
}

// Write the index the only way it is ever written: to a temporary file, then
// renamed over the real one.
//
// Two sessions in the same directory is the ordinary case rather than the
// exotic one, and a plain write leaves a window where a concurrent read sees a
// half-written file. `rename` is atomic, so a reader gets either the old index
// or the new one and never something in between.
//
// Shared by every writer here so that a new one cannot be added with a plain
// `writeFileSync`, which is how the guarantee would quietly be lost.
//
// Named `Unlocked` because on its own it is not safe to call. It covers one
// writer and says nothing about two, which is the whole of the bug that
// `index-lock.js` exists for. `mutateIndex` below is the only thing that calls
// it, and a second call site would be the defect rather than a use.
function writeIndexUnlocked(handoffs, home = os.homedir()) {
  try {
    fs.mkdirSync(handoffRoot(home), { recursive: true });
    const file = indexPath(home);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, handoffs }, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return handoffs;
  } catch (_) {
    // Losing the index entry degrades pickup to the guessed locations below.
    // It must never take the wrap down, since the handoff itself is the point.
    return null;
  }
}

// The one way the index is ever changed.
//
// `change` is handed the current map and a `save`, and whatever it returns is
// returned to the caller. The lock, the read and the write all live here, so a
// new kind of change cannot be added that takes the lock and forgets to read
// inside it, or reads inside it and writes outside.
//
// A gate rather than four guarded call sites, and that distinction is the whole
// reason this function exists. The first version of this fix locked each of the
// four mutations separately and left `writeIndex` exported, which reads as the
// guarantee while leaving the next mutation free to route around it without
// deleting anything. That is the shape recorded against PR #55: a list of
// guarded call sites has to be extended by whoever adds the next option, and
// the fourth way in is the one that gets missed.
//
// `save` returns whether the write reached the disk, because
// `writeIndexUnlocked` swallows its errors and reporting a change that never
// landed is the other thing this plugin keeps catching in itself.
//
// `save` is also where an unprotected write announces itself, because it is the
// only place that knows a write happened at all. The warning used to be printed
// by the lock, up front, from the lock answer alone, and so it fired on every
// path through this gate including the ones that only read. A dry run said "an
// entry may have been lost" having changed nothing.
//
// `readOnly` is for a caller that knows in advance it cannot write. It skips
// the lock, so a preview does not wait behind another session's write. Do not
// pass it on a path that might call `save`: the point of this gate is that the
// read and the write are one region, and a write from an unlocked read is that
// guarantee gone.
// `mayCreate` says this caller always writes, so the handoffs folder existing
// afterwards is the point rather than a side effect. Only `recordHandoff` sets
// it. Everything else leaves a machine with no handoffs folder exactly as it
// found it, which is what it did before this gate existed.
function mutateIndex(home, change, { readOnly = false, mayCreate = false } = {}) {
  const lock = indexLockPath(home);
  return withIndexLock(lock, () => {
    const save = (handoffs) => {
      warnUnprotectedWrite(lock);
      return writeIndexUnlocked(handoffs, home) !== null;
    };
    return change(readIndex(home), save);
  }, { readOnly, mayCreate }).value;
}

// Drop one entry by slug, without touching the handoff it names.
//
// The separation is the whole point. `wrap` adds entries and nothing ever
// removed one, so the index only grew, and clearing a single stale entry meant
// hand-editing JSON. Deleting the document as well would make this a dangerous
// command to reach for, and the entry is not the work.
//
// Reports whether the file is still there so the caller can say so. Forgetting
// an entry whose document still exists is legitimate, and `pickup` will often
// still find it through the guessed paths, which is worth knowing before it
// surprises somebody.
function forgetHandoff(slug, home = os.homedir()) {
  const key = slugify(slug);
  if (!key) return { slug: key, removed: false, reason: 'empty slug' };

  // Locked for the same reason as `recordHandoff`, and with a sharper failure:
  // unlocked, a forget that lands between another session's read and write is
  // undone by that write, so the entry the user was told was dropped is still
  // there.
  return mutateIndex(home, (handoffs, save) => {
    const entry = handoffs[key];
    if (!entry) return { slug: key, removed: false, reason: 'not in the index' };

    let fileStillThere = false;
    try { fileStillThere = !!entry.path && fs.existsSync(entry.path); } catch (_) { /* treat as gone */ }

    delete handoffs[key];
    if (!save(handoffs)) {
      return { slug: key, removed: false, reason: 'the index could not be written', entry };
    }
    return { slug: key, removed: true, entry, fileStillThere };
  });
}

// Drop every entry whose file is not there any more.
//
// An entry is recorded before the document is written, on purpose, so an
// intent that was never fulfilled is normal and harmless: every lookup verifies
// the file exists. What is not harmless is that nothing ever cleared them, so
// a handoff whose project is deleted, renamed or moved leaves a permanent
// entry, and the file only grows.
//
// Never touches an entry whose file is present, so this cannot lose a handoff.
// Absent and unreachable are different answers, and only one of them is
// evidence of anything.
//
// A missing file is not proof the handoff is gone. Project handoffs live next
// to their work, and work lives on external disks, network shares and mounts
// that are not always up. `existsSync` returns false for all of it, so a prune
// that trusts it deletes the entry for a handoff that is merely offline.
//
// That is the worst thing this file could do. The index holds the one location
// that cannot be reconstructed: a project handoff can be anywhere, the guessed
// paths reach only `<root>/<slug>/HANDOFF.md` for the configured roots, and the
// writer is the only thing that ever knew where the file actually went. More
// roots narrow that gap without closing it, since a repo can sit outside every
// one of them. Losing the entry does not lose the document,
// it loses the ability to find it by name, which is the entire point.
//
// So the file is only treated as gone when the directory that would contain it
// is right there and the file is not in it. If the directory is missing too,
// nothing here can tell a deleted project from an unmounted volume, and the
// entry stays. The cost is that a genuinely deleted project keeps its entry,
// which `forget` exists to clear and which costs nothing until then, because
// every lookup verifies the file anyway.
function entryState(entry, now = Date.now()) {
  const target = entry && entry.path;
  if (!target) return 'gone';
  try {
    if (fs.existsSync(target)) return 'present';
    if (!fs.existsSync(path.dirname(target))) return 'unreachable';
    return recentlyRecorded(entry, now) ? 'pending' : 'gone';
  } catch (_) {
    // A path that cannot even be tested is the clearest case of not knowing.
    return 'unreachable';
  }
}

// A wrap records where it is about to write before it writes, on purpose, so
// there is always a moment where the entry names a document that is not there
// yet. `entryState` called that moment `gone` and the prune collected it, so a
// second session sweeping in that gap deleted the entry of a wrap that was
// still being written. The wrap then finished, reported success, and `/pickup`
// could not find it.
//
// So a young entry whose document has not appeared is `pending`: not present,
// and not evidence of anything either. The window is generous because being
// wrong in this direction is nearly free. The existing note above says an entry
// pointing at a file that was never written costs nothing, since every lookup
// checks the file anyway, so the price of waiting is one dead entry surviving
// ten minutes longer. The price of not waiting is a lost handoff.
//
// An entry with no usable `recorded_at` is not treated as young. Missing
// evidence is not evidence, and an index written before this field existed
// would otherwise become unprunable forever.
const PENDING_MS = 10 * 60 * 1000;

function recentlyRecorded(entry, now = Date.now()) {
  const stamp = entry && entry.recorded_at;
  if (!stamp) return false;
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return false;
  // A stamp from the future is a clock that disagrees rather than a young
  // entry, and treating it as young would make it unprunable for as long as the
  // clocks differ. Only the window behind now counts.
  return at <= now && now - at < PENDING_MS;
}

function pruneIndex({ home = os.homedir(), dryRun = false } = {}) {
  // Locked, and the write here replaces the whole map rather than one key, so
  // unlocked it discards every entry another session recorded since the read.
  // That makes this the most destructive of the four sites, not the least.
  //
  // Re-entrant: `archiveStale` calls this from inside the same lock, and both
  // halves of that sweep have to be one region anyway.
  //
  // A dry run cannot reach `save` below, so it says so and skips the lock. A
  // preview waiting five seconds behind another session, to preview state that
  // session is in the middle of changing, buys nothing.
  return mutateIndex(home, (handoffs, save) => {
    const dropped = [];
    const unreachable = [];
    const kept = {};

    const pending = [];
    for (const [key, entry] of Object.entries(handoffs)) {
      const state = entryState(entry);
      if (state === 'gone') {
        dropped.push({ slug: key, path: entry && entry.path });
        continue;
      }
      kept[key] = entry;
      if (state === 'unreachable') unreachable.push({ slug: key, path: entry.path });
      // Kept, and reported, because a sweep that silently spares something is
      // as hard to trust as one that silently drops it.
      if (state === 'pending') pending.push({ slug: key, path: entry.path });
    }

    // Whether the write succeeded, so the caller can say what happened rather
    // than what was attempted. `writeIndex` swallows its errors on purpose, and
    // reporting a drop that never reached the disk is the exact shape of bug
    // this plugin keeps finding in itself.
    let written = true;
    if (dropped.length && !dryRun) written = save(kept);

    return { dropped, unreachable, pending, written };
  }, { readOnly: dryRun });
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// `pickup`'s search order, as paths to try in order. The first that exists wins.
//
// Returned rather than resolved so the skill can show what it looked at when
// nothing matches, which is the moment a person needs to know the order.
function projectRoots(home = os.homedir()) {
  const configured = config.load(home).projectRoots;
  return configured.map((root) => (root.startsWith('~/')
    ? path.join(home, root.slice(2))
    : root));
}

function searchPaths(slug, home = os.homedir()) {
  const s = slugify(slug);
  if (!s) return [];
  return [
    { path: path.join(handoffRoot(home), `HANDOFF-${s}.md`), kind: 'central' },
    // One candidate per configured root, in configured order. With the default
    // single root this is the one path it always was, so nothing changes for
    // anyone who has not opted in.
    ...projectRoots(home).map((root) => ({ path: path.join(root, s, 'HANDOFF.md'), kind: 'project' })),
    { path: path.join(handoffRoot(home), `${s}-pause.md`), kind: 'pause' },
    { path: path.join(archiveRoot(home), `HANDOFF-${s}.md`), kind: 'archived' },
  ];
}

// The recorded path when the index holds one and the document is not there.
//
// `findHandoff` deliberately degrades a stale entry to "not found", because the
// index is a convenience and never an authority. That is right, and it is also
// how a stale entry became indistinguishable from a handoff that never existed:
// the miss listed the guessed candidates and never mentioned the one path that
// had actually been recorded. Reporting is separate from resolution so the miss
// can name it without `findHandoff` ever returning a path that resolves to
// nothing.
//
// `state` carries the distinction `entryState` already draws. `gone` means the
// containing directory is right there and the file is not in it. `unreachable`
// means the directory is missing too, which cannot tell a deleted project from
// an unmounted volume, so the caller must not describe it as lost.
function staleRecord(slug, home = os.homedir()) {
  const recorded = readIndex(home)[slugify(slug)];
  if (!recorded || !recorded.path) return null;
  const state = entryState(recorded);
  if (state === 'present') return null;
  return { path: recorded.path, kind: recorded.kind || 'project', state };
}

function findHandoff(slug, home = os.homedir()) {
  // The index first, because it holds the one location that cannot be guessed:
  // a project handoff sitting next to work that lives anywhere on the disk.
  //
  // Still verified rather than trusted. A recorded path whose file has since
  // been moved or deleted falls through to the candidates below, which is the
  // same outcome as never having recorded it. The index can only help.
  const recorded = readIndex(home)[slugify(slug)];
  if (recorded && recorded.path) {
    try {
      if (fs.existsSync(recorded.path)) {
        return {
          path: recorded.path,
          kind: recorded.kind || 'project',
          mtime: fs.statSync(recorded.path).mtimeMs,
        };
      }
    } catch (_) {
      // Fall through to the guessed locations.
    }
  }

  for (const candidate of searchPaths(slug, home)) {
    try {
      if (fs.existsSync(candidate.path)) {
        return { ...candidate, mtime: fs.statSync(candidate.path).mtimeMs };
      }
    } catch (_) {
      // An unreadable candidate is not a match. Keep looking.
    }
  }
  return null;
}

// Move handoffs untouched for `days` into archived/.
//
// Moves, never deletes, and `pickup` still finds an archived document by name,
// so the worst case of being too aggressive is a note on the summary rather
// than lost work. `dryRun` exists because the first thing anyone wants from a
// sweep is to see what it would do.
function archiveStale({ days = DEFAULT_STALE_DAYS, home = os.homedir(), now = Date.now(), dryRun = false } = {}) {
  const root = handoffRoot(home);
  const dest = archiveRoot(home);
  const moved = [];
  const relocations = [];

  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch (_) {
    // No handoffs directory yet. Nothing to sweep, and creating one here would
    // be a side effect nobody asked for.
    return {
      moved, root, skipped: true, repointed: [], pruned: [], unreachable: [], pending: [], indexWritten: true,
    };
  }

  const cutoff = now - days * 86400000;

  // Follow the files that just moved, before pruning.
  //
  // The sweep renames the document and left the index pointing at where it used
  // to be, so an entry for a handoff this very command archived became a dead
  // entry the moment it ran. Lookups still found it, because the search order
  // reaches archived/ on its own, but only by falling through the index rather
  // than using it, and the entry was then indistinguishable from one whose file
  // was genuinely deleted. Pruning without this step would throw it away.
  //
  // The kind changes with the move, so `pickup` can still open with the note
  // that this handoff was archived.
  // Worked out on a dry run too, rather than skipped.
  //
  // A preview that omits one of the three things the sweep does is not a
  // preview of the sweep. The gate used to cover the whole block, so a dry run
  // reported moves and prunes and stayed silent about the index entries it
  // would rewrite. Only the write is conditional now.
  const repointed = [];
  let repointWritten = true;

  // The repoint and the prune are one locked region, not two.
  //
  // They were two separate read-then-write pairs, so another session could
  // record a handoff between them and have it discarded by the prune's write.
  // Locking each half on its own would leave that window exactly where it was,
  // which is why the lock is taken here rather than inside the two blocks.
  // `pruneIndex` asks for the same lock and re-enters this region.
  //
  // One region means one answer, including when that answer is that the lock
  // could not be taken. The nested call inherits it rather than asking again,
  // so the two halves cannot end up on opposite sides of the lock. Devin round
  // 1 on PR #109 found that they could, back when the region was recorded only
  // on the acquiring path.
  //
  // The moves are inside the region too, and that is the third thing rather
  // than a tidy-up. They used to run before it, so between renaming a document
  // and repointing its entry there was a window where the index named a path
  // nothing was at. A second session pruning in that window read the entry,
  // found no file and a directory that still existed, called it gone and
  // deleted it. The sweep then repointed an entry that was no longer there.
  // Moving, repointing and pruning are one change to one thing, so they are one
  // region.
  const { dropped, unreachable, pending, written } = mutateIndex(home, (handoffs, save) => {
    for (const name of entries) {
      if (!name.startsWith('HANDOFF-') || !name.endsWith('.md')) continue;
      const from = path.join(root, name);
      const to = path.join(dest, name);
      try {
        const stat = fs.statSync(from);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        if (!dryRun) {
          fs.mkdirSync(dest, { recursive: true });
          fs.renameSync(from, to);
        }
        moved.push(name.replace(/^HANDOFF-/, '').replace(/\.md$/, ''));
        relocations.push({ from, to });
      } catch (_) {
        // One unreadable file must not stop the sweep.
      }
    }

    if (relocations.length) {
      let touched = false;
      for (const [key, entry] of Object.entries(handoffs)) {
        const hit = entry && relocations.find((r) => r.from === entry.path);
        if (!hit) continue;
        handoffs[key] = { ...entry, path: hit.to, kind: 'archived' };
        repointed.push({ slug: key, from: hit.from, to: hit.to });
        touched = true;
      }
      if (touched && !dryRun) repointWritten = save(handoffs);
    }

    // Re-enters the gate on this process, which reads the index again so the
    // prune sees the repoint above rather than the map from before it.
    return pruneIndex({ home, dryRun });
  }, { readOnly: dryRun });

  return {
    moved,
    root,
    skipped: false,
    repointed,
    pruned: dropped,
    unreachable,
    // Entries spared because they name a document that has not been written
    // yet. Reported rather than silently kept, so a sweep that spares something
    // is as visible as one that drops it.
    pending,
    // False when the index could not be written, so the printed summary can
    // say the change did not land instead of reporting it as done.
    indexWritten: repointWritten && written,
  };
}

// The newest handoffs, for the menu `pickup` shows when given no slug.
function recentHandoffs({ home = os.homedir(), limit = 5 } = {}) {
  const out = [];
  const seen = new Set();

  for (const dir of [handoffRoot(home), archiveRoot(home)]) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!name.startsWith('HANDOFF-') || !name.endsWith('.md')) continue;
      try {
        const full = path.join(dir, name);
        out.push({
          slug: name.replace(/^HANDOFF-/, '').replace(/\.md$/, ''),
          path: full,
          mtime: fs.statSync(full).mtimeMs,
          archived: dir === archiveRoot(home),
        });
        seen.add(full);
      } catch (_) { /* skip */ }
    }
  }

  // Project handoffs live next to their work rather than in this folder, so a
  // listing built only from the folder shows none of them. That made the menu
  // shown for a bare `/pickup` a list of exactly the handoffs that were already
  // easy to find by name, and none of the ones that were not.
  for (const [slug, entry] of Object.entries(readIndex(home))) {
    if (!entry || !entry.path || seen.has(entry.path)) continue;
    try {
      out.push({ slug, path: entry.path, mtime: fs.statSync(entry.path).mtimeMs, archived: false });
    } catch (_) {
      // Recorded but gone. Not shown, and not an error.
    }
  }

  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// The repository a directory belongs to, following a worktree back to its main
// checkout. Two handoffs for the same project can record different directories,
// because work moves into a worktree, and a plain string compare on those paths
// says they are unrelated. That is exactly how a design system was lost between
// two handoffs: the one carrying it recorded the canonical checkout, the one
// that superseded it recorded a worktree under /private/tmp, and nothing
// connected them.
//
// Returns null for a directory that is not in a repository, in which case the
// caller falls back to the realpath of the directory itself.
// Why repository scoping stopped working, when it did. Null means it is fine.
//
// Anything recorded here means the answer the command gives is arrived at by
// comparing paths rather than by asking git, so a worktree will not be grouped
// with its main checkout. That produces a confident, wrong "no constraints",
// which is the failure this feature exists to prevent, so it is never inferred
// from silence.
//
// A directory that is simply not a repository is not degradation and is not
// recorded: that is the ordinary case for a handoff written outside a checkout.
let gitDegraded = null;   // null | 'missing' | 'timeout'

function gitDegradedReason() { return gitDegraded; }

// Only these mean "this git cannot take the flag". Anything else is a real
// answer about the directory, and retrying costs a second spawn for nothing.
//
// Unverified, because no pre-2.31 git is available here to test against: some
// older `rev-parse` versions echo an unrecognised `--flag` on stdout and exit
// zero rather than failing. In that case this fallback never runs and the scope
// key is the echoed flag plus the common dir. That string is still the same for
// a worktree and its main checkout, so grouping stays correct and nothing is
// silently lost; it is only uglier than intended. Worth confirming against a
// real old git before relying on the fallback path itself.
const UNSUPPORTED_FLAG = /unknown option|unrecognized|error: invalid|usage: git rev-parse/i;

function repoRoot(dir) {
  const { execFileSync } = require('child_process');
  // A directory recorded in a handoff can sit on a network volume that is slow
  // or gone, and a synchronous spawn with no timeout hangs the whole command
  // there. Ten seconds is far past a local answer and far short of waiting on a
  // dead mount.
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 };
  const strip = (out) => (out ? out.trim().replace(/\/\.git\/?$/, '') || null : null);

  // Records why a probe failed, and says whether a second attempt is worth
  // making. The first version retried unconditionally, so every directory that
  // was not a repository cost two spawns, and a dead mount cost the full
  // timeout twice.
  const classify = (e) => {
    if (!e) return false;
    if (e.code === 'ENOENT') { gitDegraded = 'missing'; return false; }
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') { gitDegraded = gitDegraded || 'timeout'; return false; }
    return UNSUPPORTED_FLAG.test(String(e.stderr || ''));
  };

  try {
    return strip(execFileSync(
      'git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], opts,
    ));
  } catch (e) {
    // `--path-format` arrived in git 2.31. On anything older the whole
    // invocation fails, and the first version read that as "not a repository",
    // which silently disabled the worktree grouping this feature exists for.
    if (!classify(e)) return null;
  }

  // Old git. The bare form works everywhere and may answer relatively, so it is
  // resolved against the directory it was asked about.
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], opts).trim();
    if (!out) return null;
    return strip(path.isAbsolute(out) ? out : path.resolve(dir, out));
  } catch (e) {
    classify(e);
    return null;
  }
}

// One git spawn per distinct directory, not per handoff. A scan reads up to a
// few hundred documents and most of them name the same handful of directories,
// so without this the common case was dozens of blocking subprocesses to answer
// a question that has the same answer every time.
const scopeCache = new Map();

// The scope key two handoffs must share for one to inherit the other's
// constraints. Repository if there is one, resolved real path otherwise, so a
// project that is not a git checkout still groups with itself.
function scopeKey(dir) {
  if (!dir) return null;
  if (scopeCache.has(dir)) return scopeCache.get(dir);
  const repo = repoRoot(dir);
  let key;
  if (repo) key = repo;
  else {
    try { key = fs.realpathSync(dir); } catch (_) { key = path.resolve(dir); }
  }
  scopeCache.set(dir, key);
  return key;
}

// The directory a handoff document says it was written from. Two header spellings
// are in the wild: `**Working directory:** <path>` from the current template and
// `**Repository:** \`<path>\`` from handoffs written before it. Both are read,
// because the older ones are exactly the documents holding constraints nobody has
// re-recorded yet.
function handoffDir(text) {
  const m = text.match(/^\*\*(?:Working directory|Repository|Repo):\*\*\s*`?([^`\n]+)`?/mi);
  if (!m) return null;
  const expand = (s) => s.trim().replace(/^~(?=\/|$)/, os.homedir()).replace(/[`,]+$/, '').trim();

  // Handoff headers carry prose after the path often enough to matter:
  //   **Working directory:** /private/tmp/atf (git worktree of ~/Projects/x)
  // The first version cut the capture at `(`, which handled that and quietly
  // broke every project whose folder name contains a bracket. A path like
  // `/Users/x/Projects (archive)/repo` truncated to `/Users/x/Projects`, so its
  // constraints vanished and every other project under that parent inherited
  // the same key and each other's rules.
  //
  // So take the whole line, and only strip a trailing parenthetical when the
  // full string is not a directory that exists. Existence is the evidence; the
  // bracket alone never was.
  const whole = expand(m[1]);
  try { if (fs.statSync(whole).isDirectory()) return whole; } catch (_) { /* not a directory */ }

  const trimmed = expand(whole.replace(/\s*\([^)]*\)\s*$/, ''));
  if (trimmed && trimmed !== whole) {
    try { if (fs.statSync(trimmed).isDirectory()) return trimmed; } catch (_) { /* nor this */ }
  }

  // Neither resolves, which is normal: the handoff may describe a machine this
  // is not, or a volume that is not mounted. Prefer the trimmed form, since a
  // trailing annotation is far more common in these headers than a bracket in a
  // real folder name, and grouping is by string in that case anyway.
  return trimmed || whole || null;
}

// Every bullet under a `## Constraints still in force` heading, split into the
// live ones and the retirements, because both are needed and only one of them
// is a constraint.
//
// An unfilled template bullet is dropped. The test is that the WHOLE bullet is
// bracketed, not that it starts with one: a constraint is very naturally
// written as a markdown link, `- [the design system](path) governs site/`, and
// a leading-bracket test threw exactly those away without a word. That is the
// failure this feature exists to prevent, committed inside the feature.
function bulletsIn(text) {
  // Terminator is any ATX heading, `^#{1,6}\s`, not `^##\s`. The narrower form
  // does not match `### Notes`, because the character after `##` is a `#` and
  // not whitespace, so a nested subsection did not end the section and its
  // bullets were collected as constraints.
  //
  // The end-of-input assertion is `$(?![\s\S])`, not `\Z`. JavaScript has no
  // `\Z`, so it parsed as a literal Z and the section only ended at the next
  // heading. Constraints written last in a file, which is where they land,
  // read back as none while sitting there in plain sight.
  const m = text.match(/^#{2,6}\s*Constraints still in force\s*$([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/mi);
  if (!m) return { live: [], retired: [] };
  const bullets = m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean)
    .filter((l) => !/^\[.*\]$/.test(l));

  const live = [];
  const retired = [];
  for (const b of bullets) {
    const r = b.match(/^retired this session\s*:\s*(.+)$/i);
    if (r) retired.push(r[1].trim());
    else live.push(b);
  }
  return { live, retired };
}

// Bullets under the heading that are live constraints. Retirements are not
// constraints, so they do not appear here.
function constraintsIn(text) {
  return bulletsIn(text).live;
}

// What a handoff says stopped applying. Read by `carriedConstraints`, which is
// the only place retirement can actually be honoured: the document doing the
// retiring is not the document carrying the constraint, so dropping the line at
// parse time and stopping there made retirement completely inert.
function retiredIn(text) {
  return bulletsIn(text).retired;
}

// The form two constraint texts are compared in. Case, surrounding whitespace
// and a trailing full stop are all noise here.
function normalizeConstraint(s) {
  return s.trim().replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase();
}

// A retirement reads `Retired this session: <the constraint>, because <reason>.`
// The reason is prose that will not appear in the original bullet, so it comes
// off before matching. Everything before the LAST `, because` is the quoted
// constraint.
//
// The last, not the first. `String.replace` with a non-global pattern cuts from
// the leftmost match, so a constraint whose own wording contains "because" was
// truncated mid-quote: `Use the glow outline, because contrast` retired with a
// reason became `use the glow outline`, matched nothing, left the constraint in
// force, and told the user their exact quote was a typo. The comment here said
// "last" while the code did "first" for the whole of round one.
function retiredTarget(s) {
  const marks = [...s.matchAll(/,\s*because\b/gi)];
  const cut = marks.length ? s.slice(0, marks[marks.length - 1].index) : s;
  return normalizeConstraint(cut);
}

// A ceiling rather than a window. The old default of 40 was applied by
// `recentHandoffs` across every project before this filtered by project, so in
// a home directory with many active threads the one handoff carrying a
// constraint could fall off the end and be dropped in silence, which is the
// failure this whole feature exists to prevent. It is high enough that hitting
// it is a real anomaly, and `truncated` says so out loud when it happens.
const CONSTRAINT_SCAN_CAP = 500;

// Every constraint still in force for the project `cwd` belongs to.
//
// Documents are read newest first, and a retirement in a newer one suppresses
// the matching bullet in every older one. That ordering is the whole mechanism:
// the document that retires a constraint is never the document that carries it,
// so retirement can only be honoured here, across documents, and not by a
// parser looking at one file.
//
// Archived handoffs are read. A constraint does not stop applying because the
// document carrying it went quiet for 30 days, and archiving is driven by mtime
// rather than by anything retiring it.
function carriedConstraints({ cwd = process.cwd(), home = os.homedir(), limit = CONSTRAINT_SCAN_CAP } = {}) {
  const want = scopeKey(cwd);
  // One more than the cap, so "exactly at the ceiling" and "more than the
  // ceiling" can be told apart. recentHandoffs slices to whatever it is given,
  // so asking for the cap made both cases return an array of that length, and
  // a scan that had in fact read everything announced itself as incomplete.
  // Wrap then tells the model to stop and resolve a truncation that never
  // happened.
  const peeked = recentHandoffs({ home, limit: limit + 1 });
  const truncated = peeked.length > limit;
  const rows = peeked.slice(0, limit);
  const scanned = [];
  const docs = [];

  // Read everything first. Whether a retirement matched anything cannot be
  // decided while scanning, because the constraint it names lives in an older
  // document that has not been read yet. Deciding it inline reported every
  // legitimate retirement as unmatched.
  for (const r of rows) {
    let text;
    try { text = fs.readFileSync(r.path, 'utf8'); } catch (_) { continue; }
    const dir = handoffDir(text);
    const key = dir ? scopeKey(dir) : null;
    const { live, retired } = bulletsIn(text);
    scanned.push({
      slug: r.slug, path: r.path, dir, matched: key === want, found: live.length,
    });
    if (key !== want) continue;
    docs.push({ row: r, live, retired });
  }

  const everLive = new Set();
  for (const d of docs) for (const c of d.live) everLive.add(normalizeConstraint(c));

  const out = [];
  const seen = new Set();
  for (const d of docs) {
    // Live bullets first, so a document that states a constraint and retires it
    // keeps it. Contradicting yourself inside one handoff is not a retirement.
    for (const c of d.live) {
      const norm = normalizeConstraint(c);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({ text: c, from: d.row.slug, path: d.row.path });
    }
    // Then the retirements, marked seen so no older document can resurrect
    // them. Nothing is emitted for these; they exist only to suppress.
    for (const t of d.retired) {
      const norm = retiredTarget(t);
      if (norm) seen.add(norm);
    }
  }

  // A retirement naming something no handoff ever recorded is almost always a
  // mistyped quote, and it does nothing. Reported rather than swallowed: a
  // retirement that silently fails is the same defect as a constraint that
  // silently vanishes, pointed the other way.
  const unmatchedRetirements = [];
  for (const d of docs) {
    for (const t of d.retired) {
      const norm = retiredTarget(t);
      if (norm && !everLive.has(norm)) unmatchedRetirements.push({ text: t, from: d.row.slug });
    }
  }

  return {
    scope: want,
    constraints: out,
    scanned,
    unmatchedRetirements,
    truncated,
    // Without git, scoping falls back to comparing real paths, which still
    // groups a directory with itself but cannot tell a worktree from an
    // unrelated folder. That is the whole mechanism quietly not working, and
    // the answer it produces is a confident one, so it is reported.
    gitDegraded: gitDegradedReason(),
  };
}

module.exports = {
  DEFAULT_STALE_DAYS,
  CONSTRAINT_SCAN_CAP,
  repoRoot,
  scopeKey,
  handoffDir,
  bulletsIn,
  constraintsIn,
  retiredIn,
  carriedConstraints,
  handoffRoot,
  archiveRoot,
  indexLockPath,
  indexPath,
  readIndex,
  // `writeIndex` is deliberately not exported. It was, and an exported raw
  // writer is a way to change the index without the lock, which is the bug this
  // module was changed to close. Anything that needs to change the index uses
  // `mutateIndex`, which cannot be called without holding the lock, because
  // taking it is the first thing it does. Nothing outside this file ever called
  // the raw writer, so removing it from the contract costs nothing today and
  // stops the next caller being written.
  mutateIndex,
  recordHandoff,
  forgetHandoff,
  pruneIndex,
  memoryDir,
  writeTarget,
  slugify,
  projectRoots,
  searchPaths,
  staleRecord,
  findHandoff,
  archiveStale,
  recentHandoffs,
};
