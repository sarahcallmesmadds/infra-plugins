#!/usr/bin/env node
// The command behind the session skills.
//
// Usage:
//   cli.js sessions              live Claude Code sessions, this one excluded
//   cli.js today                 the date line the session hook injects
//   cli.js archive [--days N] [--dry-run]
//                                sweep stale handoffs into archived/
//   cli.js find <slug>           locate the handoff a slug refers to
//   cli.js forget <slug>         drop an index entry, leaving the document
//   cli.js recent                the newest handoffs, for the pickup menu
//   cli.js target [topic]        where wrap should write from here
//   cli.js memory                the memory directory for this project, if any
//   cli.js memory-check          is that directory still worth loading
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
    command: null, rest: [], json: false, dryRun: false, self: null, noRecord: false,
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
    if (result.repointed.length) {
      lines.push(`Repointed ${result.repointed.length} index ${result.repointed.length === 1 ? 'entry' : 'entries'} to the archive: `
        + result.repointed.map((r) => r.slug).join(', '));
    }
    if (result.pruned.length) {
      const would = opts.dryRun ? 'Would drop' : 'Dropped';
      lines.push(`${would} ${result.pruned.length} index ${result.pruned.length === 1 ? 'entry' : 'entries'} pointing at files that are gone: `
        + result.pruned.map((p) => p.slug).join(', '));
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

  find(opts) {
    const slug = opts.rest[0];
    const match = handoffs.findHandoff(slug, opts.home);
    if (opts.json) {
      return emit(opts, { slug, match, tried: handoffs.searchPaths(slug, opts.home) }, []);
    }
    if (match) {
      const age = Math.round((Date.now() - match.mtime) / 86400000);
      return emit(opts, {}, [
        `${match.path}`,
        `  kind: ${match.kind}, last touched ${age} day${age === 1 ? '' : 's'} ago`,
      ]);
    }
    emit(opts, {}, [
      `No handoff found for "${slug}". Looked at:`,
      ...handoffs.searchPaths(slug, opts.home).map((c) => `  ${c.path}`),
    ]);
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
