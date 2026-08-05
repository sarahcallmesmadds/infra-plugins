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
  // `git clean` is not here. It needs the same reading as the commit rule,
  // because its dry run is spelled with a letter bundled in among the
  // destructive ones. See removesUntrackedFiles below.
  // `git push` and `git branch` are not here either, for the same reason as
  // clean: each has a spelling the regex missed. See below.
];

// Reading a git subcommand's own options. Four rules need this now, and each
// time one of them was written on its own it was written slightly differently
// and the difference was a hole. So it lives here once.
//
// Short options that carry their value attached to the letter, per subcommand.
// Everything after one of these inside the same token is data rather than more
// flags. Getting this wrong has gone both ways in this branch: `-uno` on a
// commit is `--untracked-files=no` and was read as a bundle containing `-n`,
// which refused an ordinary commit; `-enode_modules` on a clean is an exclude
// pattern and was read the same way, which cancelled the rule and let a real
// delete through unannounced. The second direction is the dangerous one.
const ATTACHED_VALUE = {
  commit: new Set(['m', 'c', 'C', 'F', 't', 'u', 'S']),
  clean: new Set(['e']),
  push: new Set(['o']),
  branch: new Set(['u']),
};

// The letters in a bundled short option that are actually flags. The first one
// that takes a value is still a flag, and everything after it is its value.
function flagLetters(token, attached) {
  const letters = [];
  for (const letter of token.slice(1)) {
    if (!/[A-Za-z]/.test(letter)) break;
    letters.push(letter);
    if (attached.has(letter)) break;
  }
  return letters;
}

// Every option token belonging to one git subcommand.
//
// Text that git never sees is removed first. A command substitution carries
// somebody else's flags, so the `-n` in `git commit -m $(head -n 1 msg.txt)`
// means "one line" to head. A trailing comment is a note to a reader. Both
// were handled on the commit rule and neither on the others, so `git clean
// -fd  # -n` read as a preview and deleted files with no warning.
//
// Only what follows the subcommand counts. Anything before it belongs to
// whatever is running it: `nice -n 10 git commit` sets a priority and
// `sudo -n git commit` means do not prompt.
function optionsAfter(segment, subcommand) {
  const own = segment
    .replace(/\$\([^)]*\)/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/(^|\s)#.*$/, '$1');

  const at = new RegExp(`(^|\\s)git\\s+(?:-[^\\s]+(?:\\s+[^\\s-][^\\s]*)?\\s+)*${subcommand}(\\s|$)`);
  const found = at.exec(own);
  if (!found) return null;

  const after = own.slice(found.index + found[0].length);
  return (after.match(/(?:^|\s)--?[A-Za-z][^\s]*/g) || []).map((raw) => raw.trim());
}

// Does this segment skip the commit hooks? A regex was tried and could not do
// it: `-[a-zA-Z]*n[a-zA-Z]*` matches any single-dash token containing an `n`,
// and once the attached values are accounted for there is not much of that
// pattern left standing.
function skipsCommitHooks(segment) {
  const options = optionsAfter(segment, 'commit');
  if (!options) return false;

  for (const token of options) {
    if (token === '--no-verify') return true;
    if (token.startsWith('--')) continue;
    if (flagLetters(token, ATTACHED_VALUE.commit).includes('n')) return true;
  }
  return false;
}

// Does this segment actually delete untracked files? The old rule was
// `git\s+clean\s+-[a-zA-Z]*[dfx]`, which asked only whether a destructive
// letter was present. `-n` is the dry run, and nobody types it alone: the
// useful preview is `git clean -nd` or `-ndx`, which name the very things
// being previewed. Both contain a `d`, so both were refused.
//
// That refusal landed on exactly the careful person the rule exists to help,
// the one checking what a delete would remove before running it, and a
// `confirm` reaches them as an outright deny. So the preview was blocked and
// the destructive form was one keystroke away.
function removesUntrackedFiles(segment) {
  const options = optionsAfter(segment, 'clean');
  if (!options) return false;

  let destructive = false;
  for (const token of options) {
    if (token === '--dry-run') return false;
    // `--force` is the long spelling of `-f` and the only long form among the
    // destructive options. Skipping every long token meant destructiveness was
    // decided from short letters alone, so `git clean --force` ran unannounced
    // while the identical `-f` was stopped. A rule that depends on which
    // spelling somebody happens to use is not a rule.
    if (token === '--force') { destructive = true; continue; }
    if (token.startsWith('--')) continue;

    const letters = flagLetters(token, ATTACHED_VALUE.clean);
    // A dry run anywhere in the command settles it, whatever else is asked
    // for. Nothing is deleted, so there is nothing to confirm.
    if (letters.includes('n')) return false;
    // `X` is uppercase and means "remove only the ignored files", which is
    // still removing files. Matching lowercase alone let it through.
    if (letters.some((l) => 'dfxX'.includes(l))) destructive = true;
  }
  return destructive;
}

// `git push -f` is the spelling most people type and it was allowed, while
// `--force` was stopped. The README advertised force pushes as blocked, so the
// guard was wrong in the direction that reads as working.
//
// `--force-with-lease` stays allowed, which is the whole point of it: it
// refuses to overwrite work you have not seen. A dry run is allowed for the
// same reason it is on clean, since nothing leaves the machine.
function forcePushes(segment) {
  const options = optionsAfter(segment, 'push');
  if (!options) return false;

  let forced = false;
  for (const token of options) {
    if (token === '--dry-run') return false;
    if (token === '--force') { forced = true; continue; }
    if (token.startsWith('--')) continue; // including --force-with-lease
    const letters = flagLetters(token, ATTACHED_VALUE.push);
    if (letters.includes('n')) return false; // -n is push's dry run
    if (letters.includes('f')) forced = true;
  }
  return forced;
}

// `-D` is the short way to write `--delete --force`, and only the short way
// was caught. A plain `-d` refuses to delete a branch holding unmerged work,
// so it is git's own guard doing its job and nothing here needs to fire.
function deletesUnmergedBranch(segment) {
  const options = optionsAfter(segment, 'branch');
  if (!options) return false;

  let deleting = false;
  let forcing = false;
  for (const token of options) {
    if (token === '--delete') { deleting = true; continue; }
    if (token === '--force') { forcing = true; continue; }
    if (token.startsWith('--')) continue;
    const letters = flagLetters(token, ATTACHED_VALUE.branch);
    if (letters.includes('D')) { deleting = true; forcing = true; }
    if (letters.includes('d')) deleting = true;
    if (letters.includes('f')) forcing = true;
  }
  return deleting && forcing;
}

// Returns { verdict: 'allow' | 'confirm', rule, reason, target }.
//
// This assesses. It does not decide policy, and it reads no on/off switch from
// the config, only safeDeletePaths. Both of those were tried and each was
// wrong in its own direction.
//
// Originally the hook decided whether to call this at all, gated on
// blockDestructiveCommands, which meant one setting silently governed two
// unrelated rules. Moving the switches in here fixed that and broke something
// quieter: cli.js calls this for `check --command`, which is the on-demand
// "is this safe" question behind the undo-possible skill and the whole Codex
// surface, where no hook can run. With the switch inside, somebody who had
// quietened the automatic prompts and then explicitly asked whether a delete
// was safe was told yes. An advisory that agrees with whatever you configured
// is not an advisory.
//
// So: always assess, and let the caller filter. `rules` names the families a
// caller cares about, and the default is all of them, so asking the question
// plainly gets the honest answer. Only bash-guard passes a filter, built from
// the config, because only bash-guard is the thing being switched off.
const ALL_RULES = ['destructive', 'commit-hook-skip'];

function checkCommand(command, config = {}, options = {}) {
  const rules = new Set(options.rules || ALL_RULES);
  const stopDeletes = rules.has('destructive');
  const stopHookSkips = rules.has('commit-hook-skip');
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
          rule: 'destructive',
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

    if (stopDeletes && removesUntrackedFiles(segment)) {
      return {
        verdict: 'confirm',
        rule: 'destructive',
        target: source,
        reason:
          `git clean removes untracked files permanently.\n\nConfirm this is ` +
          `intended before running it. Adding \`-n\` shows what it would remove ` +
          `without removing anything, which is the safer way to find out.`,
      };
    }

    if (stopDeletes && forcePushes(segment)) {
      return {
        verdict: 'confirm',
        rule: 'destructive',
        target: source,
        reason:
          `git push --force can overwrite a remote branch.\n\nConfirm this is ` +
          `intended before running it. \`--force-with-lease\` does the same job ` +
          `but refuses if somebody has pushed work you have not seen, which is ` +
          `the case a force push destroys.`,
      };
    }

    if (stopDeletes && deletesUnmergedBranch(segment)) {
      return {
        verdict: 'confirm',
        rule: 'destructive',
        target: source,
        reason:
          `This deletes a branch even if it was never merged.\n\nConfirm this ` +
          `is intended before running it. A plain \`-d\` deletes the branch only ` +
          `if its commits exist somewhere else, so it answers the question ` +
          `rather than assuming it.`,
      };
    }

    for (const entry of stopDeletes ? IRREVERSIBLE_GIT : []) {
      if (entry.re.test(segment)) {
        return {
          verdict: 'confirm',
          rule: 'destructive',
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
    if (stopHookSkips && skipsCommitHooks(segment)) {
      return {
        verdict: 'confirm',
        rule: 'commit-hook-skip',
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
  ALL_RULES,
  isRecursiveForceDelete,
  deleteTargets,
  isDisposable,
  maskQuoted,
  unquote,
};
