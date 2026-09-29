#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sanitizedGitEnvironment } = require('./git-environment');

const DEVIN_REVIEWER_ID = 158243242;
const MAX_REPORT_COUNT = 10000;
const SHA = /^[0-9a-f]{40}$/i;
const RESOLVED_PREFIX = '✅ **Resolved**:';
const NO_ISSUES_SUMMARY = '## ✅ Devin Review: No Issues Found\n\nDevin Review analyzed this PR and found no bugs or issues to report.';
const SUBMITTED_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']);
const CLI_RESERVATION_KEYS = [
  'schema_version', 'kind', 'role', 'capture_path', 'output_path', 'started_at',
];
const APP_KEYS = [
  'schema_version', 'kind', 'repository', 'pr', 'requested_head_sha',
  'expected_reviewer_id', 'captured_at', 'status', 'errors', 'pagination',
  'raw_reviews', 'raw_comments', 'runs',
];
const CLI_KEYS = [
  'schema_version', 'kind', 'repository_root', 'purpose', 'review_head_sha',
  'started_at', 'start_git_status', 'exit_code', 'status', 'outcome',
  'reported_finding_count', 'raw_output_path', 'raw_output_sha256',
  'finished_at', 'finish_head_sha', 'finish_git_status', 'interrupted_at',
  'interruption_reason', 'termination_signal', 'partial_reconciliation',
];
const LEGACY_CLI_KEYS = CLI_KEYS.slice(0, 16);
const PRE_RECONCILIATION_CLI_KEYS = [
  ...LEGACY_CLI_KEYS, 'interrupted_at', 'interruption_reason', 'termination_signal',
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonBlankText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function spawnDiagnostic(result) {
  if (result && result.error) return String(result.error.message || result.error);
  return String((result && (result.stderr || result.stdout)) || '').trim();
}

function sameKeys(value, keys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseArgs(argv) {
  const command = argv[0];
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    if (Object.prototype.hasOwnProperty.call(flags, flag)) {
      throw new Error(`duplicate argument: ${flag}`);
    }
    flags[flag] = argv[index + 1];
    index += 1;
  }
  return { command, flags };
}

function required(flags, flag) {
  const value = flags[flag];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${flag} is required`);
  return value;
}

function positiveInteger(value, label) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value, label) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function canonicalRepository(value) {
  const trimmed = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error('--repo must be owner/repository');
  }
  return trimmed.toLowerCase();
}

function fullSha(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SHA.test(normalized)) throw new Error(`${label} must be a full commit SHA`);
  return normalized;
}

function atomicWriteJson(file, value) {
  const destination = path.resolve(file);
  const parent = path.dirname(destination);
  if (!fs.existsSync(parent)) throw new Error(`output directory does not exist: ${parent}`);
  const temporary = path.join(parent, `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
}

function writeNewJson(file, value) {
  const destination = path.resolve(file);
  const parent = path.dirname(destination);
  if (!fs.existsSync(parent)) throw new Error(`output directory does not exist: ${parent}`);
  try {
    fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`refusing to overwrite existing CLI capture: ${destination}`);
    }
    throw error;
  }
}

function destinationPath(file) {
  const destination = path.resolve(file);
  const parent = fs.realpathSync(path.dirname(destination));
  return path.join(parent, path.basename(destination));
}

function pathEntryExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function cliReservationPath(outputPath) {
  return `${outputPath}.review-evidence-reservation`;
}

function reserveCliPath(targetPath, role, capturePath, outputPath, startedAt) {
  const reservationPath = cliReservationPath(targetPath);
  const reservation = {
    schema_version: 1,
    kind: 'devin_cli_path_reservation',
    role,
    capture_path: capturePath,
    output_path: outputPath,
    started_at: startedAt,
  };
  try {
    fs.writeFileSync(reservationPath, `${JSON.stringify(reservation, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`CLI ${role} path is already reserved: ${targetPath}`);
    }
    throw error;
  }
  return reservationPath;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is unreadable or malformed: ${error.message}`);
  }
}

function parseReviewBody(rawBody, linkedComments) {
  const body = typeof rawBody === 'string' ? rawBody.replace(/\r\n/g, '\n') : '';
  const comments = Array.isArray(linkedComments) ? linkedComments : [];
  const resolutions = comments.filter((item) => typeof item.body === 'string' && item.body.startsWith(RESOLVED_PREFIX));
  const visible = comments.filter((item) => !resolutions.includes(item));

  if (body === '') {
    if (visible.length === 0) {
      return {
        status: 'complete', outcome: 'clean', visible_count: 0, hidden_count: 0,
        expected_report_count: 0, error: null,
      };
    }
    return {
      status: 'incomplete', outcome: null, visible_count: visible.length,
      hidden_count: 0, expected_report_count: visible.length,
      error: 'empty review body contains a non-resolution comment',
    };
  }

  const badge = body.match(/^([\s\S]*?)\n\n<!-- devin-review-badge-begin -->\n([\s\S]+)\n<!-- devin-review-badge-end -->(?:\n\n<!-- devin-review-summary -->)?$/);
  if (!badge) {
    return {
      status: 'incomplete', outcome: null, visible_count: visible.length,
      hidden_count: 0, expected_report_count: visible.length,
      error: 'review body does not match the supported badge envelope',
    };
  }

  if (badge[1] === NO_ISSUES_SUMMARY) {
    if (visible.length > 0) {
      return {
        status: 'incomplete', outcome: null, visible_count: visible.length,
        hidden_count: 0, expected_report_count: visible.length,
        error: 'no-issues review body contains a non-resolution comment',
      };
    }
    return {
      status: 'complete', outcome: 'clean', visible_count: 0, hidden_count: 0,
      expected_report_count: 0, error: null,
    };
  }

  const semantic = badge[1].split('\n\n');
  if (semantic.length < 1 || semantic.length > 2) {
    return {
      status: 'incomplete', outcome: null, visible_count: visible.length,
      hidden_count: 0, expected_report_count: visible.length,
      error: 'review body contains unsupported semantic lines',
    };
  }

  const summary = semantic[0].match(/^\*\*Devin Review\*\* found ([1-9]\d*) (?:new )?potential (issue|issues)\.$/);
  if (!summary) {
    return {
      status: 'incomplete', outcome: null, visible_count: visible.length,
      hidden_count: 0, expected_report_count: visible.length,
      error: 'review summary does not match the supported grammar',
    };
  }
  const summaryCount = Number(summary[1]);
  if (!Number.isSafeInteger(summaryCount) || summaryCount > MAX_REPORT_COUNT) {
    return {
      status: 'incomplete', outcome: null, visible_count: visible.length,
      hidden_count: 0, expected_report_count: visible.length,
      error: `review summary count exceeds the supported maximum of ${MAX_REPORT_COUNT}`,
    };
  }
  const expectedIssueWord = summaryCount === 1 ? 'issue' : 'issues';
  if (summary[2] !== expectedIssueWord) {
    return {
      status: 'incomplete', outcome: null, visible_count: visible.length,
      hidden_count: 0, expected_report_count: visible.length,
      error: 'review summary count and plural disagree',
    };
  }

  let hiddenCount = 0;
  if (semantic.length === 2) {
    const additional = semantic[1].match(/^View ([1-9]\d*) additional (finding|findings) in Devin Review\.$/)
      || semantic[1].match(/^View in Devin Review to see ([1-9]\d*) additional (finding|findings)\.?$/);
    if (!additional) {
      return {
        status: 'incomplete', outcome: null, visible_count: visible.length,
        hidden_count: 0, expected_report_count: visible.length,
        error: 'additional-finding line does not match the supported grammar',
      };
    }
    hiddenCount = Number(additional[1]);
    if (!Number.isSafeInteger(hiddenCount) || hiddenCount > MAX_REPORT_COUNT) {
      return {
        status: 'incomplete', outcome: null, visible_count: visible.length,
        hidden_count: 0, expected_report_count: summaryCount,
        error: `additional-finding count exceeds the supported maximum of ${MAX_REPORT_COUNT}`,
      };
    }
    const expectedFindingWord = hiddenCount === 1 ? 'finding' : 'findings';
    if (additional[2] !== expectedFindingWord) {
      return {
        status: 'incomplete', outcome: null, visible_count: visible.length,
        hidden_count: hiddenCount, expected_report_count: visible.length + hiddenCount,
        error: 'additional-finding count and plural disagree',
      };
    }
  }

  if (visible.length !== summaryCount) {
    return {
      status: 'incomplete', outcome: null, visible_count: visible.length,
      hidden_count: hiddenCount, expected_report_count: summaryCount + hiddenCount,
      error: `review summary says ${summaryCount} visible findings but ${visible.length} comments were returned`,
    };
  }

  return {
    status: 'complete', outcome: 'findings', visible_count: visible.length,
    hidden_count: hiddenCount, expected_report_count: summaryCount + hiddenCount,
    error: null,
  };
}

function normalizeAppPayload(options) {
  const repository = canonicalRepository(options.repository);
  const pr = positiveInteger(options.pr, 'pr');
  const requestedHeadSha = fullSha(options.requestedHeadSha, 'requested head SHA');
  const expectedReviewerId = positiveInteger(options.expectedReviewerId, 'expected reviewer ID');
  if (expectedReviewerId !== DEVIN_REVIEWER_ID) {
    throw new Error(`expected reviewer ID must be ${DEVIN_REVIEWER_ID}`);
  }
  const reviews = Array.isArray(options.reviews) ? options.reviews : [];
  const comments = Array.isArray(options.comments) ? options.comments : [];
  const candidates = reviews.filter((item) => isObject(item)
    && isObject(item.user)
    && item.user.id === expectedReviewerId
    && String(item.commit_id || '').toLowerCase() === requestedHeadSha);
  const errors = [];
  const runs = [];
  const candidateIds = new Set(candidates.map((item) => item.id));
  for (const item of comments) {
    if (!isObject(item) || !isObject(item.user) || item.user.id !== expectedReviewerId) continue;
    if (String(item.commit_id || '').toLowerCase() !== requestedHeadSha) continue;
    if (!candidateIds.has(item.pull_request_review_id)) {
      errors.push(`same-SHA Devin comment ${item.id} has no captured review`);
    }
  }

  for (const item of candidates) {
    const linked = comments.filter((entry) => isObject(entry)
      && entry.pull_request_review_id === item.id
      && isObject(entry.user)
      && entry.user.id === expectedReviewerId
      && String(entry.commit_id || '').toLowerCase() === requestedHeadSha);
    const reviewState = typeof item.state === 'string' ? item.state.toUpperCase() : '';
    const parsed = SUBMITTED_REVIEW_STATES.has(reviewState)
      ? parseReviewBody(item.body, linked)
      : {
        status: 'incomplete', outcome: null, visible_count: 0, hidden_count: 0,
        expected_report_count: 0,
        error: `review state ${reviewState || '(missing)'} is not submitted`,
      };
    const resolutionCommentIds = linked
      .filter((entry) => typeof entry.body === 'string' && entry.body.startsWith(RESOLVED_PREFIX))
      .map((entry) => entry.id);
    const visible = linked.filter((entry) => !resolutionCommentIds.includes(entry.id));
    const reports = visible.map((entry) => ({
      id: `comment-${entry.id}`,
      kind: 'visible',
      comment_id: entry.id,
      url: entry.html_url || null,
      path: entry.path || null,
      line: Number.isInteger(entry.line) ? entry.line : null,
    }));
    for (let ordinal = 1; ordinal <= parsed.hidden_count; ordinal += 1) {
      reports.push({
        id: `hidden-${item.id}-${ordinal}`,
        kind: 'hidden',
        ordinal,
      });
    }
    const id = `github-review-${item.id}`;
    if (parsed.error) errors.push(`${id}: ${parsed.error}`);
    runs.push({
      id,
      review_id: item.id,
      commit_id: requestedHeadSha,
      reviewer_id: expectedReviewerId,
      review_state: reviewState,
      url: item.html_url || null,
      body: typeof item.body === 'string' ? item.body : '',
      status: parsed.status,
      outcome: parsed.outcome,
      expected_report_count: parsed.expected_report_count,
      reports,
      resolution_comment_ids: resolutionCommentIds,
    });
  }

  if (runs.length === 0) errors.push('no Devin app review exists for the requested head SHA');
  return {
    repository,
    pr,
    requested_head_sha: requestedHeadSha,
    expected_reviewer_id: expectedReviewerId,
    status: errors.length === 0 && runs.every((run) => run.status === 'complete') ? 'complete' : 'incomplete',
    errors,
    runs,
  };
}

function githubPages(options, endpoint) {
  const apiPath = `repos/${options.repository}/pulls/${options.pr}/${endpoint}?per_page=100`;
  const result = spawnSync('gh', [
    'api', '--hostname', 'github.com', '--method', 'GET', '--paginate', '--slurp', apiPath,
  ], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`GitHub ${endpoint} capture failed: ${spawnDiagnostic(result)}`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch (error) { throw new Error(`GitHub ${endpoint} response is not JSON: ${error.message}`); }
  if (!Array.isArray(parsed)) throw new Error(`GitHub ${endpoint} response is not an array`);
  return parsed.length > 0 && Array.isArray(parsed[0]) ? parsed : [parsed];
}

function collectAppEvidence(options, getPages = (endpoint) => githubPages(options, endpoint)) {
  const initialReviewPages = getPages('reviews');
  const initialCommentPages = getPages('comments');
  const reviewPages = getPages('reviews');
  const commentPages = getPages('comments');
  if (!Array.isArray(initialReviewPages) || initialReviewPages.some((page) => !Array.isArray(page))
    || !Array.isArray(reviewPages) || reviewPages.some((page) => !Array.isArray(page))) {
    throw new Error('reviews transport must return an array of pages');
  }
  if (!Array.isArray(initialCommentPages) || initialCommentPages.some((page) => !Array.isArray(page))
    || !Array.isArray(commentPages) || commentPages.some((page) => !Array.isArray(page))) {
    throw new Error('comments transport must return an array of pages');
  }
  const reviews = reviewPages.flat();
  const comments = commentPages.flat();
  const normalized = normalizeAppPayload({ ...options, reviews, comments });
  if (JSON.stringify(initialReviewPages) !== JSON.stringify(reviewPages)) {
    normalized.errors.push('GitHub reviews changed during capture; rerun for a stable snapshot');
    normalized.status = 'incomplete';
  }
  if (JSON.stringify(initialCommentPages) !== JSON.stringify(commentPages)) {
    normalized.errors.push('GitHub comments changed during capture; rerun for a stable snapshot');
    normalized.status = 'incomplete';
  }
  return {
    schema_version: 1,
    kind: 'github_app_capture',
    repository: normalized.repository,
    pr: normalized.pr,
    requested_head_sha: normalized.requested_head_sha,
    expected_reviewer_id: normalized.expected_reviewer_id,
    captured_at: new Date().toISOString(),
    status: normalized.status,
    errors: normalized.errors,
    pagination: {
      reviews: { pages: reviewPages.length, item_count: reviews.length },
      comments: { pages: commentPages.length, item_count: comments.length },
    },
    raw_reviews: reviews,
    raw_comments: comments,
    runs: normalized.runs,
  };
}

function git(repositoryRoot, args) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot, encoding: 'utf8', env: sanitizedGitEnvironment(),
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${spawnDiagnostic(result)}`);
  return result.stdout.trim();
}

function gitStatus(repositoryRoot) {
  const output = git(repositoryRoot, ['status', '--porcelain', '--untracked-files=all']);
  return output ? output.split('\n') : [];
}

function startCli(flags) {
  const root = fs.realpathSync(required(flags, '--repo-root'));
  const purpose = required(flags, '--purpose');
  if (!['proactive', 'recovery'].includes(purpose)) throw new Error('--purpose must be proactive or recovery');
  const out = destinationPath(required(flags, '--out'));
  const outputPath = destinationPath(required(flags, '--output'));
  if (out === outputPath) throw new Error('CLI capture and raw output must use different paths');
  if (out === cliReservationPath(outputPath) || outputPath === cliReservationPath(out)) {
    throw new Error('CLI capture, raw output, and reservation paths must all be distinct');
  }
  if (pathEntryExists(out)) throw new Error(`refusing to overwrite existing CLI capture: ${out}`);
  if (pathEntryExists(outputPath)) throw new Error(`CLI output path must not already exist: ${outputPath}`);
  const status = gitStatus(root);
  if (status.length > 0) throw new Error('start-cli requires a clean worktree and index');
  const head = fullSha(git(root, ['rev-parse', 'HEAD']), 'repository HEAD');
  const startedAt = new Date().toISOString();
  const capture = {
    schema_version: 1,
    kind: 'devin_cli_capture',
    repository_root: root,
    purpose,
    review_head_sha: head,
    started_at: startedAt,
    start_git_status: status,
    exit_code: null,
    status: 'started',
    outcome: null,
    reported_finding_count: null,
    raw_output_path: outputPath,
    raw_output_sha256: null,
    finished_at: null,
    finish_head_sha: null,
    finish_git_status: null,
    interrupted_at: null,
    interruption_reason: null,
    termination_signal: null,
    partial_reconciliation: null,
  };
  const reservations = [];
  try {
    for (const claim of [
      { targetPath: out, role: 'capture' },
      { targetPath: outputPath, role: 'output' },
    ].sort((left, right) => left.targetPath.localeCompare(right.targetPath))) {
      reservations.push(reserveCliPath(
        claim.targetPath, claim.role, out, outputPath, startedAt
      ));
    }
    writeNewJson(out, capture);
  } catch (error) {
    for (const reservationPath of reservations) {
      try { fs.unlinkSync(reservationPath); }
      catch (_) { /* An orphaned reservation fails safely and must not hide the original error. */ }
    }
    throw error;
  }
  return capture;
}

function recognizedPreflight(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').trim().split('\n');
  const trustRefusal = /^Error: Refusing to run in an untrusted workspace:[^\n]*$/.test(lines[0]);
  const permissionRefusal = /^Error: Tool call rejected by permission mode auto:[^\n]*$/.test(lines[0]);
  if ((!trustRefusal && !permissionRefusal) || lines.length === 0) return false;
  if (lines.length === 1) return true;
  return trustRefusal && lines.length === 2
    && lines[1] === 'Start `devin` interactively in this directory to trust it, or set `respect_workspace_trust: false` in your config to restore the previous behavior.';
}

function containsRecognizedPreflightLine(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  return lines.some((line) => recognizedPreflight(line));
}

function cliResponseText(text) {
  const output = String(text || '').replace(/\r\n/g, '\n');
  let parsed;
  try { parsed = JSON.parse(output); }
  catch (_) { return output; }
  if (!isObject(parsed)) return '';
  if (parsed.schema_version === 'ATIF-v1.7' && Array.isArray(parsed.steps)) {
    const finalStep = parsed.steps[parsed.steps.length - 1];
    if (!isObject(finalStep) || finalStep.source !== 'agent' || typeof finalStep.message !== 'string') return '';
    return finalStep.message.replace(/\r\n/g, '\n');
  }
  if (parsed.schema_version === 'devin-cli-session-transcript-v1'
      && parsed.kind === 'devin_cli_session_transcript' && Array.isArray(parsed.messages)) {
    const finalMessage = parsed.messages[parsed.messages.length - 1];
    if (!isObject(finalMessage) || finalMessage.role !== 'assistant'
        || typeof finalMessage.content !== 'string'
        || (Array.isArray(finalMessage.tool_calls) && finalMessage.tool_calls.length > 0)) return '';
    return finalMessage.content.replace(/\r\n/g, '\n');
  }
  return '';
}

function interruptedTranscript(text) {
  const output = Buffer.isBuffer(text) ? text.toString('utf8') : String(text || '');
  let parsed;
  try { parsed = JSON.parse(output); }
  catch (_) { return false; }
  if (isObject(parsed) && parsed.schema_version === 'ATIF-v1.7' && Array.isArray(parsed.steps)) {
    const finalStep = parsed.steps[parsed.steps.length - 1];
    return isObject(finalStep) && finalStep.source === 'agent'
      && isObject(finalStep.observation) && Array.isArray(finalStep.observation.results)
      && finalStep.observation.results.length === 1
      && isObject(finalStep.observation.results[0])
      && finalStep.observation.results[0].content === 'Tool execution was rejected by the user';
  }
  return observedTerminationSignal(output) === 'SIGINT';
}

function observedTerminationSignal(text) {
  let parsed;
  try { parsed = JSON.parse(Buffer.isBuffer(text) ? text.toString('utf8') : String(text || '')); }
  catch (_) { return null; }
  if (isObject(parsed)
      && parsed.schema_version === 'devin-cli-session-transcript-v1'
      && parsed.kind === 'devin_cli_session_transcript'
      && typeof parsed.session_id === 'string'
      && Array.isArray(parsed.messages) && parsed.messages.length > 0
      && isObject(parsed.termination)
      && parsed.termination.signal === 'SIGINT'
      && typeof parsed.termination.log_line === 'string'
      && parsed.termination.log_line.includes('Ctrl-C detected during request processing, requesting cancellation')) {
    return 'SIGINT';
  }
  return null;
}

function assistantMessages(text) {
  let parsed;
  try { parsed = JSON.parse(Buffer.isBuffer(text) ? text.toString('utf8') : String(text || '')); }
  catch (_) { return null; }
  let messages;
  if (isObject(parsed) && parsed.schema_version === 'ATIF-v1.7' && Array.isArray(parsed.steps)) {
    messages = parsed.steps.filter((step) => isObject(step) && step.source === 'agent')
      .map((step) => step.message === undefined || step.message === null ? '' : step.message);
  } else if (isObject(parsed) && parsed.schema_version === 'devin-cli-session-transcript-v1'
      && parsed.kind === 'devin_cli_session_transcript' && Array.isArray(parsed.messages)) {
    messages = parsed.messages.filter((message) => isObject(message) && message.role === 'assistant')
      .map((message) => message.content === undefined || message.content === null ? '' : message.content);
  } else {
    return null;
  }
  return messages.every((message) => typeof message === 'string') ? messages : null;
}

function occurrenceExists(text, quote, occurrence) {
  let position = -1;
  let cursor = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    position = text.indexOf(quote, cursor);
    if (position < 0) return false;
    cursor = position + 1;
  }
  return position >= 0;
}

function validatePartialReconciliation(output, transcriptSha256, reconciliation) {
  const errors = [];
  const recordKeys = ['schema_version', 'kind', 'transcript_sha256', 'messages', 'findings'];
  if (!sameKeys(reconciliation, recordKeys)) {
    return { errors: ['partial reconciliation has an unknown schema'], findings: [], reportIds: [] };
  }
  if (reconciliation.schema_version !== 1 || reconciliation.kind !== 'devin_cli_partial_reconciliation') {
    errors.push('partial reconciliation has an unknown schema');
  }
  if (reconciliation.transcript_sha256 !== transcriptSha256) {
    errors.push('partial reconciliation transcript checksum differs from raw CLI output');
  }
  const messages = assistantMessages(output);
  if (!messages) errors.push('partial reconciliation requires a supported transcript with string assistant messages');
  if (!Array.isArray(reconciliation.messages)) errors.push('partial reconciliation messages must be an array');
  const messageRecords = Array.isArray(reconciliation.messages) ? reconciliation.messages : [];
  if (messages && messageRecords.length !== messages.length) {
    errors.push('partial reconciliation must account for every assistant message');
  }
  const findings = Array.isArray(reconciliation.findings) ? reconciliation.findings : [];
  if (!Array.isArray(reconciliation.findings)) errors.push('partial reconciliation findings must be an array');
  if (findings.length > MAX_REPORT_COUNT) errors.push(`partial reconciliation findings must not exceed ${MAX_REPORT_COUNT}`);
  const messageFindingIds = [];
  for (let index = 0; index < messageRecords.length; index += 1) {
    const record = messageRecords[index];
    if (!sameKeys(record, ['message_index', 'classification', 'finding_ids'])) {
      errors.push(`partial reconciliation message ${index} has an unknown schema`);
      continue;
    }
    if (record.message_index !== index) errors.push(`partial reconciliation message indexes must be contiguous from zero`);
    if (!['no_findings', 'findings'].includes(record.classification)) {
      errors.push(`partial reconciliation message ${index} must be classified no_findings or findings`);
    }
    if (!Array.isArray(record.finding_ids)
        || record.finding_ids.some((id) => !nonBlankText(id))
        || new Set(record.finding_ids).size !== record.finding_ids.length) {
      errors.push(`partial reconciliation message ${index} finding_ids must be unique nonblank IDs`);
      continue;
    }
    if (record.classification === 'no_findings' && record.finding_ids.length !== 0) {
      errors.push(`partial reconciliation message ${index} is no_findings but lists findings`);
    }
    if (record.classification === 'findings' && record.finding_ids.length === 0) {
      errors.push(`partial reconciliation message ${index} is findings but lists no IDs`);
    }
    if (messages && typeof messages[index] === 'string') {
      messageFindingIds.push(...record.finding_ids.map((id) => ({ id, messageIndex: index })));
    }
  }
  const reportIds = [];
  const seenIds = new Set();
  for (const [index, finding] of findings.entries()) {
    if (!sameKeys(finding, ['id', 'message_index', 'quote', 'occurrence'])) {
      errors.push(`partial reconciliation finding ${index + 1} has an unknown schema`);
      continue;
    }
    if (!nonBlankText(finding.id) || seenIds.has(finding.id)) {
      errors.push(`partial reconciliation finding ${index + 1} ID must be unique and nonblank`);
    } else {
      seenIds.add(finding.id);
      reportIds.push(finding.id);
    }
    if (!Number.isInteger(finding.message_index) || finding.message_index < 0
        || !messages || finding.message_index >= messages.length) {
      errors.push(`partial reconciliation finding ${index + 1} has an invalid message_index`);
    } else if (!nonBlankText(finding.quote)) {
      errors.push(`partial reconciliation finding ${index + 1} quote is required`);
    } else if (!Number.isInteger(finding.occurrence) || finding.occurrence < 0
        || !occurrenceExists(messages[finding.message_index], finding.quote, finding.occurrence)) {
      errors.push(`partial reconciliation finding ${index + 1} quote is not present at its stated occurrence`);
    }
  }
  const declaredFindingIds = messageFindingIds.map((item) => item.id);
  const recordFindingIds = findings.filter(isObject).map((item) => item.id);
  if (!sameJson(declaredFindingIds.slice().sort(), recordFindingIds.slice().sort())) {
    errors.push('partial reconciliation message finding_ids do not match its finding records');
  }
  if (messages) {
    for (const item of messageFindingIds) {
      const finding = findings.find((candidate) => isObject(candidate) && candidate.id === item.id);
      if (finding && finding.message_index !== item.messageIndex) {
        errors.push(`partial reconciliation finding ${item.id} points to a different message than its message record`);
      }
    }
  }
  return { errors, findings, reportIds };
}

function completionMarkerMatch(line) {
  return String(line || '').replace(/[\p{White_Space}\uFEFF]+$/u, '')
    .match(/^DEVIN_REVIEW_COMPLETE outcome=(clean|findings) finding_count=(0|[1-9][0-9]*)$/);
}

function markdownFenceOpening(line) {
  const match = String(line || '').match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { character: match[1][0], length: match[1].length };
}

function markdownFenceClosing(line, openFence) {
  const match = String(line || '').match(/^ {0,3}(`{3,}|~{3,})[\t ]*$/);
  return match && match[1][0] === openFence.character && match[1].length >= openFence.length;
}

function linesOutsideCodeFences(text) {
  let codeFence = null;
  return String(text || '').replace(/\r\n/g, '\n').split('\n').map((line) => {
    if (codeFence) {
      if (markdownFenceClosing(line, codeFence)) codeFence = null;
      return null;
    }
    const fence = markdownFenceOpening(line);
    if (fence) {
      codeFence = fence;
      return null;
    }
    return line;
  });
}

function containsCliCompletionMarker(text) {
  const output = Buffer.isBuffer(text) ? text.toString('utf8') : String(text || '');
  let parsed;
  try { parsed = JSON.parse(output); }
  catch (_) { return false; }
  const hasMarker = (message) => {
    return linesOutsideCodeFences(message).some((line) => line !== null && completionMarkerMatch(line));
  };
  if (isObject(parsed) && parsed.schema_version === 'ATIF-v1.7' && Array.isArray(parsed.steps)) {
    return parsed.steps.some((step) => (
      isObject(step) && step.source === 'agent' && typeof step.message === 'string'
      && hasMarker(step.message)
    ));
  }
  if (isObject(parsed) && parsed.schema_version === 'devin-cli-session-transcript-v1'
      && parsed.kind === 'devin_cli_session_transcript' && Array.isArray(parsed.messages)) {
    return parsed.messages.some((message) => (
      isObject(message) && message.role === 'assistant' && typeof message.content === 'string'
      && hasMarker(message.content)
    ));
  }
  return false;
}

function parseCliCompletion(text) {
  const lines = linesOutsideCodeFences(cliResponseText(text));
  while (lines.length > 0) {
    const line = lines.pop();
    if (line === null) return null;
    if (line.replace(/[\p{White_Space}\uFEFF]+$/u, '') === '') continue;
    const match = completionMarkerMatch(line);
    if (!match) return null;
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count) || count > MAX_REPORT_COUNT) return null;
    if ((match[1] === 'clean' && count !== 0) || (match[1] === 'findings' && count < 1)) return null;
    return { outcome: match[1], finding_count: count };
  }
  return null;
}

function classifyCliExecution(exitCode, output) {
  if (interruptedTranscript(output) && !containsCliCompletionMarker(output)) return 'interrupted';
  if (exitCode === null || exitCode === undefined) {
    throw new Error('CLI exit code is required unless the export proves an interrupted run');
  }
  if (!Number.isSafeInteger(exitCode) || exitCode < 0) {
    throw new Error('CLI exit code must be a non-negative integer');
  }
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output || '');
  if (exitCode === 0) {
    if (containsRecognizedPreflightLine(cliResponseText(text))) return 'incomplete';
    return parseCliCompletion(text) ? 'complete' : 'incomplete';
  }
  return recognizedPreflight(text) ? 'preflight-failed' : 'incomplete';
}

function finishCli(flags) {
  const root = fs.realpathSync(required(flags, '--repo-root'));
  const captureFile = fs.realpathSync(required(flags, '--capture'));
  const capture = readJson(captureFile, 'CLI capture');
  if ((!sameKeys(capture, CLI_KEYS) && !sameKeys(capture, PRE_RECONCILIATION_CLI_KEYS)
      && !sameKeys(capture, LEGACY_CLI_KEYS))
      || capture.kind !== 'devin_cli_capture' || capture.schema_version !== 1) {
    throw new Error('CLI capture has an unknown schema');
  }
  if (capture.status !== 'started') throw new Error('CLI capture is not awaiting completion');
  if (fs.realpathSync(capture.repository_root) !== root) throw new Error('CLI capture repository differs from --repo-root');
  const reservations = [
    { file: cliReservationPath(captureFile), role: 'capture' },
    { file: cliReservationPath(capture.raw_output_path), role: 'output' },
  ];
  for (const expected of reservations) {
    const reservationStat = fs.lstatSync(expected.file);
    if (!reservationStat.isFile() || reservationStat.isSymbolicLink()) {
      throw new Error(`CLI ${expected.role} reservation is not a regular file`);
    }
    const reservation = readJson(expected.file, `CLI ${expected.role} reservation`);
    if (!sameKeys(reservation, CLI_RESERVATION_KEYS)
      || reservation.schema_version !== 1 || reservation.kind !== 'devin_cli_path_reservation'
      || reservation.role !== expected.role
      || reservation.capture_path !== captureFile
      || reservation.output_path !== capture.raw_output_path
      || reservation.started_at !== capture.started_at) {
      throw new Error(`CLI ${expected.role} reservation does not match its capture`);
    }
  }
  const outputFile = fs.realpathSync(required(flags, '--output'));
  if (fs.realpathSync(capture.raw_output_path) !== outputFile) {
    throw new Error('CLI output differs from the path reserved by start-cli');
  }
  const finishStatus = gitStatus(root);
  if (finishStatus.length > 0) throw new Error('finish-cli requires the same clean worktree and index');
  const finishHead = fullSha(git(root, ['rev-parse', 'HEAD']), 'repository HEAD');
  if (finishHead !== capture.review_head_sha) throw new Error('repository HEAD changed during the CLI review');
  const output = fs.readFileSync(outputFile);
  const startedAt = Date.parse(capture.started_at);
  if (!Number.isFinite(startedAt) || fs.statSync(outputFile).mtimeMs < startedAt) {
    throw new Error('CLI output predates the capture start');
  }
  const exitCode = flags['--exit-code'] === undefined
    ? null : nonNegativeInteger(flags['--exit-code'], '--exit-code');
  if (exitCode === 0 && output.toString('utf8').trim() === '') {
    throw new Error('a successful CLI run requires non-empty output evidence');
  }
  const status = classifyCliExecution(exitCode, output);
  const completion = parseCliCompletion(output);
  const outputSha256 = crypto.createHash('sha256').update(output).digest('hex');
  const interruptionReason = flags['--interruption-reason'] || null;
  const interruptedAt = flags['--interrupted-at'] || null;
  const suppliedTerminationSignal = flags['--termination-signal'] || null;
  let terminationSignal = null;
  if (status === 'interrupted') {
    if (!nonBlankText(interruptionReason) || !nonBlankText(interruptedAt)) {
      throw new Error('interrupted CLI runs require --interruption-reason and --interrupted-at');
    }
    if (suppliedTerminationSignal !== null && suppliedTerminationSignal !== 'SIGINT') {
      throw new Error('--termination-signal must be SIGINT when supplied');
    }
    terminationSignal = observedTerminationSignal(output);
    if (suppliedTerminationSignal !== null && suppliedTerminationSignal !== terminationSignal) {
      throw new Error('--termination-signal requires matching native transcript evidence');
    }
    const interruptionMs = Date.parse(interruptedAt);
    if (!Number.isFinite(interruptionMs) || interruptionMs < startedAt || interruptionMs > Date.now()) {
      throw new Error('--interrupted-at must be a valid instant between capture start and now');
    }
  } else if (interruptionReason !== null || interruptedAt !== null || suppliedTerminationSignal !== null) {
    throw new Error('interruption fields are only valid for an interrupted CLI export');
  } else if (exitCode === null) {
    throw new Error('--exit-code is required for non-interrupted CLI runs');
  }
  const suppliedOutcome = flags['--outcome'];
  if (suppliedOutcome !== undefined && !['clean', 'findings'].includes(suppliedOutcome)) {
    throw new Error('--outcome must be clean or findings');
  }
  let suppliedCount = null;
  if (flags['--finding-count'] !== undefined) {
    suppliedCount = nonNegativeInteger(flags['--finding-count'], '--finding-count');
    if (suppliedCount > MAX_REPORT_COUNT) {
      throw new Error(`--finding-count must not exceed ${MAX_REPORT_COUNT}`);
    }
  }
  if (status !== 'complete' && suppliedOutcome !== undefined) {
    throw new Error('--outcome is only valid for a completed CLI run');
  }
  if (suppliedCount !== null) {
    if (!['complete', 'interrupted'].includes(status)) {
      throw new Error('--finding-count is only valid for completed or interrupted CLI exports');
    }
  }
  let partialReconciliation = null;
  let partialFindingTotal = 0;
  if (status === 'interrupted') {
    const reconciliationFile = fs.realpathSync(required(flags, '--reconciliation'));
    if (reconciliationFile === captureFile || reconciliationFile === outputFile) {
      throw new Error('partial reconciliation must use a separate file from the CLI capture and output');
    }
    partialReconciliation = readJson(reconciliationFile, 'partial reconciliation');
    const checked = validatePartialReconciliation(output, outputSha256, partialReconciliation);
    if (checked.errors.length > 0) throw new Error(checked.errors.join('; '));
    partialFindingTotal = checked.findings.length;
    if (suppliedCount !== null && suppliedCount !== partialFindingTotal) {
      throw new Error('--finding-count differs from the partial reconciliation record');
    }
  } else if (flags['--reconciliation'] !== undefined) {
    throw new Error('--reconciliation is only valid for an interrupted CLI run');
  }
  let outcome = null;
  let count = 0;
  if (status === 'complete') {
    outcome = completion.outcome;
    count = completion.finding_count;
    if (suppliedOutcome !== undefined && suppliedOutcome !== outcome) {
      throw new Error('--outcome differs from the CLI completion marker');
    }
    if (suppliedCount !== null && suppliedCount !== count) {
      throw new Error('--finding-count differs from the CLI completion marker');
    }
  }
  if (status === 'interrupted') count = partialFindingTotal;
  const finished = {
    ...capture,
    exit_code: exitCode,
    status,
    outcome,
    reported_finding_count: count,
    raw_output_path: outputFile,
    raw_output_sha256: outputSha256,
    finished_at: interruptedAt || new Date().toISOString(),
    finish_head_sha: finishHead,
    finish_git_status: finishStatus,
    interrupted_at: interruptedAt,
    interruption_reason: interruptionReason,
    termination_signal: terminationSignal,
    partial_reconciliation: partialReconciliation,
  };
  atomicWriteJson(captureFile, finished);
  for (const reservation of reservations) {
    try { fs.unlinkSync(reservation.file); }
    catch (_) { /* Finished evidence and existing target files keep stale claims fail-closed. */ }
  }
  return finished;
}

function reconcileInterruptedCli(flags) {
  const root = fs.realpathSync(required(flags, '--repo-root'));
  const captureFile = fs.realpathSync(required(flags, '--capture'));
  const outputFile = fs.realpathSync(required(flags, '--output'));
  const capture = readJson(captureFile, 'CLI capture');
  if ((!sameKeys(capture, LEGACY_CLI_KEYS) && !sameKeys(capture, PRE_RECONCILIATION_CLI_KEYS))
      || capture.kind !== 'devin_cli_capture'
      || capture.schema_version !== 1 || capture.status !== 'incomplete') {
    throw new Error('reconcile-cli requires a legacy incomplete CLI capture');
  }
  if (fs.realpathSync(capture.repository_root) !== root) throw new Error('CLI capture repository differs from --repo-root');
  if (fs.realpathSync(capture.raw_output_path) !== outputFile) throw new Error('CLI output differs from the path reserved by start-cli');
  const output = fs.readFileSync(outputFile);
  const digest = crypto.createHash('sha256').update(output).digest('hex');
  if (digest !== capture.raw_output_sha256) throw new Error('raw CLI output checksum differs from its capture');
  if (classifyCliExecution(capture.exit_code, output) !== 'interrupted') {
    throw new Error('raw CLI output does not prove an interrupted execution');
  }
  const finishStatus = gitStatus(root);
  if (finishStatus.length > 0) throw new Error('reconcile-cli requires the same clean worktree and index');
  const finishHead = fullSha(git(root, ['rev-parse', 'HEAD']), 'repository HEAD');
  if (finishHead !== capture.review_head_sha || capture.finish_head_sha !== capture.review_head_sha) {
    throw new Error('repository HEAD differs from the interrupted CLI capture');
  }
  const reason = required(flags, '--interruption-reason');
  const reconciliationFile = fs.realpathSync(required(flags, '--reconciliation'));
  if (reconciliationFile === captureFile || reconciliationFile === outputFile) {
    throw new Error('partial reconciliation must use a separate file from the CLI capture and output');
  }
  const reconciliation = readJson(reconciliationFile, 'partial reconciliation');
  const checked = validatePartialReconciliation(output, digest, reconciliation);
  if (checked.errors.length > 0) throw new Error(checked.errors.join('; '));
  const count = checked.findings.length;
  if (flags['--finding-count'] !== undefined
      && nonNegativeInteger(flags['--finding-count'], '--finding-count') !== count) {
    throw new Error('--finding-count differs from the partial reconciliation record');
  }
  const interrupted = {
    ...capture,
    status: 'interrupted',
    reported_finding_count: count,
    interrupted_at: capture.finished_at,
    interruption_reason: reason,
    termination_signal: null,
    partial_reconciliation: reconciliation,
  };
  atomicWriteJson(captureFile, interrupted);
  return interrupted;
}

function prepareReconciliation(flags) {
  const outputFile = fs.realpathSync(required(flags, '--output'));
  const reconciliationFile = destinationPath(required(flags, '--out'));
  if (reconciliationFile === outputFile) {
    throw new Error('partial reconciliation must use a separate file from the CLI output');
  }
  if (pathEntryExists(reconciliationFile)) {
    throw new Error(`refusing to overwrite existing partial reconciliation: ${reconciliationFile}`);
  }
  const output = fs.readFileSync(outputFile);
  const messages = assistantMessages(output);
  if (!messages) throw new Error('partial reconciliation requires a supported transcript with string assistant messages');
  const reconciliation = {
    schema_version: 1,
    kind: 'devin_cli_partial_reconciliation',
    transcript_sha256: crypto.createHash('sha256').update(output).digest('hex'),
    messages: messages.map((_, messageIndex) => ({
      message_index: messageIndex,
      classification: 'unresolved',
      finding_ids: [],
    })),
    findings: [],
  };
  writeNewJson(reconciliationFile, reconciliation);
  return reconciliation;
}

function usage() {
  return [
    'usage:',
    '  review-evidence.js capture-app --repo owner/repository --pr N --head SHA --reviewer-id 158243242 --out FILE',
    '  review-evidence.js start-cli --repo-root DIR --purpose proactive|recovery --output FILE --out FILE',
    '  review-evidence.js finish-cli --repo-root DIR --capture FILE --output FILE [--exit-code N] [--outcome clean|findings --finding-count N] [--interruption-reason TEXT --interrupted-at ISO --reconciliation FILE [--termination-signal SIGINT]]',
    '  review-evidence.js reconcile-cli --repo-root DIR --capture FILE --output FILE --interruption-reason TEXT --reconciliation FILE',
    '  review-evidence.js prepare-reconciliation --output FILE --out FILE',
  ].join('\n');
}

function main(argv) {
  try {
    const { command, flags } = parseArgs(argv);
    if (command === 'capture-app') {
      const options = {
        repository: canonicalRepository(required(flags, '--repo')),
        pr: positiveInteger(required(flags, '--pr'), '--pr'),
        requestedHeadSha: fullSha(required(flags, '--head'), '--head'),
        expectedReviewerId: positiveInteger(required(flags, '--reviewer-id'), '--reviewer-id'),
      };
      const capture = collectAppEvidence(options);
      atomicWriteJson(required(flags, '--out'), capture);
      console.log(`captured ${capture.runs.length} Devin app review${capture.runs.length === 1 ? '' : 's'} for ${capture.requested_head_sha}`);
      if (capture.status !== 'complete') process.exitCode = 1;
      return;
    }
    if (command === 'start-cli') {
      const capture = startCli(flags);
      console.log(`CLI capture started at ${capture.review_head_sha}`);
      return;
    }
    if (command === 'finish-cli') {
      const capture = finishCli(flags);
      console.log(`CLI capture finished with status ${capture.status}`);
      return;
    }
    if (command === 'reconcile-cli') {
      const capture = reconcileInterruptedCli(flags);
      console.log(`CLI capture reconciled with status ${capture.status}`);
      return;
    }
    if (command === 'prepare-reconciliation') {
      const reconciliation = prepareReconciliation(flags);
      console.log(`partial reconciliation prepared for ${reconciliation.messages.length} assistant messages`);
      return;
    }
    throw new Error(usage());
  } catch (error) {
    console.error(`review-evidence: ${error.message}`);
    if (!String(error.message).startsWith('usage:')) console.error(usage());
    process.exitCode = 2;
  }
}

module.exports = {
  APP_KEYS,
  CLI_KEYS,
  PRE_RECONCILIATION_CLI_KEYS,
  classifyCliExecution,
  DEVIN_REVIEWER_ID,
  MAX_REPORT_COUNT,
  collectAppEvidence,
  normalizeAppPayload,
  parseCliCompletion,
  interruptedTranscript,
  containsCliCompletionMarker,
  assistantMessages,
  validatePartialReconciliation,
  observedTerminationSignal,
  parseReviewBody,
  recognizedPreflight,
};

if (require.main === module) main(process.argv.slice(2));
