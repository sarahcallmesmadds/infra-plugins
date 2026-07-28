// Which Claude Code sessions are alive on this machine right now.
//
// The question this answers is "am I about to edit a file another session is
// also editing", so it has to report live processes rather than recent
// activity. Those are different sets and only one of them can collide with you.
//
// ---------------------------------------------------------------------------
// Why the process table and not the transcript directory.
//
// The obvious source is ~/.claude/projects/<slug>/*.jsonl, sorted by mtime.
// It is wrong in both directions. A session you closed an hour ago leaves a
// file with a recent mtime and looks alive. A session sitting idle while you
// read something leaves a stale mtime and looks dead. Neither error is rare and
// the second one is the dangerous direction, because it stays quiet exactly
// when a warning was the point.
//
// `ps` reports what is actually running. A session that has exited is not in
// the table, whatever it left on disk.
//
// ---------------------------------------------------------------------------
// What counts as a session, and the two things that look like one.
//
// Matching on the word "claude" alone is far too loose on this kind of machine.
// Both of these are in the process table on a normal day and neither is a
// Claude Code session:
//
//   /Applications/Claude.app/Contents/MacOS/Claude            the desktop app
//   /Applications/cmux.app/.../cmux hooks feed --source claude   a session manager
//
// The discriminator is `--session-id <uuid>`, which the CLI is invoked with and
// neither of those carries. It also hands us the id, which is what makes
// excluding the caller exact rather than a guess.

'use strict';

const { execFileSync } = require('child_process');

// `ps` on a busy machine is still only a few milliseconds, but this runs at
// session start where anything noticeable is too much. Both calls are bounded
// and any failure means "report nothing", never "report a partial list".
const PS_TIMEOUT_MS = 1500;
const LSOF_TIMEOUT_MS = 1000;

// A Claude Code CLI invocation, and nothing else. Anchored on a path separator
// or the start of the command so `cmux` and friends cannot match, and it
// requires the flag rather than merely allowing it.
const SESSION_RE = /(?:^|\/)claude\s+(?:.*\s)?--session-id\s+([0-9a-fA-F-]{36})/;

function run(cmd, args, timeout) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_) {
    // A missing binary, a timeout and a non-zero exit are all the same answer
    // here: we do not know, so we say nothing.
    return null;
  }
}

// The working directory of a running process.
//
// This is asked per process, so a machine with a lot of sessions pays for it
// several times over. That is why the caller passes a deadline and why this
// returns null rather than throwing: a session we cannot locate is still worth
// reporting, just without its path.
function cwdOf(pid, exec = run) {
  const out = exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], LSOF_TIMEOUT_MS);
  if (!out) return null;
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1).trim() || null : null;
}

// Parse `ps -eo pid,lstart,command` output into session records.
//
// Split out from the process call so the tests can feed it captured `ps` text
// and pin the two impostors above, which is the part that actually breaks. A
// test that spawns real sessions would prove nothing about a machine that
// happens to be running the desktop app.
function parsePs(text, now = Date.now()) {
  if (!text) return [];
  const out = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const match = line.match(SESSION_RE);
    if (!match) continue;

    // pid is the first field; lstart is the next five whitespace-separated
    // fields, in the fixed `Www Mmm DD HH:MM:SS YYYY` form `ps` always emits.
    const fields = line.split(/\s+/);
    const pid = Number(fields[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;

    const startedMs = Date.parse(fields.slice(1, 6).join(' '));

    out.push({
      pid,
      sessionId: match[1].toLowerCase(),
      startedAt: Number.isFinite(startedMs) ? startedMs : null,
      // Age is left null rather than zero when the start time will not parse.
      // Zero reads as "started just now", which is a claim, and a wrong one.
      ageMinutes: Number.isFinite(startedMs)
        ? Math.max(0, Math.round((now - startedMs) / 60000))
        : null,
    });
  }

  return out;
}

// Walk up the process tree, collecting every ancestor pid.
//
// This is the signal that needs nothing to be true except that processes have
// parents. A command run from a skill was spawned by a shell that was spawned
// by Claude Code, so the session that launched it is always somewhere up this
// chain and is recognised without agreeing on an environment variable name, an
// id format, or anything else that a future release could rename.
//
// Bounded rather than looped to the root, since a cycle in a process table
// should not be able to hang a status command.
function ancestorPids(pid = process.pid, exec = run, limit = 12) {
  const out = [];
  let current = Number(pid);
  for (let i = 0; i < limit; i += 1) {
    if (!Number.isInteger(current) || current <= 1) break;
    const raw = exec('ps', ['-o', 'ppid=', '-p', String(current)], PS_TIMEOUT_MS);
    if (!raw) break;
    const parent = parseInt(String(raw).trim(), 10);
    if (!Number.isInteger(parent) || parent <= 1 || out.includes(parent)) break;
    out.push(parent);
    current = parent;
  }
  return out;
}

// Every live session except the one asking.
//
// The caller says who it is, one of two ways. A hook passes `selfSessionId`
// from its own event, which is exact. A command has no event and passes
// `selfPids` instead, the chain of processes above it, since the session that
// spawned it is always somewhere in that chain.
//
// Returns `{ sessions, complete, identifiedSelf }`.
//
// `complete` is false when the deadline ran out before every working directory
// was resolved, or when the process table could not be read at all. The caller
// must not read an empty list as "nothing is running" in that case, and must
// not read an empty overlap list as "nothing overlaps". Those are different
// answers and only one of them is good news. Every consumer of this function
// has got that wrong at least once, so it is worth restating: check `complete`
// before saying anything reassuring.
//
// `identifiedSelf` is false when neither signal matched anything, meaning the
// list probably includes the caller and must not be described as "others".
//
// ---------------------------------------------------------------------------
// On the deadline, which is where the cost actually is.
//
// `ps` is one call. Resolving working directories is one `lsof` per session,
// and lsof is the slow one. Ten sessions is ten calls, and this runs before the
// first prompt of every session, so the bound has to be on the total rather
// than on each call. Each call is capped as well, but ten calls each safely
// under their own cap is still an unacceptable wait.
//
// The check is between calls, not around them. execFileSync blocks the event
// loop for as long as the child runs, so a timer cannot interrupt work already
// underway; it can only stop the next one from starting.
function liveSessions({
  selfSessionId, selfPids, now = Date.now(), exec = run, deadline,
} = {}) {
  const ps = exec('ps', ['-eo', 'pid,lstart,command'], PS_TIMEOUT_MS);
  if (!ps) return { sessions: [], complete: false, identifiedSelf: false };

  // Getting this wrong produces the one answer guaranteed to be useless:
  // "another session is live in this directory", about itself. So there is
  // more than one way to be recognised, and they fail independently.
  //
  //   The hook passes the session id from its own event. Exact, and free.
  //   A command has no event, so the caller passes pids instead: the process
  //   tree above it, which is true regardless of what anything is named.
  //
  // An earlier version relied on a single environment variable. The name was
  // right, and checked, but it was still one rename away from silently
  // reporting the current session as a parallel one.
  //
  // `identifiedSelf` reports whether anything matched at all. When nothing
  // did, the caller must say the list may include the current session rather
  // than presenting it as a list of other people's.
  const self = selfSessionId ? String(selfSessionId).toLowerCase() : null;
  const pids = new Set(
    (Array.isArray(selfPids) ? selfPids : [selfPids])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 1),
  );

  const all = parsePs(ps, now);
  const found = all.filter((s) => s.sessionId !== self && !pids.has(s.pid));
  const identifiedSelf = found.length < all.length;

  const sessions = [];
  let complete = true;

  for (const s of found) {
    if (deadline != null && Date.now() >= deadline) {
      // Everything from here on is reported without a path. The session is
      // real and worth counting; we just do not know where it is.
      sessions.push({ ...s, cwd: null });
      complete = false;
      continue;
    }
    const cwd = cwdOf(s.pid, exec);
    if (cwd === null) complete = false;
    sessions.push({ ...s, cwd });
  }

  return { sessions, complete, identifiedSelf };
}

// True when `other` is working somewhere that can collide with `cwd`: the same
// directory, or one containing the other.
//
// Two sessions in unrelated directories are not a problem and saying so every
// time would make this the kind of notice people learn to ignore. Nesting
// counts in both directions, because a session at a repo root and a session in
// one of its subdirectories edit the same files.
function overlaps(cwd, other) {
  if (!cwd || !other) return false;
  const a = cwd.replace(/\/+$/, '');
  const b = other.replace(/\/+$/, '');
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

module.exports = { parsePs, liveSessions, cwdOf, overlaps, ancestorPids, SESSION_RE };
