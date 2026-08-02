#!/usr/bin/env node
// Tests for the shared configured-roots check.
//
// Run: node tests/roots-check.test.js
//
// The bug this pins: on 2026-08-01 the one configured root pointed at a
// directory that had moved, every skill resolved to files that were not there,
// and nothing said so. Three skills carried a guard and three did not, and the
// guard the three carried only fired when every root was dead, so one dead root
// among several scanned as empty. Empty and absent are indistinguishable to a
// glob, which is why this has to be checked rather than inferred.
//
// Everything here runs the real script as a subprocess against a throwaway HOME,
// because the thing being tested is what a skill sees: the exit code and the
// text on stdout. A unit test that imported resolve() and asserted on an object
// would pass while the script printed nothing.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'plugins', 'build-loop', 'scripts', 'roots.js');
const HOMES = [];

// A fresh HOME per case. Sharing one and rewriting the config between checks
// makes every later failure depend on the order they run in.
function makeHome(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-home-'));
  HOMES.push(home);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(
      path.join(home, '.claude', 'build-loop.config.json'),
      typeof config === 'string' ? config : JSON.stringify(config, null, 2)
    );
  }
  return home;
}

function run(home, args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

let failed = 0;
let total = 0;
function check(what, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${what}`);
    console.log(`        ${error.message}`);
  }
}

check('every root existing is reported, and exits 0', () => {
  const home = makeHome(undefined);
  const live = path.join(home, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(
    path.join(home, '.claude', 'build-loop.config.json'),
    JSON.stringify({ roots: [{ name: 'live', path: live, kind: 'skill' }] })
  );
  const out = run(home, ['check']);
  assert.strictEqual(out.code, 0, `expected 0, got ${out.code}`);
  assert.match(out.stdout, /Every configured root exists/, 'did not confirm the roots are there');
});

check('one dead root among several is reported, and exits 3', () => {
  const home = makeHome();
  const live = path.join(home, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(
    path.join(home, '.claude', 'build-loop.config.json'),
    JSON.stringify({ roots: [
      { name: 'live', path: live, kind: 'skill' },
      { name: 'gone', path: path.join(home, 'gone'), kind: 'plugin-repo' },
    ] })
  );
  const out = run(home, ['check']);
  assert.strictEqual(out.code, 3, `one dead root of two should exit 3, got ${out.code}`);
  assert.match(out.stdout, /Root 'gone'/, 'did not name the dead root');
  assert.doesNotMatch(out.stdout, /None of the configured roots/, 'claimed every root was dead');
});

check('every root being dead exits 4 and says there is nothing to scan', () => {
  const home = makeHome({ roots: [{ name: 'gone', path: '/nonexistent/one', kind: 'skill' }] });
  const out = run(home, ['check']);
  assert.strictEqual(out.code, 4, `all dead should exit 4, got ${out.code}`);
  assert.match(out.stdout, /None of the configured roots exist/, 'did not report the all-dead case');
});

check('the dead-root message names the root and the path it points at', () => {
  const home = makeHome({ roots: [
    { name: 'alpha', path: '/nonexistent/alpha', kind: 'skill' },
    { name: 'beta', path: '/nonexistent/beta', kind: 'skill' },
  ] });
  const out = run(home, ['check']);
  assert.match(out.stdout, /Root 'alpha' points at \/nonexistent\/alpha/, 'alpha not named with its path');
  assert.match(out.stdout, /Root 'beta' points at \/nonexistent\/beta/, 'beta not named with its path');
});

check('a file where a root should be does not count as existing', () => {
  const home = makeHome();
  const notADir = path.join(home, 'imposter');
  fs.writeFileSync(notADir, 'this is a file');
  fs.writeFileSync(
    path.join(home, '.claude', 'build-loop.config.json'),
    JSON.stringify({ roots: [{ name: 'imposter', path: notADir, kind: 'skill' }] })
  );
  const out = run(home, ['check']);
  assert.strictEqual(out.code, 4, 'a plain file was accepted as a root');
});

check('a tilde is expanded rather than taken literally', () => {
  const home = makeHome();
  fs.mkdirSync(path.join(home, 'tilde-root'));
  fs.writeFileSync(
    path.join(home, '.claude', 'build-loop.config.json'),
    JSON.stringify({ roots: [{ name: 'tilde', path: '~/tilde-root', kind: 'skill' }] })
  );
  const out = run(home, ['check']);
  assert.strictEqual(out.code, 0, 'the tilde path was not expanded to the home directory');
  const listed = JSON.parse(run(home, ['list']).stdout);
  assert.strictEqual(listed.roots[0].path, path.join(home, 'tilde-root'), 'expanded path not reported');
  assert.strictEqual(listed.roots[0].configured, '~/tilde-root', 'lost what the config actually said');
});

check('no config at all falls back to the documented defaults', () => {
  const home = makeHome(undefined);
  const listed = JSON.parse(run(home, ['list']).stdout);
  assert.strictEqual(listed.usedDefaults, true, 'did not flag that defaults were used');
  assert.deepStrictEqual(
    listed.roots.map((r) => r.name).sort(),
    ['commands', 'hooks', 'personal'],
    'the defaults drifted from the three in SCHEMA.md'
  );
});

check('a corrupt config is refused rather than silently defaulted', () => {
  const home = makeHome('{ this is not json');
  const out = run(home, ['check']);
  assert.strictEqual(out.code, 1, `a corrupt config should exit 1, got ${out.code}`);
  assert.match(out.stderr, /not valid JSON/, 'did not say what was wrong with it');
  assert.doesNotMatch(out.stdout, /personal/, 'fell back to the defaults, hiding the real root');
});

check('skillRoots with no roots is read as roots of kind skill', () => {
  const home = makeHome();
  const live = path.join(home, 'legacy');
  fs.mkdirSync(live);
  fs.writeFileSync(
    path.join(home, '.claude', 'build-loop.config.json'),
    JSON.stringify({ skillRoots: [{ name: 'legacy', path: live }] })
  );
  const listed = JSON.parse(run(home, ['list']).stdout);
  assert.strictEqual(listed.legacy, 'skillRoots', 'did not report reading a pre-v2 config');
  assert.strictEqual(listed.roots[0].kind, 'skill', 'a skillRoots entry is kind skill');
});

check('filtering by kind does not hide a dead root from the exit code', () => {
  const home = makeHome();
  const live = path.join(home, 'skills-root');
  fs.mkdirSync(live);
  fs.writeFileSync(
    path.join(home, '.claude', 'build-loop.config.json'),
    JSON.stringify({ roots: [
      { name: 'skills', path: live, kind: 'skill' },
      { name: 'gone', path: path.join(home, 'gone'), kind: 'plugin-repo' },
    ] })
  );
  const out = run(home, ['list', '--kind', 'skill']);
  assert.strictEqual(out.code, 3, 'filtering the output suppressed the dead root in the exit code');
  const listed = JSON.parse(out.stdout);
  assert.strictEqual(listed.roots.length, 1, 'the filter did not apply to the listed roots');
  assert.strictEqual(listed.missing.length, 1, 'missing was filtered too, so nothing reported it');
});

check('an unknown option is refused rather than becoming a silent boolean', () => {
  const home = makeHome({ roots: [{ name: 'x', path: '/nonexistent/x', kind: 'skill' }] });
  const out = run(home, ['list', '--bogus', 'value']);
  assert.strictEqual(out.code, 1, 'an unknown option was accepted');
  assert.match(out.stderr, /unknown option --bogus/, 'did not name the bad option');
});

check('check and list agree about which roots are missing', () => {
  const home = makeHome({ roots: [
    { name: 'a', path: '/nonexistent/a', kind: 'skill' },
    { name: 'b', path: '/nonexistent/b', kind: 'skill' },
  ] });
  const checked = run(home, ['check']);
  const listed = JSON.parse(run(home, ['list']).stdout);
  assert.strictEqual(checked.code, 4, 'check disagreed about the all-dead case');
  assert.strictEqual(listed.missing.length, 2, 'list did not report both as missing');
  assert.strictEqual(listed.allMissing, true, 'list did not flag the all-dead case');
});

// --- the wiring, not the script -----------------------------------------
//
// The script being right is the easy half. Every finding on PR #42 was in the
// skills the locked writer was bolted into rather than in the writer, because
// prose has no compiler. These two pin the same seam for this one.

const SKILLS = path.join(__dirname, '..', 'plugins', 'build-loop', 'skills');

function skillDirs() {
  return fs.readdirSync(SKILLS).filter((d) => fs.existsSync(path.join(SKILLS, d, 'SKILL.md')));
}

function skillText(name) {
  return fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
}

check('every skill that calls roots.js is allowed to run it', () => {
  // A skill with no allowed-tools line is unrestricted, so it can already run
  // node. Only a skill that opts into a list has to name it, and one that names
  // a command it cannot run is broken in the worst way: the instruction reads
  // correctly and fails at the moment of use.
  const offending = skillDirs().filter((name) => {
    const text = skillText(name);
    if (!/roots\.js"? (check|list)/.test(text)) return false;
    const frontmatter = text.slice(0, text.indexOf('---', 4));
    if (!/^allowed-tools:/m.test(frontmatter)) return false;
    return !/Bash\(node:\*\)/.test(frontmatter);
  });
  assert.deepStrictEqual(
    offending, [],
    `these call roots.js and do not grant Bash(node:*): ${offending.join(', ')}`
  );
});

check('every skill that reads the config checks the roots exist', () => {
  // This is the whole bug. Three skills carried a guard and three did not, and
  // nothing anywhere said which was which, so the gap was invisible until a
  // root moved. Reading the config is the trigger: if a skill resolves paths
  // against these roots, it has to know whether they are there.
  const offending = skillDirs().filter((name) => {
    const text = skillText(name);
    if (!/build-loop\.config\.json/.test(text)) return false;
    return !/roots\.js"? check/.test(text);
  });
  assert.deepStrictEqual(
    offending, [],
    `these read build-loop.config.json and never check the roots: ${offending.join(', ')}`
  );
});

check('no skill still describes the check it now delegates', () => {
  // The paragraph each skill used to carry said the all-dead case out loud.
  // Left next to a call that reports the same thing, a reader cannot tell which
  // one is in force, and the two drift apart from the first edit onwards. This
  // is the failure mode that put two descriptions of the retired write sequence
  // into the skills on PR #42.
  const offending = skillDirs().filter((name) =>
    /None of the configured roots exist/.test(skillText(name)));
  assert.deepStrictEqual(
    offending, [],
    `these still spell out the all-dead message instead of relaying roots.js: ${offending.join(', ')}`
  );
});

for (const home of HOMES) fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
