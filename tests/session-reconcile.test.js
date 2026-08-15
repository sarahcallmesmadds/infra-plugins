#!/usr/bin/env node
// Regression tests for `cli.js reconcile`, which reads the handoffs folder back
// against the index.
//
// Run: node tests/session-reconcile.test.js
//
// Everything here drives `cli.js` as a subprocess and asserts on the bytes it
// printed. That is the standing rule in this repository and it was earned: every
// bug shipped so far lived in a printing path no test executed, because the
// detector underneath was tested directly and the command that reports it was
// not.
//
// The finding this command exists for is `shadowed`, and it is worth stating
// what it is, because the bug was filed as something else. A central document
// with no index entry is still found by name: the search order looks in the
// handoffs folder for `HANDOFF-<slug>.md` before it needs the index at all. So
// an unlisted document is untidy. An entry pointing at a *different* document
// that does exist is not untidy: `findHandoff` consults the index first and
// returns it, so `/pickup <slug>` opens the wrong handoff and says nothing. The
// first check below pins that difference, because getting it backwards is what
// sent the original repair at the mild half of the problem.

'use strict';

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'plugins', 'session');
const CLI = path.join(ROOT, 'scripts', 'cli.js');

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'session-rec-'));
const handoffDir = (home) => path.join(home, '.planning', 'handoffs');
const indexFile = (home) => path.join(handoffDir(home), 'index.json');

function cli(home, args) {
  return spawnSync(process.execPath, [CLI, ...args, '--home', home], { encoding: 'utf8' });
}

function json(home, args) {
  const r = cli(home, [...args, '--json']);
  assert.strictEqual(r.status, 0, `cli exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// A folder with the documents named, and an index holding exactly `entries`.
function fixture(home, { docs = [], archived = [], entries = {}, elsewhere = [] } = {}) {
  fs.mkdirSync(handoffDir(home), { recursive: true });
  for (const slug of docs) {
    fs.writeFileSync(path.join(handoffDir(home), `HANDOFF-${slug}.md`), `# ${slug}\n`);
  }
  if (archived.length) {
    fs.mkdirSync(path.join(handoffDir(home), 'archived'), { recursive: true });
    for (const slug of archived) {
      fs.writeFileSync(path.join(handoffDir(home), 'archived', `HANDOFF-${slug}.md`), `# ${slug}\n`);
    }
  }
  for (const rel of elsewhere) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '# elsewhere\n');
  }
  fs.writeFileSync(indexFile(home), `${JSON.stringify({ version: 1, handoffs: entries }, null, 2)}\n`);
}

const entry = (p, kind = 'central') => ({
  path: p, kind, recorded_at: '2026-01-01T00:00:00.000Z',
});

// ------------------------------------------------------------ shadowed ----

// The one finding that makes a lookup lie, and the reason this command leads
// with it rather than with the count of unlisted documents.
check('an entry pointing at another real document is reported as a wrong answer', () => {
  const home = tmpHome();
  fixture(home, {
    docs: ['alpha'],
    elsewhere: ['work/HANDOFF.md'],
    entries: { alpha: entry(path.join(home, 'work', 'HANDOFF.md'), 'project') },
  });

  const out = json(home, ['reconcile']);
  assert.strictEqual(out.shadowed.length, 1, 'the shadowed entry is found');
  assert.strictEqual(out.shadowed[0].slug, 'alpha');
  assert.strictEqual(out.shadowed[0].doc, path.join(handoffDir(home), 'HANDOFF-alpha.md'));
  assert.strictEqual(out.shadowed[0].recorded, path.join(home, 'work', 'HANDOFF.md'));
  assert.strictEqual(out.unlisted.length, 0, 'it is not also counted as unlisted');
});

// The premise the whole report is ordered by. If this ever stops being true,
// `unlisted` becomes the severe finding and the report is in the wrong order.
check('an unlisted central document is still found by name, so it is the mild finding', () => {
  const home = tmpHome();
  fixture(home, { docs: ['beta'], entries: {} });

  const found = json(home, ['find', 'beta']);
  assert.ok(found.match, 'a document with no index entry is still findable');
  assert.strictEqual(found.match.path, path.join(handoffDir(home), 'HANDOFF-beta.md'));

  const out = json(home, ['reconcile']);
  assert.strictEqual(out.unlisted.length, 1);
  assert.strictEqual(out.shadowed.length, 0, 'an absent entry is never a wrong answer');
});

// Written from the failure rather than alongside the fix. Before the shadowing
// was understood, `find` on this slug returned the recorded document and the
// report said nothing at all.
check('the shadowed slug really does resolve to the wrong document', () => {
  const home = tmpHome();
  fixture(home, {
    docs: ['gamma'],
    elsewhere: ['work/HANDOFF.md'],
    entries: { gamma: entry(path.join(home, 'work', 'HANDOFF.md'), 'project') },
  });
  const found = json(home, ['find', 'gamma']);
  assert.strictEqual(found.match.path, path.join(home, 'work', 'HANDOFF.md'),
    'the index wins over the correctly named document, which is the whole finding');
});

// A suggestion that cannot be accepted is worse than none, so the remedy is run
// rather than string-matched.
check('the remedy printed for a shadowed slug works when it is followed', () => {
  const home = tmpHome();
  fixture(home, {
    docs: ['delta'],
    elsewhere: ['work/HANDOFF.md'],
    entries: { delta: entry(path.join(home, 'work', 'HANDOFF.md'), 'project') },
  });

  const report = cli(home, ['reconcile']).stdout;
  const suggested = /cli\.js forget (\S+)/.exec(report);
  assert.ok(suggested, `the report names a remedy:\n${report}`);

  const r = cli(home, ['forget', suggested[1]]);
  assert.strictEqual(r.status, 0, r.stderr);

  const found = json(home, ['find', 'delta']);
  assert.strictEqual(found.match.path, path.join(handoffDir(home), 'HANDOFF-delta.md'),
    'after the suggested command, the slug resolves to the document beside it');
});

// ----------------------------------------------------------- duplicates ----

check('two slugs recorded against one document are reported together', () => {
  const home = tmpHome();
  const doc = path.join(handoffDir(home), 'HANDOFF-eps.md');
  fixture(home, { docs: ['eps'], entries: { eps: entry(doc), 'eps-old': entry(doc) } });

  const out = json(home, ['reconcile']);
  assert.strictEqual(out.duplicates.length, 1);
  assert.deepStrictEqual(out.duplicates[0].slugs, ['eps', 'eps-old'],
    'both slugs are named, sorted, so the report is stable');
});

// ---------------------------------------------------------- superseded ----

// Not grouped with `shadowed`, and the distinction is behavioural rather than
// cosmetic: a recorded path that resolves to nothing is skipped by the lookup,
// which then reaches the document through the search order. The answer is
// already right and only the entry is wrong.
check('an entry pointing at nothing is separated from one pointing at something', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  fixture(home, {
    docs: ['zeta'],
    entries: { zeta: entry(path.join(home, 'work', 'NOPE.md'), 'project') },
  });

  const out = json(home, ['reconcile']);
  assert.strictEqual(out.superseded.length, 1);
  assert.strictEqual(out.shadowed.length, 0);

  const found = json(home, ['find', 'zeta']);
  assert.strictEqual(found.match.path, path.join(handoffDir(home), 'HANDOFF-zeta.md'),
    'the lookup already gives the right answer, which is why this is the mild category');
});

// ----------------------------------------------------------------- fix ----

check('--fix records an entry for every document that had none', () => {
  const home = tmpHome();
  fixture(home, { docs: ['one', 'two'], archived: ['three'], entries: {} });

  const out = json(home, ['reconcile', '--fix']);
  assert.strictEqual(out.recorded.length, 3);
  assert.strictEqual(out.written, true);

  const index = JSON.parse(fs.readFileSync(indexFile(home), 'utf8')).handoffs;
  assert.deepStrictEqual(Object.keys(index).sort(), ['one', 'three', 'two']);
  assert.strictEqual(index.three.kind, 'archived',
    'a document in archived/ is recorded as archived, so pickup can say so');
  assert.strictEqual(index.one.kind, 'central');

  const after = json(home, ['reconcile']);
  assert.strictEqual(after.unlisted.length, 0, 'running it again finds nothing left to do');
});

// The repair adds and never resolves. Which of two documents is the real one is
// a decision, and a command that guesses it is a command that can lose a
// handoff.
check('--fix leaves shadowed and duplicated entries exactly as it found them', () => {
  const home = tmpHome();
  const doc = path.join(handoffDir(home), 'HANDOFF-eta.md');
  fixture(home, {
    docs: ['eta', 'theta'],
    elsewhere: ['work/HANDOFF.md'],
    entries: {
      eta: entry(path.join(home, 'work', 'HANDOFF.md'), 'project'),
      'eta-old': entry(doc),
    },
  });
  const before = fs.readFileSync(indexFile(home), 'utf8');

  const out = json(home, ['reconcile', '--fix']);
  assert.strictEqual(out.recorded.length, 1, 'only the unlisted document is recorded');
  assert.strictEqual(out.recorded[0].slug, 'theta');

  const index = JSON.parse(fs.readFileSync(indexFile(home), 'utf8')).handoffs;
  assert.strictEqual(index.eta.path, path.join(home, 'work', 'HANDOFF.md'),
    'the shadowing entry is untouched');
  assert.strictEqual(index['eta-old'].path, doc, 'the duplicate is untouched');
  assert.notStrictEqual(before, fs.readFileSync(indexFile(home), 'utf8'),
    'and the file was in fact rewritten, so the assertions above mean something');

  const still = json(home, ['reconcile']);
  assert.strictEqual(still.shadowed.length, 1, 'the wrong answer is still reported afterwards');
});

// --------------------------------------------------------- the report ----

check('a folder that agrees with its index says so, and says what it checked', () => {
  const home = tmpHome();
  fixture(home, {
    docs: ['iota'],
    entries: { iota: entry(path.join(handoffDir(home), 'HANDOFF-iota.md')) },
  });

  const out = cli(home, ['reconcile']).stdout;
  assert.match(out, /The index and the folder agree\./);
  assert.match(out, /Checked 1 HANDOFF-\*\.md document/,
    'the count of what was looked at is printed, so a clean result can be weighed');
  assert.match(out, /Not checked: pause documents/,
    'and what was not looked at, because a clean result looks identical either way');
});

// The create-nothing rule, which this command has to honour like every other
// read: taking the lock means creating the handoffs folder, so a command that
// changes nothing must not leave one behind.
check('reconcile on a machine with no handoffs folder creates nothing', () => {
  const home = tmpHome();
  const r = cli(home, ['reconcile']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(handoffDir(home)),
    'looking at an empty machine must not put a handoffs folder on it');
});

check('--fix on a machine with no handoffs folder also creates nothing', () => {
  const home = tmpHome();
  const r = cli(home, ['reconcile', '--fix']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(handoffDir(home)),
    'there is nothing to record, so there is nothing to create');
});

// ---------------------------------------------------------- contention ----

// The repair reads the folder outside the lock and writes inside it, so a wrap
// landing in that gap is the exact shape of the race this whole subsystem was
// changed to close. The re-check inside the region is what stops it, and this
// is the check that would notice if it were removed.
const LAUNCHER = `
  const { spawn } = require('child_process');
  const snippets = JSON.parse(process.argv[1]);
  let done = 0;
  for (const code of snippets) {
    const p = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('exit', () => { if (++done === snippets.length) process.exit(0); });
  }
`;

check('a wrap recording beside --fix loses neither entry', () => {
  const home = tmpHome();
  const docs = [];
  for (let i = 0; i < 8; i += 1) docs.push(`doc-${i}`);
  fixture(home, { docs, entries: {} });

  const snippets = [
    `require('child_process').spawnSync(process.execPath, `
      + `[${JSON.stringify(CLI)}, 'reconcile', '--fix', '--home', ${JSON.stringify(home)}, '--json']);`,
  ];
  for (let i = 0; i < 6; i += 1) {
    const repo = path.join(home, 'code', `repo-${i}`);
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    snippets.push(`require('child_process').spawnSync(process.execPath, `
      + `[${JSON.stringify(CLI)}, 'target', 'topic-${i}', '--cwd', ${JSON.stringify(repo)}, `
      + `'--home', ${JSON.stringify(home)}, '--json']);`);
  }
  execFileSync(process.execPath, ['-e', LAUNCHER, JSON.stringify(snippets)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const index = JSON.parse(fs.readFileSync(indexFile(home), 'utf8')).handoffs;
  const missingWraps = [];
  for (let i = 0; i < 6; i += 1) if (!index[`repo-${i}`]) missingWraps.push(`repo-${i}`);
  assert.deepStrictEqual(missingWraps, [], 'every concurrent wrap survived the repair');

  const missingDocs = docs.filter((d) => !index[d]);
  assert.deepStrictEqual(missingDocs, [], 'and every document the repair recorded survived the wraps');
});

// The check above proves no wrap is lost. It does not prove anything about the
// re-check inside the region, because the documents it repairs and the slugs the
// wraps record never collide, so the line that skips an already-recorded slug is
// never reached. Removing that line left it passing, which is the exact shape
// this repository keeps catching in itself: a check that cannot fail against the
// broken version.
//
// The collision has to be arranged rather than hoped for. One process takes the
// lock, writes the contested slug and holds the region open; `reconcile --fix`
// starts just after, does its scan unlocked and so still sees the document as
// unlisted, then blocks on the lock. By the time it gets in, the slug it was
// about to record belongs to somebody else, and the re-check is the only thing
// that stops it being overwritten.
check('--fix does not overwrite a slug that was recorded while it was waiting', () => {
  const home = tmpHome();
  fixture(home, { docs: ['contested'], entries: {} });
  const theirs = path.join(home, 'code', 'contested', 'HANDOFF.md');
  fs.mkdirSync(path.dirname(theirs), { recursive: true });
  fs.writeFileSync(theirs, '# theirs\n');
  const out = path.join(home, 'fix-output.json');

  const sleep = (ms) => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});`;

  const holder = `
    const h = require(${JSON.stringify(path.join(ROOT, 'scripts', 'handoffs.js'))});
    h.mutateIndex(${JSON.stringify(home)}, (map, save) => {
      map['contested'] = { path: ${JSON.stringify(theirs)}, kind: 'project',
        recorded_at: new Date().toISOString() };
      ${sleep(1500)}
      return save(map);
    });
  `;
  const repairer = `
    ${sleep(200)}
    const r = require('child_process').spawnSync(process.execPath,
      [${JSON.stringify(CLI)}, 'reconcile', '--fix', '--home', ${JSON.stringify(home)}, '--json'],
      { encoding: 'utf8' });
    require('fs').writeFileSync(${JSON.stringify(out)}, r.stdout);
  `;

  execFileSync(process.execPath, ['-e', LAUNCHER, JSON.stringify([holder, repairer])],
    { stdio: ['ignore', 'pipe', 'pipe'] });

  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(result.unlisted.some((u) => u.slug === 'contested'),
    'the scan saw the document as unlisted, so the window this check needs was open');
  assert.ok(!result.recorded.some((r) => r.slug === 'contested'),
    'and it did not record it anyway, because somebody else got there first');

  const index = JSON.parse(fs.readFileSync(indexFile(home), 'utf8')).handoffs;
  assert.strictEqual(index.contested.path, theirs,
    'the entry that was already there is the one that survived');
});

process.stdout.write(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
