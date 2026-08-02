#!/usr/bin/env node
// Regression tests for the destructive-command check.
//
// Run: node tests/command.test.js
//
// The two rows that matter most are the quoted-string pair. Blocking a command
// that only MENTIONS a delete is an annoyance; failing to block `bash -c "rm
// -rf ..."` is a hole. Both were real, and a fix for one can reintroduce the
// other, so they are pinned here together.

'use strict';

const assert = require('assert');
const { checkCommand } = require('../plugins/guardrails/scripts/command');
const { DEFAULTS } = require('../plugins/guardrails/scripts/config');

const CONFIG = { safeDeletePaths: ['/tmp', '~/.cache', 'node_modules'] };

const CASES = [
  // --- must block: the whole point of the plugin -------------------------
  ['rm -rf ~/Projects/live', 'confirm', 'plain recursive force-delete'],
  ['sudo rm -rf /etc/nginx', 'confirm', 'delete behind sudo'],
  ['cp x /tmp/y && rm -rf ~/live', 'confirm', 'safe path mentioned, other path deleted'],
  ['git reset --hard', 'confirm', 'discards uncommitted work'],
  ['git clean -fd', 'confirm', 'removes untracked files'],
  ['git push --force origin main', 'confirm', 'can overwrite a remote branch'],
  ['git branch -D feature', 'confirm', 'deletes an unmerged branch'],

  // --- must block: quoted text that really is executed -------------------
  ['bash -c "rm -rf ~/live"', 'confirm', 'shell -c executes its quoted argument'],
  ["sh -c 'rm -rf ~/live'", 'confirm', 'single-quoted form of the same'],
  ['ssh box "rm -rf /srv/data"', 'confirm', 'remote shell executes it too'],

  // --- must allow: quoted text that is only passed along -----------------
  ['claude -p "assess rm -rf ./throwaway and report"', 'allow', 'prompt mentioning a delete'],
  ['echo "run rm -rf later"', 'allow', 'echoing the words'],
  ['git commit -m "drop rm -rf from the docs"', 'allow', 'commit message mentioning it'],
  ['claude -p "step a && rm -rf ~/live"', 'allow', 'operator inside quotes must not split'],

  // --- must allow: legitimate near-misses --------------------------------
  ['git push --force-with-lease', 'allow', 'refuses to overwrite unseen work'],
  ['rm -rf /tmp/build', 'allow', 'configured disposable path'],
  ['rm -rf node_modules', 'allow', 'configured disposable path'],
  ['rm file.txt', 'allow', 'not recursive, not forced'],
  ['ls -la', 'allow', 'ordinary command'],
];

let failed = 0;
for (const [command, expected, why] of CASES) {
  const actual = checkCommand(command, CONFIG).verdict;
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${expected.padEnd(7)} ${why}\n         ${command}`);
}

// The reported target has to be the path as typed. It used to be the rest of
// the sentence, and after masking it could have been a row of x characters.
const quoted = checkCommand('rm -rf "my dir"', CONFIG);
assert.strictEqual(quoted.verdict, 'confirm');
assert.strictEqual(quoted.target, 'my dir', `quoted target was reported as ${quoted.target}`);
console.log('  ok   target    quoted path with a space is reported as typed');

const chained = checkCommand('cp x /tmp/y && rm -rf ~/live', CONFIG);
assert.strictEqual(chained.target, '~/live', `chained target was reported as ${chained.target}`);
console.log('  ok   target    chained delete reports the deleted path, not the safe one');

// --- the shipped defaults, not a fixture ---------------------------------
//
// Everything above runs against a synthetic three-entry config, which is how
// three defaults that matched nothing at all stayed invisible: `/dist/`,
// `/build/` and `/coverage/` were written in the anchored form and no test
// ever looked at the real list. This walks it.
//
// An entry takes one of two forms. Anchored, with a leading slash, means one
// specific absolute location. Unanchored means a directory name that is
// disposable wherever it appears. ANCHORED below is the set allowed to take
// the first form. A new anchored default fails here until someone adds it
// deliberately, and that is the moment where it becomes obvious that `dist`
// is not a directory at the root of the filesystem.
const ANCHORED = ['/tmp', '/private/tmp'];
const REAL = { safeDeletePaths: DEFAULTS.safeDeletePaths };
let walked = 0;

function expect(command, want, why) {
  walked += 1;
  const actual = checkCommand(command, REAL).verdict;
  const ok = actual === want;
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${want.padEnd(7)} ${why}\n         ${command}`);
}

for (const raw of DEFAULTS.safeDeletePaths) {
  const entry = String(raw).replace(/\/+$/, '');
  assert.ok(entry, `safeDeletePaths contains an empty entry: ${JSON.stringify(raw)}`);

  if (entry.startsWith('/')) {
    assert.ok(
      ANCHORED.includes(entry),
      `${raw} is anchored to the filesystem root, so it matches only that one `
        + 'location and nothing inside a project. If that is intended, add it to '
        + 'ANCHORED in this file. If it is a directory name, drop the leading slash.'
    );
    expect(`rm -rf ${entry}/scratch`, 'allow', `${raw}: something inside it`);
  } else {
    // The spellings a real delete of one of these actually takes.
    expect(`rm -rf ${entry}`, 'allow', `${raw}: bare`);
    expect(`rm -rf ./${entry}`, 'allow', `${raw}: relative`);
    expect(`rm -rf /Users/someone/Projects/app/${entry}`, 'allow', `${raw}: inside a project`);
  }

  // No entry may match a neighbour that only shares its opening characters.
  expect(`rm -rf ${entry}foo`, 'confirm', `${raw}: decoy with no boundary`);
  expect(`rm -rf ${entry}-backup`, 'confirm', `${raw}: decoy suffix`);

  // And no entry may be used as a doorway to somewhere above it. A `..` after
  // the name makes the match a lie: the string opens with something disposable
  // and lands somewhere else.
  expect(`rm -rf ${entry}/../../important`, 'confirm', `${raw}: climbs back out`);

  if (!entry.startsWith('/')) {
    // A `..` in front of the name is the opposite case to the one above and
    // has to keep working. The last segment is still the disposable
    // directory, and this is what someone in a subdirectory types to clear a
    // sibling project. Only unanchored entries can be reached this way: an
    // anchored one names an absolute location, and `../tmp` is not `/tmp`.
    expect(`rm -rf ../${entry}`, 'allow', `${raw}: reached from a subdirectory`);

    // An unanchored name does not reach a top-level directory of the
    // filesystem, and no alternative spelling of that location gets there.
    expect(`rm -rf /${entry}`, 'confirm', `${raw}: at the filesystem root`);
    expect(`rm -rf //${entry}`, 'confirm', `${raw}: root, doubled separator`);
    expect(`rm -rf /./${entry}`, 'confirm', `${raw}: root, dot segment`);
  }
}

console.log(`\n${CASES.length + 2 + walked} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
