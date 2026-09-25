#!/usr/bin/env node
// One handoff per thread: the declared thread list, the guarded save, the
// migration, and the pool that stops binding once threads exist.
//
// Run: node tests/session-threads.test.js
//
// Two bugs are behind this. Every wrap wrote a new handoff named after that
// session, so one subject piled up dozens. And every home handoff pooled its
// rules with every other, so a pickup printed hundreds of rules belonging to
// other work. The checks below drive cli.js as a subprocess, because every bug
// this repository has shipped lived in a printing path no test executed.
//
// The design was reviewed five times before any of this was written, and most
// of the checks here pin a specific failure one of those reviews found by
// probing: a retirement carried into a rewritten thread suppressing a rule
// restated elsewhere, an assignment saved before the migration committed
// reviving a retired rule, a draft from before a migration saved after it.

'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'plugins', 'session');
const CLI = path.join(ROOT, 'scripts', 'cli.js');
const handoffs = require(path.join(ROOT, 'scripts', 'handoffs.js'));

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

function tmpHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-thr-')));
}
const dirOf = (home) => path.join(home, '.planning', 'handoffs');
const docPath = (home, slug) => path.join(dirOf(home), `HANDOFF-${slug}.md`);

function run(home, args) {
  return spawnSync(process.execPath, [CLI, ...args, '--home', home], { encoding: 'utf8' });
}
function json(home, args) {
  const r = run(home, [...args, '--json']);
  try { return { status: r.status, body: JSON.parse(r.stdout), err: r.stderr }; } catch (_) {
    throw new Error(`not JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
  }
}

// A handoff written from `wd`, oldest first, so mtime orders them as listed.
function handoff(wd, rules, { worked = 'The subject of this work.', extra = '' } = {}) {
  return [
    '# Session Handoff',
    '**Date:** 2026-09-25',
    `**Working directory:** ${wd}`,
    '',
    '## What was worked on',
    worked,
    '',
    '## Constraints still in force',
    ...rules.map((r) => `- ${r}`),
    '',
    '## Next actions',
    '1. Something.',
    extra,
  ].join('\n');
}

function write(home, docs) {
  fs.mkdirSync(dirOf(home), { recursive: true });
  let t = Date.now() - docs.length * 60000 - 3600000;
  for (const [slug, body] of docs) {
    const p = docPath(home, slug);
    fs.writeFileSync(p, body);
    t += 60000;
    fs.utimesSync(p, new Date(t), new Date(t));
  }
}

function migrate(home, slugs, dispose = {}) {
  const planFile = path.join(home, 'plan.json');
  const plan = run(home, ['migrate', 'plan', '--threads', slugs.join(','), '--out', planFile]);
  assert.strictEqual(plan.status, 0, plan.stdout + plan.stderr);
  const m = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  for (const row of m.lost) row.disposition = dispose.lost ? dispose.lost(row) : 'retire';
  for (const row of m.gained) row.disposition = dispose.gained ? dispose.gained(row) : 'keep';
  fs.writeFileSync(planFile, JSON.stringify(m, null, 2));
  return { planFile, manifest: m };
}

function apply(home, planFile) {
  return json(home, ['migrate', 'apply', planFile, '--accept-narrowing', '--confirm-sessions-restarted']);
}

function setUp() {
  const home = tmpHome();
  write(home, [
    ['old-session', handoff(home, ['Shared old rule.', 'Only in history.'])],
    ['site-thread', handoff(home, ['Shared old rule.', 'Site rule.'], { worked: 'The website. Everything about it.' })],
    ['brand-thread', handoff(home, ['Brand rule.'])],
  ]);
  return home;
}

function registry(home) {
  return JSON.parse(fs.readFileSync(path.join(dirOf(home), 'threads.json'), 'utf8'));
}

function draftFor(home, body) {
  const p = path.join(home, `draft-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(p, body);
  return p;
}

function snapshot(file) {
  const st = fs.statSync(file);
  return { content: fs.readFileSync(file, 'utf8'), mtime: st.mtimeMs };
}

// ---------------------------------------------------------- before migration

check('before migration, a thread pickup gets the same pool as before', () => {
  const home = setUp();
  const byThread = json(home, ['constraints', '--thread', 'site-thread']).body;
  const byCwd = json(home, ['constraints', '--cwd', home]).body;
  assert.deepStrictEqual(byThread.constraints.map((c) => c.text), byCwd.constraints.map((c) => c.text),
    'installing the upgrade alone changed what a pickup is told is binding');
  assert.ok(byThread.constraints.some((c) => c.text === 'Only in history.'), 'the pool is still the pool');
});

check('before migration, save refuses and says threads are not set up', () => {
  const home = setUp();
  const before = snapshot(docPath(home, 'site-thread'));
  const r = json(home, ['save', '--thread', 'site-thread', '--from', draftFor(home, handoff(home, ['x'])), '--base', 'none', '--generation', '1']);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.reason, 'pre-migration');
  assert.deepStrictEqual(snapshot(docPath(home, 'site-thread')), before);
});

// ----------------------------------------------------------------- the plan

check('the plan writes nothing to any handoff', () => {
  const home = setUp();
  const before = ['old-session', 'site-thread', 'brand-thread'].map((s) => snapshot(docPath(home, s)));
  const r = json(home, ['migrate', 'plan', '--threads', 'site-thread,brand-thread']);
  assert.strictEqual(r.status, 0, JSON.stringify(r.body));
  assert.deepStrictEqual(['old-session', 'site-thread', 'brand-thread'].map((s) => snapshot(docPath(home, s))), before);
  assert.ok(!fs.existsSync(path.join(dirOf(home), 'threads.json')), 'a plan declared threads');
});

check('the plan lists rules lost, rules gained, and what each thread binds', () => {
  const home = tmpHome();
  write(home, [
    ['keeper-thread', handoff(home, ['Retired elsewhere.', 'Kept.'])],
    ['history', handoff(home, ['Lost rule.', 'Retired this session: Retired elsewhere, because done.'])],
  ]);
  const m = json(home, ['migrate', 'plan', '--threads', 'keeper-thread']).body;
  assert.deepStrictEqual(m.lost.map((r) => r.text), ['Lost rule.']);
  // Declaring a thread must not quietly bring back a rule a newer document
  // retired. It appears here and needs a keep or a drop.
  assert.deepStrictEqual(m.gained.map((r) => r.text), ['Retired elsewhere.']);
  assert.deepStrictEqual(m.perThread, [{ slug: 'keeper-thread', bindingToday: 2, bindingAfter: 2 }]);
});

check('the plan refuses archived, protected and non-home handoffs', () => {
  const home = setUp();
  fs.mkdirSync(path.join(dirOf(home), 'archived'), { recursive: true });
  fs.writeFileSync(path.join(dirOf(home), 'archived', 'HANDOFF-gone-thread.md'), handoff(home, ['x']));
  write(home, [['elsewhere-thread', handoff('/somewhere/else', ['y'])]]);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'session.config.json'), JSON.stringify({ protectedHandoffs: [docPath(home, 'brand-thread')] }));
  for (const slug of ['gone-thread', 'elsewhere-thread', 'brand-thread']) {
    const r = json(home, ['migrate', 'plan', '--threads', slug]);
    assert.strictEqual(r.status, 1, `${slug} was accepted as a thread`);
  }
});

// ---------------------------------------------------------------- apply ----

check('apply needs the narrowing accepted and the sessions restarted', () => {
  const home = setUp();
  const { planFile } = migrate(home, ['site-thread', 'brand-thread']);
  assert.strictEqual(json(home, ['migrate', 'apply', planFile, '--confirm-sessions-restarted']).body.reason, 'narrowing-not-accepted');
  assert.strictEqual(json(home, ['migrate', 'apply', planFile, '--accept-narrowing']).body.reason, 'sessions');
  assert.ok(!fs.existsSync(path.join(dirOf(home), 'threads.json')));
});

check('apply refuses a row with no disposition', () => {
  const home = setUp();
  const planFile = path.join(home, 'plan.json');
  run(home, ['migrate', 'plan', '--threads', 'site-thread,brand-thread', '--out', planFile]);
  const r = apply(home, planFile);
  assert.strictEqual(r.body.reason, 'dispositions');
  assert.ok(!fs.existsSync(path.join(dirOf(home), 'threads.json')));
});

check('apply refuses when any home handoff changed after the plan', () => {
  const home = setUp();
  const { planFile } = migrate(home, ['site-thread', 'brand-thread']);
  const p = docPath(home, 'old-session');
  const t = new Date();
  fs.utimesSync(p, t, t); // content the same, order changed: that alone can change today's answer
  const r = apply(home, planFile);
  assert.strictEqual(r.body.reason, 'changed-since-plan');
  assert.ok(!fs.existsSync(path.join(dirOf(home), 'threads.json')));
});

check('apply commits the list, then writes assigned rules into their threads', () => {
  const home = setUp();
  const { planFile } = migrate(home, ['site-thread', 'brand-thread'], {
    lost: (row) => (row.text === 'Only in history.' ? 'thread:site-thread' : 'retire'),
  });
  const r = apply(home, planFile);
  assert.strictEqual(r.body.committed, true, JSON.stringify(r.body));
  assert.strictEqual(r.body.remaining, 0);
  const reg = registry(home);
  assert.deepStrictEqual(reg.threads.map((t) => t.slug), ['site-thread', 'brand-thread']);
  assert.deepStrictEqual(reg.pending, []);
  const site = json(home, ['constraints', '--thread', 'site-thread']).body;
  assert.deepStrictEqual(site.constraints.map((c) => c.text), ['Shared old rule.', 'Site rule.', 'Only in history.']);
});

check('a gained rule marked drop is removed from its thread', () => {
  const home = tmpHome();
  write(home, [
    ['keeper-thread', handoff(home, ['Retired elsewhere.', 'Kept.'])],
    ['history', handoff(home, ['Retired this session: Retired elsewhere, because done.'])],
  ]);
  const { planFile } = migrate(home, ['keeper-thread'], { gained: () => 'drop' });
  apply(home, planFile);
  const t = json(home, ['constraints', '--thread', 'keeper-thread']).body;
  assert.deepStrictEqual(t.constraints.map((c) => c.text), ['Kept.']);
});

// ------------------------------------------------------- after migration ----

function migrated() {
  const home = setUp();
  const { planFile } = migrate(home, ['site-thread', 'brand-thread']);
  const r = apply(home, planFile);
  assert.strictEqual(r.body.committed, true, JSON.stringify(r.body));
  return home;
}

check('a thread binds only its own file', () => {
  const home = migrated();
  const t = json(home, ['constraints', '--thread', 'brand-thread']).body;
  assert.deepStrictEqual(t.constraints.map((c) => c.text), ['Brand rule.']);
  assert.strictEqual(t.binding, true);
});

check('a newer document retiring a thread rule does not reach into the thread', () => {
  const home = migrated();
  write(home, [['later', handoff(home, ['Retired this session: Brand rule, because elsewhere.'])]]);
  const t = json(home, ['constraints', '--thread', 'brand-thread']).body;
  assert.deepStrictEqual(t.constraints.map((c) => c.text), ['Brand rule.'],
    'retirement across documents is the mtime-ordered pool this change exists to leave behind');
});

check('the home pool is labelled history once threads exist', () => {
  const home = migrated();
  const pool = json(home, ['constraints', '--cwd', home]).body;
  assert.strictEqual(pool.binding, false);
  assert.ok(!pool.constraints.some((c) => c.from === 'site-thread' || c.from === 'brand-thread'),
    'a declared thread was counted into a pool');
  assert.match(run(home, ['constraints', '--cwd', home]).stdout, /^History, not binding/);
});

check('a history slug binds nothing and says so', () => {
  const home = migrated();
  const t = json(home, ['constraints', '--thread', 'old-session']);
  assert.strictEqual(t.body.binding, false);
  assert.strictEqual(t.body.kind, 'history');
});

check('find answers a declared thread from the thread list, with its rev', () => {
  const home = migrated();
  const f = json(home, ['find', 'site-thread']).body;
  assert.strictEqual(f.match.kind, 'thread');
  assert.strictEqual(f.thread.path, docPath(home, 'site-thread'));
  assert.match(f.thread.rev, /^[0-9a-f]{64}$/);
  assert.strictEqual(f.thread.generation, registry(home).generation);
});

check('a declared thread whose file is gone is an error, not history', () => {
  const home = migrated();
  fs.rmSync(docPath(home, 'brand-thread'));
  const f = run(home, ['find', 'brand-thread']);
  assert.strictEqual(f.status, 1);
  assert.match(f.stdout, /declared thread, and its file/);
});

// ------------------------------------------------------------------ save ----

function saveArgs(home, slug, body, overrides = {}) {
  const f = json(home, ['find', slug]).body;
  return ['save', '--thread', slug, '--from', draftFor(home, body),
    '--base', overrides.base || (f.thread ? f.thread.rev : 'none'),
    '--generation', String(overrides.generation || registry(home).generation),
    ...(overrides.create ? ['--create'] : [])];
}

check('save rewrites the thread in place and never makes a second file', () => {
  const home = migrated();
  const before = fs.readdirSync(dirOf(home)).filter((n) => n.startsWith('HANDOFF-')).sort();
  const r = json(home, saveArgs(home, 'brand-thread', handoff(home, ['Brand rule.', 'New rule.'])));
  assert.strictEqual(r.body.saved, true, JSON.stringify(r.body));
  assert.deepStrictEqual(fs.readdirSync(dirOf(home)).filter((n) => n.startsWith('HANDOFF-')).sort(), before);
  assert.deepStrictEqual(json(home, ['constraints', '--thread', 'brand-thread']).body.constraints.map((c) => c.text),
    ['Brand rule.', 'New rule.']);
});

check('a removed rule restated later binds again', () => {
  const home = migrated();
  json(home, saveArgs(home, 'brand-thread', handoff(home, ['Retired this session: Brand rule, because paused.'])));
  assert.deepStrictEqual(json(home, ['constraints', '--thread', 'brand-thread']).body.constraints, []);
  json(home, saveArgs(home, 'brand-thread', handoff(home, ['Brand rule.'])));
  assert.deepStrictEqual(json(home, ['constraints', '--thread', 'brand-thread']).body.constraints.map((c) => c.text), ['Brand rule.']);
});

check('save refuses a stale base and leaves the file byte-identical', () => {
  const home = migrated();
  const stale = json(home, ['find', 'brand-thread']).body.thread.rev;
  json(home, saveArgs(home, 'brand-thread', handoff(home, ['Other session.'])));
  const between = snapshot(docPath(home, 'brand-thread'));
  const r = json(home, saveArgs(home, 'brand-thread', handoff(home, ['Mine.']), { base: stale }));
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.reason, 'conflict');
  assert.ok(r.body.draft && fs.existsSync(r.body.draft), 'the draft is kept so the work is not lost');
  assert.deepStrictEqual(snapshot(docPath(home, 'brand-thread')), between);
});

check('save refuses a draft prepared under another generation', () => {
  const home = migrated();
  const before = snapshot(docPath(home, 'brand-thread'));
  const r = json(home, saveArgs(home, 'brand-thread', handoff(home, ['x']), { generation: 1 }));
  assert.strictEqual(r.body.reason, 'generation');
  assert.deepStrictEqual(snapshot(docPath(home, 'brand-thread')), before);
});

check('save refuses an undeclared slug and a draft from outside home', () => {
  const home = migrated();
  assert.strictEqual(json(home, saveArgs(home, 'old-session', handoff(home, ['x']))).body.reason, 'not-declared');
  assert.strictEqual(json(home, saveArgs(home, 'brand-thread', handoff('/elsewhere', ['x']))).body.reason, 'out-of-scope');
});

check('save refuses a protected thread', () => {
  const home = migrated();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'session.config.json'), JSON.stringify({ protectedHandoffs: [docPath(home, 'brand-thread')] }));
  const before = snapshot(docPath(home, 'brand-thread'));
  assert.strictEqual(json(home, saveArgs(home, 'brand-thread', handoff(home, ['x']))).body.reason, 'protected');
  assert.deepStrictEqual(snapshot(docPath(home, 'brand-thread')), before);
});

check('save --create makes a new thread and declares it', () => {
  const home = migrated();
  const r = json(home, saveArgs(home, 'stickers-thread', handoff(home, ['Sticker rule.']), { create: true, base: 'none' }));
  assert.strictEqual(r.body.saved, true, JSON.stringify(r.body));
  assert.strictEqual(r.body.declared, true);
  assert.ok(registry(home).threads.some((t) => t.slug === 'stickers-thread'));
  assert.deepStrictEqual(json(home, ['constraints', '--thread', 'stickers-thread']).body.constraints.map((c) => c.text), ['Sticker rule.']);
});

check('save --create refuses to overwrite an existing undeclared file', () => {
  const home = migrated();
  const before = snapshot(docPath(home, 'old-session'));
  const r = json(home, saveArgs(home, 'old-session', handoff(home, ['x']), { create: true, base: 'none' }));
  // Its own reason, not `conflict`: a conflict tells the wrap to merge into
  // what is there, and merging an unrelated old handoff into a new thread is
  // exactly wrong.
  assert.strictEqual(r.body.reason, 'name-taken');
  assert.deepStrictEqual(snapshot(docPath(home, 'old-session')), before);
});

check('rewriting a thread leaves every pool result unchanged', () => {
  const home = migrated();
  const repo = path.join(home, 'work');
  fs.mkdirSync(repo, { recursive: true });
  write(home, [['repo-work', handoff(repo, ['Repo rule.'])]]);
  const before = [json(home, ['constraints', '--cwd', home]).body.constraints, json(home, ['constraints', '--cwd', repo]).body.constraints];
  json(home, saveArgs(home, 'site-thread', handoff(home, ['Retired this session: Shared old rule, because moved.', 'Site rule.'])));
  const after = [json(home, ['constraints', '--cwd', home]).body.constraints, json(home, ['constraints', '--cwd', repo]).body.constraints];
  assert.deepStrictEqual(after, before);
});

// -------------------------------------------------------------- pending ----

check('an unfinished migration refuses reads and saves until finished', () => {
  const home = migrated();
  const reg = registry(home);
  reg.pending = [{ kind: 'add', slug: 'brand-thread', text: 'Pending rule.' }];
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), JSON.stringify(reg));
  const c = json(home, ['constraints', '--thread', 'brand-thread']);
  assert.strictEqual(c.status, 1);
  assert.strictEqual(c.body.refused, 'migration-unfinished');
  assert.deepStrictEqual(c.body.pending.map((p) => p.text), ['Pending rule.'], 'the pending rule is named, not hidden');
  assert.strictEqual(json(home, saveArgs(home, 'brand-thread', handoff(home, ['x']))).body.reason, 'migration-unfinished');

  const f = json(home, ['migrate', 'finish']);
  assert.strictEqual(f.body.remaining, 0, JSON.stringify(f.body));
  assert.deepStrictEqual(json(home, ['constraints', '--thread', 'brand-thread']).body.constraints.map((x) => x.text), ['Brand rule.', 'Pending rule.']);
});

// ------------------------------------------------------ list and sweep ----

check('an invalid thread list blocks writes and reports on reads', () => {
  const home = migrated();
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  const before = snapshot(docPath(home, 'brand-thread'));
  assert.strictEqual(json(home, ['save', '--thread', 'brand-thread', '--from', draftFor(home, handoff(home, ['x'])), '--base', 'none', '--generation', '1']).body.reason, 'registry-invalid');
  assert.strictEqual(json(home, ['constraints', '--thread', 'brand-thread']).body.refused, 'registry-invalid');
  assert.strictEqual(run(home, ['archive']).status, 1, 'the sweep ran on a thread list it could not read');
  assert.deepStrictEqual(snapshot(docPath(home, 'brand-thread')), before);
});

check('the sweep never moves a declared thread or a protected file, and never renames over the archive', () => {
  const home = migrated();
  const old = Date.now() - 90 * 86400000;
  const age = (p) => fs.utimesSync(p, new Date(old), new Date(old));
  write(home, [['kept-safe', handoff(home, ['x'])], ['dup', handoff(home, ['y'])]]);
  fs.mkdirSync(path.join(dirOf(home), 'archived'), { recursive: true });
  fs.writeFileSync(path.join(dirOf(home), 'archived', 'HANDOFF-dup.md'), 'the older one');
  for (const s of ['site-thread', 'kept-safe', 'dup']) age(docPath(home, s));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'session.config.json'), JSON.stringify({ protectedHandoffs: ['~/.planning/handoffs/HANDOFF-kept-safe.md'] }));
  const protectedBefore = snapshot(docPath(home, 'kept-safe'));

  const r = json(home, ['archive']).body;
  assert.ok(fs.existsSync(docPath(home, 'site-thread')), 'a declared thread was archived');
  assert.deepStrictEqual(snapshot(docPath(home, 'kept-safe')), protectedBefore, 'a protected file was touched');
  assert.deepStrictEqual(r.protectedSkipped, ['HANDOFF-kept-safe.md']);
  assert.deepStrictEqual(r.collisions, ['HANDOFF-dup.md']);
  assert.strictEqual(fs.readFileSync(path.join(dirOf(home), 'archived', 'HANDOFF-dup.md'), 'utf8'), 'the older one');
});

check('an unreadable protection list stops the sweep and moves nothing', () => {
  const home = setUp();
  const old = Date.now() - 90 * 86400000;
  fs.utimesSync(docPath(home, 'old-session'), new Date(old), new Date(old));
  const before = snapshot(docPath(home, 'old-session'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'session.config.json'), '{ "protectedHandoffs": [ 42 ] }');
  const r = run(home, ['archive']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /Sweep refused/);
  assert.deepStrictEqual(snapshot(docPath(home, 'old-session')), before);
});

check('a bad protection entry does not break the unrelated commands', () => {
  const home = setUp();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'session.config.json'), '{ "protectedHandoffs": "nope" }');
  assert.strictEqual(run(home, ['mcp-status']).status, 0);
  assert.strictEqual(run(home, ['memory-check']).status, 0);
});

check('target will not hand out a declared thread', () => {
  const home = migrated();
  const r = json(home, ['target', 'site thread', '--cwd', home]);
  assert.strictEqual(r.status, 1);
  assert.match(r.body.refused, /declared thread/);
  assert.strictEqual(r.body.path, undefined, 'a refusal still carried a writable path');
});

check('target will not hand out a protected path, and carries no path when it refuses', () => {
  const home = setUp();
  const repo = path.join(home, 'code', 'guarded');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'session.config.json'), JSON.stringify({ protectedHandoffs: [path.join(repo, 'HANDOFF.md')] }));
  const r = json(home, ['target', 'x', '--cwd', repo]);
  assert.strictEqual(r.status, 1);
  assert.match(r.body.refused, /protected/);
  assert.strictEqual(r.body.path, undefined);
});

// ------------------------------------ outside the home scope, after migration

check('after migration, a project handoff still gets its pooled rules', () => {
  const home = migrated();
  const repo = path.join(home, 'Projects', 'app');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  // Recorded the way a real wrap records it, through target. The pool reads
  // the handoffs the index knows about, before migration and after.
  assert.strictEqual(json(home, ['target', 'x', '--cwd', repo]).body.recorded, true);
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), handoff(repo, ['Repo rule.']));
  const r = json(home, ['constraints', '--thread', 'app']);
  assert.strictEqual(r.status, 0, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.constraints.map((c) => c.text), ['Repo rule.'],
    'migrating the home scope took the rules away from a project it never touched');
});

check('after migration, a central handoff from another directory is not history', () => {
  const home = migrated();
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(elsewhere);
  write(home, [['away-work', handoff(elsewhere, ['Away rule.'])]]);
  const f = json(home, ['find', 'away-work']).body;
  assert.ok(!f.match.history, 'a handoff outside the home scope was called history');
  assert.deepStrictEqual(json(home, ['constraints', '--thread', 'away-work']).body.constraints.map((c) => c.text), ['Away rule.']);
});

check('before migration, --thread for an unknown slug is an error, not the local pool', () => {
  const home = setUp();
  const r = json(home, ['constraints', '--thread', 'no-such-thing', '--cwd', home]);
  assert.strictEqual(r.status, 1);
  assert.deepStrictEqual(r.body.constraints, []);
  assert.match(r.body.error, /no handoff found/);
});

// ------------------------------------------------------ more migration ----

check('a gained rule marked drop leaves every thread that holds it', () => {
  const home = tmpHome();
  write(home, [
    ['a-thread', handoff(home, ['Old rule.', 'A.'])],
    ['b-thread', handoff(home, ['Old rule.', 'B.'])],
    ['history', handoff(home, ['Retired this session: Old rule, because gone.'])],
  ]);
  const { planFile, manifest } = migrate(home, ['a-thread', 'b-thread'], { gained: () => 'drop' });
  assert.deepStrictEqual(manifest.gained.map((g) => g.threads), [['a-thread', 'b-thread']]);
  apply(home, planFile);
  assert.deepStrictEqual(json(home, ['constraints', '--thread', 'a-thread']).body.constraints.map((c) => c.text), ['A.']);
  assert.deepStrictEqual(json(home, ['constraints', '--thread', 'b-thread']).body.constraints.map((c) => c.text), ['B.'],
    'dropped from the first thread and left binding in the second');
});

check('the plan refuses when a home handoff cannot be read', () => {
  const home = setUp();
  const p = docPath(home, 'old-session');
  fs.chmodSync(p, 0o000);
  try {
    const r = json(home, ['migrate', 'plan', '--threads', 'site-thread']);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.body.reason, 'unreadable');
  } finally {
    fs.chmodSync(p, 0o644);
  }
});

check('migrate finish will not write into a protected thread', () => {
  const home = migrated();
  const reg = registry(home);
  reg.pending = [{ kind: 'add', slug: 'brand-thread', text: 'Pending rule.' }];
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), JSON.stringify(reg));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'session.config.json'), JSON.stringify({ protectedHandoffs: [docPath(home, 'brand-thread')] }));
  const before = snapshot(docPath(home, 'brand-thread'));
  const f = json(home, ['migrate', 'finish']);
  assert.strictEqual(f.status, 1);
  assert.strictEqual(f.body.finished, false);
  assert.match(f.body.failures[0].error, /protected/);
  assert.deepStrictEqual(snapshot(docPath(home, 'brand-thread')), before);
});

check('a new thread cannot take a slug the index gives to another document', () => {
  const home = migrated();
  const repo = path.join(home, 'far', 'foo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), '# theirs');
  const idxFile = path.join(dirOf(home), 'index.json');
  const idx = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : { version: 1, handoffs: {} };
  idx.handoffs.foo = { path: path.join(repo, 'HANDOFF.md'), kind: 'project', recorded_at: new Date().toISOString() };
  fs.writeFileSync(path.join(dirOf(home), 'index.json'), JSON.stringify(idx));
  const r = json(home, saveArgs(home, 'foo', handoff(home, ['x']), { create: true, base: 'none' }));
  assert.strictEqual(r.body.reason, 'name-taken');
  assert.ok(!fs.existsSync(docPath(home, 'foo')));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dirOf(home), 'index.json'), 'utf8')).handoffs.foo.path, path.join(repo, 'HANDOFF.md'));
});

check('a thread list naming a non-central path is invalid', () => {
  const home = migrated();
  const reg = registry(home);
  reg.threads[0].path = '/tmp/elsewhere/HANDOFF.md';
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), JSON.stringify(reg));
  assert.strictEqual(json(home, ['threads']).status, 1);
  assert.strictEqual(json(home, ['threads']).body.mode, 'invalid');
});

check('a refusal exits nonzero in JSON as well as text', () => {
  const home = migrated();
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  assert.strictEqual(json(home, ['archive']).status, 1);
  assert.strictEqual(json(home, ['threads']).status, 1);
});

check('a busy lock refuses the save with reason busy and changes nothing', () => {
  const home = migrated();
  const args = saveArgs(home, 'brand-thread', handoff(home, ['x']));
  const before = snapshot(docPath(home, 'brand-thread'));
  const lock = handoffs.indexLockPath(home);
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), 'another-session');
  try {
    const r = json(home, args);
    assert.strictEqual(r.body.reason, 'busy');
    assert.deepStrictEqual(snapshot(docPath(home, 'brand-thread')), before);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

check('inserting into a CRLF handoff keeps CRLF', () => {
  const t = require(path.join(ROOT, 'scripts', 'threads.js'));
  const out = t.insertBullet('# H\r\n\r\n## Constraints still in force\r\n- a\r\n\r\n## Next\r\n', 'b');
  assert.ok(!/[^\r]\n/.test(out), JSON.stringify(out));
  assert.deepStrictEqual(handoffs.constraintsIn(out.replace(/\r/g, '')), ['a', 'b']);
});

// ------------------------------------------------------------ the CLI ----

check('capabilities answers in JSON', () => {
  const home = tmpHome();
  assert.deepStrictEqual(json(home, ['capabilities']).body, { threads: 1 });
});

check('an unknown flag or a missing value is an error, never an argument', () => {
  const home = tmpHome();
  const a = run(home, ['constraints', '--thred', 'x']);
  assert.strictEqual(a.status, 2);
  assert.match(a.stderr, /unknown flag --thred/);
  const b = run(home, ['constraints', '--thread']);
  assert.strictEqual(b.status, 2);
  assert.match(b.stderr, /--thread needs a value/);
});

check('threads lists subjects for a wrap to choose from', () => {
  const home = migrated();
  const t = json(home, ['threads']).body;
  assert.deepStrictEqual(t.threads.map((x) => x.slug).sort(), ['brand-thread', 'site-thread']);
  assert.strictEqual(t.threads.find((x) => x.slug === 'site-thread').subject, 'The website.');
});

check('the pool scan applies its ceiling after filtering by scope', () => {
  // The ceiling used to apply across every project first, so another project's
  // volume of handoffs could push this one's oldest carrier out of the window.
  const home = tmpHome();
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(elsewhere);
  write(home, [
    ['mine', handoff(home, ['Mine.'])],
    ['a', handoff(elsewhere, ['A.'])],
    ['b', handoff(elsewhere, ['B.'])],
  ]);
  const r = handoffs.carriedConstraints({ cwd: home, home, limit: 1 });
  assert.deepStrictEqual(r.constraints.map((c) => c.text), ['Mine.']);
  assert.strictEqual(r.truncated, false);
});

// ------------------------------------------------ Devin CLI round one ----

function setIndex(home, slug, entry) {
  const f = path.join(dirOf(home), 'index.json');
  const idx = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { version: 1, handoffs: {} };
  idx.handoffs[slug] = entry;
  fs.writeFileSync(f, JSON.stringify(idx));
}

check('a new thread does not take the slug of a wrap still being written', () => {
  // The in-flight window: target has recorded where a wrap will write, and the
  // file is not there yet. existsSync says free; it is not.
  const home = migrated();
  const repo = path.join(home, 'code', 'inflight');
  fs.mkdirSync(repo, { recursive: true });
  setIndex(home, 'inflight', { path: path.join(repo, 'HANDOFF.md'), kind: 'project', recorded_at: new Date().toISOString() });
  const r = json(home, saveArgs(home, 'inflight', handoff(home, ['x']), { create: true, base: 'none' }));
  assert.strictEqual(r.body.reason, 'name-taken');
  assert.strictEqual(handoffs.readIndex(home).inflight.path, path.join(repo, 'HANDOFF.md'));
});

check('a new thread does not take the slug of a handoff on an unmounted disk', () => {
  const home = migrated();
  setIndex(home, 'offline', { path: path.join(home, 'Volumes', 'gone', 'HANDOFF.md'), kind: 'project', recorded_at: '2026-01-01T00:00:00.000Z' });
  const r = json(home, saveArgs(home, 'offline', handoff(home, ['x']), { create: true, base: 'none' }));
  assert.strictEqual(r.body.reason, 'name-taken');
});

check('the plan refuses a thread file it cannot read, without crashing', () => {
  const home = setUp();
  fs.chmodSync(docPath(home, 'brand-thread'), 0o000);
  try {
    const r = json(home, ['migrate', 'plan', '--threads', 'brand-thread']);
    assert.strictEqual(r.status, 1);
    assert.ok(['bad-threads', 'unreadable'].includes(r.body.reason), JSON.stringify(r.body));
  } finally {
    fs.chmodSync(docPath(home, 'brand-thread'), 0o644);
  }
});

check('the plan refuses a slug the index maps to a differently named file', () => {
  const home = setUp();
  setIndex(home, 'site-thread', { path: docPath(home, 'old-session'), kind: 'central', recorded_at: '2026-01-01T00:00:00.000Z' });
  const r = json(home, ['migrate', 'plan', '--threads', 'site-thread']);
  assert.strictEqual(r.status, 1);
  assert.match(r.body.detail, /not HANDOFF-site-thread\.md/);
});

check('removing a rule from a CRLF handoff keeps CRLF', () => {
  const t = require(path.join(ROOT, 'scripts', 'threads.js'));
  const out = t.dropBullet('# H\r\n\r\n## Constraints still in force\r\n- a\r\n- b\r\n\r\n## Next\r\n', 'a');
  assert.strictEqual(out.removed, true);
  assert.ok(!/[^\r]\n/.test(out.text), JSON.stringify(out.text));
});

check('forget exits nonzero when the lock is refused', () => {
  const home = setUp();
  setIndex(home, 'x', { path: docPath(home, 'old-session'), kind: 'central', recorded_at: '2026-01-01T00:00:00.000Z' });
  const lock = handoffs.indexLockPath(home);
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), 'another-session');
  try {
    const r = json(home, ['forget', 'x']);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.body.refused, true);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

check('after migration target will not hand out an existing history handoff', () => {
  const home = migrated();
  const r = json(home, ['target', 'old session', '--cwd', home]);
  assert.strictEqual(r.status, 1);
  assert.match(r.body.refused, /saved as a thread/);
  assert.strictEqual(r.body.path, undefined);
});

check('declare refuses during an unfinished migration', () => {
  const home = migrated();
  const reg = registry(home);
  reg.pending = [{ kind: 'add', slug: 'brand-thread', text: 'P.' }];
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), JSON.stringify(reg));
  assert.strictEqual(json(home, ['declare', 'old-session']).body.reason, 'migration-unfinished');
});

check('a declared thread written outside home is refused, not read as binding', () => {
  const home = migrated();
  fs.writeFileSync(docPath(home, 'brand-thread'), handoff('/some/project', ['Project rule.']));
  const r = json(home, ['constraints', '--thread', 'brand-thread']);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.refused, 'declared-out-of-scope');
});

check('a broken thread list does not block a project handoff pickup', () => {
  const home = migrated();
  const repo = path.join(home, 'Projects', 'app2');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  json(home, ['target', 'x', '--cwd', repo]);
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), handoff(repo, ['Repo rule.']));
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  const r = json(home, ['constraints', '--thread', 'app2']);
  assert.deepStrictEqual(r.body.constraints.map((c) => c.text), ['Repo rule.']);
  assert.strictEqual(json(home, ['constraints', '--thread', 'brand-thread']).body.refused, 'registry-invalid');
});

check('the constraints list says when a handoff could not be read', () => {
  const home = setUp();
  fs.chmodSync(docPath(home, 'old-session'), 0o000);
  try {
    assert.match(run(home, ['constraints', '--cwd', home]).stdout, /could not be read/);
  } finally {
    fs.chmodSync(docPath(home, 'old-session'), 0o644);
  }
});

// ------------------------------------------------ Devin CLI round two ----

check('after migration target refuses a brand-new home topic too', () => {
  // A session still running the older skill calls target and writes whatever
  // it is given. A new home path would be history the moment it was written.
  const home = migrated();
  const r = json(home, ['target', 'something new', '--cwd', home]);
  assert.strictEqual(r.status, 1);
  assert.match(r.body.refused, /saved as a thread/, 'refused, but for some other reason');
  assert.strictEqual(r.body.path, undefined);
});

check('after migration target still hands out a central path for another directory', () => {
  const home = migrated();
  const elsewhere = path.join(home, 'notes');
  fs.mkdirSync(elsewhere);
  write(home, [['notes-work', handoff(elsewhere, ['x'])]]);
  const r = json(home, ['target', 'notes work', '--cwd', elsewhere]);
  assert.strictEqual(r.status, 0, JSON.stringify(r.body));
  assert.strictEqual(r.body.path, docPath(home, 'notes-work'));
});

check('a broken thread list does not block a central handoff from another directory', () => {
  const home = migrated();
  const elsewhere = path.join(home, 'notes');
  fs.mkdirSync(elsewhere);
  write(home, [['notes-work', handoff(elsewhere, ['Notes rule.'])]]);
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  assert.deepStrictEqual(json(home, ['constraints', '--thread', 'notes-work']).body.constraints.map((c) => c.text), ['Notes rule.']);
});

check('an unreadable declared thread is called unreadable, not missing, and save refuses it plainly', () => {
  const home = migrated();
  const args = saveArgs(home, 'brand-thread', handoff(home, ['x']));
  fs.chmodSync(docPath(home, 'brand-thread'), 0o000);
  try {
    assert.strictEqual(json(home, ['constraints', '--thread', 'brand-thread']).body.refused, 'declared-unreadable');
    assert.match(run(home, ['threads']).stdout, /CANNOT BE READ/);
    assert.strictEqual(json(home, args).body.reason, 'unreadable');
  } finally {
    fs.chmodSync(docPath(home, 'brand-thread'), 0o644);
  }
});

check('a hand-edited plan with the wrong shape is refused, not crashed on', () => {
  const home = setUp();
  const planFile = path.join(home, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify({ kind: 'session-threads-migration', version: 1, threads: [], lost: 'nope', gained: [] }));
  const r = json(home, ['migrate', 'apply', planFile, '--accept-narrowing', '--confirm-sessions-restarted']);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.reason, 'manifest');
  assert.doesNotMatch(r.err, /TypeError/);
});

check('a new thread does not take a path another wrap has just recorded for itself', () => {
  const home = migrated();
  setIndex(home, 'samepath', { path: docPath(home, 'samepath'), kind: 'central', recorded_at: new Date().toISOString() });
  const r = json(home, saveArgs(home, 'samepath', handoff(home, ['x']), { create: true, base: 'none' }));
  assert.strictEqual(r.body.reason, 'name-taken');
  assert.ok(!fs.existsSync(docPath(home, 'samepath')));
});

check('find says in plain text when a match is history', () => {
  const home = migrated();
  assert.match(run(home, ['find', 'old-session']).stdout, /Kept as history/);
});

// ----------------------------------------------------- Devin app round ----

check('a dangling thread list symlink is invalid, not absent', () => {
  const home = migrated();
  const f = path.join(dirOf(home), 'threads.json');
  fs.rmSync(f);
  fs.symlinkSync(path.join(home, 'nowhere.json'), f);
  assert.strictEqual(json(home, ['threads']).body.mode, 'invalid');
  assert.strictEqual(run(home, ['archive']).status, 1, 'the sweep ran as if no threads were declared');
});

check('a dangling config symlink fails closed', () => {
  const home = setUp();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(path.join(home, 'nowhere.json'), path.join(home, '.claude', 'session.config.json'));
  const old = Date.now() - 90 * 86400000;
  fs.utimesSync(docPath(home, 'old-session'), new Date(old), new Date(old));
  assert.strictEqual(run(home, ['archive']).status, 1);
  assert.ok(fs.existsSync(docPath(home, 'old-session')));
});

check('the plain migration plan lists the rules, not only the counts', () => {
  const home = setUp();
  assert.match(run(home, ['migrate', 'plan', '--threads', 'site-thread,brand-thread']).stdout, /- Only in history\.\s+\(from old-session\)/);
});

// ------------------------------------------- persona review of 7e3bcf7 ----

check('a session outside home is not handed an existing home history handoff', () => {
  const home = migrated();
  const notes = path.join(home, 'notes');
  fs.mkdirSync(notes);
  const before = snapshot(docPath(home, 'old-session'));
  const r = json(home, ['target', 'old session', '--cwd', notes]);
  assert.strictEqual(r.status, 1);
  assert.match(r.body.refused, /may be home history/);
  assert.strictEqual(r.body.path, undefined);
  assert.deepStrictEqual(snapshot(docPath(home, 'old-session')), before);
});

check('a broken thread list does not stop target for a project', () => {
  const home = migrated();
  const repo = path.join(home, 'Projects', 'app3');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  const r = json(home, ['target', 'x', '--cwd', repo]);
  assert.strictEqual(r.status, 0, JSON.stringify(r.body));
  assert.strictEqual(r.body.path, path.join(repo, 'HANDOFF.md'));
  assert.strictEqual(json(home, ['target', 'x', '--cwd', home]).status, 1, 'a home write went ahead on a broken list');
});

check('find says a declared thread cannot be read', () => {
  const home = migrated();
  fs.chmodSync(docPath(home, 'brand-thread'), 0o000);
  try {
    const f = json(home, ['find', 'brand-thread']);
    assert.strictEqual(f.status, 1);
    assert.strictEqual(f.body.thread.unreadable, true);
    assert.match(run(home, ['find', 'brand-thread']).stdout, /cannot be read/);
  } finally {
    fs.chmodSync(docPath(home, 'brand-thread'), 0o644);
  }
});

// ------------------------------------------------ Devin CLI round three ----

check('before migration, an unreadable handoff is called unreadable', () => {
  const home = setUp();
  fs.chmodSync(docPath(home, 'old-session'), 0o000);
  try {
    const r = json(home, ['constraints', '--thread', 'old-session']);
    assert.strictEqual(r.status, 1);
    assert.match(r.body.error, /could not be read/);
  } finally {
    fs.chmodSync(docPath(home, 'old-session'), 0o644);
  }
});

check('a declared thread with no Working directory line is not called out of scope', () => {
  const home = migrated();
  fs.writeFileSync(docPath(home, 'brand-thread'), '# Session Handoff\n\n## Constraints still in force\n- x\n');
  assert.strictEqual(json(home, ['constraints', '--thread', 'brand-thread']).body.refused, 'declared-no-directory');
});

check('find says when the thread list cannot be read', () => {
  const home = migrated();
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  const r = run(home, ['find', 'old-session']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /thread list cannot be read/);
});

// ------------------------------------------- persona review of 8abdb9e ----

check('target treats an existing file with no Working directory line as home', () => {
  const home = migrated();
  const notes = path.join(home, 'notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(docPath(home, 'old-notes'), '# Session Handoff\n\n## Constraints still in force\n- x\n');
  const r = json(home, ['target', 'old notes', '--cwd', notes]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.path, undefined);
});

check('target treats an unreadable existing file as home', () => {
  const home = migrated();
  const notes = path.join(home, 'notes');
  fs.mkdirSync(notes);
  fs.chmodSync(docPath(home, 'old-session'), 0o000);
  try {
    const r = json(home, ['target', 'old session', '--cwd', notes]);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.body.path, undefined);
  } finally {
    fs.chmodSync(docPath(home, 'old-session'), 0o644);
  }
});

check('a broken thread list stops central target writes even outside home', () => {
  const home = migrated();
  const notes = path.join(home, 'notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  const r = json(home, ['target', 'brand thread', '--cwd', notes]);
  assert.strictEqual(r.status, 1, 'a declared thread path could be handed out while the list is unreadable');
  assert.strictEqual(r.body.path, undefined);
});

check('find does not fail a project handoff because the thread list is broken', () => {
  const home = migrated();
  const repo = path.join(home, 'Projects', 'app4');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  json(home, ['target', 'x', '--cwd', repo]);
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), handoff(repo, ['R.']));
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  const r = json(home, ['find', 'app4']);
  assert.strictEqual(r.status, 0, JSON.stringify(r.body));
  assert.strictEqual(r.body.listUncertain, false);
  assert.strictEqual(json(home, ['find', 'brand-thread']).body.listUncertain, true);
});

check('find does not call an unreadable non-thread a thread', () => {
  const home = setUp();
  fs.chmodSync(docPath(home, 'old-session'), 0o000);
  try {
    const r = json(home, ['find', 'old-session']);
    assert.ok(r.body.unreadable, 'the JSON does not say it cannot be read');
    assert.doesNotMatch(run(home, ['find', 'old-session']).stdout, /thread's file/);
  } finally {
    fs.chmodSync(docPath(home, 'old-session'), 0o644);
  }
});

// The sweep checks protection and the thread list twice: once before taking
// the lock and again inside it. Every other test trips the first check. These
// make the second answer differ from the first, which is what happens when a
// file changes while the sweep waits for another session's lock.
function sweepWithSecondAnswer(home, stub) {
  const out = spawnSync(process.execPath, ['-e', `
    const cfg = require(${JSON.stringify(path.join(ROOT, 'scripts', 'config.js'))});
    const reg = require(${JSON.stringify(path.join(ROOT, 'scripts', 'registry.js'))});
    let calls = 0;
    ${stub}
    const h = require(${JSON.stringify(path.join(ROOT, 'scripts', 'handoffs.js'))});
    process.stdout.write(JSON.stringify(h.archiveStale({ home: ${JSON.stringify(home)}, days: 30 })));
  `], { encoding: 'utf8' });
  return JSON.parse(out.stdout);
}

check('protection that breaks while the sweep waits for the lock stops it', () => {
  const home = setUp();
  const old = Date.now() - 90 * 86400000;
  fs.utimesSync(docPath(home, 'old-session'), new Date(old), new Date(old));
  const r = sweepWithSecondAnswer(home, `
    const real = cfg.loadProtection;
    cfg.loadProtection = (h) => (++calls === 1 ? real(h) : { ok: false, paths: [], errors: ['changed while waiting'] });`);
  assert.match(String(r.refused), /changed while waiting/);
  assert.deepStrictEqual(r.moved, []);
  assert.ok(fs.existsSync(docPath(home, 'old-session')));
});

check('a thread list that breaks while the sweep waits for the lock stops it', () => {
  const home = setUp();
  const old = Date.now() - 90 * 86400000;
  fs.utimesSync(docPath(home, 'old-session'), new Date(old), new Date(old));
  const r = sweepWithSecondAnswer(home, `
    const real = reg.readRegistry;
    reg.readRegistry = (h) => (++calls === 1 ? real(h) : { state: 'invalid', registry: null, errors: ['changed while waiting'] });`);
  assert.match(String(r.refused), /changed while waiting/);
  assert.deepStrictEqual(r.moved, []);
});

// ------------------------------------------ Devin CLI round 4 and the app ----

check('when home is a git checkout, threads are refused rather than half supported', () => {
  const home = tmpHome();
  spawnSync('git', ['init', '-q'], { cwd: home });
  write(home, [['brand-thread', handoff(home, ['B.'])]]);
  const r = json(home, ['migrate', 'plan', '--threads', 'brand-thread']);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.reason, 'home-is-a-checkout');
});

check('a thread list in a home that became a checkout is not trusted', () => {
  const home = migrated();
  spawnSync('git', ['init', '-q'], { cwd: home });
  assert.strictEqual(json(home, ['threads']).body.mode, 'invalid');
  assert.strictEqual(json(home, saveArgs(home, 'brand-thread', handoff(home, ['x']), { base: 'none', generation: 1 })).body.reason, 'registry-invalid');
});

check('declare re-checks the file under the lock', () => {
  const t = require(path.join(ROOT, 'scripts', 'threads.js'));
  const home = migrated();
  // Removed between the first check and the lock: simulated by removing it
  // inside the locked region, which is where the second check runs.
  const h = require(path.join(ROOT, 'scripts', 'handoffs.js'));
  const real = h.mutateIndex;
  h.mutateIndex = (hm, fn, o) => real(hm, (...a) => { fs.rmSync(docPath(home, 'old-session')); return fn(...a); }, o);
  try {
    const r = t.declareThread({ slug: 'old-session', home });
    assert.strictEqual(r.declared, false);
    assert.strictEqual(r.reason, 'missing');
  } finally {
    h.mutateIndex = real;
  }
  assert.ok(!registry(home).threads.some((x) => x.slug === 'old-session'));
});

// --------------------------------------- persona and Codex on 35ce31a ----

check('with a broken list, an archived home handoff does not get the whole pool', () => {
  const home = migrated();
  fs.mkdirSync(path.join(dirOf(home), 'archived'), { recursive: true });
  fs.renameSync(docPath(home, 'old-session'), path.join(dirOf(home), 'archived', 'HANDOFF-old-session.md'));
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  const r = json(home, ['constraints', '--thread', 'old-session']);
  assert.strictEqual(r.body.refused, 'registry-invalid');
  assert.ok(!(r.body.constraints || []).length);
});

check('a broken list does not let a project stand in for a thread of the same name', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'brand-thread');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  setIndex(home, 'brand-thread', { path: path.join(repo, 'HANDOFF.md'), kind: 'project', recorded_at: '2026-01-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), handoff(repo, ['Repo rule.']));
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  assert.strictEqual(json(home, ['find', 'brand-thread']).body.listUncertain, true);
  assert.strictEqual(json(home, ['constraints', '--thread', 'brand-thread']).body.refused, 'registry-invalid');
});

check('target treats home spelled with a trailing slash as home', () => {
  const home = migrated();
  const r = json(home, ['target', 'x', '--cwd', `${home}/`]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.path, undefined);
});

check('a project named like a declared thread gets its handoff, indexed as name-project', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'brand-thread');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const r = json(home, ['target', 'x', '--cwd', repo]);
  assert.strictEqual(r.status, 0, JSON.stringify(r.body));
  assert.strictEqual(r.body.path, path.join(repo, 'HANDOFF.md'));
  assert.strictEqual(r.body.recorded, true);
  assert.strictEqual(r.body.pickupSlug, 'brand-thread-project');
  fs.writeFileSync(r.body.path, handoff(repo, ['Repo rule.']));
  assert.strictEqual(json(home, ['find', 'brand-thread']).body.match.kind, 'thread');
  assert.strictEqual(json(home, ['find', 'brand-thread-project']).body.match.path, r.body.path);
});

check('a stray empty .git in home stops the plan, so it can never write a list that is then refused', () => {
  const home = setUp();
  fs.mkdirSync(path.join(home, '.git'));
  const r = json(home, ['migrate', 'plan', '--threads', 'site-thread']);
  assert.strictEqual(r.body.reason, 'home-is-a-checkout');
});

check('a project named like a thread with --no-record prints no retry advice', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'brand-thread');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const out = run(home, ['target', 'x', '--cwd', repo, '--no-record']).stdout;
  assert.doesNotMatch(out, /Run this again/);
});

check('a project named like a thread is given name-project as its pickup slug', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'brand-thread');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  assert.strictEqual(json(home, ['target', 'x', '--cwd', repo]).body.pickupSlug, 'brand-thread-project');
});


check('a symlinked home inside a checkout is caught', () => {
  const outer = tmpHome();
  spawnSync('git', ['init', '-q'], { cwd: outer });
  const realHome = path.join(outer, 'me');
  fs.mkdirSync(realHome);
  const link = path.join(fs.realpathSync(os.tmpdir()), `session-link-${process.pid}-${Date.now()}`);
  fs.symlinkSync(realHome, link);
  try {
    assert.strictEqual(require(path.join(ROOT, 'scripts', 'registry.js')).homeIsCheckout(link), true);
  } finally {
    fs.rmSync(link, { force: true });
  }
});

// ------------------------- persona, Codex round 9 and the Devin app on 019480a ----

check('with a broken list, a project whose document names home is refused, not pooled with home', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'app');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), handoff(home, ['App rule.']));
  setIndex(home, 'app', { path: path.join(repo, 'HANDOFF.md'), kind: 'project', recorded_at: '2026-01-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  const r = json(home, ['constraints', '--thread', 'app']);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.refused, 'registry-invalid');
  assert.ok(!(r.body.constraints || []).length);
});

check('with a broken list, a project written from its own repository still gets its own pool', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'app');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), handoff(repo, ['App rule.']));
  setIndex(home, 'app', { path: path.join(repo, 'HANDOFF.md'), kind: 'project', recorded_at: '2026-01-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  const r = json(home, ['constraints', '--thread', 'app']);
  assert.strictEqual(r.status, 0, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.constraints.map((c) => c.text), ['App rule.']);
});

check('an index entry claiming project for a central file does not make it safe while the list is broken', () => {
  const home = migrated();
  setIndex(home, 'alias', { path: docPath(home, 'brand-thread'), kind: 'project', recorded_at: '2026-01-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  const r = json(home, ['find', 'alias']);
  assert.strictEqual(r.body.listUncertain, true);
  assert.strictEqual(r.status, 1);
});

check('a folder sharing home\'s scope is refused while the list cannot be read', () => {
  const home = migrated();
  spawnSync('git', ['init', '-q'], { cwd: home });
  const webby = path.join(home, 'code', 'webby');
  fs.mkdirSync(webby, { recursive: true });
  const r = json(home, ['constraints', '--cwd', webby]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.refused, 'registry-invalid');
  assert.ok(!r.body.constraints.length);
});

check('git finding a repository for home some other way refuses both the plan and the list', () => {
  const home = migrated();
  const outer = tmpHome();
  spawnSync('git', ['init', '-q'], { cwd: outer });
  const env = { ...process.env, GIT_DIR: path.join(outer, '.git'), GIT_WORK_TREE: home };
  const threads = spawnSync(process.execPath, [CLI, 'threads', '--json', '--home', home], { encoding: 'utf8', env });
  assert.strictEqual(JSON.parse(threads.stdout).mode, 'invalid');
  const fresh = setUp();
  const plan = spawnSync(process.execPath, [CLI, 'migrate', 'plan', '--threads', 'site-thread', '--json', '--home', fresh], {
    encoding: 'utf8', env: { ...env, GIT_WORK_TREE: fresh },
  });
  assert.strictEqual(JSON.parse(plan.stdout).reason, 'home-is-a-checkout');
});

check('plain target output gives a project named like a thread its name-project slug, and none unrecorded', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'brand-thread');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const out = run(home, ['target', 'x', '--cwd', repo]).stdout;
  assert.match(out, /pickup slug: brand-thread-project/);
  // An assigned name exists only in the index, so unrecorded it leads nowhere.
  const bare = run(home, ['target', 'y', '--cwd', path.join(home, 'code', 'brand-thread'), '--no-record']);
  const home2 = migrated();
  const repo2 = path.join(home2, 'code', 'brand-thread');
  fs.mkdirSync(path.join(repo2, '.git'), { recursive: true });
  const unrecorded = json(home2, ['target', 'x', '--cwd', repo2, '--no-record']).body;
  assert.strictEqual(unrecorded.pickupSlug, null);
  assert.match(run(home2, ['target', 'x', '--cwd', repo2, '--no-record']).stdout, new RegExp(`/pickup ${repo2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.strictEqual(bare.status, 0);
});

check('wrap checks a null-pickupSlug handoff by its path and ends with the path; pickup accepts one', () => {
  const wrap = fs.readFileSync(path.join(ROOT, 'skills', 'wrap', 'SKILL.md'), 'utf8');
  const pickup = fs.readFileSync(path.join(ROOT, 'skills', 'pickup', 'SKILL.md'), 'utf8');
  assert.match(wrap, /If `target` returned `pickupSlug: null`, do not run that/);
  assert.match(wrap, /\/pickup \[path\]/);
  assert.match(pickup, /If the argument is any other path to a file rather than a name/);
  assert.match(pickup, /constraints --file "<the path>"/);
});

// ------------------------------------------------- Devin CLI round 7 on 5f6ed96 ----

check('the plan refuses a slug the index still maps to an unreachable file', () => {
  const home = setUp();
  setIndex(home, 'site-thread', { path: '/Volumes/not-mounted-here/HANDOFF-x.md', kind: 'project', recorded_at: '2026-01-01T00:00:00.000Z' });
  const r = json(home, ['migrate', 'plan', '--threads', 'site-thread']);
  assert.strictEqual(r.status, 1);
  assert.match(JSON.stringify(r.body), /not reachable now/);
});

check('an index entry whose path is not a string does not crash find', () => {
  const home = migrated();
  setIndex(home, 'site-thread', { path: 42, kind: 'central' });
  const r = run(home, ['find', 'site-thread', '--json']);
  assert.doesNotMatch(r.stderr, /TypeError/);
  assert.ok(JSON.parse(r.stdout).thread.conflicts.length, 'a malformed entry is reported, not ignored');
});

check('an empty --thread is refused rather than answering for the current directory', () => {
  const home = migrated();
  const r = run(home, ['constraints', '--thread', '']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /--thread needs a value/);
});

check('a plan whose rule text was edited, even only in spacing, is refused', () => {
  const home = setUp();
  const { planFile, manifest } = migrate(home, ['site-thread', 'brand-thread']);
  assert.ok(manifest.lost.length, 'the fixture needs a lost row');
  manifest.lost[0].text = manifest.lost[0].text.replace(' ', '\n');
  fs.writeFileSync(planFile, JSON.stringify(manifest, null, 2));
  const r = apply(home, planFile);
  assert.strictEqual(r.body.committed, false);
  assert.ok(!fs.existsSync(path.join(dirOf(home), 'threads.json')));
});

check('a thread path spelled with a trailing slash makes the list invalid', () => {
  const home = migrated();
  const f = path.join(dirOf(home), 'threads.json');
  const reg = JSON.parse(fs.readFileSync(f, 'utf8'));
  reg.threads[0].path += '/';
  fs.writeFileSync(f, JSON.stringify(reg));
  assert.strictEqual(json(home, ['threads']).body.mode, 'invalid');
});

check('a relative protectedHandoffs entry is refused', () => {
  const home = setUp();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'session.config.json'), JSON.stringify({ protectedHandoffs: ['important.md'] }));
  const r = json(home, ['migrate', 'plan', '--threads', 'site-thread']);
  assert.strictEqual(r.body.reason, 'config-invalid');
  assert.match(r.body.detail, /absolute path/);
});

check('recording a project checks the thread list again under the lock', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'brand-thread');
  fs.mkdirSync(repo, { recursive: true });
  const r = handoffs.recordHandoff({ slug: 'brand-thread', target: path.join(repo, 'HANDOFF.md'), kind: 'project', home });
  assert.strictEqual(r.recorded, false);
  assert.strictEqual(r.shadowed, true);
  assert.strictEqual(json(home, ['find', 'brand-thread']).body.thread.conflicts.length, 0);
});

// ------------------------------------------------ Codex round 10 on 5452290 ----

check('while the list cannot be read, a project whose name may be a thread gets name-project', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'brand-thread');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  const r = json(home, ['target', 'x', '--cwd', repo]);
  assert.strictEqual(r.body.path, path.join(repo, 'HANDOFF.md'));
  assert.strictEqual(r.body.pickupSlug, 'brand-thread-project');
});

check('pickup sends a central handoff path through the name lookup', () => {
  const pickup = fs.readFileSync(path.join(ROOT, 'skills', 'pickup', 'SKILL.md'), 'utf8');
  const central = pickup.indexOf('If the argument is a path directly inside `~/.planning/handoffs/`');
  const other = pickup.indexOf('If the argument is any other path');
  assert.ok(central > 0 && other > central, 'the central-path rule has to come before the project-path rule');
});

check('home becoming a checkout part way through a process is seen', () => {
  const reg = require(path.join(ROOT, 'scripts', 'registry.js'));
  const home = tmpHome();
  assert.strictEqual(reg.homeIsCheckout(home), false);
  fs.mkdirSync(path.join(home, '.git'));
  assert.strictEqual(reg.homeIsCheckout(home), true);
});

check('a central handoff that is a symlink to an archived one is not handed out to write through', () => {
  const home = migrated();
  const archived = path.join(dirOf(home), 'archived', 'HANDOFF-kept.md');
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.writeFileSync(archived, handoff(home, ['Kept.']));
  fs.symlinkSync(archived, docPath(home, 'kept'));
  const t = require(path.join(ROOT, 'scripts', 'threads.js'));
  assert.strictEqual(t.couldBeThread(docPath(home, 'kept'), home), true);
  const r = json(home, ['target', 'kept', '--cwd', path.join(home, 'Documents')]);
  assert.strictEqual(r.body.path, undefined, JSON.stringify(r.body));
});

// --------------------------------------------- Devin CLI round 8 on 5452290 ----

check('a new thread whose write fails says nothing was written, not that a previous one is unchanged', () => {
  const t = require(path.join(ROOT, 'scripts', 'threads.js'));
  const home = migrated();
  const from = draftFor(home, handoff(home, ['New.']));
  const real = fs.writeFileSync;
  fs.writeFileSync = (f, ...rest) => {
    if (String(f).includes('HANDOFF-fresh-thread.md.') && String(f).endsWith('.tmp')) throw new Error('disk full');
    return real(f, ...rest);
  };
  let r;
  try {
    r = t.saveThread({ slug: 'fresh-thread', from, base: 'none', generation: registry(home).generation, create: true, home });
  } finally {
    fs.writeFileSync = real;
  }
  assert.strictEqual(r.reason, 'write-failed', JSON.stringify(r));
  assert.strictEqual(r.previousUnchanged, false);
  assert.strictEqual(r.nothingWritten, true);
  assert.ok(!fs.existsSync(docPath(home, 'fresh-thread')));
});

check('find exits non-zero for a found handoff it cannot read, whatever its kind', () => {
  const home = migrated();
  fs.chmodSync(docPath(home, 'old-session'), 0o000);
  try {
    const r = run(home, ['find', 'old-session', '--json']);
    assert.strictEqual(r.status, 1, r.stdout);
  } finally {
    fs.chmodSync(docPath(home, 'old-session'), 0o644);
  }
});

check('outside home, the broken-list note no longer says thread rules may be counted', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'app');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  const out = run(home, ['constraints', '--cwd', repo]).stdout;
  assert.doesNotMatch(out, /may be counted/);
  assert.match(out, /no thread's rules are in this list/);
});

// ------------------------------------------------ persona review of 5452290 ----

check('constraints --file reads the Working directory itself, notes and all', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'proj');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const file = path.join(repo, 'HANDOFF.md');
  fs.writeFileSync(file, handoff(`${repo} (git worktree of something)`, ['Proj rule.']));
  setIndex(home, 'proj', { path: file, kind: 'project', recorded_at: '2026-01-01T00:00:00.000Z' });
  const r = json(home, ['constraints', '--file', file]);
  assert.strictEqual(r.status, 0, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.constraints.map((c) => c.text), ['Proj rule.']);
});

check('constraints --file refuses a file with no Working directory line or none at all', () => {
  const home = migrated();
  const file = path.join(home, 'loose.md');
  fs.writeFileSync(file, '# Session Handoff\n\n## Constraints still in force\n- X.\n');
  const r = json(home, ['constraints', '--file', file]);
  assert.strictEqual(r.status, 1);
  assert.match(r.body.error, /Working directory/);
  assert.strictEqual(json(home, ['constraints', '--file', path.join(home, 'nope.md')]).status, 1);
});

check('constraints --file on a thread\'s own file answers with the thread\'s rules', () => {
  const home = migrated();
  const r = json(home, ['constraints', '--file', docPath(home, 'brand-thread')]);
  assert.deepStrictEqual(r.body.constraints.map((c) => c.text), ['Brand rule.']);
  assert.strictEqual(r.body.binding, true);
});

check('an index entry whose path is not a string is skipped by findHandoff', () => {
  const home = migrated();
  setIndex(home, 'other', { path: 42, kind: 'project' });
  const r = run(home, ['find', 'other', '--json']);
  assert.doesNotMatch(r.stderr, /DeprecationWarning|TypeError/);
});

// ----------------------------- persona and Codex round 11 on 2e03125 ----

check('a project named like a thread keeps its rules across wrap and pickup, in its worktree and subfolders too', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'site-thread');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo });
  const t = json(home, ['target', 'x', '--cwd', repo]).body;
  assert.strictEqual(t.pickupSlug, 'site-thread-project');
  fs.writeFileSync(t.path, handoff(repo, ['Repo2 rule.']));
  const wt = path.join(home, 'code', 'site-wt');
  spawnSync('git', ['worktree', 'add', '-q', wt], { cwd: repo });
  const sub = path.join(repo, 'sub');
  fs.mkdirSync(sub);
  const texts = (args) => json(home, ['constraints', ...args]).body.constraints.map((c) => c.text);
  for (const args of [['--cwd', repo], ['--cwd', wt], ['--cwd', sub], ['--file', t.path]]) {
    assert.deepStrictEqual(texts(args), ['Repo2 rule.'], args.join(' '));
  }
});

check('--file on a central file answers for that file, not whatever the index maps its name to', () => {
  const home = setUp();
  const repo = path.join(home, 'code', 'proj');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), handoff(repo, ['Proj rule.']));
  setIndex(home, 'proj', { path: path.join(repo, 'HANDOFF.md'), kind: 'project', recorded_at: '2026-01-01T00:00:00.000Z' });
  write(home, [['proj', handoff(home, ['Home proj rule.'])]]);
  const byFile = json(home, ['constraints', '--file', docPath(home, 'proj')]).body.constraints.map((c) => c.text).sort();
  const byDir = json(home, ['constraints', '--cwd', home]).body.constraints.map((c) => c.text).sort();
  assert.deepStrictEqual(byFile, byDir);
  assert.ok(!byFile.includes('Proj rule.'));
});

check('--file through a symlink to a thread answers with that thread', () => {
  const home = migrated();
  const link = path.join(home, 'link.md');
  fs.symlinkSync(docPath(home, 'brand-thread'), link);
  const r = json(home, ['constraints', '--file', link]);
  assert.strictEqual(r.status, 0, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.constraints.map((c) => c.text), ['Brand rule.']);
});

check('reconcile survives an index entry whose path is not a string', () => {
  const home = migrated();
  setIndex(home, 'site-thread', { path: 42, kind: 'central' });
  const r = run(home, ['reconcile', '--json']);
  assert.doesNotMatch(r.stderr, /TypeError|ERR_INVALID_ARG_TYPE/);
});

// ------------------------------------------------ Codex round 12 on 5e1f5e5 ----

check('before migration an unindexed project handoff binds nothing new, exactly as 0.8', () => {
  const home = setUp();
  const repo = path.join(home, 'code', 'loose');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), handoff(repo, ['Unindexed rule.']));
  assert.deepStrictEqual(json(home, ['constraints', '--cwd', repo]).body.constraints, []);
});

// -------------------------------------------- persona review of 5e1f5e5 ----

check('a worktree\'s unindexed own handoff does not bring back a rule its checkout retired', () => {
  const home = migrated();
  const main = path.join(home, 'code', 'repo');
  fs.mkdirSync(main, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: main });
  spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: main });
  const wt = path.join(home, 'code', 'repo-wt');
  spawnSync('git', ['worktree', 'add', '-q', wt], { cwd: main });
  const mainDoc = path.join(main, 'HANDOFF.md');
  fs.writeFileSync(mainDoc, handoff(main, ['Keep A.', 'Retired this session: Rule X., because done.']));
  setIndex(home, 'repo', { path: mainDoc, kind: 'project', recorded_at: '2026-01-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(wt, 'HANDOFF.md'), handoff(wt, ['Rule X.']));
  const t = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(wt, 'HANDOFF.md'), t, t);
  const texts = (cwd) => json(home, ['constraints', '--cwd', cwd]).body.constraints.map((c) => c.text);
  assert.deepStrictEqual(texts(wt), texts(main));
  assert.ok(!texts(wt).includes('Rule X.'));
});

check('--file on a pause note is answered from its Working directory, not pooled', () => {
  const home = setUp();
  const pause = path.join(dirOf(home), 'x-pause.md');
  fs.writeFileSync(pause, handoff(home, ['Pause rule.', 'Retired this session: Only in history., because x.']));
  const texts = (args) => json(home, ['constraints', ...args]).body.constraints.map((c) => c.text).sort();
  assert.deepStrictEqual(texts(['--file', pause]), texts(['--cwd', home]));
});

check('--file on a link inside the folder with its own name answers as the thread it points at', () => {
  const home = migrated();
  const link = path.join(dirOf(home), 'HANDOFF-alias.md');
  fs.symlinkSync(docPath(home, 'brand-thread'), link);
  assert.deepStrictEqual(json(home, ['constraints', '--file', link]).body.constraints.map((c) => c.text), ['Brand rule.']);
});

// ------------------------------------------------ Codex round 13 on 1112d16 ----

check('a project named like a history handoff does not have its unindexed file read in', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'old-session');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), handoff(repo, ['Stale local rule.']));
  assert.deepStrictEqual(json(home, ['constraints', '--cwd', repo]).body.constraints, []);
});

// --------------------------------------------- Devin CLI round 9 on 2e03125 ----

check('target refuses a central path that is a symbolic link, wherever it points', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'elsewhere');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), handoff(repo, ['Project rule.']));
  fs.symlinkSync(path.join(repo, 'HANDOFF.md'), docPath(home, 'linked'));
  const notes = path.join(home, 'notes');
  fs.mkdirSync(notes);
  const r = json(home, ['target', 'linked', '--cwd', notes]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.path, undefined);
  assert.match(r.body.refused, /symbolic link/);
});

check('a declared thread whose file is a dangling link is reported broken, not missing', () => {
  const home = migrated();
  fs.renameSync(docPath(home, 'brand-thread'), path.join(home, 'moved.md'));
  fs.symlinkSync(path.join(home, 'gone.md'), docPath(home, 'brand-thread'));
  const f = json(home, ['find', 'brand-thread']).body;
  assert.strictEqual(f.thread.exists, true);
  assert.strictEqual(f.thread.unreadable, true);
  const t = json(home, ['threads']).body.threads.find((x) => x.slug === 'brand-thread');
  assert.strictEqual(t.exists, true);
  assert.match(t.unreadable, /symbolic link/);
});

check('find with no slug is a usage error', () => {
  const home = migrated();
  const r = run(home, ['find']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /Usage: cli.js find/);
});

check('a plan naming a thread it does not contain is refused as a bad plan, not a failed write', () => {
  const home = setUp();
  const { planFile, manifest } = migrate(home, ['site-thread', 'brand-thread']);
  manifest.gained.push({ text: 'Invented.', threads: ['typo-thread'], disposition: 'drop' });
  fs.writeFileSync(planFile, JSON.stringify(manifest, null, 2));
  const r = apply(home, planFile);
  assert.strictEqual(r.body.committed, false);
  assert.notStrictEqual(r.body.reason, 'write-failed');
  assert.match(JSON.stringify(r.body), /not in this plan/);
});

check('migrate finish before migration says why', () => {
  const home = setUp();
  const out = run(home, ['migrate', 'finish']).stdout;
  assert.match(out, /threads are not set up/);
});

// -------------------------------------------- Devin CLI round 10 on 6d37a85 ----

check('a project HANDOFF.md linked into the handoffs folder is not handed out', () => {
  const home = migrated();
  const repo = path.join(home, 'code', 'site-thread');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.symlinkSync(docPath(home, 'site-thread'), path.join(repo, 'HANDOFF.md'));
  const before = fs.readFileSync(docPath(home, 'site-thread'), 'utf8');
  const r = json(home, ['target', 'x', '--cwd', repo]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.path, undefined);
  assert.strictEqual(fs.readFileSync(docPath(home, 'site-thread'), 'utf8'), before);
});

check('save on a declared thread whose file is a dangling link says unreadable, not missing', () => {
  const home = migrated();
  const rev = json(home, ['find', 'brand-thread']).body.thread.rev;
  fs.renameSync(docPath(home, 'brand-thread'), path.join(home, 'moved.md'));
  fs.symlinkSync(path.join(home, 'gone.md'), docPath(home, 'brand-thread'));
  const r = json(home, ['save', '--thread', 'brand-thread', '--from', draftFor(home, handoff(home, ['x'])),
    '--base', rev, '--generation', String(registry(home).generation)]);
  assert.strictEqual(r.body.saved, false);
  assert.notStrictEqual(r.body.reason, 'declared-missing');
});

check('forget with no slug is a usage error', () => {
  const home = migrated();
  assert.strictEqual(run(home, ['forget']).status, 1);
});

// -------------------------------------------- persona review of cbef693 ----

check('a folder really named name-project does not take a thread-named project\'s entry', () => {
  const home = migrated();
  const a = path.join(home, 'code', 'brand-thread');
  const b = path.join(home, 'Projects', 'brand-thread-project');
  for (const d of [a, b]) fs.mkdirSync(path.join(d, '.git'), { recursive: true });
  const ta = json(home, ['target', 'x', '--cwd', a]).body;
  fs.writeFileSync(ta.path, handoff(a, ['Rule A.']));
  const tb = json(home, ['target', 'x', '--cwd', b]).body;
  fs.writeFileSync(tb.path, handoff(b, ['Rule B.']));
  assert.notStrictEqual(ta.pickupSlug, tb.pickupSlug);
  const again = json(home, ['target', 'x', '--cwd', a]).body;
  assert.strictEqual(again.pickupSlug, ta.pickupSlug, 'the name is stable across wraps');
  const texts = (cwd) => json(home, ['constraints', '--cwd', cwd]).body.constraints.map((c) => c.text);
  assert.deepStrictEqual(texts(a), ['Rule A.']);
  assert.deepStrictEqual(texts(b), ['Rule B.']);
});

check('with name-project taken by a central file, the next free name is used, not a path pickup', () => {
  const home = migrated();
  write(home, [['brand-thread-project', handoff(home, ['Taken.'])]]);
  const repo = path.join(home, 'code', 'brand-thread');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const r = json(home, ['target', 'x', '--cwd', repo]).body;
  assert.strictEqual(r.pickupSlug, 'brand-thread-project-2');
  fs.writeFileSync(r.path, handoff(repo, ['Rule A.']));
  assert.deepStrictEqual(json(home, ['constraints', '--cwd', repo]).body.constraints.map((c) => c.text), ['Rule A.']);
});

check('a sixty-character thread name still gets a project name of its own', () => {
  const t = require(path.join(ROOT, 'scripts', 'threads.js'));
  const home = migrated();
  const long = 'a'.repeat(60);
  write(home, [[long, handoff(home, ['L.'])]]);
  const f = path.join(dirOf(home), 'threads.json');
  const reg = JSON.parse(fs.readFileSync(f, 'utf8'));
  reg.threads.push({ slug: long, path: docPath(home, long) });
  fs.writeFileSync(f, JSON.stringify(reg));
  const k = t.projectKey(long, path.join(home, 'code', long, 'HANDOFF.md'), home);
  assert.ok(k && k !== long && k.length <= 60 && /-project$/.test(k), k);
});

check('rekey moves a 0.8 entry for a thread name onto the project name, and the plan then passes', () => {
  const home = setUp();
  const repo = path.join(home, 'code', 'brand-thread');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), handoff(repo, ['Rule A.']));
  setIndex(home, 'brand-thread', { path: path.join(repo, 'HANDOFF.md'), kind: 'project', recorded_at: '2026-01-01T00:00:00.000Z' });
  const refused = json(home, ['migrate', 'plan', '--threads', 'site-thread,brand-thread']);
  assert.match(refused.body.detail, /cli\.js rekey brand-thread/);
  // Before migration the name is not a thread yet, so rekey waits for a declared name.
  const { planFile } = (() => {
    const r = json(home, ['rekey', 'brand-thread']);
    assert.strictEqual(r.body.rekeyed, true, JSON.stringify(r.body));
    assert.strictEqual(r.body.to, 'brand-thread-project');
    return migrate(home, ['site-thread', 'brand-thread']);
  })();
  assert.strictEqual(apply(home, planFile).body.committed, true);
  assert.deepStrictEqual(json(home, ['constraints', '--cwd', repo]).body.constraints.map((c) => c.text), ['Rule A.']);
});

// ------------------ Codex round 14, Devin CLI round 11, persona on c2085dc ----

check('two projects choosing a name at once cannot both get it', () => {
  const home = migrated();
  const a = path.join(home, 'code', 'one', 'brand-thread');
  const b = path.join(home, 'code', 'two', 'brand-thread');
  for (const d of [a, b]) fs.mkdirSync(path.join(d, '.git'), { recursive: true });
  const t = require(path.join(ROOT, 'scripts', 'threads.js'));
  // Both choose from the same stale snapshot; the lock re-chooses for each.
  const snapshot = handoffs.readIndex(home);
  const choose = (target) => (index) => t.chooseProjectKey('brand-thread', target, home, index);
  const ra = handoffs.recordHandoff({ slug: 'brand-thread', target: path.join(a, 'HANDOFF.md'), kind: 'project', home, choose: choose(path.join(a, 'HANDOFF.md')) });
  const rb = handoffs.recordHandoff({ slug: 'brand-thread', target: path.join(b, 'HANDOFF.md'), kind: 'project', home, choose: choose(path.join(b, 'HANDOFF.md')) });
  assert.ok(snapshot);
  assert.notStrictEqual(ra.key, rb.key);
});

check('the name search has no fixed ceiling', () => {
  const t = require(path.join(ROOT, 'scripts', 'threads.js'));
  const home = migrated();
  const index = {};
  for (let n = 1; n <= 120; n += 1) {
    const other = path.join(home, 'elsewhere', String(n), 'HANDOFF.md');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'x');
    index[n === 1 ? 'brand-thread-project' : `brand-thread-project-${n}`] = { path: other, kind: 'project', recorded_at: new Date().toISOString() };
  }
  assert.strictEqual(t.projectKey('brand-thread', path.join(home, 'code', 'brand-thread', 'HANDOFF.md'), home, index), 'brand-thread-project-121');
});

check('before migration a project named like an old central topic keeps its own name', () => {
  const home = setUp();
  const repo = path.join(home, 'Projects', 'site-thread');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  setIndex(home, 'site-thread', { path: docPath(home, 'site-thread'), kind: 'central', recorded_at: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(json(home, ['target', 'x', '--cwd', repo]).body.pickupSlug, 'site-thread');
});

check('a project HANDOFF.md linked to a thread file that is not there yet is refused', () => {
  const home = migrated();
  fs.renameSync(docPath(home, 'site-thread'), path.join(home, 'moved.md'));
  const repo = path.join(home, 'code', 'site-thread');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.symlinkSync(docPath(home, 'site-thread'), path.join(repo, 'HANDOFF.md'));
  const r = json(home, ['target', 'x', '--cwd', repo]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.path, undefined);
});

check('while the list cannot be read, a dangling central link still counts as a possible thread', () => {
  const t = require(path.join(ROOT, 'scripts', 'threads.js'));
  const home = migrated();
  fs.symlinkSync(path.join(home, 'gone.md'), docPath(home, 'ghost'));
  fs.writeFileSync(path.join(dirOf(home), 'threads.json'), '{ not json');
  assert.strictEqual(t.slugCouldBeThread('ghost', home), true);
});

check('pickup checks that a central path leads back to the same file', () => {
  const pickup = fs.readFileSync(path.join(ROOT, 'skills', 'pickup', 'SKILL.md'), 'utf8');
  assert.match(pickup, /check that the match \(or\s+`thread.path`\) is that same file/);
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
