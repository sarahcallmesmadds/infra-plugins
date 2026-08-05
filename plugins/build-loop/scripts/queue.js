#!/usr/bin/env node
// Locked writes for the bug queue and the to-build list.
//
// Run: node scripts/queue.js <command> [options]
//
// Why this exists. Every skill here used to change an entry by reading the JSON
// with the Read tool, composing a new version, writing it to a `.tmp`, checking
// it parses, and moving it into place. That sequence protects a single write
// from being torn in half. It does nothing about two sessions doing it at once:
// session A reads, session B reads and writes, session A writes the version it
// composed before B existed, and B's change is gone with no error and nothing
// to notice. The model is holding a copy of the entry across several tool calls,
// which is exactly the window a lock has to cover, and no wording in a skill can
// close it because the gap is between the tool calls rather than inside one.
//
// So the read, the change and the write happen here instead, inside one process
// holding one lock. A skill says what it wants changed and never carries a copy
// of the entry between calls.
//
// Locking is a directory created with `wx`, not flock. It is atomic on every
// filesystem this runs on, needs no native module, and leaves something a human
// can look at and delete. A lock older than STALE_MS is assumed to belong to a
// process that died and is taken over, because a queue that deadlocks until
// someone finds a hidden file is worse than one that races.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { problemsWith, outcomeList, normalise, isClosed, disagreement } = require('./resolution.js');

const ROOT = path.join(os.homedir(), '.claude', 'build-loop');
const QUEUE = path.join(ROOT, 'queue');
const LOCK = path.join(ROOT, '.queue.lock');

// Two lists live under the same root and are read and written the same way, so
// they share this. One lock covers both rather than one each: the work under it
// is a single small file write, so contention between them is not a real cost,
// and one lock is one thing to reason about and one thing to delete by hand if
// it is ever left behind.
// A Map, not an object literal, and that is the whole point rather than a style
// choice. A plain object inherits `constructor`, `__proto__`, `toString` and the
// rest, so `--list constructor` used to return a truthy inherited value, walk
// past a guard that only asked whether the lookup found something, and reach
// path.join as a function. The caller got a stack trace where the refusal naming
// the two valid lists was supposed to be, and the skills relay that to the user.
//
// A Map has no inherited keys, so the guard cannot be walked past. The file
// already refuses unchecked property names for --field and --json; this was the
// one other place a caller names a key and it was missed.
const LISTS = new Map([
  ['queue', QUEUE],
  ['to-build', path.join(ROOT, 'to-build')],
]);

function dirFor(name) {
  const key = name === undefined ? 'queue' : String(name);
  if (!LISTS.has(key)) {
    fail(`queue.js: unknown list ${JSON.stringify(name)}. Use one of: ${[...LISTS.keys()].join(', ')}`);
  }
  return LISTS.get(key);
}

// The status values each list accepts, keyed the same way as LISTS because the
// two lists have entirely different enums and a value valid for one is wrong
// for the other. `Built` is a to-build status and means nothing in the queue.
//
// This exists because `update` used to write whatever string it was handed. Two
// queue entries sat on disk carrying `Wontfix`, which is not one of the six
// values in SCHEMA.md, and no reader matches it: /list-bugs matches the literal
// `Won't Fix` in its filter, in its sort order, and in the parent_status band
// that decides whether a dep-review is answerable or waiting. So both entries
// were invisible to the one filter written to show them, and nothing anywhere
// errored. The status was wrong for four days and the file read fine.
//
// `retired` is accepted on read and refused on write. SCHEMA.md is explicit
// that readers still take `fix attempted / unresolved` because entries written
// before 0.3.1 carry it, so a lint that called it invalid would report correct
// history as corruption.
const STATUSES = new Map([
  ['queue', {
    write: ['Open', 'In Progress', 'Resolved', "Won't Fix", 'fix applied, watching'],
    retired: ['fix attempted / unresolved'],
  }],
  ['to-build', {
    write: ['Open', 'In Progress', 'Built', 'Dropped'],
    retired: [],
  }],
]);

function statusesFor(name) {
  return STATUSES.get(name === undefined ? 'queue' : String(name));
}

// Compared with punctuation and case removed, so `Wontfix` finds `Won't Fix`
// and `in progress` finds `In Progress`. This is only ever used to suggest,
// never to silently accept: a near miss is still refused, because guessing what
// somebody meant and writing it is how a wrong status gets in without anyone
// deciding to put it there.
function loosely(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Whether the status an entry is already sitting on means it was closed. Read
// loosely because this is asked about what is on disk rather than about what
// somebody is trying to write, and what is on disk includes `Wontfix`.
//
// It exists for one question: is this write closing the entry, or repairing the
// status of an entry that was closed already. Correcting `Wontfix` to `Won't
// Fix` is the second, and demanding a resolution for it would break the
// remediation path `lint` prints, which is the whole reason `lint` reports a
// bad status at all. An entry closed before any of this existed can still be
// spelled correctly, and gains no obligation by being repaired.
// The retired `fix attempted / unresolved` is deliberately absent. Despite
// being retired it describes an unresolved entry, so moving it to either
// closed status is a real first closure and has to write a resolution.
const CLOSED_ON_DISK = ['Resolved', "Won't Fix"];

function alreadyClosed(status) {
  if (status === undefined || status === null) return false;
  return CLOSED_ON_DISK.some((known) => loosely(known) === loosely(status));
}

// `JSON.parse` accepts `null`, `3`, `"x"` and `[]` as valid JSON, and none of
// them is an entry. Property access on most of them yields undefined and passes
// quietly, but on `null` it throws, so a single file containing the four
// characters `null` used to take down whatever was reading the directory.
//
// Review found it in `lint`. It was in four places: `lint` aborted its scan and
// exited on the generic failure code rather than its deliberate 3, `update`
// crashed reading `.notes`, `create` crashed reading `.id`, and worst of the
// four, `create`'s duplicate scan crashed on a *neighbour*, so one corrupt file
// anywhere in the directory blocked every new entry. That loop already had a
// `catch { continue }` written to tolerate a bad neighbour, and it did not,
// because the fault is after the parse rather than in it.
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function isEntry(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A status as it should appear in a message. JSON.stringify(undefined) is
// undefined rather than a string, so a missing status used to print as a bare
// word that read like a value somebody had typed.
function showStatus(value) {
  return value === undefined ? '(none)' : JSON.stringify(value);
}

// Each value quoted, because `fix applied, watching` contains a comma and a
// comma-joined list of them cannot be read back.
function statusList(values) {
  return values.map((v) => JSON.stringify(v)).join(', ');
}

// Which list a directory belongs to, so the one gate in writeEntry can pick the
// right enum from the only thing it is given.
function listNameFor(dir) {
  for (const [name, d] of LISTS) if (d === dir) return name;
  return 'queue';
}

function checkStatus(value, listName) {
  const spec = statusesFor(listName);
  if (!spec) return value; // dirFor has already refused an unknown list.
  if (spec.write.includes(value)) return value;

  const list = listName === undefined ? 'queue' : String(listName);

  // `--json status=FILE` can hand over anything JSON can express. An object
  // compared against the enum is simply absent from it, and would otherwise be
  // reported as an unrecognised status when the real fault is its type.
  if (typeof value !== 'string') {
    fail(
      `queue.js: a status has to be a string, got ${Array.isArray(value) ? 'an array' : typeof value}. `
      + `Nothing was written.\n  Valid: ${statusList(spec.write)}`
    );
  }
  // Loose match, so this covers the exact retired value and any misspelling of
  // it in one branch. It used to be an exact check, with the retired values also
  // sitting in the near-miss search below, so `Fix Attempted / Unresolved` was
  // told "Did you mean fix attempted / unresolved?" and refused again when the
  // person did exactly that. A suggestion that cannot be accepted is worse than
  // none: it costs a second attempt to learn nothing.
  const nearRetired = spec.retired.find((s) => loosely(s) === loosely(value));
  if (nearRetired) {
    const resembles = value === nearRetired
      ? `${JSON.stringify(value)} is retired and must not be written.`
      : `${JSON.stringify(value)} matches the retired status ${JSON.stringify(nearRetired)}, which must not be written.`;
    fail(
      `queue.js: ${resembles} `
      + `Entries written before it was retired still carry it and are still read. `
      + `A rejected diff or a failed write leaves the entry "Open" with the attempt recorded in notes. `
      + `Nothing was written.\n  Valid: ${statusList(spec.write)}`
    );
  }

  // Writable values only. Unreachable for a retired value as this stands, since
  // the loose branch above catches those first, so what actually fixed the
  // dead-end suggestion was making that branch loose rather than exact. Kept
  // because it is the correct list to search on its own terms and because the
  // ordering above is not a thing to depend on silently. `cmdLint` does the
  // same narrowing and there it is load-bearing, because its retired check is
  // an exact one and a near miss falls through to the suggestion.
  const near = spec.write.find((s) => loosely(s) === loosely(value));
  const hint = near ? `\n  Did you mean ${JSON.stringify(near)}?` : '';
  fail(
    `queue.js: ${JSON.stringify(value)} is not a status for the ${list} list. `
    + `Nothing was written.${hint}\n  Valid: ${statusList(spec.write)}`
  );
}

// How long to wait for someone else's lock before giving up, and how old a lock
// has to be before it is treated as abandoned. The wait is generous because the
// work under a lock is one small file write, so anything approaching this means
// something is wrong rather than busy.
const WAIT_MS = 5000;
const STALE_MS = 30000;
const POLL_MS = 25;

// Throws rather than exiting. `process.exit` skips `finally`, so failing that
// way from inside the critical section left the lock directory behind and every
// later write blocked until it went stale. The whole point of this file is that
// the lock is released whatever happens, and an exit in the middle is the one
// thing that defeats it.
class QueueError extends Error {}

// Losing the lock mid-write is recoverable, unlike every other failure here:
// the work can simply be done again against fresh state. It gets its own type
// so locked() can retry exactly this and nothing else.
class LockLostError extends QueueError {}

const LOCK_ATTEMPTS = 3;

function fail(message) {
  throw new QueueError(message);
}

// Blocking sleep. This process does nothing else while it waits, and the
// alternative is an async rewrite of a script whose entire job is to be a short
// critical section.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A token unique to this run, written into the lock so `release` can tell its
// own lock from somebody else's. The pid alone is not enough: pids are reused,
// and the case that matters is precisely the one where an old process is gone.
const OWNER = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;

// What the lock is at one moment: which directory, when it was last touched,
// and who claims it. This is what tells "the lock I judged stale" apart from
// "a different lock that has replaced it since", a distinction rename cannot
// make on its own because it takes whatever is at the path.
function lockIdentity() {
  try {
    const st = fs.statSync(LOCK);
    let owner = null;
    try { owner = fs.readFileSync(path.join(LOCK, 'owner'), 'utf8'); } catch { /* not written yet */ }
    return { ino: st.ino, dev: st.dev, mtimeMs: st.mtimeMs, owner };
  } catch {
    return null;
  }
}

function sameLock(a, b) {
  return Boolean(a && b && a.ino === b.ino && a.dev === b.dev
    && a.mtimeMs === b.mtimeMs && a.owner === b.owner);
}

function holdingLock() {
  try {
    return fs.readFileSync(path.join(LOCK, 'owner'), 'utf8') === OWNER;
  } catch {
    return false;
  }
}

function acquire() {
  const deadline = Date.now() + WAIT_MS;

  // Every path that goes round again comes through here, so there is no way to
  // retry without both checking the deadline and pausing first.
  //
  // There used to be. A retry after a failed takeover jumped straight back to
  // the top, skipping both, and the loop then spun at full CPU with no exit:
  // mkdir fails EEXIST, the rename fails again for whatever reason it failed
  // the first time, round again forever. A directory that cannot be written to
  // is enough to trigger it, and the symptom is a session that hangs with no
  // message rather than the refusal that was supposed to happen after WAIT_MS.
  const waitOrGiveUp = (why) => {
    if (Date.now() > deadline) {
      fail(`queue.js: could not take the queue lock within ${WAIT_MS}ms (${why}). Nothing was written. Try again, or remove ${LOCK} if you are certain no other session is running.`);
    }
    sleep(POLL_MS);
  };

  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      // From here the lock exists and nothing is armed to remove it yet:
      // locked() only installs its finally once acquire returns. So if writing
      // the owner marker fails, on ENOSPC or EIO or the directory being moved
      // aside underneath us, the error would escape with the directory still on
      // disk, and no later run would clear it because release refuses to remove
      // a lock it does not own. Every write would be refused until it aged out.
      //
      // Undo it here, where the knowledge that it was just created still exists.
      try {
        fs.writeFileSync(path.join(LOCK, 'owner'), OWNER);
      } catch (markerError) {
        try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* nothing else to try */ }
        throw markerError;
      }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      // Someone else holds it, or nobody does and the directory is a leftover.
      const judged = lockIdentity();
      if (!judged) {
        // It vanished between the failed mkdir and the stat, so it is free now.
        waitOrGiveUp('the lock kept appearing and vanishing');
        continue;
      }
      const age = Date.now() - judged.mtimeMs;
      if (age > STALE_MS) {
        // Take it over by renaming it, never by deleting it in place.
        //
        // Deleting was wrong in a way worth spelling out, because it recreated
        // the exact bug this file exists to close. Two processes can both stat
        // the same abandoned lock and both decide it is stale. The first
        // deletes it and takes a fresh lock. The second then deletes that
        // brand-new lock and takes one of its own, and now two writers are
        // inside the critical section at once and one change is lost. The
        // recovery path reintroduced the race.
        //
        // A rename is atomic and has exactly one winner: whoever renames it
        // owns the takeover, and the loser gets ENOENT and goes back round to
        // find the winner's lock and wait for it properly.
        // The rename still has to be told which lock to move, and deciding a
        // lock is stale is a separate call from moving it. Between the two the
        // lock can be taken over by somebody else and replaced with a live one,
        // and rename takes whatever is at the path. Without this check a
        // process moves a brand-new lock aside and deletes it, putting two
        // writers in the critical section at once. That is the same corruption
        // the rename was introduced to prevent, arriving through the check
        // instead of through the delete.
        if (!sameLock(judged, lockIdentity())) {
          waitOrGiveUp('the stale lock was replaced before it could be moved aside');
          continue;
        }
        const aside = `${LOCK}.stale.${OWNER}`;
        try {
          fs.renameSync(LOCK, aside);
        } catch (renameError) {
          // Either somebody else won the takeover, in which case their lock is
          // the live one and waiting is right, or the rename cannot succeed at
          // all, for instance because the directory is not writable. The two
          // are indistinguishable from here and the deadline covers both: one
          // resolves inside it, the other reports rather than spinning.
          waitOrGiveUp(`a stale lock could not be moved aside: ${renameError.code || renameError.message}`);
          continue;
        }
        // Said out loud rather than silently: a stale lock means a session died
        // mid-write, and the entry it was writing may be half-formed.
        process.stderr.write(`queue.js: taking over a lock ${Math.round(age / 1000)}s old at ${LOCK}\n`);
        try { fs.rmSync(aside, { recursive: true, force: true }); } catch { /* it is out of the way already */ }
        continue;
      }
      waitOrGiveUp('another session is holding it');
    }
  }
}

// Removes the lock only if it is still ours. A process whose lock was taken
// over as stale, because it stalled for longer than STALE_MS, must not delete
// the lock of whoever took it: that would drop a live writer out of the
// critical section without either of them knowing.
function release() {
  try {
    if (fs.readFileSync(path.join(LOCK, 'owner'), 'utf8') !== OWNER) return;
  } catch {
    return; // No lock, or no owner file to prove it is ours. Leave it alone.
  }
  try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* already gone */ }
}

// Runs `fn` holding the lock, and releases it whatever happens. Without the
// finally, one thrown error leaves every future write blocked until the lock
// goes stale.
function locked(fn) {
  for (let attempt = 1; ; attempt += 1) {
    acquire();
    try {
      return fn();
    } catch (error) {
      if (!(error instanceof LockLostError)) throw error;
      if (attempt >= LOCK_ATTEMPTS) {
        fail(`queue.js: the queue lock was taken over by another session ${LOCK_ATTEMPTS} times running, so nothing was written. Try again, or remove ${LOCK} if you are certain no other session is running.`);
      }
      // Round again. fn re-reads the entry inside the new lock, so the retry
      // works from what is on disk now rather than from the copy that was
      // read before the lock was lost.
    } finally {
      release();
    }
  }
}

// An id becomes a filename, so it has to be one. Without this, an id carrying
// `../` writes outside the queue directory, and `show` would print, or `update`
// rewrite, an arbitrary JSON file elsewhere on disk.
//
// This is hardening rather than a trust boundary: the entry is composed by the
// model in the user's own session, so there is nobody hostile on the other side
// of it. It still matters, because ids are built from free text the user typed,
// target names and titles, and the old flow pinned the filename to a timestamped
// stem where this one takes whatever the `id` field says. A target name with a
// slash in it should fail loudly rather than write somewhere surprising.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Keys that --field and --json may not set, and why each one is here.
//
// `notes` is the whole point of the file. The guarantee is that a caller cannot
// hand over a notes array, so it cannot hand over a stale one, and --json
// notes=FILE was a way to do exactly that: it replaced the history and the
// before/after counter still read 1 -> 1, so the loss was hidden by the line
// meant to reveal it. Use --note, which appends to what is on disk.
//
// `id` has to equal the filename stem or the entry cannot be found by its own
// identifier, and nothing about setting it here moves the file.
//
// The prototype keys are not an exploit in a short-lived local process that
// serializes with JSON.stringify, which would not emit them anyway. They are
// here because an unchecked write of arbitrary property names is worth
// refusing on principle in a file that already refuses unchecked ids.
const PROTECTED_KEYS = new Set(['notes', 'id', '__proto__', 'constructor', 'prototype']);

function checkKey(key) {
  if (PROTECTED_KEYS.has(key)) {
    const advice = key === 'notes'
      ? ' Use --note, which appends to the notes already on the entry.'
      : key === 'id'
        ? ' An id has to match its filename, so changing one here would only break the pair.'
        : '';
    fail(`queue.js: ${key} cannot be set with --field or --json.${advice} Nothing was written.`);
  }
  return key;
}

function checkId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || id.includes('..')) {
    fail(`queue.js: ${JSON.stringify(id)} is not a usable entry id. Ids become filenames, so they may hold letters, digits, dots, dashes and underscores only, and may not contain "..". Nothing was read or written.`);
  }
  return id;
}

function entryPath(id, dir = QUEUE) {
  return path.join(dir, `${checkId(id)}.json`);
}

function readEntry(id, dir = QUEUE) {
  const p = entryPath(id, dir);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    fail(`queue.js: no entry at ${p}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`queue.js: ${p} is not valid JSON and was left alone: ${error.message}`);
  }
  if (!isEntry(parsed)) {
    fail(`queue.js: ${p} parses but does not hold an entry, it holds ${describe(parsed)}. It was left alone.`);
  }
  return parsed;
}

// Writes through a tempfile in the same directory, so the move is atomic and a
// crash mid-write cannot leave a half-file where the entry was. The parse check
// is on what is about to land rather than on what was composed, because those
// are only the same thing if the serialization worked.
// The status currently stored for an id, or undefined when there is no file yet
// or it cannot be read. Deliberately quiet: this only ever answers "is the
// caller changing the status", and a file that cannot be read has no prior value
// to preserve, so a new one has to be valid.
function statusOnDisk(id, dir) {
  try {
    return JSON.parse(fs.readFileSync(entryPath(id, dir), 'utf8')).status;
  } catch {
    return undefined;
  }
}

// JSON with object keys in a fixed order, so two spellings of the same value
// compare equal. Only used to answer "did this write change anything", never
// to produce something stored.
function stableJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJSON(value[k])}`).join(',')}}`;
}

function resolutionOnDisk(id, dir) {
  try {
    return JSON.parse(fs.readFileSync(entryPath(id, dir), 'utf8')).resolution;
  } catch {
    return undefined;
  }
}

function writeEntry(id, entry, dir = QUEUE) {
  // Refuse to write without the lock. The check in acquire narrows the takeover
  // race but cannot close it: there is no compare-and-swap for a rename, so two
  // adjacent syscalls are still two syscalls. This is what makes the remainder
  // harmless. A writer whose lock was taken over read the entry before the other
  // writer's change landed, so writing now would overwrite it silently while
  // both processes reported success.
  if (!holdingLock()) {
    throw new LockLostError('queue.js: the queue lock was taken over by another session mid-write. Nothing was written.');
  }
  // The one gate. Guarding the call sites instead meant guarding `--status`,
  // `--field status=` and `create`, and missing `--json status=FILE`, which
  // assigns a parsed value straight onto the entry. Review found that fourth
  // door, and a fifth would have been added the same way by whoever adds the
  // next option. Every write goes through here, so this is the only place the
  // check cannot be routed around.
  //
  // Only what this write CHANGES is checked. Validating unconditionally locked
  // every legacy entry out of being edited at all: an entry carrying the retired
  // `fix attempted / unresolved`, which SCHEMA.md says readers must still
  // accept, could not be given a note, and neither could the off-enum entries
  // `lint` exists to point at. The ones most in need of an annotation were the
  // ones that could not receive one.
  //
  // Reading the prior value here rather than having callers pass it keeps the
  // property that made this a gate: a new route cannot get it wrong by
  // forgetting an argument. The read is inside the lock, so nothing can change
  // between it and the write.
  //
  // Rewriting a bad status as itself is allowed and is a no-op. It introduces
  // no value that was not already there, and refusing it would put the entry
  // right back in the trap this paragraph is about.
  // A brand-new entry must carry one. `status` is required by both schemas, and
  // an entry without it matches no filter in /list-bugs, which is the same
  // invisibility this whole change exists to prevent. `create` used to write one
  // happily and `lint` then reported it as broken, so the tool accepted
  // something it went on to call a fault.
  //
  // An entry already on disk without a status is left alone, for the same reason
  // legacy values are: it can still be annotated while somebody decides what it
  // should be. Absent is preserved, never introduced.
  // The `!existed` arm is unreachable through the CLI as this stands: `create`
  // refuses a status-less entry before the lock is taken, and `update` cannot
  // reach a file that does not exist. Mutation testing confirmed it, so no test
  // covers it and none is claimed to. It is kept because this is the gate, and
  // the gate holding only for the routes that exist today is how the `--json`
  // hole was created in the first place.
  const existed = fs.existsSync(entryPath(id, dir));
  const statusChanged = Boolean(entry) && entry.status !== undefined && entry.status !== statusOnDisk(id, dir);
  if (entry && entry.status === undefined) {
    if (!existed) {
      fail(
        `queue.js: a new entry needs a status, and this one has none. Nothing was written.`
        + `\n  Valid: ${statusList(statusesFor(listNameFor(dir)).write)}`
      );
    }
  } else if (statusChanged) {
    checkStatus(entry.status, listNameFor(dir));
  }

  // Same gate, same rule: only what this write CHANGES. Nineteen entries on
  // disk carry a resolution written by hand in three different shapes, and
  // every one of them predates this check. Validating unconditionally would
  // lock all nineteen out of ever being annotated again, which is the trap the
  // status check above already fell into once.
  //
  // Compared with keys sorted, because `--json resolution=FILE` parses a fresh
  // object every time and JSON.stringify is order-sensitive. Handing back the
  // same legacy value with its keys in a different order read as a change,
  // which then validated it under the new rules and refused it. The entry had
  // not changed and could not be written.
  const resolutionChanged = Boolean(entry)
    && stableJSON(entry.resolution) !== stableJSON(resolutionOnDisk(id, dir));
  if (resolutionChanged) {
    const had = resolutionOnDisk(id, dir);
    // Clearing one is not an edit, it is a deletion, and it succeeded in
    // silence: `problemsWith(null)` has nothing to object to, so a resolution
    // file holding `null` replaced a complete record of outcome, timestamp,
    // summary and commit with nothing, and left the status saying Resolved.
    // This queue never deletes an entry, it changes the status instead, and
    // the same reasoning applies one level down.
    if ((entry.resolution === null || entry.resolution === undefined) && had !== null && had !== undefined) {
      fail(
        `queue.js: that would erase the resolution on ${id} and nothing was written.\n`
        + `  It currently records: ${JSON.stringify(had)}\n`
        + `  To reopen the entry, change its status. The resolution stays as the record\n`
        + `  of the earlier close. To correct it, write a new one rather than clearing it.`
      );
    }
    const problems = problemsWith(entry.resolution);
    if (problems.length) {
      fail(
        `queue.js: this resolution cannot be read back. Nothing was written.\n`
        + problems.map((p) => `  - ${p}`).join('\n')
        + `\n  Outcomes: ${outcomeList()}`
      );
    }
  }

  // The two fields, judged together. Both checks above look at one field and
  // ask whether this write changed it, which left the pair unguarded from both
  // sides.
  //
  // `Resolved` and `Won't Fix` are the only statuses this applies to, and only
  // on the queue: they do not exist in the to-build enum, and the other three
  // are not closures. An entry sitting on `Open` after being reopened keeps the
  // resolution of the earlier close, which is the documented way to reopen one,
  // so nothing here may object to that pairing.
  //
  // Read through `normalise` rather than `problemsWith`. The question is
  // whether the meaning can be read back, and the nineteen legacy resolutions
  // answer it without satisfying the writer's rules: `{commit, fixed_at,
  // summary}` on a Resolved entry reads as `fix_applied` and has no `at` at
  // all. Validating instead of reading would refuse to reclose the very entries
  // this gate had just allowed to be reopened.
  if (listNameFor(dir) === 'queue' && entry && isClosed(entry.status) && (statusChanged || resolutionChanged)) {
    const read = normalise(entry.resolution);
    const priorStatus = statusOnDisk(id, dir);
    const wasClosed = alreadyClosed(priorStatus);
    // A repair means the same closed status after punctuation and case are
    // removed: `Wontfix` -> `Won't Fix`. Merely starting and ending closed is
    // not enough; `Resolved` -> `Won't Fix` is a different state and must be
    // judged against the resolution like any other closure change.
    const pureClosedStatusRepair = statusChanged && !resolutionChanged && wasClosed
      && loosely(entry.status) === loosely(priorStatus);

    // Closing with nothing recorded. `queue.js update x --status Resolved`
    // against an entry whose resolution was null changed no resolution, so the
    // gate above never ran and the entry closed saying nothing about what
    // closing it meant. SCHEMA.md says the field is null only until closure,
    // and this is the sentence that makes that true rather than aspirational.
    //
    // Only when this write is the closure. An entry already closed without a
    // resolution predates the rule and can still be annotated and still have a
    // misspelt status repaired, which is the same rule as everywhere else here.
    // Moving `Wontfix` to `Won't Fix` is not a closing act, and refusing it
    // would break the fix `lint` prints for the fault `lint` exists to find.
    if (statusChanged && !pureClosedStatusRepair && (!read || !read.outcome)) {
      fail(
        `queue.js: closing ${id} as ${showStatus(entry.status)} needs a resolution saying what that meant.\n`
        + `  It currently records: ${JSON.stringify(entry.resolution === undefined ? null : entry.resolution)}\n`
        + `  Write one with --resolution FILE in the same call:\n`
        + `    {"outcome": "...", "at": "<ISO-8601>", "summary": "<what happened, plainly>"}\n`
        + `  Outcomes: ${outcomeList()}`
      );
    }

    // A pure spelling repair must remain reachable even when the old entry is
    // internally contradictory. `lint` can make the status visible again; it
    // cannot decide which historical outcome was intended. Requiring both to
    // be rewritten turns the printed one-field remedy into a dead end.
    const clash = !pureClosedStatusRepair && read && disagreement(entry.status, read.outcome);
    if (clash) {
      fail(`queue.js: ${clash}. Nothing was written.`);
    }
  }

  const target = entryPath(id, dir);
  const tmp = `${target}.${process.pid}.tmp`;
  const text = JSON.stringify(entry, null, 2) + '\n';
  JSON.parse(text);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
}

function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

// --- commands ------------------------------------------------------------

// Changes an existing entry. Everything is optional, and everything asked for
// in one call lands in one write, so a status and the note explaining it cannot
// be separated by another session's write.
function cmdUpdate(args) {
  const id = args._[0];
  if (!id) fail('queue.js update <id> [--list L] [--status S] [--note TEXT] [--note-file FILE] [--json key=FILE] [--field key=value]');
  const dir = dirFor(args.list);

  return locked(() => {
    const entry = readEntry(id, dir);
    const before = Array.isArray(entry.notes) ? entry.notes.length : 0;
    const ts = nowISO();

    // Not validated here. writeEntry is the single gate, and a check at this
    // call site would suggest the other three routes are covered by their own,
    // which is exactly the reasoning that missed `--json status=FILE`.
    // `!== undefined`, not truthiness. `--status ""` used to be skipped here
    // because an empty string is falsy, so the entry kept its old status and
    // the command printed "updated" and exited 0 having changed nothing. The
    // other two routes refuse it, so the three disagreed about the same value.
    // An empty status is not a way of saying "leave it alone"; leaving the
    // option off is.
    if (args.status !== undefined) entry.status = args.status;

    // --resolution FILE is the same thing as --json resolution=FILE, kept
    // because it is the common case and reads better at the call site.
    const jsonFields = [...(args.json || [])];
    // Same shape, same reason. `--resolution ""` was silently ignored, where
    // an empty filename should be reported as one that cannot be read.
    if (args.resolution !== undefined) jsonFields.push(`resolution=${args.resolution}`);

    for (const pair of jsonFields) {
      const at = pair.indexOf('=');
      if (at < 1) fail(`queue.js: --json wants key=FILE, got ${pair}`);
      const key = checkKey(pair.slice(0, at));
      const file = pair.slice(at + 1);
      // Named rather than left to render as nothing. `--resolution ""` reaches
      // here as an empty filename, and "cannot read  for --json resolution"
      // reads like a bug in the message rather than a fault in the input.
      if (!file) fail(`queue.js: --json ${key} needs a filename and was given an empty one. Nothing was written.`);
      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        fail(`queue.js: cannot read ${file} for --json ${key}. Nothing was written.`);
      }
      try {
        entry[key] = JSON.parse(raw);
      } catch (error) {
        fail(`queue.js: ${file} is not valid JSON: ${error.message}. Nothing was written.`);
      }
    }

    // --field is for plain strings. Anything structured goes through --json,
    // so a value that should be an object cannot land as the characters that
    // spell one.
    for (const pair of args.field || []) {
      const at = pair.indexOf('=');
      if (at < 1) fail(`queue.js: --field wants key=value, got ${pair}`);
      entry[checkKey(pair.slice(0, at))] = pair.slice(at + 1);
    }

    // Appended, never rebuilt. The notes array is the audit trail and is read
    // at the moment something has gone wrong, which is when it is least
    // affordable to lose. Reading it here rather than accepting a whole array
    // from the caller is what makes that structural rather than a rule someone
    // has to remember.
    // --note-file takes the text from a file rather than the command line.
    //
    // Notes carry free text: a tool's error message, retry instructions the
    // user typed, a commit subject. Interpolating those into a quoted shell
    // argument means a double quote, a backtick, a `$(...)` or a newline in the
    // text ends or extends the argument, and this runs in a context where
    // Bash(node:*) is allowed. Reading the text from a file removes the shell
    // from the path entirely, which is a guarantee where careful quoting is a
    // habit.
    const texts = [...(args.note || [])];
    for (const file of args['note-file'] || []) {
      try {
        texts.push(fs.readFileSync(file, 'utf8').replace(/\n+$/, ''));
      } catch {
        fail(`queue.js: cannot read note file ${file}. Nothing was written.`);
      }
    }

    for (const text of texts) {
      if (!Array.isArray(entry.notes)) entry.notes = [];
      entry.notes.push({ ts, text });
    }

    writeEntry(id, entry, dir);
    const after = Array.isArray(entry.notes) ? entry.notes.length : 0;
    process.stdout.write(`updated ${id}: status ${entry.status || '(unset)'}, notes ${before} -> ${after}\n`);
    return 0;
  });
}

// Creates a new entry from a composed file, re-checking for a duplicate inside
// the lock. The check and the write used to be separate tool calls, so two
// sessions capturing the same correction both saw an empty queue and both
// wrote. Here nothing can land between them.
function cmdCreate(args) {
  const from = args._[0];
  if (!from) fail('queue.js create <file.json> [--list L] [--dedup-window MINUTES]');
  const dir = dirFor(args.list);

  // `all` means no expiry: any entry with this dedup_key counts, however old.
  // That is what a dep-review wants, because one parent and one dependent is
  // one logical review forever, not one every ten minutes.
  const raw = args['dedup-window'] === undefined ? '10' : String(args['dedup-window']);
  const windowMin = raw === 'all' ? Infinity : Number(raw);
  if (!(windowMin >= 0)) fail('queue.js: --dedup-window wants a number of minutes, or "all"');

  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(from, 'utf8'));
  } catch (error) {
    fail(`queue.js: ${from} is not valid JSON: ${error.message}. Nothing was written.`);
  }
  if (!isEntry(entry)) {
    fail(`queue.js: ${from} parses but does not hold an entry, it holds ${describe(entry)}. Nothing was written.`);
  }
  if (!entry.id) fail('queue.js: the entry has no id, so there is nowhere to write it.');
  checkId(entry.id);
  // Kept as well as the gate in writeEntry, and the only call site that is.
  // This one runs before the lock is taken, so a composed file with a bad
  // status is refused without making anyone else wait for it. The gate would
  // catch it either way.
  // Refused before the lock is taken, so a bad composed file does not make
  // anyone wait. The gate in writeEntry enforces the same two rules and is what
  // makes them unavoidable; this is the early, cheaper copy.
  if (entry.status === undefined) {
    fail(
      'queue.js: a new entry needs a status, and this one has none. Nothing was written.'
      + `\n  Valid: ${statusList(statusesFor(args.list).write)}`
    );
  }
  checkStatus(entry.status, args.list);

  return locked(() => {
    if (fs.existsSync(entryPath(entry.id, dir))) {
      fail(`queue.js: ${entry.id} already exists. Nothing was written.`);
    }

    if (entry.dedup_key && windowMin > 0) {
      const cutoff = Date.now() - windowMin * 60000;
      for (const file of listFiles(dir)) {
        let other;
        try {
          other = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        } catch {
          continue; // A malformed neighbour is list-bugs' problem, not this one.
        }
        // And one that parses to something other than an entry is the same
        // kind of neighbour. Skipping is what the catch above already intends.
        if (!isEntry(other)) continue;
        if (other.dedup_key !== entry.dedup_key) continue;
        const at = Date.parse(other.created_at);
        // An unparseable date counts as a match. Treating it as "long ago"
        // would let the duplicate through on the strength of a field nobody
        // can read, and a duplicate refused is cheaper than one written.
        if (Number.isNaN(at) || at >= cutoff) {
          process.stdout.write(`duplicate: ${file} has the same dedup_key. Nothing was written.\n`);
          return 2;
        }
      }
    }

    writeEntry(entry.id, entry, dir);
    process.stdout.write(`created ${entry.id}\n`);
    return 0;
  });
}

function listFiles(dir = QUEUE) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

// Prints one entry, so a skill can read it without the Read tool and without
// holding a copy across calls it then writes back.
function cmdShow(args) {
  const id = args._[0];
  if (!id) fail('queue.js show <id> [--list L]');
  process.stdout.write(JSON.stringify(readEntry(id, dirFor(args.list)), null, 2) + '\n');
  return 0;
}

// --- argument parsing ----------------------------------------------------

// Repeatable flags collect into an array, because --note is used more than once
// in a single update and the last one winning would silently drop the rest.
const REPEATABLE = new Set(['note', 'note-file', 'field', 'json']);

// Options that take a value, and therefore always consume the next token.
//
// The parser used to decide that by looking at the token: if it began with two
// dashes it could not be a value. That silently destroyed any note starting
// with dashes. `--note "--force was ignored"` is one shell argument, but it
// begins with `--`, so `note` was set to the string 'true', the real text was
// re-read as a flag called `force was ignored`, and the entry was written with
// a note reading `true` and an exit code of 0. The text of what went wrong,
// gone, with nothing to notice.
//
// Knowing which options take values removes the guess. `--note --force` now
// means a note reading `--force`, which is what it looks like it means.
const VALUE_OPTS = new Set([
  'list', 'status', 'note', 'note-file', 'field', 'json', 'resolution', 'dedup-window',
]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { out._.push(token); continue; }

    // `--name=value` is unambiguous whatever the value starts with.
    const eq = token.indexOf('=');
    let name = eq > 2 ? token.slice(2, eq) : token.slice(2);
    let value = eq > 2 ? token.slice(eq + 1) : undefined;

    // An unknown option used to become a silent boolean, which is how a
    // mangled value turned into a flag nobody asked for. Refusing it means a
    // typo is reported rather than ignored.
    if (!VALUE_OPTS.has(name)) {
      fail(`queue.js: unknown option --${name}. Known options: ${[...VALUE_OPTS].map((o) => '--' + o).join(', ')}`);
    }

    if (value === undefined) {
      if (i + 1 >= argv.length) fail(`queue.js: --${name} needs a value.`);
      value = argv[++i];
    }

    if (REPEATABLE.has(name)) (out[name] = out[name] || []).push(value);
    else out[name] = value;
  }
  return out;
}

// Reports entries already on disk whose status is not in the enum. Refusing bad
// writes from here on does nothing about anything already stored, and the two
// entries that prompted this had been wrong for four days before anyone looked.
//
// A retired status is reported separately and does not fail the run, because
// SCHEMA.md says readers still accept it. Counting it as a fault would tell
// somebody their correct history is broken.
//
// Exit 0 clean, 3 when something is off-enum, matching roots.js in using a
// distinct code rather than 1, so a caller can tell a finding from a crash.
function cmdLint(args) {
  const dir = dirFor(args.list);
  const list = args.list === undefined ? 'queue' : String(args.list);
  const spec = statusesFor(args.list);
  const bad = [];
  const retired = [];
  let unreadable = 0;

  for (const file of listFiles(dir)) {
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      unreadable += 1;
      continue;
    }
    // Counted with the unreadable rather than crashing the scan. The command
    // promises it does not diagnose an unreadable file as a status fault, and
    // a file holding `null` is unreadable in every sense that matters here.
    if (!isEntry(entry)) {
      unreadable += 1;
      continue;
    }
    const status = entry.status;
    if (spec.write.includes(status)) continue;
    if (spec.retired.includes(status)) {
      retired.push([file, status]);
      continue;
    }
    // Writable values only, for the same reason as checkStatus: the line below
    // ends with an update command, and suggesting a value that command refuses
    // makes the report a dead end.
    const near = spec.write.find((s) => loosely(s) === loosely(status));
    bad.push([file, status, near]);
  }

  // Ids, not filenames. The fix below takes an id, and `bad.json` is not one:
  // pasting it gives "no entry at .../bad.json.json". The id is the filename
  // stem by schema rule, so this is the same string with the suffix off.
  const idOf = (file) => file.replace(/\.json$/, '');

  for (const [file, status, near] of bad) {
    const hint = near ? `  (did you mean ${JSON.stringify(near)}?)` : '';
    process.stdout.write(`off-enum  ${idOf(file)}  status=${showStatus(status)}${hint}\n`);
  }
  for (const [file, status] of retired) {
    process.stdout.write(`retired   ${idOf(file)}  status=${showStatus(status)}  (valid on read, refused on write)\n`);
  }
  if (unreadable) {
    // Files rather than ids, deliberately. These did not parse into entries, so
    // there is nothing to call an id and nothing to run a command against.
    process.stdout.write(`unreadable ${unreadable} file(s), which this command does not diagnose\n`);
  }
  if (bad.length === 0) {
    process.stdout.write(`every status in ${list} is in the enum\n`);
    return 0;
  }
  // `--list` named every time, including for the default. cmdUpdate falls back
  // to the queue when it is absent, so a fix copied out of a `--list to-build`
  // run used to look for the id in the wrong place: "no entry at ...", or worse,
  // a silent edit of an unrelated entry when the same id existed in both.
  process.stdout.write(`\n${bad.length} ${bad.length === 1 ? 'entry carries' : 'entries carry'} a status no reader matches. Fix with: queue.js update <id> --status <valid> --list ${list}\n`);
  return 3;
}

const COMMANDS = {
  update: cmdUpdate, create: cmdCreate, show: cmdShow, lint: cmdLint,
};

function main(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write([
      'queue.js <command>',
      '',
      '  show   <id>                                    print an entry',
      '  update <id> [--status S] [--note TEXT]...      change one, under a lock',
      '              [--note-file FILE]  (free text: use this, not --note)',
      '              [--json key=FILE] [--field key=value]',
      '  create <file.json> [--dedup-window MINUTES]    add one, dedup under the same lock',
      '  lint                                           report statuses no reader matches',
      '',
      '  A status is checked against the list it is written to. Exit 3 from lint',
      '  means something on disk is off-enum.',
      '',
      '  --list queue (default) or to-build. Both live under ~/.claude/build-loop',
      '  and share one lock.',
      '',
    ].join('\n'));
    return 0;
  }
  const run = COMMANDS[command];
  if (!run) fail(`queue.js: unknown command ${command}. Try --help.`);
  return run(parseArgs(argv.slice(1)));
}

if (require.main === module) {
  let code = 0;
  try {
    code = main(process.argv.slice(2)) || 0;
  } catch (error) {
    // A QueueError is a message written for the person reading it. Anything
    // else is a bug here, and its stack is the useful part.
    process.stderr.write((error instanceof QueueError ? error.message : error.stack) + '\n');
    code = 1;
  }
  // `process.exitCode`, never `process.exit`. On macOS a write to a pipe is
  // asynchronous, so exiting immediately after one can drop it, and every
  // caller here is a skill reading what was printed: flag-issue names the entry
  // create reported, apply-fix repeats what update said when it failed. A
  // truncated line there is a skill reporting nothing, or half a sentence, at
  // the moment something went wrong.
  //
  // Setting the code and letting the process end on its own flushes first.
  // Nothing in this file is asynchronous, so it ends immediately either way.
  process.exitCode = code;
}

// STATUSES is exported for one reason: it is a second copy of the enums written
// out in SCHEMA.md and SCHEMA-BUILD.md, and a test compares the two. Without
// that comparison, adding a status to a schema and forgetting this Map would
// make the new value unwritable rather than merely undocumented, which is a
// worse failure than the one before this file validated anything.
module.exports = { main, LOCK, QUEUE, STATUSES };
