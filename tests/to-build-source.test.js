#!/usr/bin/env node
// Regression tests for the `source` field on a to-build item.
//
// Run: node tests/to-build-source.test.js
//
// The fault: nine open items recorded "port from <file>.js in hq-skills PR #1".
// That repository was archived and taken off the machine, and nothing surfaced
// the dead reference. It was found by someone sitting down to build one of the
// items and discovering the material was gone. A recorded source that no longer
// resolves should be visible when the list is read, not at build time.
//
// The rejected alternative is pinned here too, because it is the obvious one
// and it is wrong: scanning `what`, `why` and `where` for path-shaped strings
// would warn about `where`, which holds the DESTINATION and is supposed to be
// missing until the thing is built. A skill that cries wolf on the healthy case
// gets ignored on the real one.
//
// /to-build and /built-check are prose rather than code, so what can be tested
// is the contract the three files state, and that they state it compatibly.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'plugins', 'build-loop');
const toBuild = fs.readFileSync(path.join(ROOT, 'skills', 'to-build', 'SKILL.md'), 'utf8');
const builtCheck = fs.readFileSync(path.join(ROOT, 'skills', 'built-check', 'SKILL.md'), 'utf8');
const schema = fs.readFileSync(path.join(ROOT, 'reference', 'SCHEMA-BUILD.md'), 'utf8');

let failed = 0;
function check(what, fn) {
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

// --- the field exists in all three places that have to agree ---------------

check('the schema documents `source` as an optional field', () => {
  assert.ok(/\|\s*`source`\s*\|/.test(schema), 'no `source` row in the field reference table');
  const row = schema.split('\n').find((l) => /\|\s*`source`\s*\|/.test(l));
  assert.ok(/\|\s*no\s*\|/.test(row), `\`source\` is not marked optional: ${row}`);
});

check('the schema example carries the field, so a copied example is complete', () => {
  assert.ok(/"source":/.test(schema), 'the example entry has no `source` key');
});

check('$schema_version is not bumped for an optional addition', () => {
  assert.ok(
    /Currently 1\./.test(schema),
    'the field reference no longer says the schema version is 1'
  );
  assert.ok(
    /\$schema_version.{0,40}stays at 1/s.test(schema),
    'the changelog does not record that the version deliberately stayed at 1'
  );
});

check('/to-build writes the field when it composes an item', () => {
  assert.ok(/^source:\s/m.test(toBuild), 'Step A4 does not list `source` among the fields written');
});

check('/to-build shows the field in the draft before writing', () => {
  assert.ok(/^Source:\s*\{source/m.test(toBuild), 'the Step A3 draft does not show Source');
});

// --- the check itself ------------------------------------------------------

check('the list mode checks recorded sources', () => {
  assert.ok(
    /Check recorded sources/i.test(toBuild),
    'no step in /to-build checks whether a source resolves'
  );
});

check('a leading ~ is expanded before the check', () => {
  // `[ -e "~/x" ]` is false for every path, so without this the check reports
  // every home-relative source as gone.
  assert.ok(
    /Expand a leading `~`/.test(toBuild),
    'the source check does not say to expand ~, so ~-relative paths all read as missing'
  );
});

check('the check is batched, not one tool call per item', () => {
  assert.ok(
    /for p in .*\n\s*\[ -e "\$p" \]/.test(toBuild),
    'the source check does not batch its paths into one command'
  );
});

// --- what the check must NOT do -------------------------------------------

check('`where` is explicitly excluded from the path check', () => {
  assert.ok(
    /Only `source` is checked\.\*\* Not `where`/.test(toBuild),
    '/to-build does not state that `where` is excluded from the source check'
  );
  assert.ok(
    /destination, not a source/i.test(schema),
    'the schema does not warn that `where` is a destination'
  );
});

check('a missing source does not change the item status', () => {
  assert.ok(
    /A missing source does not change the item's status/.test(toBuild),
    'nothing stops a dead source being treated as a status change or a blocker'
  );
});

check('nothing is printed when every source resolves', () => {
  assert.ok(
    /Do not print the block, the heading, or a reassurance/.test(toBuild),
    'the skill may print an all-clear line on every run, which trains the reader to skip it'
  );
});

// --- the dependent skill ---------------------------------------------------

check('/built-check does not treat `source` as evidence of being built', () => {
  assert.ok(
    /`source` is excluded from this sweep/.test(builtCheck),
    'built-check stats paths found in item text and does not exclude `source`, so an item ' +
    'would look built the moment its spec existed'
  );
});

check('/built-check names exactly the fields it reads for paths', () => {
  assert.ok(
    /Only `what` and `why` are read for paths here\./.test(builtCheck),
    'built-check does not pin which fields its path sweep covers'
  );
});

// --- the printed text obeys the house style --------------------------------

check('no em dash in the lines these skills print', () => {
  // The Stop hook blocks em dashes in assistant output, so one inside a display
  // template means a rewrite on every single invocation. Section headings are
  // exempt: they reach nobody.
  for (const [name, text] of [['to-build', toBuild], ['built-check', builtCheck]]) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (/^#{1,6}\s/.test(line)) return;
      if (!line.includes('—')) return;
      const quoted = /^>/.test(line.trim()) || /^\s*"/.test(line);
      assert.ok(!quoted, `${name}:${i + 1} prints an em dash: ${line.trim().slice(0, 70)}`);
    });
  }
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  to-build-source.test.js  ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
