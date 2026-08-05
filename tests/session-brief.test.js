#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const brief = require(path.join(__dirname, '..', 'plugins', 'session', 'scripts', 'build-loop-brief.js'));

let ran = 0;
let failed = 0;
function check(name, fn) {
  ran += 1;
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (error) { failed += 1; process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`); }
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-brief-'));
}

function stateDir(home, name) {
  const dir = path.join(home, '.claude', 'build-loop', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

check('absent build-loop state stays silent', () => {
  assert.strictEqual(brief.buildBrief({ home: tempHome() }), '');
});

check('the queue reports active primary work and dependency reviews separately', () => {
  const home = tempHome();
  const dir = stateDir(home, 'queue');
  writeJson(path.join(dir, '1.json'), { status: 'Open', type: 'primary', target: 'first-hook' });
  writeJson(path.join(dir, '2.json'), { status: 'fix applied, watching', type: 'primary', target: 'second-script' });
  writeJson(path.join(dir, '3.json'), { status: 'Open', type: 'dep-review', target: 'dependent' });
  writeJson(path.join(dir, '4.json'), { status: 'Resolved', type: 'primary', target: 'finished' });
  writeJson(path.join(dir, '5.json'), { status: "Won't Fix", type: 'primary', target: 'declined' });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');

  const out = brief.buildBrief({ home });
  assert.match(out, /Bug queue: 2 active: first-hook, second-script; 1 dependency review\./);
  assert.doesNotMatch(out, /finished|declined|dependent/);
});

check('the to-build count includes open and in-progress items only', () => {
  const home = tempHome();
  const dir = stateDir(home, 'to-build');
  writeJson(path.join(dir, '1.json'), { status: 'Open' });
  writeJson(path.join(dir, '2.json'), { status: 'In Progress' });
  writeJson(path.join(dir, '3.json'), { status: 'Built' });

  assert.match(brief.buildBrief({ home }), /To build: 2 active \(1 in progress\)\./);
});

check('the lexically latest weekly summary is included and bounded', () => {
  const home = tempHome();
  const dir = stateDir(home, 'summaries');
  fs.writeFileSync(path.join(dir, '2026-30.md'), 'old');
  fs.writeFileSync(path.join(dir, '2026-31.md'), 'x'.repeat(brief.SUMMARY_LIMIT + 100));

  const out = brief.buildBrief({ home });
  assert.match(out, /Latest weekly summary \(2026-31\.md\):/);
  assert.doesNotMatch(out, /old/);
  assert.ok(out.length < brief.SUMMARY_LIMIT + 100, `summary was not clipped: ${out.length}`);
  assert.ok(out.endsWith('\u2026'));
});

check('DEPS reports missing and files changed since their record', () => {
  const home = tempHome();
  const root = path.join(home, '.claude', 'build-loop');
  fs.mkdirSync(root, { recursive: true });
  const changed = path.join(home, 'changed.js');
  const current = path.join(home, 'current.js');
  fs.writeFileSync(changed, 'changed');
  fs.writeFileSync(current, 'current');
  writeJson(path.join(root, 'DEPS.json'), { targets: {
    changed: { path: '~/changed.js', last_updated: '2000-01-01T00:00:00Z' },
    current: { path: '~/current.js', last_updated: '2999-01-01T00:00:00Z' },
    missing: { path: '~/missing.js', last_updated: '2000-01-01T00:00:00Z' },
  } });

  const out = brief.buildBrief({ home });
  assert.match(out, /DEPS\.json drift warning: 1 missing, 1 changed\./);
  assert.match(out, /\/audit-deps/);
});

check('an exhausted deadline is described as incomplete, not clean', () => {
  const home = tempHome();
  const root = path.join(home, '.claude', 'build-loop');
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'DEPS.json'), { targets: { one: { path: '~/one' } } });
  assert.match(brief.buildBrief({ home, deadline: 0 }), /check incomplete/);
});

check('the combined hook context never exceeds 10000 characters', () => {
  const out = brief.joinContext(['date', 'x'.repeat(20000)]);
  assert.strictEqual(out.length, brief.CONTEXT_LIMIT);
  assert.ok(out.endsWith('\u2026'));
});

process.stdout.write(`\n${ran} checks, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;
