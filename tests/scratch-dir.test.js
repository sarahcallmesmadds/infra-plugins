#!/usr/bin/env node
// Tests for the shared scratch-directory script, and for the skills having
// stopped explaining it themselves.
//
// Run: node tests/scratch-dir.test.js
//
// The bug this pins: the same instruction lived in seven skills as prose and
// three of those copies had already been reworded. flag-issue's copy dropped the
// sentence that introduces `{scratch}`, so the skill went on to use a
// placeholder its own text never defined. That is the failure this class of
// duplication produces: not a copy that is obviously stale, but one that is
// still readable and no longer says the same thing.
//
// The script half runs as a subprocess and reads what a skill would read,
// because what a skill uses is the line on stdout. A unit test importing main()
// would pass while the script printed nothing.
//
// The prose half is the part that actually decays, so it is checked against the
// files rather than against a list kept here.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'plugins', 'build-loop', 'scripts', 'scratch.js');
const SKILLS_DIR = path.join(ROOT, 'plugins', 'build-loop', 'skills');

const made = [];
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

function run(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: (error.stdout || '') + (error.stderr || '') };
  }
}

function skillFiles() {
  return fs.readdirSync(SKILLS_DIR)
    .map((name) => ({ name, file: path.join(SKILLS_DIR, name, 'SKILL.md') }))
    .filter(({ file }) => fs.existsSync(file))
    .map((entry) => ({ ...entry, text: fs.readFileSync(entry.file, 'utf8') }));
}

console.log('\nscratch.js');

check('prints one line, and it is a directory that now exists', () => {
  const out = run();
  assert.strictEqual(out.code, 0);
  const lines = out.stdout.trimEnd().split('\n');
  assert.strictEqual(lines.length, 1, `expected one line, got ${lines.length}`);
  const dir = lines[0];
  made.push(dir);
  assert.ok(path.isAbsolute(dir), `not absolute: ${dir}`);
  assert.ok(fs.statSync(dir).isDirectory(), `not a directory: ${dir}`);
});

check('two runs never return the same directory', () => {
  // Both codes and both directories are asserted, not just that the two lines
  // differ. Two runs that failed with different error text also produce two
  // different lines, and this check would have passed with neither directory
  // existing.
  const first = run();
  const second = run();
  assert.strictEqual(first.code, 0);
  assert.strictEqual(second.code, 0);
  const a = first.stdout.trim();
  const b = second.stdout.trim();
  made.push(a, b);
  assert.ok(fs.statSync(a).isDirectory(), `not a directory: ${a}`);
  assert.ok(fs.statSync(b).isDirectory(), `not a directory: ${b}`);
  assert.notStrictEqual(a, b);
});

check('the directory is private to this user', () => {
  const dir = run().stdout.trim();
  made.push(dir);
  // 0700. A world-readable directory is half of what this script exists to
  // prevent: another local account can replace a file between a Write and the
  // call that reads it.
  const mode = fs.statSync(dir).mode & 0o777;
  assert.strictEqual(mode, 0o700, `mode was ${mode.toString(8)}`);
});

check('it lands under the platform temp directory, not a hardcoded /tmp', () => {
  const dir = run().stdout.trim();
  made.push(dir);
  assert.ok(
    dir.startsWith(fs.realpathSync(os.tmpdir())) || dir.startsWith(os.tmpdir()),
    `${dir} is not under ${os.tmpdir()}`
  );
});

check('an argument is refused rather than answered', () => {
  // A caller passing an argument means a different command. Printing a path
  // anyway sends its files somewhere it is not looking.
  const out = run(['--list']);
  assert.strictEqual(out.code, 1);
  assert.match(out.stdout, /takes no arguments/);
});

check('--help explains itself and exits zero', () => {
  const out = run(['--help']);
  assert.strictEqual(out.code, 0);
  assert.match(out.stdout, /0700/);
  assert.match(out.stdout, /not\s+removed by this script/);
});

check('--help alongside another argument is still refused', () => {
  // Testing for --help anywhere in argv made this print help and exit 0, so the
  // script answered a command it does not have while its own help text said it
  // takes no arguments.
  const out = run(['--help', '--list']);
  assert.strictEqual(out.code, 1);
  assert.match(out.stdout, /takes no arguments/);
});

console.log('\nthe skills no longer carry their own copy');

check('no build-loop skill runs mktemp', () => {
  // Including in allowed-tools. A grant for a command no skill runs is a
  // standing permission nobody is watching.
  const offenders = skillFiles().filter(({ text }) => text.includes('mktemp'));
  assert.deepStrictEqual(offenders.map((o) => o.name), []);
});

// The runnable command, not a mention of the path. Matching the bare string
// `scripts/scratch.js` also counted the sentence in apply-fix that names the
// script while explaining why not to make a directory any other way, so deleting
// that skill's actual command block left both checks below passing.
const CALL = /```bash\nnode "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/scratch\.js"\n```/;

check('every skill that uses {scratch} also runs the command that makes one', () => {
  const offenders = skillFiles()
    .filter(({ text }) => text.includes('{scratch}'))
    .filter(({ text }) => !CALL.test(text))
    .map(({ name }) => name);
  assert.deepStrictEqual(offenders, [], `use {scratch} without making one: ${offenders.join(', ')}`);
});

check('every skill that runs it says what to call the path', () => {
  // flag-issue is why this is here. Its copy of the block dropped the sentence
  // that names `{scratch}`, and it then used the placeholder eleven lines later.
  const offenders = skillFiles()
    .filter(({ text }) => CALL.test(text))
    .filter(({ text }) => !/written as `\{scratch\}`|prints as `\{scratch\}`/.test(text))
    .map(({ name }) => name);
  assert.deepStrictEqual(offenders, []);
});

console.log('\nthe warning that cannot become a script call');

// Pinned, not discovered. The first version of the check below found its
// subjects by searching for the warning, so deleting the warning deleted the
// thing being tested: removing it from six of these eight files passed clean.
// A list has to be edited on purpose, which is the whole point of the guard.
const TILDE_WARNING_CARRIERS = [
  'apply-fix', 'audit-deps', 'built-check', 'flag-issue',
  'flag-patterns', 'to-build', 'verify-fix',
];

check('the tilde-paths warning is in every file expected to carry it', () => {
  const marker = 'Paths in this file are written with `~` for readability.';
  const carrying = skillFiles().filter(({ text }) => text.includes(marker)).map(({ name }) => name);
  assert.deepStrictEqual(carrying.sort(), [...TILDE_WARNING_CARRIERS].sort());
});

check('every copy of the tilde-paths warning is byte-identical', () => {
  // This one is an instruction to the model about writing a path, so there is
  // no command to move it into and deleting it would be wrong: all eight files
  // that carry it reference `~/` paths, between 2 and 21 times each. Pinning
  // the copies is the available guard. The scratch block is what happens
  // without one.
  const marker = 'Paths in this file are written with `~` for readability.';
  const carriers = skillFiles().filter(({ text }) => text.includes(marker));
  assert.strictEqual(carriers.length, TILDE_WARNING_CARRIERS.length);

  const block = ({ text }) => {
    const start = text.indexOf('> **' + marker);
    assert.notStrictEqual(start, -1, 'warning is not in the expected blockquote form');
    const lines = text.slice(start).split('\n');
    const out = [];
    for (const line of lines) {
      if (!line.startsWith('>')) break;
      out.push(line);
    }
    return out.join('\n');
  };

  const first = block(carriers[0]);
  for (const carrier of carriers.slice(1)) {
    assert.strictEqual(
      block(carrier),
      first,
      `${carrier.name} has a reworded copy; change all ${carriers.length} or none`
    );
  }
});

for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
