#!/usr/bin/env node
// What a closed entry says happened to it.
//
// Run: node tests/resolution.test.js
//
// Two halves. The reader has to take every shape this field has ever had,
// including the three found in the real queue, because nothing rewrites those
// and a reader that only knows the new one reports twelve closed entries as
// having no outcome. The writer has to refuse a shape that cannot be read
// back, at the one gate, so a new route cannot skip it.
//
// The real-queue shapes are pinned here as literals rather than read off the
// machine. A test that reads ~/.claude passes or fails on what happens to be
// on somebody's disk, and these have to keep working after those entries are
// long gone.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'build-loop');
const QUEUE_JS = path.join(PLUGIN, 'scripts', 'queue.js');
const { normalise, problemsWith, OUTCOMES } = require(path.join(PLUGIN, 'scripts', 'resolution.js'));

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

// --- the three shapes in the real queue ------------------------------------

const REAL_SHAPES = [
  {
    what: 'a Resolved primary, written before outcomes existed',
    stored: {
      commit: 'a74c489d63b8c40b7284ebb7ba9da177a1f4d59d',
      fixed_at: '2026-08-02',
      pr: 'https://github.com/sarahcallmesmadds/plugins/pull/41',
      shipped_in: '0.4.1',
      summary: 'unanchored build output, dropped the substring match',
    },
    status: 'Resolved',
    expect: { outcome: 'fix_applied', at: '2026-08-02', commit: 'a74c489d63b8c40b7284ebb7ba9da177a1f4d59d' },
    keepsExtra: ['pr', 'shipped_in'],
  },
  {
    what: 'a Resolved dep-review',
    stored: {
      ts: '2026-08-02T05:31:13.000Z',
      outcome: 'no change needed',
      commit: '301c738',
      why: 'The guard reads config through loadConfig, which is unchanged.',
    },
    expect: { outcome: 'no_change_needed', at: '2026-08-02T05:31:13.000Z', commit: '301c738' },
    keepsExtra: [],
  },
  {
    what: "a Won't Fix primary",
    stored: {
      ts: '2026-08-01T20:30:00.000Z',
      outcome: 'wontfix',
      why: 'The target is dead code and is not on this machine.',
    },
    expect: { outcome: 'wont_fix', at: '2026-08-01T20:30:00.000Z', commit: null },
    keepsExtra: [],
  },
];

for (const shape of REAL_SHAPES) {
  check(`reads ${shape.what}`, () => {
    const got = normalise(shape.stored, { status: shape.status });
    for (const [key, want] of Object.entries(shape.expect)) {
      assert.strictEqual(got[key], want, `${key}: expected ${want}, got ${got[key]}`);
    }
    assert.ok(got.summary && got.summary.length > 0, 'lost the summary');
    for (const key of shape.keepsExtra) {
      assert.ok(key in got.extra, `dropped ${key}, which nothing else records`);
    }
  });
}

check('a summary is read from either name it was written under', () => {
  assert.strictEqual(normalise({ why: 'x', at: 'now', outcome: 'obsolete' }).summary, 'x');
  assert.strictEqual(normalise({ summary: 'y', at: 'now', outcome: 'obsolete' }).summary, 'y');
});

check('the string the old schema described reads as a summary', () => {
  // No entry on disk has one, but the field was documented as a string until
  // now, so the docs invited it. It is a summary with no outcome, not a fault.
  const got = normalise('the guard now reads the event cwd');
  assert.strictEqual(got.summary, 'the guard now reads the event cwd');
  assert.strictEqual(got.outcome, null);
});

check('null and nonsense read as nothing rather than throwing', () => {
  for (const input of [null, undefined, '', '   ', 42, [], true]) {
    assert.strictEqual(normalise(input), null, `${JSON.stringify(input)} did not read as nothing`);
  }
});

check('an outcome nobody can read is not replaced by an inferred one', () => {
  // The inference exists for the twelve legacy entries that carry no outcome
  // at all. It used to fire whenever the outcome could not be *resolved*,
  // which is a different thing, so a deliberate `"reverted"` alongside a
  // commit came back as `fix_applied`. That is not a lossy reading of
  // "reverted", it is the opposite of it, and a typo or a cased variant went
  // the same way in silence.
  for (const stated of ['reverted', 'Fix_Applied', 'fix-applied', 'partially done']) {
    const got = normalise({ outcome: stated, commit: 'abc1234', at: 'now', summary: 's' });
    assert.strictEqual(got.outcome, null, `"${stated}" was rewritten as ${got.outcome}`);
  }
});

check('the inference still fires when the field is genuinely empty', () => {
  // The other half. Gating it too tightly would break the twelve legacy
  // entries this exists for, so both directions are pinned together.
  for (const stated of [undefined, '', '   ']) {
    const r = { commit: 'abc1234', fixed_at: '2026-08-02', summary: 's' };
    if (stated !== undefined) r.outcome = stated;
    const got = normalise(r, { status: 'Resolved' }).outcome;
    assert.strictEqual(got, 'fix_applied', `${JSON.stringify(stated)} lost the inference`);
  }
});

check('an outcome that was stated and cannot be read is kept, not dropped', () => {
  // Returning null is the right answer to "which of the five is this". It is
  // not an answer to "what did somebody write", and the first version lost
  // that entirely, so a deliberate "reverted" came back indistinguishable
  // from an entry closed with no outcome at all.
  const got = normalise({ outcome: 'reverted', at: 'now', summary: 's', commit: 'abc1234' });
  assert.strictEqual(got.outcome, null, 'invented an enum value');
  assert.strictEqual(got.extra.outcome, 'reverted', 'the stated outcome vanished');
});

check('the inference needs the status, and does not guess without it', () => {
  // Its justification has always been "those twelve are Resolved primaries
  // carrying a commit". The function could not see a status, so what it
  // actually did was infer from a commit alone, and a Won't Fix entry
  // recording the commit it was rolled back by read as a fix.
  const legacy = { commit: 'abc1234', fixed_at: '2026-08-05', summary: 'Declined after rollback' };
  assert.strictEqual(normalise(legacy, { status: "Won't Fix" }).outcome, null, 'called a rollback a fix');
  assert.strictEqual(normalise(legacy).outcome, null, 'guessed with no status to go on');
  assert.strictEqual(normalise(legacy, { status: 'Resolved' }).outcome, 'fix_applied');
});

check('a closed entry with no commit and no outcome stays unknown', () => {
  // The only inference here is commit-plus-Resolved meaning fix_applied.
  // Without a commit there is nothing to infer from, and "closed, cannot say
  // why" is a real answer that guessing would hide.
  assert.strictEqual(normalise({ at: '2026-08-02', summary: 'closed' }).outcome, null);
});

// --- what the gate refuses -------------------------------------------------

check('every outcome in the enum is accepted', () => {
  for (const outcome of OUTCOMES.keys()) {
    const r = { outcome, at: '2026-08-05T12:00:00.000Z', summary: 's' };
    if (outcome === 'duplicate') r.duplicate_of = '2026-01-01T00-00-00-other';
    assert.deepStrictEqual(problemsWith(r), [], `${outcome} was refused`);
  }
});

// The two functions are separate and nothing forces them to agree. These are
// the values that passed the gate and then read back as null, so the write was
// accepted and the value was gone. The duplicate one is the worse: the link is
// the entire reason that outcome exists.
const TYPE_MISMATCHES = [
  ['a numeric duplicate_of', { outcome: 'duplicate', at: 'now', summary: 's', duplicate_of: 42 }, 'duplicate_of'],
  ['a boolean commit', { outcome: 'fix_applied', at: 'now', summary: 's', commit: true }, 'commit'],
  ['an object commit', { outcome: 'fix_applied', at: 'now', summary: 's', commit: { sha: 'x' } }, 'commit'],
  ['a numeric by', { outcome: 'obsolete', at: 'now', summary: 's', by: 7 }, 'by'],
];

for (const [what, value, field] of TYPE_MISMATCHES) {
  check(`the writer refuses what the reader would drop: ${what}`, () => {
    const problems = problemsWith(value);
    assert.ok(problems.length > 0, 'accepted a value that reads back as null');
    assert.ok(problems.some((p) => p.includes(field)), `refused, but not about ${field}: ${problems.join('; ')}`);
    assert.strictEqual(normalise(value)[field], null, 'the reader kept it after all, so this test is stale');
  });
}

const REFUSED = [
  ['no outcome', { at: 'now', summary: 's' }, /no outcome/],
  ['an invented outcome', { outcome: 'fixed', at: 'now', summary: 's' }, /not one of/],
  ['an old spelling', { outcome: 'wontfix', at: 'now', summary: 's' }, /old spelling/],
  ['no timestamp', { outcome: 'obsolete', summary: 's' }, /at.*timestamp/],
  ['no summary', { outcome: 'obsolete', at: 'now' }, /summary/],
  ['a duplicate naming nothing', { outcome: 'duplicate', at: 'now', summary: 's' }, /duplicate_of/],
  ['duplicate_of on another outcome', { outcome: 'obsolete', at: 'now', summary: 's', duplicate_of: 'x' }, /duplicate_of is set/],
  ['an array', ['x'], /an array/],
  ['a bare string on write', 'just words', /object/],
];

for (const [what, value, pattern] of REFUSED) {
  check(`refuses ${what}`, () => {
    const problems = problemsWith(value);
    assert.ok(problems.length > 0, 'accepted it');
    assert.ok(
      problems.some((p) => pattern.test(p)),
      `refused for the wrong reason: ${problems.join('; ')}`
    );
  });
}

check('an old spelling is refused on write and still read', () => {
  // The pair that matters. Readers must keep taking what is on disk while
  // writers are pushed to the new vocabulary, and testing only one half would
  // let the other break silently.
  assert.ok(problemsWith({ outcome: 'no change needed', at: 'now', summary: 's' }).length > 0);
  assert.strictEqual(normalise({ outcome: 'no change needed', at: 'now', why: 's' }).outcome, 'no_change_needed');
});

// --- the gate, through the command line ------------------------------------
//
// Everything above calls the checker directly. These go through queue.js,
// because the check being right and the check being reached are different
// claims, and this repository has already shipped a guard that was never
// reached.

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resolution-'));
  fs.mkdirSync(path.join(home, '.claude', 'build-loop', 'queue'), { recursive: true });
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function queueDir(home) {
  return path.join(home, '.claude', 'build-loop', 'queue');
}

function seed(home, id, resolution) {
  const entry = {
    $schema_version: 5, id, created_at: '2026-08-01T00:00:00.000Z', status: 'Open',
    type: 'primary', parent_id: null, target: 't', target_kind: 'skill',
    target_path: '/tmp/t', repo: 'r', session_id: '', session_cwd: '',
    what_happened: 'x', what_expected: 'y', correct_example: 'z',
    source: 'manual', urgency_hint: 'normal', dedup_key: `t::${id}`, notes: [],
    resolution: resolution === undefined ? null : resolution,
  };
  fs.writeFileSync(path.join(queueDir(home), `${id}.json`), JSON.stringify(entry, null, 2));
}

function run(home, args) {
  return execFileSync(process.execPath, [QUEUE_JS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

function readBack(home, id) {
  return JSON.parse(fs.readFileSync(path.join(queueDir(home), `${id}.json`), 'utf8'));
}

check('the gate refuses a bad resolution through --resolution', () => {
  withHome((home) => {
    seed(home, 'a1');
    fs.writeFileSync(path.join(home, 'bad.json'), JSON.stringify({ outcome: 'fixed' }));
    assert.throws(
      () => run(home, ['update', 'a1', '--resolution', path.join(home, 'bad.json')]),
      /not one of/,
      'wrote an outcome nothing can read'
    );
    assert.strictEqual(readBack(home, 'a1').resolution, null, 'the entry changed anyway');
  });
});

check('the gate refuses it through --json too, which is the route that was missed before', () => {
  withHome((home) => {
    seed(home, 'a2');
    fs.writeFileSync(path.join(home, 'bad.json'), JSON.stringify({ outcome: 'duplicate', at: 'now', summary: 's' }));
    assert.throws(
      () => run(home, ['update', 'a2', '--json', `resolution=${path.join(home, 'bad.json')}`]),
      /duplicate_of/,
      'a duplicate naming nothing got through --json'
    );
  });
});

check('a good resolution goes in', () => {
  withHome((home) => {
    seed(home, 'a3');
    fs.writeFileSync(path.join(home, 'ok.json'), JSON.stringify({
      outcome: 'fix_applied', at: '2026-08-05T12:00:00.000Z',
      summary: 'the guard reads the event cwd', commit: 'abc1234', by: 'user',
    }));
    run(home, ['update', 'a3', '--status', 'Resolved', '--resolution', path.join(home, 'ok.json')]);
    const after = readBack(home, 'a3');
    assert.strictEqual(after.resolution.outcome, 'fix_applied');
    assert.strictEqual(after.status, 'Resolved');
  });
});

check('the gate refuses to erase a resolution', () => {
  // Clearing one is not an edit, it is a deletion, and it succeeded in
  // silence: there is nothing for the shape check to object to in `null`, so a
  // resolution file holding it replaced a complete record of outcome,
  // timestamp, summary and commit with nothing, and left the status saying
  // Resolved. This queue never deletes an entry, and the same reasoning
  // applies one level down.
  withHome((home) => {
    const kept = {
      outcome: 'fix_applied', at: '2026-08-05T12:00:00.000Z',
      summary: 'the guard reads the event cwd', commit: 'abc1234',
    };
    seed(home, 'a5', kept);
    fs.writeFileSync(path.join(home, 'null.json'), 'null');
    assert.throws(
      () => run(home, ['update', 'a5', '--resolution', path.join(home, 'null.json')]),
      /erase the resolution/,
      'erased a closed entry\'s record'
    );
    assert.deepStrictEqual(readBack(home, 'a5').resolution, kept, 'the record changed anyway');
  });
});

check('a resolution can still be replaced by a better one', () => {
  // The other side of the refusal above. Refusing to erase must not turn into
  // refusing to correct.
  withHome((home) => {
    seed(home, 'a6', { outcome: 'obsolete', at: '2026-08-01T00:00:00.000Z', summary: 'wrong call' });
    fs.writeFileSync(path.join(home, 'better.json'), JSON.stringify({
      outcome: 'wont_fix', at: '2026-08-05T12:00:00.000Z', summary: 'declined on purpose',
    }));
    run(home, ['update', 'a6', '--resolution', path.join(home, 'better.json')]);
    assert.strictEqual(readBack(home, 'a6').resolution.outcome, 'wont_fix');
  });
});

check('the same legacy value in a different key order is not a change', () => {
  // JSON.stringify is order-sensitive, so handing back an untouched legacy
  // resolution with its keys reordered read as a change, which then validated
  // it under the new rules and refused it. The entry had not changed and could
  // not be written.
  withHome((home) => {
    seed(home, 'a7', { ts: '2026-08-01T20:30:00.000Z', outcome: 'wontfix', why: 'dead code' });
    fs.writeFileSync(path.join(home, 'same.json'), JSON.stringify({
      outcome: 'wontfix', why: 'dead code', ts: '2026-08-01T20:30:00.000Z',
    }));
    run(home, ['update', 'a7', '--note', 'checked again', '--resolution', path.join(home, 'same.json')]);
    const after = readBack(home, 'a7');
    assert.strictEqual(after.notes.length, 1, 'the note was refused over a reordering');
    assert.strictEqual(after.resolution.outcome, 'wontfix');
  });
});

check('an entry already carrying a legacy resolution can still be annotated', () => {
  // The trap the status gate fell into once: validating everything on every
  // write locked the entries most in need of a note out of receiving one.
  // Nineteen real entries predate this check.
  withHome((home) => {
    seed(home, 'a4', { ts: '2026-08-01T20:30:00.000Z', outcome: 'wontfix', why: 'dead code' });
    run(home, ['update', 'a4', '--note', 'still true a month later']);
    const after = readBack(home, 'a4');
    assert.strictEqual(after.notes.length, 1, 'the note was refused');
    assert.strictEqual(after.resolution.outcome, 'wontfix', 'the old resolution was rewritten');
  });
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
