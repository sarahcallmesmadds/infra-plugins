#!/usr/bin/env node
// The command behind the session skills.
//
// Usage:
//   cli.js sessions              live Claude Code sessions, this one excluded
//   cli.js today                 the date line the session hook injects
//   cli.js archive [--days N] [--dry-run]
//                                sweep stale handoffs into archived/
//   cli.js find <slug>           locate the handoff a slug refers to
//   cli.js recent                the newest handoffs, for the pickup menu
//   cli.js target [topic]        where wrap should write from here
//   cli.js memory                the memory directory for this project, if any
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
    // wrong. The hook gets the id from its event; there is no event here, so it
    // comes from the environment, which Claude Code sets for anything it
    // spawns. Verified against a live session rather than assumed.
    const { sessions, complete } = sessionsMod.liveSessions({
      selfSessionId: opts.self || process.env.CLAUDE_CODE_SESSION_ID,
      deadline: Date.now() + 4000,
    });
    const rows = sessions.map((s) => ({
      ...s,
      overlapsHere: sessionsMod.overlaps(opts.cwd, s.cwd),
    }));

    if (opts.json) return emit(opts, { sessions: rows, complete }, []);

    if (!rows.length) {
      return emit(opts, {}, ['No other Claude Code sessions are running.']);
    }
    const lines = rows.map((s) => {
      const where = s.cwd || 'working directory unknown';
      const age = s.ageMinutes == null ? '' : `, ${s.ageMinutes} min`;
      return `  ${s.overlapsHere ? '>' : ' '} ${where}${age}  (pid ${s.pid})`;
    });
    if (!complete) {
      lines.push('', 'Some working directories could not be read, so this list may be incomplete.');
    }
    lines.unshift(`${rows.length} other session${rows.length === 1 ? '' : 's'} running:`, '');
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
    if (!result.moved.length) {
      return emit(opts, result, [`Nothing untouched for ${opts.days} days. Nothing moved.`]);
    }
    const verb = opts.dryRun ? 'Would archive' : 'Archived';
    emit(opts, result, [`${verb} ${result.moved.length}: ${result.moved.join(', ')}`]);
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
