#!/usr/bin/env node
// Regression tests for the inventory drift classifier.
//
// Run: node tests/ip-diff.test.js
//
// The rows come from tests/fixtures/ip-inventory-rows.json, which is a real
// Notion API response captured off the live database rather than hand-written,
// with its free-text fields redacted because this repository is public. Every
// structural value a check reads is exactly what the API returned, so the tests
// exercise the real property mapping and not an idealised version of it.
//
// Several checks below fail against the first working version of the
// classifier. They are here because that version looked correct and was not:
//   - it read an unticked Notion checkbox as a deliberate "no", so one enabled
//     plugin produced eleven findings claiming its own scripts were disabled
//   - it checked live paths with fs.existsSync alone, which passes happily on a
//     path into a superseded version directory, because updating a plugin
//     leaves the old copy on disk
//   - its path rewrite required a trailing slash, so on the one row whose path
//     stops at the version it produced a "fix" identical to the input

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'plugins', 'ip-inventory');
const { toRow } = require(path.join(ROOT, 'scripts', 'notion'));
const { DEFAULTS } = require(path.join(ROOT, 'scripts', 'config'));
const { classify } = require(path.join(ROOT, 'scripts', 'diff'));
const {
  repoFacts, pluginKey, installedPlugins, enabledPlugins,
} = require(path.join(ROOT, 'scripts', 'reality'));

const fixture = require('./fixtures/ip-inventory-rows.json');
const config = { ...DEFAULTS };
const ROWS = fixture.results.map((page) => toRow(page, config.properties));

function row(name) {
  const found = ROWS.find((candidate) => candidate.name === name);
  assert.ok(found, `fixture has no row named ${name}`);
  return found;
}

// A reality with nothing in it. Each test adds only the facts it is about, so
// no test depends on a fact it did not state.
function reality(overrides = {}) {
  return {
    hasGithubToken: true,
    repos: new Map(),
    trees: new Map(),
    installed: new Map(),
    enabled: new Map(),
    pathExists: () => true,
    ...overrides,
  };
}

function findingsFor(rows, realityObject) {
  return classify(rows, realityObject, config).findings;
}

function checksOn(rows, realityObject, name) {
  return findingsFor(rows, realityObject)
    .filter((finding) => finding.name === name)
    .map((finding) => finding.check);
}

let failed = 0;
// Counted rather than written down. The summary line said "16 checks" as a
// literal, so adding one made the count wrong and nothing said so, which is a
// small version of the thing this whole file is testing for.
let passed = 0;
function check(what, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

// --- the property mapping ----------------------------------------------------

check('the fixture maps to the flat row shape the classifier expects', () => {
  const guardrails = row('guardrails');
  assert.strictEqual(guardrails.kind, 'Plugin');
  assert.strictEqual(guardrails.version, '0.2.4');
  assert.strictEqual(guardrails.installed, true, 'ticked checkbox should read true');
  assert.strictEqual(guardrails.visibility, 'Public');
  assert.strictEqual(guardrails.dateStarted, '2026-07-26', 'date should be the ISO start');
  assert.ok(Array.isArray(guardrails.parent), 'relation should map to an array of ids');
});

check('a component row inherits nothing it was not given', () => {
  const script = row('guardrails/cli.js');
  assert.strictEqual(script.kind, 'Script');
  // This is the value the first classifier misread. Notion returns false both
  // for a box someone unticked and for one nobody ever touched.
  assert.strictEqual(script.enabled, false);
});

// --- checkboxes --------------------------------------------------------------

check('an untouched checkbox on a component row is not reported as drift', () => {
  const rows = [row('guardrails'), row('guardrails/cli.js')];
  const state = reality({
    installed: new Map([['guardrails', { version: '0.2.4', versionsOnDisk: ['0.2.4'], path: '/x' }]]),
    enabled: new Map([['guardrails', true]]),
  });
  const onScript = checksOn(rows, state, 'guardrails/cli.js');
  assert.ok(
    !onScript.includes('enabled-changed'),
    `component row claimed enabled drift: ${onScript.join(', ')}. Notion cannot distinguish `
    + 'an unticked box from an unset one, so false is not a claim.'
  );
});

check('a plugin row whose enabled state really differs is still reported', () => {
  const rows = [row('guardrails')];
  const state = reality({
    installed: new Map([['guardrails', { version: '0.2.4', versionsOnDisk: ['0.2.4'], path: '/x' }]]),
    enabled: new Map([['guardrails', false]]),
  });
  const found = findingsFor(rows, state).find((f) => f.check === 'enabled-changed');
  assert.ok(found, 'a plugin silently disabled is the failure this whole check exists for');
  assert.strictEqual(found.now, false);
  assert.ok(/DISABLED/.test(found.detail), 'the reason should say what it means for the user');
});

// --- stale live paths --------------------------------------------------------

check('a live path into a superseded version is caught even though it exists', () => {
  const rows = [row('build-loop'), row('find-skill')];
  const state = reality({
    installed: new Map([['build-loop', {
      version: '0.2.4',
      versionsOnDisk: ['0.2.0', '0.2.1', '0.2.2', '0.2.3', '0.2.4'],
      path: '/x',
    }]]),
    // Deliberately true. The old directory is still on disk, which is exactly
    // why an existence check alone is not enough.
    pathExists: () => true,
  });
  const onSkill = checksOn(rows, state, 'find-skill');
  assert.ok(
    onSkill.includes('live-path-stale'),
    `expected live-path-stale, got: ${onSkill.join(', ') || 'nothing'}`
  );
});

check('the rewritten path actually differs from the one it replaces', () => {
  // The plugin's own row ends at the version with no trailing slash, so a
  // rewrite keyed on "/name/version/" silently produced the input unchanged.
  const rows = [row('build-loop')];
  const state = reality({
    installed: new Map([['build-loop', {
      version: '0.2.4', versionsOnDisk: ['0.2.0', '0.2.4'], path: '/x',
    }]]),
  });
  const found = findingsFor(rows, state).find((f) => f.check === 'live-path-stale');
  assert.ok(found, 'no stale finding on the plugin row');
  assert.notStrictEqual(found.now, found.was, 'the suggested path is identical to the current one');
  assert.ok(found.now.endsWith('/0.2.4'), `unexpected rewrite: ${found.now}`);
});

check('a live path already on the newest version is left alone', () => {
  const rows = [row('guardrails')];
  const state = reality({
    installed: new Map([['guardrails', { version: '0.2.4', versionsOnDisk: ['0.2.4'], path: '/x' }]]),
  });
  assert.ok(!checksOn(rows, state, 'guardrails').includes('live-path-stale'));
});

check('a live path that resolves to nothing is queued, not auto-fixed', () => {
  const rows = [row('statusline-usage-bar')];
  const state = reality({ pathExists: () => false });
  const found = findingsFor(rows, state).find((f) => f.check === 'live-path-missing');
  assert.ok(found, 'missing path not reported');
  assert.strictEqual(found.verdict, 'queue', 'a vanished file is not something to guess about');
});

// --- repositories ------------------------------------------------------------

check('a rename is detected from the payload, not from the status code', () => {
  // GitHub serves a renamed repository from its old path with a 200, so a check
  // that only looks at the status sees nothing wrong.
  const rows = [row('sarahcallmesmadds/plugins')];
  const state = reality({
    repos: new Map([[rows[0].repo, {
      checked: true, exists: true, fullName: 'sarahcallmesmadds/marketplace',
      renamed: true, visibility: 'Public', defaultBranch: 'main',
    }]]),
  });
  const found = findingsFor(rows, state).find((f) => f.check === 'repo-renamed');
  assert.ok(found, 'rename not detected');
  assert.strictEqual(found.verdict, 'auto');
  assert.strictEqual(found.now, 'https://github.com/sarahcallmesmadds/marketplace');
});

check('a repository that 404s is queued rather than auto-fixed', () => {
  const rows = [row('sarahcallmesmadds/plugins')];
  const state = reality({
    repos: new Map([[rows[0].repo, { checked: true, exists: false }]]),
  });
  const found = findingsFor(rows, state).find((f) => f.check === 'repo-missing');
  assert.ok(found, 'missing repository not reported');
  assert.strictEqual(
    found.verdict, 'queue',
    'a vanished repository does not say whether the work is retired, moved, or still running'
  );
});

check('an unreachable repository is recorded as unchecked, not as missing', () => {
  const rows = [row('sarahcallmesmadds/plugins')];
  const state = reality({
    repos: new Map([[rows[0].repo, { checked: false, reason: 'GitHub returned 403' }]]),
  });
  const result = classify(rows, state, config);
  assert.strictEqual(
    result.findings.filter((f) => f.check === 'repo-missing').length, 0,
    'a repository we could not see must never be reported as deleted'
  );
  assert.ok(result.skipped.some((s) => /403/.test(s.reason)), 'the skip was not recorded');
});

check('visibility drift is auto-fixable', () => {
  const rows = [row('sarahcallmesmadds/plugins')];
  const state = reality({
    repos: new Map([[rows[0].repo, {
      checked: true, exists: true, fullName: 'sarahcallmesmadds/plugins',
      renamed: false, visibility: 'Private', defaultBranch: 'main',
    }]]),
  });
  const found = findingsFor(rows, state).find((f) => f.check === 'visibility-changed');
  assert.ok(found, 'visibility flip not detected');
  assert.strictEqual(found.was, 'Public');
  assert.strictEqual(found.now, 'Private');
});

// --- prose where a value belongs ---------------------------------------------

check('a sentence in a path field is skipped and said out loud', () => {
  const rows = [row('build-loop.config.json')];
  const result = classify(rows, reality(), config);
  assert.ok(
    !result.findings.some((f) => f.check === 'source-path-missing'),
    'a sentence was checked as if it were a path'
  );
  assert.ok(
    result.skipped.some((s) => s.check === 'source-path' && /sentence/.test(s.reason)),
    'the skip was not surfaced, so it would look like a pass'
  );
});

// --- what did not run --------------------------------------------------------

check('running without a GitHub token is reported, not quietly assumed fine', () => {
  const result = classify([row('guardrails')], reality({ hasGithubToken: false }), config);
  assert.ok(
    result.skipped.some((s) => /token/.test(s.reason)),
    'no token and no mention of it: a report of "no drift" would be a lie'
  );
});

check('a clean run still reports how much it checked', () => {
  const result = classify([row('daily-brief')], reality(), config);
  assert.strictEqual(result.findings.length, 0);
  assert.strictEqual(result.counts.rows, 1);
  assert.ok(result.checksRun.length >= 10, 'the report must be able to say what it looked at');
});

// --- plugins with no row -----------------------------------------------------

check('a plugin installed but absent from the inventory is surfaced', () => {
  const state = reality({
    installed: new Map([['brand-new', { version: '1.0.0', versionsOnDisk: ['1.0.0'], path: '/tmp/x' }]]),
  });
  const found = findingsFor([row('guardrails')], state)
    .find((f) => f.check === 'unrecorded-plugin');
  assert.ok(found, 'an installed plugin missing from the record was not noticed');
  assert.strictEqual(found.name, 'brand-new');
  assert.strictEqual(found.rowId, null, 'there is no row, so there is no row id');
});

// --------------------------------------------------- a 404 without a token ----
//
// GitHub answers 404, not 403, for a private repository on an unauthenticated
// request: saying "forbidden" would confirm the repository exists to anyone who
// asked. So without a token, deleted and private are the same response.
//
// repoFacts mapped every 404 to exists: false. The 401/403 branch that would
// have caught this was written for exactly this case, and says so in its own
// comment, and cannot fire on it. The report then said, in one document, that
// repository checks were skipped for lack of a token AND that those same
// repositories were missing.
//
// The contract in the README and in ip-audit is that a repository is reported
// missing only when GitHub answers 404 with a token attached.

const withFetch = async (status, body, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ status, json: async () => body });
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

async function checkAsync(what, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${what}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${what}\n          ${err.message}`);
  }
}

// A row can only be reported missing by a check that ran, so this is the
// classify half of the same contract.
check('a repository that was not checked produces no missing finding', () => {
  const target = row('sarahcallmesmadds/plugins');
  const state = reality({
    hasGithubToken: false,
    repos: new Map([[target.repo, { checked: false, reason: 'no token' }]]),
  });
  const out = classify([target], state, config);
  assert.deepStrictEqual(
    out.findings.filter((f) => f.check === 'repo-missing'),
    [],
    'an unchecked repository must not be reported as gone',
  );
  assert.ok(out.skipped.length > 0, 'and it has to be listed as skipped rather than dropped');
});

// ------------------------------------------------------- name normalisation ----

check('a plugin name has one spelling for comparison', () => {
  assert.strictEqual(pluginKey(' Build-Loop '), 'build-loop');
  assert.strictEqual(pluginKey('build-loop'), 'build-loop');
  assert.strictEqual(pluginKey(null), '');
});

check('the installed map is keyed so a differently cased row still matches', () => {
  // The directory on disk is whatever the marketplace called it. The Notion row
  // is whatever a person typed. These met only by luck.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-installed-'));
  fs.mkdirSync(path.join(home, 'cache', 'smadds', 'Build-Loop', '0.1.0'), { recursive: true });
  const found = installedPlugins({ ...DEFAULTS, pluginCacheDir: path.join(home, 'cache') });
  assert.ok(found.has('build-loop'), `keys were ${[...found.keys()].join(', ')}`);
});

check('the enabled map is keyed the same way', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-enabled-'));
  const settings = path.join(home, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'Build-Loop@smadds': true } }));
  const found = enabledPlugins({ ...DEFAULTS, settingsPath: settings });
  assert.strictEqual(found.get('build-loop'), true, `keys were ${[...found.keys()].join(', ')}`);
});

(async () => {
  await checkAsync('a 404 with no token is not a deletion', async () => {
    const facts = await withFetch(404, null, () => repoFacts('o', 'r', null));
    assert.strictEqual(facts.checked, false, 'without a token this check did not run');
    assert.notStrictEqual(facts.exists, false, 'and it must not claim the repository is gone');
    assert.match(facts.reason, /private/i);
  });

  await checkAsync('a 404 with a token is a deletion', async () => {
    // The check the tool exists for still has to work.
    const facts = await withFetch(404, null, () => repoFacts('o', 'r', 'ghp_token'));
    assert.strictEqual(facts.checked, true);
    assert.strictEqual(facts.exists, false);
  });

  await checkAsync('a 403 with a token is still an unrun check', async () => {
    const facts = await withFetch(403, null, () => repoFacts('o', 'r', 'ghp_token'));
    assert.strictEqual(facts.checked, false);
  });

  console.log(`\n${passed + failed} checks, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
