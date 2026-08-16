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

// stdio pipes the child's stderr rather than letting it through to ours.
// execFileSync captures it either way, but without this it is also echoed to
// the parent's stderr, and run-all.js takes the last non-empty line of a
// suite's output as its summary. A passing suite then reports itself with an
// error string. queue-locking.test.js has the same symptom for the same reason.
function run(home, args, cwd) {
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  if (cwd) opts.cwd = cwd;
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [SCRIPT, ...args], opts), stderr: '' };
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
  assert.match(out.stdout, /not valid JSON/, 'did not say what was wrong with it');
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

check('an absent default is its own exit code, not 0 and not 3', () => {
  // Three attempts at this one condition, which is why it now has a code of its
  // own. First it exited 3 and was reported as breakage, which described a
  // healthy machine as damaged. Then it exited 0, which told apply-fix a root
  // existed when it did not. Both readings were trying to answer two questions
  // with one number: is the directory there, and is anyone at fault for it.
  // DEFAULTS_ABSENT answers the second separately so callers stop inferring it.
  const home = makeHome(undefined);
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  const out = run(home, ['check']);
  assert.strictEqual(out.code, 5, `an absent default has its own code, got ${out.code}`);
  assert.notStrictEqual(out.code, 0, 'an absent directory reported as entirely fine');
  assert.notStrictEqual(out.code, 3, 'a path nobody chose reported as a configured root having moved');
  assert.doesNotMatch(out.stdout, /orphaned/, 'threatened the user about a path they never chose');
  assert.match(out.stdout, /normal/, 'did not say the absence was expected');
});

check('a configured root that moved keeps exit 3, and is not softened', () => {
  const home = makeHome();
  const live = path.join(home, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(
    path.join(home, '.claude', 'build-loop.config.json'),
    JSON.stringify({ roots: [
      { name: 'live', path: live, kind: 'skill' },
      { name: 'chosen', path: path.join(home, 'chosen'), kind: 'plugin-repo' },
    ] })
  );
  const out = run(home, ['check']);
  assert.strictEqual(out.code, 3, `a configured root that moved is a 3, got ${out.code}`);
  assert.match(out.stdout, /orphaned/, 'dropped the consequence for a path somebody chose');
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
    assert.match(out.stdout, /must hold a JSON object/, `config ${body} did not explain itself`);
    assert.doesNotMatch(out.stdout, /at Object\.|at Module\./, `config ${body} printed a stack trace`);
    assert.strictEqual(out.stderr, '', `config ${body} wrote to stderr, which no skill reads`);
  }
});

check('an empty roots array is refused rather than read as nothing missing', () => {
  for (const key of ['roots', 'skillRoots']) {
    const home = makeHome({ [key]: [] });
    const out = run(home, ['check']);
    assert.strictEqual(out.code, 1, `empty ${key} should exit 1, got ${out.code}`);
    assert.match(out.stdout, /empty/, `empty ${key} did not say what was wrong`);
    assert.doesNotMatch(out.stdout, /Every configured root exists/, `empty ${key} reported success`);
  }
});

check('an empty scope value is refused, not read as no scope at all', () => {
  // --name= parses to '', which is what a skill produces the moment it
  // interpolates a field that turned out to be empty. Treated as falsy it
  // skipped the filter, so a caller asking about one root was quietly answered
  // about all of them: the exact inference --name exists to remove.
  const home = makeHome(undefined);
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  for (const arg of ['--name=', '--kind=']) {
    const out = run(home, ['check', arg]);
    assert.strictEqual(out.code, 1, `${arg} was accepted, got ${out.code}`);
    assert.match(out.stdout, /empty value/, `${arg} did not say what was wrong`);
    assert.doesNotMatch(out.stdout, /default locations are in use/, `${arg} answered the broad question instead`);
  }
});

check('an unknown kind value is refused rather than matching nothing', () => {
  // A typo filtered to zero roots and returned "nothing to scan", which every
  // caller treats as a reason to stop. The option names were validated and the
  // values were not, which is the same "a typo that is ignored is a caller
  // believing it asked for something it did not" this parser already argues.
  const home = makeHome(undefined);
  const out = run(home, ['check', '--kind', 'skil']);
  assert.strictEqual(out.code, 1, `an unknown kind should exit 1, got ${out.code}`);
  assert.match(out.stdout, /unknown kind "skil"/, 'did not name the bad value');
  assert.match(out.stdout, /skill/, 'did not list what the valid kinds are');
});

check('a roots key of the wrong type says so, rather than blaming a missing key', () => {
  for (const body of [{ roots: { a: 1 } }, { roots: 'a string' }, { skillRoots: 7 }]) {
    const home = makeHome(body);
    const out = run(home, ['check']);
    assert.strictEqual(out.code, 1, `${JSON.stringify(body)} should exit 1, got ${out.code}`);
    assert.match(out.stdout, /rather than an array/, `${JSON.stringify(body)} did not describe the real problem`);
    assert.doesNotMatch(out.stdout, /has neither/, `${JSON.stringify(body)} blamed a key that is present`);
  }
});

check('two roots may not share a name', () => {
  // --name filters by it, so a duplicate made the answer to "does this root
  // exist" two things at once: cmdCheck described the first match while codeFor
  // graded both, printing "Root 'dup' exists" alongside a non-zero exit.
  const home = makeHome();
  const live = path.join(home, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(
    path.join(home, '.claude', 'build-loop.config.json'),
    JSON.stringify({ roots: [
      { name: 'dup', path: live, kind: 'skill' },
      { name: 'dup', path: path.join(home, 'gone'), kind: 'skill' },
    ] })
  );
  const out = run(home, ['check', '--name', 'dup']);
  assert.strictEqual(out.code, 1, `a duplicate name should exit 1, got ${out.code}`);
  assert.match(out.stdout, /more than one root is named 'dup'/, 'did not name the collision');
  assert.doesNotMatch(out.stdout, /exists at/, 'reported one root as fine while grading two');
});

check('an unknown option is refused rather than becoming a silent boolean', () => {
  const home = makeHome({ roots: [{ name: 'x', path: '/nonexistent/x', kind: 'skill' }] });
  const out = run(home, ['list', '--bogus', 'value']);
  assert.strictEqual(out.code, 1, 'an unknown option was accepted');
  assert.match(out.stdout, /unknown option --bogus/, 'did not name the bad option');
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

check('every caller has a rule for a config that cannot be read', () => {
  // Exit 1 writes an explanation and stops. Two skills enumerated only 0, 3 and
  // 4, so a corrupt config had no rule at all and they carried on against
  // guessed locations. An unhandled exit code in prose is not a crash, it is a
  // skill quietly doing the wrong thing.
  const offending = skillDirs().filter((name) => {
    const text = skillText(name);
    if (!/roots\.js"? check/.test(text)) return false;
    return !/Exit 1|Anything else/.test(text);
  });
  assert.deepStrictEqual(
    offending, [],
    `these call roots.js and never say what to do on exit 1: ${offending.join(', ')}`
  );
});

check('every broad caller has a rule for an absent default', () => {
  // Exit 5 exists so a caller can tell "someone's path moved" from "a standard
  // location was never created". A skill that only handles 3 either treats a
  // normal machine as broken or ignores a real absence, and both readings have
  // already shipped once each.
  const offending = skillDirs().filter((name) => {
    const text = skillText(name);
    if (!/roots\.js"? check/.test(text)) return false;
    if (/roots\.js"? check --name/.test(text)) return false;  // --name can never return 5
    return !/Exit 5/.test(text);
  });
  assert.deepStrictEqual(
    offending, [],
    `these run a broad check and never say what to do on exit 5: ${offending.join(', ')}`
  );
});

check('find-skill does not silently default underneath the check', () => {
  // The check refused a corrupt config and the Python below it caught every
  // exception and routed against ~/.claude/skills anyway, so the skill relayed
  // "the config could not be read" and then behaved as though it had. A guard
  // that the code beneath it ignores is worse than no guard: it reads as
  // handled.
  const text = skillText('find-skill');
  assert.doesNotMatch(text, /except Exception:\s*\n\s*roots = DEFAULT/, 'still swallows any config error and defaults');
  assert.match(text, /if not os\.path\.exists\(CONFIG\)/, 'no longer distinguishes an absent config from a broken one');
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


// --- the shared layout ------------------------------------------------------
//
// The bug this pins: PR #101 added `bin/` on 2026-08-14 as a new place a plugin
// keeps executable code. /audit-deps and /built-check each carried their own
// glob block, in prose, and neither was updated. `bin/hook-node` is the file
// every hook in every plugin starts through, and it appeared in DEPS.json zero
// times, so a change to it reported nothing at risk.
//
// Adding bin/ to the list is the small half. The half that lasts is the row
// below that reconciles the list against what is actually on disk, so the next
// directory somebody adds fails here instead of going missing for a month.

const REPO = path.join(__dirname, '..');
const { PLUGIN_LAYOUT, REPO_LAYOUT, NOT_MAPPED } = require(SCRIPT);

check('the layout covers bin/, the directory that went missing', () => {
  const out = run(makeHome(), ['layout', '--root', REPO]).stdout;
  assert.match(out, /plugins\/\*\/bin\/\*/, 'listing mode does not reach bin/');
  const found = run(makeHome(), ['layout', '--root', REPO, '--slug', 'hook-node']).stdout;
  assert.match(found, /plugins\/\*\/bin\/hook-node/, 'find mode does not reach bin/');
});

// The two skills asking the same question have to get the same set back. Paths
// cannot be compared directly, because find mode interpolates the slug and turns
// `skills/*/` into `skills/<slug>/`. What has to match is the rows themselves:
// same count, same order, same kinds. A later special case in one mode and not
// the other is what this catches.
check('listing and finding cover the same rows in the same order', () => {
  const kindsIn = (out) => out.split('\n').filter(Boolean).map((l) => l.match(/# kind: (\S+)/)[1]);
  // Finding emits one line per pattern and a row may carry two, the bare name
  // and the name with an extension, so consecutive repeats collapse before the
  // comparison. What has to hold is that the rows appear, in order, in both.
  const collapse = (a) => a.filter((k, i) => k !== a[i - 1]);
  const listing = kindsIn(run(makeHome(), ['layout', '--root', REPO]).stdout);
  const finding = kindsIn(run(makeHome(), ['layout', '--root', REPO, '--slug', 'x']).stdout);
  assert.deepStrictEqual(collapse(finding), collapse(listing));
  assert.strictEqual(
    listing.length, PLUGIN_LAYOUT.length + REPO_LAYOUT.length,
    'a row in the layout is not reaching the listing'
  );
});

// A prefix match here reaches files nobody named. /flag-issue records what it
// finds and /apply-fix opens and edits that path, so `queue` matching
// queue-locking.test.js is a correction applied to the wrong file. Checked as a
// property of every pattern rather than by naming the two that were loose.
check('finding matches an exact name, or that name with an extension, never a prefix', () => {
  const patterns = [...PLUGIN_LAYOUT, ...REPO_LAYOUT].flatMap((r) => r.find);
  const loose = patterns.filter((p) => /<slug>\*/.test(p));
  assert.deepStrictEqual(
    loose, [],
    'these match any name beginning with the slug, which reaches files nobody asked about'
  );
});

// Each command takes its own options. Pooled, `check --root X` was accepted and
// did nothing, which is the silent acceptance this file refuses everywhere else.
check('an option meant for another command is refused rather than ignored', () => {
  const bad = run(makeHome(), ['check', '--root', '/nonsense']);
  assert.match(bad.stdout, /check does not take --root/);
  assert.notStrictEqual(bad.code, 0, 'a refused option still exited 0');
  const alsoBad = run(makeHome(), ['layout', '--kind', 'skill']);
  assert.match(alsoBad.stdout, /layout does not take --kind/);
});

// Every row of the layout reaches the output, named by its own directory, so a
// row cannot be silently dropped while the count still adds up.
check('every directory in the layout appears in the listing', () => {
  const out = run(makeHome(), ['layout', '--root', REPO]).stdout;
  const missing = PLUGIN_LAYOUT.filter((r) => !out.includes(`/plugins/*/${r.dir}/`)).map((r) => r.dir);
  assert.deepStrictEqual(missing, [], 'these rows are in roots.js but not in what it prints');
});

// The guard. Every directory a plugin actually has is either mapped or named as
// deliberately unmapped. A new one is neither, so it fails here.
check('every directory a plugin has is mapped or explicitly excluded', () => {
  const mapped = new Set(PLUGIN_LAYOUT.map((r) => r.dir));
  const excluded = new Set(Object.keys(NOT_MAPPED));
  const unaccounted = new Set();
  const pluginsDir = path.join(REPO, 'plugins');
  for (const plugin of fs.readdirSync(pluginsDir)) {
    const dir = path.join(pluginsDir, plugin);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (mapped.has(entry.name) || excluded.has(entry.name)) continue;
      unaccounted.add(`${plugin}/${entry.name}`);
    }
  }
  assert.deepStrictEqual(
    [...unaccounted].sort(), [],
    'these exist in a plugin and are in neither PLUGIN_LAYOUT nor NOT_MAPPED in roots.js. '
    + 'Add the directory to the layout so both skills scan it, or to NOT_MAPPED with the reason'
  );
});

// A glob that matches nothing is indistinguishable from a directory that holds
// nothing, which is the failure mode this whole file exists for. Checked only
// where the directory is present, since `commands/` is a legal place no plugin
// currently uses.
check('every listing that names a present directory actually matches something', () => {
  const empty = [];
  for (const row of PLUGIN_LAYOUT) {
    const present = fs.readdirSync(path.join(REPO, 'plugins'))
      .filter((p) => fs.existsSync(path.join(REPO, 'plugins', p, row.dir)));
    if (present.length === 0) continue;
    const hits = execFileSync('sh', ['-c', `ls -1 ${REPO}/plugins/*/${row.list} 2>/dev/null | wc -l`], { encoding: 'utf8' });
    if (Number(hits.trim()) === 0) empty.push(row.dir);
  }
  assert.deepStrictEqual(empty, [], 'these directories exist but their glob finds nothing in them');
});

// Anti-drift, and the reason the list moved at all. A skill writing its own copy
// again is how this recurs, and calling roots.js does not excuse a copy sitting
// beside the call: `bin/` went missing while every skill involved looked correct.
//
// Matched on the command rather than on the path, because all three files
// discuss `plugins/*/` in prose on purpose, explaining why `tests/` cannot be
// reached from it. An earlier version of this row wanted a dash flag and so
// missed a bare `ls <root.path>/plugins/*/hooks/{target}` entirely, which is the
// exact line it exists to catch.
check('no skill has gone back to writing its own plugin-repo globs', () => {
  const dirs = PLUGIN_LAYOUT.map((r) => r.dir).join('|');
  const pattern = new RegExp(String.raw`^\s*ls\b[^\n]*plugins/\*/(${dirs})/`, 'm');
  const offending = ['audit-deps', 'built-check', 'flag-issue']
    .map((name) => path.join(REPO, 'plugins', 'build-loop', 'skills', name, 'SKILL.md'))
    .filter((f) => pattern.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(REPO, f));
  assert.deepStrictEqual(
    offending, [],
    `these spell out plugin-repo globs instead of calling roots.js layout: ${offending.join(', ')}`
  );
});

// --- covers: could this item have been looked for at all -------------------
//
// /built-check reported "no sign of it" for 12 items on 2026-08-14 and had
// never searched for seven of them, because their destination is a repository
// that is not a configured root. "Searched and not found" and "not searched"
// are opposite findings and the report gave them the same words.

{
  // A real checkout with a real origin, because an owner-qualified destination
  // is answered by the remote and by nothing else. A fake directory with the
  // right name is exactly what must NOT satisfy one.
  const home = makeHome();
  const checkout = path.join(home, 'Projects', 'infra-plugins');
  fs.mkdirSync(checkout, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/sarahcallmesmadds/infra-plugins.git');
  fs.writeFileSync(
    path.join(home, '.claude', 'build-loop.config.json'),
    JSON.stringify({
      roots: [
        { name: 'infra-plugins', path: '~/Projects/infra-plugins', kind: 'plugin-repo' },
        { name: 'personal', path: '~/.claude/skills', kind: 'skill' },
      ],
    }, null, 2)
  );

  check('a destination inside a configured root is covered, and names it', () => {
    const { code, stdout } = run(home, ['covers', '--where', 'sarahcallmesmadds/infra-plugins']);
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout.trim(), 'covered infra-plugins');
  });

  check('a bare root name, with no owner, is covered too', () => {
    assert.strictEqual(
      run(home, ['covers', '--where', 'infra-plugins']).stdout.trim(), 'covered infra-plugins'
    );
  });

  check('a destination in a repository nobody configured is not covered', () => {
    const { stdout } = run(home, ['covers', '--where', 'sarahcallmesmadds/skills']);
    assert.strictEqual(stdout.trim(), 'not-covered');
  });

  check('a different owner cannot borrow an existing checkout by repository name', () => {
    assert.strictEqual(
      run(home, ['covers', '--where', 'someoneelse/infra-plugins']).stdout.trim(),
      'not-covered'
    );
  });

  check('ordinary destination prose is unqualified, not outside every root', () => {
    for (const where of [
      'smadds marketplace',
      'the company marketplace',
      'somewhere-else',
      'the marketplace, decide by 8/14',
      'the docs and/or the site',
      'run /built-check first',
    ]) {
      assert.strictEqual(
        run(home, ['covers', '--where', where]).stdout.trim(), 'unqualified',
        `${where} was treated as proof that no configured root could hold it`
      );
    }
  });

  check('GitHub URL spellings preserve the owner/repository pair', () => {
    for (const where of [
      'https://github.com/sarahcallmesmadds/skills',
      'github.com/sarahcallmesmadds/skills',
    ]) {
      assert.strictEqual(
        run(home, ['covers', '--where', where]).stdout.trim(), 'not-covered',
        `${where} let its repo tail masquerade as the local skills root`
      );
    }
  });

  check('--where-file reads free text without shell interpolation', () => {
    const whereFile = path.join(home, 'where.txt');
    fs.writeFileSync(whereFile, 'the skills root with "quotes", `ticks`, and $(commands)\n');
    assert.strictEqual(
      run(home, ['covers', '--where-file', whereFile]).stdout.trim(), 'covered personal'
    );
    assert.strictEqual(
      run(home, ['covers', '--where', 'skills', '--where-file', whereFile]).code, 1,
      'ambiguous inline and file inputs were silently accepted'
    );
  });

  check('a repo name is not satisfied by a local directory that shares it', () => {
    // The case that started this. sarahcallmesmadds/skills is a repository on
    // GitHub. ~/.claude/skills is a local directory whose last segment happens
    // to match. Treating them as the same thing reports the five items that
    // cannot be searched as searched, which is the original bug wearing a
    // different hat. An owner-qualified name is answered by the remote only.
    const { stdout } = run(home, ['covers', '--where',
      'sarahcallmesmadds/skills, moving out of _work-skills-rebuild-ref/v1-source/']);
    assert.strictEqual(stdout.trim(), 'not-covered');
  });

  check('but a bare "skills" still means the local root somebody configured', () => {
    assert.strictEqual(
      run(home, ['covers', '--where', 'the skills root']).stdout.trim(), 'covered personal'
    );
  });

  check('an item that records no destination says so, rather than not-covered', () => {
    // Two different reasons nothing was searched, and the remedies differ. One
    // wants a root adding, the other wants the item filling in.
    assert.strictEqual(run(home, ['covers', '--where', '']).stdout.trim(), 'no-destination');
  });

  check('omitting --where means the same as passing it empty', () => {
    // A skill interpolating an empty field produces --where "". Every other
    // option here refuses an empty value on purpose, and this one must not,
    // or the caller has to build the argument list conditionally to say the
    // one thing it most needs to say.
    assert.strictEqual(run(home, ['covers']).stdout.trim(), 'no-destination');
  });

  check('matching is on whole segments, so prose containing skills is unqualified', () => {
    // `where` is free text and routinely a whole sentence. A substring test
    // would call every one of these covered.
    for (const where of ['hq-skills', '_work-skills-rebuild-ref/v1-source', 'my-skills-repo']) {
      assert.strictEqual(
        run(home, ['covers', '--where', where]).stdout.trim(),
        where.includes('/') ? 'not-covered' : 'unqualified',
        `${where} was treated as the 'personal' root at ~/.claude/skills`
      );
    }
  });

  check('the last segment of a root path counts, not only its name', () => {
    // Somebody writing `where` by hand types the directory, not the name a
    // config file gave it. They are usually the same and are allowed not to be.
    const h = makeHome({ roots: [{ name: 'work', path: '~/Projects/fermat-work-index', kind: 'skill' }] });
    fs.mkdirSync(path.join(h, 'Projects', 'fermat-work-index'), { recursive: true });
    assert.strictEqual(
      run(h, ['covers', '--where', 'fermat-work-index']).stdout.trim(), 'covered work'
    );
  });

  check('all six answers exit 0, because none of them is a failure', () => {
    // A caller loops this over a dozen items. An exit code that varies by
    // answer makes "this item has no destination" indistinguishable from "the
    // config is broken" at the call site.
    for (const args of [['covers', '--where', 'sarahcallmesmadds/infra-plugins'],
      ['covers', '--where', 'somewhere-else'], ['covers']]) {
      assert.strictEqual(run(home, args).code, 0, `${args.join(' ')} did not exit 0`);
    }
  });

  check('a destination written as a path is covered, in every anchored form', () => {
    // Review round 1. The pair rule was written for owner/repo and any
    // filesystem `where` matches the same shape, so the final folder name was
    // discarded before the comparison and a destination genuinely inside a
    // configured root came back not-covered. `where` is documented as free
    // text, so a path form is ordinary rather than exotic.
    for (const where of [
      '~/Projects/infra-plugins',
      'Projects/infra-plugins',
      '~/Projects/infra-plugins/plugins/build-loop',
      'somewhere under ~/Projects/infra-plugins/, probably',
      'It goes in ~/Projects/infra-plugins.',
      'It goes in ~/Projects/infra-plugins:',
      'It goes in ~/Projects/infra-plugins!',
      'It goes in ~/Projects/infra-plugins?',
    ]) {
      assert.strictEqual(
        run(home, ['covers', '--where', where]).stdout.trim(), 'covered infra-plugins',
        `${where} was reported as outside every configured root`
      );
    }
  });

  check('a relative folder path can identify a configured plugin repository by its tail', () => {
    const h = makeHome({ roots: [
      { name: 'infra-plugins', path: '~/dev/infra-plugins', kind: 'plugin-repo' },
      { name: 'personal', path: '~/.claude/skills', kind: 'skill' },
    ] });
    fs.mkdirSync(path.join(h, 'dev', 'infra-plugins'), { recursive: true });
    fs.mkdirSync(path.join(h, '.claude', 'skills'), { recursive: true });
    const checkout = path.join(h, 'dev', 'infra-plugins');
    execFileSync('git', ['-C', checkout, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin',
      'https://github.com/sarahcallmesmadds/infra-plugins.git'], { stdio: 'ignore' });
    assert.strictEqual(
      run(h, ['covers', '--where', 'Projects/infra-plugins']).stdout.trim(),
      'covered infra-plugins'
    );
    assert.strictEqual(
      run(h, ['covers', '--where', 'sarahcallmesmadds/skills']).stdout.trim(),
      'not-covered',
      'an owner-qualified pair fell through to a generic skill root by its tail'
    );
  });

  check('an exact configured path ending in punctuation wins before prose trimming', () => {
    const h = makeHome({ roots: [
      { name: 'punctuated', path: '~/Projects/infra-plugins.', kind: 'plugin-repo' },
    ] });
    fs.mkdirSync(path.join(h, 'Projects', 'infra-plugins.'), { recursive: true });
    assert.strictEqual(
      run(h, ['covers', '--where', '~/Projects/infra-plugins.']).stdout.trim(),
      'covered punctuated'
    );
  });

  check('a path outside every root is still not covered', () => {
    // The negative half. Without it the fix above passes by calling everything
    // with a slash in it covered.
    assert.strictEqual(
      run(home, ['covers', '--where', '~/Projects/something-else']).stdout.trim(), 'not-covered'
    );
  });

  check('bare path anchors in free text do not resolve to process directories', () => {
    // Review round 3. Resolving a stripped '/' produces cwd, while '~/', './'
    // and '../' produce other broad directories that can contain every root.
    // None names a particular destination, so none earns covered.
    const cwd = path.join(home, 'Projects');
    for (const where of [
      'the repo / the hooks dir',
      'somewhere under ~/',
      'maybe ./',
      'perhaps ../',
    ]) {
      assert.strictEqual(
        run(home, ['covers', '--where', where], cwd).stdout.trim(),
        'unqualified',
        `${where} resolved a bare anchor into a configured root`
      );
    }
  });

  check('a configured root that has moved says so, rather than covered', () => {
    // Review round 1, raised as a flag. covers matched every configured root
    // whether or not it was on disk, so it answered "covered" for the exact
    // 2026-08-01 failure this script exists for, in the same run where check
    // exits non-zero about the same root. The two cannot contradict each other.
    const h = makeHome({ roots: [{ name: 'gone', path: '/nonexistent/gone', kind: 'plugin-repo' }] });
    assert.strictEqual(run(h, ['covers', '--where', 'gone']).stdout.trim(), 'root-missing gone');
    assert.notStrictEqual(run(h, ['check']).code, 0, 'check and covers disagree about the same root');
  });

  check('an absent built-in default is not described as a moved configured root', () => {
    const h = makeHome();
    assert.strictEqual(
      run(h, ['covers', '--where', 'skills']).stdout.trim(),
      'default-missing personal'
    );
    const checked = run(h, ['check']);
    assert.notStrictEqual(checked.code, 0);
    assert.ok(/There is no config file/.test(checked.stdout + checked.stderr));
  });

  check('an owner-qualified destination still identifies a moved configured root', () => {
    // Review round 3. The missing checkout cannot reveal its git remote, so the
    // exact configured root name/path basename is the remaining durable clue.
    const h = makeHome({ roots: [
      { name: 'infra-plugins', path: '~/Projects/infra-plugins', kind: 'plugin-repo' },
      { name: 'personal', path: '~/.claude/skills', kind: 'skill' },
    ] });
    fs.mkdirSync(path.join(h, '.claude', 'skills'), { recursive: true });
    for (const where of [
      'sarahcallmesmadds/infra-plugins',
      'https://github.com/sarahcallmesmadds/infra-plugins',
    ]) {
      assert.strictEqual(
        run(h, ['covers', '--where', where]).stdout.trim(),
        'root-missing infra-plugins',
        `${where} was mistaken for a repository nobody configured`
      );
    }
  });

  check('covers still refuses an option that belongs to another command', () => {
    // Every message this script produces arrives on stdout, refusals included,
    // because a skill relays what it printed rather than reading a stream.
    const { code, stdout, stderr } = run(home, ['covers', '--slug', 'x']);
    assert.notStrictEqual(code, 0);
    assert.ok(/does not take --slug/.test(stdout + stderr), `output was: ${stdout}${stderr}`);
  });
}

for (const home of HOMES) fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
