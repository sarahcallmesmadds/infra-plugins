#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, 'plugins/build-loop/skills/devin-review-response');
const VALIDATOR = path.join(ROOT, 'plugins/build-loop/scripts/pre-push-check.js');
const README = path.join(ROOT, 'plugins/build-loop/README.md');
let passed = 0;

function check(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}\n${error.stack}`); process.exitCode = 1; }
}

function run(record) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-round-'));
  const file = path.join(dir, 'round.json');
  try {
    fs.writeFileSync(file, JSON.stringify(record));
    return spawnSync(process.execPath, [VALIDATOR, file], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const valid = {
  repository: 'o/r', pr: 12, round: 1, branch: 'feat/x', head_sha: 'abc',
  finding_set_complete: true, review_outcome: 'findings',
  findings: [{ id: 'F1', location: 'x.js:1', summary: 'wrong result', disposition: 'fixed',
    evidence: 'return corrected result', dependency_audit: ['caller checked'],
    paired_file_audit: ['test changed'], changed_files: ['x.js', 'x.test.js'] }],
  verification: [{ command: 'node test.js', outcome: 'passed' }]
};

check('skill ships every linked reference', () => {
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  for (const match of body.matchAll(/\]\((references\/[^)]+)\)/g)) {
    assert.ok(fs.existsSync(path.join(SKILL, match[1])), `missing ${match[1]}`);
  }
});

check('skill can search and create its private round directory without broad Bash', () => {
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const frontmatter = body.slice(0, body.indexOf('---', 4));
  assert.match(frontmatter, /allowed-tools:.*\bGrep\b/);
  assert.match(frontmatter, /allowed-tools:.*\bGlob\b/);
  assert.match(frontmatter, /Bash\(mktemp:\*\)/);
  assert.doesNotMatch(frontmatter, /\bBash\b(?!\s*\()/);
});

check('validator uses the plugin-level scripts convention', () => {
  assert.ok(fs.existsSync(VALIDATOR), 'plugin-level pre-push validator is missing');
  assert.ok(!fs.existsSync(path.join(SKILL, 'scripts/pre-push-check.js')),
    'a skill-local copy would be invisible to the plugin-repo script scanner');
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(body, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/pre-push-check\.js/);
});

check('Build Loop documents the same command count for Claude and Codex', () => {
  const readme = fs.readFileSync(README, 'utf8');
  const heading = readme.match(/^## The (\w+) commands$/m);
  // The sentence carrying this claim was rewritten when the Codex section
  // stopped saying the plugin ships no hooks. What the test is for is
  // unchanged: the count quoted to a Codex user must match the real list.
  const codex = readme.match(/The (\w+) commands are identical on both runtimes/);
  assert.ok(heading, 'the main command-count heading is missing');
  assert.ok(codex, 'the Codex command-count claim is missing');
  assert.strictEqual(codex[1], heading[1], 'the Codex command count drifted from the main list');
});

check('the renamed command has an explicit upgrade note', () => {
  const readme = fs.readFileSync(README, 'utf8');
  const note = readme.match(/^## Upgrading to 0\.8\.1\n([\s\S]*?)(?=^## |\z)/m);
  assert.ok(note, 'the 0.8.1 upgrade note is missing');
  assert.match(note[1], /\/address-devin-review/);
  assert.match(note[1], /\/devin-review-response/);
  assert.match(note[1], /not retained as an alias/);
});

check('complete fixed round passes', () => {
  const result = run(valid);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /push-ready/);
});

check('incomplete finding set fails', () => {
  const result = run({ ...valid, finding_set_complete: false });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /finding_set_complete/);
});

check('fixed finding without audits fails', () => {
  const finding = { ...valid.findings[0] };
  delete finding.dependency_audit;
  delete finding.paired_file_audit;
  const result = run({ ...valid, findings: [finding] });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /dependency_audit/);
  assert.match(result.stderr, /paired_file_audit/);
});

check('deferred and out-of-scope findings require durable evidence', () => {
  const findings = [
    { id: 'F2', location: 'a:1', summary: 'later', disposition: 'deferred', evidence: 'later' },
    { id: 'F3', location: 'b:2', summary: 'old', disposition: 'out-of-scope', evidence: 'old' }
  ];
  const result = run({ ...valid, findings });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /tracking_id/);
  assert.match(result.stderr, /base_evidence/);
});

check('failed verification cannot be push-ready', () => {
  const result = run({ ...valid, verification: [{ command: 'npm test', outcome: 'failed' }] });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /outcome must be passed/);
});

check('duplicate finding IDs fail', () => {
  const result = run({ ...valid, findings: [valid.findings[0], valid.findings[0]] });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /duplicate id/);
});

check('empty findings require an explicit clean review outcome', () => {
  const rejected = run({ ...valid, findings: [], review_outcome: 'findings' });
  assert.strictEqual(rejected.status, 1);
  assert.match(rejected.stderr, /requires review_outcome "clean"/);

  const clean = run({ ...valid, findings: [], review_outcome: 'clean' });
  assert.strictEqual(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /0 findings/);
});

check('non-object JSON returns a validation error without a stack trace', () => {
  for (const record of [null, 3, 'round', []]) {
    const result = run(record);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /round record must be a JSON object/);
    assert.doesNotMatch(result.stderr, /TypeError|at Object/);
  }
});

check('non-object findings and verification rows return validation errors', () => {
  const result = run({ ...valid, findings: [null], verification: [null] });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /findings\[0\] must be a JSON object/);
  assert.match(result.stderr, /verification\[0\] must be a JSON object/);
  assert.doesNotMatch(result.stderr, /TypeError|at Object/);
});

console.log(`devin-review-response: ${passed} checks passed`);
