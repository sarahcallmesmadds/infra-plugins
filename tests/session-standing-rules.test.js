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

check('the format marker counts only in its exact form, and any other form is a shape problem', () => {
  for (const bad of ['# H\n  **Format:** 2\n', '# H\n**Format:**\n2\n', '# H\n**format:** 2\n', '# H\n**Format:**  2\n']) {
    assert.strictEqual(handoffs.handoffFormat(bad), null, `read leniently: ${JSON.stringify(bad)}`);
  }
  assert.ok(handoffs.threadShapeProblems('# H\n  **Format:** 2\n## Next\n').some((p) => p.kind === 'header-line'));
  assert.strictEqual(handoffs.handoffFormat('# H\n**Format:** 2\n'), 2);
});
check('the marker lines count only in the header, not as body text', () => {
  const text = '# H\n**Working directory:** /x\n\n## Notes\n**Format:** 2\n**Project rules:** /r/CLAUDE.md\n';
  assert.strictEqual(handoffs.handoffFormat(text), null);
  assert.deepStrictEqual(handoffs.projectRulesIn(text, '/h'), []);
});

check('an empty project rules line names no file', () => {
  assert.deepStrictEqual(handoffs.projectRulesIn('**Project rules:**\n\n## What was worked on\n', '/h'), []);
});

// ------------------------------------------------------------ shapes ----
//
// Every review round of the first design found a new way an unusual shape
// fooled a parser that tried to read around it: fences in the header, fence
// variants, a repeated rule section. The wrap is the only writer, so save
// refuses those shapes and the parsers read plain text. Measured on 33 real
// thread handoffs, none had any of them.

const SHAPES = [
  ['fence in the header', 'fence', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n```\nexample\n```')],
  ['tab-indented fence in a rule section', 'fence', (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['S.'] } }).replace('- S.', '- S.\n\t```\n## Example\n```')],
  ['fence in the notes', 'fence', (h) => doc(h, { rules: ['R.'], format: 2, extra: '\n## Notes\n```markdown\n## Standing rules\n- Example only.\n- Retired this session: S., because example.\n```\n' })],
  ['indented heading', 'indented-heading', (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['S.'] } }).replace('- S.', '- S.\n  ## Notes\n- Example only.')],
  ['second Standing rules heading', 'section-repeated', (h) => `${doc(h, { rules: ['R.'], format: 2, standing: { A: ['S.'] } })}\n## Standing rules\n- T.\n`],
  ['heading with no space', 'malformed-heading', (h) => doc(h, { rules: ['R.'], format: 2 }).replace('## Constraints still in force', '##Standing rules\n- Example only.\n\n## Constraints still in force')],
  ['empty heading', 'malformed-heading', (h) => doc(h, { rules: ['R.'], format: 2 }).replace('## What was worked on', '##\n\n## What was worked on')],
  ['second constraints section', 'section-repeated', (h) => doc(h, { rules: ['Keep A.'], format: 2 }).replace('## Next actions', '## Constraints still in force\n- Keep B.\n\n## Next actions')],
  ['rule continued onto a second line', 'rule-line', (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['Deploy production'] } }).replace('- Deploy production', '- Deploy production\n  only after approval.')],
  ['subheading inside the constraints', 'rule-line', (h) => doc(h, { rules: ['Keep A.'], format: 2 }).replace('- Keep A.', '### Area\n- Keep A.')],
  ['heading of spaces only', 'malformed-heading', (h) => doc(h, { rules: ['Keep A.', 'Keep B.'], format: 2 }).replace('- Keep B.', '## \n- Keep B.')],
  ['rule section name used as an area', 'rule-line', (h) => doc(h, { rules: ['R.'], format: 2, standing: { 'Constraints still in force': ['S.'] } })],
  ['second title', 'extra-title', (h) => `${doc(h, { rules: ['R.'], format: 2 })}\n# Notes\n${'more words '.repeat(50)}\n`],
  ['indented header label', 'header-line', (h) => doc(h, { rules: ['R.'] }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n  **Format:** 2')],
  ['empty header value', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n**Last session:**')],
  ['second header label', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n**Format:** 2')],
  ['Repository spelling', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, `$1\n**Repository:** \`${h}\``)],
  ['label in another spelling', 'header-line', (h) => doc(h, { rules: ['R.'] }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n**Format**: 2')],
  ['label without bold', 'header-line', (h) => doc(h, { rules: ['R.'] }).replace(/(\*\*Working directory:\*\*.*)/, '$1\nProject rules: /r/CLAUDE.md')],
  ['Check accepted not in its exact form', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n **Check accepted:** old')],
  ['placeholder on the project rules line', 'project-rules-entry', (h) => doc(h, { rules: ['R.'], format: 2, projectRules: '[for a thread: the files]' })],
  ['relative project rules entry', 'project-rules-entry', (h) => doc(h, { rules: ['R.'], format: 2, projectRules: 'repo/CLAUDE.md' })],
  // One spelling for each rule section: the readers match it exactly.
  ['Standing rules in lower case', 'malformed-heading', (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['S.'] } }).replace('## Standing rules', '## standing rules')],
  ['Standing rules in capitals', 'malformed-heading', (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['S.'] } }).replace('## Standing rules', '## STANDING RULES')],
  ['Standing rules with two spaces', 'malformed-heading', (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['S.'] } }).replace('## Standing rules', '## Standing  rules')],
  ['constraints section in lower case', 'malformed-heading', (h) => doc(h, { rules: ['R.'], format: 2 }).replace('## Constraints still in force', '## constraints still in force')],
  ['area heading deeper than ###', 'rule-line', (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['S.'] } }).replace('- S.', '- S.\n#### Deeper\n- T.')],
  ['label with two spaces in its name', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n**Project  rules:** /r/CLAUDE.md')],
  ['Last session with two spaces', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n**Last  session:** 2026-10-01')],
  ['bare carriage return', 'line-break', (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['S.'] } }).replace('- S.', '- S.\r## Notes')],
  ['Unicode line separator', 'line-break', (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['S.'] } }).replace('- S.', `- S.${String.fromCharCode(0x2028)}### B`)],
  // Only the template's sections exist at level two.
  ['constraints heading with a colon', 'unknown-section', (h) => doc(h, { rules: ['R.'], format: 2 }).replace('## Constraints still in force', '## Constraints still in force:')],
  ['Standing rules with closing hashes', 'unknown-section', (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['S.'] } }).replace('## Standing rules', '## Standing rules ##')],
  ['Standing rules with a suffix', 'unknown-section', (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['S.'] } }).replace('## Standing rules', '## Standing rules (draft)')],
  ['a dated session section', 'unknown-section', (h) => doc(h, { rules: ['R.'], format: 2, extra: '\n## Export batch completed, 27 September 2026\nDone.\n' })],
  ['worked-on heading with a colon', 'unknown-section', (h) => doc(h, { rules: ['R.'], format: 2 }).replace('## What was worked on', '## What was worked on:')],
  ['a section name used at level three', 'rule-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace('1. Something.', '1. Something.\n\n### What was worked on\nMore.')],
  ['a title line inside a rule section', 'extra-title', (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['S.'] } }).replace('# Session Handoff\n', '').replace('- S.', '- S.\n# Notes\n- T.')],
  ['no title', 'no-title', (h) => doc(h, { rules: ['R.'], format: 2 }).replace('# Session Handoff\n', '')],
  ['a header label in the body', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/\*\*Working directory:\*\*.*\n/, '').replace('1. Something.', `1. Something.\n\n## Context to reload\n**Working directory:** ${h}`)],
  ['a bare ~ as a project rules file', 'project-rules-entry', (h) => doc(h, { rules: ['R.'], format: 2, projectRules: '~' })],
  ['a rule written as a reference link', 'rule-line', (h) => doc(h, { rules: ['R.'], format: 2, standing: { Deploy: ['[Obtain approval before deploying][policy]'] } })],
  ['a placeholder left in the constraints', 'rule-line', (h) => doc(h, { rules: ['[what governs future work]'], format: 2 })],
  ['a bracketed area', 'rule-line', (h) => doc(h, { rules: ['R.'], format: 2, standing: { '[area]': ['S.'] } })],
  ['an indented retirement example', 'rule-line', (h) => doc(h, { rules: ['R.'], format: 2, extra: '\n## Context to reload\nExample:\n\n    - Retired this session: R., because example.\n' })],
  ['a reworded retirement line', 'rule-line', (h) => doc(h, { rules: ['R.', 'retired this session: Q.'], format: 2 })],
  ['Repository below the header', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/\*\*Working directory:\*\*.*\n/, '').replace('1. Something.', `1. Something.\n\n## Context to reload\n**Repository:** ${h}`)],
  ['Repo below the header', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace('1. Something.', '1. Something.\n\n## Context to reload\n**Repo:** /elsewhere')],
  ['a heading after a no-break space', 'indented-heading', (h) => doc(h, { rules: ['R.'], format: 2, extra: `\n## Context to reload\n${String.fromCharCode(0xa0)}## Standing rules\n- Obtain approval.\n` })],
  ['a commented-out retirement', 'fence', (h) => doc(h, { rules: ['R.'], format: 2, extra: '\n## Context to reload\n<!-- Example only:\n- Retired this session: R., because example.\n-->\n' })],
  ['a Format number too long to read exactly', 'header-line', (h) => doc(h, { rules: ['R.'], format: '9007199254740993' })],
  ['a subheading inside What was worked on', 'rule-line', (h) => doc(h, { rules: ['R.'], format: 2, worked: '### Rebuild\nThe homepage rebuild is three pages in.' })],
  ['a checkbox retirement line', 'rule-line', (h) => doc(h, { rules: ['R.', '[x] Retired this session: Q., because done.'], format: 2 })],
  ['a retirement example in a pre block', 'fence', (h) => doc(h, { rules: ['R.'], format: 2, extra: '\n## Context to reload\n<pre>\n- Retired this session: R., because example only.\n</pre>\n' })],
  ['a bulleted header label', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n- **Project rules:** /repo/CLAUDE.md')],
  ['a quoted Format label', 'header-line', (h) => doc(h, { rules: ['R.'] }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n> **Format:** 2')],
  ['an underlined heading', 'malformed-heading', (h) => doc(h, { rules: ['R.'], format: 2 }).replace('\n## What was worked on', '\nStanding rules\n--------------\n- Obtain approval.\n\n## What was worked on')],
  ['a numbered header label', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n1. **Project rules:** /repo/CLAUDE.md')],
  ['an indented second project rules path', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2, projectRules: '/repo/CLAUDE.md' }).replace(/(\*\*Project rules:\*\*.*)/, '$1\n    /repo/SECOND.md')],
  ['a label broken inside a word', 'header-line', (h) => doc(h, { rules: ['R.'] }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n**For mat:** 2')],
  ['a label with a stray digit', 'header-line', (h) => doc(h, { rules: ['R.'] }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n**Format2:** 2')],
  ['a heading run together with its label', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n**Projectrules:** /repo/CLAUDE.md')],
  ['a prose line in the header', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, '$1\nThis is the thread for the site rebuild, picked up from last week.')],
  ['an unknown bold label in the header', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n**Status:** open')],
  ['a project rules line written as a heading in the header', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Format:\*\* 2)/, '$1\n### **Project rules:** /repo/CLAUDE.md')],
  ['a bare heading in the header', 'header-line', (h) => doc(h, { rules: ['R.'], format: 2 }).replace(/(\*\*Format:\*\* 2)/, '$1\n### Project rules: /repo/CLAUDE.md')],
  ['Unicode paragraph separator', 'line-break', (h) => doc(h, { rules: ['R.'], format: 2 }).replace('- R.', `- R.${String.fromCharCode(0x2029)}- Q.`)],
];

check('a section that is not in the template is told which section to fold into', () => {
  const at = (heading) => handoffs.threadShapeProblems(doc('/x', { rules: ['R.'], format: 2, extra: `\n## ${heading}\nText.\n` }))
    .find((p) => p.kind === 'unknown-section').detail;
  // A misspelled section is renamed: a `### ` inside the constraints is itself refused.
  assert.match(at('Constraints still in force, carried'), /move its text into the existing "## Constraints still in force"/);
  assert.match(at('Open loops and next session'), /rename it to exactly "## Open loops"/);
  assert.match(at('Logo comparison completed, 27 September 2026'), /rename it to "## Context to reload"/);
  assert.match(at('Notes'), /The sections are: What was worked on, Constraints still in force, Standing rules/);
});

check('every section the wrap template writes is allowed', () => {
  const wrap = fs.readFileSync(path.join(ROOT, 'skills', 'wrap', 'SKILL.md'), 'utf8');
  const block = wrap.match(/```markdown\n([\s\S]*?)```/)[1];
  const names = [...block.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]);
  assert.ok(names.length >= 9, names.join(', '));
  for (const name of names) {
    const probs = handoffs.threadShapeProblems(`# T\n**Working directory:** /x\n\n## ${name}\n`);
    assert.ok(!probs.some((p) => p.kind === 'unknown-section' || p.kind === 'malformed-heading'), `${name}: ${JSON.stringify(probs)}`);
  }
});

check('an indented retirement example does not excuse dropping a standing rule', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2, standing: { Deploy: ['Obtain approval.'] } }));
  assert.deepStrictEqual(handoffs.retiredAnywhere('    - Retired this session: Obtain approval., because example.'), []);
  assert.strictEqual(handoffs.retiredAnywhere('- Retired this session: Obtain approval., because done.').length, 1);
});

check('a draft with no folder line in its header is refused before any acceptance is written', () => {
  // A folder named only in the body is refused as a shape, so nothing stands
  // in for the header line and the acceptance line has no folder line to sit
  // under. Before, a **Repository:** line in the body let it save, with the
  // acceptance line written above the title.
  const home = migrated((h) => [['site-thread', doc(h)]]);
  writeConfig(home, { handoffBudget: { enforce: true } });
  const before = snapshot(docPath(home, 'site-thread'));
  const draftText = doc(home, { rules: ['R.'], format: 2, worked: 'word '.repeat(90) }).replace(/\*\*Working directory:\*\*.*\n/, '');
  const r = save(home, 'site-thread', draftText, ['--accept-check', 'keep context']);
  assert.strictEqual(r.body.saved, false, JSON.stringify(r.body));
  assert.deepStrictEqual(snapshot(docPath(home, 'site-thread')), before);
  const viaBody = save(home, 'site-thread', draftText.replace('1. Something.', `1. Something.\n\n## Context to reload\n**Repository:** ${home}`), ['--accept-check', 'keep context']);
  assert.strictEqual(viaBody.body.saved, false, JSON.stringify(viaBody.body));
  assert.deepStrictEqual(snapshot(docPath(home, 'site-thread')), before);
});

check('following the advice for a misspelled constraints heading gives a document save accepts', () => {
  const bad = doc('/x', { rules: ['R.'], format: 2 }).replace('## Constraints still in force', '## Constraints still in force:');
  const advice = handoffs.threadShapeProblems(bad).find((p) => p.kind === 'unknown-section').detail;
  const target = /rename it to exactly "## ([^"]+)"/.exec(advice)[1];
  assert.deepStrictEqual(handoffs.threadShapeProblems(bad.replace('## Constraints still in force:', `## ${target}`)), []);
});

check('prose that mentions the retirement phrase is not a retirement line', () => {
  const text = doc('/x', { rules: ['R.'], format: 2, worked: 'The guide calls the old field `retired this session:` in its notes.' });
  assert.deepStrictEqual(handoffs.threadShapeProblems(text), []);
});

check('save refuses a draft whose only route past a dropped rule is an indented retirement example', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2, standing: { Deploy: ['Obtain approval.'] } }));
  const before = snapshot(docPath(home, 'site-thread'));
  const r = save(home, 'site-thread', doc(home, { rules: ['R.'], format: 2, extra: '\n## Context to reload\nExample:\n\n    - Retired this session: Obtain approval., because example.\n' }));
  assert.strictEqual(r.body.saved, false, JSON.stringify(r.body));
  assert.deepStrictEqual(snapshot(docPath(home, 'site-thread')), before);
  const ok = save(home, 'site-thread', doc(home, { rules: ['R.', 'Retired this session: Obtain approval., because done.'], format: 2 }));
  assert.strictEqual(ok.body.saved, true, JSON.stringify(ok.body));
});

check('the drop guard ignores flagged lines that are not a hidden Standing rules heading', () => {
  // A missing title is reported at line 1, and a notes section only names the words.
  for (const current of [
    (h) => doc(h, { rules: ['R.'], format: 2, standing: { A: ['Obtain approval.'] } }).replace('# Session Handoff\n', '').replace(/(\*\*Format:\*\* 2\n)/, '$1').replace(/^\*\*Date:.*\n/m, '## Standing rules\n- Obtain approval.\n'),
    (h) => doc(h, { rules: ['R.'], format: 2, extra: '\n## Notes on standing rules\nProse only.\n' }),
  ]) {
    const home = migrated((h) => [['site-thread', doc(h)]]);
    fs.writeFileSync(docPath(home, 'site-thread'), current(home));
    const r = save(home, 'site-thread', doc(home, { rules: ['R.', 'Retired this session: Obtain approval., because done.'], format: 2 }));
    assert.strictEqual(r.body.saved, true, JSON.stringify(r.body));
  }
});

check('an --accept-check reason that mentions the retirement phrase saves a document that passes its own check', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  writeConfig(home, { handoffBudget: { enforce: true } });
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2 }));
  const r = save(home, 'site-thread', doc(home, { rules: ['R.'], format: 2, worked: 'word '.repeat(90) }), ['--accept-check', 'Keep the context explaining Retired this session: R.']);
  assert.strictEqual(r.body.saved, true, JSON.stringify(r.body));
  assert.deepStrictEqual(handoffs.threadShapeProblems(fs.readFileSync(docPath(home, 'site-thread'), 'utf8')), []);
});

check('handoff-check and save measure a carried acceptance line the same way', () => {
  const text = doc('/x', { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, `$1\n**Check accepted:** ${'many words here '.repeat(10)}`);
  const hc = require(path.join(ROOT, 'scripts', 'handoff-check.js'));
  const plain = hc.checkText(doc('/x', { rules: ['R.'], format: 2 }));
  assert.strictEqual(hc.checkText(text).body, plain.body);
});

check('the advice for a near-miss section never produces a repeated section', () => {
  const text = doc('/x', { rules: ['R.'], format: 2, extra: '\n## Open loops\n- One.\n\n## Open loops and next session\n- Two.\n' });
  const detail = handoffs.threadShapeProblems(text).find((p) => p.kind === 'unknown-section').detail;
  assert.match(detail, /move its text into the existing "## Open loops" and delete this heading/);
  const fixed = text.replace('\n## Open loops and next session\n- Two.\n', '').replace('- One.', '- One.\n- Two.');
  assert.deepStrictEqual(handoffs.threadShapeProblems(fixed), []);
});

check('a thread hand-edited to a # or ### Standing rules heading still guards its rules', () => {
  for (const heading of ['# Standing rules', '### Standing rules']) {
    const home = migrated((h) => [['site-thread', doc(h)]]);
    fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2, standing: { Deploy: ['Obtain approval.'] } })
      .replace('## Standing rules', heading));
    const before = snapshot(docPath(home, 'site-thread'));
    const r = save(home, 'site-thread', doc(home, { rules: ['R.'], format: 2 }));
    assert.strictEqual(r.body.reason, 'standing-dropped', `${heading}: ${JSON.stringify(r.body)}`);
    assert.deepStrictEqual(snapshot(docPath(home, 'site-thread')), before);
  }
});

check('a --- rule after a blank line is not an underlined heading', () => {
  const text = doc('/x', { rules: ['R.'], format: 2, extra: '\n## Context to reload\nSome text.\n\n---\n\nMore text.\n' });
  assert.deepStrictEqual(handoffs.threadShapeProblems(text), []);
});

check('an HTML tag named in a sentence is not an HTML block', () => {
  const text = doc('/x', { rules: ['R.'], format: 2, worked: 'The page wraps its examples in a <pre> block and the guide shows `<code>`.' });
  assert.deepStrictEqual(handoffs.threadShapeProblems(text), []);
});

check('a Standing rules heading with a tag after it still guards its rules on disk', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2, standing: { Deploy: ['Obtain approval.'] } })
    .replace('## Standing rules', '## Standing rules <code>'));
  const before = snapshot(docPath(home, 'site-thread'));
  const r = save(home, 'site-thread', doc(home, { rules: ['R.'], format: 2 }));
  assert.strictEqual(r.body.reason, 'standing-dropped', JSON.stringify(r.body));
  assert.deepStrictEqual(snapshot(docPath(home, 'site-thread')), before);
});

check('a header holding only the wrap template\'s label lines and blank lines passes', () => {
  const wrap = fs.readFileSync(path.join(ROOT, 'skills', 'wrap', 'SKILL.md'), 'utf8');
  const block = wrap.match(/```markdown\n([\s\S]*?)```/)[1];
  const head = block.slice(0, block.search(/^## /m));
  // Fill each placeholder value with a real one of its kind.
  const filled = head.split('\n').map((l) => {
    const m = /^\*\*([^*]+):\*\* /.exec(l);
    if (!m) return l;
    const value = { Format: '2', 'Project rules': '~/repo/CLAUDE.md', 'Working directory': '/x' }[m[1]] || '2026-10-20';
    return `**${m[1]}:** ${value}`;
  }).join('\n');
  const labels = [...filled.matchAll(/^\*\*([^*]+):\*\*/gm)].map((m) => m[1]);
  assert.ok(labels.length >= 5, labels.join(', '));
  const text = `${filled}\n**Check accepted:** a reason\n\n## What was worked on\nThe subject.\n`;
  assert.deepStrictEqual(handoffs.threadShapeProblems(text), []);
});

check('an arrow in prose is not an HTML comment', () => {
  const text = doc('/x', { rules: ['R.'], format: 2, worked: 'The export runs collect --> clean --> merge nightly.' });
  assert.deepStrictEqual(handoffs.threadShapeProblems(text), []);
});

check('a Windows line ending is not a shape problem', () => {
  const text = doc('/x', { rules: ['R.'], format: 2, standing: { A: ['S.'] } }).replace(/\n/g, '\r\n');
  assert.deepStrictEqual(handoffs.threadShapeProblems(text), []);
});

check('save refuses each shape a plain reading gets wrong, names the line, and keeps the draft', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2, standing: { A: ['S.'] } }));
  const before = snapshot(docPath(home, 'site-thread'));
  for (const [name, kind, make] of SHAPES) {
    const r = save(home, 'site-thread', make(home));
    assert.strictEqual(r.body.reason, 'bad-shape', `${name}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.problems.some((p) => p.kind === kind && Number.isInteger(p.line) && p.line > 0), `${name} not named as ${kind}: ${JSON.stringify(r.body.problems)}`);
    assert.ok(fs.existsSync(r.body.draft), `${name}: the draft was not kept`);
    assert.deepStrictEqual(snapshot(docPath(home, 'site-thread')), before, `${name}: a refused shape touched the thread`);
  }
  // A reason does not get a shape through: it is not a budget question.
  const r = save(home, 'site-thread', SHAPES[0][2](home), ['--accept-check', 'please']);
  assert.strictEqual(r.body.reason, 'bad-shape');
  assert.deepStrictEqual(snapshot(docPath(home, 'site-thread')), before, '--accept-check let a shape reach disk');
});
check('handoff-check reports the same shapes, so the wrap can fix the draft first', () => {
  const home = tmpHome();
  for (const [name, kind, make] of SHAPES) {
    const r = json(home, ['handoff-check', '--file', draft(home, make(home))]).body;
    assert.ok(r.flags.some((f) => f.kind === 'shape' && f.shape === kind), `${name}: ${JSON.stringify(r.flags)}`);
  }
  const text = run(home, ['handoff-check', '--file', draft(home, SHAPES[0][2](home))]).stdout;
  assert.match(text, /Shape problems\. save refuses these whatever the budget, and --accept-check does not cover them/);
  assert.doesNotMatch(text, /does not refuse/, 'the plain output says save will not refuse a shape it always refuses');
});
check('a thread file edited into an odd shape is reported at pickup, not read as whole', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), SHAPES.find(([, k]) => k === 'section-repeated')[2](home));
  const r = json(home, ['constraints', '--thread', 'site-thread']).body;
  assert.ok(r.shapeProblems.some((p) => p.kind === 'section-repeated'), JSON.stringify(r.shapeProblems));
  const text = run(home, ['constraints', '--thread', 'site-thread']).stdout;
  const warn = text.indexOf('may be incomplete');
  const list = text.indexOf('in force this week');
  assert.ok(warn !== -1 && list !== -1 && warn < list, `the warning is missing or printed below the lists it qualifies:\n${text}`);
});

check('a thread hand-edited to a miscased Standing rules heading still guards its rules', () => {
  // The heading cannot be read exactly, so the guard counts it as holding rules.
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2, standing: { Deploy: ['Obtain approval.'] } })
    .replace('## Standing rules', '## standing rules'));
  const before = snapshot(docPath(home, 'site-thread'));
  const r = save(home, 'site-thread', doc(home, { rules: ['R.'], format: 2 }));
  assert.strictEqual(r.body.reason, 'standing-dropped', JSON.stringify(r.body));
  assert.deepStrictEqual(snapshot(docPath(home, 'site-thread')), before);
  const ok = save(home, 'site-thread', doc(home, { rules: ['R.'], format: 2, standing: { Deploy: ['Obtain approval.'] } }));
  assert.strictEqual(ok.body.saved, true, JSON.stringify(ok.body));
});

check('the guard also holds for a no-break space in the heading, and a Standing rules title does not trip it', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2, standing: { Deploy: ['Obtain approval.'] } })
    .replace('## Standing rules', `## Standing${String.fromCharCode(0xa0)}rules`));
  const before = snapshot(docPath(home, 'site-thread'));
  const r = save(home, 'site-thread', doc(home, { rules: ['R.'], format: 2 }));
  assert.strictEqual(r.body.reason, 'standing-dropped', JSON.stringify(r.body));
  assert.deepStrictEqual(snapshot(docPath(home, 'site-thread')), before);

  const titled = (h) => doc(h, { rules: ['R.'], format: 2 }).replace('# Session Handoff', '# Standing rules');
  fs.writeFileSync(docPath(home, 'site-thread'), titled(home));
  const ok = save(home, 'site-thread', titled(home));
  assert.strictEqual(ok.body.saved, true, JSON.stringify(ok.body));
});

check('the shape warning comes before everything else at pickup, near-duplicate notes included', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  const rule = 'Handoffs file centrally in `~/.planning/handoffs/`, never at a repo root, whatever `cli.js target` proposes.';
  const body = doc(home, { rules: [`${rule} Seventh session running.`, `${rule} Tenth session running.`], format: 2 });
  fs.writeFileSync(docPath(home, 'site-thread'), `${body}\n## Next actions\n2. Again.\n`);
  const text = run(home, ['constraints', '--thread', 'site-thread']).stdout;
  const warn = text.indexOf('may be incomplete');
  const dup = text.indexOf('look like one rule');
  assert.ok(warn !== -1 && dup !== -1, `the fixture does not raise both:\n${text}`);
  assert.ok(warn < dup, `the shape warning prints after the near-duplicate note:\n${text}`);
});

check('save lists budget counts and advice apart in its plain output', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2 }));
  const worked = 'Round one, 2026-09-01.\n\nRound two, 2026-09-08.';
  const text = doc(home, { rules: ['R.'], format: 2, worked });
  const f = json(home, ['find', 'site-thread']).body;
  const r = run(home, ['save', '--thread', 'site-thread', '--from', draft(home, text),
    '--base', f.thread.rev, '--generation', String(registry(home).generation)]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /Over budget/, `advice alone is labelled over budget:\n${r.stdout}`);
  assert.match(r.stdout, /Advice, not a budget:/, r.stdout);
});

check('advice flags never refuse a save, even with enforcement on', () => {
  // And the save records no acceptance, because it excused nothing.
  // A log or an old row is a judgement made by pattern; only counts gate.
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2 }));
  writeConfig(home, { handoffBudget: { enforce: true } });
  const worked = 'Round one, 2026-09-01.\n\nRound two, 2026-09-08.';
  const files = '\n## Files created or changed\n| File | What |\n|---|---|\n| a.md | replaces the 2026-01-01 version |\n';
  const text = doc(home, { rules: ['R.'], format: 2, worked, extra: files });
  const flags = json(home, ['handoff-check', '--file', draft(home, text)]).body.flags;
  assert.ok(flags.some((f) => f.kind === 'log') && flags.some((f) => f.kind === 'old-file-rows'), `the fixture does not raise both: ${JSON.stringify(flags)}`);
  const r = save(home, 'site-thread', text);
  assert.strictEqual(r.body.saved, true, JSON.stringify(r.body));
  assert.strictEqual(r.body.check.accepted, null);
  assert.doesNotMatch(fs.readFileSync(docPath(home, 'site-thread'), 'utf8'), /Check accepted/);
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

check('a draft that keeps the marker and drops every standing rule is refused', () => {
  const home = migrated((h) => [['brand-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'brand-thread'), doc(home, { rules: ['R.'], standing: { Look: ['S.'] }, format: 2 }));
  const before = snapshot(docPath(home, 'brand-thread'));
  const r = save(home, 'brand-thread', doc(home, { rules: ['R.'], format: 2 }));
  assert.strictEqual(r.body.reason, 'standing-dropped', JSON.stringify(r.body));
  assert.deepStrictEqual(snapshot(docPath(home, 'brand-thread')), before);
  // Naming a file that is not there, or a relative one, is not where they
  // went; naming one that is there is the legitimate route, and it saves.
  assert.strictEqual(save(home, 'brand-thread', doc(home, { rules: ['R.'], format: 2, projectRules: '/no/such/CLAUDE.md' })).body.reason, 'standing-dropped');
  assert.strictEqual(save(home, 'brand-thread', doc(home, { rules: ['R.'], format: 2, projectRules: 'repo/CLAUDE.md' })).body.reason, 'bad-shape',
    'a relative project rules entry is a shape problem before it is anything else');
  const rules = path.join(home, 'repo', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(rules, '# rules');
  const moved = save(home, 'brand-thread', doc(home, { rules: ['R.'], format: 2, projectRules: rules }));
  assert.strictEqual(moved.body.saved, true, JSON.stringify(moved.body));
});

check('dropping every standing rule is refused even where the document has no marker', () => {
  // The rules bind whether or not the line is there, so the guard follows the
  // rules, not the line.
  const home = migrated((h) => [['brand-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'brand-thread'), doc(home, { rules: ['R.'], standing: { Look: ['S.'] } }));
  assert.strictEqual(save(home, 'brand-thread', doc(home, { rules: ['R.'] })).body.reason, 'standing-dropped');
});

check('a relative project rules entry is reported, never looked up', () => {
  const home = migrated((h) => [['site-thread', doc(h, { format: 2, projectRules: 'repo/CLAUDE.md' })]]);
  const r = json(home, ['constraints', '--thread', 'site-thread']).body;
  assert.deepStrictEqual(r.projectRules, [{ path: 'repo/CLAUDE.md', exists: false, relative: true }]);
  assert.match(run(home, ['constraints', '--thread', 'site-thread']).stdout, /NOT AN ABSOLUTE PATH/);
});

check('an acceptance is written only when something was excused, and goes once the draft is clean', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2 }));
  assert.strictEqual(save(home, 'site-thread', logShaped(home), ['--accept-check', 'next session']).body.saved, true);
  assert.match(fs.readFileSync(docPath(home, 'site-thread'), 'utf8'), /\*\*Check accepted:\*\*/);
  // A clean draft that still carries the old line has it dropped.
  const clean = doc(home, { rules: ['R.'], format: 2 }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n**Check accepted:** next session');
  assert.strictEqual(save(home, 'site-thread', clean).body.saved, true);
  assert.doesNotMatch(fs.readFileSync(docPath(home, 'site-thread'), 'utf8'), /Check accepted/);
  // A reason given for a clean draft excuses nothing and is not written.
  const r = save(home, 'site-thread', doc(home, { rules: ['R.', 'Q.'], format: 2 }), ['--accept-check', 'nothing to excuse']);
  assert.strictEqual(r.body.check.accepted, null);
  assert.doesNotMatch(fs.readFileSync(docPath(home, 'site-thread'), 'utf8'), /Check accepted/);
});

check('a thread whose marker on disk is in another spelling keeps its protection', () => {
  // Only possible by hand editing, and it fails closed: the guard reads the
  // document on disk loosely, so an older-shape draft still cannot replace it.
  const home = migrated((h) => [['brand-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'brand-thread'), doc(home, { rules: ['R.'] }).replace(/(\*\*Working directory:\*\*.*)/, '$1\n  **Format:** 2'));
  const before = snapshot(docPath(home, 'brand-thread'));
  const r = save(home, 'brand-thread', doc(home, { rules: ['R.'] }));
  assert.strictEqual(r.body.reason, 'format-downgrade', JSON.stringify(r.body));
  assert.deepStrictEqual(snapshot(docPath(home, 'brand-thread')), before);
});

check('a thread still in the older shape can be saved either way', () => {
  // The guard only protects documents that have the marker. Refusing an old
  // draft over an old document would stop every unmigrated thread, and the
  // move to the new shape has to be allowed too.
  const home = migrated((h) => [['brand-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'brand-thread'), doc(home, { rules: ['R.'] }));
  assert.strictEqual(save(home, 'brand-thread', doc(home, { rules: ['R.', 'Q.'] })).body.saved, true);
  const up = save(home, 'brand-thread', doc(home, { rules: ['R.'], standing: { Look: ['Q.'] }, format: 2 }));
  assert.strictEqual(up.body.saved, true, JSON.stringify(up.body));
  assert.strictEqual(json(home, ['constraints', '--thread', 'brand-thread']).body.format, 2);
});

check('retiring the last standing rule with its line is allowed', () => {
  const home = migrated((h) => [['brand-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'brand-thread'), doc(home, { rules: ['R.'], standing: { Api: ['Use the old API.'] }, format: 2 }));
  const r = save(home, 'brand-thread', doc(home, { rules: ['R.', 'Retired this session: Use the old API., because it was removed.'], format: 2 }));
  assert.strictEqual(r.body.saved, true, JSON.stringify(r.body));
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

check('dates still to come are a plan, not a log', () => {
  const home = tmpHome();
  const worked = 'The launch is set for 2026-11-05.\n\nThe review follows on 2026-11-12.';
  const r = json(home, ['handoff-check', '--file', draft(home, doc(home, { rules: ['R.'], worked }))]).body;
  assert.ok(!r.flags.some((f) => f.kind === 'log'), JSON.stringify(r.flags));
});

check('one session told in two paragraphs dated today is not a log', () => {
  const home = tmpHome();
  const worked = 'Rebuilt the page on 2026-10-01.\n\nThen reviewed it, also 2026-10-01.';
  const r = json(home, ['handoff-check', '--file', draft(home, doc(home, { rules: ['R.'], worked }))]).body;
  assert.ok(!r.flags.some((f) => f.kind === 'log'), JSON.stringify(r.flags));
});

check('a fenced example date does not move the handoff date', () => {
  // With no real Date line, a fenced one made every real entry look future.
  const home = tmpHome();
  const worked = 'Round one, 2026-09-01.\n\nRound two, 2026-09-08.';
  const text = doc(home, { rules: ['R.'], worked }).replace(/^\*\*Date:\*\*.*\n/m, '')
    + '\n```\n**Date:** 2020-01-01\n```\n';
  const r = json(home, ['handoff-check', '--file', draft(home, text)]).body;
  assert.ok(r.flags.some((f) => f.kind === 'log'), JSON.stringify(r.flags));
});

check('a log written as paragraphs that all start from one date is still a log', () => {
  const home = tmpHome();
  const worked = 'Since 2026-09-01: session 2026-09-10 built the page.\n\nSince 2026-09-01: session 2026-09-20 reviewed it.';
  const r = json(home, ['handoff-check', '--file', draft(home, doc(home, { rules: ['R.'], worked }))]).body;
  assert.ok(r.flags.some((f) => f.kind === 'log'), JSON.stringify(r.flags));
});

check('dated area headings are not a log', () => {
  const home = tmpHome();
  const text = doc(home, { rules: ['R.'], extra: '\n## Notes\n### Build 2026-10-01\n- a\n### Review 2026-10-01\n- b\n' });
  const r = json(home, ['handoff-check', '--file', draft(home, text)]).body;
  assert.ok(!r.flags.some((f) => f.kind === 'log'), JSON.stringify(r.flags));
});

check('a dated filename is not an old row', () => {
  const home = tmpHome();
  const files = '\n## Files created or changed\n| File | What |\n|---|---|\n| 2026-01-01-plan.md | updated today |\n';
  const r = json(home, ['handoff-check', '--file', draft(home, doc(home, { rules: ['R.'], extra: files }))]).body;
  assert.ok(!r.flags.some((f) => f.kind === 'old-file-rows'), JSON.stringify(r.flags));
});

check('a section written twice is measured as one', () => {
  const home = tmpHome();
  const text = doc(home, { rules: ['R.'], worked: 'Short.', extra: `\n## What was worked on\n${'More words about the work. '.repeat(30)}\n` });
  const r = json(home, ['handoff-check', '--file', draft(home, text)]).body;
  assert.ok(r.flags.some((f) => f.kind === 'worked-on-long'), JSON.stringify(r.flags));
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

check('an acceptance line carried from an earlier save does not count against the budget', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2 }));
  const clean = doc(home, { rules: ['R.', 'Q.'], format: 2 });
  const limit = json(home, ['handoff-check', '--file', draft(home, clean)]).body.body;
  writeConfig(home, { handoffBudget: { enforce: true, bodyWords: limit } });
  const carried = clean.replace(/(\*\*Working directory:\*\*.*)/, '$1\n**Check accepted:** an old reason');
  // The same words as ordinary text would be over: the fixture sits on the boundary.
  const asText = clean.replace(/(\*\*Working directory:\*\*.*)/, '$1\nCheck accepted an old reason');
  assert.ok(json(home, ['handoff-check', '--file', draft(home, asText)]).body.flags.some((f) => f.kind === 'body-long'),
    'the fixture does not sit on the boundary, so it proves nothing');
  // handoff-check and save give one answer.
  assert.ok(!json(home, ['handoff-check', '--file', draft(home, carried)]).body.flags.some((f) => f.kind === 'body-long'));
  const r = save(home, 'site-thread', carried);
  assert.strictEqual(r.body.saved, true, JSON.stringify(r.body));
});

check('an acceptance line in its exact form is replaced, never duplicated', () => {
  const home = migrated((h) => [['site-thread', doc(h)]]);
  fs.writeFileSync(docPath(home, 'site-thread'), doc(home, { rules: ['R.'], format: 2 }));
  const carried = logShaped(home).replace(/(\*\*Working directory:\*\*.*)/, '$1\n**Check accepted:** an old reason');
  assert.strictEqual(save(home, 'site-thread', carried, ['--accept-check', 'a new reason']).body.saved, true);
  const saved = fs.readFileSync(docPath(home, 'site-thread'), 'utf8');
  assert.deepStrictEqual(saved.match(/^\*\*Check accepted:\*\*.*$/gm), ['**Check accepted:** a new reason']);
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
  // Both have to actually run, or untouched files prove nothing.
  assert.strictEqual(save(home, 'brand-thread', doc(home, { rules: ['R.', 'Q.'], format: 2, standing: { A: ['S.'] } })).body.saved, true);
  const sweep = json(home, ['archive']);
  assert.strictEqual(sweep.status, 0, JSON.stringify(sweep.body));
  assert.deepStrictEqual(sweep.body.protectedSkipped.sort(), names.map((n) => `HANDOFF-${n}.md`).sort());
  assert.deepStrictEqual(names.map((n) => snapshot(docPath(home, n))), before);
  assert.strictEqual(json(home, ['save', '--thread', 'rule-pool-cleanup-a', '--from', draft(home, doc(home, { rules: ['x'], format: 2 })), '--base', 'none', '--generation', String(registry(home).generation), '--create']).body.reason, 'protected');
});

// ------------------------------------------------------------- the skills ----

check('wrap sorts every rule into this week, standing or done, and measures the draft before saving', () => {
  const wrap = fs.readFileSync(path.join(ROOT, 'skills', 'wrap', 'SKILL.md'), 'utf8');
  assert.match(wrap, /Sort every rule, carried or new, into exactly one of three places/);
  const writeAt = wrap.indexOf('Write the whole document to a draft file');
  const measure = wrap.indexOf('cli.js handoff-check --file');
  const saveAt = wrap.indexOf('cli.js save --thread', measure);
  assert.ok(writeAt !== -1 && measure > writeAt, 'the draft is measured before it is written, so the check reads a file that is not there');
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
  // Each one has to be there first: a missing heading reads as -1, which
  // sorts ahead of everything and passes an order check.
  for (const h of ['**Still binding:**', '**Standing rules:**', '**Project rules files:**', '**Next actions per the handoff:**']) {
    assert.ok(at(h) !== -1, `${h} is gone from the pickup output`);
  }
  assert.ok(at('**Still binding:**') < at('**Standing rules:**') && at('**Standing rules:**') < at('**Project rules files:**')
    && at('**Project rules files:**') < at('**Next actions per the handoff:**'), 'the order of the binding lists changed');
  assert.match(pickup, /each is printed in\s+full/);
  assert.match(pickup, /`threads` is 2 or higher/);
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
