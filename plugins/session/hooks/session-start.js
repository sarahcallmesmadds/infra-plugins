#!/usr/bin/env node
// SessionStart: state today's date, surface the build loop, and say if another
// session is already working in this directory.
//
// These jobs share one hook because they produce one opening injection between
// them. Separate hooks would mean several blocks of context at the top of every
// session for information that is useful together, and the whole argument for
// the date line and brief is that they are cheap.
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

// The session scan gets a share of the budget rather than all of it.
//
// Both stages take the same absolute deadline, so whatever the first one spends
// comes out of the second. That part is deliberate: the number a person notices
// is the total delay before their first prompt, not how fairly it was divided,
// and giving each stage its own full budget would let the hook take twice as
// long as the number above says.
//
// The problem is what the git scan then reports. `liveSessions` reads the
// process table, which is the one call here whose cost depends on the machine
// rather than on this code. Where it ran long enough to exhaust the budget, the
// git scan discovered nothing, returned `complete: false`, and the hook said
// "some repositories could not be checked" about a scan that had not checked
// any. True, useless, and identical to a real partial scan.
//
// So cap the first stage. The git scan keeps the same absolute deadline and is
// therefore guaranteed the remainder, and the total is still bounded by
// BUDGET_MS. When `liveSessions` returns early, which is the normal case at
// around a tenth of its cap, the git scan still gets everything left over.
const SESSIONS_BUDGET_MS = Math.round(BUDGET_MS * 0.6);
// The local-state brief runs after the process scan, so it cannot consume the
// session scan's share. Give it one tenth of the total before git activity gets
// the remaining three tenths. A section that cannot finish is omitted rather
// than publishing a partial count; a partial DEPS scan says it was incomplete.
const BRIEF_DEADLINE_MS = Math.round(BUDGET_MS * 0.7);

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

// Work left behind in a repository, which no live process will report.
//
// Deliberately quiet about the current repository's own uncommitted changes:
// you are about to work in it, you can see them, and mentioning them at the top
// of every session in a repo you are mid-change on is the fastest way to teach
// somebody to skip this whole notice.
//
// What is worth saying is activity somewhere else, because that is the part you
// cannot see from here.
function gitActivityLine(cwd, deadline) {
  try {
    const config = require(path.join(__dirname, '..', 'scripts', 'config.js')).load();
    if (config.gitActivity && config.gitActivity.enabled === false) return '';

    const ga = require(path.join(__dirname, '..', 'scripts', 'git-activity.js'));
    const here = ga.findRepoRoot(cwd);
    const { notable, complete } = ga.scan({ cwd, config: config.gitActivity, deadline });

    const elsewhere = notable.filter((r) => r.repo !== here);

    // Nothing found is two answers, and only one of them is good news.
    //
    // This returned '' the moment the list was empty, without ever consulting
    // `complete`, so a scan the deadline cut short reported exactly what a
    // clean machine reports. That is the failure this module's own header
    // warns about, in the one place that reads it, and `parallelLine` sitting
    // directly above already handles the same case correctly.
    //
    // Sixth instance of this shape in this plugin. It is not carelessness about
    // the logic; the flag was computed, threaded through, and documented. It is
    // that the early return is written before the caveat, and an early return
    // is easy to read as "nothing to say" when it means "nothing found so far".
    // No command is named here on purpose. This said "Run /sessions", and there
    // is no such skill in this plugin or anywhere else. There is a `sessions`
    // subcommand on the CLI, which is presumably where the name came from, but
    // the model has no path to it and cannot invoke a subcommand as a slash
    // command. So the one actionable sentence in the notice pointed at nothing.
    //
    // A notice that ends in an instruction that fails is worse than one that
    // ends without an instruction, because the failure is what gets remembered
    // about the notice.
    if (!elsewhere.length) {
      if (complete) return '';
      return 'Some repositories could not be checked before the session-start budget ran out, '
        + 'so whether anything was left uncommitted elsewhere is unknown. '
        + 'Check by hand if that matters.';
    }

    const described = elsewhere.slice(0, 3).map((r) => {
      const bits = [];
      if (r.changed) bits.push(`${r.changed} uncommitted`);
      if (r.commits && r.commits.length) bits.push(`${r.commits.length} recent commit${r.commits.length === 1 ? '' : 's'}`);
      return `${r.name}${r.branch ? ` on ${r.branch}` : ''}: ${bits.join(', ')}`;
    }).join('; ');

    const more = elsewhere.length > 3 ? `, and ${elsewhere.length - 3} more` : '';
    const caveat = complete ? '' : ' Not every repository was checked, so there may be more.';

    return `Recent work sits in ${elsewhere.length} other repositor${elsewhere.length === 1 ? 'y' : 'ies'}: `
      + `${described}${more}.${caveat} `
      + 'Mentioned in case it belongs to something still in progress. Nothing here needs doing.';
  } catch (_) {
    return '';
  }
}

function main(event) {
  const { todayLine } = require(path.join(__dirname, '..', 'scripts', 'today.js'));
  const sessionsMod = require(path.join(__dirname, '..', 'scripts', 'sessions.js'));
  const brief = require(path.join(__dirname, '..', 'scripts', 'build-loop-brief.js'));

  kickHealthRefresh();

  const parts = [todayLine(new Date())];

  const live = sessionsMod.liveSessions({
    selfSessionId: event && event.session_id,
    deadline: started + SESSIONS_BUDGET_MS,
  });

  const cwd = (event && event.cwd) || process.cwd();
  const parallel = parallelLine(cwd, live, sessionsMod);
  if (parallel) parts.push(parallel);

  const openingBrief = brief.buildBrief({
    deadline: started + BRIEF_DEADLINE_MS,
    // The queue counts are short enough to restate. The weekly report is an
    // opening orientation, not another 2,000 characters on compact or resume.
    includeSummary: event && event.source === 'startup',
  });
  if (openingBrief) parts.push(openingBrief);

  const activity = gitActivityLine(cwd, started + BUDGET_MS);
  if (activity) parts.push(activity);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: brief.joinContext(parts),
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

module.exports = { parallelLine, describeAge, gitActivityLine };
