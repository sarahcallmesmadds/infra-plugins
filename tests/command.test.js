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

console.log(`\n${CASES.length + 2} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
