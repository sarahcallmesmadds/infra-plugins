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

// Every live session except the one asking.
//
// `selfSessionId` comes from the hook event, so the caller is excluded by
// identity rather than by pid. That matters: the hook is a child process, so
// its own pid never appears in this list and comparing pids would exclude
// nothing while looking like it worked.
//
// Returns `{ sessions, complete }`. `complete` is false when the deadline ran
// out before every working directory was resolved, and the caller must not read
// an empty overlap list as "nothing overlaps" in that case. It is not the same
// answer. See the note on the deadline below.
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
  selfSessionId, selfPid, now = Date.now(), exec = run, deadline,
} = {}) {
  const ps = exec('ps', ['-eo', 'pid,lstart,command'], PS_TIMEOUT_MS);
  if (!ps) return { sessions: [], complete: false, identifiedSelf: false };

  // Two independent ways to recognise the caller, because getting this wrong
  // produces the one answer guaranteed to be useless: "another session is live
  // in this directory", about itself.
  //
  // The hook has the session id from its event, which is exact. A command run
  // from a skill has no event, so it reads the environment, and depending on a
  // single environment variable name is a thin thread to hang the whole answer
  // on. The pid of the Claude process is exported alongside it and appears
  // directly in the process table, so either one alone is enough.
  //
  // `identifiedSelf` reports whether anything matched. When nothing did, the
  // caller has to say the list may include the current session rather than
  // presenting it as a list of other people's.
  const self = selfSessionId ? String(selfSessionId).toLowerCase() : null;
  const selfPidNum = Number(selfPid);
  const hasPid = Number.isInteger(selfPidNum) && selfPidNum > 0;

  const all = parsePs(ps, now);
  const found = all.filter((s) => s.sessionId !== self && !(hasPid && s.pid === selfPidNum));
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

module.exports = { parsePs, liveSessions, cwdOf, overlaps, SESSION_RE };
