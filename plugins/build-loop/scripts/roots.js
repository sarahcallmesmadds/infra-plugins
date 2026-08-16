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
// A default location that is absent is still absent, and a caller still has to
// know. But nobody chose that path, so it is not the same event as a root
// someone wrote into a config having moved, and giving both the same code meant
// every caller had to re-derive the difference from the text. Two rounds of
// review went into getting this wrong in both directions: first by reporting
// defaults as breakage, then by exiting 0 and hiding a real absence. A separate
// code says the thing once, here, and each skill gets one instruction for it.
const DEFAULTS_ABSENT = 5;

// The kinds a root may declare, per SCHEMA-DEPS.md. Used to refuse a typo in a
// --kind value: `--kind skil` filtered to nothing and returned "nothing to
// scan", which every caller treats as a reason to stop.
const KINDS = new Set(['skill', 'hook', 'command', 'script', 'plugin', 'plugin-repo']);

// --- where a plugin repository keeps things -------------------------------

// The one list. /audit-deps lists everything in a checkout and /built-check
// looks for one name in it, and both need the same answer to the same question:
// where does a plugin keep something worth mapping.
//
// They used to carry a glob block each, written out in prose. On 2026-08-14 PR
// #101 added `bin/` as a new place a plugin keeps executable code and neither
// block was updated, so `bin/hook-node` appeared in DEPS.json zero times across
// the five plugins that ship it, while being the file every hook in the
// repository starts through. The map said nothing depended on the most
// depended-on file there is, so a change to it would have reported no risk.
//
// Same move as the root check above, for the same reason: a rule that has to
// hold in two places cannot be two paragraphs, because prose has no compiler.
// Add a directory here and both skills have it.
const PLUGIN_LAYOUT = [
  { dir: 'skills', list: 'skills/*/SKILL.md', find: ['skills/<slug>/SKILL.md'], kind: 'skill' },
  { dir: 'hooks', list: 'hooks/*', find: ['hooks/<slug>', 'hooks/<slug>.*'], kind: 'hook' },
  { dir: 'commands', list: 'commands/*.md', find: ['commands/<slug>.md'], kind: 'command' },
  { dir: 'scripts', list: 'scripts/*', find: ['scripts/<slug>', 'scripts/<slug>.*'], kind: 'script' },
  { dir: 'statusline', list: 'statusline/*', find: ['statusline/<slug>', 'statusline/<slug>.*'], kind: 'script' },
  { dir: 'bin', list: 'bin/*', find: ['bin/<slug>', 'bin/<slug>.*'], kind: 'script' },
];

// Finding is the exact name, or the exact name with an extension. Never a
// prefix. `<slug>*` looks equivalent and is not: asked for `queue` it returns
// queue-count.test.js, queue-locking.test.js and three more, none of which is
// queue. /flag-issue records the path it finds into a queue entry and
// /apply-fix later opens that path and edits it, so a prefix match there is a
// correction applied to a file nobody was talking about. The looser form came
// from /built-check, which never needed it either: it claims an item looks
// built on the strength of the match.

// The two rows that sit outside `plugins/<name>/`, and the two that get
// forgotten, for opposite reasons. The plugin directory itself is the entry the
// map carries for a plugin as a whole. `tests/` is at the repository root, so
// every glob anchored at `plugins/*/` walks straight past it.
const REPO_LAYOUT = [
  { dir: '.', list: 'plugins/*/', find: ['plugins/<slug>/.claude-plugin/plugin.json'], kind: 'plugin', dirOnly: true },
  { dir: 'tests', list: 'tests/*.js', find: ['tests/<slug>.js', 'tests/<slug>.test.js'], kind: 'script' },
];
// Directories inside a plugin that are deliberately not mapped, with the reason.
// Named rather than left out, so the test that reconciles this list against
// what is on disk can tell "decided against" from "nobody has looked". An
// unlisted directory appearing in a plugin is how bin/ went missing, and it
// fails that test rather than passing silently.
const NOT_MAPPED = {
  reference: 'prose a skill loads on demand, not code anything can depend on',
  '.claude-plugin': 'the manifest, carried by the plugin row itself',
  '.codex-plugin': 'the manifest, carried by the plugin row itself',
};

class RootsError extends Error {}

function fail(message) {
  throw new RootsError(message);
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const t = typeof value;
  return `${/^[aeiou]/.test(t) ? 'an' : 'a'} ${t}`;
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
  // A `roots` key of the wrong type is exactly the case the reasoning above
  // covers, and it used to fall through to "has neither roots nor skillRoots",
  // which is a different complaint and sends you looking for a key that is
  // right there in the file.
  if ('roots' in parsed && !Array.isArray(parsed.roots)) {
    fail(`roots.js: ${CONFIG} has a "roots" key that is ${describeType(parsed.roots)} rather than an array. Fix or remove it.`);
  }
  if ('skillRoots' in parsed && !Array.isArray(parsed.skillRoots)) {
    fail(`roots.js: ${CONFIG} has a "skillRoots" key that is ${describeType(parsed.skillRoots)} rather than an array. Fix or remove it.`);
  }

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

  // Two roots may not share a name. --name filters by it, and the answer to
  // "does this root exist" cannot be two different things: with a duplicate,
  // cmdCheck described the first match while codeFor graded both, so it printed
  // "Root 'x' exists" and exited 3 at the same time.
  const seen = new Set();
  for (const r of all) {
    if (seen.has(r.name)) {
      fail(`roots.js: more than one root is named '${r.name}'. Names identify a root to --name and to a queue entry's repo field, so they have to be unique.`);
    }
    seen.add(r.name);
  }

  // `!== undefined`, not truthiness. An empty --name reached this as '' and
  // skipped the filter, so a caller asking about one root silently got an
  // answer about all of them, which is the inference this whole option removes.
  // parseArgs refuses an empty value too; this is the second lock on the same
  // door, because the two failures look identical from the caller's side.
  let roots = all;
  if (kind !== undefined && kind !== null) roots = roots.filter((r) => r.kind === kind);
  if (name !== undefined && name !== null) roots = roots.filter((r) => r.name === name);
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
  if (state.allMissing) return ALL_MISSING;
  // Missing, but nobody wrote these paths down. Distinct from 3 so a caller can
  // have one rule for each rather than re-deriving the difference from the text.
  return state.usedDefaults ? DEFAULTS_ABSENT : SOME_MISSING;
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
    // fault. It still exits non-zero, because the directory is still not there
    // and a caller about to use it has to know: codeFor returns DEFAULTS_ABSENT
    // so that "absent" and "someone's configured path moved" are separable
    // without reading the prose. All of them absent is ALL_MISSING, because
    // then there is nowhere to look at all.
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

// Ready-to-run listings for a plugin-repo root, generated from the one list
// above so the two skills cannot answer differently. Without --slug it lists
// everything, which is what /audit-deps needs. With --slug it looks for one
// name, which is what /built-check needs. Both modes walk the same rows, so a
// directory added for one is present in the other by construction.
function cmdLayout(args) {
  const root = args.root ? expand(args.root) : '<root.path>';
  const slug = args.slug;

  const rows = [
    ...PLUGIN_LAYOUT.map((r) => ({ ...r, under: 'plugins/*/' })),
    ...REPO_LAYOUT.map((r) => ({ ...r, under: '' })),
  ].flatMap((r) => (slug ? r.find : [r.list]).map((pattern) => ({
    kind: r.kind,
    command: `${r.dirOnly && !slug ? 'ls -1d' : 'ls -1 '} ${root}/${r.under}${pattern.replace(/<slug>/g, slug)} 2>/dev/null`,
  })));

  const width = Math.max(...rows.map((r) => r.command.length));
  process.stdout.write(
    rows.map((r) => `${r.command.padEnd(width + 3)}# kind: ${r.kind}`).join('\n') + '\n',
  );
  return OK;
}

// Answer one exact, machine-readable coverage question. `where` remains free
// prose and never reaches this command; callers pass the optional
// `destination_root` field through a file so user text is not interpolated into
// a shell command. A missing name is different from a configured path that has
// moved, because their remedies are different.
function cmdCoverage(args) {
  if (args._.length > 0) {
    fail('roots.js: coverage takes --name-file, not a positional destination.');
  }
  if (args['name-file'] === undefined) {
    fail('roots.js: coverage requires --name-file with a file containing the exact destination root name.');
  }
  let name;
  try {
    name = fs.readFileSync(expand(args['name-file']), 'utf8').trim();
  } catch (error) {
    fail(`roots.js: could not read --name-file ${JSON.stringify(args['name-file'])} (${error.message}).`);
  }
  if (!name) fail('roots.js: --name-file must contain a root name.');

  const state = resolve({ name });
  const root = state.roots[0];
  const answer = !root
    ? 'not-configured'
    : root.exists
      ? 'covered'
      : state.usedDefaults ? 'default-missing' : 'root-missing';
  process.stdout.write(JSON.stringify({ answer, root: name }) + '\n');
  return OK;
}

// --- argument parsing ----------------------------------------------------

// Same shape as queue.js on purpose, including refusing an unknown option
// rather than turning it into a silent boolean. A typo that is ignored is a
// caller believing it asked for something it did not.
//
// Scoped per command rather than pooled. Pooled, `check --root X` was accepted
// and did nothing, which is the same silent-acceptance fault one level up: the
// option is real, it is simply meaningless to the command it was handed to, and
// nothing said so.
const COMMAND_OPTS = {
  list: new Set(['kind', 'name']),
  check: new Set(['kind', 'name']),
  layout: new Set(['root', 'slug']),
  coverage: new Set(['name-file']),
};

function parseArgs(command, argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { out._.push(token); continue; }

    const eq = token.indexOf('=');
    const name = eq > 2 ? token.slice(2, eq) : token.slice(2);
    let value = eq > 2 ? token.slice(eq + 1) : undefined;

    const allowed = COMMAND_OPTS[command] || new Set();
    if (!allowed.has(name)) {
      // Two different mistakes, and they want different sentences. A name no
      // command knows is a typo. A real option handed to the wrong command is
      // someone who has the right idea and the wrong line, and telling them
      // which command does take it is the whole of the answer.
      const elsewhere = Object.keys(COMMAND_OPTS).filter((c) => COMMAND_OPTS[c].has(name));
      const known = `Options for ${command}: ${[...allowed].map((o) => '--' + o).join(', ') || 'none'}`;
      fail(elsewhere.length > 0
        ? `roots.js: ${command} does not take --${name}. It is an option for ${elsewhere.join(' and ')}. ${known}`
        : `roots.js: unknown option --${name}. ${known}`);
    }
    if (value === undefined) {
      if (i + 1 >= argv.length) fail(`roots.js: --${name} needs a value.`);
      value = argv[++i];
    }

    // `--name=` parses to an empty string, which a skill produces whenever it
    // interpolates a field that turned out to be empty. Treated as "no scope"
    // it silently widened the question from one root to all of them. Refused,
    // because a caller that asked to be specific and was not told otherwise
    // will believe it was.
    if (value === '') {
      fail(`roots.js: --${name} was given an empty value. Pass a real one, or leave the option off to ask about everything.`);
    }
    if (name === 'kind' && !KINDS.has(value)) {
      fail(`roots.js: unknown kind ${JSON.stringify(value)}. Known kinds: ${[...KINDS].join(', ')}`);
    }
    out[name] = value;
  }
  return out;
}

const COMMANDS = { list: cmdList, check: cmdCheck, layout: cmdLayout, coverage: cmdCoverage };

function main(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write([
      'roots.js <command>',
      '',
      '  check [--kind K] [--name N]   report any root in scope that is missing',
      '  list  [--kind K] [--name N]   the roots as JSON, each with an exists flag',
      '  layout [--root P] [--slug S]  where a plugin repo keeps things, as listings',
      '  coverage --name-file F         whether one exact destination root was searched',
      '',
      '  layout answers one question for two callers. Without --slug it lists',
      '  everything under a checkout, which is the scan. With --slug it looks for',
      '  one name. Both are generated from a single list in this file, so a new',
      '  place a plugin keeps code is added once and both skills have it. bin/ was',
      '  added to the repository and to neither of the two prose copies this',
      '  replaced, and the launcher every hook starts through was absent from the',
      '  map entirely.',
      '',
      '  --kind and --name scope everything: which roots are looked at, which are',
      '  reported missing, and the exit code. Ask about skill roots and a missing',
      '  hook root is not your answer. Use --name when you are about to work',
      '  inside one particular root and need an answer about that one.',
      '',
      '  Exit codes:',
      '    0  every root in scope exists',
      '    3  a root someone configured is missing',
      '    5  only default locations are absent; nobody configured those paths,',
      '       so this is normal on a machine that installs from marketplaces',
      '    4  nothing to scan: all of them missing, or nothing configured in scope',
      '    1  the config could not be read',
      '',
      '  3 and 5 are separated so a caller can have one rule for each instead of',
      '  re-deriving the difference from the wording. Both mean a directory is',
      '  not there. Only one of them means somebody should go and fix a path.',
      '',
      '  coverage is the exception to the graded exit codes above. Its four',
      '  ordinary answers are carried in the JSON answer field and all exit 0.',
      '  Exit 1 still means the invocation or configuration could not be read.',
      '',
      '  Everything addressed to a person goes to stdout, including the exit-1',
      '  explanation, because the skills relay what was printed. stderr carries',
      '  a stack trace only, which means a bug in this file.',
      '',
      '  Reads only; it never repairs a path.',
      '',
    ].join('\n'));
    return OK;
  }
  const run = COMMANDS[command];
  if (!run) fail(`roots.js: unknown command ${command}. Try --help.`);
  return run(parseArgs(command, argv.slice(1)));
}

if (require.main === module) {
  let code = OK;
  try {
    code = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof RootsError) {
      // Written to stdout, not stderr. Every skill here is told to relay what
      // the check printed, and a skill reads stdout: on stderr, the one case
      // where the config itself is broken produced an empty relay and the
      // skills carried on as though nothing had happened. This is a sentence
      // addressed to a person and it belongs where the other sentences go.
      process.stdout.write(error.message + '\n');
    } else {
      // A bug in this file rather than a message for anyone. The stack is the
      // useful part and stderr is where it belongs.
      process.stderr.write(error.stack + '\n');
    }
    code = 1;
  }
  // process.exitCode, never process.exit, for the reason queue.js gives at
  // length: a write to a pipe on macOS is asynchronous, and every caller here
  // is a skill reading what was printed.
  process.exitCode = code;
}

module.exports = {
  main, resolve, expand, CONFIG, DEFAULT_ROOTS, KINDS,
  OK, SOME_MISSING, ALL_MISSING, DEFAULTS_ABSENT,
  // Exported so the test can reconcile the list against what is on disk. That
  // reconciliation is the guard: a directory that exists in a plugin and is in
  // neither list fails, which is exactly how bin/ would have been caught.
  PLUGIN_LAYOUT, REPO_LAYOUT, NOT_MAPPED,
};
