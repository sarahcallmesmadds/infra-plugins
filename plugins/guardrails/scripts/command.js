// Assess a shell command for irreversible destructive potential.
//
// Scope is deliberately narrow: recursive force-delete, and a small set of
// commands that discard work with no undo. A guard that flags everything gets
// ignored, so this only fires where recovery is genuinely hard.

'use strict';

function firstLineOf(command) {
  // Only the command line itself. Heredoc bodies frequently contain the word
  // "rm" as prose and are not being executed.
  return String(command || '').split('\n')[0];
}

function isRecursiveForceDelete(line) {
  if (!/\brm\b/.test(line)) return false;
  const recursive = /(^|\s)(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(\s|$)/.test(line);
  const force = /(^|\s)(-[a-zA-Z]*f[a-zA-Z]*|--force)(\s|$)/.test(line);
  return recursive && force;
}

function deleteTarget(command) {
  const stripped = String(command).replace(
    /.*\brm\s+((-{1,2}[a-zA-Z-]+\s+)*)/,
    ''
  ).trim();
  return stripped.split(/\s+/)[0] || '(unknown path)';
}

// Commands that throw away committed or staged work with no straightforward undo.
const IRREVERSIBLE_GIT = [
  { re: /\bgit\s+reset\s+--hard\b/, what: 'git reset --hard discards uncommitted work' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*[dfx]/, what: 'git clean removes untracked files permanently' },
  { re: /\bgit\s+push\s+[^\n]*--force(?!-with-lease)/, what: 'git push --force can overwrite a remote branch' },
  { re: /\bgit\s+branch\s+-D\b/, what: 'git branch -D deletes an unmerged branch' },
];

// Returns { verdict: 'allow' | 'confirm', reason, target }.
function checkCommand(command, config = {}) {
  const safePaths = config.safeDeletePaths || [];
  const line = firstLineOf(command);
  const full = String(command || '');

  if (isRecursiveForceDelete(line)) {
    const onSafePath = safePaths.some((p) => full.includes(p));
    if (!onSafePath) {
      const target = deleteTarget(line);
      return {
        verdict: 'confirm',
        target,
        reason:
          `Recursive force-delete of "${target}". This cannot be undone.\n\n` +
          `Before running it, say what is being deleted, why it is safe to delete, ` +
          `and how it could be recovered if the answer turns out to be wrong. ` +
          `If the path is routinely disposable, add it to safeDeletePaths in ` +
          `~/.claude/guardrails.config.json rather than approving it each time.`,
      };
    }
  }

  for (const entry of IRREVERSIBLE_GIT) {
    if (entry.re.test(line)) {
      return {
        verdict: 'confirm',
        target: line.trim(),
        reason:
          `${entry.what}.\n\nConfirm this is intended before running it. ` +
          `If you are recovering from a mistake, check \`git reflog\` first, ` +
          `it usually still has what you are about to discard.`,
      };
    }
  }

  return { verdict: 'allow' };
}

module.exports = { checkCommand, isRecursiveForceDelete };
