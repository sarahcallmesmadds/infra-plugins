#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, 'plugins/build-loop/skills/devin-review-response');
const EVIDENCE = path.join(ROOT, 'plugins/build-loop/scripts/review-evidence.js');
const VALIDATOR = path.join(ROOT, 'plugins/build-loop/scripts/pre-push-check.js');
const PUSH_HELPER = path.join(ROOT, 'plugins/build-loop/scripts/push-review-response.js');
const TEMPLATES = path.join(SKILL, 'references/templates.md');
const README = path.join(ROOT, 'plugins/build-loop/README.md');
const CHANGELOG = path.join(ROOT, 'plugins/build-loop/CHANGELOG.md');
const BOT_ID = 158243242;
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
let passed = 0;

function check(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}\n${error.stack}`); process.exitCode = 1; }
}

function temp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-round-'));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function reviewBody(count = 1, additional = 0, isNew = false) {
  const issue = count === 1 ? 'issue' : 'issues';
  const summary = `**Devin Review** found ${count}${isNew ? ' new' : ''} potential ${issue}.`;
  const hidden = additional
    ? `\n\nView ${additional} additional ${additional === 1 ? 'finding' : 'findings'} in Devin Review.`
    : '';
  return `${summary}${hidden}\n\n<!-- devin-review-badge-begin -->\n<a>synthetic badge</a>\n<!-- devin-review-badge-end -->`;
}

function noIssuesReviewBody(withSummaryMarker = true) {
  const marker = withSummaryMarker ? '\n\n<!-- devin-review-summary -->' : '';
  return `## ✅ Devin Review: No Issues Found\n\nDevin Review analyzed this PR and found no bugs or issues to report.\n\n<!-- devin-review-badge-begin -->\n<a>synthetic badge</a>\n<!-- devin-review-badge-end -->${marker}`;
}

function review(id = 1, body = reviewBody(), commit = HEAD, reviewerId = BOT_ID, state = 'COMMENTED') {
  return { id, body, commit_id: commit,
    html_url: `https://example.invalid/reviews/${id}`,
    state, user: { id: reviewerId, login: 'synthetic-reviewer' } };
}

function comment(id = 11, reviewId = 1, body = 'Synthetic finding', commit = HEAD) {
  return { id, pull_request_review_id: reviewId, body,
    html_url: `https://example.invalid/comments/${id}`,
    path: 'src/example.js', line: 10, commit_id: commit,
    user: { id: BOT_ID, login: 'synthetic-reviewer' } };
}

function evidenceModule() {
  delete require.cache[require.resolve(EVIDENCE)];
  return require(EVIDENCE);
}

function appCapture(reviews = [review()], comments = [comment()], requestedHeadSha = HEAD) {
  const { normalizeAppPayload } = evidenceModule();
  const normalized = normalizeAppPayload({
    repository: 'o/r', pr: 12, requestedHeadSha,
    expectedReviewerId: BOT_ID, reviews, comments,
  });
  return {
    schema_version: 1,
    kind: 'github_app_capture',
    repository: 'o/r',
    pr: 12,
    requested_head_sha: requestedHeadSha,
    expected_reviewer_id: BOT_ID,
    captured_at: '2026-08-27T12:00:00.000Z',
    status: normalized.status,
    errors: normalized.errors,
    pagination: {
      reviews: { pages: 1, item_count: reviews.length },
      comments: { pages: 1, item_count: comments.length },
    },
    raw_reviews: reviews,
    raw_comments: comments,
    runs: normalized.runs,
  };
}

function fixedFinding(id = 'F1', reportIds = ['APP-REPORT-1']) {
  return {
    id, source_report_ids: reportIds, severity: 'high',
    location: 'src/example.js:10', summary: 'The failure path reports success',
    disposition: 'fixed', evidence: 'Return the error result to the caller',
    tracking_id: null, base_evidence: null,
    dependency_audit: ['src/caller.js checked'],
    paired_file_audit: ['tests/example.test.js changed'],
    changed_files: ['src/example.js', 'tests/example.test.js'],
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fakeGhEnvironment(dir, head, capture, overrides = {}) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'gh');
  const heads = Array.isArray(head) ? head : [head, head];
  const branches = Array.isArray(overrides.branch)
    ? overrides.branch : [overrides.branch || 'feature/example', overrides.branch || 'feature/example'];
  const repositories = Array.isArray(overrides.repository)
    ? overrides.repository : [overrides.repository || 'o/r', overrides.repository || 'o/r'];
  const identities = heads.map((sha, index) => JSON.stringify({
    headRefOid: sha,
    headRefName: branches[index] || branches[0],
    headRepository: { nameWithOwner: repositories[index] || repositories[0] },
  }));
  const marker = path.join(dir, 'gh-head-read');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    '  case " $* " in *" --repo github.com/o/r "*) ;; *) exit 4 ;; esac',
    '  if [ -f "$SYNTHETIC_PR_HEAD_MARKER" ]; then',
    '    if [ -n "$SYNTHETIC_LOCAL_MUTATION_FILE" ]; then',
    '      printf "late mutation\\n" > "$SYNTHETIC_LOCAL_MUTATION_FILE"',
    '    fi',
    '    if [ -n "$SYNTHETIC_REMOTE_MUTATION_REPO" ]; then',
    '      git -C "$SYNTHETIC_REMOTE_MUTATION_REPO" remote set-url origin "$SYNTHETIC_REMOTE_MUTATION_URL" || exit 3',
    '    fi',
    '    printf "%s\\n" "$SYNTHETIC_PR_IDENTITY_SECOND"',
    '  else',
    '    : > "$SYNTHETIC_PR_HEAD_MARKER"',
    '    printf "%s\\n" "$SYNTHETIC_PR_IDENTITY_FIRST"',
    '  fi',
    'elif [ "$1" = "api" ]; then',
    '  case " $* " in *" --hostname github.com "*) ;; *) exit 4 ;; esac',
    '  case "$*" in',
    '    *"/reviews?per_page=100"*) printf "%s\\n" "$SYNTHETIC_REVIEWS" ;;',
    '    *"/comments?per_page=100"*) printf "%s\\n" "$SYNTHETIC_COMMENTS" ;;',
    '    *) exit 2 ;;',
    '  esac',
    'else',
    '  exit 2',
    'fi',
    '',
  ].join('\n'));
  fs.chmodSync(executable, 0o755);
  return {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    GH_HOST: 'example.invalid',
    SYNTHETIC_PR_IDENTITY_FIRST: identities[0],
    SYNTHETIC_PR_IDENTITY_SECOND: identities[1] || identities[0],
    SYNTHETIC_PR_HEAD_MARKER: marker,
    SYNTHETIC_LOCAL_MUTATION_FILE: overrides.localMutationFile || '',
    SYNTHETIC_REMOTE_MUTATION_REPO: overrides.remoteMutationRepo || '',
    SYNTHETIC_REMOTE_MUTATION_URL: overrides.remoteMutationUrl || '',
    SYNTHETIC_REVIEWS: JSON.stringify([overrides.reviews || capture.raw_reviews]),
    SYNTHETIC_COMMENTS: JSON.stringify([overrides.comments || capture.raw_comments]),
  };
}

function baseState(dir) {
  const capture = appCapture();
  const captureFile = path.join(dir, 'github-app.json');
  writeJson(captureFile, capture);
  return {
    dir, capture, captureFile,
    round: {
      repository: 'o/r', head_repository: 'o/r', push_remote: 'origin',
      pr: 12, round: 1, branch: 'feature/example',
      review_head_sha: HEAD, response_head_sha: null, response_mode: null,
      expected_reviewer_id: BOT_ID, app_capture: captureFile,
      cli_not_run_reason: 'not-needed', finding_set_complete: true,
      review_outcome: 'findings',
      review_runs: [{ id: 'GITHUB-APP-1', source: 'github_app', purpose: 'posted',
        capture_id: 'github-review-1', report_ids: ['APP-REPORT-1'] }],
      source_reports: [{ id: 'APP-REPORT-1', run_id: 'GITHUB-APP-1',
        capture_report_id: 'comment-11', finding_id: 'F1', same_as: [] }],
      findings: [fixedFinding()],
      verification: [{ command: 'node tests/run-all.js', outcome: 'passed' }],
    },
  };
}

function validate(mutator, options = {}) {
  return temp((dir) => {
    const state = baseState(dir);
    if (mutator) mutator(state);
    writeJson(state.captureFile, state.capture);
    const roundFile = path.join(dir, 'round.json');
    writeJson(roundFile, state.round);
    const phase = options.phase === undefined ? 'pre-commit' : options.phase;
    const args = [VALIDATOR];
    if (phase !== null) args.push('--phase', phase);
    if (options.repoRoot) args.push('--repo-root', options.repoRoot);
    args.push(roundFile);
    const env = options.env || (options.currentPrHead
      ? fakeGhEnvironment(dir, options.currentPrHead, state.capture, {
        reviews: options.liveReviews,
        comments: options.liveComments,
        branch: options.currentPrBranch,
        repository: options.currentPrRepository,
        localMutationFile: options.localMutationFile,
        remoteMutationRepo: options.remoteMutationRepo,
        remoteMutationUrl: options.remoteMutationUrl,
      })
      : process.env);
    return spawnSync(process.execPath, args, { encoding: 'utf8', env });
  });
}

function makeClean(state) {
  state.capture = appCapture([review(1, '')], []);
  state.round.review_runs[0].report_ids = [];
  state.round.source_reports = [];
  state.round.findings = [];
  state.round.review_outcome = 'clean';
}

function cliCapture(dir, name, overrides = {}) {
  const sha = overrides.sha || HEAD;
  const status = overrides.status || 'complete';
  const outcome = Object.prototype.hasOwnProperty.call(overrides, 'outcome')
    ? overrides.outcome : 'clean';
  const count = Object.prototype.hasOwnProperty.call(overrides, 'count')
    ? overrides.count : 0;
  const defaultOutput = status === 'preflight-failed'
    ? 'Error: Refusing to run in an untrusted workspace: /synthetic\n'
    : status === 'incomplete' ? 'Error: synthetic unknown failure\n'
      : `Synthetic Devin result\nDEVIN_REVIEW_COMPLETE outcome=${outcome} finding_count=${count}\n`;
  const output = overrides.outputPath || path.join(dir, `${name}.txt`);
  fs.writeFileSync(output, overrides.outputText || defaultOutput);
  const capture = {
    schema_version: 1, kind: 'devin_cli_capture',
    repository_root: overrides.repoRoot || '/synthetic/repository',
    purpose: overrides.purpose || 'proactive', review_head_sha: sha,
    started_at: overrides.startedAt || '2026-08-27T12:00:00.000Z', start_git_status: [],
    exit_code: Object.prototype.hasOwnProperty.call(overrides, 'exitCode')
      ? overrides.exitCode : status === 'complete' ? 0 : 1,
    status, outcome, reported_finding_count: count,
    raw_output_path: output,
    raw_output_sha256: crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'),
    finished_at: overrides.finishedAt || '2026-08-27T12:01:00.000Z', finish_head_sha: sha,
    finish_git_status: [],
  };
  const file = path.join(dir, `${name}.json`);
  writeJson(file, capture);
  return { file, capture };
}

function addCli(state, options = {}) {
  const id = options.id || 'DEVIN-CLI-1';
  const made = cliCapture(state.dir, id.toLowerCase(), options);
  state.round.cli_not_run_reason = null;
  state.round.review_runs.push({
    id, source: 'devin_cli', purpose: options.purpose || 'proactive', capture: made.file,
    status: options.status || 'complete',
    outcome: Object.prototype.hasOwnProperty.call(options, 'outcome') ? options.outcome : 'clean',
    reported_finding_count: Object.prototype.hasOwnProperty.call(options, 'count') ? options.count : 0,
    evidence: [made.file, made.capture.raw_output_path],
    superseded_by: options.supersededBy || null,
  });
  return made;
}

function initRepo(dir) {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  for (const args of [
    ['init', '-b', 'feature/example'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'user.name', 'Synthetic Test'],
  ]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
  }
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n');
  spawnSync('git', ['add', 'file.txt'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'base'], { cwd: repo });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: repo });
  return repo;
}

check('skill ships every linked reference', () => {
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  for (const match of body.matchAll(/\]\((references\/[^)]+)\)/g)) {
    assert.ok(fs.existsSync(path.join(SKILL, match[1])), `missing ${match[1]}`);
  }
});

check('skill keeps narrow permissions and prompt-file recovery', () => {
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const front = body.slice(0, body.indexOf('---', 4));
  assert.match(front, /Bash\(node:\*\)/);
  assert.match(front, /Bash\(devin --permission-mode auto --prompt-file:\*\)/);
  assert.doesNotMatch(front, /\bBash\b(?!\s*\()/);
  assert.doesNotMatch(front, /Bash\((?:git add|git commit|git push|gh pr merge):\*\)/);
  for (const command of [...body.matchAll(/^\s*devin .*$/gm)].map((m) => m[0].trim())) {
    assert.match(command, /--prompt-file\s+\S/);
    assert.ok(command.endsWith('-p'), `review content follows -p in ${command}`);
  }
});

check('skill reconciles app and CLI without false clean', () => {
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(body, /clean result from one source says nothing about the other/i);
  assert.match(body, /every posted app review/i);
  assert.match(body, /every known proactive CLI/i);
  assert.match(body, /same `review_head_sha`/);
  assert.match(body, /CLI clean plus app findings.*findings/is);
});

check('skill uses immutable reviewer identity and explicit validation phases', () => {
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const front = body.slice(0, body.indexOf('---', 4));
  assert.match(body, /expected_reviewer_id/);
  assert.match(body, /--reviewer-id EXPECTED_REVIEWER_ID_FROM_ROUND/);
  assert.doesNotMatch(body, /reviewer.*login.*match/i);
  assert.match(body, /--phase pre-commit/);
  assert.match(body, /--phase pre-push --repo-root/);
  assert.match(body, /explicit approval before `git add` or `git commit`/i);
  assert.ok(body.indexOf('explicit approval before `git add` or `git commit`')
    < body.indexOf('--phase pre-push --repo-root'));
  assert.match(body, /gh auth status/);
  assert.match(body, /headRepository/);
  assert.match(body, /push_remote/);
  assert.match(body, /gh pr comment.*--body-file/);
  assert.match(body, /explicit\s+approval for the GitHub write/i);
  const finalHeadRead = body.lastIndexOf('--json headRefOid');
  const post = body.lastIndexOf('gh pr comment');
  assert.ok(finalHeadRead > body.indexOf('After approval') && finalHeadRead < post,
    'the live PR head must be re-read after approval and immediately before posting');
  assert.match(body, /headRefOid` to equal.*`response_head_sha`/s);
  assert.doesNotMatch(front, /Bash\(gh pr comment/);
  assert.match(body, /\/usr\/bin\/env node.*push-review-response\.js/);
});

check('push helper keeps a hostile branch name inside one git argument', () => {
  delete require.cache[require.resolve(PUSH_HELPER)];
  const { pushArguments, selectPushDestination } = require(PUSH_HELPER);
  const branch = 'fix;id;#';
  const destination = 'ssh://git@github.com:22/o/r.git';
  assert.deepStrictEqual(pushArguments({
    response_mode: 'commit', push_remote: 'fork', branch,
    review_head_sha: HEAD, response_head_sha: OTHER_HEAD,
  }, destination), ['push', `--force-with-lease=refs/heads/${branch}:${HEAD}`,
    '--end-of-options', destination, `${OTHER_HEAD}:refs/heads/${branch}`]);
  assert.strictEqual(selectPushDestination([
    destination, 'https://github.com/o/r.git',
  ]), destination, 'multiple URLs for one validated repository must produce one push destination');
});

check('push helper pins the recorded response and exact remote head', () => temp((dir) => {
  const repo = initRepo(dir);
  const remote = path.join(dir, 'remote.git');
  let command = spawnSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  command = spawnSync('git', ['remote', 'set-url', 'origin', remote], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  const branch = 'feature/example';
  const branchRef = `refs/heads/${branch}`;
  const reviewed = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  command = spawnSync('git', ['push', '--end-of-options', 'origin', `${branchRef}:${branchRef}`],
    { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'review response\n');
  spawnSync('git', ['add', 'file.txt'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'response'], { cwd: repo });
  const response = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  command = spawnSync('git', ['tag', branch, reviewed], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'unvalidated local change\n');
  spawnSync('git', ['add', 'file.txt'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'unvalidated'], { cwd: repo });
  const unvalidated = spawnSync('git', ['rev-parse', 'HEAD'],
    { cwd: repo, encoding: 'utf8' }).stdout.trim();

  delete require.cache[require.resolve(PUSH_HELPER)];
  const { pushArguments } = require(PUSH_HELPER);
  const args = pushArguments({ response_mode: 'commit', push_remote: 'origin', branch,
    review_head_sha: reviewed, response_head_sha: response }, remote);
  command = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  const remoteHead = spawnSync('git', ['--git-dir', remote, 'rev-parse', branchRef],
    { encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(remoteHead, response);
  command = spawnSync('git', ['push', '--end-of-options', 'origin', `${unvalidated}:${branchRef}`],
    { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  command = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.notStrictEqual(command.status, 0, 'stale expected-old lease unexpectedly pushed');
}));

check('push helper neutralizes Git URL rewrites after destination validation', () => temp((dir) => {
  const repo = initRepo(dir);
  const intended = path.join(dir, 'intended.git');
  const redirected = path.join(dir, 'redirected.git');
  for (const remote of [intended, redirected]) {
    const initialized = spawnSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
    assert.strictEqual(initialized.status, 0, initialized.stderr);
  }
  const branchRef = 'refs/heads/feature/example';
  const reviewed = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  for (const remote of [intended, redirected]) {
    const seeded = spawnSync('git', ['push', '--end-of-options', remote, `${reviewed}:${branchRef}`],
      { cwd: repo, encoding: 'utf8' });
    assert.strictEqual(seeded.status, 0, seeded.stderr);
  }
  fs.writeFileSync(path.join(repo, 'file.txt'), 'isolated response\n');
  spawnSync('git', ['add', 'file.txt'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'isolated response'], { cwd: repo });
  const response = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const rewriteKey = `url.file://${redirected}.insteadOf`;
  const configured = spawnSync('git', ['config', rewriteKey, intended], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(configured.status, 0, configured.stderr);

  delete require.cache[require.resolve(PUSH_HELPER)];
  const { pushArguments, pushWithIsolatedConfig } = require(PUSH_HELPER);
  const result = pushWithIsolatedConfig(repo, pushArguments({
    response_mode: 'commit', push_remote: 'origin', branch: 'feature/example',
    review_head_sha: reviewed, response_head_sha: response,
  }, intended), 'pipe');
  assert.strictEqual(result.status, 0, result.stderr);
  const intendedHead = spawnSync('git', ['--git-dir', intended, 'rev-parse', branchRef],
    { encoding: 'utf8' }).stdout.trim();
  const redirectedHead = spawnSync('git', ['--git-dir', redirected, 'rev-parse', branchRef],
    { encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(intendedHead, response);
  assert.strictEqual(redirectedHead, reviewed);
}));

check('push helper preserves a shallow clone boundary', () => temp((dir) => {
  const source = initRepo(dir);
  const remote = path.join(dir, 'shallow-origin.git');
  let command = spawnSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  command = spawnSync('git', ['push', '--end-of-options', remote,
    'refs/heads/feature/example:refs/heads/feature/example'], { cwd: source, encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  const shallow = path.join(dir, 'shallow');
  command = spawnSync('git', ['clone', '--depth=1', '--branch', 'feature/example',
    `file://${remote}`, shallow], { encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: shallow });
  spawnSync('git', ['config', 'user.name', 'Synthetic Test'], { cwd: shallow });
  const reviewed = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: shallow, encoding: 'utf8',
  }).stdout.trim();
  fs.writeFileSync(path.join(shallow, 'response.txt'), 'response\n');
  spawnSync('git', ['add', 'response.txt'], { cwd: shallow });
  spawnSync('git', ['commit', '-m', 'response'], { cwd: shallow });
  const response = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: shallow, encoding: 'utf8',
  }).stdout.trim();

  delete require.cache[require.resolve(PUSH_HELPER)];
  const { pushArguments, pushWithIsolatedConfig } = require(PUSH_HELPER);
  const result = pushWithIsolatedConfig(shallow, pushArguments({
    response_mode: 'commit', push_remote: 'origin', branch: 'feature/example',
    review_head_sha: reviewed, response_head_sha: response,
  }, remote), 'pipe');
  assert.strictEqual(result.status, 0, result.stderr);
  const remoteHead = spawnSync('git', ['--git-dir', remote, 'rev-parse',
    'refs/heads/feature/example'], { encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(remoteHead, response);
}));

check('push helper falls back when Git lacks path-format', () => temp((dir) => {
  const repo = initRepo(dir);
  const remote = path.join(dir, 'legacy-origin.git');
  let command = spawnSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  const reviewed = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  command = spawnSync('git', ['push', '--end-of-options', remote,
    `${reviewed}:refs/heads/feature/example`], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  fs.writeFileSync(path.join(repo, 'legacy.txt'), 'response\n');
  spawnSync('git', ['add', 'legacy.txt'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'legacy response'], { cwd: repo });
  const response = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const realGit = (process.env.PATH || '').split(path.delimiter)
    .map((entry) => path.join(entry, 'git')).find((candidate) => fs.existsSync(candidate));
  assert.ok(realGit, 'git executable is unavailable');
  const bin = path.join(dir, 'legacy-bin');
  fs.mkdirSync(bin);
  const wrapper = path.join(bin, 'git');
  fs.writeFileSync(wrapper, [
    '#!/bin/sh',
    'case " $* " in',
    '  *" --path-format=absolute "*)',
    '    printf "%s\\n" "--path-format=absolute"',
    '    exec "$SYNTHETIC_REAL_GIT" rev-parse --git-path "$4"',
    '    ;;',
    'esac',
    'exec "$SYNTHETIC_REAL_GIT" "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(wrapper, 0o755);
  const priorPath = process.env.PATH;
  const priorRealGit = process.env.SYNTHETIC_REAL_GIT;
  process.env.PATH = `${bin}${path.delimiter}${priorPath || ''}`;
  process.env.SYNTHETIC_REAL_GIT = realGit;
  try {
    delete require.cache[require.resolve(PUSH_HELPER)];
    const { pushArguments, pushWithIsolatedConfig } = require(PUSH_HELPER);
    const result = pushWithIsolatedConfig(repo, pushArguments({
      response_mode: 'commit', push_remote: 'origin', branch: 'feature/example',
      review_head_sha: reviewed, response_head_sha: response,
    }, remote), 'pipe');
    assert.strictEqual(result.status, 0, result.stderr);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorRealGit === undefined) delete process.env.SYNTHETIC_REAL_GIT;
    else process.env.SYNTHETIC_REAL_GIT = priorRealGit;
  }
  const remoteHead = spawnSync('git', ['--git-dir', remote, 'rev-parse',
    'refs/heads/feature/example'], { encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(remoteHead, response);
}));

check('skill shell-quotes every substituted path in command blocks', () => {
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.doesNotMatch(body,
    /(?:--repo-root|--out|--capture|--output|--prompt-file|--export|--round|--body-file)\s+(?:\{scratch\}|\/path\/to\/)/,
    'a flag is followed by an unquoted substituted path');
  assert.doesNotMatch(body, /\s\/path\/to\//,
    'a positional substituted path is unquoted');
  assert.match(body, /git remote get-url --push --all -- 'PUSH_REMOTE'/,
    'the substituted remote name must be quoted after an option terminator');
});

check('skill preserves trust, read-only GitHub, and prompt safety rules', () => {
  const body = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(body, /gh api --method GET/);
  assert.match(body, /body, not the check status/i);
  assert.match(body, /devin --respect-workspace-trust false --permission-mode auto/);
  assert.match(body, /authorized recovery returns nothing usable,\s+stop/i);
  assert.doesNotMatch(body, /paste.*fallback/i);
  assert.match(body, /prompt goes in the file/i);
});

check('Build Loop docs keep existing counts and rename note', () => {
  const readme = fs.readFileSync(README, 'utf8');
  const heading = readme.match(/^## The (\w+) commands$/m);
  const codex = readme.match(/The (\w+) commands are identical on both runtimes/);
  assert.ok(heading && codex);
  assert.strictEqual(codex[1], heading[1]);
  const changelog = fs.readFileSync(CHANGELOG, 'utf8');
  const note = changelog.match(/^## Upgrading to 0\.8\.1\n([\s\S]*?)(?=^## |\z)/m);
  assert.ok(note);
  assert.match(note[1], /\/address-devin-review/);
  assert.match(note[1], /\/devin-review-response/);
  assert.match(note[1], /not retained as an alias/);
  assert.match(readme, /devin-review-response.*GitHub CLI[\s\S]*gh auth login/i);
  assert.match(changelog, /0\.10\.20[\s\S]*authenticated[\s\S]*gh auth login/i);
});

check('reference templates use the validator schema exactly', () => {
  const body = fs.readFileSync(TEMPLATES, 'utf8');
  const blocks = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  const appRun = blocks[0].review_runs[0];
  assert.deepStrictEqual(Object.keys(appRun).sort(),
    ['capture_id', 'id', 'purpose', 'report_ids', 'source']);
  assert.strictEqual(appRun.source, 'github_app');
  assert.strictEqual(appRun.purpose, 'posted');
  for (const response of blocks.slice(2)) {
    assert.ok(Object.prototype.hasOwnProperty.call(response, 'response_head_sha'));
    assert.ok(!Object.prototype.hasOwnProperty.call(response, 'response_commit'));
  }
  assert.match(body, /`positive-flag` findings/);
  assert.doesNotMatch(body, /`positive` findings/);
});

check('normalizer accepts exact singular, plural, new, and no-additional shapes', () => {
  const { parseReviewBody } = evidenceModule();
  for (const [body, visible, hidden] of [
    [reviewBody(1, 1, false), 1, 1], [reviewBody(2, 2, false), 2, 2],
    [reviewBody(1, 0, true), 1, 0], [reviewBody(2, 0, true), 2, 0],
  ]) {
    const comments = Array.from({ length: visible }, (_, i) => comment(20 + i));
    const parsed = parseReviewBody(body, comments);
    assert.strictEqual(parsed.status, 'complete', JSON.stringify(parsed));
    assert.strictEqual(parsed.visible_count, visible);
    assert.strictEqual(parsed.hidden_count, hidden);
  }
});

check('normalizer accepts the established legacy hidden-finding sentence', () => {
  const { parseReviewBody } = evidenceModule();
  const body = reviewBody(1).replace(
    '\n\n<!-- devin-review-badge-begin -->',
    '\n\nView in Devin Review to see 1 additional finding\n\n<!-- devin-review-badge-begin -->'
  );
  const parsed = parseReviewBody(body, [comment()]);
  assert.strictEqual(parsed.status, 'complete', JSON.stringify(parsed));
  assert.strictEqual(parsed.hidden_count, 1);
});

check('normalizer treats resolution-only empty bodies as clean', () => {
  const { parseReviewBody } = evidenceModule();
  for (const comments of [[], [comment(1, 1, '✅ **Resolved**: synthetic resolution')]]) {
    const parsed = parseReviewBody('', comments);
    assert.strictEqual(parsed.status, 'complete');
    assert.strictEqual(parsed.outcome, 'clean');
    assert.strictEqual(parsed.expected_report_count, 0);
  }
});

check('normalizer accepts the observed no-issues envelopes', () => {
  const { parseReviewBody } = evidenceModule();
  for (const body of [noIssuesReviewBody(false), noIssuesReviewBody(true)]) {
    const parsed = parseReviewBody(body, []);
    assert.strictEqual(parsed.status, 'complete', JSON.stringify(parsed));
    assert.strictEqual(parsed.outcome, 'clean');
    assert.strictEqual(parsed.expected_report_count, 0);
  }
  const inconsistent = parseReviewBody(noIssuesReviewBody(), [comment()]);
  assert.strictEqual(inconsistent.status, 'incomplete');
  assert.match(inconsistent.error, /no-issues.*comment/i);
});

check('normalizer fails closed on grammar and count drift', () => {
  const { parseReviewBody } = evidenceModule();
  for (const [body, comments] of [
    ['**Devin Review** found potential issues.', []],
    [reviewBody(2), [comment()]],
    [reviewBody(1).replace('potential issue', 'possible issue'), [comment()]],
    [reviewBody(1).replace('<!-- devin-review-badge-end -->', '<!-- other-end -->'), [comment()]],
    ['', [comment()]],
    [reviewBody(1).replace('found 1', 'found 4294967296'), [comment()]],
    [reviewBody(1, 1).replace('View 1 additional', 'View 4294967296 additional'), [comment()]],
  ]) assert.strictEqual(parseReviewBody(body, comments).status, 'incomplete');
});

check('normalizer retains every same-SHA review and cannot erase findings with a clean retry', () => {
  const capture = appCapture([review(1, reviewBody(1)), review(2, '')], [comment(11, 1)]);
  assert.strictEqual(capture.runs.length, 2);
  assert.strictEqual(capture.status, 'complete');
  assert.deepStrictEqual(capture.runs.map((r) => r.outcome), ['findings', 'clean']);
});

check('pending reviews and orphan same-SHA Devin comments block capture', () => {
  const pending = appCapture([review(1, '', HEAD, BOT_ID, 'PENDING')], []);
  assert.strictEqual(pending.status, 'incomplete');
  assert.match(pending.errors.join('\n'), /not submitted/i);
  const orphan = appCapture([review(1, '')], [comment(22, 2)]);
  assert.strictEqual(orphan.status, 'incomplete');
  assert.match(orphan.errors.join('\n'), /no captured review/i);
});

check('human thread replies are not counted as Devin findings', () => {
  const humanReply = {
    ...comment(12, 1, 'Synthetic human reply'),
    user: { id: 42, login: 'synthetic-human' },
  };
  const capture = appCapture([review()], [comment(), humanReply]);
  assert.strictEqual(capture.status, 'complete', JSON.stringify(capture.errors));
  assert.strictEqual(capture.runs[0].reports.length, 1);
  assert.strictEqual(capture.runs[0].reports[0].comment_id, 11);
});

check('capture transport consumes every reviews and comments page', () => {
  const { collectAppEvidence } = evidenceModule();
  const requested = [];
  const getPages = (endpoint) => {
    requested.push(endpoint);
    if (endpoint === 'reviews') return [[review(1)], [review(2, '', HEAD)]];
    return [[comment(11, 1)], []];
  };
  const capture = collectAppEvidence({
    repository: 'o/r', pr: 12, requestedHeadSha: HEAD, expectedReviewerId: BOT_ID,
  }, getPages);
  assert.deepStrictEqual(requested, ['reviews', 'comments', 'reviews', 'comments']);
  assert.strictEqual(capture.pagination.reviews.pages, 2);
  assert.strictEqual(capture.pagination.comments.pages, 2);
  assert.strictEqual(capture.raw_reviews.length, 2);
  assert.strictEqual(capture.raw_comments.length, 1);
});

check('capture transport rejects reviews or comments that change between reads', () => {
  const { collectAppEvidence } = evidenceModule();
  let reviewRead = 0;
  const capture = collectAppEvidence({
    repository: 'o/r', pr: 12, requestedHeadSha: HEAD, expectedReviewerId: BOT_ID,
  }, (endpoint) => {
    if (endpoint === 'comments') return [[comment(11, 1)]];
    reviewRead += 1;
    return reviewRead === 1 ? [[review(1)]] : [[review(1), review(2, '')]];
  });
  assert.strictEqual(capture.status, 'incomplete');
  assert.match(capture.errors.join('\n'), /changed during capture/i);

  let commentRead = 0;
  const changedComment = collectAppEvidence({
    repository: 'o/r', pr: 12, requestedHeadSha: HEAD, expectedReviewerId: BOT_ID,
  }, (endpoint) => {
    if (endpoint === 'reviews') return [[review(1)]];
    commentRead += 1;
    return commentRead === 1 ? [[comment(11, 1)]] : [[comment(11, 1, 'Edited finding')]];
  });
  assert.strictEqual(changedComment.status, 'incomplete');
  assert.match(changedComment.errors.join('\n'), /comments changed/i);
});

check('complete fixed round passes', () => {
  const result = validate();
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /pre-commit ready/);
});

check('app clean with CLI not-needed passes', () => {
  const result = validate(makeClean);
  assert.strictEqual(result.status, 0, result.stderr);
});

check('one or more same-SHA clean CLI runs pass with a clean app', () => {
  const result = validate((state) => {
    makeClean(state);
    addCli(state, { id: 'DEVIN-CLI-1' });
    addCli(state, { id: 'DEVIN-CLI-2', purpose: 'recovery' });
  });
  assert.strictEqual(result.status, 0, result.stderr);
});

check('two CLI rows cannot reuse one capture through a path alias', () => {
  const result = validate((state) => {
    makeClean(state);
    const made = addCli(state);
    const alias = path.join(state.dir, 'cli-alias.json');
    fs.symlinkSync(made.file, alias);
    state.round.review_runs.push({
      ...state.round.review_runs[state.round.review_runs.length - 1],
      id: 'DEVIN-CLI-2',
      capture: alias,
    });
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /CLI capture is already used/i);
});

check('two CLI attempts cannot reuse one raw output file', () => {
  const result = validate((state) => {
    makeClean(state);
    const shared = path.join(state.dir, 'shared-output.txt');
    addCli(state, { id: 'DEVIN-CLI-1', outputPath: shared });
    addCli(state, { id: 'DEVIN-CLI-2', outputPath: shared });
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /raw CLI output is already used/i);
});

check('CLI output cannot alias app or CLI capture metadata', () => {
  const appAlias = validate((state) => {
    makeClean(state);
    const made = addCli(state);
    made.capture.raw_output_path = state.captureFile;
    const appBytes = Buffer.from(`${JSON.stringify(state.capture, null, 2)}\n`);
    made.capture.raw_output_sha256 = crypto.createHash('sha256').update(appBytes).digest('hex');
    writeJson(made.file, made.capture);
    state.round.review_runs.at(-1).evidence = [made.file, state.captureFile];
  });
  assert.strictEqual(appAlias.status, 1);
  assert.match(appAlias.stderr, /raw CLI output is already used by app capture/i);

  const cliAlias = validate((state) => {
    makeClean(state);
    const first = addCli(state, { id: 'DEVIN-CLI-1' });
    const second = addCli(state, { id: 'DEVIN-CLI-2' });
    first.capture.raw_output_path = second.file;
    first.capture.raw_output_sha256 = crypto.createHash('sha256')
      .update(fs.readFileSync(second.file)).digest('hex');
    writeJson(first.file, first.capture);
    state.round.review_runs.find((run) => run.id === 'DEVIN-CLI-1').evidence = [first.file, second.file];
  });
  assert.strictEqual(cliAlias.status, 1);
  assert.match(cliAlias.stderr, /CLI capture is already used by DEVIN-CLI-1 as raw CLI output/i);
});

check('app findings plus CLI clean remain findings', () => {
  const result = validate((state) => addCli(state));
  assert.strictEqual(result.status, 0, result.stderr);
});

check('omitting app or CLI reports fails', () => {
  const app = validate((state) => { state.round.source_reports = []; state.round.findings = []; });
  assert.strictEqual(app.status, 1);
  assert.match(app.stderr, /APP-REPORT-1|report/i);
  const cli = validate((state) => { makeClean(state); addCli(state, { outcome: 'findings', count: 1 }); });
  assert.strictEqual(cli.status, 1);
  assert.match(cli.stderr, /DEVIN-CLI-1.*report/i);
});

check('run count, mixed SHA, pending capture, and incomplete CLI fail', () => {
  const count = validate((state) => state.round.review_runs[0].report_ids = []);
  assert.strictEqual(count.status, 1);
  assert.match(count.stderr, /report_ids|expected 1 report/i);
  const mixed = validate((state) => addCli(state, { sha: OTHER_HEAD }));
  assert.strictEqual(mixed.status, 1);
  assert.match(mixed.stderr, /review_head_sha/);
  const pending = validate((state) => state.capture.status = 'incomplete');
  assert.strictEqual(pending.status, 1);
  assert.match(pending.stderr, /capture.*complete/i);
  const incomplete = validate((state) => addCli(state, { status: 'incomplete', outcome: null }));
  assert.strictEqual(incomplete.status, 1);
  assert.match(incomplete.stderr, /incomplete/);
});

check('top-level outcome is mechanically derived from the ledger', () => {
  const falseClean = validate((state) => state.round.review_outcome = 'clean');
  assert.strictEqual(falseClean.status, 1);
  assert.match(falseClean.stderr, /non-empty.*findings/i);
  const falseFindings = validate((state) => { makeClean(state); state.round.review_outcome = 'findings'; });
  assert.strictEqual(falseFindings.status, 1);
  assert.match(falseFindings.stderr, /empty.*clean/i);
});

check('same defect reports remain separate with a reciprocal same_as link', () => {
  const result = validate((state) => {
    addCli(state, { outcome: 'findings', count: 1 });
    state.round.source_reports[0].same_as = ['CLI-REPORT-1'];
    state.round.source_reports.push({ id: 'CLI-REPORT-1', run_id: 'DEVIN-CLI-1',
      ordinal: 1, finding_id: 'F1', same_as: ['APP-REPORT-1'] });
    state.round.findings[0].source_report_ids.push('CLI-REPORT-1');
  });
  assert.strictEqual(result.status, 0, result.stderr);
});

check('hidden app placeholders require a recovery report', () => {
  const resolved = validate((state) => {
    state.capture = appCapture([review(1, reviewBody(1, 1))], [comment()]);
    state.round.review_runs[0].report_ids.push('APP-HIDDEN-1');
    state.round.source_reports.push({ id: 'APP-HIDDEN-1', run_id: 'GITHUB-APP-1',
      capture_report_id: 'hidden-1-1', finding_id: 'F2', same_as: ['CLI-REPORT-1'] });
    addCli(state, { id: 'DEVIN-CLI-1', purpose: 'recovery', outcome: 'findings', count: 1 });
    state.round.source_reports.push({ id: 'CLI-REPORT-1', run_id: 'DEVIN-CLI-1',
      ordinal: 1, finding_id: 'F2', same_as: ['APP-HIDDEN-1'] });
    state.round.findings.push(fixedFinding('F2', ['APP-HIDDEN-1', 'CLI-REPORT-1']));
  });
  assert.strictEqual(resolved.status, 0, resolved.stderr);
  const unresolved = validate((state) => {
    state.capture = appCapture([review(1, reviewBody(1, 1))], [comment()]);
    state.round.review_runs[0].report_ids.push('APP-HIDDEN-1');
    state.round.source_reports.push({ id: 'APP-HIDDEN-1', run_id: 'GITHUB-APP-1',
      capture_report_id: 'hidden-1-1', finding_id: 'F1', same_as: [] });
    state.round.findings[0].source_report_ids.push('APP-HIDDEN-1');
  });
  assert.strictEqual(unresolved.status, 1);
  assert.match(unresolved.stderr, /hidden.*same_as/i);
});

check('one CLI report can recover the same hidden defect from multiple app retries', () => {
  const result = validate((state) => {
    state.capture = appCapture(
      [review(1, reviewBody(1, 1)), review(2, reviewBody(1, 1))],
      [comment(11, 1), comment(12, 2)]
    );
    state.round.review_runs[0].report_ids = ['APP-REPORT-1', 'APP-HIDDEN-1'];
    state.round.review_runs.push({
      id: 'GITHUB-APP-2', source: 'github_app', purpose: 'posted',
      capture_id: 'github-review-2', report_ids: ['APP-REPORT-2', 'APP-HIDDEN-2'],
    });
    state.round.source_reports = [
      { id: 'APP-REPORT-1', run_id: 'GITHUB-APP-1', capture_report_id: 'comment-11',
        finding_id: 'F1', same_as: [] },
      { id: 'APP-HIDDEN-1', run_id: 'GITHUB-APP-1', capture_report_id: 'hidden-1-1',
        finding_id: 'FH', same_as: ['CLI-REPORT-1'] },
      { id: 'APP-REPORT-2', run_id: 'GITHUB-APP-2', capture_report_id: 'comment-12',
        finding_id: 'F2', same_as: [] },
      { id: 'APP-HIDDEN-2', run_id: 'GITHUB-APP-2', capture_report_id: 'hidden-2-1',
        finding_id: 'FH', same_as: ['CLI-REPORT-1'] },
    ];
    addCli(state, { purpose: 'recovery', outcome: 'findings', count: 1 });
    state.round.source_reports.push({
      id: 'CLI-REPORT-1', run_id: 'DEVIN-CLI-1', ordinal: 1,
      finding_id: 'FH', same_as: ['APP-HIDDEN-1', 'APP-HIDDEN-2'],
    });
    state.round.findings = [
      fixedFinding('F1', ['APP-REPORT-1']),
      fixedFinding('F2', ['APP-REPORT-2']),
      fixedFinding('FH', ['APP-HIDDEN-1', 'APP-HIDDEN-2', 'CLI-REPORT-1']),
    ];
  });
  assert.strictEqual(result.status, 0, result.stderr);
});

check('hidden app reports cannot collapse into a visible finding from the same review', () => {
  const result = validate((state) => {
    state.capture = appCapture([review(1, reviewBody(1, 1))], [comment()]);
    state.round.review_runs[0].report_ids.push('APP-HIDDEN-1');
    state.round.source_reports[0].same_as = ['CLI-REPORT-1'];
    state.round.source_reports.push({
      id: 'APP-HIDDEN-1', run_id: 'GITHUB-APP-1',
      capture_report_id: 'hidden-1-1', finding_id: 'F1', same_as: ['CLI-REPORT-1'],
    });
    addCli(state, { purpose: 'recovery', outcome: 'findings', count: 1 });
    state.round.source_reports.push({
      id: 'CLI-REPORT-1', run_id: 'DEVIN-CLI-1', ordinal: 1,
      finding_id: 'F1', same_as: ['APP-REPORT-1', 'APP-HIDDEN-1'],
    });
    state.round.findings[0].source_report_ids.push('APP-HIDDEN-1', 'CLI-REPORT-1');
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /app reports .* from the same review cannot share finding/i);
});

check('hidden ordinals in one app run require distinct recovery reports', () => {
  const collapsed = validate((state) => {
    state.capture = appCapture([review(1, reviewBody(1, 2))], [comment()]);
    state.round.review_runs[0].report_ids = ['APP-REPORT-1', 'APP-HIDDEN-1', 'APP-HIDDEN-2'];
    state.round.source_reports.push(
      { id: 'APP-HIDDEN-1', run_id: 'GITHUB-APP-1',
        capture_report_id: 'hidden-1-1', finding_id: 'FH', same_as: ['CLI-REPORT-1'] },
      { id: 'APP-HIDDEN-2', run_id: 'GITHUB-APP-1',
        capture_report_id: 'hidden-1-2', finding_id: 'FH', same_as: ['CLI-REPORT-1'] }
    );
    addCli(state, { purpose: 'recovery', outcome: 'findings', count: 1 });
    state.round.source_reports.push({
      id: 'CLI-REPORT-1', run_id: 'DEVIN-CLI-1', ordinal: 1,
      finding_id: 'FH', same_as: ['APP-HIDDEN-1', 'APP-HIDDEN-2'],
    });
    state.round.findings.push(fixedFinding('FH', ['APP-HIDDEN-1', 'APP-HIDDEN-2', 'CLI-REPORT-1']));
  });
  assert.strictEqual(collapsed.status, 1);
  assert.match(collapsed.stderr, /already recovers hidden report/i);

  const distinct = validate((state) => {
    state.capture = appCapture([review(1, reviewBody(1, 2))], [comment()]);
    state.round.review_runs[0].report_ids = ['APP-REPORT-1', 'APP-HIDDEN-1', 'APP-HIDDEN-2'];
    state.round.source_reports.push(
      { id: 'APP-HIDDEN-1', run_id: 'GITHUB-APP-1',
        capture_report_id: 'hidden-1-1', finding_id: 'FH1', same_as: ['CLI-REPORT-1'] },
      { id: 'APP-HIDDEN-2', run_id: 'GITHUB-APP-1',
        capture_report_id: 'hidden-1-2', finding_id: 'FH2', same_as: ['CLI-REPORT-2'] }
    );
    addCli(state, { purpose: 'recovery', outcome: 'findings', count: 2 });
    state.round.source_reports.push(
      { id: 'CLI-REPORT-1', run_id: 'DEVIN-CLI-1', ordinal: 1,
        finding_id: 'FH1', same_as: ['APP-HIDDEN-1'] },
      { id: 'CLI-REPORT-2', run_id: 'DEVIN-CLI-1', ordinal: 2,
        finding_id: 'FH2', same_as: ['APP-HIDDEN-2'] }
    );
    state.round.findings.push(
      fixedFinding('FH1', ['APP-HIDDEN-1', 'CLI-REPORT-1']),
      fixedFinding('FH2', ['APP-HIDDEN-2', 'CLI-REPORT-2'])
    );
  });
  assert.strictEqual(distinct.status, 0, distinct.stderr);
});

check('preflight refusals require a later complete same-SHA retry', () => {
  const good = validate((state) => {
    makeClean(state);
    addCli(state, { id: 'DEVIN-CLI-1', purpose: 'recovery', status: 'preflight-failed',
      outcome: null, count: 0, supersededBy: 'DEVIN-CLI-2',
      startedAt: '2026-08-27T12:00:00.000Z', finishedAt: '2026-08-27T12:01:00.000Z' });
    addCli(state, { id: 'DEVIN-CLI-2', purpose: 'recovery',
      startedAt: '2026-08-27T12:02:00.000Z', finishedAt: '2026-08-27T12:03:00.000Z' });
  });
  assert.strictEqual(good.status, 0, good.stderr);
  for (const mutate of [
    (state) => addCli(state, { status: 'preflight-failed', outcome: null, count: 0 }),
    (state) => addCli(state, { status: 'preflight-failed', outcome: null, count: 0, supersededBy: 'MISSING' }),
    (state) => {
      addCli(state, { id: 'DEVIN-CLI-1', status: 'preflight-failed', outcome: null,
        count: 0, supersededBy: 'DEVIN-CLI-2' });
      addCli(state, { id: 'DEVIN-CLI-2', purpose: 'recovery' });
    },
  ]) {
    const result = validate((state) => { makeClean(state); mutate(state); });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /superseded/i);
  }
});

check('preflight supersession uses capture chronology, not ledger order', () => {
  const result = validate((state) => {
    makeClean(state);
    addCli(state, { id: 'DEVIN-CLI-1', purpose: 'recovery', status: 'preflight-failed',
      outcome: null, count: 0, supersededBy: 'DEVIN-CLI-2',
      startedAt: '2026-08-27T12:02:00.000Z', finishedAt: '2026-08-27T12:03:00.000Z' });
    addCli(state, { id: 'DEVIN-CLI-2', purpose: 'recovery',
      startedAt: '2026-08-27T12:00:00.000Z', finishedAt: '2026-08-27T12:01:00.000Z' });
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /started before the preflight failure finished/i);
});

check('CLI status is derived from the recorded exit code and raw output', () => {
  const falseComplete = validate((state) => {
    makeClean(state);
    addCli(state, {
      status: 'complete', outcome: 'clean', count: 0, exitCode: 1,
      outputText: 'Error: synthetic unknown failure\n',
    });
  });
  assert.strictEqual(falseComplete.status, 1);
  assert.match(falseComplete.stderr, /status disagrees with its exit code and raw CLI output/i);

  const falsePreflight = validate((state) => {
    makeClean(state);
    addCli(state, {
      id: 'DEVIN-CLI-1', purpose: 'recovery', status: 'preflight-failed',
      outcome: null, count: 0, exitCode: 1, supersededBy: 'DEVIN-CLI-2',
      outputText: 'Synthetic partial finding\nError: Refusing to run in an untrusted workspace: /synthetic\n',
      startedAt: '2026-08-27T12:00:00.000Z', finishedAt: '2026-08-27T12:01:00.000Z',
    });
    addCli(state, {
      id: 'DEVIN-CLI-2', purpose: 'recovery',
      startedAt: '2026-08-27T12:02:00.000Z', finishedAt: '2026-08-27T12:03:00.000Z',
    });
  });
  assert.strictEqual(falsePreflight.status, 1);
  assert.match(falsePreflight.stderr, /status disagrees with its exit code and raw CLI output/i);

  const falseOutcome = validate((state) => {
    makeClean(state);
    addCli(state, {
      outcome: 'findings', count: 1,
      outputText: 'Synthetic result\nDEVIN_REVIEW_COMPLETE outcome=clean finding_count=0\n',
    });
  });
  assert.strictEqual(falseOutcome.status, 1);
  assert.match(falseOutcome.stderr, /outcome or finding count disagrees.*completion marker/i);
});

check('no-CLI reason has one allowed value and is null when CLI ran', () => {
  for (const reason of [null, '', 'not-authorized', 'anything']) {
    const result = validate((state) => state.round.cli_not_run_reason = reason);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /cli_not_run_reason/);
  }
  const ran = validate((state) => { addCli(state); state.round.cli_not_run_reason = 'not-needed'; });
  assert.strictEqual(ran.status, 1);
});

check('capture and round identity mismatches fail', () => {
  for (const mutate of [
    (state) => state.round.repository = 'x/y',
    (state) => state.round.pr = 13,
    (state) => state.round.review_head_sha = OTHER_HEAD,
    (state) => state.round.expected_reviewer_id = 7,
  ]) {
    const result = validate(mutate);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /capture|reviewer|158243242/i);
  }
});

check('repository identity comparison accepts GitHub case differences', () => {
  const result = validate((state) => { state.round.repository = 'O/R'; });
  assert.strictEqual(result.status, 0, result.stderr);
});

check('malformed nested records and unexpected keys fail without stack traces', () => {
  for (const mutate of [
    (state) => state.round.review_runs = {},
    (state) => state.round.review_runs = [null],
    (state) => state.round.source_reports = {},
    (state) => state.round.source_reports = [null],
    (state) => state.capture.runs[0].reports = [null],
    (state) => state.round.extra = true,
  ]) {
    const result = validate(mutate);
    assert.strictEqual(result.status, 1);
    assert.doesNotMatch(result.stderr, /TypeError|at Object/);
  }
});

check('legacy completeness, audits, disposition evidence, and verification remain enforced', () => {
  const incomplete = validate((state) => state.round.finding_set_complete = false);
  assert.strictEqual(incomplete.status, 1);
  assert.match(incomplete.stderr, /finding_set_complete/);
  const audits = validate((state) => delete state.round.findings[0].dependency_audit);
  assert.strictEqual(audits.status, 1);
  assert.match(audits.stderr, /dependency_audit/);
  const deferred = validate((state) => {
    const finding = state.round.findings[0];
    delete finding.dependency_audit; delete finding.paired_file_audit; delete finding.changed_files;
    finding.disposition = 'deferred';
  });
  assert.strictEqual(deferred.status, 1);
  assert.match(deferred.stderr, /tracking_id/);
  const out = validate((state) => {
    const finding = state.round.findings[0];
    delete finding.dependency_audit; delete finding.paired_file_audit; delete finding.changed_files;
    finding.disposition = 'out-of-scope';
  });
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /base_evidence/);
  const verification = validate((state) => state.round.verification[0].outcome = 'failed');
  assert.strictEqual(verification.status, 1);
  assert.match(verification.stderr, /passed/);
});

check('duplicate IDs and broken same_as links fail', () => {
  const duplicate = validate((state) => state.round.findings.push({ ...state.round.findings[0] }));
  assert.strictEqual(duplicate.status, 1);
  assert.match(duplicate.stderr, /duplicate/i);
  const broken = validate((state) => state.round.source_reports[0].same_as = ['MISSING']);
  assert.strictEqual(broken.status, 1);
  assert.match(broken.stderr, /same_as/);
  const scalar = validate((state) => state.round.source_reports[0].same_as = 'APP-REPORT-2');
  assert.strictEqual(scalar.status, 1);
  assert.match(scalar.stderr, /same_as.*array/i);
});

check('multiple reports cannot collapse into one finding without equivalence links', () => {
  const result = validate((state) => {
    addCli(state, { outcome: 'findings', count: 1 });
    state.round.source_reports.push({
      id: 'CLI-REPORT-1', run_id: 'DEVIN-CLI-1', ordinal: 1,
      finding_id: 'F1', same_as: [],
    });
    state.round.findings[0].source_report_ids.push('CLI-REPORT-1');
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /connected reciprocal same_as group/i);
});

check('phase is mandatory and pre-commit requires null response fields', () => {
  const omitted = validate(null, { phase: null });
  assert.strictEqual(omitted.status, 2);
  assert.match(omitted.stderr, /--phase/);
  const unknown = validate(null, { phase: 'later' });
  assert.strictEqual(unknown.status, 2);
  for (const mutate of [
    (state) => state.round.response_mode = 'no-change',
    (state) => state.round.response_head_sha = HEAD,
  ]) {
    const result = validate(mutate);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /pre-commit/);
  }
});

function setReviewedSha(state, sha, clean = false) {
  state.round.review_head_sha = sha;
  state.capture = clean
    ? appCapture([review(1, '', sha)], [], sha)
    : appCapture([review(1, reviewBody(), sha)], [comment(11, 1, 'Synthetic finding', sha)], sha);
}

check('pre-push no-change binds reviewed SHA to clean repository HEAD', () => temp((dir) => {
  const repo = initRepo(dir);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const result = validate((state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  }, { phase: 'pre-push', repoRoot: repo, currentPrHead: sha });
  assert.strictEqual(result.status, 0, result.stderr);
}));

check('pre-push canonicalizes valid mixed-case SHA fields', () => temp((dir) => {
  const repo = initRepo(dir);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const result = validate((state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    state.round.review_head_sha = sha.toUpperCase();
    state.round.response_mode = 'no-change';
    state.round.response_head_sha = sha.toUpperCase();
  }, { phase: 'pre-push', repoRoot: repo, currentPrHead: sha });
  assert.strictEqual(result.status, 0, result.stderr);
}));

check('pre-push reports missing git and gh executables', () => temp((dir) => {
  const repo = initRepo(dir);
  const emptyPath = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyPath);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const result = validate((state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  }, {
    phase: 'pre-push', repoRoot: repo,
    env: { ...process.env, PATH: emptyPath },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /spawnSync git ENOENT/);
  assert.match(result.stderr, /spawnSync gh ENOENT/);
}));

check('pre-push binds every CLI capture to the validated checkout', () => temp((dir) => {
  const repo = initRepo(dir);
  const other = path.join(dir, 'other-checkout');
  fs.mkdirSync(other);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const good = validate((state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    addCli(state, { sha, repoRoot: repo });
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  }, { phase: 'pre-push', repoRoot: repo, currentPrHead: sha });
  assert.strictEqual(good.status, 0, good.stderr);
  const wrong = validate((state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    addCli(state, { sha, repoRoot: other });
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  }, { phase: 'pre-push', repoRoot: repo, currentPrHead: sha });
  assert.strictEqual(wrong.status, 1);
  assert.match(wrong.stderr, /CLI capture repository differs/i);
}));

check('pre-push no-change cannot certify a fixed finding', () => temp((dir) => {
  const repo = initRepo(dir);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const result = validate((state) => {
    setReviewedSha(state, sha);
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  }, { phase: 'pre-push', repoRoot: repo, currentPrHead: sha });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /fixed findings require one response commit/i);
}));

check('pre-push commit requires one clean non-merge direct child', () => temp((dir) => {
  const repo = initRepo(dir);
  const reviewed = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(repo, 'file.txt'), 'response\n');
  spawnSync('git', ['add', 'file.txt'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'response'], { cwd: repo });
  const response = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const result = validate((state) => {
    setReviewedSha(state, reviewed);
    state.round.response_mode = 'commit'; state.round.response_head_sha = response;
    state.round.findings[0].changed_files = ['file.txt'];
  }, { phase: 'pre-push', repoRoot: repo, currentPrHead: reviewed });
  assert.strictEqual(result.status, 0, result.stderr);
}));

check('pre-push commit must contain exactly the declared fixed files', () => temp((dir) => {
  const emptyCase = path.join(dir, 'empty-case');
  fs.mkdirSync(emptyCase);
  const emptyRepo = initRepo(emptyCase);
  const emptyReviewed = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: emptyRepo, encoding: 'utf8',
  }).stdout.trim();
  spawnSync('git', ['commit', '--allow-empty', '-m', 'empty response'], { cwd: emptyRepo });
  const emptyResponse = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: emptyRepo, encoding: 'utf8',
  }).stdout.trim();
  const empty = validate((state) => {
    setReviewedSha(state, emptyReviewed);
    state.round.response_mode = 'commit'; state.round.response_head_sha = emptyResponse;
    state.round.findings[0].changed_files = ['file.txt'];
  }, { phase: 'pre-push', repoRoot: emptyRepo, currentPrHead: emptyReviewed });
  assert.strictEqual(empty.status, 1);
  assert.match(empty.stderr, /response commit is empty|absent from response commit/i);

  const unrelatedCase = path.join(dir, 'unrelated-case');
  fs.mkdirSync(unrelatedCase);
  const unrelatedRepo = initRepo(unrelatedCase);
  const unrelatedReviewed = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: unrelatedRepo, encoding: 'utf8',
  }).stdout.trim();
  fs.writeFileSync(path.join(unrelatedRepo, 'other.txt'), 'unrelated\n');
  spawnSync('git', ['add', 'other.txt'], { cwd: unrelatedRepo });
  spawnSync('git', ['commit', '-m', 'unrelated response'], { cwd: unrelatedRepo });
  const unrelatedResponse = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: unrelatedRepo, encoding: 'utf8',
  }).stdout.trim();
  const unrelated = validate((state) => {
    setReviewedSha(state, unrelatedReviewed);
    state.round.response_mode = 'commit'; state.round.response_head_sha = unrelatedResponse;
    state.round.findings[0].changed_files = ['file.txt'];
  }, { phase: 'pre-push', repoRoot: unrelatedRepo, currentPrHead: unrelatedReviewed });
  assert.strictEqual(unrelated.status, 1);
  assert.match(unrelated.stderr, /absent from response commit|undeclared fixed file/i);
}));

check('pre-push commit is invalid when no finding is fixed', () => temp((dir) => {
  const repo = initRepo(dir);
  const reviewed = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(repo, 'file.txt'), 'response\n');
  spawnSync('git', ['add', 'file.txt'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'undeclared response'], { cwd: repo });
  const response = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const result = validate((state) => {
    setReviewedSha(state, reviewed);
    const finding = state.round.findings[0];
    finding.disposition = 'design-intentional';
    delete finding.dependency_audit;
    delete finding.paired_file_audit;
    delete finding.changed_files;
    state.round.response_mode = 'commit'; state.round.response_head_sha = response;
  }, { phase: 'pre-push', repoRoot: repo, currentPrHead: reviewed });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /requires at least one fixed finding/i);
}));

check('pre-push rejects missing mode and dirty trees', () => temp((dir) => {
  const repo = initRepo(dir);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const missing = validate((state) => setReviewedSha(state, sha),
    { phase: 'pre-push', repoRoot: repo });
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /response_mode|response_head_sha/);
  spawnSync('git', ['checkout', '--detach', sha], { cwd: repo });
  const detached = validate((state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  }, { phase: 'pre-push', repoRoot: repo, currentPrHead: sha });
  assert.strictEqual(detached.status, 1);
  assert.match(detached.stderr, /branch differs/i);
  spawnSync('git', ['checkout', 'feature/example'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'dirty\n');
  const dirty = validate((state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  }, { phase: 'pre-push', repoRoot: repo, currentPrHead: sha });
  assert.strictEqual(dirty.status, 1);
  assert.match(dirty.stderr, /clean worktree/i);
}));

check('pre-push rejects a PR head that advanced after capture', () => temp((dir) => {
  const repo = initRepo(dir);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const result = validate((state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  }, { phase: 'pre-push', repoRoot: repo, currentPrHead: OTHER_HEAD });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /current PR head differs/i);
}));

check('pre-push binds the live PR branch and head repository to the push remote', () => temp((dir) => {
  const repo = initRepo(dir);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const prepare = (state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  };
  const wrongBranch = validate(prepare, {
    phase: 'pre-push', repoRoot: repo, currentPrHead: sha,
    currentPrBranch: 'different-branch',
  });
  assert.strictEqual(wrongBranch.status, 1);
  assert.match(wrongBranch.stderr, /PR head branch differs/i);

  const wrongLiveRepository = validate(prepare, {
    phase: 'pre-push', repoRoot: repo, currentPrHead: sha,
    currentPrRepository: 'fork-owner/r',
  });
  assert.strictEqual(wrongLiveRepository.status, 1);
  assert.match(wrongLiveRepository.stderr, /PR head repository differs/i);

  const wrongPushDestination = validate((state) => {
    prepare(state);
    state.round.head_repository = 'fork-owner/r';
  }, {
    phase: 'pre-push', repoRoot: repo, currentPrHead: sha,
    currentPrRepository: 'fork-owner/r',
  });
  assert.strictEqual(wrongPushDestination.status, 1);
  assert.match(wrongPushDestination.stderr, /push remote URL 1 repository differs/i);

  const addDashedRemote = spawnSync('git', ['remote', 'add', '--', '-fork',
    'https://github.com/o/r.git'], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(addDashedRemote.status, 0, addDashedRemote.stderr);
  delete require.cache[require.resolve(VALIDATOR)];
  const { inspectPushUrls } = require(VALIDATOR);
  assert.deepStrictEqual(inspectPushUrls(repo, '-fork', 'o/r').errors, [],
    'a leading-dash remote name must be passed after the Git option terminator');

  let command;
  for (const url of [
    'ssh://git@github.com:22/o/r.git',
    'ssh://git@ssh.github.com:443/o/r.git',
  ]) {
    command = spawnSync('git', ['remote', 'set-url', 'origin', url], { cwd: repo, encoding: 'utf8' });
    assert.strictEqual(command.status, 0, command.stderr);
    const sshWithPort = validate(prepare, {
      phase: 'pre-push', repoRoot: repo, currentPrHead: sha,
    });
    assert.strictEqual(sshWithPort.status, 0, sshWithPort.stderr);
  }

  command = spawnSync('git', ['remote', 'set-url', 'origin',
    'http://github.com/o/r.git'], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  const plaintextHttp = validate(prepare, {
    phase: 'pre-push', repoRoot: repo, currentPrHead: sha,
  });
  assert.strictEqual(plaintextHttp.status, 1);
  assert.match(plaintextHttp.stderr, /must be a GitHub SSH or HTTPS repository URL/i);

  command = spawnSync('git', ['remote', 'set-url', '--add', '--push', 'origin',
    'https://github.com/o/r.git'], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  command = spawnSync('git', ['remote', 'set-url', '--add', '--push', 'origin',
    'https://github.com/unrelated/r.git'], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(command.status, 0, command.stderr);
  const extraPushDestination = validate(prepare, {
    phase: 'pre-push', repoRoot: repo, currentPrHead: sha,
  });
  assert.strictEqual(extraPushDestination.status, 1);
  assert.match(extraPushDestination.stderr, /push remote URL 2 repository differs/i);
}));

check('pre-push rejects a PR head that advances during app refresh', () => temp((dir) => {
  const repo = initRepo(dir);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const result = validate((state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  }, { phase: 'pre-push', repoRoot: repo, currentPrHead: [sha, OTHER_HEAD] });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /changed during final app refresh/i);
}));

check('pre-push rechecks the local checkout after app refresh', () => temp((dir) => {
  const repo = initRepo(dir);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const result = validate((state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  }, {
    phase: 'pre-push', repoRoot: repo, currentPrHead: sha,
    localMutationFile: path.join(repo, 'late-mutation.txt'),
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /repository status changed during final app refresh/i);
}));

check('pre-push rechecks push URLs after app refresh', () => temp((dir) => {
  const repo = initRepo(dir);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const result = validate((state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  }, {
    phase: 'pre-push', repoRoot: repo, currentPrHead: sha,
    remoteMutationRepo: repo,
    remoteMutationUrl: 'https://github.com/unrelated/r.git',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /push remote URLs changed during final app refresh/i);
}));

check('pre-push rejects same-SHA Devin activity added after capture', () => temp((dir) => {
  const repo = initRepo(dir);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const lateReview = review(2, reviewBody(), sha);
  const lateComment = comment(22, 2, 'Late synthetic finding', sha);
  const result = validate((state) => {
    makeClean(state); setReviewedSha(state, sha, true);
    state.round.response_mode = 'no-change'; state.round.response_head_sha = sha;
  }, {
    phase: 'pre-push', repoRoot: repo, currentPrHead: sha,
    liveReviews: [review(1, '', sha), lateReview],
    liveComments: [lateComment],
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /app capture is stale/i);
}));

check('start-cli and finish-cli enforce clean same-SHA captures', () => temp((dir) => {
  const repo = initRepo(dir);
  const capture = path.join(dir, 'cli.json');
  const output = path.join(dir, 'output.txt');
  let result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
    '--purpose', 'proactive', '--output', output, '--out', capture], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  fs.writeFileSync(output,
    'No findings.\nDEVIN_REVIEW_COMPLETE outcome=clean finding_count=0\n\n \n');
  result = spawnSync(process.execPath, [EVIDENCE, 'finish-cli', '--repo-root', repo,
    '--capture', capture, '--output', output, '--exit-code', '0',
    '--outcome', 'clean', '--finding-count', '0'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(capture)).status, 'complete');
  assert.strictEqual(JSON.parse(fs.readFileSync(capture)).exit_code, 0);
  const completedCapture = fs.readFileSync(capture, 'utf8');
  result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
    '--purpose', 'recovery', '--output', path.join(dir, 'retry.txt'),
    '--out', capture], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /refusing to overwrite existing CLI capture/i);
  assert.strictEqual(fs.readFileSync(capture, 'utf8'), completedCapture);
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n');
  result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
    '--purpose', 'proactive', '--output', path.join(dir, 'dirty.txt'),
    '--out', path.join(dir, 'dirty-cli.json')], { encoding: 'utf8' });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /clean worktree/i);
}));

check('finish-cli reads the final response from a Devin ATIF export', () => temp((dir) => {
  const repo = initRepo(dir);
  const capture = path.join(dir, 'atif.json');
  const output = path.join(dir, 'atif-output.json');
  let result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
    '--purpose', 'proactive', '--output', output, '--out', capture], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  writeJson(output, {
    schema_version: 'ATIF-v1.7',
    steps: [
      { source: 'user', message: 'Review this change and use the completion marker.' },
      { source: 'agent', message: '', reasoning_content: 'DEVIN_REVIEW_COMPLETE outcome=clean finding_count=0' },
      { source: 'agent', message: 'Two findings.\nDEVIN_REVIEW_COMPLETE outcome=findings finding_count=2' },
    ],
  });
  result = spawnSync(process.execPath, [EVIDENCE, 'finish-cli', '--repo-root', repo,
    '--capture', capture, '--output', output, '--exit-code', '0',
    '--outcome', 'findings', '--finding-count', '2'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const finished = JSON.parse(fs.readFileSync(capture));
  assert.strictEqual(finished.status, 'complete');
  assert.strictEqual(finished.outcome, 'findings');
  assert.strictEqual(finished.reported_finding_count, 2);
}));

check('finish-cli rejects incomplete or unknown Devin export envelopes', () => temp((dir) => {
  const repo = initRepo(dir);
  for (const [name, exportBody] of [
    ['unfinished', {
      schema_version: 'ATIF-v1.7',
      steps: [
        { source: 'agent', message: 'DEVIN_REVIEW_COMPLETE outcome=clean finding_count=0' },
        { source: 'agent', message: '', tool_calls: [{ function_name: 'grep' }] },
      ],
    }],
    ['refusal-marker', {
      schema_version: 'ATIF-v1.7',
      steps: [{
        source: 'agent',
        message: 'Error: Tool call rejected by permission mode auto: synthetic read\nDEVIN_REVIEW_COMPLETE outcome=clean finding_count=0',
      }],
    }],
    ['unknown-schema', {
      schema_version: 'ATIF-v9.9',
      steps: [{ source: 'agent', message: 'DEVIN_REVIEW_COMPLETE outcome=clean finding_count=0' }],
    }],
  ]) {
    const capture = path.join(dir, `${name}.json`);
    const output = path.join(dir, `${name}-output.json`);
    let result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
      '--purpose', 'proactive', '--output', output, '--out', capture], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    writeJson(output, exportBody);
    result = spawnSync(process.execPath, [EVIDENCE, 'finish-cli', '--repo-root', repo,
      '--capture', capture, '--output', output, '--exit-code', '0'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(capture)).status, 'incomplete');
  }
}));

check('review evidence reports a missing git or gh executable', () => temp((dir) => {
  const repo = initRepo(dir);
  const emptyPath = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyPath);
  const env = { ...process.env, PATH: emptyPath };
  let result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
    '--purpose', 'proactive', '--output', path.join(dir, 'missing-git.txt'),
    '--out', path.join(dir, 'missing-git.json')], { encoding: 'utf8', env });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /spawnSync git ENOENT/);
  result = spawnSync(process.execPath, [EVIDENCE, 'capture-app', '--repo', 'o/r', '--pr', '12',
    '--head', HEAD, '--reviewer-id', String(BOT_ID), '--out', path.join(dir, 'missing-gh.json')],
  { encoding: 'utf8', env });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /spawnSync gh ENOENT/);
}));

check('start-cli binds each capture to one fresh output path', () => temp((dir) => {
  const repo = initRepo(dir);
  for (const [capture, output] of [
    [path.join(dir, 'capture-sidecar.json'),
      path.join(dir, 'capture-sidecar.json.review-evidence-reservation')],
    [path.join(dir, 'output-sidecar.txt.review-evidence-reservation'),
      path.join(dir, 'output-sidecar.txt')],
  ]) {
    const collision = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
      '--purpose', 'proactive', '--output', output, '--out', capture], { encoding: 'utf8' });
    assert.strictEqual(collision.status, 2);
    assert.match(collision.stderr, /reservation paths must all be distinct/i);
    assert.ok(!fs.existsSync(capture));
    assert.ok(!fs.existsSync(output));
  }
  const stale = path.join(dir, 'stale.txt');
  fs.writeFileSync(stale, 'Old clean result from another execution\n');
  let result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
    '--purpose', 'proactive', '--output', stale,
    '--out', path.join(dir, 'stale.json')], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /output path must not already exist/i);

  const capture = path.join(dir, 'fresh.json');
  const reserved = path.join(dir, 'fresh.txt');
  result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
    '--purpose', 'proactive', '--output', reserved, '--out', capture], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const duplicateCapture = path.join(dir, 'duplicate.json');
  result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
    '--purpose', 'proactive', '--output', reserved, '--out', duplicateCapture], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /output path is already reserved/i);
  assert.ok(!fs.existsSync(duplicateCapture));
  const crossRoleOutput = path.join(dir, 'cross-role-output.txt');
  result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
    '--purpose', 'proactive', '--output', crossRoleOutput, '--out', reserved], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /capture path is already reserved/i);
  assert.ok(!fs.existsSync(crossRoleOutput));
  fs.writeFileSync(reserved, 'Fresh result\n');
  const other = path.join(dir, 'other.txt');
  fs.writeFileSync(other, 'Different result\n');
  result = spawnSync(process.execPath, [EVIDENCE, 'finish-cli', '--repo-root', repo,
    '--capture', capture, '--output', other, '--exit-code', '0',
    '--outcome', 'clean', '--finding-count', '0'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /differs from the path reserved by start-cli/i);
}));

check('finish-cli distinguishes recognized preflight refusal from unknown failure', () => temp((dir) => {
  const repo = initRepo(dir);
  for (const [name, outputText, exitCode, expected] of [
    ['trust', 'Error: Refusing to run in an untrusted workspace: /synthetic\n', 1, 'preflight-failed'],
    ['trust-explained', [
      'Error: Refusing to run in an untrusted workspace: /synthetic',
      'Start `devin` interactively in this directory to trust it, or set `respect_workspace_trust: false` in your config to restore the previous behavior.',
      '',
    ].join('\n'), 1, 'preflight-failed'],
    ['permission', 'Error: Tool call rejected by permission mode auto: synthetic read\n', 1, 'preflight-failed'],
    ['mixed', 'Synthetic partial finding\nError: Refusing to run in an untrusted workspace: /synthetic\n', 1, 'incomplete'],
    ['mixed-zero', 'Synthetic partial finding\nError: Refusing to run in an untrusted workspace: /synthetic\n', 0, 'incomplete'],
    ['unknown', 'Error: network vanished\n', 1, 'incomplete'],
    ['unknown-zero', 'Error: network vanished\n', 0, 'incomplete'],
  ]) {
    const capture = path.join(dir, `${name}.json`);
    const output = path.join(dir, `${name}.txt`);
    let result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
      '--purpose', 'recovery', '--output', output, '--out', capture], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    fs.writeFileSync(output, outputText);
    result = spawnSync(process.execPath, [EVIDENCE, 'finish-cli', '--repo-root', repo,
      '--capture', capture, '--output', output, '--exit-code', String(exitCode)], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    const finished = JSON.parse(fs.readFileSync(capture));
    assert.strictEqual(finished.status, expected);
    assert.strictEqual(finished.exit_code, exitCode);
  }
}));

check('finish-cli rejects an excessive finding count without allocating it', () => temp((dir) => {
  const repo = initRepo(dir);
  const capture = path.join(dir, 'count.json');
  const output = path.join(dir, 'count.txt');
  let result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
    '--purpose', 'proactive', '--output', output, '--out', capture], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  fs.writeFileSync(output,
    'Synthetic excessive count\nDEVIN_REVIEW_COMPLETE outcome=findings finding_count=4294967296\n');
  result = spawnSync(process.execPath, [EVIDENCE, 'finish-cli', '--repo-root', repo,
    '--capture', capture, '--output', output, '--exit-code', '0',
    '--outcome', 'findings', '--finding-count', '4294967296'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /must not exceed 10000/i);
}));

check('finish-cli rejects a successful run with empty output evidence', () => temp((dir) => {
  const repo = initRepo(dir);
  const capture = path.join(dir, 'empty.json');
  const output = path.join(dir, 'empty.txt');
  let result = spawnSync(process.execPath, [EVIDENCE, 'start-cli', '--repo-root', repo,
    '--purpose', 'proactive', '--output', output, '--out', capture], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  fs.writeFileSync(output, ' \n\t');
  result = spawnSync(process.execPath, [EVIDENCE, 'finish-cli', '--repo-root', repo,
    '--capture', capture, '--output', output, '--exit-code', '0',
    '--outcome', 'clean', '--finding-count', '0'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /requires non-empty output evidence/i);
}));

console.log(`devin-review-response: ${passed} checks passed`);
