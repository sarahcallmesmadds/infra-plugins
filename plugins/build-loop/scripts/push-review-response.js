#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  isolatedGitEnvironment,
  sanitizedGitEnvironment,
} = require('./git-environment');
const { inspectPushUrls, validateRound } = require('./pre-push-check');

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== '--repo-root' || argv[2] !== '--round') {
    throw new Error('usage: push-review-response.js --repo-root REPOSITORY --round ROUND.json');
  }
  return {
    repoRoot: fs.realpathSync(argv[1]),
    roundFile: fs.realpathSync(argv[3]),
  };
}

function pushArguments(round, destination) {
  if (!round || round.response_mode !== 'commit') {
    throw new Error('push-review-response requires a commit response');
  }
  if (typeof round.push_remote !== 'string' || round.push_remote.length === 0
    || typeof round.branch !== 'string' || round.branch.length === 0) {
    throw new Error('round push_remote and branch are required');
  }
  if (!/^[0-9a-f]{40}$/i.test(round.review_head_sha || '')
    || !/^[0-9a-f]{40}$/i.test(round.response_head_sha || '')) {
    throw new Error('round review_head_sha and response_head_sha must be full commit SHAs');
  }
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new Error('a validated push URL is required');
  }
  const branchRef = `refs/heads/${round.branch}`;
  return [
    'push', `--force-with-lease=${branchRef}:${round.review_head_sha}`,
    '--end-of-options', destination, `${round.response_head_sha}:${branchRef}`,
  ];
}

function selectPushDestination(urls) {
  if (!Array.isArray(urls) || urls.length === 0
    || urls.some((url) => typeof url !== 'string' || url.length === 0)) {
    throw new Error('at least one validated push URL is required');
  }
  return urls[0];
}

function repositoryGitPath(repoRoot, name) {
  const env = sanitizedGitEnvironment();
  let result = spawnSync('git', [
    'rev-parse', '--path-format=absolute', '--git-path', name,
  ], { cwd: repoRoot, encoding: 'utf8', env });
  if (result.error) throw result.error;
  let value = result.status === 0 ? result.stdout.trim() : '';
  // Git before 2.31 can echo an unknown option to stdout and still exit zero.
  // Treat any non-path-shaped answer as unsupported and retry without the flag.
  if (result.status !== 0 || !value || /[\r\n]/.test(value)) {
    result = spawnSync('git', ['rev-parse', '--git-path', name], {
      cwd: repoRoot, encoding: 'utf8', env,
    });
    if (result.error) throw result.error;
    value = result.status === 0 ? result.stdout.trim() : '';
  }
  if (result.status !== 0) {
    throw new Error(`cannot locate repository ${name}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  if (!value || /[\r\n]/.test(value)) throw new Error(`repository ${name} path is malformed`);
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function pushWithIsolatedConfig(repoRoot, args, stdio = 'inherit') {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-review-push-'));
  const gitDir = path.join(scratch, 'repository.git');
  try {
    const objectDirectory = fs.realpathSync(repositoryGitPath(repoRoot, 'objects'));
    const shallowFile = repositoryGitPath(repoRoot, 'shallow');
    fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/unused\n', { mode: 0o600 });
    fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), `${objectDirectory}\n`, { mode: 0o600 });
    if (fs.existsSync(shallowFile)) {
      const boundaries = fs.readFileSync(shallowFile, 'utf8').trim().split('\n');
      if (boundaries.length === 0 || boundaries.some((sha) => !/^[0-9a-f]{40}$/i.test(sha))) {
        throw new Error('repository shallow boundaries are malformed');
      }
      fs.writeFileSync(path.join(gitDir, 'shallow'), `${boundaries.join('\n')}\n`, { mode: 0o600 });
    }
    fs.writeFileSync(path.join(gitDir, 'config'), [
      '[core]',
      '\trepositoryformatversion = 0',
      '\tbare = true',
      '[credential "https://github.com"]',
      '\thelper =',
      '\thelper = !gh auth git-credential',
      '',
    ].join('\n'), { mode: 0o600 });
    return spawnSync('git', ['--git-dir', gitDir, ...args], {
      cwd: scratch,
      stdio,
      env: isolatedGitEnvironment(),
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function main(argv) {
  try {
    const args = parseArguments(argv);
    const round = JSON.parse(fs.readFileSync(args.roundFile, 'utf8'));
    const errors = validateRound(round, args.roundFile, {
      phase: 'pre-push', repoRoot: args.repoRoot,
    });
    if (errors.length > 0) {
      console.error(`round is not pre-push ready (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
      for (const error of errors) console.error(`- ${error}`);
      return 1;
    }
    const inspection = inspectPushUrls(args.repoRoot, round.push_remote, round.head_repository);
    if (inspection.errors.length > 0) throw new Error(inspection.errors.join('; '));
    const destination = selectPushDestination(inspection.urls);
    const result = pushWithIsolatedConfig(
      args.repoRoot, pushArguments(round, destination)
    );
    if (result.error) throw result.error;
    if (result.status !== 0) return Number.isInteger(result.status) ? result.status : 1;
    return 0;
  } catch (error) {
    console.error(`push-review-response: ${error.message}`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  isolatedGitEnvironment,
  main,
  parseArguments,
  pushArguments,
  pushWithIsolatedConfig,
  repositoryGitPath,
  selectPushDestination,
};
