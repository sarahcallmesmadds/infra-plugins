#!/usr/bin/env node
// Regression tests for which rows stand as works on the exhibit.
//
// Run: node tests/ip-exhibit.test.js
//
// The rows come from tests/fixtures/ip-inventory-rows.json, the same captured
// Notion response the drift tests use, so the property mapping exercised here
// is the real one.
//
// What this file is really pinning is a counting rule, and both ways of getting
// it wrong cost something different.
//
// The first version listed a repository as a work alongside the plugins inside
// it. Its own comment said a repository is a container rather than a work, and
// the filter never acted on that: a top-level repository has no parent, so the
// empty-parent branch returned it. The exhibit then claimed the same authorship
// twice, which is the padding the tool warns about elsewhere.
//
// Excluding every repository fixes that and breaks something worse. A
// repository with nothing registered under it is not containing anything, it is
// the only record of that work, and dropping it takes real IP off the schedule
// with nothing left pointing at it. A padded exhibit can be argued down. A
// missing entry cannot be argued back.
//
// So the rule is neither "repositories are works" nor "repositories are not
// works". It is that a repository is a container where something beneath it is
// listed, and a work where nothing is.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'plugins', 'ip-inventory');
const { toRow } = require(path.join(ROOT, 'scripts', 'notion'));
const { DEFAULTS } = require(path.join(ROOT, 'scripts', 'config'));
const { exhibitRows } = require(path.join(ROOT, 'scripts', 'exhibit'));

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ip-inventory-rows.json'), 'utf8'));
const ROWS = raw.results.map((page) => toRow(page, DEFAULTS.properties || DEFAULTS));

const names = (rows) => exhibitRows(rows, DEFAULTS).map((row) => row.name);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`  ok   ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL ${name}\n         ${err.message}\n`);
  }
}

check('a repository holding listed work is not itself listed', () => {
  // The regression. guardrails and build-loop are inside this repository and
  // both appear as works, so the repository must not appear beside them.
  const listed = names(ROWS);
  assert.ok(listed.includes('guardrails'), listed.join(', '));
  assert.ok(listed.includes('build-loop'), listed.join(', '));
  assert.ok(
    !listed.includes('sarahcallmesmadds/plugins'),
    `the repository is counted again beside its own contents: ${listed.join(', ')}`,
  );
});

check('a repository with nothing under it is still a work', () => {
  // The failure the obvious fix introduces. Nothing else on the exhibit speaks
  // for this repository, so removing it removes the work entirely.
  const lone = { id: 'lone-repo', kind: 'Repo', name: 'sarahcallmesmadds/archive', parent: [] };
  assert.ok(names(ROWS.concat([lone])).includes('sarahcallmesmadds/archive'));
});

check('a repository whose only contents are components is still a work', () => {
  // Components are excluded from the exhibit, so a repository holding only
  // those has no entry standing in for it and has to speak for itself. This is
  // why the check reads the promoted set rather than the raw children.
  const repo = { id: 'scripts-repo', kind: 'Repo', name: 'sarahcallmesmadds/scripts', parent: [] };
  const script = { id: 'tidy', kind: 'Script', name: 'scripts/tidy.js', parent: ['scripts-repo'] };
  const listed = names(ROWS.concat([repo, script]));
  assert.ok(listed.includes('sarahcallmesmadds/scripts'), listed.join(', '));
  assert.ok(!listed.includes('scripts/tidy.js'), 'components never stand as works');
});

check('nothing is counted twice', () => {
  const listed = names(ROWS);
  assert.strictEqual(new Set(listed).size, listed.length, `duplicates in ${listed.join(', ')}`);
});

check('work nested under a plugin stays under the plugin', () => {
  // find-skill sits under build-loop, which is a Plugin and not a Repo, so the
  // plugin is the work and the skill inside it is not promoted. Unchanged by
  // this fix, and pinned so it stays that way.
  assert.ok(!names(ROWS).includes('find-skill'));
});

check('third-party entries never appear', () => {
  assert.ok(!names(ROWS).includes('Notion MCP'));
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
