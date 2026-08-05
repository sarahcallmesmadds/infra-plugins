#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, 'plugins/build-loop/skills/address-devin-review');
const VALIDATOR = path.join(SKILL, 'scripts/pre-push-check.js');
let passed = 0;

function check(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}\n${error.stack}`); process.exitCode = 1; }
}

function run(record) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-round-'));
  const file = path.join(dir, 'round.json');
  fs.writeFileSync(file, JSON.stringify(record));
  return spawnSync(process.execPath, [VALIDATOR, file], { encoding: 'utf8' });
}

const valid = {
  repository: 'o/r', pr: 12, round: 1, branch: 'feat/x', head_sha: 'abc',
  finding_set_complete: true,
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

console.log(`address-devin-review: ${passed} checks passed`);
