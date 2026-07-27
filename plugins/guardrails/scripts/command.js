// Assess a shell command for irreversible destructive potential.
//
// Scope is deliberately narrow: recursive force-delete, and a small set of
// commands that discard work with no undo. A guard that flags everything gets
// ignored, so this only fires where recovery is genuinely hard.

'use strict';

const path = require('path');

// Commands that take a string and run it as shell code. When one of these is
// present, text inside quotes IS code and has to stay visible to the checks
// below, or `bash -c "rm -rf ~/live"` would walk straight through.
const SHELL_INVOKERS = /(^|\s)(bash|sh|zsh|dash|ksh|fish|eval|ssh|xargs|watch)(\s|$)/;

// Blank the inside of quoted strings, keeping every character position so
// offsets still line up with the original text.
//
// Without this, any command that merely MENTIONS a delete is treated as one:
// `claude -p "assess rm -rf ./tmp"` deletes nothing but matched the rm rule,
// and the reported target became the rest of the English sentence. Passing a
// string to another program is not executing it. If that program goes on to
// run something destructive, it is caught then, by the guard on that call.
// The mirror of maskQuoted, for lines that DO execute their quoted text. The
// quote characters are replaced by spaces so the code inside them reads as
// code. Without this, `bash -c "rm -rf ~/live"` slips past every rule here:
// the rules anchor on whitespace, and the opening quote sits where the
// whitespace before `rm` would be, so nothing matches.
function unquote(line) {
  return line.replace(/['"]/g, ' ');
}

function maskQuoted(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      // A backslash escape inside double quotes hides two characters.
      if (ch === '\\' && quote === '"' && i + 1 < line.length) { out += 'xx'; i += 1; continue; }
      if (ch === quote) { quote = null; out += ch; continue; }
      out += 'x';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    out += ch;
  }
  return out;
}

// Split a command line into its separate commands. A safe-path decision must be
// made against the delete target itself, never against the whole line: a command
// like `cp x /tmp/y && rm -rf ~/live` mentions a disposable path but deletes
// something else entirely.
//
// Splitting runs over the masked line, so an operator inside quotes no longer
// splits a command in half. Each segment carries the original text alongside,
// because the masked copy is for matching and the original is what gets shown.
function segments(masked, original = masked) {
  const bounds = [];
  const operator = /&&|\|\||[;&|]/g;
  let last = 0;
  let hit;
  while ((hit = operator.exec(masked)) !== null) {
    bounds.push([last, hit.index]);
    last = hit.index + hit[0].length;
  }
  bounds.push([last, masked.length]);

  return bounds
    .map(([from, to]) => ({
      masked: masked.slice(from, to).trim(),
      source: original.slice(from, to).trim(),
    }))
    .filter((s) => s.masked);
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
//
// Tokens are found in the masked copy and then read back out of the original, so
// a quoted path containing spaces stays one target and is reported as it was
// typed rather than as the mask.
function deleteTargets(segment, source = segment) {
  const tokens = [];
  const word = /\S+/g;
  let hit;
  while ((hit = word.exec(segment)) !== null) {
    tokens.push({ text: hit[0], start: hit.index, end: hit.index + hit[0].length });
  }

  const rmAt = tokens.findIndex((t) => t.text === 'rm');
  if (rmAt === -1) return [];

  const targets = [];
  for (let i = rmAt + 1; i < tokens.length; i++) {
    const token = tokens[i];
    // Flags are not targets.
    if (token.text.startsWith('-')) continue;
    // A bare redirection operator consumes the filename that follows it.
    if (/^\d*[<>]{1,2}$/.test(token.text)) { i += 1; continue; }
    // An attached redirection such as `2>/dev/null` or `>out.log` is plumbing.
    if (/^\d*[<>]/.test(token.text)) continue;
    // Strip a trailing attached redirection, e.g. `dir>out.log`.
    const cut = token.text.search(/\d*[<>]/);
    const end = cut > 0 ? token.start + cut : token.end;
    targets.push(source.slice(token.start, end).replace(/^['"]|['"]$/g, ''));
  }
  return targets;
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
  // Quoted text is only inert when nothing on the line will execute it.
  const masked = SHELL_INVOKERS.test(line) ? unquote(line) : maskQuoted(line);

  for (const { masked: segment, source } of segments(masked, line)) {
    if (isRecursiveForceDelete(segment)) {
      const targets = deleteTargets(segment, source);
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
          target: source,
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

module.exports = {
  checkCommand,
  isRecursiveForceDelete,
  deleteTargets,
  isDisposable,
  maskQuoted,
  unquote,
};
