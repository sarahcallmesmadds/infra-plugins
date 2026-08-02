#!/usr/bin/env node
// The configured roots, and whether they still exist.
//
// Run: node scripts/roots.js <command> [options]
//
// Why this exists. On 2026-08-01 every path in DEPS.json and the single root in
// build-loop.config.json pointed at a directory that had moved. Every skill here
// resolved to files that were not there, and not one of them said so. It was
// found by hand, days later, while chasing an unrelated failure.
//
// Three skills carried a guard for it and three did not, and the guard the three
// carried only fired when *every* root was dead. One dead root among several
// scanned as empty, which is indistinguishable from a root that genuinely holds
// nothing. The check was in prose, so it drifted between the files that had it,
// and the files that never had it stayed silent.
//
// So the check lives here instead and the skills call it. This is the same move
// queue.js made for writes: a rule that has to hold everywhere cannot be six
// paragraphs that each drift on their own, because prose has no compiler.
//
// It reads. It never writes, and it never repairs a path: a root that has moved
// is a decision for the person who moved it.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG = path.join(os.homedir(), '.claude', 'build-loop.config.json');

// Kept in step with SCHEMA.md. Used only when there is no config file at all,
// which is a fresh install rather than a broken one.
const DEFAULT_ROOTS = [
  { name: 'personal', path: '~/.claude/skills', kind: 'skill' },
  { name: 'hooks', path: '~/.claude/hooks', kind: 'hook' },
  { name: 'commands', path: '~/.claude/commands', kind: 'command' },
];

// Exit codes are the whole interface for a caller that does not parse the
// output, so they distinguish the two cases that need different handling:
// carry on with what is left, versus stop because there is nothing to work with.
const OK = 0;
const SOME_MISSING = 3;
const ALL_MISSING = 4;

class RootsError extends Error {}

function fail(message) {
  throw new RootsError(message);
}

// `~` is expanded here and nowhere else. Node's fs takes a literal tilde, so an
// unexpanded path creates or reads a directory actually named `~` beside the
// current one, and every check after it looks in the wrong place. Every skill
// in this plugin repeats that warning at the top precisely because it has
// happened.
function expand(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// A root counts as existing only when it is a directory. A file sitting where a
// root should be is not something to scan, and reporting it as present sends
// every later glob looking inside a non-directory for no stated reason.
function existsAsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readConfig() {
  if (!fs.existsSync(CONFIG)) {
    return { source: null, usedDefaults: true, roots: DEFAULT_ROOTS };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (error) {
    // Deliberately not falling back to the defaults. A corrupt config is a
    // different situation from an absent one: the defaults would scan three
    // directories the user never asked for and report everything under their
    // real root as orphaned.
    fail(`roots.js: ${CONFIG} exists but is not valid JSON (${error.message}). Fix or remove it.`);
  }

  if (Array.isArray(parsed.roots)) {
    return { source: CONFIG, usedDefaults: false, roots: parsed.roots };
  }

  // A config holding skillRoots and no roots predates schema v2 and still
  // works. It is read, never rewritten.
  if (Array.isArray(parsed.skillRoots)) {
    const roots = parsed.skillRoots.map((r) =>
      typeof r === 'string'
        ? { name: path.basename(expand(r)), path: r, kind: 'skill' }
        : { kind: 'skill', ...r });
    return { source: CONFIG, usedDefaults: false, legacy: 'skillRoots', roots };
  }

  fail(`roots.js: ${CONFIG} has neither "roots" nor "skillRoots". Nothing to scan.`);
}

function resolve() {
  const config = readConfig();
  const roots = config.roots.map((r, i) => {
    const raw = r && typeof r.path === 'string' ? r.path : null;
    if (!raw) fail(`roots.js: root at position ${i} has no "path".`);
    const resolved = expand(raw);
    return {
      name: r.name || path.basename(resolved),
      kind: r.kind || 'skill',
      path: resolved,
      configured: raw,
      exists: existsAsDir(resolved),
    };
  });

  const missing = roots.filter((r) => !r.exists);
  return {
    config: config.source,
    usedDefaults: Boolean(config.usedDefaults),
    legacy: config.legacy || null,
    roots,
    missing,
    allMissing: roots.length > 0 && missing.length === roots.length,
  };
}

function codeFor(state) {
  if (state.missing.length === 0) return OK;
  return state.allMissing ? ALL_MISSING : SOME_MISSING;
}

// --- commands ------------------------------------------------------------

function cmdList(args) {
  const state = resolve();
  const wanted = args.kind;
  const out = wanted
    ? { ...state, roots: state.roots.filter((r) => r.kind === wanted) }
    : state;
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return codeFor(state);
}

// The sentences a skill relays. They are written here rather than in each
// SKILL.md so that six callers cannot describe the same condition six ways,
// which is how the old guard drifted.
function cmdCheck() {
  const state = resolve();
  const lines = [];

  // Every dead root is named, including when they are all dead. The all-dead
  // message used to stand on its own, and the one thing nobody knew on
  // 2026-08-01 was which path had gone. "Nothing exists" without the path sends
  // you looking at the config to work out what it was even pointing at.
  for (const r of state.missing) {
    lines.push(
      `Root '${r.name}' points at ${r.path}, which does not exist. Nothing under it can be resolved, and anything the map holds there will read as orphaned until the path is fixed.`,
    );
  }

  if (state.allMissing) {
    lines.push(
      'None of the configured roots exist on this machine, so there is nothing to scan.',
      'If you develop plugins in a checkout, add it to ~/.claude/build-loop.config.json as a root of kind plugin-repo.',
    );
  }

  if (lines.length === 0) {
    const names = state.roots.map((r) => r.name).join(', ');
    lines.push(`Every configured root exists: ${names}.`);
  }

  process.stdout.write(lines.join('\n') + '\n');
  return codeFor(state);
}

// --- argument parsing ----------------------------------------------------

// Same shape as queue.js on purpose, including refusing an unknown option
// rather than turning it into a silent boolean. A typo that is ignored is a
// caller believing it asked for something it did not.
const VALUE_OPTS = new Set(['kind']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { out._.push(token); continue; }

    const eq = token.indexOf('=');
    const name = eq > 2 ? token.slice(2, eq) : token.slice(2);
    let value = eq > 2 ? token.slice(eq + 1) : undefined;

    if (!VALUE_OPTS.has(name)) {
      fail(`roots.js: unknown option --${name}. Known options: ${[...VALUE_OPTS].map((o) => '--' + o).join(', ')}`);
    }
    if (value === undefined) {
      if (i + 1 >= argv.length) fail(`roots.js: --${name} needs a value.`);
      value = argv[++i];
    }
    out[name] = value;
  }
  return out;
}

const COMMANDS = { list: cmdList, check: cmdCheck };

function main(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write([
      'roots.js <command>',
      '',
      '  check                 report any configured root that does not exist',
      '  list [--kind K]       print the roots as JSON, each with an exists flag',
      '',
      '  Exit codes: 0 every root exists, 3 some are missing, 4 all are missing,',
      '  1 the config could not be read. Reads only; it never repairs a path.',
      '',
    ].join('\n'));
    return OK;
  }
  const run = COMMANDS[command];
  if (!run) fail(`roots.js: unknown command ${command}. Try --help.`);
  return run(parseArgs(argv.slice(1)));
}

if (require.main === module) {
  let code = OK;
  try {
    code = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write((error instanceof RootsError ? error.message : error.stack) + '\n');
    code = 1;
  }
  // process.exitCode, never process.exit, for the reason queue.js gives at
  // length: a write to a pipe on macOS is asynchronous, and every caller here
  // is a skill reading what was printed.
  process.exitCode = code;
}

module.exports = { main, resolve, expand, CONFIG, DEFAULT_ROOTS, OK, SOME_MISSING, ALL_MISSING };
