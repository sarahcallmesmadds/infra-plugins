#!/usr/bin/env node
// PreToolUse hook for Bash. Blocks three classes of command:
//   1. Recursive force-delete outside known-disposable paths
//   2. Commits directly to a protected branch
//   3. Commit messages that miss the Conventional Commits format (opt in)

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
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
// `~` is expanded by the shell, not by us, so a path lifted straight out of the
// command text still has it. execSync then looks for a directory literally
// named "~/Projects/thing", does not find one, throws, and the guard waves the
// commit through in silence. `cd ~/some/repo && git commit` is how most people
// write it, so the guard worked or did not depending on how the path happened
// to be typed. A bare `~` and `~/...` are the two forms worth handling; `~user`
// means another account's home and is not something to guess at.
function expandHome(dir) {
  if (dir === '~') return os.homedir();
  if (dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

function targetRepoDir(command) {
  const dashC = command.match(/\bgit\s+(?:[^\s]+\s+)*?-C\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  if (dashC) return expandHome(dashC[1] || dashC[2] || dashC[3]);
  const cd = command.match(/(?:^|[;&|]|&&)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  if (cd) return expandHome(cd[1] || cd[2] || cd[3]);
  return null;
}

// `eventCwd` is the directory the Bash tool will actually run the command in,
// and it is the one to trust. The hook is a separate process, so its own
// process.cwd() is wherever the harness happened to spawn it, which is not
// necessarily where the command lands. The Bash tool also keeps its working
// directory between calls, so `cd repo` in one call and `git commit` in the
// next is an ordinary sequence, and only the event knows about the first call.
// Falling back to process.cwd() checked some other repository, or no repository
// at all, and a branch guard that reads the wrong repo reads the wrong branch.
// Returns { branch, unresolved }.
//
// `unresolved` is the case the guard used to hide: the command names a
// directory to commit in, and that directory is not there. A shell variable is
// the usual reason, `cd $REPO && git commit`, because the shell expands it and
// we only ever see the text. It cannot be resolved from here at all.
//
// Everything else stays quiet on purpose:
//
//   directory exists but is not a repository   git commit fails by itself, so
//                                              there is nothing to protect
//   detached HEAD                              symbolic-ref fails on a valid
//                                              repository doing normal work
//   no directory named and nowhere is a repo   committing outside a repository
//                                              is not a thing that happens
//
// Only the first is a case where a commit could really land on a protected
// branch without the guard having any way to see it, and that is the only one
// worth interrupting for.
function currentBranch(command, eventCwd) {
  const named = targetRepoDir(command || '');

  if (named) {
    let ok = false;
    try {
      ok = fs.statSync(named).isDirectory();
    } catch (_) {
      ok = false;
    }
    if (!ok) return { branch: null, unresolved: true, named };
  }

  try {
    const branch = execSync('git symbolic-ref --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: named || eventCwd || process.cwd(),
    }).trim();
    return { branch, unresolved: false, named };
  } catch (_) {
    return { branch: null, unresolved: false, named };
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
    const { branch, unresolved, named } = currentBranch(command, event.cwd);

    if (unresolved) {
      block(
        `This commit names a directory the guard cannot find: "${named}".\n\n` +
        `That usually means the path is held in a shell variable, which the ` +
        `shell expands and this check never sees. So there is no way to tell ` +
        `which branch the commit would land on, and it could be a protected one.\n\n` +
        `Write the path out in full, or run the commit from inside the ` +
        `repository, and this will check it properly.`
      );
      return;
    }

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
