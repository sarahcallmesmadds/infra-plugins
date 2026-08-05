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

// Returns the path exactly as it was typed. Expansion and resolution happen in
// currentBranch, because the original text is what belongs in a message shown
// to the person who typed it.
function targetRepoDir(command) {
  const dashC = command.match(/\bgit\s+(?:[^\s]+\s+)*?-C\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  if (dashC) return dashC[1] || dashC[2] || dashC[3];
  const cd = command.match(/(?:^|[;&|]|&&)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  if (cd) return cd[1] || cd[2] || cd[3];
  return null;
}

// A relative path means "relative to where the command runs", which is
// `eventCwd` and never this process's own directory. Resolving `subdir`
// against the hook's location points at a directory that has nothing to do
// with the command, so a repository that is right there looks missing and
// `cd subdir && git commit` gets judged somewhere else entirely.
function resolveAgainst(named, base) {
  const expanded = expandHome(named);
  return path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
}

// `eventCwd` is the directory the Bash tool will actually run the command in,
// and it is the one to trust. The hook is a separate process, so its own
// process.cwd() is wherever the harness happened to spawn it, which is not
// necessarily where the command lands. The Bash tool also keeps its working
// directory between calls, so `cd repo` in one call and `git commit` in the
// next is an ordinary sequence, and only the event knows about the first call.
// Falling back to process.cwd() checked some other repository, or no repository
// at all, and a branch guard that reads the wrong repo reads the wrong branch.
// A named directory that cannot be found falls back to `base`, the directory
// the command runs in. It does not refuse.
//
// Refusing was tried and it was wrong. The text after `cd` is frequently
// something that only the shell can turn into a path: `$REPO`, or
// `"$(git rev-parse --show-toplevel)"`, or a directory created earlier in the
// same line by `git clone x r && cd r`. None of those exist at the moment this
// hook looks, and all of them are ordinary. Refusing stopped real work and
// told people to write out a path that is computed, which they cannot do.
//
// The fallback is not a consolation prize. `$(git rev-parse --show-toplevel)`
// IS the repository the command already sits in, so reading `base` answers it
// exactly. A path in a variable usually points at the repository you are
// working in, so `base` answers it often. A fresh clone has no branch worth
// protecting yet, and `base` is its parent, which is normally not a repository
// at all, so nothing fires. The cases where the fallback is wrong are the ones
// where a commit is aimed at a different repository named dynamically, and
// that stays uncovered rather than being covered by guessing.
//
// Silence in these cases is deliberate:
//
//   directory exists but is not a repository   git commit fails by itself, so
//                                              there is nothing to protect
//   detached HEAD                              symbolic-ref fails on a valid
//                                              repository doing normal work
//   nothing named and nowhere is a repository  committing outside a repository
//                                              is not a thing that happens
//
// There is no exception here for a repository with no commits yet, and there
// was one for a day. It rested on the claim that such a repository cannot be
// put on another branch, so the first commit is necessarily on main and the
// block had nothing to suggest. The claim is simply false. `git checkout -b
// feature` succeeds on an unborn HEAD and repoints it, and the branch is real
// as soon as the first commit lands. Checked by running it rather than by
// reasoning about it, which is how the mistake got in.
//
// So the advice the guard prints was always actionable, including on the very
// first commit, and the exception did nothing but wave through the one commit
// that establishes main as the branch everybody then keeps committing to.
function currentBranch(command, eventCwd) {
  const named = targetRepoDir(command || '');
  const base = eventCwd || process.cwd();

  let dir = null;
  if (named) {
    const candidate = resolveAgainst(named, base);
    try {
      if (fs.statSync(candidate).isDirectory()) dir = candidate;
    } catch (_) {
      // Leave dir null and fall back to base, below.
    }
  }

  try {
    return execSync('git symbolic-ref --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: dir || base,
    }).trim();
  } catch (_) {
    return null; // not a repository, or a detached HEAD
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

  // 1. Destructive commands, and commands that skip the commit hooks.
  //
  // No switch is read here. checkCommand reads its own, one per family of
  // rule, because gating the whole call on blockDestructiveCommands meant
  // turning off delete prompts also turned off the commit-hook rule without
  // saying so.
  const verdict = checkCommand(command, config);
  if (verdict.verdict === 'confirm') {
    block(verdict.reason);
    return;
  }

  // `git commit`, but also `git -C <path> commit`, `git --no-pager commit`, and
  // any other option between the two words. Matching only the adjacent form is
  // what let `git -C <path> commit` past the branch guard entirely.
  if (!IS_GIT_COMMIT.test(command)) return;

  // 2. Protected branches.
  if (config.blockCommitToProtectedBranch) {
    const branch = currentBranch(command, event.cwd);
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
