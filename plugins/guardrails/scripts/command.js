// Assess a shell command for irreversible destructive potential.
//
// Scope is deliberately narrow: recursive force-delete, and a small set of
// commands that discard work with no undo. A guard that flags everything gets
// ignored, so this only fires where recovery is genuinely hard.

'use strict';

const path = require('path');

// Split a command line into its separate commands. A safe-path decision must be
// made against the delete target itself, never against the whole line: a command
// like `cp x /tmp/y && rm -rf ~/live` mentions a disposable path but deletes
// something else entirely.
function segments(line) {
  return String(line || '')
    .split(/&&|\|\||[;&|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstLineOf(command) {
  // Only the command line itself. Heredoc bodies frequently contain the word
  // "rm" as prose and are not being executed.
  return String(command || '').split('\n')[0];
}

function isRecursiveForceDelete(segment) {
  if (!/(^|\s)rm(\s|$)/.test(segment)) return false;
  const recursive = /(^|\s)(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(\s|$)/.test(segment);
  const force = /(^|\s)(-[a-zA-Z]*f[a-zA-Z]*|--force)(\s|$)/.test(segment);
  return recursive && force;
}

// Every operand of an `rm` after its flags are stripped. `rm -rf a b` deletes two
// things, and both have to clear the safe-path check.
function deleteTargets(segment) {
  const afterRm = segment.replace(/^.*?(^|\s)rm(\s|$)/, ' ');
  return afterRm
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && !token.startsWith('-'));
}

// A target is disposable if the configured path is a prefix of it, or appears as
// a whole path segment inside it. Substring matching alone would let
// `~/node_modules_backup` pass as `node_modules`.
function isDisposable(target, safePaths) {
  const normalized = target.replace(/\/+$/, '');
  return safePaths.some((raw) => {
    const safe = String(raw).replace(/\/+$/, '');
    if (!safe) return false;
    if (normalized === safe) return true;
    if (normalized.startsWith(safe + '/')) return true;
    if (normalized.startsWith(safe) && safe.startsWith('/')) return true;
    return normalized.includes('/' + safe + '/') || normalized.endsWith('/' + safe);
  });
}

// Commands that throw away committed or staged work with no straightforward undo.
const IRREVERSIBLE_GIT = [
  { re: /(^|\s)git\s+reset\s+--hard(\s|$)/, what: 'git reset --hard discards uncommitted work' },
  { re: /(^|\s)git\s+clean\s+-[a-zA-Z]*[dfx]/, what: 'git clean removes untracked files permanently' },
  { re: /(^|\s)git\s+push\s[^\n]*--force(?!-with-lease)/, what: 'git push --force can overwrite a remote branch' },
  { re: /(^|\s)git\s+branch\s+-D(\s|$)/, what: 'git branch -D deletes an unmerged branch' },
];

// Returns { verdict: 'allow' | 'confirm', reason, target }.
function checkCommand(command, config = {}) {
  const safePaths = config.safeDeletePaths || [];
  const line = firstLineOf(command);

  for (const segment of segments(line)) {
    if (isRecursiveForceDelete(segment)) {
      const targets = deleteTargets(segment);
      // No parsable operand means we could not establish what is being deleted.
      // Ask rather than assume.
      const unsafe = targets.length === 0
        ? ['(unparsed target)']
        : targets.filter((t) => !isDisposable(t, safePaths));

      if (unsafe.length > 0) {
        const shown = unsafe.join(', ');
        return {
          verdict: 'confirm',
          target: shown,
          reason:
            `Recursive force-delete of ${shown}. This cannot be undone.\n\n` +
            `Before running it, say what is being deleted, why it is safe to delete, ` +
            `and how it could be recovered if the answer turns out to be wrong. ` +
            `If the path is routinely disposable, add it to safeDeletePaths in ` +
            `~/.claude/guardrails.config.json rather than approving it each time.`,
        };
      }
    }

    for (const entry of IRREVERSIBLE_GIT) {
      if (entry.re.test(segment)) {
        return {
          verdict: 'confirm',
          target: segment,
          reason:
            `${entry.what}.\n\nConfirm this is intended before running it. ` +
            `If you are recovering from a mistake, check \`git reflog\` first, ` +
            `it usually still has what you are about to discard.`,
        };
      }
    }
  }

  return { verdict: 'allow' };
}

module.exports = { checkCommand, isRecursiveForceDelete, deleteTargets, isDisposable };
