#!/usr/bin/env node
// SessionStart: state today's date, and say if another session is already
// working in this directory.
//
// Two jobs in one hook because they produce one injection between them. Two
// hooks would mean two blocks of context at the top of every session to say
// about three lines, and the whole argument for the date line is that it is
// cheap.
//
// ---------------------------------------------------------------------------
// Why this fires on every source, unlike the git-hygiene notice.
//
// That one speaks only on `startup` and `clear`, because a branch count
// re-injected on every resume is the same notice twice and it was already
// acted on or ignored the first time.
//
// These two do not behave that way.
//
//   `compact` replaces the conversation with a summary. Anything stated in
//   context and not repeated in that summary is gone, and the date is exactly
//   the kind of single line a summary drops. A long session that compacts twice
//   would spend its second half back on the training cutoff.
//
//   `resume` is the single most likely moment for a second session to exist,
//   since resuming is what you do when you already have one open somewhere.
//   Staying quiet there would skip the case the check is for.
//
// So both lines are re-stated. The cost is a sentence.

'use strict';

const path = require('path');

// The whole hook. This runs before the first prompt, so the budget is what a
// person will not notice, not what is technically survivable.
const BUDGET_MS = 1200;
const STDIN_WAIT_MS = 1000;

// Naming every overlapping session gets silly past a handful, and past a
// handful the count is the useful part anyway.
const MAX_NAMED = 4;

function describeAge(minutes) {
  if (minutes == null) return '';
  if (minutes < 1) return ' (just started)';
  if (minutes < 60) return ` (${minutes} min)`;
  const hours = Math.round(minutes / 60);
  return ` (${hours}h)`;
}

// The parallel-session sentence, or '' when there is nothing to say.
//
// Kept separate from the process work so the tests can drive every branch with
// plain objects. The branch that matters is the incomplete one: an empty
// overlap list means "none overlap" only when every directory was resolved.
function parallelLine(cwd, { sessions, complete }, { overlaps }) {
  if (!sessions.length) return '';

  const here = sessions.filter((s) => overlaps(cwd, s.cwd));
  const elsewhereCount = sessions.length - here.length;

  if (here.length) {
    const named = here.slice(0, MAX_NAMED)
      .map((s) => `${s.cwd}${describeAge(s.ageMinutes)}`)
      .join(', ');
    const more = here.length > MAX_NAMED ? `, and ${here.length - MAX_NAMED} more` : '';
    return `${here.length === 1 ? 'Another Claude Code session is' : `${here.length} other Claude Code sessions are`} `
      + `already live in this working directory: ${named}${more}. `
      + 'Edits made here can be overwritten by that session, and it will not see changes made in this one. '
      + 'Say so before writing to a shared file, and prefer a branch or a separate directory over '
      + 'both sessions editing the same tree.';
  }

  // No overlap found. Whether that is worth stating depends entirely on whether
  // we actually looked everywhere.
  if (!complete) {
    // Some directories did not resolve, so "none overlap" is not a claim this
    // can make. Report only the count, which is still true.
    return `${sessions.length} other Claude Code session${sessions.length === 1 ? ' is' : 's are'} `
      + 'running on this machine. Their working directories could not all be read, so whether any of '
      + 'them shares this one is unknown.';
  }

  if (!elsewhereCount) return '';
  return `${elsewhereCount} other Claude Code session${elsewhereCount === 1 ? '' : 's'} `
    + `running elsewhere on this machine, none in this directory.`;
}

// Kick the tool-health probe off and walk away.
//
// `claude mcp list` contacts every configured server and takes seconds, so it
// cannot run inline here: this hook is in front of the first prompt, and its
// whole budget is about a second. It is spawned detached and unref'd instead,
// so this process exits immediately and the refresh finishes on its own.
//
// That means the status line shows the previous session's answer for the first
// few seconds of this one, which is why the cache carries its age and the
// segment says so once it gets old. A number with no age is the failure mode
// worth avoiding here, not a number that is thirty seconds behind.
//
// Nothing is reported to the model about this. It is housekeeping, it can fail
// for ordinary reasons, and a line at the top of every session explaining that
// a cache refresh was attempted is precisely the noise that gets a plugin
// uninstalled.
function kickHealthRefresh() {
  try {
    const config = require(path.join(__dirname, '..', 'scripts', 'config.js')).load();
    if (!config.coreTools.length) return;

    const health = require(path.join(__dirname, '..', 'scripts', 'mcp-health.js'));
    if (!health.isStale(health.readCache(), config.healthMaxAgeMinutes)) return;

    const { spawn } = require('child_process');
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'cli.js'), 'mcp-refresh'],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch (_) {
    // Housekeeping. It is never worth a word.
  }
}

function main(event) {
  const { todayLine } = require(path.join(__dirname, '..', 'scripts', 'today.js'));
  const sessionsMod = require(path.join(__dirname, '..', 'scripts', 'sessions.js'));

  kickHealthRefresh();

  const parts = [todayLine(new Date())];

  const live = sessionsMod.liveSessions({
    selfSessionId: event && event.session_id,
    deadline: started + BUDGET_MS,
  });

  const parallel = parallelLine((event && event.cwd) || process.cwd(), live, sessionsMod);
  if (parallel) parts.push(parallel);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: parts.join('\n\n'),
    },
  }));
}

const started = Date.now();

// Only when run as a hook. Requiring this file from a test must not attach a
// stdin listener, or the test hangs waiting for input that never comes, which
// looks exactly like a slow test rather than like a mistake.
function run() {
  // Covers the wait for stdin, which is the only genuinely idle stretch here
  // and so the only one a timer can actually interrupt.
  const stdinTimer = setTimeout(() => process.exit(0), STDIN_WAIT_MS);

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buffer += c; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    clearTimeout(stdinTimer);
    try {
      main(buffer ? JSON.parse(buffer) : {});
    } catch (_) {
      // A broken convenience notice must never be a broken session start.
    }
    process.exit(0);
  });
}

if (require.main === module) run();

module.exports = { parallelLine, describeAge };
