// A short critical section around the handoff index.
//
// `handoffs.js` mutates `index.json` in four places, and every one of them was
// read, change in memory, write back. `writeIndex` renames a temporary file
// over the real one, which is atomic and does stop a reader seeing a
// half-written file. It does nothing at all about two writers: session B reads
// the index before session A renames, then B renames its own copy over A's
// entry, and A's handoff is silently unlisted. The rename made each write
// indivisible and left the read-then-write pair wide open.
//
// Measured before this file existed, 40 concurrent `recordHandoff` calls
// against a throwaway home: 15 to 18 entries survived, varying run to run.
//
// The logic here is a port of the lock in build-loop's `queue.js`, which has
// been through several rounds of exactly this problem. It is copied rather than
// imported because plugins install separately and one cannot require another's
// files. `hook-io.js` already lives in three plugins for the same reason.
//
// Parameterised by lock path where queue.js hardcodes one, because the session
// plugin locks per index rather than per repository, and the tests need to lock
// inside a throwaway home.

'use strict';

const fs = require('fs');
const path = require('path');

// The wait is generous because the work under this lock is one small file
// write. Anything approaching the deadline means something is wrong rather
// than busy.
const WAIT_MS = 5000;
const STALE_MS = 30000;
const POLL_MS = 25;

// Unique per process run. The pid alone is not enough: pids are reused, and the
// case that matters is the one where the old process is gone.
const OWNER = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;

// The region this process is currently inside, per lock path.
//
// `archiveStale` repoints entries and then calls `pruneIndex`, which asks for
// the same lock. Without this the second request waits on a lock this very
// process holds, spends the whole deadline, and then proceeds unlocked. Both of
// them have to run inside one region anyway: a sweep that repoints under a lock
// and then prunes under a different one lets another writer in between the two.
//
// The entry is recorded whether or not the lock was taken, and that is the
// point rather than an accident. It used to be recorded only on the acquiring
// path, so a nested call inside a region that had already given up went back
// through `acquire`, waited out a second full deadline and printed a second
// warning about the same write. Worse than the delay: it could succeed where
// the outer call had failed, which put the repoint outside the lock and the
// prune inside it, and those two being one region is the whole reason this is
// re-entrant.
//
// So a nested call inherits the outer answer exactly, including a failure.
// Whether this process is inside a region is a different question from whether
// the region holds the lock, and recording only the second one lost the first.
//
// Shape: lock path -> { count, locked, reason }.
const regions = new Map();

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Which directory, when it was last touched, and who claims it. This tells
// "the lock I judged stale" apart from "a different lock that has replaced it
// since", a distinction rename cannot make on its own because it takes
// whatever is at the path.
function lockIdentity(lock) {
  try {
    const st = fs.statSync(lock);
    let owner = null;
    try { owner = fs.readFileSync(path.join(lock, 'owner'), 'utf8'); } catch (_) { /* not written yet */ }
    return { ino: st.ino, dev: st.dev, mtimeMs: st.mtimeMs, owner };
  } catch (_) {
    return null;
  }
}

function sameLock(a, b) {
  return Boolean(a && b && a.ino === b.ino && a.dev === b.dev
    && a.mtimeMs === b.mtimeMs && a.owner === b.owner);
}

// Returns 'acquired', 'busy', or 'unavailable'.
//
// Three answers rather than two, because the two failures need different
// handling and one boolean cannot tell them apart. 'busy' means somebody else
// is writing right now and this write is going ahead beside theirs, which is
// the dangerous case and gets said out loud. 'unavailable' means no lock could
// be created at all, usually a directory that is not writable, in which case
// the index write is about to fail too and `indexWritten: false` already
// reports it. Warning about a lost race that nobody was in would be noise on
// exactly the path that is already reporting a real failure.
//
// Never throws on contention. The caller's contract is that losing the index
// must not take the wrap down, so a refusal here has to be something the
// caller can carry on past rather than an exception through the middle of it.
function acquire(lock, now = Date.now) {
  const deadline = now() + WAIT_MS;

  // Every path that goes round again comes through here, so there is no way to
  // retry without both checking the deadline and pausing first. queue.js once
  // had a retry that skipped both and spun at full CPU with no exit.
  const waitOrGiveUp = () => {
    if (now() > deadline) return false;
    sleep(POLL_MS);
    return true;
  };

  for (;;) {
    try {
      fs.mkdirSync(lock, { recursive: false });
      // From here the lock exists and nothing is armed to remove it. If writing
      // the owner marker fails, on ENOSPC or the directory being moved aside
      // underneath us, the error would escape with the directory still on disk
      // and no later run would clear it, because release refuses to remove a
      // lock it does not own. Undo it here, where the knowledge that it was
      // just created still exists.
      try {
        fs.writeFileSync(path.join(lock, 'owner'), OWNER);
      } catch (_) {
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) { /* nothing else to try */ }
        return 'unavailable';
      }
      return 'acquired';
    } catch (error) {
      // Anything other than a collision means no lock can be made here at all:
      // a directory that is not writable, or one that is not there. Contention
      // is EEXIST and only EEXIST.
      if (!error || error.code !== 'EEXIST') return 'unavailable';

      const judged = lockIdentity(lock);
      if (!judged) {
        // It vanished between the failed mkdir and the stat, so it is free now.
        if (!waitOrGiveUp()) return 'busy';
        continue;
      }
      if (now() - judged.mtimeMs <= STALE_MS) {
        if (!waitOrGiveUp()) return 'busy';
        continue;
      }

      // Take a stale lock over by renaming it, never by deleting it in place.
      //
      // Deleting recreates the exact bug this file exists to close. Two
      // processes can both stat the same abandoned lock and both judge it
      // stale. The first deletes it and takes a fresh one. The second then
      // deletes that brand-new lock and takes one of its own, and now two
      // writers are inside the critical section at once. A rename is atomic
      // and has exactly one winner.
      //
      // Judging a lock stale and moving it aside are two calls, and between
      // them the lock can be taken over by somebody else and replaced with a
      // live one. rename takes whatever is at the path, so without this check
      // a process moves a brand-new lock aside and deletes it.
      if (!sameLock(judged, lockIdentity(lock))) {
        if (!waitOrGiveUp()) return 'busy';
        continue;
      }
      const aside = `${lock}.stale.${OWNER}`;
      try {
        fs.renameSync(lock, aside);
      } catch (_) {
        // Either somebody else won the takeover, in which case waiting is
        // right, or the rename cannot succeed at all. The two are
        // indistinguishable from here and the deadline covers both.
        if (!waitOrGiveUp()) return 'busy';
        continue;
      }
      // Said out loud rather than silently: a stale lock means a session died
      // mid-write, and the entry it was writing may be half-formed.
      process.stderr.write(`session: taking over a handoff index lock at ${lock}\n`);
      try { fs.rmSync(aside, { recursive: true, force: true }); } catch (_) { /* out of the way already */ }
      continue;
    }
  }
}

// Removes the lock only if it is still ours. A process whose lock was taken
// over as stale must not delete the lock of whoever took it: that would drop a
// live writer out of the critical section without either of them knowing.
function release(lock) {
  try {
    if (fs.readFileSync(path.join(lock, 'owner'), 'utf8') !== OWNER) return;
  } catch (_) {
    return; // No lock, or no owner file to prove it is ours. Leave it alone.
  }
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) { /* already gone */ }
}

// Run `fn` holding the lock at `lock`, and release it whatever happens.
//
// Returns `{ value, locked, reason }`. `reason` is 'acquired', 'reentrant',
// 'busy' or 'unavailable'.
//
// Running `fn` even when the lock was not taken is deliberate, and it is the
// one place this trades correctness for availability. The rule it serves is
// written at `writeIndex`: losing the index degrades pickup to guessed paths,
// and it must never take the wrap down, because the handoff itself is the
// point. Refusing to write after a five second wait would fail the wrap to
// protect an index that is a convenience.
//
// An unprotected write must not be silent about it, but the warning belongs to
// the write and not to the region. It used to be printed here, up front, from
// the lock answer alone. Every path through the gate reaches this line,
// including the ones that only read: a dry run, or a sweep with nothing to move
// and nothing to prune. Those printed "an entry may have been lost" after
// changing nothing, which is not a warning, it is a false statement, and it is
// the same contract the surrounding code enforces on `indexWritten`. Devin
// round 2 on PR #109.
//
// So `warnUnprotectedWrite` is exported and called at the moment a write
// actually happens without the lock. Once per region, because one write is one
// warning however many nested calls made it.
//
// A caller that knows it cannot write says so with `readOnly`, and then no lock
// is taken and nothing waits. That is what stops a preview stalling five
// seconds behind another session's write.
function exists(dir) {
  try { return fs.existsSync(dir); } catch (_) { return false; }
}

// A region that runs without the lock, for the two cases where there is nothing
// to protect. Still recorded, so a nested call inherits the answer rather than
// going off to take a lock its caller decided against.
function unlockedRegion(lock, fn, reason) {
  const region = { count: 1, locked: false, reason };
  regions.set(lock, region);
  try {
    return { value: fn(), locked: false, reason };
  } finally {
    region.count -= 1;
    if (region.count === 0) regions.delete(lock);
  }
}

function withIndexLock(lock, fn, { readOnly = false, mayCreate = false } = {}) {
  // Already inside a region for this lock on this process, so run directly and
  // inherit its answer. Inherited whether or not that region holds the lock: a
  // nested call that goes looking again can wait a second deadline, warn twice
  // about one write, and end up on the other side of the lock from the call
  // that contains it.
  //
  // A read-only nested call inherits too rather than opting out, because the
  // region around it may still write and the snapshot has to be the same one.
  const outer = regions.get(lock);
  if (outer) {
    outer.count += 1;
    try {
      return { value: fn(), locked: outer.locked, reason: 'reentrant' };
    } finally {
      outer.count -= 1;
    }
  }

  // A caller that cannot write does not queue behind one that can. Reads are
  // safe unlocked: `writeIndexUnlocked` renames a finished file over the old
  // one, so a reader gets one whole version or the other and never a torn one.
  // A preview of state that another session is changing is approximate by
  // nature, and waiting five seconds does not make it less so.
  if (readOnly) return unlockedRegion(lock, fn, 'read-only');

  // Nothing on disk yet, and this caller cannot put anything there.
  //
  // The lock lives inside the handoffs folder, so taking it means creating that
  // folder. This gate is entered by every mutation, including the ones that turn
  // out to change nothing, so creating it up front put `~/.planning/handoffs` on
  // machines that had never had one, from commands that reported doing nothing.
  // `archiveStale` refuses that exact side effect a few lines away, in as many
  // words. Devin round 3 on PR #109.
  //
  // Safe to skip the lock here rather than merely convenient: with no folder
  // there is no index, `readIndex` gives back an empty map, and a caller that
  // cannot create the folder has nothing it could write. There is no
  // read-then-write pair to protect, because there is no write.
  //
  // `mayCreate` is for the one caller that always writes. It creates the folder
  // because that is what recording a handoff means, not as a side effect of
  // looking.
  //
  // Not "skip the lock when the index file is absent", which is the same idea
  // one step too far: two sessions wrapping for the first time on a fresh
  // machine would both read an empty index and both write, which is the race
  // this whole file exists to close, surviving in the one case nobody would
  // think to test.
  if (!mayCreate && !exists(path.dirname(lock))) {
    return unlockedRegion(lock, fn, 'no-index');
  }

  let reason;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    reason = acquire(lock);
  } catch (_) {
    reason = 'unavailable';
  }

  const locked = reason === 'acquired';
  const region = { count: 1, locked, reason };
  regions.set(lock, region);
  try {
    return { value: fn(), locked, reason };
  } finally {
    region.count -= 1;
    // Deleted rather than left at zero, so a later independent call starts from
    // nothing instead of reading a spent region's answer.
    if (region.count === 0) {
      regions.delete(lock);
      if (locked) release(lock);
    }
  }
}

// Say that a write went ahead without the lock, at the moment it does.
//
// Called by the writer rather than by the region, because only the writer knows
// a write happened. Once per region: one write is one warning, however many
// nested calls contributed to it.
//
// Silent when the region holds the lock, obviously, and silent for
// 'unavailable' too. That one means no lock could be created at all, usually a
// directory that is not writable, in which case the index write is about to
// fail and `indexWritten: false` reports it properly. Two messages for one
// failure, one of them speculative, is worse than one.
function warnUnprotectedWrite(lock) {
  const region = regions.get(lock);
  if (!region || region.reason !== 'busy' || region.warned) return false;
  region.warned = true;
  process.stderr.write(
    `session: wrote the handoff index without the lock at ${lock}, after waiting ${WAIT_MS}ms. `
    + 'Another session was writing at the same time, so an entry may have been lost.\n',
  );
  return true;
}

module.exports = {
  withIndexLock,
  warnUnprotectedWrite,
  WAIT_MS,
  STALE_MS,
  // Exported for the tests, which need to drive contention deterministically
  // rather than by racing real processes and hoping.
  OWNER,
  acquire,
  release,
};
