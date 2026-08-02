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

check('--kind scopes the roots, the missing list and the exit code together', () => {
  // This asserted the opposite until Devin pointed out what it caused. Leaving
  // missing and the exit code global meant find-skill, which only ever reads
  // skill roots, warned about a missing hooks directory to someone asking which
  // skill to use. A caller that asks about one kind is asking about that kind.
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
  assert.strictEqual(out.code, 0, 'a dead root of another kind still drove the exit code');
  const listed = JSON.parse(out.stdout);
  assert.strictEqual(listed.roots.length, 1, 'the filter did not apply to the listed roots');
  assert.strictEqual(listed.missing.length, 0, 'missing was left global, so it names a root absent from roots');
  const checked = run(home, ['check', '--kind', 'skill']);
  assert.strictEqual(checked.code, 0, 'check disagreed with list about the same scope');
  assert.doesNotMatch(checked.stdout, /gone/, 'reported a root of a kind that was not asked about');
});

check('a kind nothing is configured for is nothing to scan, not success', () => {
  const home = makeHome();
  const live = path.join(home, 'repo');
  fs.mkdirSync(live);
  fs.writeFileSync(
    path.join(home, '.claude', 'build-loop.config.json'),
    JSON.stringify({ roots: [{ name: 'repo', path: live, kind: 'plugin-repo' }] })
  );
  const out = run(home, ['check', '--kind', 'skill']);
  assert.strictEqual(out.code, 4, 'having no root of the asked-about kind reported success');
  assert.match(out.stdout, /No root of kind skill is configured/, 'did not say why there was nothing');
});

check('an absent default is described as normal, in words, and still exits 3', () => {
  // SCHEMA.md says on a machine installing everything from marketplaces none of
  // the three defaults will exist, and that this is not an error. That is a
  // statement about wording, and an earlier version of this file read it as a
  // statement about the exit code: it returned 0, which told apply-fix the root
  // existed, and Step 8 then ran git against a path that was not there after the
  // target file had already been written.
  //
  // So both halves are asserted here. Gentle words, honest code.
  const home = makeHome(undefined);
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  const out = run(home, ['check']);
  assert.strictEqual(out.code, 3, `an absent default is still an absent directory, got ${out.code}`);
  assert.doesNotMatch(out.stdout, /orphaned/, 'threatened the user about a path they never chose');
  assert.match(out.stdout, /normal/, 'did not say the absence was expected');
});

check('scoping is what keeps an absent default quiet, not the exit code', () => {
  // find-skill reads skill roots only. On the common machine it must hear
  // nothing about hooks and commands, and that has to come from asking a
  // narrower question rather than from the answer being softened for everyone.
  const home = makeHome(undefined);
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  const out = run(home, ['check', '--kind', 'skill']);
  assert.strictEqual(out.code, 0, 'the skill root exists, so the scoped check should be clean');
  assert.doesNotMatch(out.stdout, /hooks|commands/, 'reported roots this caller never reads');
});

check('--name answers about one root, which is what a committer asks', () => {
  const home = makeHome(undefined);
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });

  const present = run(home, ['check', '--name', 'personal']);
  assert.strictEqual(present.code, 0, 'a root that exists was not reported as existing');
  assert.match(present.stdout, /Root 'personal' exists/, 'did not confirm the named root');

  // The regression this whole check exists for: a bare check on this machine
  // exits 3, but the question apply-fix has is about one root, and inferring a
  // narrow answer from a broad one is what let an absent root through.
  const absent = run(home, ['check', '--name', 'hooks']);
  assert.notStrictEqual(absent.code, 0, 'an absent root answered as though it were fine');
  assert.match(absent.stdout, /nowhere to work/, 'did not say the caller cannot work there');

  const unconfigured = run(home, ['check', '--name', 'no-such-root']);
  assert.notStrictEqual(unconfigured.code, 0, 'an unconfigured name answered as though it were fine');
  assert.match(unconfigured.stdout, /No root named 'no-such-root'/, 'did not name what it could not find');
});

check('every default being absent is still nothing to scan', () => {
  const home = makeHome(undefined);
  const out = run(home, ['check']);
  assert.strictEqual(out.code, 4, `no config and no defaults on disk should exit 4, got ${out.code}`);
  assert.match(out.stdout, /nothing to scan/, 'did not say there was nowhere to look');
});

check('a config that parses to something other than an object is refused in words', () => {
  // JSON.parse returns null for the literal text `null`. That reached
  // parsed.roots and threw a TypeError, so the skill relayed a Node stack trace
  // rather than the sentence written for this.
  for (const body of ['null', '[]', '42', '"a string"']) {
    const home = makeHome(body);
    const out = run(home, ['check']);
    assert.strictEqual(out.code, 1, `config ${body} should exit 1, got ${out.code}`);
    assert.match(out.stderr, /must hold a JSON object/, `config ${body} did not explain itself`);
    assert.doesNotMatch(out.stderr, /at Object\.|at Module\./, `config ${body} printed a stack trace`);
  }
});

check('an empty roots array is refused rather than read as nothing missing', () => {
  for (const key of ['roots', 'skillRoots']) {
    const home = makeHome({ [key]: [] });
    const out = run(home, ['check']);
    assert.strictEqual(out.code, 1, `empty ${key} should exit 1, got ${out.code}`);
    assert.match(out.stderr, /empty/, `empty ${key} did not say what was wrong`);
    assert.doesNotMatch(out.stdout, /Every configured root exists/, `empty ${key} reported success`);
  }
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

check('a skill that commits into one root asks about that root by name', () => {
  // apply-fix and revert-fix both run git inside the root named by the entry's
  // repo field. A bare check answers about every root, and "the others are
  // fine" is not an answer about the one you are about to write into. That gap
  // is how an absent default reached a git command as an all-clear.
  const offending = ['apply-fix', 'revert-fix'].filter((name) =>
    !/roots\.js"? check --name/.test(skillText(name)));
  assert.deepStrictEqual(
    offending, [],
    `these run git inside one root and do not ask about it by name: ${offending.join(', ')}`
  );
});

check('no skill claims a bare check proves a particular root exists', () => {
  // The claim apply-fix made at Step 8 after the first review round. It was
  // false for as long as a bare check could exit 0 with something missing, and
  // a sentence asserting a guarantee is worse than no sentence, because the
  // steps after it stop looking.
  const offending = skillDirs().filter((name) => {
    const text = skillText(name);
    if (!/roots\.js/.test(text)) return false;
    if (/roots\.js"? check --name/.test(text)) return false;
    return /known to exist|is known to be there/.test(text);
  });
  assert.deepStrictEqual(
    offending, [],
    `these claim a root is known to exist without having asked about it by name: ${offending.join(', ')}`
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

check('nothing in the plugin still describes the check it now delegates', () => {
  // The paragraph each skill used to carry said the all-dead case out loud.
  // Left next to a call that reports the same thing, a reader cannot tell which
  // one is in force, and the two drift apart from the first edit onwards. This
  // is the failure mode that put two descriptions of the retired write sequence
  // into the skills on PR #42.
  //
  // Reference documents count, and the first version of this check missed them:
  // it walked skills/ only, so the identical paragraph sat untouched in
  // SCHEMA.md, which the skills are told to read. Scoping a drift check to one
  // directory is how the drift survives it.
  const PLUGIN = path.join(__dirname, '..', 'plugins', 'build-loop');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.md$/.test(e.name)) files.push(full);
    }
  })(PLUGIN);

  const offending = files
    .filter((f) => /None of the configured roots exist/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(PLUGIN, f));
  assert.deepStrictEqual(
    offending, [],
    `these still spell out the all-dead message instead of relaying roots.js: ${offending.join(', ')}`
  );
});

for (const home of HOMES) fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
