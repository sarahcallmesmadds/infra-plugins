#!/usr/bin/env node
// Regression tests for the memory budget check.
//
// Run: node tests/session-memory.test.js
//
// This check exists because the rules it enforces were already written down, in
// /wrap, and being written down did nothing. One real directory reached 14,637
// words across eleven files before anyone measured it, and half of that was two
// files: a session log nobody had removed anything from, and a status document
// that had quietly become the only home for some durable engineering notes.
//
// So the cases that matter here are the ones where the check has to stay quiet.
// A check that flags a good file gets switched off, and a switched-off check is
// worth exactly as much as the advice it replaced.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'plugins', 'session');
const memory = require(path.join(ROOT, 'scripts', 'memory.js'));
const CLI = path.join(ROOT, 'scripts', 'cli.js');

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

function file(type, wordCount, links = []) {
  const fm = type
    ? `---\nname: x\ndescription: "d"\nmetadata:\n  node_type: memory\n  type: ${type}\n---\n\n`
    : '';
  return fm + links.map((l) => `[[${l}]]`).join(' ') + ' ' + 'word '.repeat(wordCount);
}

function dirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-mem-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

const kinds = (r) => r.findings.map((f) => f.kind);

// --------------------------------------------------------------- budgets ----

check('a long live-state file is flagged', () => {
  // `project` means live state: replaced rather than grown. A long one means
  // nothing has been taken out since it was written.
  const dir = dirWith({ 'HANDOFF.md': file('project', 2000) });
  assert.ok(kinds(memory.audit({ dir })).includes('oversize-live'));
});

check('a live-state file inside its budget is not flagged', () => {
  const dir = dirWith({ 'HANDOFF.md': file('project', 100) });
  assert.ok(!kinds(memory.audit({ dir })).includes('oversize-live'));
});

check('a durable file of the same length is not flagged as live', () => {
  // The whole point of the split. A reference file accumulates slowly and
  // legitimately, and holding it to the live budget would nag about a good
  // file until somebody turned the check off.
  const dir = dirWith({ 'traps.md': file('reference', 2000) });
  const k = kinds(memory.audit({ dir }));
  assert.ok(!k.includes('oversize-live'), 'a reference file was judged as live state');
  assert.ok(!k.includes('oversize-durable'), '2000 words is inside the durable budget');
});

check('a durable file long enough to split is still flagged', () => {
  const dir = dirWith({ 'traps.md': file('reference', 4000) });
  assert.ok(kinds(memory.audit({ dir })).includes('oversize-durable'));
});

check('feedback and user types are durable, not live', () => {
  for (const t of ['feedback', 'user']) {
    const dir = dirWith({ 'x.md': file(t, 2000) });
    assert.ok(!kinds(memory.audit({ dir })).includes('oversize-live'), `${t} treated as live`);
  }
});

check('a file with no declared type gets the permissive budget', () => {
  // Being quiet about a file we cannot classify beats being loudly wrong about
  // it. A guess here would apply the tight budget to a durable file.
  const dir = dirWith({ 'x.md': file(null, 2000) });
  assert.ok(!kinds(memory.audit({ dir })).includes('oversize-live'));
});

check('the total is reported against the whole directory', () => {
  // These three each break the 2500 durable cap on their own, which is why
  // over-budget fires. Stated here because it used to fire on the directory
  // total instead, and then this case passed for a reason it no longer holds.
  const dir = dirWith({
    'a.md': file('reference', 4000), 'b.md': file('reference', 4000), 'c.md': file('reference', 4000),
  });
  const r = memory.audit({ dir });
  assert.ok(kinds(r).includes('over-budget'));
  assert.ok(r.total > 10000, `total was ${r.total}`);
});

// The regression this check was rewritten for, on 2026-08-04.
//
// over-budget used to compare the directory total against totalWords. A
// directory of small, compliant files exceeds any fixed total once there are
// enough of them, so the flag stayed up whatever anyone edited and reported
// over-budget on every wrap forever. A warning nobody can clear gets switched
// off, and then the whole check goes with it.
//
// This is the case that was impossible before, so it is the one that must fail
// if the old condition ever comes back.
check('over-budget stays silent when every file is inside its own cap', () => {
  const files = {};
  for (let i = 0; i < 12; i += 1) files[`f${i}.md`] = file('reference', 2000);
  const r = memory.audit({ dir: dirWith(files) });
  assert.ok(r.total > 10000, `total was ${r.total}, so this does not test what it claims`);
  assert.ok(!kinds(r).includes('over-budget'),
    `every file is under 2500 and the directory still reported over-budget: ${JSON.stringify(kinds(r))}`);
});

check('over-budget counts how far the oversize files are over their own caps', () => {
  // file() prefixes 11 words of frontmatter, so 2589 lands on 2600 words
  // against the 2500 durable cap. One file, 100 words over.
  const r = memory.audit({ dir: dirWith({ 'big.md': file('reference', 2589) }) });
  const f = r.findings.find((x) => x.kind === 'over-budget');
  assert.ok(f, 'over-budget did not fire on a file 100 words over its cap');
  assert.strictEqual(f.files, 1);
  assert.strictEqual(f.excess, 100);
  assert.ok(/1 file is over its per-file cap by 100 words/.test(f.note), f.note);
});

check('over-budget carries no directory total, so nothing can print an unclearable number', () => {
  // The caller prints "N words, over M" whenever words is set. Carrying the
  // total here is what put the number nobody could move back on screen.
  const r = memory.audit({ dir: dirWith({ 'big.md': file('reference', 4000) }) });
  const f = r.findings.find((x) => x.kind === 'over-budget');
  assert.strictEqual(f.words, undefined);
  assert.strictEqual(f.limit, undefined);
});

check('over-budget says "files are" when more than one is over', () => {
  const r = memory.audit({
    dir: dirWith({ 'a.md': file('reference', 4000), 'b.md': file('project', 1000) }),
  });
  const f = r.findings.find((x) => x.kind === 'over-budget');
  assert.strictEqual(f.files, 2);
  assert.ok(/2 files are over their per-file cap/.test(f.note), f.note);
});

check('budgets can be overridden one key at a time', () => {
  const dir = dirWith({ 'HANDOFF.md': file('project', 1000) });
  assert.ok(kinds(memory.audit({ dir })).includes('oversize-live'));
  const relaxed = memory.audit({ dir, config: { liveFileWords: 5000 } });
  assert.ok(!kinds(relaxed).includes('oversize-live'));
  // Overriding one limit must not quietly reset the others.
  assert.strictEqual(relaxed.limits.durableFileWords, memory.DEFAULTS.durableFileWords);
});

// ------------------------------------------------------------ index rot ----

check('a file the index does not mention is flagged', () => {
  const dir = dirWith({
    'MEMORY.md': '- [A](a.md) hook\n',
    'a.md': file('project', 10),
    'orphan.md': file('project', 10),
  });
  const f = memory.audit({ dir }).findings.find((x) => x.kind === 'unlisted');
  assert.ok(f, 'an unlisted file was not flagged');
  assert.strictEqual(f.file, 'orphan.md');
});

check('an index entry pointing at nothing is flagged', () => {
  const dir = dirWith({
    'MEMORY.md': '- [A](a.md) hook\n- [Gone](gone.md) hook\n',
    'a.md': file('project', 10),
  });
  assert.ok(kinds(memory.audit({ dir })).includes('dangling-index'));
});

check('a fully consistent index produces neither finding', () => {
  const dir = dirWith({
    'MEMORY.md': '- [A](a.md) hook\n- [B](b.md) hook\n',
    'a.md': file('project', 10),
    'b.md': file('reference', 10),
  });
  const k = kinds(memory.audit({ dir }));
  assert.ok(!k.includes('unlisted') && !k.includes('dangling-index'), k.join(', '));
});

check('the index itself is never reported as unlisted', () => {
  const dir = dirWith({ 'MEMORY.md': '- [A](a.md) hook\n', 'a.md': file('project', 10) });
  assert.ok(!memory.audit({ dir }).findings.some((f) => f.file === 'MEMORY.md'));
});

// ---------------------------------------------------------------- links ----

check('a link resolving to nothing is flagged', () => {
  const dir = dirWith({ 'a.md': file('project', 10, ['nowhere']) });
  const f = memory.audit({ dir }).findings.find((x) => x.kind === 'broken-link');
  assert.ok(f);
  assert.strictEqual(f.target, 'nowhere');
});

check('a link that resolves is not flagged', () => {
  const dir = dirWith({ 'a.md': file('project', 10, ['b']), 'b.md': file('project', 10) });
  assert.ok(!kinds(memory.audit({ dir })).includes('broken-link'));
});

check('link matching ignores case', () => {
  // HANDOFF.md is linked as [[handoff]] in several real files. Matching on
  // case would invent broken links, and a check that reports imaginary
  // problems gets ignored along with its real ones.
  const dir = dirWith({ 'a.md': file('project', 10, ['handoff']), 'HANDOFF.md': file('project', 10) });
  assert.ok(!kinds(memory.audit({ dir })).includes('broken-link'));
});

// ------------------------------------------------------------- the edges ----

check('a missing directory returns null rather than throwing', () => {
  assert.strictEqual(memory.audit({ dir: '/no/such/place/at/all' }), null);
});

check('an empty directory is clean, not broken', () => {
  const r = memory.audit({ dir: dirWith({}) });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.total, 0);
});

check('a directory with no index skips the index checks without complaining', () => {
  const dir = dirWith({ 'a.md': file('project', 10) });
  const k = kinds(memory.audit({ dir }));
  assert.ok(!k.includes('unlisted') && !k.includes('dangling-index'));
});

// ------------------------------------------------------- what gets printed ----
//
// Driven through the CLI, because every bug this repository has shipped lived
// in a printing path no test executed, and three of them were the printed
// sentence contradicting data that was already correct.

function cli(home, cwd) {
  return spawnSync(process.execPath, [CLI, 'memory-check', '--home', home, '--cwd', cwd],
    { encoding: 'utf8' }).stdout;
}

function homeWithMemory(cwd, files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-h-'));
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(home, '.claude', 'projects', slug, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return home;
}

check('a project with no memory directory says so instead of failing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-h-'));
  assert.match(cli(home, '/some/project'), /No memory directory/);
});

check('a clean directory prints the total and nothing to act on', () => {
  const home = homeWithMemory('/p', { 'MEMORY.md': '- [A](a.md) h\n', 'a.md': file('project', 10) });
  const out = cli(home, '/p');
  assert.match(out, /Nothing to act on/);
  assert.match(out, /words across 2 files/, out);
});

// The count printed beside the total must cover the same set the total does.
//
// It did not. `total` summed every file including the index and the sentence
// printed it against a list that had been filtered to exclude the index, so it
// said "8957 words across 10 files" when 8957 covered eleven. Both numbers were
// individually right.
//
// That is the fourth time in this plugin that two correct values were printed
// next to each other and the sentence was wrong, and it happened inside the
// check written to catch exactly that. So this asserts the relationship rather
// than either number, which is the assertion the earlier version was missing:
// it matched the substring "words across N files" without ever checking that N
// described the same files as the total.

check('the printed file count covers the same files as the printed total', () => {
  const home = homeWithMemory('/p', {
    'MEMORY.md': '- [A](a.md) h\n- [B](b.md) h\n',
    'a.md': file('project', 10),
    'b.md': file('reference', 10),
  });
  const out = cli(home, '/p');
  const m = out.match(/(\d+) words across (\d+) files/);
  assert.ok(m, `no summary line in: ${out}`);
  assert.strictEqual(Number(m[2]), 3, 'the index is a file that loads and must be counted');
});

check('the total equals the sum of every file, index included', () => {
  const dir = dirWith({
    'MEMORY.md': 'one two three',
    'a.md': file('project', 10),
    'b.md': file('reference', 10),
  });
  const r = memory.audit({ dir });
  const summed = memory.scan(dir).reduce((n, f) => n + f.words, 0);
  assert.strictEqual(r.total, summed);
  assert.strictEqual(r.fileCount, 3);
  // And the set the findings iterate is deliberately smaller, which is the
  // discrepancy that caused the bug. Both are correct; they are just not the
  // same thing, and nothing may print one against the other.
  assert.strictEqual(r.files.length, 2);
});

check('the count is right when there is no index at all', () => {
  const dir = dirWith({ 'a.md': file('project', 10) });
  const r = memory.audit({ dir });
  assert.strictEqual(r.fileCount, 1);
  assert.strictEqual(r.files.length, 1);
});

check('one file reads as "1 file", not "1 files"', () => {
  // Every other count in this CLI guards its plural. This one did not, in the
  // component whose stated purpose is that the printed sentence matches what is
  // true.
  const home = homeWithMemory('/p', { 'a.md': file('project', 10) });
  const out = cli(home, '/p');
  assert.match(out, /across 1 file,/, out);
  assert.doesNotMatch(out, /1 files/);
});

check('more than one file still reads as "files"', () => {
  const home = homeWithMemory('/p', { 'a.md': file('project', 10), 'b.md': file('project', 10) });
  assert.match(cli(home, '/p'), /across 2 files,/);
});

// ------------------------------------------------------ format assumptions ----
//
// Both of these were verified against the live memory directory before being
// hardened: real files nest `type:` under `metadata:` and all ten classify, and
// the real index uses markdown links. Neither was broken.
//
// They are pinned anyway because the failure mode of getting either wrong is
// silence, and silence in opposite directions. A type that stops resolving
// drops every file into the permissive budget and the check never fires again.
// An index format that stops resolving flags every file at once. One is ignored
// and the other is switched off, and both end with nobody measuring anything.

check('a type nested under metadata is read', () => {
  const dir = dirWith({
    'a.md': '---\nname: x\nmetadata:\n  node_type: memory\n  type: project\n---\n\n' + 'word '.repeat(2000),
  });
  assert.ok(kinds(memory.audit({ dir })).includes('oversize-live'));
});

check('node_type is not mistaken for type', () => {
  // If it were, a durable file declaring `node_type: memory` would be judged
  // against the live budget.
  assert.strictEqual(memory.declaredType('---\nmetadata:\n  node_type: memory\n---\n'), null);
});

check('a quoted type still resolves', () => {
  // `type: "project"` would otherwise capture the quotes, match no known kind,
  // and silently drop the file into the permissive budget forever.
  for (const raw of ['"project"', "'project'", 'project']) {
    assert.strictEqual(memory.declaredType(`---\nmetadata:\n  type: ${raw}\n---\n`), 'project');
  }
});

check('an index written with wiki-links does not flag every file at once', () => {
  // The live index uses markdown links. If one were ever written the other way,
  // reading only markdown would find no links and report every file as
  // unlisted. A check that fires on everything gets switched off.
  const dir = dirWith({
    'MEMORY.md': '- [[alpha]] the first\n- [[beta]] the second\n',
    'alpha.md': file('project', 10),
    'beta.md': file('reference', 10),
  });
  assert.ok(!kinds(memory.audit({ dir })).includes('unlisted'), 'wiki-link index flagged everything');
});

check('a mixed-style index resolves both kinds', () => {
  const dir = dirWith({
    'MEMORY.md': '- [Alpha](alpha.md) one\n- [[beta]] two\n',
    'alpha.md': file('project', 10),
    'beta.md': file('reference', 10),
  });
  assert.ok(!kinds(memory.audit({ dir })).includes('unlisted'));
});

check('a genuinely unlisted file is still caught with either style', () => {
  // The other direction, so accepting both formats cannot have quietly turned
  // the check off.
  const dir = dirWith({
    'MEMORY.md': '- [[alpha]] one\n',
    'alpha.md': file('project', 10),
    'orphan.md': file('project', 10),
  });
  const f = memory.audit({ dir }).findings.find((x) => x.kind === 'unlisted');
  assert.ok(f, 'an orphan survived a wiki-link index');
  assert.strictEqual(f.file, 'orphan.md');
});

check('a finding is printed with the file and the numbers', () => {
  const home = homeWithMemory('/p', { 'HANDOFF.md': file('project', 2000) });
  const out = cli(home, '/p');
  assert.match(out, /oversize-live/);
  assert.match(out, /HANDOFF\.md/);
  assert.doesNotMatch(out, /Nothing to act on/);
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
