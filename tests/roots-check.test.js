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
const { execFileSync, spawnSync } = require('child_process');

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
function run(home, args) {
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  };
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
  // apply-fix runs git inside the root named by the entry's repo field, in both
  // of its modes: apply mode to record the fix, revert mode to undo it. A bare
  // check answers about every root, and "the others are fine" is not an answer
  // about the one you are about to write into. That gap is how an absent default
  // reached a git command as an all-clear.
  //
  // revert-fix was the second name here until it folded into apply-fix as revert
  // mode. Both call sites survived the fold and both are inside the one file now,
  // so a check that only looked at the file would pass having lost one of them.
  //
  // The step each call lives in is asserted rather than named in a message. The
  // previous version put the step in the failure text only, and when the revert
  // guard moved from R5 to R2 the message kept saying R5: a maintainer sent to
  // the wrong step by a test that was still green. Naming a thing in prose is how
  // it goes stale; asserting it is how it cannot.
  const offending = ['apply-fix'].filter((name) =>
    !/roots\.js"? check --name/.test(skillText(name)));
  assert.deepStrictEqual(
    offending, [],
    `these run git inside one root and do not ask about it by name: ${offending.join(', ')}`
  );
});

check('apply-fix asks by name once per mode, not once in total', () => {
  // The guard the comment above promises. Folding revert-fix in turned two files
  // each holding one call site into one file holding two, and a single-match
  // regex cannot tell two from one. Apply mode asks at Step 2, before anything is
  // written; revert mode asks at Step R5, because Step 2 never ran on that path.
  // Losing either one puts a git command behind an unasked question.
  //
  // Split at the mode boundary rather than counted across the file. A count alone
  // is satisfied by any two occurrences, so both calls landing in apply mode, or
  // one of them being a mention in prose, would pass while the property this
  // names is broken. That is the shape of check this repository keeps having to
  // replace: one that passes while half of what it describes is gone.
  const text = skillText('apply-fix');

  // Anchored to the start of a line and required to be unique. Plain indexOf
  // would also match the heading quoted inside prose or a fenced block, and a
  // split at the wrong offset still yields one match per half, so the check
  // would pass while saying nothing. A second occurrence is the failure, not a
  // tie to break.
  const headings = [...text.matchAll(/^# Revert mode\s*$/gm)];
  assert.strictEqual(headings.length, 1,
    `apply-fix has ${headings.length} lines reading "# Revert mode", expected `
    + 'exactly one. With none the two modes cannot be told apart and every '
    + 'assertion below is measuring one undivided file; with more than one the '
    + 'split lands at the first, which may not be the mode boundary.');
  const boundary = headings[0].index;

  const applyMode = text.slice(0, boundary);
  const revertMode = text.slice(boundary);

  for (const [mode, section, step] of [
    ['apply', applyMode, 'Step 2'],
    ['revert', revertMode, 'Step R2'],
  ]) {
    // The heading this mode's root check must live under. Asserted first,
    // because every boundary below is found by splitting on headings: if the
    // heading is reworded the split silently stops working and the assertions
    // under it pass while measuring nothing.
    const heads = [...section.matchAll(/^## (Step [^\s—-]+)[^\n]*$/gm)];
    assert.ok(heads.some((h) => h[1] === step),
      `${mode} mode has no "## ${step}" heading. Headings found: `
      + `${heads.map((h) => h[1]).join(', ') || 'none'}. The checks below split on `
      + 'headings, so a renamed one turns them into assertions about nothing.');

    // And the call has to be under that heading, not merely somewhere in the
    // mode. A guard that moves to another step keeps the count at one.
    const askAt = section.search(/roots\.js"? check --name/);
    const owning = heads.filter((h) => h.index < askAt).pop();
    assert.ok(owning && owning[1] === step,
      `${mode} mode asks about its root under "${owning ? owning[1] : 'no heading'}" `
      + `but it belongs under "${step}". Apply mode asks before it writes; revert `
      + 'mode asks at R2 because Steps R3 and R4 quote the path to a person before '
      + 'any revert runs.');
    const asks = (section.match(/roots\.js"? check --name/g) || []).length;
    assert.strictEqual(asks, 1,
      `${mode} mode asks about a root by name ${asks} times, expected once at `
      + `${step}. A mode that stopped asking runs git inside a root nothing `
      + 'confirmed; a mode asking twice means the other mode lost its call.');

    const takes = (section.match(/roots\.js"? list --name/g) || []).length;
    assert.strictEqual(takes, 1,
      `${mode} mode takes a root path by name ${takes} times, expected once. `
      + 'A path taken without the matching check in the same mode is the ordering '
      + 'bug both modes name.');

    // Calling list and never saying what to do with the answer is how revert
    // mode shipped a git command with no directory: the call was present, the
    // count was right, and {repo_root} was bound nowhere in the section.
    //
    // Presence alone was not enough either. The next version passed on a file
    // whose binding sat at Step R5 while Steps R3 and R4 already put {repo_root}
    // into text shown to a person, so the placeholder was handed over with no
    // value behind it.
    //
    // But "the binding must precede every use" is too strict and fails a correct
    // file: apply mode writes the command block and then a one-line legend under
    // it, which is readable and fine. What actually went wrong in revert mode was
    // crossing a step boundary, using the value in one step and explaining it two
    // steps later. So the boundary is the step: whatever binds {repo_root} has to
    // arrive before the next "## Step" heading after its first use.
    //
    // Both wordings in this file are accepted, because pinning one phrase makes a
    // legitimate rewrite fail while changing nothing about the property.
    const BINDS = /\{repo_root\}`? is the (absolute )?`path`( of the root| this prints)?/;
    const bindsAt = section.search(BINDS);
    assert.ok(bindsAt >= 0,
      `${mode} mode never says what {repo_root} is. The path it looks up goes `
      + 'nowhere and every git command in the mode has no stated directory.');

    const firstUse = section.search(/\{repo_root\}/);
    assert.ok(firstUse >= 0, `${mode} mode never mentions {repo_root} at all.`);

    if (bindsAt > firstUse) {
      const between = section.slice(firstUse, bindsAt);
      const crossed = between.match(/\n## Step [^\n]*/g) || [];
      assert.deepStrictEqual(crossed, [],
        `${mode} mode first uses {repo_root} and only binds it ${crossed.length} `
        + `step heading(s) later, crossing:${crossed.join(';')}. A step that quotes `
        + 'the placeholder before anything defines it hands a person a command '
        + 'they cannot run.');
    }
  }
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
  const callers = skillDirs().filter((name) =>
    /roots\.js"? (?:check|list)/.test(skillText(name)));
  assert.ok(callers.includes('to-build'), 'the caller audit did not discover the roots.js list call in to-build');
  const offending = callers.filter((name) => {
    const text = skillText(name);
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
  const callers = skillDirs().filter((name) =>
    /roots\.js"? (?:check|list)/.test(skillText(name)));
  assert.ok(callers.includes('to-build'), 'the absent-default audit did not discover the roots.js list call in to-build');
  const offending = callers.filter((name) => {
    const text = skillText(name);
    if (/roots\.js"? (?:check|list) --name/.test(text)) return false;  // --name can never return 5
    return !/Exit 5/.test(text);
  });
  assert.deepStrictEqual(
    offending, [],
    `these run a broad check and never say what to do on exit 5: ${offending.join(', ')}`
  );
});

check('find-skill does not silently default underneath the check', () => {
  // The check refused a corrupt config and the Python below it caught every
  // exception and routed against the default path anyway, so the skill relayed
  // "the config could not be read" and then behaved as though it had. A guard
  // that the code beneath it ignores is worse than no guard: it reads as
  // handled.
  //
  // This used to assert the shape of that Python, `if not os.path.exists(CONFIG)`,
  // which pinned one implementation of the rule rather than the rule. The block
  // no longer reads the config at all; roots.js decides absent versus broken for
  // every skill here. So the check runs the block against a corrupt config and
  // asserts what it does, which is the thing that was actually wrong.
  const text = skillText('find-skill');
  const block = text.match(/python3 - "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/roots\.js" <<'PY'\n([\s\S]*?)\nPY\n/);
  assert.ok(block, 'the inventory block is not in the expected heredoc form');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'find-skill-corrupt-'));
  try {
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: d\n---\n');
    // A config that exists and cannot be parsed. Absent would be legitimate and
    // would correctly fall back; broken must stop.
    fs.writeFileSync(path.join(home, '.claude', 'build-loop.config.json'), '{ not json');

    const script = path.join(home, 'block.py');
    fs.writeFileSync(script, block[1]);
    const run = spawnSync('python3', [script, SCRIPT], {
      encoding: 'utf8', env: { ...process.env, HOME: home },
    });

    assert.notStrictEqual(run.status, 0,
      'routed against the defaults with a config it could not read');
    const said = (run.stdout || '') + (run.stderr || '');
    assert.match(said, /not valid JSON|could not be read|Fix or remove it/,
      `stopped without saying why: ${said.slice(0, 200)}`);
    assert.doesNotMatch(said, /"name":\s*"demo"/,
      'printed an inventory anyway, which is the silent default this guards');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

check('every skill that reads the config checks the roots exist', () => {
  // This is the whole bug. Three skills carried a guard and three did not, and
  // nothing anywhere said which was which, so the gap was invisible until a
  // root moved. Reading the config is the trigger: if a skill resolves paths
  // against these roots, it has to know whether they are there.
  const offending = skillDirs().filter((name) => {
    const text = skillText(name);
    if (!/build-loop\.config\.json/.test(text)) return false;
    return !/roots\.js"? (?:check|list)/.test(text);
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

// --- coverage: exact structured destination roots -------------------------

{
  const home = makeHome({ roots: [
    { name: 'live', path: '~/live', kind: 'skill' },
    { name: 'moved', path: '~/moved', kind: 'plugin-repo' },
  ] });
  fs.mkdirSync(path.join(home, 'live'));

  const coverage = (name) => {
    const file = path.join(home, `destination-${name.replace(/[^a-z0-9]/gi, '-')}.txt`);
    fs.writeFileSync(file, name);
    return run(home, ['coverage', '--name-file', file]);
  };

  check('coverage matches only an exact configured root name', () => {
    assert.deepStrictEqual(JSON.parse(coverage('live').stdout), { answer: 'covered', root: 'live' });
    assert.deepStrictEqual(JSON.parse(coverage('lives').stdout), { answer: 'not-configured', root: 'lives' });
  });

  check('coverage separates a moved root from an unconfigured root', () => {
    assert.deepStrictEqual(JSON.parse(coverage('moved').stdout), { answer: 'root-missing', root: 'moved' });
    assert.deepStrictEqual(JSON.parse(coverage('elsewhere').stdout), { answer: 'not-configured', root: 'elsewhere' });
  });

  check('coverage output stays one valid JSON record for unusual root names', () => {
    const result = coverage('not configured\ncovered personal');
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      answer: 'not-configured', root: 'not configured\ncovered personal',
    });
    assert.strictEqual(result.stdout.trim().split('\n').length, 1);
  });

  check('coverage reads the name from a file and never accepts a positional destination', () => {
    const positional = run(home, ['coverage', 'live']);
    assert.notStrictEqual(positional.code, 0);
    assert.match(positional.stdout, /not a positional destination/);
  });

  check('coverage clearly requires --name-file when it is omitted', () => {
    const out = run(home, ['coverage']);
    assert.notStrictEqual(out.code, 0);
    assert.match(out.stdout, /coverage requires --name-file/);
    assert.doesNotMatch(out.stdout, /undefined|path.*argument/i);
  });

  check('coverage refuses an empty destination-root file', () => {
    const file = path.join(home, 'empty-destination.txt');
    fs.writeFileSync(file, '');
    const out = run(home, ['coverage', '--name-file', file]);
    assert.notStrictEqual(out.code, 0);
    assert.match(out.stdout, /must contain a root name/);
  });

  check('coverage reports configuration failures as exit 1 prose', () => {
    const h = makeHome('{ broken json');
    const file = path.join(h, 'destination.txt');
    fs.writeFileSync(file, 'live');
    const out = run(h, ['coverage', '--name-file', file]);
    assert.strictEqual(out.code, 1);
    assert.match(out.stdout, /not valid JSON/);
    assert.throws(() => JSON.parse(out.stdout));
  });

  check('help documents that ordinary coverage answers exit zero', () => {
    const out = run(home, ['--help']);
    assert.strictEqual(out.code, 0);
    assert.match(out.stdout, /coverage is the exception[\s\S]*four[\s\S]*answers[\s\S]*exit 0/);
    assert.match(out.stdout, /Exit 1 still means the invocation or configuration could not be read/);
  });
}

for (const home of HOMES) fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
