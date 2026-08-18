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
const CHANGELOG = path.join(ROOT, 'plugins/build-loop/CHANGELOG.md');
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
  assert.match(frontmatter, /allowed-tools:.*\bEdit\b/);
  // The round directory comes from scripts/scratch.js, so the grant that makes
  // it possible is Bash(node:*) rather than Bash(mktemp:*).
  assert.match(frontmatter, /Bash\(node:\*\)/);
  assert.doesNotMatch(frontmatter, /\bBash\b(?!\s*\()/);
  assert.doesNotMatch(frontmatter, /Bash\((?:git|gh):\*\)/);
  for (const grant of [
    'git branch --show-current', 'git diff', 'git log', 'git remote -v',
    'git rev-parse', 'git status', 'gh auth status', 'gh pr view',
  ]) {
    assert.match(frontmatter, new RegExp(`Bash\\(${grant.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:\\*\\)`));
  }
  for (const mutation of ['git add', 'git commit', 'git push', 'git reset', 'gh pr merge']) {
    assert.doesNotMatch(frontmatter, new RegExp(`Bash\\(${mutation.replace(/ /g, '\\s')}`));
  }
  assert.match(frontmatter, /Bash\(gh api --method GET:\*\)/);
  assert.doesNotMatch(frontmatter, /Bash\(gh api:\*\)/);
});

check('inline review fallback is explicitly read-only', () => {
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(body, /gh api --method GET/);
  assert.match(body, /`reviews` and `comments` endpoints/);
  assert.match(body, /method must be explicit/);
});

check('recovering a hidden finding comes before asking the user for it', () => {
  // The skill used to say to stop and ask whenever the web interface held
  // findings the API did not return. On one pull request that stopped a session
  // dead, and the CLI then recovered the same finding unattended in two minutes,
  // with a file and a line number. Escalating to a person is the fallback.
  const whole = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  // Past the frontmatter, or the allowed-tools grant names the same command and
  // every ordering test measures against a position near the top of the file.
  // That version of this check passed with the old wording still in place.
  const body = whole.split(/^---$/m).slice(2).join('---');
  assert.match(body, /devin --permission-mode auto --prompt-file/,
    'the skill no longer names the command that recovers the findings');

  // Whitespace-insensitive, because this file is hard-wrapped and the phrase
  // lands across a line break as often as not. A version of this matching a
  // literal space passed with the old wording restored, purely because the
  // sentence it was looking for read "ask the\nuser".
  const recover = body.indexOf('devin --permission-mode auto --prompt-file');
  const escalate = body.search(/ask(?:ing)?\s+the\s+user/i);
  assert.ok(escalate > -1, 'the skill no longer says when to involve a person at all');
  assert.ok(escalate > recover,
    'the skill puts asking the user ahead of recovering the findings, which is the bug');
});

check('the skill says to read the review body rather than the check status', () => {
  // A green check has sat above a body reporting findings more than once, so a
  // round called clean on the status alone is not established.
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(body, /body, not the check status/i);
  assert.match(body, /review body names findings/i,
    'the hard stops no longer cover a body that disagrees with the check');
});

check('a clean review is scoped to the commit it ran against', () => {
  // Three rounds went clean and three real findings landed after them, each on
  // a commit answering the previous round.
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(body, /evidence for the commit it ran against/);
  assert.match(body, /no longer the head/,
    'the hard stops no longer cover a review that ran against a stale SHA');
});

check('the recovery command is granted, not just described', () => {
  // A skill naming a command its allowed-tools does not carry stops to ask on
  // every run, which is the same interruption this change removes.
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const front = body.split('---')[1] || '';
  assert.match(front, /Bash\(devin --permission-mode auto --prompt-file:\*\)/,
    'the CLI recovery is documented but not granted');
});

check('the trust-skip command is written outside the skill\'s own grant', () => {
  // The skill says skipping the workspace trust check stops to ask. A grant is
  // a prefix, so that is only true while the flag sits ahead of everything the
  // grant covers: written after that point the command still starts with the
  // granted prefix and runs unasked, and the claim quietly stops being true.
  const whole = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const front = whole.split(/^---$/m)[1] || '';
  // Every devin grant, not the first one found. Reading one prefix means a
  // second, broader grant added later leaves this passing while the sentence it
  // checks has become false, which is the failure it exists to catch.
  const prefixes = [...front.matchAll(/Bash\((devin\b[^:)]*):?\*?\)/g)].map((m) => m[1].trim());
  assert.ok(prefixes.length, 'the skill no longer grants the recovery command');

  const documented = (whole.match(/^\s*devin .*--respect-workspace-trust.*$/m) || [])[0];
  assert.ok(documented, 'the skill no longer shows how to run it in an untrusted workspace');
  const covered = prefixes.filter((p) => documented.trim().startsWith(p));
  assert.deepStrictEqual(covered, [],
    `the documented trust-skip command is covered by ${JSON.stringify(covered)}, so it runs without asking`);
});

check('the review prompt is passed as a file, never on the command line', () => {
  // The granted tail is a wildcard, and this prompt is assembled from review
  // bodies and PR text the skill just fetched. Inline, that is untrusted content
  // on a command line nothing will ask about, where a `;` ends the invocation
  // and starts another. A path is not text from the review.
  const whole = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const commands = [...whole.matchAll(/^\s*devin .*$/gm)].map((m) => m[0].trim());
  assert.ok(commands.length, 'the skill no longer shows the command at all');
  for (const command of commands) {
    assert.ok(/--prompt-file\s+\S/.test(command),
      `"${command}" does not name a prompt file`);
    // `-p` ends the command, and nothing may follow it. Rejecting only a quoted
    // argument left `devin ... -p unquoted review text` passing, which puts the
    // same content on the same granted command line without the quotes that
    // made it look wrong.
    assert.ok(command.endsWith('-p'),
      `"${command}" puts something after -p, where review content reaches a granted command line`);
  }
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
  // Upgrade notes live in CHANGELOG.md, not the README. Same requirement, and
  // the note still has to name both the old command and the new one.
  const readme = fs.readFileSync(CHANGELOG, 'utf8');
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
