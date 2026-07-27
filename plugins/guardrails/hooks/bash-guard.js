#!/usr/bin/env node
// PreToolUse hook for Bash. Blocks three classes of command:
//   1. Recursive force-delete outside known-disposable paths
//   2. Commits directly to a protected branch
//   3. Commit messages that miss the Conventional Commits format (opt in)

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { readEvent, block } = require(path.join(ROOT, 'scripts', 'hook-io'));
const { loadConfig } = require(path.join(ROOT, 'scripts', 'config'));
const { checkCommand } = require(path.join(ROOT, 'scripts', 'command'));

const IS_GIT_COMMIT = /\bgit\s+(?:-[^\s]+(?:\s+[^\s-][^\s]*)?\s+)*commit\b/;

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+/;

// The repository a git command actually targets is not necessarily the hook's
// own working directory. `git -C <path> commit` and `cd <path> && git commit`
// both act somewhere else, and checking the wrong repo means checking the wrong
// branch, which silently defeats the guard.
function targetRepoDir(command) {
  const dashC = command.match(/\bgit\s+(?:[^\s]+\s+)*?-C\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  if (dashC) return dashC[1] || dashC[2] || dashC[3];
  const cd = command.match(/(?:^|[;&|]|&&)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  if (cd) return cd[1] || cd[2] || cd[3];
  return null;
}

function currentBranch(command) {
  const dir = targetRepoDir(command || '');
  try {
    return execSync('git symbolic-ref --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: dir || process.cwd(),
    }).trim();
  } catch (_) {
    return null; // not a git repository, bad path, or detached HEAD
  }
}

function commitMessageFrom(command) {
  const quoted = command.match(/-m\s+(?:"([^"]*)"|'([^']*)')/);
  if (quoted) return quoted[1] !== undefined ? quoted[1] : quoted[2];
  const heredoc = command.match(/<<\s*'?EOF'?\s*\n([^\n]*)/);
  return heredoc ? heredoc[1] : null;
}

readEvent((event) => {
  if (event.tool_name !== 'Bash') return;

  const command = (event.tool_input && event.tool_input.command) || '';
  if (!command) return;

  const config = loadConfig();

  // 1. Destructive commands.
  if (config.blockDestructiveCommands) {
    const verdict = checkCommand(command, config);
    if (verdict.verdict === 'confirm') {
      block(verdict.reason);
      return;
    }
  }

  // `git commit`, but also `git -C <path> commit`, `git --no-pager commit`, and
  // any other option between the two words. Matching only the adjacent form is
  // what let `git -C <path> commit` past the branch guard entirely.
  if (!IS_GIT_COMMIT.test(command)) return;

  // 2. Protected branches.
  if (config.blockCommitToProtectedBranch) {
    const branch = currentBranch(command);
    if (branch && config.protectedBranches.includes(branch)) {
      block(
        `You are on "${branch}", which is a protected branch.\n\n` +
        `Branch first, then commit:\n` +
        `  git checkout -b <short-description-of-the-change>\n\n` +
        `To change which branches are protected, edit protectedBranches in ` +
        `~/.claude/guardrails.config.json.`
      );
      return;
    }
  }

  // 3. Commit message format.
  if (config.requireConventionalCommits) {
    const message = commitMessageFrom(command);
    if (message && !CONVENTIONAL.test(message)) {
      block(
        `Commit message does not match Conventional Commits:\n  "${message}"\n\n` +
        `Expected "<type>: <description>", where type is one of feat, fix, docs, ` +
        `style, refactor, perf, test, build, ci, chore, revert.\n\n` +
        `To turn this check off, set requireConventionalCommits to false in ` +
        `~/.claude/guardrails.config.json.`
      );
    }
  }
});
