#!/usr/bin/env node
// The default roots are decided in roots.js and nowhere else.
//
// Run: node tests/roots-one-source.test.js
//
// The bug this pins: the same rule about which roots to read, and what the
// defaults are when there is no config file, was written out in six skills at
// six different lengths. It had already drifted. `find-skill` stated one default
// root where the other five stated three, and its copy was not prose but a
// second implementation in Python with its own DEFAULT list, so it could
// disagree with roots.js without anyone reading a difference.
//
// audit-deps is the reason this is a test and not a note. Its own text said "the
// same rule has to hold in every skill that reads this config, and six
// paragraphs drift where one script cannot", and that sentence sat directly
// beneath a copy of the default roots written out in full.
//
// Two of these checks would pass on an empty list, which is how a guard like
// this quietly stops guarding, so the list itself is asserted first.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'plugins', 'build-loop', 'skills');
const { DEFAULT_ROOTS } = require(path.join(ROOT, 'plugins', 'build-loop', 'scripts', 'roots.js'));

let total = 0;
let failed = 0;
function check(what, fn) {
  total += 1;
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

function skillFiles() {
  return fs.readdirSync(SKILLS_DIR)
    .map((name) => ({ name, file: path.join(SKILLS_DIR, name, 'SKILL.md') }))
    .filter(({ file }) => fs.existsSync(file))
    .map((entry) => ({ ...entry, text: fs.readFileSync(entry.file, 'utf8') }));
}

console.log('\nthe defaults live in one place');

check('roots.js still exports a non-empty DEFAULT_ROOTS', () => {
  // Everything below iterates this list. Exported as undefined or emptied, the
  // two checks after it would iterate nothing and report success, which is the
  // failure mode that makes a guard worse than no guard.
  assert.ok(Array.isArray(DEFAULT_ROOTS), 'DEFAULT_ROOTS is not an array');
  assert.ok(DEFAULT_ROOTS.length > 0, 'DEFAULT_ROOTS is empty');
  for (const root of DEFAULT_ROOTS) {
    assert.ok(root.path && root.name && root.kind, `incomplete default root: ${JSON.stringify(root)}`);
  }
});

check('no skill writes out a default root path', () => {
  const offenders = [];
  for (const { name, text } of skillFiles()) {
    for (const root of DEFAULT_ROOTS) {
      if (text.includes(root.path)) offenders.push(`${name} names ${root.path}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `ask roots.js instead:\n        ${offenders.join('\n        ')}`);
});

check('no skill writes out a default root name', () => {
  // The paths are the obvious copy; the names are how a copy survives a path
  // changing. A skill that still says `"name": "personal"` is carrying the list
  // in a second form.
  const offenders = [];
  for (const { name, text } of skillFiles()) {
    for (const root of DEFAULT_ROOTS) {
      const quoted = new RegExp(`["\`']${root.name}["\`'][^\\n]*\\b(path|kind)\\b`);
      if (quoted.test(text)) offenders.push(`${name} names the ${root.name} root with its shape`);
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n        '));
});

check('a skill that resolves roots asks the script for them', () => {
  // The inverse of the two above: having removed the copies, something has to
  // still be reading the roots, or these skills stopped resolving them at all
  // and the checks above pass for the wrong reason.
  const resolvers = skillFiles().filter(({ text }) => /roots\.js"? (list|check)/.test(text));
  assert.ok(resolvers.length >= 5,
    `only ${resolvers.length} skills call roots.js; the copies were removed without a replacement`);
});

check('a skill that promises to relay a roots message calls check, not just list', () => {
  // `check` writes the sentences that name a dead root, its path and the
  // remedy. `list` writes JSON and nothing else. Three skills were switched
  // from one to the other while keeping instructions that said "print what it
  // said", which would have dumped a JSON object at the user in place of the
  // sentence, and each still carried the line promising every message arrives
  // on stdout. That line is the tell, so it is what this keys on.
  //
  // to-build is the counter-example that shows the rule is about the promise
  // and not about calling both: it uses `list` alone and deliberately says it
  // relays only on exit 1, so it makes no claim to keep.
  const PROMISE = 'arrives on stdout';
  const claimants = skillFiles().filter(({ text }) => text.includes(PROMISE));
  assert.ok(claimants.length >= 3,
    `only ${claimants.length} skills make the relay promise; this check has stopped finding its subjects`);

  const offenders = claimants
    .filter(({ text }) => !/roots\.js"? check/.test(text))
    .map(({ name }) => name);
  assert.deepStrictEqual(offenders, [],
    `these promise to relay a roots message but only call list, which prints JSON: ${offenders.join(', ')}`);
});

check('no skill reads build-loop.config.json itself', () => {
  // find-skill did, in Python, with its own copy of the defaults underneath.
  // Naming the config file is fine in prose; opening it is not.
  //
  // Comment lines are stripped first. The first version of this check matched
  // the word "open" anywhere on a line and so fired on find-skill's comment
  // saying it no longer opens the config, which is the shape that gets a check
  // deleted rather than fixed: it accuses the text that records the fix.
  const isComment = (line) => /^\s*(#|\/\/|>|\*)/.test(line);
  const reads = /(open|readFileSync|readFile|json\.load)\s*\([^\n]*build-loop\.config\.json/;
  const offenders = skillFiles()
    .filter(({ text }) => text.split('\n').filter((l) => !isComment(l)).some((l) => reads.test(l)))
    .map(({ name }) => name);
  assert.deepStrictEqual(offenders, [],
    `these open the config directly instead of calling roots.js: ${offenders.join(', ')}`);
});

console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
