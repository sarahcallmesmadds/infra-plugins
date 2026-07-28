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
    return { path: path.join(cwd, 'HANDOFF.md'), slug: path.basename(cwd), kind: 'project' };
  }
  const slug = slugify(topicSlug) || 'session';
  return { path: path.join(handoffRoot(home), `HANDOFF-${slug}.md`), slug, kind: 'central' };
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

  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch (_) {
    // No handoffs directory yet. Nothing to sweep, and creating one here would
    // be a side effect nobody asked for.
    return { moved, root, skipped: true };
  }

  const cutoff = now - days * 86400000;

  for (const name of entries) {
    if (!name.startsWith('HANDOFF-') || !name.endsWith('.md')) continue;
    const from = path.join(root, name);
    try {
      const stat = fs.statSync(from);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
      if (!dryRun) {
        fs.mkdirSync(dest, { recursive: true });
        fs.renameSync(from, path.join(dest, name));
      }
      moved.push(name.replace(/^HANDOFF-/, '').replace(/\.md$/, ''));
    } catch (_) {
      // One unreadable file must not stop the sweep.
    }
  }

  return { moved, root, skipped: false };
}

// The newest handoffs, for the menu `pickup` shows when given no slug.
function recentHandoffs({ home = os.homedir(), limit = 5 } = {}) {
  const out = [];
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
      } catch (_) { /* skip */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

module.exports = {
  DEFAULT_STALE_DAYS,
  handoffRoot,
  archiveRoot,
  memoryDir,
  writeTarget,
  slugify,
  searchPaths,
  findHandoff,
  archiveStale,
  recentHandoffs,
};
