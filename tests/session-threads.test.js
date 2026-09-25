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

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
