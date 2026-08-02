#!/usr/bin/env node
// No skill may write a queue entry by hand. Every change goes through
// scripts/queue.js.
//
// Run: node tests/queue-writes.test.js
//
// What this file used to check, and why it changed. The original bug was
// /apply-fix silently dropping notes: it recomposed the entry from scratch, so
// a note recording an abandoned attempt disappeared. The fix at the time was
// wording. Every updater was made to say "read the current entry" and "append
// to notes", and this file asserted those sentences were present, including
// catching the parentheticals that had quietly cancelled them.
//
// That was the best answer available while the writing was done by a model
// following prose, and it was never a guarantee. Reading the entry in one tool
// call and writing it in another leaves a gap, and another session writing into
// that gap loses its change with no error and nothing to notice. No wording
// closes that, because the gap is between the tool calls rather than inside one.
//
// So the read, the change and the write now happen inside queue.js, holding a
// lock, and the property this file protects is enforced by that code rather than
// by sentences. What is left to check here is that nothing has gone back to
// doing it by hand, which is a smaller thing and a much harder one to get wrong
// by accident.
//
// The behaviour itself, that a note survives a concurrent write, is tested for
// real in queue-locking.test.js by racing processes. This file is the source
// assertion that the skills actually call the thing that behaves.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SKILLS = path.join(__dirname, '..', 'plugins', 'build-loop', 'skills');
const QUEUE_JS = path.join(__dirname, '..', 'plugins', 'build-loop', 'scripts', 'queue.js');

// Skills that change an entry that already exists.
const UPDATERS = ['apply-fix', 'verify-fix', 'revert-fix'];

// Skills that create entries. /flag-issue was deliberately absent from the old
// list, because it only ever wrote new files and there was nothing on disk to
// preserve. It belongs here now: creating is where the dedup race lived, and
// that was the half of the bug the note-preservation rule never covered.
const CREATORS = ['flag-issue', 'to-build'];

function skill(name) {
  const file = path.join(SKILLS, name, 'SKILL.md');
  assert.ok(fs.existsSync(file), `${name}/SKILL.md is missing`);
  return fs.readFileSync(file, 'utf8');
}

// The hand-rolled sequence, in every spelling it appeared in. Any of these in a
// skill means someone has reintroduced the gap.
// Both lists, not just the queue. to-build kept creating items with the Write
// tool after the queue had stopped, and these patterns only named `queue/`, so
// nothing saw it. The bug entry covered both lists and so does this.
const BY_HAND = [
  /(queue|to-build)\/\{id\}\.json\.tmp/,
  /(queue|to-build)\/\{filename\}`? using the Write tool/,
  /mv ~\/\.claude\/build-loop\/(queue|to-build)/,
  /Write the JSON with the Write tool/,
];

// A line describing the old sequence in order to say it was wrong is not an
// offence. The prose has to be able to name what it replaced.
const EXPLAINING = /used to|no longer|rather than|instead of|never edit|do not write it/i;

let failed = 0;
let ran = 0;
function check(what, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

for (const name of [...UPDATERS, ...CREATORS]) {
  check(`${name} does not write the queue by hand`, () => {
    const text = skill(name);
    for (const pattern of BY_HAND) {
      const offending = text.split('\n').filter((line) => pattern.test(line) && !EXPLAINING.test(line));
      assert.deepStrictEqual(
        offending, [],
        `${name} writes a queue entry directly:\n        ${offending.join('\n        ')}\n`
        + '        That reopens the gap between the read and the write, where another '
        + "session's change is lost with no error."
      );
    }
  });
}

for (const name of UPDATERS) {
  check(`${name} changes entries through queue.js update`, () => {
    assert.match(
      skill(name), /queue\.js"? update/,
      `${name} changes an existing entry and never calls "queue.js update", so it is doing it some other way.`
    );
  });
}

for (const name of CREATORS) {
  check(`${name} adds entries through queue.js create`, () => {
    assert.match(
      skill(name), /queue\.js"? create/,
      `${name} adds entries and never calls "queue.js create", so the dedup check and the write are separable again.`
    );
  });
}

// --- the guarantees the skills are relying on ----------------------------

check('queue.js appends to notes rather than taking an array from the caller', () => {
  // The structural version of the rule this file used to ask for in prose. A
  // caller cannot hand over a notes array at all, so it cannot hand over a
  // stale one, and a stale one is what made the original bug possible.
  const source = fs.readFileSync(QUEUE_JS, 'utf8');
  assert.match(source, /entry\.notes\.push\(/, 'queue.js no longer appends to the notes already on the entry');
  assert.ok(
    !/entry\.notes\s*=\s*(args|JSON)/.test(source),
    'queue.js assigns notes from something the caller passed, which is how a stale array gets back in'
  );
});

check('queue.js reads the entry inside the lock, not before it', () => {
  const source = fs.readFileSync(QUEUE_JS, 'utf8');
  assert.match(source, /function locked\(/, 'queue.js has no lock helper');
  assert.ok(
    /locked\(\(\) => \{[\s\S]{0,200}?readEntry\(id[,)]/.test(source),
    'the read happens outside the lock, which is the bug rather than the fix'
  );
});

check('the lock is released even when the write fails', () => {
  // Found by the tests rather than by review: failing with process.exit skipped
  // the finally, so one bad resolution file left the queue locked for everyone
  // until the lock went stale.
  const source = fs.readFileSync(QUEUE_JS, 'utf8');
  assert.match(source, /finally\s*\{\s*release\(\)/, 'queue.js does not release the lock in a finally');
  assert.ok(
    !/function fail\([\s\S]{0,200}?process\.exit/.test(source),
    'fail() exits the process, which skips the finally and leaves the lock behind'
  );
});

check('the dep-review dedup has no expiry', () => {
  // A parent and a dependent is one logical review forever. A ten-minute window
  // there would write a fresh duplicate on every run.
  assert.match(
    skill('flag-issue'), /--dedup-window all/,
    'flag-issue no longer asks for an unexpiring dedup window on dep-review entries'
  );
});

check('every skill that calls queue.js is allowed to run it', () => {
  // to-build was converted to call queue.js and its allowed-tools was not
  // updated, so the note it promised to write could never be written. A skill
  // that names a command it cannot run is broken in a way nothing else here
  // notices: the instruction reads correctly and fails at the moment of use.
  const dirs = fs.readdirSync(SKILLS).filter((d) => fs.existsSync(path.join(SKILLS, d, 'SKILL.md')));
  const offending = dirs.filter((name) => {
    const text = skill(name);
    if (!/queue\.js"? (update|create|show)/.test(text)) return false;
    const frontmatter = text.slice(0, text.indexOf('---', 4));
    return !/Bash\(node:\*\)/.test(frontmatter);
  });
  assert.deepStrictEqual(
    offending, [],
    `these call queue.js and do not grant Bash(node:*): ${offending.join(', ')}`
  );
});

check('no skill still claims it cannot run node', () => {
  // The sentence that used to justify the old arrangement outlived it in
  // to-build, sitting a few lines above an instruction to run node. A reader
  // could not tell which was authoritative.
  const dirs = fs.readdirSync(SKILLS).filter((d) => fs.existsSync(path.join(SKILLS, d, 'SKILL.md')));
  for (const name of dirs) {
    const offending = skill(name).split('\n').filter((line) =>
      /grants (no|neither) `?node/.test(line) && !EXPLAINING.test(line));
    assert.deepStrictEqual(offending, [], `${name} still says it cannot run node:\n        ${offending.join('\n        ')}`);
  }
});

check('no skill names the command in a form that cannot be run', () => {
  // Six inline mentions said `queue.js update ...` with no interpreter and no
  // path, while the fenced blocks in the same files used the full form. They sit
  // on the failure and cancellation branches, which are the least exercised and
  // the most expensive to lose: an entry that should go back to Open stays
  // parked in a status nobody looks at.
  const dirs = fs.readdirSync(SKILLS).filter((d) => fs.existsSync(path.join(SKILLS, d, 'SKILL.md')));
  for (const name of dirs) {
    const offending = skill(name).split('\n').filter((line) => /`queue\.js (update|create|show)/.test(line));
    assert.deepStrictEqual(
      offending, [],
      `${name} names queue.js without node and a path:\n        ${offending.join('\n        ')}\n`
      + '        Use: node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" ...'
    );
  }
});

check('free text reaches a note through a file, not a shell argument', () => {
  // A note carries a tool's error message, or retry instructions the user
  // typed. Interpolated into a quoted shell argument, a double quote or a
  // `$(...)` in that text ends or extends the argument, in a context where
  // Bash(node:*) is allowed. --note-file removes the shell from the path.
  const INTERPOLATED = /--note "[^"]*\{(error|retry|file_state)[^"]*"/;
  const dirs = fs.readdirSync(SKILLS).filter((d) => fs.existsSync(path.join(SKILLS, d, 'SKILL.md')));
  for (const name of dirs) {
    const offending = skill(name).split('\n').filter((line) => INTERPOLATED.test(line));
    assert.deepStrictEqual(
      offending, [],
      `${name} interpolates free text into a shell argument:\n        ${offending.join('\n        ')}\n`
      + '        Write it to a file and use --note-file.'
    );
  }
});

check('queue.js can take a note from a file', () => {
  const source = fs.readFileSync(QUEUE_JS, 'utf8');
  assert.match(source, /note-file/, 'queue.js has no --note-file, so the skills are calling something that does not exist');
});

check('the reference documents agree with the skills', () => {
  // The schemas are prose the skills tell the model to read, so a retired rule
  // left in one competes with the live rule in the other. Nothing here scanned
  // reference/ at all, so both files kept ordering the hand-rolled sequence
  // after every skill had stopped using it.
  // Skills are scanned as well as reference/. whats-breaking kept pointing at
  // flag-issue as "the one exception" long after flag-issue had stopped being
  // one, and a scan of reference/ alone could not see a stale cross-reference
  // living inside a SKILL.md.
  const ref = path.join(__dirname, '..', 'plugins', 'build-loop', 'reference');
  const docs = [
    ...fs.readdirSync(ref).filter((f) => f.endsWith('.md')).map((f) => [f, path.join(ref, f)]),
    ...fs.readdirSync(SKILLS).filter((d) => fs.existsSync(path.join(SKILLS, d, 'SKILL.md')))
      .map((d) => [`${d}/SKILL.md`, path.join(SKILLS, d, 'SKILL.md')]),
  ];
  for (const [file, full] of docs) {
    const text = fs.readFileSync(full, 'utf8');
    const offending = text.split('\n').filter((line) =>
      (/`?\.tmp`? (plus|\+) (node )?parse-check (plus|\+) `?mv`?/.test(line)
        || /the one exception is `?flag-issue/i.test(line))
      && !/used to|no longer|is not a queue entry/i.test(line));
    assert.deepStrictEqual(
      offending, [],
      `${file} still orders the hand-rolled sequence:\n        ${offending.join('\n        ')}`
    );
  }
});

check('the checks would catch one', () => {
  // A linter nobody has seen fail is a linter nobody should trust.
  const broken = '4. Write updated JSON to `~/.claude/build-loop/queue/{id}.json.tmp` using the Write tool.';
  assert.ok(BY_HAND.some((p) => p.test(broken)), 'BY_HAND no longer matches the sequence it names');
  assert.ok(!EXPLAINING.test(broken), 'the exemption for explanatory prose swallows a real offence');

  const explaining = 'This skill used to write entries to queue/{id}.json.tmp by hand.';
  assert.ok(EXPLAINING.test(explaining), 'prose explaining the old way is reported as an offence');
});

// Counted as they run and then compared. This line was once a formula that
// looked derived and was not, and it reported 10 while 13 ran.
const EXPECTED_CHECKS = 21;
if (ran !== EXPECTED_CHECKS) {
  failed += 1;
  console.log(
    '  FAIL  the file runs the number of checks it expects to\n'
    + `        ran ${ran}, expected ${EXPECTED_CHECKS}. If you added or removed a `
    + 'check, move EXPECTED_CHECKS. If you did not, one has gone missing.'
  );
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
