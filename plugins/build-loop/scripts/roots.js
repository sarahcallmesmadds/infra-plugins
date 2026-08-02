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

  // JSON.parse returns null for the literal text `null`, and happily returns a
  // number or an array too. Every one of those reaches `parsed.roots` below and
  // throws a TypeError rather than the sentence written for this, and a skill
  // relaying that prints a Node stack trace at the user. Valid JSON and a usable
  // config are different questions and both have to be asked.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`roots.js: ${CONFIG} must hold a JSON object with a "roots" array. Fix or remove it.`);
  }

  // An empty list is refused rather than treated as "no roots are missing". It
  // resolves to nothing, so every caller would be told the roots are fine while
  // nothing could ever be found under them, which is the exact confusion between
  // empty and absent that this file exists to end.
  if (Array.isArray(parsed.roots)) {
    if (parsed.roots.length === 0) {
      fail(`roots.js: ${CONFIG} has an empty "roots" array, so nothing can be scanned. Add a root, or remove the file to fall back to the defaults.`);
    }
    return { source: CONFIG, usedDefaults: false, roots: parsed.roots };
  }

  // A config holding skillRoots and no roots predates schema v2 and still
  // works. It is read, never rewritten.
  if (Array.isArray(parsed.skillRoots)) {
    if (parsed.skillRoots.length === 0) {
      fail(`roots.js: ${CONFIG} has an empty "skillRoots" array, so nothing can be scanned. Add a root, or remove the file to fall back to the defaults.`);
    }
    const roots = parsed.skillRoots.map((r) =>
      typeof r === 'string'
        ? { name: path.basename(expand(r)), path: r, kind: 'skill' }
        : { kind: 'skill', ...r });
    return { source: CONFIG, usedDefaults: false, legacy: 'skillRoots', roots };
  }

  fail(`roots.js: ${CONFIG} has neither "roots" nor "skillRoots". Nothing to scan.`);
}

// `kind` scopes everything it touches: the roots listed, the missing list, the
// all-missing flag and therefore the exit code. An earlier version filtered only
// the listing and left the rest global, on the reasoning that a filter should
// not be able to hide a problem. That was the wrong call. It meant `missing`
// could name a root absent from `roots`, and `allMissing` could read false while
// every root of the kind asked about was dead. A caller that asks about skill
// roots is answering a question about skill roots, and find-skill was reporting
// a missing hooks directory to someone who asked which skill to use.
// `name` narrows to a single root, which is the question apply-fix and
// revert-fix actually have: not "is everything well" but "is the one I am about
// to commit into there". Asking the broad question and inferring the narrow
// answer from it is what let an absent root through.
function resolve({ kind, name } = {}) {
  const config = readConfig();
  const all = config.roots.map((r, i) => {
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

  let roots = all;
  if (kind) roots = roots.filter((r) => r.kind === kind);
  if (name) roots = roots.filter((r) => r.name === name);
  const missing = roots.filter((r) => !r.exists);
  return {
    config: config.source,
    usedDefaults: Boolean(config.usedDefaults),
    legacy: config.legacy || null,
    kind: kind || null,
    name: name || null,
    roots,
    missing,
    allMissing: roots.length > 0 && missing.length === roots.length,
  };
}

// The exit code answers one question only: does every root in scope exist. It
// does not grade how upset to be about the answer.
//
// An earlier version returned OK when a default was absent, on the reasoning
// that SCHEMA.md calls that "not an error". It is not an error, and the code
// still has to say it, because the exit code is the only signal a caller gets
// about whether the root it is about to use is there. Returning OK told
// apply-fix the root existed, and Step 8 then ran git against a path that was
// not there, after the target file had already been written: the exact limbo
// the Step 2 guard exists to prevent.
//
// "Not an error" is a statement about wording, so it lives in the wording.
// cmdCheck says plainly that an absent default is normal. Scope is what keeps
// that quiet where it is irrelevant: find-skill asks --kind skill and never
// hears about a missing hooks directory at all.
function codeFor(state) {
  // Asking about a kind or a name nothing is configured for leaves nothing to
  // scan, which has the same consequence as every root being gone even though
  // the cause differs. Returning OK here would tell find-skill the skill roots
  // are fine on a machine that has none.
  if (state.roots.length === 0) return ALL_MISSING;
  if (state.missing.length === 0) return OK;
  return state.allMissing ? ALL_MISSING : SOME_MISSING;
}

// --- commands ------------------------------------------------------------

function cmdList(args) {
  const state = resolve(args);
  process.stdout.write(JSON.stringify(state, null, 2) + '\n');
  return codeFor(state);
}

// The sentences a skill relays. They are written here rather than in each
// SKILL.md so that six callers cannot describe the same condition six ways,
// which is how the old guard drifted.
function cmdCheck(args) {
  const state = resolve(args);
  const scope = state.kind ? ` of kind ${state.kind}` : '';
  const lines = [];

  if (state.name) {
    // Narrowed to one root, so answer about that root and nothing else. The
    // caller asked because it is about to work inside it.
    const found = state.roots[0];
    if (!found) {
      lines.push(`No root named '${state.name}'${scope} is configured, so there is nowhere to work.`);
    } else if (!found.exists) {
      lines.push(
        `Root '${found.name}' points at ${found.path}, which does not exist, so there is nowhere to work.`,
        state.usedDefaults
          ? 'It is a default location rather than one anything configured, so nothing has been lost. Nothing can be written there either.'
          : 'Anything the map holds under it will read as orphaned until the path is fixed.',
      );
    } else {
      lines.push(`Root '${found.name}' exists at ${found.path}.`);
    }
  } else if (state.roots.length === 0) {
    lines.push(`No root${scope} is configured, so there is nothing to scan.`);
  } else if (state.usedDefaults) {
    // Nobody chose these paths, so an absent one is information rather than a
    // fault, and codeFor returns 0 so the skills stay quiet about it. All of
    // them absent is still worth stopping for: there is then nowhere to look.
    const present = state.roots.filter((r) => r.exists).map((r) => r.name);
    if (state.allMissing) {
      lines.push(
        `There is no config file, and none of the default locations${scope} exist either, so there is nothing to scan: ${state.missing.map((r) => `${r.name} (${r.path})`).join(', ')}.`,
        'If you develop plugins in a checkout, add it to ~/.claude/build-loop.config.json as a root of kind plugin-repo.',
      );
    } else {
      lines.push(`No config file, so the default locations are in use. Present: ${present.join(', ')}.`);
      if (state.missing.length > 0) {
        lines.push(`Absent, which is normal on a machine where everything is installed from marketplaces: ${state.missing.map((r) => r.name).join(', ')}.`);
      }
    }
  } else if (state.missing.length > 0) {
    // One wording for a configured root, whether it is the only dead one or all
    // of them. The all-dead message used to stand on its own and name no paths,
    // and the one thing nobody knew on 2026-08-01 was which path had gone.
    for (const r of state.missing) {
      lines.push(
        `Root '${r.name}' points at ${r.path}, which does not exist. Nothing under it can be resolved, and anything the map holds there will read as orphaned until the path is fixed.`,
      );
    }
    if (state.allMissing) {
      lines.push(
        `None of the configured roots${scope} exist on this machine, so there is nothing to scan.`,
        'If you develop plugins in a checkout, add it to ~/.claude/build-loop.config.json as a root of kind plugin-repo.',
      );
    }
  } else {
    lines.push(`Every configured root${scope} exists: ${state.roots.map((r) => r.name).join(', ')}.`);
  }

  process.stdout.write(lines.join('\n') + '\n');
  return codeFor(state);
}

// --- argument parsing ----------------------------------------------------

// Same shape as queue.js on purpose, including refusing an unknown option
// rather than turning it into a silent boolean. A typo that is ignored is a
// caller believing it asked for something it did not.
const VALUE_OPTS = new Set(['kind', 'name']);

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
      '  check [--kind K] [--name N]   report any root in scope that is missing',
      '  list  [--kind K] [--name N]   the roots as JSON, each with an exists flag',
      '',
      '  --kind and --name scope everything: which roots are looked at, which are',
      '  reported missing, and the exit code. Ask about skill roots and a missing',
      '  hook root is not your answer. Use --name when you are about to work',
      '  inside one particular root and need an answer about that one.',
      '',
      '  Exit codes: 0 every root in scope exists, 3 some are missing, 4 nothing',
      '  to scan (all missing, or nothing configured matching the scope), 1 the',
      '  config could not be read.',
      '',
      '  The code answers only whether the roots are there. It does not grade how',
      '  much that matters: with no config file the defaults are in use and an',
      '  absent one is reported as normal, in words, while still exiting 3. A',
      '  caller needs to know a directory is not there even when nobody is at',
      '  fault for it.',
      '',
      '  Reads only; it never repairs a path.',
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
