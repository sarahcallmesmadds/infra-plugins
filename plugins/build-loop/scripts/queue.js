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

const ROOT = path.join(os.homedir(), '.claude', 'build-loop');
const QUEUE = path.join(ROOT, 'queue');
const LOCK = path.join(ROOT, '.queue.lock');

// Two lists live under the same root and are read and written the same way, so
// they share this. One lock covers both rather than one each: the work under it
// is a single small file write, so contention between them is not a real cost,
// and one lock is one thing to reason about and one thing to delete by hand if
// it is ever left behind.
const LISTS = { queue: QUEUE, 'to-build': path.join(ROOT, 'to-build') };

function dirFor(name) {
  const dir = LISTS[name || 'queue'];
  if (!dir) fail(`queue.js: unknown list ${name}. Use one of: ${Object.keys(LISTS).join(', ')}`);
  return dir;
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

function fail(message) {
  throw new QueueError(message);
}

// Blocking sleep. This process does nothing else while it waits, and the
// alternative is an async rewrite of a script whose entire job is to be a short
// critical section.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire() {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(path.join(LOCK, 'owner'), String(process.pid));
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      // Someone else holds it, or nobody does and the file is a leftover.
      let age = 0;
      try {
        age = Date.now() - fs.statSync(LOCK).mtimeMs;
      } catch {
        // It vanished between the failed mkdir and the stat, so it is free now.
        continue;
      }
      if (age > STALE_MS) {
        // Take it over. Say so on stderr rather than silently, because a stale
        // lock means a session died mid-write and the entry may be half-formed.
        process.stderr.write(`queue.js: taking over a lock ${Math.round(age / 1000)}s old at ${LOCK}\n`);
        try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* raced, retry */ }
        continue;
      }
      if (Date.now() > deadline) {
        fail(`queue.js: another session has held the queue lock for ${WAIT_MS}ms. Nothing was written. Try again, or remove ${LOCK} if you are certain no other session is running.`);
      }
      sleep(POLL_MS);
    }
  }
}

function release() {
  try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* nothing to release */ }
}

// Runs `fn` holding the lock, and releases it whatever happens. Without the
// finally, one thrown error leaves every future write blocked until the lock
// goes stale.
function locked(fn) {
  acquire();
  try {
    return fn();
  } finally {
    release();
  }
}

function entryPath(id, dir = QUEUE) {
  return path.join(dir, `${id}.json`);
}

function readEntry(id, dir = QUEUE) {
  const p = entryPath(id, dir);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    fail(`queue.js: no entry at ${p}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`queue.js: ${p} is not valid JSON and was left alone: ${error.message}`);
  }
}

// Writes through a tempfile in the same directory, so the move is atomic and a
// crash mid-write cannot leave a half-file where the entry was. The parse check
// is on what is about to land rather than on what was composed, because those
// are only the same thing if the serialization worked.
function writeEntry(id, entry, dir = QUEUE) {
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
  if (!id) fail('queue.js update <id> [--list L] [--status S] [--note TEXT] [--json key=FILE] [--field key=value]');
  const dir = dirFor(args.list);

  return locked(() => {
    const entry = readEntry(id, dir);
    const before = Array.isArray(entry.notes) ? entry.notes.length : 0;
    const ts = nowISO();

    if (args.status) entry.status = args.status;

    // --resolution FILE is the same thing as --json resolution=FILE, kept
    // because it is the common case and reads better at the call site.
    const jsonFields = [...(args.json || [])];
    if (args.resolution) jsonFields.push(`resolution=${args.resolution}`);

    for (const pair of jsonFields) {
      const at = pair.indexOf('=');
      if (at < 1) fail(`queue.js: --json wants key=FILE, got ${pair}`);
      const key = pair.slice(0, at);
      const file = pair.slice(at + 1);
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
      entry[pair.slice(0, at)] = pair.slice(at + 1);
    }

    // Appended, never rebuilt. The notes array is the audit trail and is read
    // at the moment something has gone wrong, which is when it is least
    // affordable to lose. Reading it here rather than accepting a whole array
    // from the caller is what makes that structural rather than a rule someone
    // has to remember.
    for (const text of args.note || []) {
      if (!Array.isArray(entry.notes)) entry.notes = [];
      entry.notes.push({ ts, text });
    }

    writeEntry(id, entry, dir);
    const after = Array.isArray(entry.notes) ? entry.notes.length : 0;
    process.stdout.write(`updated ${id}: status ${entry.status}, notes ${before} -> ${after}\n`);
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
  if (!entry.id) fail('queue.js: the entry has no id, so there is nowhere to write it.');

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
const REPEATABLE = new Set(['note', 'field', 'json']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { out._.push(token); continue; }
    const name = token.slice(2);
    const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    if (REPEATABLE.has(name)) (out[name] = out[name] || []).push(value);
    else out[name] = value;
  }
  return out;
}

const COMMANDS = { update: cmdUpdate, create: cmdCreate, show: cmdShow };

function main(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write([
      'queue.js <command>',
      '',
      '  show   <id>                                    print an entry',
      '  update <id> [--status S] [--note TEXT]...      change one, under a lock',
      '              [--json key=FILE] [--field key=value]',
      '  create <file.json> [--dedup-window MINUTES]    add one, dedup under the same lock',
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
  process.exit(code);
}

module.exports = { main, LOCK, QUEUE };
