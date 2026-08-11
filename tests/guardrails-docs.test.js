#!/usr/bin/env node
// The guardrails docs against the guardrails code.
//
// Run: node tests/guardrails-docs.test.js
//
// A review found three stale claims in one release. The README said the
// scanner groups patterns into eight categories directly above a list of eight
// names, while the code had nine. The blocked-command paragraph did not
// mention a rule that had just been added, and neither did the table in the
// undo-possible skill. All three were true when written and none of them was
// wrong in a way any test could see.
//
// stated-counts.test.js does not catch this shape. It compares a count to a
// markdown list or table sitting immediately below it, and these names are
// written inline in a sentence, so there is no list to compare against. The
// answer is not to teach that detector to parse prose. It is to check the
// documentation against the thing it describes, which is what this does.
//
// Scope is deliberately small: the claims that go stale when somebody adds a
// row. Nothing here reads the prose for meaning.

'use strict';

const fs = require('fs');
const path = require('path');
const { PATTERNS } = require('../plugins/guardrails/scripts/patterns');
const { DEFAULTS } = require('../plugins/guardrails/scripts/config');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'guardrails');
const README = fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');
const GUARD = fs.readFileSync(path.join(PLUGIN, 'hooks', 'resource-owner-guard.js'), 'utf8');

// The one-line descriptions a person reads before installing. Three of them,
// in three files, which is three chances to update two.
const DESCRIPTIONS = {
  'the Claude manifest': require('../plugins/guardrails/.claude-plugin/plugin.json').description,
  'the Codex manifest': require('../plugins/guardrails/.codex-plugin/plugin.json').description,
  'the marketplace entry': require('../.claude-plugin/marketplace.json')
    .plugins.find((entry) => entry.name === 'guardrails').description,
};
const UNDO = fs.readFileSync(
  path.join(PLUGIN, 'skills', 'undo-possible', 'SKILL.md'),
  'utf8'
);

const NUMBER_WORD = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
];

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

const categories = [...new Set(PATTERNS.map((p) => p.category))];

// The prose name for each category, written out rather than derived. Dropping
// the hyphen almost works and then does not: `fake-boundary` reads as "fake
// conversation boundaries" in the README, because the short name is a label
// and the sentence is for somebody who has never seen the code. Deriving would
// have forced one of the two to be worse. A category with no entry here fails
// the check below, which is the property that matters: a new one cannot be
// added without somebody deciding what to call it in the docs.
const PROSE_NAME = {
  'instruction-override': 'instruction override',
  'role-reassignment': 'role reassignment',
  'fake-boundary': 'fake conversation boundaries',
  exfiltration: 'exfiltration',
  'secret-solicitation': 'secret solicitation',
  'tool-coercion': 'tool coercion',
  'authority-spoofing': 'authority spoofing',
  obfuscation: 'obfuscation',
  'summarisation-survival': 'summarisation survival',
};

check('every pattern category is named in the README', () => {
  // Line breaks fall wherever the paragraph wrapped, so a name can be split
  // across two lines and still read correctly. Comparing against the raw text
  // would report that as missing.
  const prose = README.toLowerCase().replace(/\s+/g, ' ');

  const unnamed = categories.filter((c) => !PROSE_NAME[c]);
  if (unnamed.length) {
    throw new Error(
      `${unnamed.join(', ')} is a category with no agreed wording. Add it to PROSE_NAME `
        + 'in this file and to the sentence in the README that lists them.'
    );
  }

  const missing = categories.filter((c) => !prose.includes(PROSE_NAME[c]));
  if (missing.length) {
    throw new Error(
      `${missing.join(', ')} exists in patterns.js and is not named in the README. `
        + 'Add it to the sentence listing the categories, and move the count with it.'
    );
  }
});

check('the stated category count matches how many there are', () => {
  const stated = README.match(/groups patterns into (\w+) categories/i);
  if (!stated) {
    throw new Error(
      'the README no longer states a category count in the expected words, so this '
        + 'check is watching nothing. Update the pattern here or drop the sentence.'
    );
  }
  const want = NUMBER_WORD[categories.length] || String(categories.length);
  if (stated[1].toLowerCase() !== want) {
    throw new Error(
      `the README says ${stated[1]} categories and patterns.js has ${categories.length} (${want})`
    );
  }
});

check('the count at the top matches the things listed under it', () => {
  // The other shape stated-counts cannot see. It compares a number to a
  // markdown list or table immediately below it, and this number sits above
  // four paragraphs that each open with a bold sentence, which is not a list
  // as far as any parser is concerned. A fourth was added under a sentence
  // saying three and nothing anywhere noticed.
  const lines = README.split('\n');
  const at = lines.findIndex((l) => /^(\w+) things, and it says which/.test(l));
  if (at === -1) {
    throw new Error(
      'the opening sentence no longer has the expected shape, so this check is '
        + 'watching nothing. Update the pattern here or drop the count.'
    );
  }

  let listed = 0;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) break;
    if (/^\*\*[A-Z]/.test(lines[i])) listed += 1;
  }

  const stated = lines[at].match(/^(\w+) things/)[1].toLowerCase();
  const want = NUMBER_WORD[listed] || String(listed);
  if (stated !== want) {
    throw new Error(
      `the README opens by promising ${stated} things and then lists ${listed} (${want})`
    );
  }
});

check('every config key is documented in the README table', () => {
  const missing = Object.keys(DEFAULTS).filter((key) => !README.includes(`\`${key}\``));
  if (missing.length) {
    throw new Error(
      `${missing.join(', ')} is a real setting nobody can find: it is in config.js `
        + 'and not in the README table.'
    );
  }
});

check('the commands the guard blocks are listed in both docs', () => {
  // Named rather than derived. IRREVERSIBLE_GIT holds regular expressions, and
  // turning one back into the command a person types is guesswork, so the list
  // is written out and a new rule fails here until it is added on purpose.
  const BLOCKED = [
    'rm -rf',
    'git reset --hard',
    'git clean -fd',
    'git push --force',
    'git branch -D',
    'git commit --no-verify',
  ];
  const gaps = [];
  for (const command of BLOCKED) {
    if (!README.includes(command)) gaps.push(`${command} (README)`);
    if (!UNDO.includes(command)) gaps.push(`${command} (undo-possible)`);
  }
  if (gaps.length) {
    throw new Error(
      `${gaps.join(', ')}. A blocked command absent from the docs is one that `
        + 'surprises somebody at the moment it fires.'
    );
  }
});

// A capability named in a description that the code does not implement.
//
// This is the shape that got through twice in one release. The owner gate was
// removed, the marketplace entry and the README were rewritten, and the Claude
// manifest kept promising it blocks "direct writes to skill-owned resources".
// The text a person reads before installing was the last copy left, which is
// the worst one to miss.
//
// It reads the guard rather than hard-coding the verdict, so re-adding the gate
// relaxes this check instead of leaving a test that lies in the other
// direction. The Codex manifest is held to the same rule and not to the same
// words: Codex plugins cannot carry hooks, so it describes the skills only, and
// syncing the three descriptions would put a claim there that is false for that
// runtime.
check('no description advertises a gate the code does not have', () => {
  const ownerGateExists = /activeOwner|readLease/.test(GUARD);
  if (ownerGateExists) return;

  const retired = /skill-owned|owning skill|owned by|\blease\b/i;
  const stale = Object.entries(DESCRIPTIONS)
    .filter(([, text]) => retired.test(String(text || '')))
    .map(([where, text]) => `${where}: "${text}"`);

  if (stale.length) {
    throw new Error(
      `${stale.join(' | ')}. The owner gate was removed, so a description `
        + 'promising it describes behaviour the plugin no longer has.'
    );
  }
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
