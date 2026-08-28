#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  APP_KEYS,
  CLI_KEYS,
  DEVIN_REVIEWER_ID,
  MAX_REPORT_COUNT,
  classifyCliExecution,
  collectAppEvidence,
  normalizeAppPayload,
  parseCliCompletion,
} = require('./review-evidence');

const SHA = /^[0-9a-f]{40}$/i;
const TOP_KEYS = [
  'repository', 'head_repository', 'push_remote', 'pr', 'round', 'branch', 'review_head_sha',
  'response_head_sha', 'response_mode', 'expected_reviewer_id', 'app_capture',
  'cli_not_run_reason', 'finding_set_complete', 'review_outcome', 'review_runs',
  'source_reports', 'findings', 'verification',
];
const APP_RUN_KEYS = ['id', 'source', 'purpose', 'capture_id', 'report_ids'];
const CLI_RUN_KEYS = [
  'id', 'source', 'purpose', 'capture', 'status', 'outcome',
  'reported_finding_count', 'evidence', 'superseded_by',
];
const APP_REPORT_KEYS = ['id', 'run_id', 'capture_report_id', 'finding_id', 'same_as'];
const CLI_REPORT_KEYS = ['id', 'run_id', 'ordinal', 'finding_id', 'same_as'];
const FINDING_BASE_KEYS = [
  'id', 'source_report_ids', 'location', 'summary', 'disposition', 'evidence',
  'tracking_id', 'base_evidence',
];
const FIXED_KEYS = ['dependency_audit', 'paired_file_audit', 'changed_files'];
const DISPOSITIONS = new Set([
  'fixed', 'design-intentional', 'deferred', 'positive-flag', 'out-of-scope',
]);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function spawnDiagnostic(result) {
  if (result && result.error) return String(result.error.message || result.error);
  return String((result && (result.stderr || result.stdout)) || '').trim();
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function fullSha(value) {
  return typeof value === 'string' && SHA.test(value);
}

function stringList(value, allowEmpty = false) {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.every(text)
    && new Set(value).size === value.length;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseArguments(argv) {
  let phase = null;
  let repoRoot = null;
  let file = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--phase' || value === '--repo-root') {
      if (index + 1 >= argv.length) throw new Error(`${value} needs a value`);
      const next = argv[index + 1];
      if (value === '--phase') {
        if (phase !== null) throw new Error('--phase was supplied more than once');
        phase = next;
      } else {
        if (repoRoot !== null) throw new Error('--repo-root was supplied more than once');
        repoRoot = next;
      }
      index += 1;
    } else if (value.startsWith('--')) {
      throw new Error(`unknown option: ${value}`);
    } else if (file === null) {
      file = value;
    } else {
      throw new Error(`unexpected argument: ${value}`);
    }
  }
  if (!['pre-commit', 'pre-push'].includes(phase)) {
    throw new Error('--phase is required and must be pre-commit or pre-push');
  }
  if (!file) throw new Error('round record path is required');
  if (phase === 'pre-push' && !repoRoot) throw new Error('--repo-root is required for pre-push');
  if (phase === 'pre-commit' && repoRoot) throw new Error('--repo-root is only valid for pre-push');
  return { phase, repoRoot, file };
}

function usage() {
  return 'usage: pre-push-check.js --phase pre-commit ROUND.json\n'
    + '   or: pre-push-check.js --phase pre-push --repo-root REPOSITORY ROUND.json';
}

function readJson(file, label, errors) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    errors.push(`${label} is unreadable or malformed: ${error.message}`);
    return null;
  }
}

function resolveFrom(roundFile, candidate) {
  if (!text(candidate)) return null;
  return path.isAbsolute(candidate) ? candidate : path.resolve(path.dirname(roundFile), candidate);
}

function fileIdentity(roundFile, candidate) {
  const resolved = resolveFrom(roundFile, candidate);
  if (!resolved) return null;
  try {
    const stat = fs.statSync(fs.realpathSync(resolved));
    return `inode:${stat.dev}:${stat.ino}`;
  } catch (_) {
    return `path:${path.resolve(resolved)}`;
  }
}

function checkKeys(value, required, optional, label, errors) {
  if (!object(value)) {
    errors.push(`${label} must be a JSON object`);
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${label}: missing key ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}: unexpected key ${key}`);
  }
  return true;
}

function git(root, args, errors, label) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    errors.push(`${label}: ${spawnDiagnostic(result)}`);
    return null;
  }
  return result.stdout.trim();
}

function gitPaths(root, args, errors, label) {
  const result = spawnSync('git', [...args, '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    errors.push(`${label}: ${spawnDiagnostic(result)}`);
    return null;
  }
  return new Set(result.stdout.split('\0').filter((value) => value.length > 0));
}

function currentPullRequestIdentity(round, errors) {
  const result = spawnSync('gh', [
    'pr', 'view', String(round.pr), '--repo', `github.com/${round.repository}`,
    '--json', 'headRefOid,headRefName,headRepository',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    errors.push(`cannot read current PR identity: ${spawnDiagnostic(result)}`);
    return null;
  }
  let value;
  try { value = JSON.parse(result.stdout); }
  catch (error) {
    errors.push(`current PR identity is not JSON: ${error.message}`);
    return null;
  }
  const head = typeof value.headRefOid === 'string' ? value.headRefOid.toLowerCase() : '';
  const branch = value.headRefName;
  const repository = object(value.headRepository) ? value.headRepository.nameWithOwner : null;
  if (!fullSha(head)) {
    errors.push('current PR head is not a full commit SHA');
    return null;
  }
  if (!text(branch)) {
    errors.push('current PR head branch is missing');
    return null;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) {
    errors.push('current PR head repository is missing or malformed');
    return null;
  }
  return { head, branch, repository };
}

function githubRepositoryFromRemote(remoteUrl) {
  if (!text(remoteUrl)) return null;
  const value = remoteUrl.trim();
  const scp = value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (scp) return `${scp[1]}/${scp[2].replace(/\.git$/i, '')}`;

  let parsed;
  try { parsed = new URL(value); }
  catch (_) { return null; }
  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  if (protocol === 'ssh:') {
    const githubSsh = hostname === 'github.com' && ['', '22'].includes(parsed.port);
    const githubSshOver443 = hostname === 'ssh.github.com' && parsed.port === '443';
    if ((!githubSsh && !githubSshOver443)
      || (parsed.username && parsed.username !== 'git') || parsed.password) return null;
  } else {
    if (protocol !== 'https:' || hostname !== 'github.com'
      || parsed.username || parsed.password) return null;
  }
  if (parsed.search || parsed.hash) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) return null;
  return `${owner}/${repository}`;
}

function inspectPushUrls(root, remote, expectedRepository) {
  const result = spawnSync('git', ['remote', 'get-url', '--push', '--all', '--', remote], {
    cwd: root, encoding: 'utf8',
  });
  if (result.status !== 0) {
    return {
      urls: [],
      errors: [`cannot read push remote URLs: ${spawnDiagnostic(result)}`],
    };
  }
  const urls = result.stdout.trim().split('\n').filter(text);
  const errors = [];
  if (urls.length === 0) errors.push('push remote has no configured push URL');
  for (const [index, pushUrl] of urls.entries()) {
    const pushRepository = githubRepositoryFromRemote(pushUrl);
    if (!pushRepository) {
      errors.push(`push remote URL ${index + 1} must be a GitHub SSH or HTTPS repository URL`);
    } else if (pushRepository.toLowerCase() !== String(expectedRepository).toLowerCase()) {
      errors.push(`push remote URL ${index + 1} repository differs from head_repository`);
    }
  }
  return { urls, errors };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function sameShaDevinActivity(capture, round) {
  const matches = (item) => object(item)
    && object(item.user)
    && item.user.id === round.expected_reviewer_id
    && String(item.commit_id || '').toLowerCase() === String(round.review_head_sha).toLowerCase();
  const byId = (left, right) => String(left.id).localeCompare(String(right.id));
  return canonicalJson({
    reviews: (Array.isArray(capture.raw_reviews) ? capture.raw_reviews : []).filter(matches).sort(byId),
    comments: (Array.isArray(capture.raw_comments) ? capture.raw_comments : []).filter(matches).sort(byId),
  });
}

function validateCurrentAppCapture(round, capture, errors) {
  if (!capture || !Array.isArray(capture.raw_reviews) || !Array.isArray(capture.raw_comments)) return;
  let current;
  try {
    current = collectAppEvidence({
      repository: round.repository,
      pr: round.pr,
      requestedHeadSha: round.review_head_sha,
      expectedReviewerId: round.expected_reviewer_id,
    });
  } catch (error) {
    errors.push(`cannot refresh app capture: ${error.message}`);
    return;
  }
  if (current.status !== 'complete') {
    errors.push('current app activity is incomplete or changed during final validation; recapture the round');
    return;
  }
  if (!sameJson(sameShaDevinActivity(capture, round), sameShaDevinActivity(current, round))) {
    errors.push('app capture is stale; same-SHA Devin reviews or comments changed after capture');
  }
}

function validateAppCapture(round, roundFile, errors) {
  const capturePath = resolveFrom(roundFile, round.app_capture);
  if (!capturePath) {
    errors.push('app_capture is required');
    return { capture: null, runsById: new Map(), reportsByRun: new Map() };
  }
  const capture = readJson(capturePath, 'app capture', errors);
  if (!capture || !checkKeys(capture, APP_KEYS, [], 'app capture', errors)) {
    return { capture, runsById: new Map(), reportsByRun: new Map() };
  }
  if (capture.schema_version !== 1) errors.push('app capture: schema_version must be 1');
  if (capture.kind !== 'github_app_capture') errors.push('app capture: kind must be github_app_capture');
  if (!text(capture.captured_at)) errors.push('app capture: captured_at is required');
  if (!Array.isArray(capture.errors) || !capture.errors.every(text)) errors.push('app capture: errors must be a string array');
  if (!Array.isArray(capture.raw_reviews)) errors.push('app capture: raw_reviews must be an array');
  if (!Array.isArray(capture.raw_comments)) errors.push('app capture: raw_comments must be an array');
  if (!Array.isArray(capture.runs)) errors.push('app capture: runs must be an array');
  if (!object(capture.pagination)
    || !checkKeys(capture.pagination, ['reviews', 'comments'], [], 'app capture pagination', errors)) {
    errors.push('app capture: pagination is malformed');
  } else {
    for (const endpoint of ['reviews', 'comments']) {
      const value = capture.pagination[endpoint];
      if (checkKeys(value, ['pages', 'item_count'], [], `app capture pagination.${endpoint}`, errors)) {
        if (!Number.isInteger(value.pages) || value.pages < 1) errors.push(`app capture pagination.${endpoint}.pages must be positive`);
        const raw = endpoint === 'reviews' ? capture.raw_reviews : capture.raw_comments;
        if (!Number.isInteger(value.item_count) || !Array.isArray(raw) || value.item_count !== raw.length) {
          errors.push(`app capture pagination.${endpoint}.item_count disagrees with raw payload`);
        }
      }
    }
  }

  if (String(capture.repository).toLowerCase() !== String(round.repository).toLowerCase()) {
    errors.push('app capture repository differs from the round');
  }
  if (capture.pr !== round.pr) errors.push('app capture PR differs from the round');
  if (capture.requested_head_sha !== round.review_head_sha) errors.push('app capture requested SHA differs from review_head_sha');
  if (capture.expected_reviewer_id !== round.expected_reviewer_id) errors.push('app capture reviewer identity differs from expected_reviewer_id');

  if (Array.isArray(capture.raw_reviews) && Array.isArray(capture.raw_comments)) {
    try {
      const normalized = normalizeAppPayload({
        repository: capture.repository,
        pr: capture.pr,
        requestedHeadSha: capture.requested_head_sha,
        expectedReviewerId: capture.expected_reviewer_id,
        reviews: capture.raw_reviews,
        comments: capture.raw_comments,
      });
      if (capture.status !== normalized.status) errors.push('app capture status disagrees with its raw payload');
      if (!sameJson(capture.errors, normalized.errors)) errors.push('app capture errors disagree with its raw payload');
      if (!sameJson(capture.runs, normalized.runs)) errors.push('app capture runs disagree with its raw payload');
    } catch (error) {
      errors.push(`app capture cannot be normalized: ${error.message}`);
    }
  }
  if (capture.status !== 'complete') errors.push('app capture must be complete');

  const runsById = new Map();
  const reportsByRun = new Map();
  for (const run of Array.isArray(capture.runs) ? capture.runs : []) {
    if (!object(run) || !text(run.id)) continue;
    if (runsById.has(run.id)) errors.push(`app capture: duplicate run id ${run.id}`);
    runsById.set(run.id, run);
    reportsByRun.set(run.id, new Map(
      (Array.isArray(run.reports) ? run.reports : []).filter(object).map((report) => [report.id, report])
    ));
  }
  return { capture, runsById, reportsByRun };
}

function validateCliCapture(run, round, roundFile, errors) {
  const capturePath = resolveFrom(roundFile, run.capture);
  if (!capturePath) {
    errors.push(`${run.id}: capture is required`);
    return null;
  }
  const capture = readJson(capturePath, `${run.id} capture`, errors);
  if (!capture || !checkKeys(capture, CLI_KEYS, [], `${run.id} capture`, errors)) return capture;
  if (capture.schema_version !== 1 || capture.kind !== 'devin_cli_capture') errors.push(`${run.id}: capture has an unknown schema`);
  if (!text(capture.repository_root)) errors.push(`${run.id}: capture repository_root is required`);
  if (capture.purpose !== run.purpose) errors.push(`${run.id}: purpose differs from its capture`);
  if (capture.review_head_sha !== round.review_head_sha) errors.push(`${run.id}: capture SHA differs from review_head_sha`);
  if (!Array.isArray(capture.start_git_status) || capture.start_git_status.length !== 0) errors.push(`${run.id}: CLI did not start from a clean worktree`);
  if (!Array.isArray(capture.finish_git_status) || capture.finish_git_status.length !== 0) errors.push(`${run.id}: CLI did not finish with a clean worktree`);
  if (capture.finish_head_sha !== capture.review_head_sha) errors.push(`${run.id}: repository HEAD changed during the CLI run`);
  if (!Number.isSafeInteger(capture.exit_code) || capture.exit_code < 0) {
    errors.push(`${run.id}: capture exit_code must be a non-negative integer`);
  }
  if (capture.status !== run.status) errors.push(`${run.id}: status differs from its capture`);
  if (capture.outcome !== run.outcome) errors.push(`${run.id}: outcome differs from its capture`);
  if (capture.reported_finding_count !== run.reported_finding_count) errors.push(`${run.id}: finding count differs from its capture`);
  const startedAt = Date.parse(capture.started_at);
  const finishedAt = Date.parse(capture.finished_at);
  if (!text(capture.started_at) || !text(capture.finished_at)
    || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
    errors.push(`${run.id}: capture timestamps must be valid instants`);
  } else if (finishedAt < startedAt) {
    errors.push(`${run.id}: capture finished before it started`);
  }
  if (!text(capture.raw_output_path) || !text(capture.raw_output_sha256)) {
    errors.push(`${run.id}: raw CLI output evidence is required`);
  } else {
    try {
      const output = fs.readFileSync(capture.raw_output_path);
      const outputStat = fs.statSync(capture.raw_output_path);
      const digest = crypto.createHash('sha256').update(output).digest('hex');
      if (digest !== capture.raw_output_sha256) errors.push(`${run.id}: raw CLI output checksum differs from its capture`);
      if (Number.isFinite(startedAt) && outputStat.mtimeMs < startedAt) {
        errors.push(`${run.id}: raw CLI output predates the capture start`);
      }
      if (Number.isSafeInteger(capture.exit_code) && capture.exit_code >= 0) {
        const derivedStatus = classifyCliExecution(capture.exit_code, output);
        if (capture.status !== derivedStatus) {
          errors.push(`${run.id}: capture status disagrees with its exit code and raw CLI output`);
        }
        const completion = parseCliCompletion(output);
        if (derivedStatus === 'complete' && completion
          && (capture.outcome !== completion.outcome
            || capture.reported_finding_count !== completion.finding_count)) {
          errors.push(`${run.id}: capture outcome or finding count disagrees with its raw CLI completion marker`);
        }
      }
    } catch (error) {
      errors.push(`${run.id}: raw CLI output is unreadable: ${error.message}`);
    }
  }
  return capture;
}

function validateRuns(round, roundFile, app, errors) {
  if (!Array.isArray(round.review_runs)) {
    errors.push('review_runs must be an array');
    return { runs: [], runMap: new Map(), cliCaptures: new Map() };
  }
  const runMap = new Map();
  const cliCaptures = new Map();
  const usedCaptureIds = new Set();
  const usedEvidenceFiles = new Map();
  const claimEvidenceFile = (identity, role, label) => {
    if (!identity) return;
    if (usedEvidenceFiles.has(identity)) {
      const existing = usedEvidenceFiles.get(identity);
      errors.push(`${label}: ${role} is already used by ${existing.label} as ${existing.role}`);
    } else {
      usedEvidenceFiles.set(identity, { role, label });
    }
  };
  claimEvidenceFile(fileIdentity(roundFile, round.app_capture), 'app capture', 'app capture');
  for (const [index, run] of round.review_runs.entries()) {
    const label = object(run) && text(run.id) ? run.id : `review_runs[${index}]`;
    if (!object(run)) {
      errors.push(`${label} must be a JSON object`);
      continue;
    }
    if (!text(run.id)) errors.push(`${label}: id is required`);
    else if (runMap.has(run.id)) errors.push(`${label}: duplicate run id`);
    else runMap.set(run.id, run);
    if (run.source === 'github_app') {
      checkKeys(run, APP_RUN_KEYS, [], label, errors);
      if (run.purpose !== 'posted') errors.push(`${label}: app purpose must be posted`);
      if (!text(run.capture_id)) errors.push(`${label}: capture_id is required`);
      if (!stringList(run.report_ids, true)) errors.push(`${label}: report_ids must be a unique string array`);
      if (usedCaptureIds.has(run.capture_id)) errors.push(`${label}: duplicate app capture_id`);
      usedCaptureIds.add(run.capture_id);
      if (!app.runsById.has(run.capture_id)) errors.push(`${label}: unknown app capture_id ${run.capture_id}`);
    } else if (run.source === 'devin_cli') {
      checkKeys(run, CLI_RUN_KEYS, [], label, errors);
      const captureIdentity = fileIdentity(roundFile, run.capture);
      claimEvidenceFile(captureIdentity, 'CLI capture', label);
      if (!['proactive', 'recovery'].includes(run.purpose)) errors.push(`${label}: invalid CLI purpose`);
      if (!['complete', 'incomplete', 'preflight-failed'].includes(run.status)) errors.push(`${label}: invalid CLI status`);
      if (!Number.isInteger(run.reported_finding_count) || run.reported_finding_count < 0
        || run.reported_finding_count > MAX_REPORT_COUNT) {
        errors.push(`${label}: finding count must be an integer from 0 to ${MAX_REPORT_COUNT}`);
      }
      if (!stringList(run.evidence)) errors.push(`${label}: evidence must be a non-empty unique string array`);
      if (run.status === 'complete') {
        if (!['clean', 'findings'].includes(run.outcome)) errors.push(`${label}: complete CLI outcome must be clean or findings`);
        if (run.superseded_by !== null) errors.push(`${label}: a complete CLI run cannot be superseded`);
      } else {
        if (run.outcome !== null) errors.push(`${label}: non-complete CLI outcome must be null`);
        if (run.reported_finding_count !== 0) errors.push(`${label}: non-complete CLI finding count must be zero`);
        if (run.status === 'incomplete' && run.superseded_by !== null) errors.push(`${label}: an incomplete CLI run cannot be superseded`);
      }
      if (run.status === 'complete' && run.outcome === 'clean' && run.reported_finding_count !== 0) errors.push(`${label}: clean CLI run must report zero findings`);
      if (run.status === 'complete' && run.outcome === 'findings' && run.reported_finding_count < 1) errors.push(`${label}: findings CLI run must report at least one finding`);
      if (run.status === 'incomplete') errors.push(`${label}: incomplete CLI run blocks validation`);
      const capture = validateCliCapture(run, round, roundFile, errors);
      if (capture) {
        cliCaptures.set(run.id, capture);
        const outputIdentity = fileIdentity(roundFile, capture.raw_output_path);
        claimEvidenceFile(outputIdentity, 'raw CLI output', label);
        if (stringList(run.evidence)) {
          const declaredEvidence = run.evidence.map((file) => fileIdentity(roundFile, file)).sort();
          const capturedEvidence = [captureIdentity, outputIdentity].sort();
          if (!sameJson(declaredEvidence, capturedEvidence)) {
            errors.push(`${label}: evidence must name exactly its CLI capture and raw output files`);
          }
        }
      }
    } else {
      errors.push(`${label}: source must be github_app or devin_cli`);
    }
  }
  for (const captureId of app.runsById.keys()) {
    if (!usedCaptureIds.has(captureId)) errors.push(`app capture run ${captureId} is missing from review_runs`);
  }
  return { runs: round.review_runs, runMap, cliCaptures };
}

function validateSupersession(runs, runMap, cliCaptures, errors) {
  for (const [index, run] of runs.entries()) {
    if (!object(run) || run.source !== 'devin_cli' || run.status !== 'preflight-failed') continue;
    if (!text(run.superseded_by)) {
      errors.push(`${run.id}: preflight failure must be superseded by a later complete run`);
      continue;
    }
    const target = runMap.get(run.superseded_by);
    const targetIndex = runs.findIndex((candidate) => object(candidate) && candidate.id === run.superseded_by);
    const sourceCapture = cliCaptures.get(run.id);
    const targetCapture = cliCaptures.get(run.superseded_by);
    if (!target || target.source !== 'devin_cli') errors.push(`${run.id}: superseded_by points to an unknown CLI run`);
    else {
      if (targetIndex <= index) errors.push(`${run.id}: superseded_by must point forward`);
      if (target.status !== 'complete') errors.push(`${run.id}: superseded_by target must be complete`);
      if (target.purpose !== run.purpose) errors.push(`${run.id}: superseded_by target has a different purpose`);
      if (sourceCapture && targetCapture && sourceCapture.review_head_sha !== targetCapture.review_head_sha) {
        errors.push(`${run.id}: superseded_by target has a different SHA`);
      }
      if (sourceCapture && targetCapture) {
        const sourceFinished = Date.parse(sourceCapture.finished_at);
        const targetStarted = Date.parse(targetCapture.started_at);
        if (Number.isFinite(sourceFinished) && Number.isFinite(targetStarted)
          && targetStarted < sourceFinished) {
          errors.push(`${run.id}: superseded_by target started before the preflight failure finished`);
        }
      }
    }
  }
}

function validateReports(round, runState, app, errors) {
  if (!Array.isArray(round.source_reports)) {
    errors.push('source_reports must be an array');
    return { reports: [], reportMap: new Map(), byRun: new Map() };
  }
  const reportMap = new Map();
  const byRun = new Map();
  for (const [index, report] of round.source_reports.entries()) {
    const label = object(report) && text(report.id) ? report.id : `source_reports[${index}]`;
    if (!object(report)) {
      errors.push(`${label} must be a JSON object`);
      continue;
    }
    const run = runState.runMap.get(report.run_id);
    const keys = run && run.source === 'github_app' ? APP_REPORT_KEYS : CLI_REPORT_KEYS;
    checkKeys(report, keys, [], label, errors);
    if (!text(report.id)) errors.push(`${label}: id is required`);
    else if (reportMap.has(report.id)) errors.push(`${label}: duplicate report id`);
    else reportMap.set(report.id, report);
    if (!run) errors.push(`${label}: unknown run_id ${report.run_id}`);
    if (!text(report.finding_id)) errors.push(`${label}: finding_id is required`);
    if (!stringList(report.same_as, true)) errors.push(`${label}: same_as must be a unique report-id array`);
    if (!byRun.has(report.run_id)) byRun.set(report.run_id, []);
    byRun.get(report.run_id).push(report);
    if (run && run.source === 'github_app') {
      if (!text(report.capture_report_id)) errors.push(`${label}: capture_report_id is required`);
      const known = app.reportsByRun.get(run.capture_id);
      if (!known || !known.has(report.capture_report_id)) errors.push(`${label}: unknown capture_report_id ${report.capture_report_id}`);
    } else if (run && run.source === 'devin_cli') {
      if (!Number.isInteger(report.ordinal) || report.ordinal < 1) errors.push(`${label}: ordinal must be a positive integer`);
    }
  }

  for (const run of runState.runs) {
    if (!object(run) || !text(run.id)) continue;
    const reports = byRun.get(run.id) || [];
    if (run.source === 'github_app') {
      const captured = app.runsById.get(run.capture_id);
      const expected = captured ? captured.expected_report_count : 0;
      if (reports.length !== expected) errors.push(`${run.id} expected ${expected} reports from capture but the ledger contains ${reports.length}`);
      const ids = reports.map((report) => report.id).sort();
      const declared = Array.isArray(run.report_ids) ? [...run.report_ids].sort() : [];
      if (!sameJson(ids, declared)) errors.push(`${run.id}: report_ids disagree with the report ledger`);
      const captureIds = reports.map((report) => report.capture_report_id).sort();
      const expectedIds = captured && Array.isArray(captured.reports)
        ? captured.reports.filter(object).map((report) => report.id).sort() : [];
      if (!sameJson(captureIds, expectedIds)) errors.push(`${run.id}: capture report IDs disagree with the report ledger`);
      const findingsInReview = new Map();
      for (const report of reports) {
        if (!text(report.finding_id)) continue;
        const first = findingsInReview.get(report.finding_id);
        if (first) {
          errors.push(`${run.id}: app reports ${first} and ${report.id} from the same review cannot share finding ${report.finding_id}`);
        } else {
          findingsInReview.set(report.finding_id, report.id);
        }
      }
    } else if (run.source === 'devin_cli') {
      if (reports.length !== run.reported_finding_count) errors.push(`${run.id} reports ${run.reported_finding_count} findings but the ledger contains ${reports.length}`);
      const ordinals = reports.map((report) => report.ordinal).sort((a, b) => a - b);
      if (!ordinals.every((ordinal, index) => ordinal === index + 1)) {
        errors.push(`${run.id}: report ordinals must be contiguous from 1`);
      }
    }
  }

  for (const report of reportMap.values()) {
    for (const peerId of Array.isArray(report.same_as) ? report.same_as : []) {
      if (peerId === report.id) {
        errors.push(`${report.id}: same_as cannot point to itself`);
        continue;
      }
      const peer = reportMap.get(peerId);
      if (!peer) errors.push(`${report.id}: same_as points to unknown report ${peerId}`);
      else {
        if (!Array.isArray(peer.same_as) || !peer.same_as.includes(report.id)) {
          errors.push(`${report.id}: same_as link to ${peerId} is not reciprocal`);
        }
        if (peer.finding_id !== report.finding_id) errors.push(`${report.id}: same_as reports use different findings`);
      }
    }
  }
  const hiddenRecoveryUse = new Map();
  for (const report of reportMap.values()) {
    const run = runState.runMap.get(report.run_id);
    if (!run || run.source !== 'github_app') continue;
    const captured = app.reportsByRun.get(run.capture_id);
    const descriptor = captured && captured.get(report.capture_report_id);
    if (descriptor && descriptor.kind === 'hidden' && (!Array.isArray(report.same_as) || report.same_as.length === 0)) {
      errors.push(`${report.id}: hidden app report needs a recovery same_as link`);
    }
    if (descriptor && descriptor.kind === 'hidden' && Array.isArray(report.same_as)) {
      for (const peerId of report.same_as) {
        const peer = reportMap.get(peerId);
        const peerRun = peer && runState.runMap.get(peer.run_id);
        if (!peerRun || peerRun.source !== 'devin_cli' || peerRun.purpose !== 'recovery') {
          errors.push(`${report.id}: hidden app report must link only to recovery CLI reports`);
        } else {
          if (!hiddenRecoveryUse.has(run.id)) hiddenRecoveryUse.set(run.id, new Map());
          const usedBy = hiddenRecoveryUse.get(run.id).get(peerId);
          if (usedBy && usedBy !== report.id) {
            errors.push(`${report.id}: recovery report ${peerId} already recovers hidden report ${usedBy} in the same app review`);
          } else {
            hiddenRecoveryUse.get(run.id).set(peerId, report.id);
          }
        }
      }
    }
  }
  return { reports: round.source_reports, reportMap, byRun };
}

function validateFindings(round, reportState, errors) {
  if (!Array.isArray(round.findings)) {
    errors.push('findings must be an array');
    return new Map();
  }
  const findingMap = new Map();
  for (const [index, finding] of round.findings.entries()) {
    const label = object(finding) && text(finding.id) ? finding.id : `findings[${index}]`;
    if (!object(finding)) {
      errors.push(`${label} must be a JSON object`);
      continue;
    }
    const optional = ['severity'];
    const required = [...FINDING_BASE_KEYS];
    if (finding.disposition === 'fixed') required.push(...FIXED_KEYS);
    checkKeys(finding, required, optional, label, errors);
    if (!text(finding.id)) errors.push(`${label}: id is required`);
    else if (findingMap.has(finding.id)) errors.push(`${label}: duplicate finding id`);
    else findingMap.set(finding.id, finding);
    if (!stringList(finding.source_report_ids)) errors.push(`${label}: source_report_ids must be a non-empty unique string array`);
    if (Object.prototype.hasOwnProperty.call(finding, 'severity') && !text(finding.severity)) errors.push(`${label}: severity must be nonblank`);
    if (!text(finding.location)) errors.push(`${label}: location is required`);
    if (!text(finding.summary)) errors.push(`${label}: summary is required`);
    if (!DISPOSITIONS.has(finding.disposition)) errors.push(`${label}: invalid disposition`);
    if (!text(finding.evidence)) errors.push(`${label}: evidence is required`);
    if (finding.disposition === 'fixed') {
      for (const key of FIXED_KEYS) if (!stringList(finding[key])) errors.push(`${label}: fixed finding needs ${key}`);
    }
    if (finding.disposition === 'deferred') {
      if (!text(finding.tracking_id)) errors.push(`${label}: deferred finding needs tracking_id`);
      if (finding.base_evidence !== null) errors.push(`${label}: deferred finding base_evidence must be null`);
    } else if (finding.disposition === 'out-of-scope') {
      if (!text(finding.base_evidence)) errors.push(`${label}: out-of-scope finding needs base_evidence`);
      if (finding.tracking_id !== null) errors.push(`${label}: out-of-scope finding tracking_id must be null`);
    } else {
      if (finding.tracking_id !== null) errors.push(`${label}: tracking_id must be null for ${finding.disposition}`);
      if (finding.base_evidence !== null) errors.push(`${label}: base_evidence must be null for ${finding.disposition}`);
    }
  }

  for (const report of reportState.reportMap.values()) {
    if (!findingMap.has(report.finding_id)) errors.push(`${report.id}: finding_id ${report.finding_id} is absent`);
  }
  for (const finding of findingMap.values()) {
    const actual = [...reportState.reportMap.values()]
      .filter((report) => report.finding_id === finding.id)
      .map((report) => report.id)
      .sort();
    const declared = Array.isArray(finding.source_report_ids) ? [...finding.source_report_ids].sort() : [];
    if (!sameJson(actual, declared)) errors.push(`${finding.id}: source_report_ids disagree with the report ledger`);
    if (actual.length > 1) {
      const members = new Set(actual);
      const reached = new Set([actual[0]]);
      const pending = [actual[0]];
      while (pending.length > 0) {
        const report = reportState.reportMap.get(pending.pop());
        for (const peerId of report && Array.isArray(report.same_as) ? report.same_as : []) {
          if (members.has(peerId) && !reached.has(peerId)) {
            reached.add(peerId);
            pending.push(peerId);
          }
        }
      }
      if (reached.size !== members.size) {
        errors.push(`${finding.id}: source reports must form one connected reciprocal same_as group`);
      }
    }
  }
  return findingMap;
}

function validateVerification(round, errors) {
  if (!Array.isArray(round.verification) || round.verification.length === 0) {
    errors.push('verification needs at least one command result');
    return;
  }
  for (const [index, item] of round.verification.entries()) {
    const label = `verification[${index}]`;
    if (!checkKeys(item, ['command', 'outcome'], [], label, errors)) continue;
    if (!text(item.command)) errors.push(`${label}: command is required`);
    if (item.outcome !== 'passed') errors.push(`${label}: outcome must be passed`);
  }
}

function validatePhase(round, args, app, runState, errors) {
  if (args.phase === 'pre-commit') {
    if (round.response_mode !== null || round.response_head_sha !== null) {
      errors.push('pre-commit requires null response_mode and response_head_sha');
    }
    return;
  }
  if (!['no-change', 'commit'].includes(round.response_mode)) errors.push('pre-push response_mode must be no-change or commit');
  if (!fullSha(round.response_head_sha)) errors.push('pre-push response_head_sha must be a full commit SHA');
  let root;
  try { root = fs.realpathSync(args.repoRoot); }
  catch (error) { errors.push(`repository root is unavailable: ${error.message}`); return; }
  const head = git(root, ['rev-parse', 'HEAD'], errors, 'cannot read repository HEAD');
  const status = git(root, ['status', '--porcelain', '--untracked-files=all'], errors, 'cannot read repository status');
  const branch = git(root, ['branch', '--show-current'], errors, 'cannot read repository branch');
  const pushInspection = text(round.push_remote)
    ? inspectPushUrls(root, round.push_remote, round.head_repository)
    : { urls: [], errors: [] };
  errors.push(...pushInspection.errors);
  const pushUrls = pushInspection.urls;
  const fixed = Array.isArray(round.findings)
    ? round.findings.filter((finding) => object(finding) && finding.disposition === 'fixed')
    : [];
  if (head && round.response_head_sha !== head) errors.push('response_head_sha differs from repository HEAD');
  if (status !== null && status !== '') errors.push('pre-push requires a clean worktree and index');
  if (branch !== null && branch !== round.branch) errors.push('round branch differs from the checked-out branch');
  for (const [runId, capture] of runState.cliCaptures) {
    try {
      if (fs.realpathSync(capture.repository_root) !== root) {
        errors.push(`${runId}: CLI capture repository differs from --repo-root`);
      }
    } catch (error) {
      errors.push(`${runId}: CLI capture repository is unavailable: ${error.message}`);
    }
  }
  if (['no-change', 'commit'].includes(round.response_mode)) {
    const before = currentPullRequestIdentity(round, errors);
    if (before && before.head !== String(round.review_head_sha).toLowerCase()) {
      errors.push('current PR head differs from review_head_sha; start a new review round');
    }
    if (before && before.branch !== round.branch) {
      errors.push('current PR head branch differs from round branch');
    }
    if (before && before.repository.toLowerCase() !== String(round.head_repository).toLowerCase()) {
      errors.push('current PR head repository differs from head_repository');
    }
    validateCurrentAppCapture(round, app.capture, errors);
    const after = currentPullRequestIdentity(round, errors);
    if (after && after.head !== String(round.review_head_sha).toLowerCase()) {
      errors.push('PR head changed during final app refresh; start a new review round');
    }
    if (before && after && !sameJson(before, after)) {
      errors.push('PR head identity changed during final app refresh; start a new review round');
    }
    const finalHead = git(root, ['rev-parse', 'HEAD'], errors, 'cannot reread repository HEAD after final app refresh');
    const finalStatus = git(root, ['status', '--porcelain', '--untracked-files=all'], errors,
      'cannot reread repository status after final app refresh');
    const finalBranch = git(root, ['branch', '--show-current'], errors,
      'cannot reread repository branch after final app refresh');
    if (head !== null && finalHead !== null && head !== finalHead) {
      errors.push('repository HEAD changed during final app refresh');
    }
    if (status !== null && finalStatus !== null && status !== finalStatus) {
      errors.push('repository status changed during final app refresh');
    }
    if (branch !== null && finalBranch !== null && branch !== finalBranch) {
      errors.push('repository branch changed during final app refresh');
    }
    if (text(round.push_remote)) {
      const finalPushInspection = inspectPushUrls(root, round.push_remote, round.head_repository);
      errors.push(...finalPushInspection.errors);
      if (!sameJson(pushUrls, finalPushInspection.urls)) {
        errors.push('push remote URLs changed during final app refresh');
      }
    }
  }
  if (round.response_mode === 'no-change') {
    if (round.response_head_sha !== round.review_head_sha) errors.push('no-change requires response_head_sha to equal review_head_sha');
    if (fixed.length > 0) {
      errors.push('no-change cannot answer a fixed finding; fixed findings require one response commit');
    }
  }
  if (round.response_mode === 'commit' && fullSha(round.response_head_sha)) {
    if (fixed.length === 0) errors.push('commit response requires at least one fixed finding; use no-change');
    const parents = git(root, ['rev-list', '--parents', '-n', '1', round.response_head_sha], errors, 'cannot read response commit parents');
    if (parents) {
      const fields = parents.split(/\s+/);
      if (fields.length !== 2 || fields[1] !== round.review_head_sha) {
        errors.push('commit response must be one non-merge direct child of review_head_sha');
      }
    }
    if (fixed.length > 0 && fullSha(round.review_head_sha)) {
      const changed = gitPaths(root, [
        'diff', '--name-only', '--no-renames', round.review_head_sha, round.response_head_sha,
      ], errors, 'cannot read response commit files');
      if (changed) {
        const declared = new Set(fixed.flatMap((finding) => (
          Array.isArray(finding.changed_files) ? finding.changed_files.filter(text) : []
        )));
        if (changed.size === 0) errors.push('response commit is empty but the round contains fixed findings');
        for (const file of declared) {
          if (!changed.has(file)) errors.push(`declared fixed file is absent from response commit: ${file}`);
        }
        for (const file of changed) {
          if (!declared.has(file)) errors.push(`response commit contains undeclared fixed file: ${file}`);
        }
      }
    }
  }
}

function validateRound(round, roundFile, args) {
  const errors = [];
  if (!object(round)) return ['round record must be a JSON object'];
  checkKeys(round, TOP_KEYS, [], 'round', errors);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(round.repository || '')) errors.push('repository must be owner/repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(round.head_repository || '')) errors.push('head_repository must be owner/repository');
  if (!text(round.push_remote)) errors.push('push_remote is required');
  if (!Number.isInteger(round.pr) || round.pr < 1) errors.push('pr must be a positive integer');
  if (!Number.isInteger(round.round) || round.round < 1) errors.push('round must be a positive integer');
  if (!text(round.branch)) errors.push('branch is required');
  if (!fullSha(round.review_head_sha)) errors.push('review_head_sha must be a full commit SHA');
  else round.review_head_sha = round.review_head_sha.toLowerCase();
  if (fullSha(round.response_head_sha)) round.response_head_sha = round.response_head_sha.toLowerCase();
  if (round.expected_reviewer_id !== DEVIN_REVIEWER_ID) errors.push(`expected_reviewer_id must be ${DEVIN_REVIEWER_ID}`);
  if (round.finding_set_complete !== true) errors.push('finding_set_complete must be true');

  const app = validateAppCapture(round, roundFile, errors);
  const runs = validateRuns(round, roundFile, app, errors);
  validateSupersession(runs.runs, runs.runMap, runs.cliCaptures, errors);
  const cliRuns = runs.runs.filter((run) => object(run) && run.source === 'devin_cli');
  if (cliRuns.length === 0 && round.cli_not_run_reason !== 'not-needed') {
    errors.push('cli_not_run_reason must be not-needed when no CLI run exists');
  }
  if (cliRuns.length > 0 && round.cli_not_run_reason !== null) {
    errors.push('cli_not_run_reason must be null when a CLI run exists');
  }

  const reports = validateReports(round, runs, app, errors);
  const findings = validateFindings(round, reports, errors);
  if (findings.size === 0 && round.review_outcome !== 'clean') errors.push('an empty findings array requires review_outcome "clean"');
  if (findings.size > 0 && round.review_outcome !== 'findings') errors.push('a non-empty findings array requires review_outcome "findings"');
  if (round.review_outcome === 'clean') {
    for (const captured of app.runsById.values()) {
      if (captured.status !== 'complete' || captured.outcome !== 'clean') errors.push(`${captured.id}: app result prevents a clean round`);
    }
    for (const run of cliRuns) {
      if (run.status === 'complete' && run.outcome !== 'clean') errors.push(`${run.id}: CLI result prevents a clean round`);
    }
  }
  validateVerification(round, errors);
  validatePhase(round, args, app, runs, errors);
  return errors;
}

function main() {
  let args;
  try { args = parseArguments(process.argv.slice(2)); }
  catch (error) {
    console.error(`${error.message}\n${usage()}`);
    process.exit(2);
  }

  let round;
  try { round = JSON.parse(fs.readFileSync(args.file, 'utf8')); }
  catch (error) {
    console.error(`invalid round record: ${error.message}`);
    process.exit(2);
  }
  const errors = validateRound(round, path.resolve(args.file), args);
  if (errors.length > 0) {
    console.error(`round is not ${args.phase} ready (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`round is ${args.phase} ready: ${round.findings.length} finding${round.findings.length === 1 ? '' : 's'}, all sources reconciled`);
}

if (require.main === module) main();

module.exports = { inspectPushUrls, parseArguments, validateRound };
