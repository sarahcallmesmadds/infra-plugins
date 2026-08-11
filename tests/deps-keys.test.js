#!/usr/bin/env node
// Regression tests for DEPS.json keys and the plugin-repo file search.
//
// Run: node tests/deps-keys.test.js
//
// Two faults, found by running /audit-deps against this repository for the
// first time. Both are prose rather than code, so what is testable is the
// instruction each skill gives and the shape of the repository it is given.
//
// 1. Keys collided. The rule was {repo}:{name on disk}, which assumes the root
//    name disambiguates. Under a plugin-repo root it does not: one root named
//    `plugins` holding four plugins produces `plugins:cli` for three separate
//    files. Later entries overwrite earlier ones, so the map describes the
//    wrong file and a fix to one plugin flags another plugin's dependents.
//
// 2. scripts/ was invisible. The plugin-repo search covered skills/, hooks/ and
//    commands/, and scripts/ is where the logic actually lives, since hooks and
//    skills in a well-built plugin are thin wrappers. Two of the four guardrails
//    bugs fixed on 2026-07-27 were in scripts/, so /flag-issue could not resolve
//    the file for the common case.
//
// The behavioural half at the bottom derives keys from this repository both
// ways and asserts the collision is real. If the plugin layout ever changes so
// that bare names no longer collide, that test fails and the rule can be
// revisited on evidence rather than on memory.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PLUGINS = path.join(__dirname, '..', 'plugins');
const BUILD_LOOP = path.join(PLUGINS, 'build-loop');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const SCHEMA = read(BUILD_LOOP, 'reference', 'SCHEMA-DEPS.md');
const SKILLS = {
  'flag-issue': read(BUILD_LOOP, 'skills', 'flag-issue', 'SKILL.md'),
  'audit-deps': read(BUILD_LOOP, 'skills', 'audit-deps', 'SKILL.md'),
  'apply-fix': read(BUILD_LOOP, 'skills', 'apply-fix', 'SKILL.md'),
  'built-check': read(BUILD_LOOP, 'skills', 'built-check', 'SKILL.md'),
};

// The number of checks this file is expected to run. It is asserted at the
// bottom rather than printed from a literal, because on 2026-07-28 three checks
// were added here and the hardcoded tally was left at 17, so the suite ran 20
// and said 17. That is the failure this repository keeps finding: the value was
// right, the sentence printed beside it was not.
//
// Counting as they run fixes the wrong number. It does not fix the other half,
// which is why the literal was here at all: a check that quietly disappears
// should be noticed. So the count is derived AND compared, and this constant
// has to move when a check is added or removed. Forgetting now fails the suite
// instead of printing a smaller number nobody reads.
const EXPECTED_CHECKS = 25;

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

// --- the scripts/ gap ------------------------------------------------------

check('every skill that searches a plugin-repo root also searches scripts/', () => {
  // These three each carry their own copy of the search. A line added to one
  // and not the others is how they drifted apart in the first place.
  for (const [name, text] of Object.entries(SKILLS)) {
    if (!/plugins\/\*\//.test(text)) continue;
    assert.ok(
      /plugins\/\*\/scripts\//.test(text),
      `${name} searches a plugin-repo root but never looks in scripts/, `
      + 'where the logic lives'
    );
  }
});

// --- the statusline/ and tests/ gaps ---------------------------------------

// Same drift as scripts/, found by diffing the repository against DEPS.json on
// 2026-07-28: 19 test files and 2 statusline files, none of them reachable by
// any search. The statusline pair was in the map only because someone added it
// by hand, which is the state that looks fixed and is not.
check('every skill that searches a plugin-repo root also searches statusline/', () => {
  for (const [name, text] of Object.entries(SKILLS)) {
    if (!/plugins\/\*\//.test(text)) continue;
    assert.ok(
      /plugins\/\*\/statusline\//.test(text),
      `${name} searches a plugin-repo root but never looks in statusline/, `
      + 'a fourth place a plugin keeps executable code'
    );
  }
});

check('every skill that searches a plugin-repo root also searches tests/', () => {
  // This one cannot be fixed by adding another subdirectory to the plugins/*/
  // glob. tests/ is a sibling of plugins/, not a child, so the search has to
  // reach outside the pattern that finds everything else.
  for (const [name, text] of Object.entries(SKILLS)) {
    if (!/plugins\/\*\//.test(text)) continue;
    assert.ok(
      /<root\.path>\/tests\//.test(text),
      `${name} searches a plugin-repo root but never looks in tests/, which `
      + 'sits at the repository root and inside no plugin'
    );
  }
});

check('a test target keeps a key that cannot collide with a plugin target', () => {
  assert.ok(
    /built-check\.test/.test(SKILLS['audit-deps']),
    'audit-deps does not say what key a test file gets, so built-check.test.js '
    + "and the build-loop skill called built-check can land on the same key"
  );
});

check('a script target is no longer sent straight to a manual ask', () => {
  assert.ok(
    !/If `target_kind` is `script` or `other` and nothing above matched/.test(SKILLS['flag-issue']),
    'flag-issue still gives up on script targets before searching scripts/'
  );
});

// --- the key collision -----------------------------------------------------

check('the schema defines the key under a plugin-repo root', () => {
  assert.ok(
    /\{plugin\}\/\{name\}/.test(SCHEMA),
    'SCHEMA-DEPS.md does not say what the key is when one root holds many plugins'
  );
  // The key rule arrived in v3, so anything from 3 up carries it. Pinning the
  // exact number made this fail on the next unrelated bump, which says nothing
  // about whether the rule is still documented.
  const declared = SCHEMA.match(/\$schema_version` \| int \| Currently (\d+)/);
  assert.ok(declared, 'the schema does not declare a version at all');
  assert.ok(Number(declared[1]) >= 3, `schema version is ${declared[1]}, so the plugin-qualified key predates it`);
});

check('both key readers know about the plugin-qualified form', () => {
  // A writer and a reader that disagree about the key produce a lookup that
  // finds nothing, which is indistinguishable from having no dependents.
  for (const name of ['flag-issue', 'apply-fix']) {
    assert.ok(
      /plugin-repo`, it is `\{repo\}:\{plugin\}\/\{target\}/.test(SKILLS[name]),
      `${name} still builds a bare {repo}:{target} key, which will miss every `
      + 'entry written under a plugin-repo root'
    );
  }
});

check('both readers fall back to a suffix match rather than giving up quietly', () => {
  for (const name of ['flag-issue', 'apply-fix']) {
    assert.ok(
      /ending `\/\{target\}`|ends with `\/\{target\}`|suffix match on `\/\{target\}`/.test(SKILLS[name]),
      `${name} has no suffix fallback, so a bare lookup against a v3 map finds nothing`
    );
  }
});

check('both readers retry the bare key, which is what a pre-v3 map stored', () => {
  // The suffix match only works in one direction. A qualified lookup against a
  // map written before v3 finds nothing through it, because the stored name is
  // `hook-io` and that does not end with `/hook-io`. Without a bare-key retry,
  // installing this version makes every existing map go quiet, which is the
  // failure the whole change set out to remove.
  for (const name of ['flag-issue', 'apply-fix']) {
    assert.ok(
      /bare key, `\{repo\}:\{target\}`/.test(SKILLS[name]),
      `${name} never retries the bare key, so a pre-v3 map silently stops reporting dependents`
    );
    assert.ok(
      /predates v3/.test(SKILLS[name]),
      `${name} matches a pre-v3 key without saying the entry may describe a different plugin`
    );
  }
});

check('the schema spells out the lookup order rather than one fallback', () => {
  assert.ok(
    /in order/.test(SCHEMA) && /bare key, `\{repo\}:\{target\}`/.test(SCHEMA),
    'SCHEMA-DEPS.md does not define the full lookup order, so the two readers '
    + 'have nothing to agree against'
  );
});

check('the README does not claim an old map keeps working unqualified', () => {
  // It said "keeps working through the fallback", which was not true for the
  // migration direction that actually occurs.
  const readme = read(BUILD_LOOP, 'README.md');
  assert.ok(
    !/keeps working through the fallback/.test(readme),
    'README still claims a pre-v3 map resolves through the suffix fallback, which it does not'
  );
});

check('an ambiguous match is reported rather than guessed at', () => {
  for (const name of ['flag-issue', 'apply-fix']) {
    assert.ok(
      /More than one[\s\S]{0,200}(do not choose|do not pick)/i.test(SKILLS[name]),
      `${name} does not say what to do when two keys match, and guessing sends a `
      + 'fix to the wrong plugin'
    );
  }
});

// --- edges point at a key without becoming one -----------------------------
//
// The key carries the plugin. An edge has to reach the same key, and it also
// feeds /flag-issue, which copies an edge's `target` verbatim into a queue
// entry. A queue entry's target is a name on disk. So the plugin has to travel
// beside `target`, not inside it: fold it in and every dep-review entry names
// something like `guardrails/hook-io`, which no search will ever resolve.

check('the edge format carries plugin as its own field', () => {
  assert.ok(
    /\| `plugin` \| string \| no \|/.test(SCHEMA),
    'the edge field table has no `plugin`, so an edge inside a plugin-repo root '
    + 'cannot say which plugin it means'
  );
  assert.ok(
    /\*\*Bare, never `plugin\/name`\.\*\*/.test(SCHEMA),
    'nothing says the edge target stays bare, which is the half that breaks quietly'
  );
});

check('flag-issue keeps the edge target bare in the entry it writes', () => {
  const t = SKILLS['flag-issue'];
  assert.ok(
    /plugin: P/.test(t),
    'flag-issue does not read the edge plugin field'
  );
  assert.ok(
    /Never write `\{P\}\/\{X\}` into the entry's `target`/.test(t),
    'flag-issue does not forbid writing a slashed name into a queue entry, '
    + 'which produces an entry that cannot resolve to a file'
  );
});

check('audit-deps writes plugin beside target, and carries it to back-edges', () => {
  const t = SKILLS['audit-deps'];
  assert.ok(
    /never `\{"target": "guardrails\/hook-io"\}`/.test(t),
    'audit-deps does not say to keep the edge target bare'
  );
  assert.ok(
    /plugin: A\.plugin/.test(t),
    'the back-edge step drops plugin, so dependents lose it while depends_on keeps it'
  );
});

check('an entry stores plugin as a field, so back-edges have it to read', () => {
  // The back-edge step reads A.plugin off an entry. If the plugin only lives
  // inside the composite key, that read returns nothing and every dependent is
  // written without one, which is the ambiguity this change removed from edges
  // reappearing on the reverse direction.
  assert.ok(
    /\| `plugin` \| string \| no \| Which plugin inside a `plugin-repo` root holds this/.test(SCHEMA),
    'the entry field table has no `plugin`, so A.plugin in the back-edge step '
    + 'reads a field that does not exist'
  );
  assert.ok(
    /`plugin` when the root is a\n  `plugin-repo`/.test(SKILLS['audit-deps'])
      || /plus \*\*`plugin` when the root is a/.test(SKILLS['audit-deps']),
    'audit-deps never writes plugin onto the entry it builds'
  );
});

check('a dep-review id and dedup key carry the plugin, so two cli entries survive', () => {
  // target and id want opposite things. target is a name that has to resolve to
  // a file, so it stays bare. id, filename and dedup_key exist to be unique,
  // and a bare name is not: one fix touching something both guardrails/cli and
  // slop-check/cli depend on produced the same filename twice and the same
  // dedup key twice, so one review overwrote the other or was skipped as a
  // duplicate. The dependent in the other plugin then vanished with no message,
  // inside the machinery built to stop exactly that.
  const t = SKILLS['flag-issue'];
  assert.ok(
    /dep-review-\{slug\(P\)\}-\{slug\(X\)\}/.test(t),
    'the dep-review id is built from the bare name, so two dependents sharing a '
    + 'name across plugins collide on one filename'
  );
  assert.ok(
    /dep-review::\{P\}\/\{X\}::/.test(t),
    'the dedup key is built from the bare name, so the second dependent is '
    + 'skipped as a duplicate of the first'
  );
});

check('the dependents warning names the plugin, not just the bare name', () => {
  // Guidance said to show {plugin}/{target}; the template below it still said
  // {dep.target}. The template is the part that reaches the user.
  const t = SKILLS['apply-fix'];
  assert.ok(
    /\{dep\.plugin\}\/\{dep\.target\}/.test(t),
    'the warning template still shows a bare dependent name, so a fix can warn '
    + 'about "cli" without saying which of the three it means'
  );
});

// --- and the repository this rule exists for -------------------------------

function targetsInRepo() {
  const found = [];
  for (const plugin of fs.readdirSync(PLUGINS)) {
    for (const dir of ['scripts', 'hooks', 'commands']) {
      const full = path.join(PLUGINS, plugin, dir);
      if (!fs.existsSync(full)) continue;
      for (const file of fs.readdirSync(full)) {
        if (file.startsWith('.') || file.endsWith('.json')) continue;
        found.push({ plugin, name: file.replace(/\.[^.]+$/, '') });
      }
    }
    const skills = path.join(PLUGINS, plugin, 'skills');
    if (fs.existsSync(skills)) {
      for (const s of fs.readdirSync(skills)) found.push({ plugin, name: s });
    }
  }
  return found;
}

check('bare names really do collide in this repository', () => {
  // The evidence the rule rests on. If this stops being true the collision is
  // gone and the key format is worth revisiting, so a failure here is a prompt
  // rather than a defect.
  const counts = {};
  for (const t of targetsInRepo()) counts[t.name] = (counts[t.name] || 0) + 1;
  const collisions = Object.entries(counts).filter(([, n]) => n > 1);
  assert.ok(
    collisions.length > 0,
    'no bare-name collisions found, so the plugin-qualified key may no longer '
    + 'be needed. Check before removing it.'
  );
  assert.ok(
    collisions.some(([name]) => name === 'cli'),
    `expected cli to collide, got: ${collisions.map(([n, c]) => n + '×' + c).join(', ')}`
  );
});

check('plugin-qualified keys are unique across the whole repository', () => {
  const seen = new Set();
  for (const t of targetsInRepo()) {
    const key = `plugins:${t.plugin}/${t.name}`;
    assert.ok(!seen.has(key), `plugin-qualified key still collides: ${key}`);
    seen.add(key);
  }
});

// --- what a plugin row's path points at -------------------------------------

// Found by running the audit by hand on 2026-07-28. The map stores a plugin as
// its manifest; the glob that finds plugins returns a directory. Nothing says
// which to store, so a run reports all five plugins MISSING and the same five
// ORPHANED in a single pass, and approving that draft doubles every plugin row.
check('audit-deps says a plugin row stores the manifest, not the directory', () => {
  assert.ok(
    /`path` for a `kind: plugin` entry is the plugin's\n\s*`\.claude-plugin\/plugin\.json`/.test(SKILLS['audit-deps']),
    'audit-deps never says what path a plugin entry stores, so the directory '
    + 'the glob returns and the manifest already in the map both look correct'
  );
});

// --- the two ways this skill used to lose information silently --------------

// Step 6 said "prune dependents with no matching depends_on" and nothing else.
// Run against the live map on 2026-08-11 that deleted 101 of 242 back-edges,
// 42 percent, almost all of them test coverage links. No error, no count, the
// file just came back smaller and every reader kept working.
check('audit-deps does not prune back-edges without being told to', () => {
  const step6 = SKILLS['audit-deps'];
  assert.ok(
    /Collect, do not delete/.test(step6),
    'audit-deps still prunes one-sided dependents as a silent step'
  );
  assert.ok(
    /Never prune without an explicit `remove`/.test(step6),
    'audit-deps never says pruning needs permission, so it reads as automatic'
  );
  assert.ok(
    /keep \/ add-missing \/ remove/.test(step6),
    'audit-deps offers no way to repair a one-sided edge, so the only options '
    + 'are keep it broken or delete the evidence'
  );
});

// `last_updated` means a person or this skill judged the edges correct. v4 added
// `last_auto_checked` so an unattended check would stop writing into it. Step 5
// then told this skill to stamp it on entries nobody looked at, which is the
// same fault in the place the fix did not reach.
check('audit-deps does not stamp a review that did not happen', () => {
  const skill = SKILLS['audit-deps'];
  assert.ok(
    /If they decline, leave `last_updated` alone/.test(skill),
    'audit-deps still bumps last_updated on entries it did not re-infer'
  );
  assert.ok(
    !/this acknowledges the file was inspected/.test(skill),
    'the old instruction to stamp an uninspected entry is still present'
  );
});

check('flag-issue resolves a plugin to a file rather than a directory', () => {
  assert.ok(
    /plugins\/\{target\}\/\.claude-plugin\/plugin\.json/.test(SKILLS['flag-issue']),
    'flag-issue resolves a plugin target to its directory, and /apply-fix '
    + 'cannot open a directory'
  );
  assert.ok(
    !/ls -d <root\.path>\/plugins\/\{target\}\s/.test(SKILLS['flag-issue']),
    'the old directory-only lookup is still there beside the new one'
  );
});

check('the two path conventions really are distinguishable', () => {
  // The evidence the rule rests on, in the shape of the collision test above.
  // If a manifest path ever equalled its directory path the double-add could
  // not happen and this rule would be unnecessary.
  const dirs = fs.readdirSync(PLUGINS).filter((d) =>
    fs.existsSync(path.join(PLUGINS, d, '.claude-plugin', 'plugin.json')));
  assert.ok(dirs.length > 1, `expected several plugins on disk, found ${dirs.length}`);
  for (const d of dirs) {
    const asDir = path.join(PLUGINS, d);
    const asManifest = path.join(PLUGINS, d, '.claude-plugin', 'plugin.json');
    assert.notStrictEqual(
      asDir, asManifest,
      `${d} resolves the same both ways, so storing the wrong one would be harmless`
    );
    assert.ok(fs.statSync(asDir).isDirectory(), `${d} is not a directory`);
    assert.ok(fs.statSync(asManifest).isFile(), `${d} has no manifest file to store`);
  }
});

if (ran !== EXPECTED_CHECKS) {
  failed += 1;
  console.log(
    `  FAIL  the file runs the number of checks it expects to\n`
    + `        ran ${ran}, expected ${EXPECTED_CHECKS}. If you added or removed a `
    + `check, move EXPECTED_CHECKS. If you did not, one has gone missing.`
  );
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
