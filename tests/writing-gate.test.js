#!/usr/bin/env node
// Regression tests for the writing-gate detectors.
//
// Run: node tests/writing-gate.test.js
//
// The rows that matter most are the negative ones. A detector that flags
// everything is worse than no detector, because it trains you to ignore it.

'use strict';

const assert = require('assert');
const path = require('path');

const base = path.join(__dirname, '..', 'plugins', 'writing-gate', 'scripts');
const { checkHard, checkAll } = require(path.join(base, 'tells.js'));
const { checkCode, checkData, checkSpec, checkTechnical, checkOverbuilt, checkOverplanned } = require(path.join(base, 'technical.js'));

const EM = String.fromCharCode(0x2014);
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` (got ${actual}, wanted ${expected})`}`);
}

console.log('hard rules');
check('em dash is caught', checkHard(`a sentence ${EM} with a dash`).ok, false);
check('hyphen is not an em dash', checkHard('a plain-English compound word').ok, true);
check('three short sentences run', checkHard('Yes. It works. All done.').ok, false);
check('one short sentence is fine', checkHard('Yes. That is a perfectly ordinary longer sentence here.').ok, true);
check('generation artefact is caught', checkHard('the result oaicite follows').ok, false);
check('bullets do not count as prose', checkHard('- one\n- two\n- three').ok, true);

console.log('\nsoft prose signals need to stack');
check('one buzzword is not a verdict', checkAll('We should leverage this.').reading, 'little');
check(
  'many categories together are',
  checkAll(
    "In today's world it's important to note that teams must leverage robust, holistic, seamless " +
    'processes. This is not just a challenge, but an opportunity. Experts argue that it serves as ' +
    'a testament to modern practice, underscoring the importance of change. It depends. ' +
    'Both approaches have merit. Ultimately the choice is yours.'
  ).reading,
  'strong'
);

console.log('\ncode');
check('shipped placeholder is a hard finding',
  checkCode('const KEY = "your-api-key";').some((f) => f.hard), true);
check('bare except that passes is caught',
  checkCode('try:\n    go()\nexcept:\n    pass\n').some((f) => f.name === 'errors-silently-swallowed'), true);
check('specific exception deliberately ignored is NOT caught',
  checkCode('try:\n    go()\nexcept ValueError:\n    pass\n').some((f) => f.name === 'errors-silently-swallowed'), false);
check('empty JS catch is caught',
  checkCode('try { go(); } catch (e) {}').some((f) => f.name === 'errors-silently-swallowed'), true);

console.log('\ndata and charts');
check('percentages that miss 100 are caught',
  checkData('30% of one, 30% of two, 25% of three').some((f) => f.name === 'percentages-do-not-total-100'), true);
check('percentages that total 100 are not',
  checkData('50% of one, 30% of two, 20% of three').some((f) => f.name === 'percentages-do-not-total-100'), false);
check('default chart labels are caught',
  checkData('Series 1 plotted against Category A').some((f) => f.name === 'default-chart-labels'), true);

console.log('\nspecs');
check('options with no recommendation are caught',
  checkSpec('Option 1 is this. Option 2 is that. Option 3 is the other.')
    .some((f) => f.name === 'options-with-no-recommendation'), true);
check('options WITH a recommendation are not',
  checkSpec('Option 1 is this. Option 2 is that. I recommend option 1 because it ships sooner.')
    .some((f) => f.name === 'options-with-no-recommendation'), false);
check('identical estimates are caught',
  checkSpec('Phase one 2 weeks. Phase two 2 weeks. Phase three 2 weeks.')
    .some((f) => f.name === 'every-estimate-identical'), true);

console.log('\ntaking the long way round');
check('hand-rolled stdlib is caught',
  checkOverbuilt('function isEmpty(v) { return v === null; }')
    .some((f) => f.name === 'rebuilt-what-the-language-provides'), true);
check('async with nothing to await is caught',
  checkOverbuilt('async function a() { return 1; }\nasync function b() { return 2; }\n')
    .some((f) => f.name === 'async-with-nothing-to-await'), true);
check('async that actually awaits is not',
  checkOverbuilt('async function a() { await go(); }\nasync function b() { await go(); }\n')
    .some((f) => f.name === 'async-with-nothing-to-await'), false);
check('a plan that names no cut line is caught',
  checkOverplanned('We will build the thing. The plan is to implement it across the team. '.repeat(12))
    .some((f) => f.name === 'never-says-what-it-is-not-doing'), true);
check('a plan that says what it is NOT doing is not',
  checkOverplanned('We will build the thing. The plan is to implement it. Out of scope: everything else. '.repeat(12))
    .some((f) => f.name === 'never-says-what-it-is-not-doing'), false);
check('handing back the reader their own context is caught',
  checkOverplanned('As you mentioned, this is manual. To recap, it is slow.')
    .some((f) => f.name === 'restates-what-you-already-said'), true);

console.log('\nthe two readings are separate');
{
  // Two signals is "somewhat heavier", not a verdict. Three stacks into one.
  const light = checkTechnical(
    'function isEmpty(v) { return !v; }\nfunction unique(l) { return l; }\n' +
    'async function x() { return 1; }\nasync function y() { return 2; }\n', 'code');
  check('two signals is only somewhat heavy', light.weight, 'some');

  const heavy = checkTechnical(
    'const UserFactory = {};\nconst UserManager = {};\nconst UserProvider = {};\n' +
    'const UserRegistry = {};\nfunction isEmpty(v) { return !v; }\n' +
    'async function x() { return 1; }\nasync function y() { return 2; }\n', 'code');
  check('three or more reads heavy', heavy.weight, 'strong');
  check('...but none of it reads as unreviewed', heavy.reading, 'little');
}

console.log('\nverdicts do not overreact');
check('a single hard finding is not yet strong',
  checkTechnical('const KEY = "your-api-key";', 'code').reading, 'some');

console.log(`\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
