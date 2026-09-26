#!/usr/bin/env node
// The command behind the session skills.
//
// Usage:
//   cli.js sessions              live Claude Code sessions, this one excluded
//   cli.js today                 the date line the session hook injects
//   cli.js archive [--days N] [--dry-run]
//                                sweep stale handoffs into archived/
//   cli.js reconcile [--fix]     what the folder holds against what the index says
//   cli.js find <slug>           locate the handoff a slug refers to
//   cli.js forget <slug>         drop an index entry, leaving the document
//   cli.js recent                the newest handoffs, for the pickup menu
//   cli.js target [topic]        where wrap should write from here
//   cli.js constraints           what earlier handoffs say is still binding here
//   cli.js constraints --thread <slug>
//                                the rules one thread binds, from its own file
//   cli.js capabilities          what this copy of the scripts can do
//   cli.js threads               the declared threads, for wrap to pick from
//   cli.js save --thread <slug> --from <draft> --base <rev|none> --generation N [--create]
//                                the only way a thread's handoff is written
//   cli.js declare <slug>        add an existing home handoff to the thread list
//   cli.js migrate plan --threads a,b [--out plan.json]
//   cli.js migrate apply <plan.json> --accept-narrowing --confirm-sessions-restarted
//   cli.js migrate finish        write what an interrupted apply left pending
//   cli.js memory                the memory directory for this project, if any
//   cli.js memory-check          is that directory still worth loading
//   cli.js mcp-probe             transition-only core-tools monitor
//
// Common flags:
//   --json                       machine-readable output
//   --cwd <path>                 pretend to be somewhere else (tests)
//   --home <path>                pretend home is somewhere else (tests)
//
// This is what the skills run and what the tests run. Every bug this repository
// has shipped so far lived in a printing path no test executed, so the tests
// drive this file rather than the functions underneath it.

'use strict';

const path = require('path');
const os = require('os');

const handoffs = require(path.join(__dirname, 'handoffs.js'));
const { todayLine } = require(path.join(__dirname, 'today.js'));
const sessionsMod = require(path.join(__dirname, 'sessions.js'));
const mcpHealth = require(path.join(__dirname, 'mcp-health.js'));
const configMod = require(path.join(__dirname, 'config.js'));
const memoryMod = require(path.join(__dirname, 'memory.js'));
const threadsMod = require(path.join(__dirname, 'threads.js'));
const registryMod = require(path.join(__dirname, 'registry.js'));

// What this copy of the scripts supports. The skills ask for this first and
// stop if it is missing, because the skill text and the scripts are installed
// as one plugin in each host but can still disagree: a session that loaded an
// older copy, or a host that has not updated yet. An older script prints its
// command list for an unknown command and exits 1, which no skill can mistake
// for this object.
const CAPABILITIES = { threads: 1 };

// Flags that take a value, and flags that stand alone. Anything else starting
// with `--` is an error rather than an argument.
//
// It used to be an argument. An unknown flag fell through into the positional
// list, so `constraints --thread site-thread` run against a copy that did not
// know `--thread` quietly answered a different question, the whole pool for the
// working directory, and printed it as if it were the thread's rules.
const VALUE_FLAGS = new Set(['--days', '--cwd', '--home', '--self', '--thread', '--from', '--base', '--generation', '--out', '--threads', '--file']);
const BOOL_FLAGS = new Set(['--json', '--dry-run', '--no-record', '--fix', '--create', '--accept-narrowing', '--confirm-sessions-restarted']);

function parseArgs(argv) {
  const out = {
    command: null, rest: [], json: false, dryRun: false, self: null, noRecord: false, fix: false,
    days: handoffs.DEFAULT_STALE_DAYS, cwd: process.cwd(), home: os.homedir(),
    thread: null, file: null, from: null, base: null, generation: null, out: null, threads: null,
    create: false, acceptNarrowing: false, sessionsRestarted: false, error: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) {
        const v = argv[i + 1];
        // An empty value is refused too: `--thread ""` would otherwise vanish
        // and answer for the directory the command ran in, the silent wrong
        // answer the flag exists to prevent.
        if (v === undefined || v === '' || v.startsWith('--')) { out.error = `${a} needs a value`; continue; }
        i += 1;
        if (a === '--days') out.days = parseInt(v, 10);
        else if (a === '--generation') out.generation = /^\d+$/.test(v) ? parseInt(v, 10) : NaN;
        else out[{ '--cwd': 'cwd', '--home': 'home', '--self': 'self', '--thread': 'thread', '--from': 'from', '--base': 'base', '--out': 'out', '--threads': 'threads', '--file': 'file' }[a]] = v;
      } else if (BOOL_FLAGS.has(a)) {
        if (a === '--json') out.json = true;
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--no-record') out.noRecord = true;
        else if (a === '--fix') out.fix = true;
        else if (a === '--create') out.create = true;
        else if (a === '--accept-narrowing') out.acceptNarrowing = true;
        else if (a === '--confirm-sessions-restarted') out.sessionsRestarted = true;
      } else {
        out.error = `unknown flag ${a}`;
      }
    } else if (!out.command) out.command = a;
    else out.rest.push(a);
  }
  if (!Number.isFinite(out.days) || out.days < 0) out.days = handoffs.DEFAULT_STALE_DAYS;
  return out;
}

function emit(opts, payload, lines) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

// The rules one thread binds, or why they cannot be given right now.
function printThreadConstraints(opts, t) {
  if (t.refused) process.exitCode = 1;
  if (opts.json) return emit(opts, t, []);
  if (t.refused === 'registry-invalid') {
    return emit(opts, {}, [`The thread list at ${t.path} cannot be read, so no thread's rules can be given:`, ...t.errors.map((e) => `  ${e}`)]);
  }
  if (t.refused === 'migration-unfinished') {
    const lines = [`A migration is part way through (${t.pendingTotal} rule${t.pendingTotal === 1 ? '' : 's'} still to write), so no thread's rules are given until it finishes.`,
      'Run: cli.js migrate finish'];
    if (t.pending && t.pending.length) {
      lines.push('', 'Still to be written into this thread:', ...t.pending.map((p) => `  ${p.kind === 'add' ? '+' : '-'} ${p.text}`));
    }
    return emit(opts, {}, lines);
  }
  if (t.refused === 'declared-no-directory') {
    return emit(opts, {}, [`${t.slug} is declared as a thread, and ${t.path} has no **Working directory:** line, so which scope it belongs to cannot be told. Restore that line.`]);
  }
  if (t.refused === 'declared-out-of-scope') {
    return emit(opts, {}, [`${t.slug} is declared as a thread, but ${t.path} says it was written outside the home directory. Its rules are not read as binding; fix the thread list.`]);
  }
  if (t.refused === 'declared-unreadable') {
    return emit(opts, {}, [`${t.slug} is declared at ${t.path}, and that file could not be read: ${t.detail}`]);
  }
  if (t.refused === 'declared-missing') {
    return emit(opts, {}, [`${t.slug} is declared at ${t.path}, and that file is not there.`]);
  }
  if (!t.binding) {
    return emit(opts, {}, [
      `${opts.thread} is not a declared thread${t.path ? ` (${t.kind}: ${t.path})` : ''}, so it binds nothing.`,
      'Run cli.js threads to see the threads.',
    ]);
  }
  const lines = [];
  for (const p of t.nearDuplicates || []) {
    lines.push('Two constraints look like one rule in two wordings, differing only here:',
      `  "${p.a.differs}"`, `  "${p.b.differs}"`,
      '  Retire one by deleting it and recording the retirement.', '');
  }
  if (!t.constraints.length) {
    lines.push(`No constraints recorded in ${t.slug} (${t.path}).`);
    return emit(opts, {}, lines);
  }
  lines.push(`${t.constraints.length} constraint${t.constraints.length === 1 ? '' : 's'} in force for thread ${t.slug}:`,
    ...t.constraints.map((c) => `  - ${c.text}`));
  return emit(opts, {}, lines);
}

const COMMANDS = {
  today(opts) {
    emit(opts, { line: todayLine(new Date()) }, [todayLine(new Date())]);
  },

  sessions(opts) {
    // Without this the command reports the session that ran it, which reads as
    // "another session is live here" and is the one answer guaranteed to be
    // wrong. The hook is handed an exact id by its event. There is no event
    // here, so the caller has to work it out.
    //
    // The process tree is the signal that carries the weight. This command was
    // spawned by a shell that was spawned by Claude Code, so the session that
    // launched it is always an ancestor, and finding it that way depends on
    // nothing being named anything in particular.
    //
    // The environment variables are kept as a cheap first answer. They were
    // checked in a node subprocess spawned exactly the way this one is, rather
    // than assumed from their names, but a variable name is still one release
    // away from changing, and the earlier version of this line rested the whole
    // answer on one.
    const { sessions, complete, identifiedSelf } = sessionsMod.liveSessions({
      selfSessionId: opts.self || process.env.CLAUDE_CODE_SESSION_ID,
      selfPids: [process.env.CLAUDE_PID, ...sessionsMod.ancestorPids()],
      deadline: Date.now() + 4000,
    });
    const rows = sessions.map((s) => ({
      ...s,
      overlapsHere: sessionsMod.overlaps(opts.cwd, s.cwd),
    }));

    if (opts.json) return emit(opts, { sessions: rows, complete, identifiedSelf }, []);

    // An empty list is two different answers and only one of them is good news.
    //
    // `liveSessions` returns no sessions both when nothing is running and when
    // reading the process table failed, and it sets `complete` to tell them
    // apart. The hook honours that. This branch did not: it printed a flat
    // all-clear the moment the list was empty, so a failed scan told someone
    // nothing else was running in a directory where something might well be.
    //
    // Third time this exact shape has been found in this plugin. The data
    // layer kept the distinction, the comment explaining it was accurate, and
    // the sentence a person actually reads threw it away. Checking that the
    // logic is right is not the same as checking that the output says what the
    // logic knows.
    if (!rows.length) {
      return emit(opts, {}, complete
        ? ['No other Claude Code sessions are running.']
        : ['Could not read the process table, so whether anything else is running is unknown.']);
    }
    const lines = rows.map((s) => {
      const where = s.cwd || 'working directory unknown';
      const age = s.ageMinutes == null ? '' : `, ${s.ageMinutes} min`;
      return `  ${s.overlapsHere ? '>' : ' '} ${where}${age}  (pid ${s.pid})`;
    });
    if (!complete) {
      lines.push('', 'Some working directories could not be read, so this list may be incomplete.');
    }
    // Say it rather than let the count quietly be one too high. A list headed
    // "other sessions" that silently includes this one is worse than no list.
    if (!identifiedSelf) {
      lines.push('', 'This session could not be identified, so one of the above is probably it.');
    }
    const heading = identifiedSelf
      ? `${rows.length} other session${rows.length === 1 ? '' : 's'} running:`
      : `${rows.length} session${rows.length === 1 ? '' : 's'} running:`;
    lines.unshift(heading, '');
    emit(opts, {}, lines);
  },

  archive(opts) {
    const result = handoffs.archiveStale({
      days: opts.days, home: opts.home, dryRun: opts.dryRun,
    });
    // Set before either output, so --json and text agree on success.
    if (result.refused) process.exitCode = 1;
    if (opts.json) return emit(opts, result, []);

    if (result.skipped) {
      return emit(opts, result, [`No handoffs directory at ${result.root}. Nothing to sweep.`]);
    }
    // Nothing moved in either case, and both say why rather than printing a
    // summary of a sweep that did not happen.
    if (result.refused) {
      return emit(opts, result, [`Sweep refused: ${result.refused}. Nothing moved.`]);
    }
    if (result.lockSkipped) {
      return emit(opts, result, [`Sweep skipped: ${result.lockSkipped}. Nothing moved; the next wrap will sweep.`]);
    }

    const verb = opts.dryRun ? 'Would archive' : 'Archived';
    const lines = result.moved.length
      ? [`${verb} ${result.moved.length}: ${result.moved.join(', ')}`]
      : [`Nothing untouched for ${opts.days} days. Nothing moved.`];

    // Said out loud rather than done quietly. The sweep now edits the index as
    // well as the folder, and a command that changes something it does not
    // mention is the shape of every bug in this plugin so far.
    const plural = (n) => (n === 1 ? 'entry' : 'entries');

    if (result.repointed.length) {
      const verb2 = opts.dryRun ? 'Would repoint' : 'Repointed';
      lines.push(`${verb2} ${result.repointed.length} index ${plural(result.repointed.length)} to the archive: `
        + result.repointed.map((r) => r.slug).join(', '));
    }
    if (result.pruned.length) {
      const would = opts.dryRun ? 'Would drop' : 'Dropped';
      lines.push(`${would} ${result.pruned.length} index ${plural(result.pruned.length)} pointing at files that are gone: `
        + result.pruned.map((p) => p.slug).join(', '));
    }
    // Spared, and worth saying, for the same reason as everything else here: a
    // sweep that quietly keeps something is as hard to trust as one that
    // quietly drops it. These are entries a wrap recorded minutes ago whose
    // document has not appeared yet, which is what a wrap in progress looks
    // like from outside.
    if (result.pending && result.pending.length) {
      const n = result.pending.length;
      lines.push(`Left ${n} index ${plural(n)} alone as too new to judge, because a wrap records where `
        + `it will write before it writes: ${result.pending.map((p) => p.slug).join(', ')}. `
        + 'They are dropped by a later sweep if the document never appears.');
    }
    // Kept, and worth saying. Silence here reads as "everything was checked",
    // when in fact one of these is a handoff whose disk was not mounted.
    if (result.unreachable.length) {
      const it = result.unreachable.length === 1 ? 'it' : 'them';
      // The remedy goes on the same line as the problem. `forget` is the only
      // thing that drops an index entry, so reporting the state without naming
      // it describes a situation with no way out. Conditioned on the directory
      // being gone for good, because the other reason one cannot be read is a
      // disk that is not mounted, and forgetting those loses a live handoff.
      const remedy = result.unreachable.length === 1
        ? ` If it is gone for good, run \`cli.js forget ${result.unreachable[0].slug}\` to drop the entry.`
        : ` If any are gone for good, run \`cli.js forget <slug>\` to drop them, for example \`cli.js forget ${result.unreachable[0].slug}\`.`;
      lines.push(`Left ${result.unreachable.length} index ${plural(result.unreachable.length)} alone, `
        + `because the directory holding ${it} could not be read: ${result.unreachable.map((u) => u.slug).join(', ')}.${remedy}`);
    }
    if (result.protectedSkipped && result.protectedSkipped.length) {
      lines.push(`Left ${result.protectedSkipped.length} protected handoff${result.protectedSkipped.length === 1 ? '' : 's'} where ${result.protectedSkipped.length === 1 ? 'it is' : 'they are'}.`);
    }
    if (result.collisions && result.collisions.length) {
      lines.push(`Did not move ${result.collisions.join(', ')}: a document with the same name is already in the archive. Which one to keep is a person's call.`);
    }
    // Last, and unmissable. Everything above this describes what was worked
    // out; this is whether any of it reached the disk.
    if (!result.indexWritten) {
      lines.push('', 'The index could not be written, so none of the index changes above actually happened.');
    }
    emit(opts, result, lines);
  },

  // Drop an index entry without touching the document it names.
  //
  // `target` adds entries and, until this existed, nothing removed one. An
  // entry whose project has since been deleted or moved stayed for good, and
  // clearing a single one meant hand-editing JSON.
  // Moves a project's index entry off a name a thread has taken. migrate plan
  // names this when a 0.8 index maps a thread's name to a project.
  rekey(opts) {
    const slug = opts.rest[0];
    if (!slug) {
      process.exitCode = 1;
      if (opts.json) return emit(opts, { rekeyed: false, reason: 'no slug given' }, []);
      return emit(opts, {}, ['Which one? Usage: cli.js rekey <slug>']);
    }
    const r = threadsMod.rekeyProject(slug, opts.home);
    if (!r.rekeyed) process.exitCode = 1;
    if (opts.json) return emit(opts, r, []);
    return emit(opts, {}, [r.rekeyed
      ? `Moved "${r.from}" to "${r.to}" for ${r.path}. Pick it up with /pickup ${r.to}.`
      : `Not moved: ${r.reason}.`]);
  },

  forget(opts) {
    const slug = opts.rest[0];
    if (!slug) {
      process.exitCode = 1;
      if (opts.json) return emit(opts, { removed: false, reason: 'no slug given' }, []);
      return emit(opts, {}, ['Which one? Usage: cli.js forget <slug>']);
    }

    const result = handoffs.forgetHandoff(slug, opts.home);
    // A refusal is not the same answer as "not in the index", so it exits
    // nonzero where "not in the index" does not.
    // So does a write that failed: it is not "not in the index" either.
    if (result.refused || result.reason === 'the index could not be written') process.exitCode = 1;
    if (opts.json) return emit(opts, result, []);

    if (!result.removed) {
      return emit(opts, {}, [`Nothing forgotten: ${result.reason} ("${slug}").`]);
    }
    const lines = [`Forgot "${result.slug}".`];
    // Which of these two it is decides whether anything was actually lost, so
    // it is not left for the reader to infer from silence.
    lines.push(result.fileStillThere
      ? `The handoff itself is untouched at ${result.entry.path}`
      : `It pointed at ${result.entry.path}, which is not there.`);
    emit(opts, {}, lines);
  },

  // What the handoffs folder holds, against what the index says about it.
  //
  // The index was only ever written forwards, so nothing checked it back
  // against the disk. Two sessions wrapping at once was one way it drifted and
  // is now locked; a hand repair is another, and the hand repair that fixed the
  // first drift left a duplicate entry behind on the same day.
  //
  // Leads with the findings that produce a wrong answer and ends with the one
  // that merely looks untidy, because the filed version of this bug had those
  // the other way round.
  reconcile(opts) {
    const result = opts.fix
      ? handoffs.applyReconcile({ home: opts.home })
      : handoffs.reconcileIndex({ home: opts.home });

    if (result.refused) process.exitCode = 1;
    if (opts.json) return emit(opts, result, []);
    if (result.refused) process.stdout.write(`Nothing recorded: ${result.refused}.\n\n`);

    const plural = (n, one, many) => (n === 1 ? one : many);
    const lines = [];

    // First, and the only finding here that makes a lookup lie. Everything
    // else on this report is untidiness.
    if (result.shadowed.length) {
      const n = result.shadowed.length;
      lines.push(`${n} ${plural(n, 'slug returns', 'slugs return')} the wrong handoff:`, '');
      for (const s of result.shadowed) {
        lines.push(`  ${s.slug}`);
        lines.push(`    /pickup opens ${s.recorded}`);
        lines.push(`    but ${s.doc} is the document named for that slug`);
        // The remedy has to work when it is run. Dropping the entry leaves the
        // search order to find the document beside it, which is what it was
        // doing before something recorded the other path.
        lines.push(`    If the second one is the one you want: cli.js forget ${s.slug}`);
        lines.push('');
      }
    }

    if (result.duplicates.length) {
      const n = result.duplicates.length;
      lines.push(`${n} ${plural(n, 'document has', 'documents have')} more than one slug recorded against ${plural(n, 'it', 'them')}:`, '');
      for (const d of result.duplicates) {
        lines.push(`  ${d.path}`);
        lines.push(`    ${d.slugs.join(', ')}`);
        lines.push(`    Drop whichever you do not want with cli.js forget <slug>`);
        lines.push('');
      }
    }

    if (result.superseded.length) {
      const n = result.superseded.length;
      lines.push(`${n} index ${plural(n, 'entry points', 'entries point')} at a document that is not there, `
        + `while the ${plural(n, 'one', 'ones')} named for that slug ${plural(n, 'is', 'are')} in this folder:`, '');
      for (const s of result.superseded) {
        // Not grouped with `shadowed` because the lookup already gives the right
        // answer: a recorded path that resolves to nothing is skipped and the
        // search order reaches the document. Only the entry is wrong.
        lines.push(`  ${s.slug}  (recorded ${s.recorded})`);
      }
      lines.push('', '  Lookups already reach the right document. Clear the dead entry with cli.js forget <slug>.', '');
    }

    // Spared, and said out loud, because the advice above is to delete an entry
    // and these are the two cases where deleting one loses something.
    //
    // A wrap notes where it will write before it writes, so an entry recorded
    // minutes ago whose document has not appeared is a handoff being written
    // right now, in another session. Reported without a remedy on purpose:
    // there is nothing to do but wait, and the only command that could be
    // offered here is the one that would destroy it.
    if (result.pending && result.pending.length) {
      const n = result.pending.length;
      lines.push(`${n} index ${plural(n, 'entry was', 'entries were')} recorded in the last few minutes, `
        + `naming ${plural(n, 'a document', 'documents')} that ${plural(n, 'has', 'have')} not appeared yet:`, '');
      for (const p of result.pending) lines.push(`  ${p.slug}  (recorded ${p.recorded})`);
      lines.push('', '  That is what a wrap in progress looks like from outside. Left alone, and not',
        '  reported as stale. If a wrap is running, let it finish.', '');
    }

    // The other one that must never be called dead. `existsSync` says false for
    // an external disk, a network share and a volume that is not mounted, and
    // nothing here can tell those from a deletion.
    if (result.unreachable && result.unreachable.length) {
      const n = result.unreachable.length;
      lines.push(`${n} index ${plural(n, 'entry names', 'entries name')} a path whose directory could not be read:`, '');
      for (const u of result.unreachable) lines.push(`  ${u.slug}  (recorded ${u.recorded})`);
      // The remedy is conditioned rather than offered flat, for the same reason
      // the sweep conditions its own: forgetting an entry whose volume is simply
      // not mounted loses a live handoff.
      lines.push('', '  Either the project moved, or its disk is not mounted, and this cannot tell which.',
        `  If ${plural(n, 'it is', 'they are')} gone for good: cli.js forget <slug>`, '');
    }

    // Last, and deliberately understated. A central document with no entry is
    // still found by name, because the search order looks in this folder before
    // it needs the index. This was filed as the headline symptom and measuring
    // it showed it is the mildest thing on the report.
    if (result.unlisted.length) {
      const n = result.unlisted.length;
      if (opts.fix) {
        const r = result.recorded.length;
        lines.push(`Recorded ${r} ${plural(r, 'entry', 'entries')} for ${plural(r, 'a document', 'documents')} that had none:`);
        for (const d of result.recorded) lines.push(`  ${d.slug}`);
        const skipped = n - r;
        if (skipped > 0 && !result.refused) {
          lines.push(`  ${skipped} ${plural(skipped, 'was', 'were')} recorded by something else while this ran, and left alone.`);
        }
        lines.push('');
      } else {
        lines.push(`${n} ${plural(n, 'document has', 'documents have')} no index entry:`, '');
        for (const d of result.unlisted) lines.push(`  ${d.slug}${d.archived ? '  (archived)' : ''}`);
        lines.push('', `  These are still found by name, because /pickup looks in this folder before it`,
          '  needs the index. Recording them costs nothing: cli.js reconcile --fix', '');
      }
    }

    // Pending and unreachable count as findings for this line even though
    // nothing is wrong with either. Printing "the index and the folder agree"
    // above a list of entries this run refused to judge would be the same fault
    // as any other summary that claims more than it checked.
    const clean = !result.shadowed.length && !result.duplicates.length
      && !result.superseded.length && !result.unlisted.length
      && !(result.pending || []).length && !(result.unreachable || []).length;
    if (clean) lines.push('The index and the folder agree.', '');

    // What was looked at, said on every run rather than only when something is
    // wrong. A clean result above means nothing without it: the shapes this
    // does not scan would look exactly this clean.
    lines.push(`Checked ${result.scanned} HANDOFF-*.md ${plural(result.scanned, 'document', 'documents')} in ${result.root} `
      + `and its archive, against ${result.entries} index ${plural(result.entries, 'entry', 'entries')}.`);
    lines.push('Not checked: pause documents, which are never indexed, and handoffs kept beside their');
    lines.push('work, which this cannot enumerate because the index is the only record of where they are.');
    // The count above is what the check ran against, which is the count before
    // anything was recorded. Left as the count checked rather than updated,
    // because that is what the sentence claims, and said plainly here so it
    // cannot be read as the current total.
    if (opts.fix && result.recorded.length) {
      lines.push(`The index now holds ${result.entries + result.recorded.length}.`);
    }

    // Last line, and unmissable, for the same reason the sweep prints one.
    // Everything above says what was worked out. This says whether it landed.
    if (opts.fix && !result.written) {
      process.exitCode = 1;
      lines.push('', 'The index could not be written, so nothing above was actually recorded.');
    }
    emit(opts, result, lines);
  },

  find(opts) {
    const slug = opts.rest[0];
    if (!slug) {
      process.exitCode = 1;
      if (opts.json) return emit(opts, { error: 'no slug given', match: null }, []);
      return emit(opts, {}, ['Which one? Usage: cli.js find <slug>']);
    }
    // A declared thread is answered from the thread list, which is the
    // authority for it; the index and the search order only ever guessed.
    const resolved = threadsMod.resolve(slug, opts.home);
    let match = handoffs.findHandoff(slug, opts.home);
    if (resolved.kind === 'thread') {
      let mtime = null;
      // lstat, so a link whose target is gone stays "there and unreadable".
      try { mtime = require('fs').lstatSync(resolved.path).mtimeMs; } catch (_) { resolved.exists = false; }
      match = resolved.exists ? { path: resolved.path, kind: 'thread', mtime } : null;
    } else if (match && resolved.kind === 'history') {
      match = { ...match, history: true };
    }
    const stale = match || resolved.kind === 'thread' ? null : handoffs.staleRecord(slug, opts.home);
    // A broken thread list only makes the answer uncertain for something that
    // could be a thread: a project handoff never is.
    const listUncertain = resolved.mode === 'invalid'
      && (!match || threadsMod.couldBeThread(match.path, opts.home)
        || threadsMod.slugCouldBeThread(slug, opts.home));
    // There and unreadable exits non-zero for any kind, as every other
    // "found but cannot be read" answer here does.
    if ((resolved.kind === 'thread' && (!resolved.exists || resolved.unreadable)) || listUncertain
      || (resolved.kind !== 'thread' && match && resolved.unreadable)) process.exitCode = 1;
    if (opts.json) {
      return emit(opts, {
        slug,
        match,
        stale,
        tried: handoffs.searchPaths(slug, opts.home),
        mode: resolved.mode,
        registryErrors: resolved.mode === 'invalid' ? resolved.errors : [],
        listUncertain,
        unreadable: resolved.kind !== 'thread' && resolved.unreadable ? resolved.unreadable : null,
        thread: resolved.kind === 'thread'
          ? {
            slug: resolved.slug, path: resolved.path, exists: resolved.exists, unreadable: resolved.unreadable,
            rev: resolved.rev, generation: resolved.generation, conflicts: resolved.conflicts,
          }
          : null,
      }, []);
    }
    if (resolved.kind === 'thread' && !resolved.exists) {
      return emit(opts, {}, [
        `${resolved.slug} is a declared thread, and its file ${resolved.path} is not there.`,
        ...(resolved.conflicts || []).map((c) => `The index also gives this slug to ${c.indexed}.`),
      ]);
    }
    if (match) {
      const age = Math.round((Date.now() - match.mtime) / 86400000);
      const lines = [
        `${match.path}`,
        `  kind: ${match.kind}, last touched ${age} day${age === 1 ? '' : 's'} ago`,
      ];
      if (match.history) lines.push('  Kept as history: threads are set up, and this handoff is not one, so it binds nothing.');
      if (resolved.kind === 'thread' && resolved.unreadable) {
        lines.push('  This thread\'s file is there and cannot be read, so it cannot be picked up or saved.');
      } else if (resolved.unreadable) {
        lines.push(`  This handoff is there and cannot be read: ${resolved.unreadable}`);
      }
      if (listUncertain) lines.push('  The thread list cannot be read, so whether this is a declared thread is unknown.');
      for (const c of resolved.conflicts || []) lines.push(`  Conflict: the index also gives this slug to ${c.indexed}.`);
      return emit(opts, {}, lines);
    }
    // A stale entry and no entry at all produced the same message, so a moved
    // project read as a handoff that never existed. The recorded path is the one
    // fact worth having here, because it says where to look.
    const lines = [`No handoff found for "${slug}".`];
    if (listUncertain) lines.push('The thread list cannot be read, so a declared thread by this name cannot be ruled out.');
    if (stale) {
      // `unreachable` cannot tell a moved project from an unmounted volume, so
      // it names both rather than implying the one that happens to be rarer.
      // A moved repo lands here, not in `gone`, because its whole directory went
      // with it.
      // Three states, three answers. `pending` used to fall into the `gone`
      // branch and report a handoff as deleted when it had simply not been
      // written yet, which is the same fault as any other message that says
      // what did not happen.
      if (stale.state === 'unreachable') {
        lines.push(`The index points at ${stale.path}, and its directory is not there either. Either the project moved, in which case add its new parent to projectRoots, or it is on a volume that is not mounted, in which case the handoff is fine and this will find it once the volume is back.`);
      } else if (stale.state === 'pending') {
        lines.push(`The index points at ${stale.path}, which was recorded in the last few minutes and is not there yet. A wrap notes where it will write before it writes, so this is what one looks like in progress. If a wrap is running, let it finish and try again.`);
      } else {
        lines.push(`The index points at ${stale.path}, which is gone. The directory is still there, so the handoff itself was deleted or renamed rather than moved with the project.`);
      }
    }
    const roots = handoffs.projectRoots(opts.home).length;
    lines.push(`Searched ${roots} project root${roots === 1 ? '' : 's'}. Looked at:`);
    lines.push(...handoffs.searchPaths(slug, opts.home).map((c) => `  ${c.path}`));
    emit(opts, {}, lines);
  },

  recent(opts) {
    const rows = handoffs.recentHandoffs({ home: opts.home });
    if (opts.json) return emit(opts, { handoffs: rows }, []);
    if (!rows.length) return emit(opts, {}, ['No handoffs yet.']);
    emit(opts, {}, rows.map((r) => {
      const age = Math.round((Date.now() - r.mtime) / 86400000);
      return `  ${r.slug}${r.archived ? ' (archived)' : ''}  ${age}d  ${r.path}`;
    }));
  },

  // What earlier handoffs for this same project say is still binding.
  //
  // Wrap calls this before writing, so a constraint recorded once keeps being
  // recorded until something retires it on purpose. Without it a constraint
  // survives exactly as long as nobody starts a new thread of work: the
  // an approved design system was named in one day's handoff, the handoff
  // three days later for the same repository never mentioned it, and every
  // pickup after that began with the governing document invisible.
  //
  // Scope is the repository rather than the directory, so a worktree inherits
  // from its main checkout. That specific mismatch is what hid it.
  constraints(opts) {
    // A handoff named by its file, which is how /wrap ends for a project whose
    // name belongs to a thread. The Working directory is parsed here, never
    // pasted into --cwd by the skill: a pasted `~/...` or a line carrying a
    // note such as "(git worktree of ...)" names no real folder and answered
    // with an empty list that read exactly like a first wrap.
    if (opts.file) {
      const fsMod = require('fs');
      const fail = (why) => {
        process.exitCode = 1;
        return emit(opts, { error: why, constraints: [] }, [`Cannot say what binds ${opts.file}: ${why}.`]);
      };
      if (opts.thread) return fail('give --file or --thread, not both');
      const file = opts.file === '~' || opts.file.startsWith('~/') ? path.join(opts.home, opts.file.slice(2)) : opts.file;
      let text;
      try { text = fsMod.readFileSync(file, 'utf8'); } catch (e) { return fail(`it could not be read: ${e.message}`); }
      // A central handoff, which may be a thread, is answered by its name so a
      // thread gets its own rules rather than the home pool as history, but
      // only when that name leads back to this same file. The index can map
      // the name to another document, and a symlink's own name can be another
      // thread's; answering by name then answered for a file nobody named.
      // Both spellings are tried, the target's first so a link inside the
      // folder with a name of its own still answers as the thread it points
      // at, then the link's, slugified.
      const byName = threadsMod.threadShaped(file, opts.home)
        && [handoffs.resolvePath(file), file]
          .map((p) => handoffs.slugify(path.basename(p).replace(/^HANDOFF-/, '').replace(/\.md$/, '')))
          .find((name) => {
            const r = threadsMod.resolve(name, opts.home);
            return r.path && handoffs.resolvePath(r.path) === handoffs.resolvePath(file);
          });
      if (byName) {
        opts.thread = byName;
      } else {
        const dir = handoffs.handoffDir(text);
        if (!dir) return fail('it has no **Working directory:** line');
        // The pool for the file's own Working directory, the same answer
        // --cwd gives for it. The file itself is not added: it is in the pool
        // already when the index lists it, and adding one the index does not
        // list let a stale worktree copy bring back a retired rule.
        opts.cwd = dir;
      }
    }
    if (opts.thread) {
      const t = threadsMod.threadConstraints({ slug: opts.thread, home: opts.home });
      // Before migration, and for any handoff outside the home scope after it,
      // the answer is the older pool for the handoff's own working directory,
      // exactly as 0.8. Anything else is a thread, history, or a refusal.
      if (t.mode !== 'pre-migration' && t.mode !== 'pooled') return printThreadConstraints(opts, t);
      // Never the directory this command happens to run in. Answering for that
      // instead of the named handoff is the silent wrong answer --thread exists
      // to prevent, so a handoff that cannot be found, or names no working
      // directory, is said out loud.
      let dir = t.dir || null;
      let unreadable = t.unreadable || null;
      const found = handoffs.findHandoff(opts.thread, opts.home);
      if (!dir && found) {
        try { dir = handoffs.handoffDir(require('fs').readFileSync(found.path, 'utf8')); } catch (e) { unreadable = e.message; }
      }
      if (!found || !dir) {
        process.exitCode = 1;
        let why = !found ? `no handoff found for "${opts.thread}"` : `${found.path} has no **Working directory:** line`;
        if (found && unreadable) why = `${found.path} could not be read: ${unreadable}`;
        return emit(opts, { error: why, constraints: [] }, [`Cannot say what binds ${opts.thread}: ${why}.`]);
      }
      opts.cwd = dir;
    }
    const r = handoffs.carriedConstraints({ cwd: opts.cwd, home: opts.home });
    // With the thread list unreadable, a pool sharing home's scope may hold
    // every thread's rules, and which of them bind cannot be told. Refused
    // rather than listed: a warning above a confident list is carried anyway.
    // Other scopes never held a thread and are answered as usual.
    if (r.registry === 'invalid' && r.homeScope) {
      process.exitCode = 1;
      const why = `the thread list ${registryMod.registryPath(opts.home)} cannot be read, so which rules bind this folder cannot be told; fix it first`;
      return emit(opts, { error: why, refused: 'registry-invalid', constraints: [] }, [`Cannot say what binds ${opts.cwd}: ${why}.`]);
    }
    // After migration the home pool is history. Every home thread binds only
    // its own file, so this list is shown for reference and says so first.
    const reg = registryMod.readRegistry(opts.home);
    r.binding = !(reg.state === 'ok' && r.home);
    if (opts.json) return emit(opts, r, []);
    if (!r.binding) {
      process.stdout.write('History, not binding: home threads each bind only their own file. '
        + 'Use constraints --thread <slug> for a thread\'s rules.\n\n');
    }
    if (r.registry === 'invalid') {
      // Only reached outside home's scope, which the refusal above covers, and
      // a thread's document always names home, so none is in this list.
      process.stdout.write('The thread list cannot be read. This folder is outside the home directory\'s scope, '
        + 'so no thread\'s rules are in this list, but fix ~/.planning/handoffs/threads.json before relying on any thread answer.\n\n');
    }

    // Anything that makes the answer less than complete is said before the
    // answer, never after it. A truncated scan and a retirement that hit
    // nothing both mean the list below may be wrong, and a caveat printed
    // underneath a confident list is one nobody reads.
    const warnings = [];
    if (r.gitDegraded) {
      warnings.push(
        r.gitDegraded === 'timeout'
          ? 'A git probe timed out, so scope fell back to comparing directory paths.'
          : 'git could not be run, so scope fell back to comparing directory paths.',
        '  A worktree will not be grouped with its main checkout, and constraints',
        '  recorded from one may be missing below.',
        r.gitDegraded === 'timeout'
          ? '  Usually a recorded path on a volume that is not mounted.'
          : '',
        '',
      );
    }
    if (r.truncated) {
      warnings.push(
        `Scan hit its ceiling of ${handoffs.CONSTRAINT_SCAN_CAP} handoffs, so an older one may not have been read.`,
        'Treat the list below as incomplete.',
        '',
      );
    }
    // Listed and unreadable is not the same as holding nothing, and a list
    // printed without saying so reads as complete.
    if (r.unreadable && r.unreadable.length) {
      warnings.push(
        `${r.unreadable.length} handoff${r.unreadable.length === 1 ? '' : 's'} could not be read, so any rules in ${r.unreadable.length === 1 ? 'it' : 'them'} are missing below:`,
        ...r.unreadable.map((u) => `  ${u}`),
        '',
      );
    }
    for (const u of r.unmatchedRetirements) {
      warnings.push(
        `"${u.text}" in ${u.from} retires something no handoff records, so it retires nothing.`,
        '  Usually a mistyped quote. The constraint has to be repeated exactly as it was written.',
        '',
      );
    }
    // Said before the list for the same reason as the others: two wordings of
    // one rule make the list below longer than the number of rules in it, and a
    // caveat printed underneath is one nobody reads.
    //
    // It names what differs rather than printing both constraints in full. The
    // pair is nearly identical by definition, so two near-identical paragraphs
    // is the least readable way to show a difference of one word.
    for (const p of r.nearDuplicates || []) {
      warnings.push(
        'Two constraints look like one rule in two wordings, differing only here:',
        `  "${p.a.differs}"  (from ${p.a.from})`,
        `  "${p.b.differs}"  (from ${p.b.from})`,
        '  Both are live, so retiring one by quoting it leaves the other in force.',
        '  A constraint holds nothing that changes between sessions: no count, no date.',
        '',
      );
    }

    if (!r.constraints.length) {
      const matched = r.scanned.filter((s) => s.matched);
      // Two different answers, and only one of them is about this project.
      // Printing a colon and then no list, followed by a sentence about "those",
      // was the same defect as everything else fixed on this branch: output that
      // reads as complete while describing nothing.
      const tail = matched.length
        ? [
          `  ${matched.length} of ${r.scanned.length} handoffs scanned belong to this project:`,
          ...matched.map((s) => `    ${s.slug}`),
          '  If one of those carries a binding constraint in prose, record it in the',
          '  next handoff under "## Constraints still in force".',
        ]
        : [
          `  None of the ${r.scanned.length} handoffs scanned belong to this project, so there was`,
          '  nothing to inherit from. This is expected for the first wrap here.',
        ];
      return emit(opts, {}, [...warnings, `No constraints recorded yet for ${r.scope}.`, ...tail]);
    }
    emit(opts, {}, [
      ...warnings,
      `${r.constraints.length} constraint${r.constraints.length === 1 ? '' : 's'} still in force for ${r.scope}:`,
      ...r.constraints.map((c) => `  - ${c.text}\n      (from ${c.from})`),
    ]);
  },

  // Where wrap should write, and a note of it so pickup can find it later.
  //
  // The recording happens here, before the file exists, because this is the
  // only moment anything knows both the slug and the path. A project handoff
  // goes next to the work and the work can be anywhere, so nothing downstream
  // can reconstruct that path from the slug. The previous version guessed
  // `~/Projects/<slug>` and silently failed for every repository kept
  // somewhere else.
  //
  // Recording an intent that is never fulfilled is harmless: every lookup
  // checks the file is actually there.
  target(opts) {
    const t = handoffs.writeTarget(opts.cwd, opts.rest.join(' '), opts.home);
    // Two paths this never hands out, because the next thing a wrap does with
    // it is write there directly: a protected handoff, and a declared thread,
    // which is only ever written through `save`.
    const protection = configMod.loadProtection(opts.home);
    const reg = registryMod.readRegistry(opts.home);
    // Project handoffs are never threads and are handed out as before. A
    // central path is refused whenever it could involve a thread: while the
    // thread list is broken (which paths are declared cannot be read), when
    // the session is in the home directory (home handoffs are saved as
    // threads), and when a file is already there that could be a thread or
    // home history (see couldBeThread; what cannot be told counts as home).
    const fsMod = require('fs');
    const central = t.kind === 'central';
    const homeCwd = central && threadsMod.isHomeDir(opts.cwd, opts.home);
    const existingMaybeThread = central && fsMod.existsSync(t.path) && threadsMod.couldBeThread(t.path, opts.home);
    let linkedCentral = false;
    let linkedIntoHandoffs = false;
    try {
      if (fsMod.lstatSync(t.path).isSymbolicLink()) {
        linkedCentral = central;
        // A project HANDOFF.md linked to a file elsewhere is a legitimate
        // shared setup; linked into the handoffs folder, the wrap would write
        // over a thread or a history document.
        // Judged on the link's own target as well as its real path: a link to
        // a thread file that is not there yet has no real path, and the wrap
        // would then create the thread's file directly, skipping save.
        const roots = [handoffs.resolvePath(handoffs.handoffRoot(opts.home)), path.resolve(handoffs.handoffRoot(opts.home))];
        // Every hop of the chain, since a link to a link to a missing thread
        // file got through when only the first hop was read.
        const spellings = [handoffs.resolvePath(t.path)];
        let hop = t.path;
        let unresolved = false;
        // Past the system's own limit of 40 resolutions nothing can open the
        // chain anyway, so one still a link after 64 hops is refused.
        for (let i = 0; ; i += 1) {
          let next;
          try {
            if (!fsMod.lstatSync(hop).isSymbolicLink()) break;
            if (i >= 64) { unresolved = true; break; }
            next = path.resolve(path.dirname(hop), fsMod.readlinkSync(hop));
          } catch (e) {
            if (e && e.code === 'ENOENT') break;
            unresolved = true;
            break;
          }
          spellings.push(next, handoffs.resolvePath(path.dirname(next)));
          hop = next;
        }
        linkedIntoHandoffs = unresolved
          || spellings.some((p) => p && roots.some((r) => p === r || p.startsWith(`${r}${path.sep}`)));
      }
    } catch (_) { /* nothing there */ }
    let refusal = null;
    if (!protection.ok) refusal = `protected handoffs could not be read: ${protection.errors.join('; ')}`;
    else if (linkedCentral || linkedIntoHandoffs) {
      // A wrap writes to the path it is handed, and a central file that is a
      // symlink writes through to whatever it points at, a project's own
      // handoff included, whatever that document says it is.
      refusal = linkedCentral
        ? `${t.path} is a symbolic link, and a wrap would write through it to another document; choose another topic`
        : `${t.path} is a symbolic link into the handoffs folder, and a wrap would write over the handoff it points at; replace the link with a real file`;
    }
    else if (configMod.isProtected(protection, t.path, opts.home)) refusal = `${t.path} is protected`;
    else if (central && reg.state === 'invalid') {
      refusal = `the thread list is invalid, so whether ${t.path} is a thread cannot be told: ${reg.errors.join('; ')}`;
    } else if (central && reg.state === 'ok' && registryMod.declaredPaths(reg.registry).has(t.path)) {
      refusal = `${t.path} is a declared thread; write it with cli.js save --thread ${t.slug}`;
    } else if (central && reg.state === 'ok' && (homeCwd || existingMaybeThread)) {
      refusal = homeCwd
        ? 'threads are set up, so a handoff written from the home directory is saved as a thread: '
          + 'cli.js save --thread <slug> (add --create for a new one)'
        : `${t.path} already exists and may be home history, which is never rewritten; choose another topic`;
    }
    if (refusal) {
      process.exitCode = 1;
      // The path is left out on purpose: a caller that skims past `refused`
      // must not find a writable path in the answer.
      if (opts.json) return emit(opts, { kind: t.kind, slug: t.slug, refused: refusal }, []);
      return emit(opts, {}, [`Not handed out: ${refusal}`]);
    }
    let record = null;
    // A project whose name is taken by a thread is indexed under
    // `<name>-project` instead, so /pickup has a name that opens it and, as
    // importantly, the index still lists it: the index is how every pool finds
    // project handoffs. Leaving it out of the index was tried first and lost
    // its rules for every other folder in its repository (a worktree, a
    // subfolder, the main checkout), each patch for that opening the next.
    // Only if the alternative is taken as well does it fall back to a path.
    // The name is chosen inside recordHandoff's lock (see chooseProjectKey), so
    // two wraps at once cannot both take the same free name. A central
    // handoff keeps its topic name, as before.
    const choose = central ? null : (index) => threadsMod.chooseProjectKey(t.slug, t.path, opts.home, index);
    let key;
    let assigned = false;
    if (opts.noRecord) {
      const c = choose ? choose(handoffs.readIndex(opts.home)) : { key: t.slug, assigned: false };
      key = c.key;
      assigned = c.assigned;
    } else {
      record = handoffs.recordHandoff({ slug: t.slug, target: t.path, kind: t.kind, home: opts.home, choose });
      if (record.key === undefined) {
        // Refused before choosing (a busy or unwritable lock): decide from a
        // fresh read which name it would have been, so a thread-named project
        // is not handed its bare name, which /pickup would open as the thread.
        const c = choose ? choose(handoffs.readIndex(opts.home)) : { key: t.slug, assigned: false };
        key = c.key;
        assigned = c.assigned;
      } else {
        key = record.key;
        assigned = Boolean(record.assigned);
      }
    }
    // An assigned name exists only in the index, so one that was not recorded
    // (--no-record, a refused lock, a failed write) leads nowhere and is not
    // handed out; the project is then picked up by its path. A project's own
    // folder name is still handed out, as in 0.8, with the retry advice below.
    // An empty key too: a folder whose name slugifies to nothing (`___`) got
    // pickupSlug '', and find "" then called a written file not written.
    const shadowed = !key || Boolean(record && record.shadowed)
      || (assigned && !(record && record.recorded));
    if (!key) key = t.slug;
    const pickupSlug = shadowed ? null : key;
    if (opts.json) {
      return emit(opts, {
        ...t, recorded: record ? record.recorded : false, recordReason: record && record.reason,
        pickupSlug,
      }, []);
    }
    // The plain answer says what the JSON says, with or without --no-record.
    const lines = [t.path, shadowed
      ? `  kind: ${t.kind}, pickup slug: none, because ${record && record.reason ? record.reason : `"${key}" is not recorded by this run (--no-record)`}; pick this up by its path: /pickup ${t.path}`
      : `  kind: ${t.kind}, pickup slug: ${key}${key !== t.slug ? ` ("${t.slug}" is taken)` : ''}`];
    // Said, because a project handoff whose entry was not recorded may not be
    // found by name later, and the wrap is the moment that can still be fixed.
    if (record && !record.recorded) {
      lines.push(shadowed
        ? `  Not recorded in the index: ${record.reason}.`
        : `  Not recorded in the index (${record.reason}). Run this again before relying on /pickup ${key}.`);
    }
    emit(opts, {}, lines);
  },

  capabilities(opts) {
    emit(opts, CAPABILITIES, [JSON.stringify(CAPABILITIES)]);
  },

  threads(opts) {
    const r = threadsMod.listThreads(opts.home);
    if (r.mode === 'invalid') process.exitCode = 1;
    if (opts.json) return emit(opts, r, []);
    if (r.mode === 'pre-migration') {
      return emit(opts, {}, ['Threads are not set up here yet. Central handoffs are still written one per session.',
        'To set them up: cli.js migrate plan --threads <slug,slug,...>']);
    }
    if (r.mode === 'invalid') {
      return emit(opts, {}, ['The thread list cannot be read:', ...r.errors.map((e) => `  ${e}`)]);
    }
    const lines = [`${r.threads.length} thread${r.threads.length === 1 ? '' : 's'}, generation ${r.generation}:`];
    for (const t of r.threads) {
      lines.push(`  ${t.slug}${t.exists ? (t.unreadable ? '  (CANNOT BE READ)' : '') : '  (FILE MISSING)'}`);
      if (t.subject) lines.push(`      ${t.subject}`);
    }
    if (r.pending) lines.push('', `A migration is part way through: run cli.js migrate finish.`);
    emit(opts, {}, lines);
  },

  save(opts) {
    const result = threadsMod.saveThread({
      slug: opts.thread,
      from: opts.from,
      base: opts.base,
      generation: opts.generation,
      create: opts.create,
      home: opts.home,
    });
    if (!result.saved || (opts.create && !result.declared)) process.exitCode = 1;
    if (opts.json) return emit(opts, result, []);
    if (!result.saved) {
      const lines = [`Not saved (${result.reason}): ${result.detail}`];
      if (result.previousUnchanged === true) lines.push('The previous handoff is unchanged.');
      if (result.nothingWritten === true) lines.push(`Nothing was written to ${result.path || 'the thread path'}.`);
      if (result.draft) lines.push(`The draft is kept at ${result.draft}.`);
      return emit(opts, {}, lines);
    }
    const lines = [`Saved ${result.path}`, `  rev ${result.rev.slice(0, 12)}`];
    if (!result.indexUpdated) {
      lines.push(result.indexConflict
        ? `  The index was not updated: it records this slug for ${result.indexConflict}. cli.js find will report the conflict.`
        : '  The index was not updated. The thread is still found by name.');
    }
    if (opts.create && !result.declared) lines.push(`  Not yet declared as a thread: run cli.js declare ${result.slug}`);
    emit(opts, {}, lines);
  },

  declare(opts) {
    const r = threadsMod.declareThread({ slug: opts.rest[0], home: opts.home });
    if (!r.declared) process.exitCode = 1;
    if (opts.json) return emit(opts, r, []);
    emit(opts, {}, [r.declared ? `Declared ${r.slug} (${r.path}).` : `Not declared (${r.reason}): ${r.detail}`]);
  },

  migrate(opts) {
    const sub = opts.rest[0];
    const fs = require('fs');
    if (sub === 'plan') {
      const r = threadsMod.migratePlan({ slugs: String(opts.threads || '').split(','), home: opts.home });
      if (!r.ok) {
        process.exitCode = 1;
        return emit(opts, r, [`No plan (${r.reason}):`, ...String(r.detail).split('\n').map((l) => `  ${l}`)]);
      }
      // The only file this ever writes, and only where it is told to. The plan
      // is the document a person fills in, so it has to be somewhere they chose.
      if (opts.out) {
        try {
          fs.writeFileSync(opts.out, `${JSON.stringify(r.manifest, null, 2)}\n`);
        } catch (e) {
          process.exitCode = 1;
          return emit(opts, { ok: false, reason: 'out', detail: e.message }, [`Could not write the plan to ${opts.out}: ${e.message}`]);
        }
      }
      if (opts.json) return emit(opts, r.manifest, []);
      const m = r.manifest;
      const lines = [
        `${m.threads.length} threads, ${m.scannedDocuments} home handoffs read.`,
        '',
        'What each thread binds, today and after:',
        ...m.perThread.map((p) => `  ${p.slug}: ${p.bindingToday} -> ${p.bindingAfter}`),
        '',
        `${m.lost.length} rule${m.lost.length === 1 ? '' : 's'} bind today and are in no thread. Each needs retire, shared:done, or thread:<slug>.`,
        ...m.lost.map((r) => `  - ${r.text}  (from ${r.from})`),
        '',
        `${m.gained.length} rule${m.gained.length === 1 ? '' : 's'} would start binding. Each needs keep or drop.`,
        ...m.gained.map((r) => `  + ${r.text}  (in ${r.threads.join(', ')})`),
        '',
      ];
      lines.push(opts.out ? `Plan written to ${opts.out}. Fill in each disposition, then run migrate apply.`
        : 'Nothing written. Rerun with --out <file> to save the plan for review.');
      return emit(opts, {}, lines);
    }
    if (sub === 'apply') {
      const r = threadsMod.migrateApply({
        manifestPath: opts.rest[1], acceptNarrowing: opts.acceptNarrowing, sessionsRestarted: opts.sessionsRestarted, home: opts.home,
      });
      if (!r.committed || (r.failures && r.failures.length)) process.exitCode = 1;
      if (opts.json) return emit(opts, r, []);
      if (!r.committed) return emit(opts, {}, [`Not applied (${r.reason}):`, ...String(r.detail).split('\n').map((l) => `  ${l}`)]);
      const lines = [`Threads declared, generation ${r.generation}. ${r.applied.length} rule change${r.applied.length === 1 ? '' : 's'} written into threads.`];
      if (r.failures.length) {
        lines.push(`Stopped with ${r.remaining === null ? 'an unknown number' : r.remaining} still pending: ${r.failures[0].error}`,
          'Run cli.js migrate finish once that is fixed.');
      }
      return emit(opts, {}, lines);
    }
    if (sub === 'finish') {
      const r = threadsMod.migrateFinish({ home: opts.home });
      if (!r.finished) process.exitCode = 1;
      if (opts.json) return emit(opts, r, []);
      if (r.reason) return emit(opts, {}, [`Not finished (${r.reason}): ${r.detail}`]);
      if (!r.finished) return emit(opts, {}, [`Stopped with ${r.remaining === null ? 'an unknown number' : r.remaining} still pending: ${r.failures[0].error}`]);
      return emit(opts, {}, [`Done. ${r.applied.length} written.`]);
    }
    process.exitCode = 1;
    emit(opts, { error: 'migrate needs plan, apply or finish' }, ['Usage: cli.js migrate plan|apply|finish']);
  },

  memory(opts) {
    const dir = handoffs.memoryDir(opts.cwd, opts.home);
    if (opts.json) return emit(opts, { memoryDir: dir }, []);
    emit(opts, {}, [dir || 'No memory directory for this project.']);
  },

  // Measure the memory directory rather than trusting the rules about it.
  //
  // /wrap already tells the model to edit rather than append and to replace
  // stale lines rather than adding beside them. Those are the right rules and
  // they are advice, which this repository has spent two days learning the
  // value of. This reports numbers at the one moment somebody is already
  // deciding what still matters.
  //
  // It changes nothing and deletes nothing, ever.
  'memory-check': function memoryCheck(opts) {
    const dir = handoffs.memoryDir(opts.cwd, opts.home);
    if (!dir) {
      if (opts.json) return emit(opts, { memoryDir: null, findings: [] }, []);
      return emit(opts, {}, ['No memory directory for this project. Nothing to check.']);
    }

    const config = configMod.load(opts.home);
    const result = memoryMod.audit({ dir, config: config.memoryBudget });
    if (!result) {
      if (opts.json) return emit(opts, { memoryDir: dir, findings: [] }, []);
      return emit(opts, {}, [`Could not read ${dir}.`]);
    }

    if (opts.json) return emit(opts, result, []);

    // fileCount, not files.length. The second is filtered to exclude the index
    // because the index is exempt from the per-file checks, and printing a total
    // against it claimed more words than the count covered.
    const lines = [`${result.total} words across ${result.fileCount} file${result.fileCount === 1 ? '' : 's'}, budget ${result.limits.totalWords}.`, ''];
    if (!result.findings.length) {
      lines.push('Nothing to act on.');
      return emit(opts, {}, lines);
    }
    for (const f of result.findings) {
      const where = f.file ? `${f.file}: ` : '';
      const size = f.words != null ? `${f.words} words, over ${f.limit}. ` : '';
      lines.push(`  ${f.kind}`, `    ${where}${size}${f.note}`);
    }
    emit(opts, {}, lines);
  },

  // Every connected server, so /core-tools can offer a real list to pick from
  // rather than asking someone to remember what they have connected.
  'mcp-servers': function mcpServers(opts) {
    const servers = mcpHealth.probe() || [];
    if (opts.json) return emit(opts, { servers }, []);
    if (!servers.length) {
      return emit(opts, {}, ['No MCP servers reported. Is `claude mcp list` working?']);
    }
    emit(opts, {}, servers.map((s) => `  ${s.status.padEnd(10)} ${s.name}`));
  },

  'mcp-refresh': function mcpRefresh(opts) {
    const written = mcpHealth.refresh({ home: opts.home });
    if (opts.json) return emit(opts, { written }, []);
    if (!written) {
      return emit(opts, {}, ['Could not reach `claude mcp list`. The existing cache was left alone.']);
    }
    emit(opts, {}, [`Cached ${written.servers.length} servers at ${mcpHealth.cachePath(opts.home)}`]);
  },

  'mcp-status': function mcpStatus(opts) {
    const config = configMod.load(opts.home);
    const summary = mcpHealth.summarize({ config, home: opts.home });

    if (opts.json) return emit(opts, { config: config.coreTools, summary }, []);

    if (!summary) {
      return emit(opts, {}, [
        'No core tools configured, so the status line segment is off.',
        `Run /core-tools to pick some, or edit ${configMod.configPath(opts.home)}`,
      ]);
    }
    if (summary.noCache) {
      return emit(opts, {}, ['No health cache yet. Run `cli.js mcp-refresh` to build one.']);
    }
    const lines = summary.tools.map((t) => `  ${t.status.padEnd(10)} ${t.label}`
      + (t.server ? `  (${t.server})` : '  (no server matches "' + t.match + '")'));
    lines.push('', `${summary.connected}/${summary.total} connected, checked ${mcpHealth.formatAge(summary.ageMinutes)} ago`);
    emit(opts, {}, lines);
  },

  'mcp-probe': function mcpProbe(opts) {
    const config = configMod.load(opts.home);
    const result = mcpHealth.scheduledProbe({ config, home: opts.home });
    if (['unconfigured', 'lock_failed', 'write_failed', 'state_failed', 'probe_failed'].includes(result.event)) {
      process.exitCode = 1;
    }
    if (opts.json) return emit(opts, result, []);
    if (result.message) process.stdout.write(`${result.message}\n`);
  },
};

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    process.stderr.write(`session: ${opts.error}. This copy of cli.js may be older or newer than the skill calling it.\n`);
    if (opts.json) process.stdout.write(`${JSON.stringify({ error: opts.error })}\n`);
    process.exit(2);
  }
  const fn = COMMANDS[opts.command];
  if (!fn) {
    process.stdout.write(`Commands: ${Object.keys(COMMANDS).join(', ')}\n`);
    process.exit(opts.command ? 1 : 0);
  }
  fn(opts);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseArgs, COMMANDS, main };
