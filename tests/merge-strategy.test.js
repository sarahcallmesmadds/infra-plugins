#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'plugins', 'git-hygiene', 'skills', 'merge-strategy', 'SKILL.md');
const text = fs.readFileSync(file, 'utf8');
let failed = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try { fn(); console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
}

check('the skill is read-only and does not perform merges', () => {
  assert.match(text, /never merges, rebases, pushes, or deletes/i);
  assert.match(text, /Read-only/);
});
check('the skill gathers actual branch and pull-request evidence', () => {
  assert.match(text, /git rev-list --count/);
  assert.match(text, /git log --oneline/);
  assert.match(text, /symbolic-ref --short refs\/remotes\/origin\/HEAD/);
  assert.match(text, /Resolve[\s\S]*default[\s\S]*baseRefName/);
  assert.match(text, /gh pr view/);
  assert.match(text, /reviewDecision/);
});
check('the skill distinguishes public history from shared history', () => {
  assert.match(text, /remote branch proves[\s\S]*public/i);
  assert.match(text, /does not prove[\s\S]*nobody else/i);
  assert.match(text, /treat it as[\s\n]+shared/i);
});
check('all three strategies have evidence-based rules', () => {
  for (const strategy of ['Merge commit', 'Rebase-and-merge', 'Squash-and-merge']) {
    assert.match(text, new RegExp(`\\*\\*${strategy}\\*\\*`));
  }
  assert.match(text, /fixups, review corrections/);
  assert.match(text, /meaningful[\s\n]+merge commits/);
  assert.match(text, /small number of[\s\n]+meaningful commits/);
});
check('uncertain or unready changes fail safe', () => {
  assert.match(text, /Unknown is not a reason/);
  assert.match(text, /not ready to[\s\n]+merge/);
  assert.match(text, /uncommitted local[\s\n]+files/);
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
