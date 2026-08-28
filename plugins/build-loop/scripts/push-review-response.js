#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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
    const result = spawnSync('git', pushArguments(round, destination), {
      cwd: args.repoRoot,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return Number.isInteger(result.status) ? result.status : 1;
    return 0;
  } catch (error) {
    console.error(`push-review-response: ${error.message}`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArguments, pushArguments, selectPushDestination };
