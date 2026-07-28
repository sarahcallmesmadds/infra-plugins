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

const DEFAULT_STALE_DAYS = 30;

function handoffRoot(home = os.homedir()) {
  return path.join(home, '.planning', 'handoffs');
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
// No amount of adding candidate directories fixes that, it just moves the line
// between people it works for and people it does not. The writer is the only
// thing that knows where the file went, so the writer records it.
//
// The index is a convenience, never an authority. Every lookup checks the file
// is still there, so a moved or deleted project degrades to "not found"
// instead of to a confident path that resolves to nothing.

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
function recordHandoff({ slug, target, kind, home = os.homedir(), now = Date.now() }) {
  if (!slug || !target) return null;
  const handoffs = readIndex(home);
  handoffs[slugify(slug)] = { path: target, kind: kind || 'project', recorded_at: new Date(now).toISOString() };
  return writeIndex(handoffs, home);
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
function writeIndex(handoffs, home = os.homedir()) {
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

  const handoffs = readIndex(home);
  const entry = handoffs[key];
  if (!entry) return { slug: key, removed: false, reason: 'not in the index' };

  let fileStillThere = false;
  try { fileStillThere = !!entry.path && fs.existsSync(entry.path); } catch (_) { /* treat as gone */ }

  delete handoffs[key];
  if (writeIndex(handoffs, home) === null) {
    return { slug: key, removed: false, reason: 'the index could not be written', entry };
  }
  return { slug: key, removed: true, entry, fileStillThere };
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
function pruneIndex({ home = os.homedir(), dryRun = false } = {}) {
  const handoffs = readIndex(home);
  const dropped = [];
  const kept = {};

  for (const [key, entry] of Object.entries(handoffs)) {
    let present = false;
    try { present = !!(entry && entry.path) && fs.existsSync(entry.path); } catch (_) { present = false; }
    if (present) kept[key] = entry;
    else dropped.push({ slug: key, path: entry && entry.path });
  }

  if (dropped.length && !dryRun) writeIndex(kept, home);
  return { dropped };
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
function searchPaths(slug, home = os.homedir()) {
  const s = slugify(slug);
  if (!s) return [];
  return [
    { path: path.join(handoffRoot(home), `HANDOFF-${s}.md`), kind: 'central' },
    { path: path.join(home, 'Projects', s, 'HANDOFF.md'), kind: 'project' },
    { path: path.join(handoffRoot(home), `${s}-pause.md`), kind: 'pause' },
    { path: path.join(archiveRoot(home), `HANDOFF-${s}.md`), kind: 'archived' },
  ];
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
      moved, root, skipped: true, repointed: [], pruned: [],
    };
  }

  const cutoff = now - days * 86400000;

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
  const repointed = [];
  if (!dryRun && relocations.length) {
    const handoffs = readIndex(home);
    let touched = false;
    for (const [key, entry] of Object.entries(handoffs)) {
      const hit = entry && relocations.find((r) => r.from === entry.path);
      if (!hit) continue;
      handoffs[key] = { ...entry, path: hit.to, kind: 'archived' };
      repointed.push({ slug: key, from: hit.from, to: hit.to });
      touched = true;
    }
    if (touched) writeIndex(handoffs, home);
  }

  const { dropped } = pruneIndex({ home, dryRun });

  return {
    moved, root, skipped: false, repointed, pruned: dropped,
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

module.exports = {
  DEFAULT_STALE_DAYS,
  handoffRoot,
  archiveRoot,
  indexPath,
  readIndex,
  writeIndex,
  recordHandoff,
  forgetHandoff,
  pruneIndex,
  memoryDir,
  writeTarget,
  slugify,
  searchPaths,
  findHandoff,
  archiveStale,
  recentHandoffs,
};
