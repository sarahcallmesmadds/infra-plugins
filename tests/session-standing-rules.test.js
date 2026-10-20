#!/usr/bin/env node
// Standing rules, the format guard and the handoff check.
//
// Run: node tests/session-standing-rules.test.js
//
// A thread's handoff was rewritten in place and still only grew: every rule
// ever written stayed in its constraints list, and every session added a dated
// paragraph to "What was worked on". These pin the three parts of the fix. A
// second section holds rules that outlive the current work, so the constraints
// list can stay this week's. A format marker stops a session running the older
// skill from writing the old shape over a migrated thread. And a measurement
// of the draft, run by wrap and by save, makes "current state, not a log"
// something checked rather than something hoped for.
//
// Driven through cli.js as a subprocess wherever a person or a skill would run
// it, because every bug this repository has shipped lived in a printing path no
// test executed. Fixtures are written for the test; nothing here comes from a
// real handoff.

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

const tmpHome = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-std-')));
const dirOf = (home) => path.join(home, '.planning', 'handoffs');
const docPath = (home, slug) => path.join(dirOf(home), `HANDOFF-${slug}.md`);

function run(home, args) {
  return spawnSync(process.execPath, [CLI, ...args, '--home', home], { encoding: 'utf8' });
}
function json(home, args) {
  const r = run(home, [...args, '--json']);
  try { return { status: r.status, body: JSON.parse(r.stdout), out: r.stdout, err: r.stderr }; } catch (_) {
    throw new Error(`not JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
  }
}

// A handoff in either shape. `standing` is a map of area to rules; passing it,
// or format 2, writes the new shape.
function doc(wd, { rules = [], standing = null, format = null, worked = 'The subject of this work.', extra = '', projectRules = null } = {}) {
  const out = ['# Session Handoff', '**Date:** 2026-10-01', `**Working directory:** ${wd}`];
  if (format) out.push(`**Format:** ${format}`);
  if (projectRules) out.push(`**Project rules:** ${projectRules}`);
  out.push('', '## What was worked on', worked, '', '## Constraints still in force', ...rules.map((r) => `- ${r}`), '');
  if (standing) {
    out.push('## Standing rules');
    for (const [area, list] of Object.entries(standing)) out.push(`### ${area}`, ...list.map((r) => `- ${r}`), '');
  }
  out.push('## Next actions', '1. Something.', extra);
  return out.join('\n');
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

function registry(home) {
  return JSON.parse(fs.readFileSync(path.join(dirOf(home), 'threads.json'), 'utf8'));
}

// `make(home)` returns the documents, so each can name the home it lives in.
function migrated(make) {
  const home = tmpHome();
  const docs = make(home);
  write(home, docs);
  const slugs = docs.map(([s]) => s).filter((s) => s.endsWith('-thread'));
  const planFile = path.join(home, 'plan.json');
  const plan = run(home, ['migrate', 'plan', '--threads', slugs.join(','), '--out', planFile]);
  assert.strictEqual(plan.status, 0, plan.stdout + plan.stderr);
  const m = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  for (const row of m.lost) row.disposition = 'retire';
  for (const row of m.gained) row.disposition = 'keep';
  fs.writeFileSync(planFile, JSON.stringify(m));
  const a = json(home, ['migrate', 'apply', planFile, '--accept-narrowing', '--confirm-sessions-restarted']);
  assert.strictEqual(a.body.committed, true, JSON.stringify(a.body));
  return home;
}

function draft(home, body) {
  const p = path.join(home, `draft-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(p, body);
  return p;
}

function save(home, slug, body, extra = []) {
  const f = json(home, ['find', slug]).body;
  return json(home, ['save', '--thread', slug, '--from', draft(home, body),
    '--base', f.thread.rev, '--generation', String(registry(home).generation), ...extra]);
}

function snapshot(file) {
  return { content: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs };
}

function writeConfig(home, value) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'session.config.json'), JSON.stringify(value));
}

// --------------------------------------------------------------- parsing ----

check('standing rules are read under their areas, and the constraints list is untouched by them', () => {
  const text = doc('/x', {
    rules: ['Push only by explicit refspec.'],
    standing: { 'Contact form': ['The form is one component.', 'Topics live in two files.'], Copy: ['No banned words.'] },
  });
  assert.deepStrictEqual(handoffs.standingIn(text), [
    { area: 'Contact form', text: 'The form is one component.' },
    { area: 'Contact form', text: 'Topics live in two files.' },
    { area: 'Copy', text: 'No banned words.' },
  ]);
  assert.deepStrictEqual(handoffs.constraintsIn(text), ['Push only by explicit refspec.'],
    'a standing rule leaked into the constraints list, or the area headings cut it short');
});

check('the standing section runs past its area headings to the next section, and no further', () => {
  // A `###` ends the constraints section by design. Here it must not end the
  // standing section, or every area after the first is dropped.
  const text = '## Standing rules\n### A\n- one\n### B\n- two\n\n## Decisions made\n- not a rule\n';
  assert.deepStrictEqual(handoffs.standingIn(text).map((r) => r.text), ['one', 'two']);
});

check('a standing section written last in the file is read to the end', () => {
  assert.deepStrictEqual(handoffs.standingIn('# H\n\n## Standing rules\n### A\n- last\n').map((r) => r.text), ['last']);
});

check('the template placeholders read back as nothing in the standing section too', () => {
  const wrap = fs.readFileSync(path.join(ROOT, 'skills', 'wrap', 'SKILL.md'), 'utf8');
  const block = wrap.match(/```markdown\n([\s\S]*?)```/);
  assert.ok(block, 'the handoff template is gone');
  assert.match(block[1], /^## Standing rules\s*$/m, 'the template has no standing rules section');
  assert.deepStrictEqual(handoffs.standingIn(block[1]), [], 'a placeholder reads back as a real standing rule');
  assert.deepStrictEqual(handoffs.constraintsIn(block[1]), []);
});

check('the format marker and the project rules line are read from the header', () => {
  const text = doc('/x', { format: 2, projectRules: '`/repo/CLAUDE.md`, ~/other/AGENTS.md' });
  assert.strictEqual(handoffs.handoffFormat(text), 2);
  assert.strictEqual(handoffs.handoffFormat(doc('/x')), null);
  assert.deepStrictEqual(handoffs.projectRulesIn(text, '/h'), ['/repo/CLAUDE.md', '/h/other/AGENTS.md']);
});

// ------------------------------------------------- what a thread binds ----

check('constraints --thread returns this week, the standing rules and the project files, labelled', () => {
  let repoRules;
  const home = migrated((h) => {
    repoRules = path.join(h, 'repo', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(repoRules), { recursive: true });
    fs.writeFileSync(repoRules, '# rules');
    return [['site-thread', doc(h, {
      rules: ['Push only by explicit refspec.'], standing: { Build: ['The homepage is generated.'] }, format: 2, projectRules: repoRules,
    })]];
  });
  const r = json(home, ['constraints', '--thread', 'site-thread']).body;
  assert.deepStrictEqual(r.constraints.map((c) => c.text), ['Push only by explicit refspec.']);
  assert.deepStrictEqual(r.standing.map((s) => [s.area, s.text]), [['Build', 'The homepage is generated.']]);
  assert.deepStrictEqual(r.projectRules, [{ path: repoRules, exists: true }]);
  assert.strictEqual(r.format, 2);
  const text = run(home, ['constraints', '--thread', 'site-thread']).stdout;
  const at = (s) => text.indexOf(s);
  assert.ok(at('Push only by explicit refspec.') !== -1 && at('The homepage is generated.') !== -1, text);
  assert.ok(at('this week') < at('standing rule') && at('standing rule') < at(repoRules),
    'the plain answer does not print this week, then standing rules, then the project files');
});

// ---------------------------------------------------- the format guard ----

check('a draft in the older shape cannot replace a thread already in the new one', () => {
  const home = migrated((h) => [['brand-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'brand-thread'), doc(home, { rules: ['R.'], standing: { Look: ['S.'] }, format: 2 }));
  const before = snapshot(docPath(home, 'brand-thread'));
  const r = save(home, 'brand-thread', doc(home, { rules: ['R.'] }));
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.reason, 'format-downgrade', JSON.stringify(r.body));
  assert.ok(r.body.draft && fs.existsSync(r.body.draft), 'the draft is not kept');
  assert.deepStrictEqual(snapshot(docPath(home, 'brand-thread')), before, 'the thread was touched');
  // The new shape saves, which is the other half: the guard is not a lock.
  const ok = save(home, 'brand-thread', doc(home, { rules: ['R.'], standing: { Look: ['S.', 'T.'] }, format: 2 }));
  assert.strictEqual(ok.body.saved, true, JSON.stringify(ok.body));
});

check('a thread still in the older shape can be saved either way', () => {
  // The guard only protects documents that have the marker. Refusing an old
  // draft over an old document would stop every unmigrated thread.
  const home = migrated((h) => [['brand-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'brand-thread'), doc(home, { rules: ['R.'] }));
  assert.strictEqual(save(home, 'brand-thread', doc(home, { rules: ['R.', 'Q.'] })).body.saved, true);
});

// ------------------------------------------------------ the handoff check ----

// Shaped like the failure: every session stacked a dated paragraph under "What
// was worked on", and the open loops kept every loop ever opened.
function logShaped(home) {
  const sessions = [1, 2, 3, 4].map((n) => `**Round ${n}, 2026-09-0${n}.** ${'Work happened and was described at length. '.repeat(8)}`);
  const loops = Array.from({ length: 90 }, (_, i) => `- Loop ${i}: still open, waiting on something.`).join('\n');
  return doc(home, { rules: ['R.'], format: 2, worked: sessions.join('\n\n'), extra: `\n## Open loops\n${loops}\n` });
}

check('the check flags a session log, an oversize summary and an oversize section', () => {
  const home = tmpHome();
  const f = draft(home, logShaped(home));
  const r = json(home, ['handoff-check', '--file', f]);
  assert.strictEqual(r.status, 0, r.err);
  const kinds = r.body.flags.map((x) => x.kind);
  assert.ok(kinds.includes('log'), `no log flag in ${kinds}`);
  assert.ok(kinds.includes('worked-on-long'), `no summary flag in ${kinds}`);
  assert.ok(r.body.flags.some((x) => x.kind === 'section-long' && x.section === 'Open loops'), JSON.stringify(r.body.flags));
  assert.strictEqual(r.body.flags.find((x) => x.kind === 'log').count, 4);
});

check('a current-state handoff is not flagged', () => {
  // The other direction, which a check that flags everything also passes.
  const home = tmpHome();
  const f = draft(home, doc(home, { rules: ['R.'], format: 2, standing: { A: ['S.'] }, worked: 'The website: one page left to rebuild.' }));
  const r = json(home, ['handoff-check', '--file', f]).body;
  assert.deepStrictEqual(r.flags, [], JSON.stringify(r.flags));
  assert.ok(r.sections.length >= 4, 'the sections were not counted');
});

check('standing rules are left out of the body total and the section cap', () => {
  const home = tmpHome();
  const many = Array.from({ length: 200 }, (_, i) => `Standing rule number ${i} about how the thing is built.`);
  const f = draft(home, doc(home, { rules: ['R.'], format: 2, standing: { Build: many } }));
  const r = json(home, ['handoff-check', '--file', f]).body;
  assert.ok(r.total > 1500, 'the fixture is not big enough to prove anything');
  assert.ok(r.body < 1500, `the standing rules were counted into the body (${r.body})`);
  assert.deepStrictEqual(r.flags, [], JSON.stringify(r.flags));
});

check('a file row dated before the handoff is flagged; an undated one is not guessed at', () => {
  const home = tmpHome();
  const files = '\n## Files created or changed\n| File | What |\n|---|---|\n| a.md | made 2026-08-01 |\n| b.md | made this session |\n';
  const r = json(home, ['handoff-check', '--file', draft(home, doc(home, { rules: ['R.'], extra: files }))]).body;
  const row = r.flags.find((x) => x.kind === 'old-file-rows');
  assert.ok(row, JSON.stringify(r.flags));
  assert.strictEqual(row.count, 1);
});

check('handoff-check on a file that is not there says so and exits nonzero', () => {
  const home = tmpHome();
  const r = run(home, ['handoff-check', '--file', path.join(home, 'nope.md')]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /could not be read/);
});

// ------------------------------------------------------ save and the check ----

check('with the budget enforced, save refuses an over-budget draft and keeps it', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2 }));
  writeConfig(home, { handoffBudget: { enforce: true } });
  const before = snapshot(docPath(home, 'site-thread'));
  const r = save(home, 'site-thread', logShaped(home));
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.body.reason, 'check-failed', JSON.stringify(r.body));
  assert.ok(r.body.flags.length, 'the refusal does not say what to fix');
  assert.ok(fs.existsSync(r.body.draft), 'the draft was not kept');
  assert.deepStrictEqual(snapshot(docPath(home, 'site-thread')), before);
  assert.match(run(home, ['save', '--thread', 'site-thread', '--from', r.body.draft, '--base', json(home, ['find', 'site-thread']).body.thread.rev, '--generation', String(registry(home).generation)]).stdout,
    /--accept-check/, 'the plain refusal does not name the way past it');
});

check('with a reason given, the over-budget draft saves and the reason is in its header', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2 }));
  writeConfig(home, { handoffBudget: { enforce: true } });
  const r = save(home, 'site-thread', logShaped(home), ['--accept-check', 'the fold is next session']);
  assert.strictEqual(r.body.saved, true, JSON.stringify(r.body));
  const saved = fs.readFileSync(docPath(home, 'site-thread'), 'utf8');
  assert.match(saved, /^\*\*Check accepted:\*\* the fold is next session$/m);
  assert.strictEqual(r.body.rev, json(home, ['find', 'site-thread']).body.thread.rev, 'the reported rev is not what is on disk');
  assert.strictEqual(r.body.check.accepted, 'the fold is next session');
});

check('a reason holding replacement patterns is written as typed', () => {
  // String.replace expands `$&` and `$1` in its replacement, so a reason
  // carrying either came out as some other text in the saved header.
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2 }));
  writeConfig(home, { handoffBudget: { enforce: true } });
  const reason = 'costs $& and $1 to fix';
  assert.strictEqual(save(home, 'site-thread', logShaped(home), ['--accept-check', reason]).body.saved, true);
  assert.ok(fs.readFileSync(docPath(home, 'site-thread'), 'utf8').includes(`**Check accepted:** ${reason}\n`));
});

check('a draft that cannot be saved for a plainer reason says that, not its word count', () => {
  // Before migration the answer is pre-migration whatever the draft weighs.
  const home = tmpHome();
  write(home, [['site-thread', doc(home)]]);
  writeConfig(home, { handoffBudget: { enforce: true } });
  const r = json(home, ['save', '--thread', 'site-thread', '--from', draft(home, logShaped(home)), '--base', 'none', '--generation', '1']);
  assert.strictEqual(r.body.reason, 'pre-migration', JSON.stringify(r.body));
});

check('with the budget not enforced, save reports the flags and saves', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2 }));
  const r = save(home, 'site-thread', logShaped(home));
  assert.strictEqual(r.body.saved, true, JSON.stringify(r.body));
  assert.strictEqual(r.body.check.enforced, false);
  assert.ok(r.body.check.flags.some((f) => f.kind === 'log'), 'the save stopped reporting what it measured');
});

check('an empty --accept-check reason is refused, not taken as consent', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2 }));
  const f = json(home, ['find', 'site-thread']).body;
  const r = spawnSync(process.execPath, ['-e', `
    const t = require(${JSON.stringify(path.join(ROOT, 'scripts', 'threads.js'))});
    process.stdout.write(JSON.stringify(t.saveThread({ slug: 'site-thread', from: ${JSON.stringify(draft(home, doc(home, { rules: ['R.'], format: 2 })))},
      base: ${JSON.stringify(f.thread.rev)}, generation: ${registry(home).generation}, home: ${JSON.stringify(home)}, acceptCheck: '   ' })));
  `], { encoding: 'utf8' });
  assert.strictEqual(JSON.parse(r.stdout).reason, 'bad-input', r.stdout + r.stderr);
});

// ---------------------------------------------------------- outside threads ----

check('outside threads, a standing section binds nothing new and the pool is what it was', () => {
  // The pooled answer outside threads never reads the standing section. That
  // is a deliberate limit, and it is why the wrap template marks the section
  // threads only: a rule moved there in a project handoff would stop binding.
  const home = tmpHome();
  const repo = path.join(home, 'code', 'app');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const older = path.join(dirOf(home), 'HANDOFF-older.md');
  write(home, [
    ['older', doc(repo, { rules: ['Kept.', 'To retire.'] })],
    ['newer', doc(repo, { rules: ['Retired this session: To retire, because done.'], standing: { Area: ['Only in standing.'] } })],
  ]);
  assert.ok(fs.existsSync(older));
  const r = handoffs.carriedConstraints({ cwd: repo, home });
  assert.deepStrictEqual(r.constraints.map((c) => c.text), ['Kept.'],
    'a standing rule was pooled, or retirement across documents stopped working beside one');
  // The retirement above is matched through retiredTarget and
  // normalizeConstraint, so this pair is what proves both still work beside a
  // standing section.
  assert.deepStrictEqual(r.unmatchedRetirements, []);
  assert.strictEqual(handoffs.normalizeConstraint('  A  b. '), 'a b');
});

check('the three protected cleanup handoffs are never touched by a save or a sweep', () => {
  const home = migrated((h) => [['brand-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'brand-thread'), doc(home, { rules: ['R.'], format: 2 }));
  const names = ['rule-pool-cleanup-a', 'rule-pool-cleanup-b', 'rule-pool-cleanup-c'];
  const old = Date.now() - 90 * 86400000;
  for (const n of names) {
    fs.writeFileSync(docPath(home, n), doc(home, { rules: ['Old.'] }));
    fs.utimesSync(docPath(home, n), new Date(old), new Date(old));
  }
  writeConfig(home, { protectedHandoffs: names.map((n) => docPath(home, n)) });
  const before = names.map((n) => snapshot(docPath(home, n)));
  save(home, 'brand-thread', doc(home, { rules: ['R.', 'Q.'], format: 2, standing: { A: ['S.'] } }));
  run(home, ['archive']);
  assert.deepStrictEqual(names.map((n) => snapshot(docPath(home, n))), before);
  assert.strictEqual(json(home, ['save', '--thread', 'rule-pool-cleanup-a', '--from', draft(home, doc(home, { rules: ['x'], format: 2 })), '--base', 'none', '--generation', String(registry(home).generation), '--create']).body.reason, 'protected');
});

// ------------------------------------------------------------- the skills ----

check('wrap sorts every rule into this week, standing or done, and measures the draft before saving', () => {
  const wrap = fs.readFileSync(path.join(ROOT, 'skills', 'wrap', 'SKILL.md'), 'utf8');
  assert.match(wrap, /Sort every rule, carried or new, into exactly one of three places/);
  const measure = wrap.indexOf('cli.js handoff-check --file');
  const saveAt = wrap.indexOf('cli.js save --thread', measure);
  assert.ok(measure !== -1 && saveAt > measure, 'the draft is not measured before the save step');
  assert.match(wrap, /A correction becomes a standing rule in these notes only when the user says\s+it is a rule/);
  assert.doesNotMatch(wrap, /Do not remove earlier entries unless they are now resolved or wrong/,
    'the add-only wording is back in the memory step');
  assert.match(wrap, /### Outside threads only/);
});

check('pickup prints standing rules and project files in full, after this week and before the next actions', () => {
  const pickup = fs.readFileSync(path.join(ROOT, 'skills', 'pickup', 'SKILL.md'), 'utf8');
  const tpl = pickup.slice(pickup.indexOf('Thread: {slug}'));
  const at = (s) => tpl.indexOf(s);
  assert.ok(at('**Still binding:**') < at('**Standing rules:**') && at('**Standing rules:**') < at('**Project rules files:**')
    && at('**Project rules files:**') < at('**Next actions per the handoff:**'), 'the order of the binding lists changed');
  assert.match(pickup, /each is printed in\s+full/);
  assert.match(pickup, /`threads` is 2 or higher/);
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
