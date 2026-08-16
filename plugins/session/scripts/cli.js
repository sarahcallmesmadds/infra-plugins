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

function parseArgs(argv) {
  const out = {
    command: null, rest: [], json: false, dryRun: false, self: null, noRecord: false, fix: false,
    days: handoffs.DEFAULT_STALE_DAYS, cwd: process.cwd(), home: os.homedir(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--days') out.days = parseInt(argv[++i], 10);
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--self') out.self = argv[++i];
    else if (a === '--no-record') out.noRecord = true;
    else if (a === '--fix') out.fix = true;
    else if (!out.command) out.command = a;
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
    if (opts.json) return emit(opts, result, []);

    if (result.skipped) {
      return emit(opts, result, [`No handoffs directory at ${result.root}. Nothing to sweep.`]);
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
  forget(opts) {
    const slug = opts.rest[0];
    if (!slug) {
      if (opts.json) return emit(opts, { removed: false, reason: 'no slug given' }, []);
      return emit(opts, {}, ['Which one? Usage: cli.js forget <slug>']);
    }

    const result = handoffs.forgetHandoff(slug, opts.home);
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

    if (opts.json) return emit(opts, result, []);

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
        if (skipped > 0) {
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
    const match = handoffs.findHandoff(slug, opts.home);
    const stale = match ? null : handoffs.staleRecord(slug, opts.home);
    if (opts.json) {
      return emit(opts, {
        slug, match, stale, tried: handoffs.searchPaths(slug, opts.home),
      }, []);
    }
    if (match) {
      const age = Math.round((Date.now() - match.mtime) / 86400000);
      return emit(opts, {}, [
        `${match.path}`,
        `  kind: ${match.kind}, last touched ${age} day${age === 1 ? '' : 's'} ago`,
      ]);
    }
    // A stale entry and no entry at all produced the same message, so a moved
    // project read as a handoff that never existed. The recorded path is the one
    // fact worth having here, because it says where to look.
    const lines = [`No handoff found for "${slug}".`];
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
    const r = handoffs.carriedConstraints({ cwd: opts.cwd, home: opts.home });
    if (opts.json) return emit(opts, r, []);

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
    if (!opts.noRecord) {
      handoffs.recordHandoff({ slug: t.slug, target: t.path, kind: t.kind, home: opts.home });
    }
    if (opts.json) return emit(opts, t, []);
    emit(opts, {}, [t.path, `  kind: ${t.kind}, pickup slug: ${t.slug}`]);
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
  const fn = COMMANDS[opts.command];
  if (!fn) {
    process.stdout.write(`Commands: ${Object.keys(COMMANDS).join(', ')}\n`);
    process.exit(opts.command ? 1 : 0);
  }
  fn(opts);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseArgs, COMMANDS, main };
