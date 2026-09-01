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
const { withIndexLock, warnUnprotectedWrite, refreshLock, lockLost } = require('./index-lock');

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
// replaced by a hyphen. A representative SessionStart cwd such as
//   /private/tmp/claude-example/-Users-example/run-id/scratchpad/capture
// produces the transcript directory
//   -private-tmp-claude-example--Users-example-run-id-scratchpad-capture
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
      // Asked before the write, not after, so the clock is fresh for it and so
      // a lock lost during a long region is caught at the one place every write
      // passes through rather than at each caller.
      refreshLock(lock);
      if (lockLost(lock)) {
        process.stderr.write(
          `session: the handoff index lock at ${lock} was taken over while this run was still `
          + 'working, so this write went ahead beside another session and an entry may have been '
          + 'lost.\n',
        );
      }
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
  // A stamp a little ahead of this clock is clamped to now. A stamp wildly
  // ahead is not trusted at all.
  //
  // It used to be rejected outright, on the reasoning that a future stamp is a
  // clock that disagrees rather than a young entry, and that treating it as
  // young would leave the entry unprunable for as long as the clocks differ.
  // That failed at the worst possible moment: the stamps most likely to sit
  // ahead are the newest ones, so the entry it dropped was a wrap that had just
  // recorded and was still being written, which is the case this window exists
  // for. Devin round 3 on PR #111.
  //
  // Clamping alone does not fix it, which the check for this found. Clamping to
  // `now` on every read makes a far-future stamp look freshly recorded every
  // time it is read, so it is spared not for the window but until real time
  // catches up to it, which for a badly wrong clock is never in any useful
  // sense. That is the property the old reasoning was protecting, and it was
  // right to protect it.
  //
  // So both, split at the window itself. Inside it, a stamp ahead of this clock
  // is ordinary skew between two processes and the entry is young. Beyond it,
  // the clock is wrong rather than early, and an entry that cannot be trusted to
  // say when it was written does not get to be permanently unprunable on the
  // strength of it. The cost is that a machine more than ten minutes ahead of
  // itself loses this protection, and a machine in that state has larger
  // problems than a swept index entry.
  if (at > now + PENDING_MS) return false;
  return now - Math.min(at, now) < PENDING_MS;
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
      // entryState stats a file per entry, so this loop is as slow as the disk
      // too.
      refreshLock(indexLockPath(home));
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
      // Every file, not every rename. A folder where most documents are not
      // stale renames nothing while statting all of them, and statting is the
      // slow part on a network home. Cheap to call: only one in every
      // REFRESH_MS reaches the disk.
      refreshLock(indexLockPath(home));
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

// ---------------------------------------------------------------------------
// Reconcile: what the folder holds, against what the index records.
//
// The index is only ever written forwards. `target` records an intent before the
// document exists, the sweep repoints and prunes, and until this existed nothing
// read the folder back and asked whether the two still agreed. They stopped
// agreeing, and the manual pass that repaired that introduced a duplicate entry
// on the same day, which is the argument for a command rather than a careful
// afternoon.
//
// What this is not for, stated first because it is what the bug was filed as.
// An unlisted central document is still found by name: `searchPaths` looks in
// this folder for `HANDOFF-<slug>.md` before the index is needed at all, so a
// missing entry costs nothing there. That was measured, not reasoned about, on
// the two slugs the original report named as unfindable. Both resolved. So
// `unlisted` is reported last and quietly, and the loud findings are the two
// below, which were found by looking rather than by being filed.
//
// `shadowed` is the one that hands back a wrong answer. `findHandoff` consults
// the index first and returns its path whenever that file exists, so an entry
// pointing at some other real document wins over the correctly named one lying
// beside it, and nothing anywhere says so. `/pickup <slug>` then opens a
// different handoff with no sign that it did. That is not a missing entry, it is
// a confident wrong one, and it is the reason this command leads with it.
//
// `duplicate` is two or more slugs recorded against one document. Cheap to read
// past, and it is how the shadowing above came to exist, so it is worth naming.
//
// Detection changes nothing. `applyReconcile` is the only half that writes, and
// the only thing it writes is an entry for a document sitting right there on the
// disk, which is the one repair that cannot lose anything.

function resolvePath(p) {
  // `realpathSync` throws on a path that is not there, and a recorded path that
  // is not there is the ordinary case here rather than an error. Falling back to
  // `resolve` keeps a comparable string for it.
  try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); }
}

function samePath(a, b) {
  if (!a || !b) return false;
  return resolvePath(a) === resolvePath(b);
}

// Every document this folder is answerable for.
//
// `HANDOFF-<slug>.md`, in the handoffs folder and its archive, which is the same
// set `archiveStale` and `recentHandoffs` walk. A `<slug>-pause.md` is a fourth
// kind in `searchPaths` and is deliberately not scanned: nothing ever records
// one, so every pause document on the disk would be reported as unlisted, every
// run, forever. The report says which shapes it looked at rather than leaving
// that gap to be inferred from a clean result.
function centralDocs(home = os.homedir()) {
  const out = [];
  for (const dir of [handoffRoot(home), archiveRoot(home)]) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!name.startsWith('HANDOFF-') || !name.endsWith('.md')) continue;
      const full = path.join(dir, name);
      try { if (!fs.statSync(full).isFile()) continue; } catch (_) { continue; }
      out.push({
        slug: slugify(name.replace(/^HANDOFF-/, '').replace(/\.md$/, '')),
        path: full,
        archived: dir === archiveRoot(home),
      });
    }
  }
  return out;
}

function reconcileIndex({ home = os.homedir(), now = Date.now() } = {}) {
  const docs = centralDocs(home);
  // Read through the gate, so this sees one whole version of the index rather
  // than one caught between another session's read and its write. `readOnly`
  // because nothing on this path writes, and a preview that queues behind a
  // running wrap is previewing state that wrap is in the middle of changing.
  const handoffs = mutateIndex(home, (map) => map, { readOnly: true }) || {};

  const shadowed = [];
  const unlisted = [];
  const superseded = [];
  const pending = [];
  const unreachable = [];

  for (const doc of docs) {
    const entry = handoffs[doc.slug];
    if (!entry || !entry.path) {
      unlisted.push({ slug: doc.slug, path: doc.path, archived: doc.archived });
      continue;
    }
    if (samePath(entry.path, doc.path)) continue;

    // `entryState` rather than a bare existence check, and that distinction is
    // the whole of Devin round 1 on PR #114.
    //
    // `fs.existsSync` collapses three different answers into "not there", and
    // only one of them may be called a dead entry. A wrap records where it will
    // write before it writes, so an entry recorded minutes ago whose document
    // has not appeared is a handoff in progress. A path whose whole directory is
    // missing may be an unmounted volume rather than a deletion. The advice
    // printed for a dead entry is to forget it, and forgetting the entry of a
    // project handoff destroys the only record of where that handoff went, which
    // is the one thing the index exists to hold.
    //
    // This is the same window `pruneIndex` was given in PR #111, the day before
    // this function was written, and it came straight back the moment new code
    // asked the question its own way instead of calling the function that
    // already knew the answer.
    const state = entryState(entry, now);

    if (state === 'present') {
      shadowed.push({
        slug: doc.slug, doc: doc.path, recorded: entry.path, kind: entry.kind || 'project',
      });
    } else if (state === 'pending') {
      // Spared and reported, in the same words the sweep uses. Not evidence of
      // anything, in either direction.
      pending.push({ slug: doc.slug, doc: doc.path, recorded: entry.path });
    } else if (state === 'unreachable') {
      unreachable.push({ slug: doc.slug, doc: doc.path, recorded: entry.path });
    } else {
      // Genuinely gone: the directory is right there and the document is not in
      // it, and the entry is old enough that it is not a wrap in flight. The
      // lookup already reaches the document beside it through the search order,
      // so only the entry is wrong, which is why this is not grouped with
      // `shadowed`.
      superseded.push({ slug: doc.slug, doc: doc.path, recorded: entry.path });
    }
  }

  // Two slugs against one document. Grouped by the resolved path so a symlinked
  // or differently spelled route to the same file is still one document.
  const byPath = new Map();
  for (const [slug, entry] of Object.entries(handoffs)) {
    if (!entry || !entry.path) continue;
    const key = resolvePath(entry.path);
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(slug);
  }
  const duplicates = [];
  for (const [p, slugs] of byPath) {
    if (slugs.length > 1) duplicates.push({ path: p, slugs: slugs.slice().sort() });
  }
  duplicates.sort((a, b) => a.path.localeCompare(b.path));

  return {
    root: handoffRoot(home),
    scanned: docs.length,
    entries: Object.keys(handoffs).length,
    shadowed,
    duplicates,
    superseded,
    // Spared rather than judged. Both are entries this cannot call dead without
    // risking a live handoff, and both are reported, because a check that
    // silently keeps something is as hard to trust as one that silently drops
    // it.
    pending,
    unreachable,
    unlisted,
  };
}

// Record an entry for every document that has none.
//
// The only repair here, and deliberately the only one. A shadowed slug and a
// duplicated one both need somebody to say which document is the real one, and
// a command that guesses that is a command that can lose a handoff. Those two
// are reported and left alone.
function applyReconcile({ home = os.homedir(), now = Date.now() } = {}) {
  const found = reconcileIndex({ home, now });
  if (!found.unlisted.length) return { ...found, recorded: [], written: true };

  const recorded = [];
  const written = mutateIndex(home, (handoffs, save) => {
    for (const d of found.unlisted) {
      // Re-checked inside the lock. The scan above ran outside it, on purpose,
      // so another session may have recorded this very slug in between, and
      // writing over a fresher entry with this one is the same lost write the
      // rest of this file exists to stop.
      if (handoffs[d.slug]) continue;
      handoffs[d.slug] = {
        path: d.path,
        kind: d.archived ? 'archived' : 'central',
        recorded_at: new Date(now).toISOString(),
      };
      recorded.push(d);
    }
    // Nothing left to do once the re-check above has skipped them all. Reported
    // as written because there was nothing to write, not as a failed write.
    if (!recorded.length) return true;
    return save(handoffs);
  });

  return { ...found, recorded, written: written === true };
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
  // Two shapes, and they have to be told apart rather than handled by one
  // capture. A backtick-quoted path ends at its closing backtick. An unquoted
  // one runs to the end of the line, prose and all.
  //
  // The single capture this replaces was `` `?([^`\n]+)`? ``, which stopped at
  // the FIRST backtick wherever it fell. That is right for a quoted path and
  // wrong for every unquoted one carrying a backticked aside:
  //
  //   **Working directory:** /Users/x (touched `~/Projects/plugins`)
  //
  // read as `/Users/x (touched`, which is not a directory, matches no scope,
  // and silently drops that handoff's constraints. Silently is the problem: a
  // dropped constraint looks exactly like a project that never had one.
  const m = text.match(/^\*\*(?:Working directory|Repository|Repo):\*\*\s*(?:`([^`\n]+)`|([^\n]+))/mi);
  if (!m) return null;
  const captured = m[1] !== undefined ? m[1] : m[2];
  if (captured === undefined) return null;
  // The leading strip is what keeps an UNCLOSED backtick from getting worse than
  // it was. `**Working directory:** `/tmp/x` with no closing backtick fails the
  // quoted branch and lands in the unquoted one, which would otherwise carry the
  // stray backtick into the path, resolve nothing, and drop the constraints
  // silently: the exact failure this function was changed to fix. The old single
  // capture happened to survive it, because its optional opening backtick ate the
  // character whether or not a closing one ever arrived.
  //
  // Stripping runs before the tilde expansion, because `` `~/x `` has to become
  // `~/x` before the home-directory rule can see the tilde at the start.
  const expand = (s) => s.trim()
    .replace(/^`+/, '')
    .replace(/^~(?=\/|$)/, os.homedir())
    .replace(/[`,]+$/, '')
    .trim();

  // A quoted path is already delimited, so the parenthetical handling below
  // must not run on it: `**Working directory:** `~/Projects/a (b)`` names a
  // folder whose name really does end in a bracket, and the quoting is how the
  // author said so.
  if (m[1] !== undefined) return expand(captured) || null;

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
  //
  // A comma introduces that same prose as often as a bracket does:
  //
  //   **Working directory:** /Users/x, with working files in `~/.planning/y/`
  //
  // read as the whole sentence, which is not a directory, carries no trailing
  // parenthetical to strip, and so became the scope key. It matched nothing, and
  // that document's constraints were dropped in silence. Measured on 2026-08-31:
  // one handoff with a header of exactly this shape held 25 live constraints and
  // contributed none of them.
  //
  // Every cut is a guess about where the path stops, so none of them is taken on
  // sight. The candidates are tried longest-intent first and the first one that
  // is a real directory wins. A folder name really containing a comma survives
  // for the same reason a bracket does: the uncut string is tried first.
  const whole = expand(captured);
  // A trailing parenthetical only counts as an annotation at the END of what is
  // being considered, so this runs again after a comma cut moves the end: a
  // header reading `<path> (main checkout), and notes in ...` has its bracket in
  // the middle until the comma cut puts it at the end.
  const dropParen = (s) => (s ? expand(s.replace(/\s*\([^)]*\)\s*$/, '')) || null : null);
  const beforeComma = (s) => {
    if (!s) return null;
    const i = s.indexOf(',');
    return i === -1 ? null : expand(s.slice(0, i)) || null;
  };
  const trimmed = dropParen(whole);

  const candidates = [];
  for (const c of [whole, trimmed, beforeComma(whole), dropParen(beforeComma(whole))]) {
    if (c && !candidates.includes(c)) candidates.push(c);
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch (_) { /* keep looking */ }
  }

  // None of them resolves, which is normal: the handoff may describe a machine
  // this is not, or a volume that is not mounted. Prefer the trimmed form, since
  // a trailing annotation is far more common in these headers than a bracket in a
  // real folder name, and grouping is by string in that case anyway. The comma
  // cut is deliberately NOT preferred here: unlike a trailing parenthetical it
  // can land in the middle of a sentence, and a wrong key that two sessions agree
  // on still groups them, while a wrong key that only one of them computes does
  // not.
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

// Two constraints that are the same rule wearing two wordings.
//
// The wrap step forbids a value that changes between sessions inside a
// constraint, because matching is on the whole text: bump a counter and the
// new wording is a different constraint, the old one cannot be retired by
// quoting the new one, and both read as live. That rule is prose, so nothing
// catches a number going back in. This is what catches it.
//
// **Detecting on digits is the obvious implementation and it is wrong.**
// Constraints legitimately carry numbers: a colour code, a count of files, the
// date a decision was made. A digit rule fires on all of those and the warning
// is ignored within a day, which is worse than no warning because it also
// covers the real case.
//
// The signal is a PAIR that agrees everywhere except one short stretch. So the
// comparison is between constraints rather than inside one: take the common
// prefix and the common suffix, and what is left in the middle is what they
// disagree about. Two wordings of the same rule leave a few characters each
// ("Tenth" against "Seventh"). Two genuinely different rules leave most of
// themselves.
//
// Thresholds are deliberately conservative. A false warning here sends someone
// to reconcile two rules that were never the same, so the cost of guessing
// wrong is somebody editing a constraint that was correct.
const NEAR_DUP_MAX_DIFF = 24;
const NEAR_DUP_MIN_SHARED = 40;
const NEAR_DUP_MIN_RATIO = 0.85;

function nearDuplicateConstraints(constraints = []) {
  const pairs = [];
  for (let i = 0; i < constraints.length; i += 1) {
    for (let j = i + 1; j < constraints.length; j += 1) {
      const a = constraints[i];
      const b = constraints[j];
      const ta = a.text || '';
      const tb = b.text || '';
      if (!ta || !tb || ta === tb) continue;

      let pre = 0;
      while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) pre += 1;

      let suf = 0;
      // Stop before the prefix on either side, or a short string with a long
      // shared head counts its own middle twice and every pair looks identical.
      while (
        suf < ta.length - pre
        && suf < tb.length - pre
        && ta[ta.length - 1 - suf] === tb[tb.length - 1 - suf]
      ) suf += 1;

      const diffA = ta.length - pre - suf;
      const diffB = tb.length - pre - suf;
      const shared = pre + suf;
      const longer = Math.max(ta.length, tb.length);

      if (diffA > NEAR_DUP_MAX_DIFF || diffB > NEAR_DUP_MAX_DIFF) continue;
      if (shared < NEAR_DUP_MIN_SHARED) continue;
      if (shared / longer < NEAR_DUP_MIN_RATIO) continue;

      // Detection is on characters, the report is on words.
      //
      // "Seventh" and "Tenth" share the trailing "enth", so a character diff
      // reports "Sev" against "T", which is accurate and unreadable. The
      // thresholds above stay on the character spans, because that is the
      // honest measure of how much two constraints differ. Only the strings
      // shown to a person are widened to the surrounding word.
      // Both boundaries move OUTWARD, so the span grows to whole words. The
      // prefix start walks left until the character before it is whitespace.
      // The suffix start walks right, which means shrinking `s`, until the
      // character before it is whitespace. Growing `s` instead pulls the
      // boundary further into the shared tail and reports less than the
      // character diff did: "Seventh" came out as "Se".
      let p = pre;
      while (p > 0 && !/\s/.test(ta[p - 1])) p -= 1;
      let s = suf;
      while (s > 0 && !/\s/.test(ta[ta.length - s - 1])) s -= 1;

      // Trimmed, because the boundary lands on the space before the next word
      // and a quoted span with a hanging space reads as a typo in the warning.
      pairs.push({
        a: { text: ta, from: a.from, differs: ta.slice(p, ta.length - s).trim() },
        b: { text: tb, from: b.from, differs: tb.slice(p, tb.length - s).trim() },
      });
    }
  }
  return pairs;
}

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
    // Computed over what survived retirement, not over every bullet ever
    // written. A wording that was properly retired is not a live duplicate, and
    // warning about it would punish the person who did the tidying.
    nearDuplicates: nearDuplicateConstraints(out),
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
  nearDuplicateConstraints,
  handoffRoot,
  archiveRoot,
  indexLockPath,
  indexPath,
  readIndex,
  // Exported because `staleRecord` already hands its result to callers, so the
  // states are part of this module's surface rather than an internal detail,
  // and because the window is a documented behaviour that a check has to be
  // able to name.
  entryState,
  PENDING_MS,
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
  reconcileIndex,
  applyReconcile,
};
