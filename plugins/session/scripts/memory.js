// Is the memory directory still worth loading.
//
// ---------------------------------------------------------------------------
// The problem, measured rather than assumed.
//
// Memory files are pulled into a session when they look relevant, so a file's
// cost is paid every time it matches, not once. On 2026-07-28 one directory
// held 14,637 words across eleven files. Two of them were half of that: a
// 4,012 word session log and a 3,133 word status document that also happened
// to contain the only copy of some durable engineering notes. Asking a
// question about working style pulled the whole status document.
//
// Reorganising it by hand took it to 8,957. That is the easy half and it does
// not stay fixed, because the thing that made it grow is still there: writing
// is cheap, deleting needs a decision, and nothing ever asks for that decision.
//
// ---------------------------------------------------------------------------
// Why a check and not a rule.
//
// The rules are already written down in /wrap: edit rather than append, replace
// a stale line rather than adding one beside it, do not remove earlier entries
// unless they are resolved. Every one of them is advice, and this repository
// has spent two days finding out what advice is worth. Every bug found on
// 07-27 and 07-28 was a rule that was written down, accurate, and not enforced
// anywhere that ran.
//
// So this measures. It changes nothing on its own and deletes nothing ever. It
// reports, at the one moment someone is already deciding what matters, which is
// the end of a session.
//
// ---------------------------------------------------------------------------
// Why the budget depends on the file's type.
//
// A file's frontmatter already declares what kind of thing it is, and the kinds
// have genuinely different shapes.
//
//   `project` is live state. It describes what is happening now, it is meant
//   to be replaced rather than added to, and a long one is a symptom: it means
//   nobody has taken anything out since it was created.
//
//   `reference`, `feedback` and `user` are durable. They accumulate slowly and
//   legitimately, they are read far more often than they are written, and a
//   long one is usually just a thorough one.
//
// Holding both to one number would either nag about a good reference file or
// ignore a status document quietly turning into a log. That distinction is the
// whole point of the reorganisation this check exists to defend.

'use strict';

const fs = require('fs');
const path = require('path');

// Types whose files are meant to be replaced rather than grown.
const LIVE_TYPES = ['project'];

const DEFAULTS = {
  // Words in a single live-state file before it is worth mentioning. A handoff
  // that cannot be read in two minutes will not be read.
  liveFileWords: 900,

  // Words in a single durable file. Higher on purpose: these earn their length.
  durableFileWords: 2500,

  // Words across the whole directory.
  totalWords: 10000,
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function words(text) {
  const m = String(text).trim().match(/\S+/g);
  return m ? m.length : 0;
}

// The declared type, or null when there is no frontmatter to read it from.
//
// An unreadable type is not guessed. Guessing would apply the tight live-state
// budget to a durable file and produce a complaint about the wrong thing, and a
// check that complains about the wrong thing gets switched off.
function declaredType(text) {
  const fm = String(text).match(FRONTMATTER);
  if (!fm) return null;
  const m = fm[1].match(/^\s*type:\s*(\S+)\s*$/m);
  return m ? m[1].toLowerCase() : null;
}

function linksIn(text) {
  const found = String(text).match(/\[\[[A-Za-z0-9_-]+\]\]/g) || [];
  return [...new Set(found.map((l) => l.slice(2, -2)))];
}

function scan(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch (_) {
    return null;
  }

  const files = [];
  for (const name of names) {
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      const type = declaredType(text);
      files.push({
        name,
        slug: name.replace(/\.md$/, ''),
        words: words(text),
        type,
        live: type ? LIVE_TYPES.includes(type) : null,
        links: linksIn(text),
        isIndex: name === 'MEMORY.md',
      });
    } catch (_) {
      // An unreadable file is not a finding. It is a different problem and not
      // this check's business.
    }
  }
  return files;
}

// Case-insensitive, because the index is written by hand and HANDOFF.md is
// linked as [[handoff]] in several places. A link that resolves for a reader
// must resolve here too, or the check invents broken links and is ignored.
function resolves(slug, files) {
  const needle = String(slug).toLowerCase();
  return files.some((f) => f.slug.toLowerCase() === needle);
}

function audit({ dir, config = {} } = {}) {
  const limits = { ...DEFAULTS, ...config };
  const files = scan(dir);
  if (!files) return null;

  const body = files.filter((f) => !f.isIndex);
  const index = files.find((f) => f.isIndex);
  const total = files.reduce((n, f) => n + f.words, 0);
  const findings = [];

  for (const f of body) {
    // An undeclared type gets the durable budget, which is the permissive one.
    // Being quiet about a file we cannot classify is better than being wrong
    // about it loudly.
    const limit = f.live ? limits.liveFileWords : limits.durableFileWords;
    if (f.words > limit) {
      findings.push({
        kind: f.live ? 'oversize-live' : 'oversize-durable',
        file: f.name,
        words: f.words,
        limit,
        note: f.live
          ? 'Live state, meant to be replaced rather than added to. Take out what already happened.'
          : 'Durable, so length is allowed, but this is long enough to be worth splitting.',
      });
    }
  }

  if (total > limits.totalWords) {
    findings.push({
      kind: 'over-budget', words: total, limit: limits.totalWords,
      note: 'Every one of these is pulled into a session whenever it looks relevant.',
    });
  }

  // Index rot, in both directions. This is the failure that made the old
  // inventory useless: entries pointing at things that no longer exist, and
  // things that exist with no entry pointing at them.
  if (index) {
    const linked = new Set();
    for (const m of (index.words ? fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8') : '')
      .matchAll(/\]\(([^)]+\.md)\)/g)) {
      linked.add(path.basename(m[1]).toLowerCase());
    }
    for (const f of body) {
      if (!linked.has(f.name.toLowerCase())) {
        findings.push({
          kind: 'unlisted', file: f.name,
          note: 'Not in MEMORY.md, so nothing points at it and it may never be recalled.',
        });
      }
    }
    for (const name of linked) {
      if (!body.some((f) => f.name.toLowerCase() === name)) {
        findings.push({
          kind: 'dangling-index', file: name,
          note: 'MEMORY.md points at a file that is not there.',
        });
      }
    }
  }

  for (const f of files) {
    for (const link of f.links) {
      if (!resolves(link, files)) {
        findings.push({
          kind: 'broken-link', file: f.name, target: link,
          note: `[[${link}]] resolves to nothing.`,
        });
      }
    }
  }

  return { dir, total, limits, files: body, findings };
}

module.exports = { DEFAULTS, LIVE_TYPES, words, declaredType, linksIn, scan, audit };
