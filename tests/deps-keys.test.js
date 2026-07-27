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

let failed = 0;
function check(what, fn) {
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
  assert.ok(/\$schema_version` \| int \| Currently 3/.test(SCHEMA), 'schema version was not bumped');
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

console.log(`\n11 checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
