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

// Tidies a path using only the text of it. Empty and `.` segments drop out, so
// `//build` and `/./build` become `/build`, and a `..` cancels the segment in
// front of it, so `dist/../../important` becomes `../important`.
//
// This resolves nothing on disk and follows no symlink. It cannot: the target
// of a delete frequently does not exist yet, which is why matching here works
// on the path as typed in the first place. Everything below is string work.
//
// The distinction that matters is where the `..` sits. After the disposable
// name it makes the match a lie, since `dist/../../important` opens with a
// disposable word and lands nowhere near it. Before the name it does not:
// `../node_modules` is still a node_modules, and someone clearing a sibling
// project's build output writes exactly that. Cancelling pairs gets both,
// where refusing anything containing a `..` got the second one wrong.
function lexicalPath(target) {
  const rooted = target.startsWith('/');
  const out = [];
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // A leading `..` has nothing to cancel and has to survive, or
      // `../node_modules` reads as `node_modules` and a different directory
      // gets waved through. Above the root there is nowhere to go, so there
      // it does drop.
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!rooted) out.push('..');
      continue;
    }
    out.push(segment);
  }
  return (rooted ? '/' : '') + out.join('/');
}

// A target is disposable if it is exactly the configured path, sits underneath
// it at a segment boundary, or contains it as a whole path segment. There is no
// bare substring case: matching on substring alone would let `/tmpfoo` pass as
// `/tmp` and `~/node_modules_backup` pass as `node_modules`.
function isDisposable(target, safePaths) {
  const normalized = lexicalPath(target);
  // `build/..` cancels down to nothing, and nothing is not a disposable path.
  if (!normalized || normalized === '/') return false;
  return safePaths.some((raw) => {
    const safe = lexicalPath(String(raw));
    if (!safe) return false;
    // An unanchored entry names a directory that appears inside a project, and
    // a top-level directory of the filesystem is not that. `/build` is not
    // somebody's build output, whatever it is called, and deleting the whole
    // of it should never be silent. Only the directory itself is withheld:
    // `/build/x` stays disposable, because a confirm verdict reaches the user
    // as an outright deny, so tightening past the catastrophic case would deny
    // real deletes on a machine that genuinely keeps a checkout up there.
    if (!safe.startsWith('/') && normalized === '/' + safe) return false;
    if (normalized === safe) return true;
    if (normalized.startsWith(safe + '/')) return true;
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

// `git commit`, with any option allowed to sit between the two words, so
// `git -C <path> commit` and `git --no-pager commit` both count.
const GIT_COMMIT = /(^|\s)git\s+(?:-[^\s]+(?:\s+[^\s-][^\s]*)?\s+)*commit(\s|$)/;

// --no-verify and its short form. `-n` is only read inside a segment already
// known to be a commit, because the same letter means something else on other
// subcommands: `git clean -n` is a dry run and is the safe way to run it, so a
// rule that fired on `-n` anywhere would flag the careful version of a command
// it flags the reckless version of. Bundled short flags count, since
// `git commit -an` is `--all --no-verify`.
const SKIPS_COMMIT_HOOKS = /(^|\s)(--no-verify|-[a-zA-Z]*n[a-zA-Z]*)(\s|$)/;

// Returns { verdict: 'allow' | 'confirm', reason, target }.
//
// Each family of rule reads its own switch, rather than the caller deciding
// whether to call this at all. That was the previous arrangement and it meant
// one setting governed two unrelated things: the hook only ran this when
// blockDestructiveCommands was on, so switching off noisy delete prompts also
// switched off the commit-hook rule, silently. A key that is absent counts as
// on, so a config naming one setting keeps the rest.
function checkCommand(command, config = {}) {
  const stopDeletes = config.blockDestructiveCommands !== false;
  const stopHookSkips = config.blockCommitHookSkip !== false;
  const safePaths = config.safeDeletePaths || [];
  const line = firstLineOf(command);
  // Quoted text is only inert when nothing on the line will execute it.
  const masked = SHELL_INVOKERS.test(line) ? unquote(line) : maskQuoted(line);

  for (const { masked: segment, source } of segments(masked, line)) {
    if (stopDeletes && isRecursiveForceDelete(segment)) {
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

    for (const entry of stopDeletes ? IRREVERSIBLE_GIT : []) {
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

    // Not on the list above, and deliberately not: nothing here is
    // irreversible, so the reflog advice attached to that list would be beside
    // the point. The reason to stop is a different one. Skipping the hooks
    // leaves a commit that looks exactly like one that passed them, so the
    // check is not recorded as having been waived anywhere, and a rule enforced
    // by a pre-commit hook stops being enforced by anything at all.
    if (stopHookSkips && GIT_COMMIT.test(segment) && SKIPS_COMMIT_HOOKS.test(segment)) {
      return {
        verdict: 'confirm',
        target: source,
        reason:
          `git commit --no-verify skips every pre-commit and commit-msg hook.\n\n` +
          `The commit that results is indistinguishable from one that passed them, ` +
          `so nothing downstream can tell the checks were not run. If a hook is ` +
          `failing, say which one and on what, then either fix the cause or turn ` +
          `that hook off on purpose. Going around it for one commit leaves the ` +
          `next person to find out the hard way.`,
      };
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
