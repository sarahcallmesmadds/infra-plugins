#!/usr/bin/env node
// Regression tests for the `source` field on a to-build item.
//
// Run: node tests/to-build-source.test.js
//
// The fault: nine open items recorded "port from <file>.js in hq-skills PR #1".
// That repository was archived and taken off the machine, and nothing surfaced
// the dead reference. It was found by someone sitting down to build one of the
// items and discovering the material was gone. A recorded source that no longer
// resolves should be visible when the list is read, not at build time.
//
// The rejected alternative is pinned here too, because it is the obvious one
// and it is wrong: scanning `what`, `why` and `where` for path-shaped strings
// would warn about `where`, which holds the DESTINATION and is supposed to be
// missing until the thing is built. A skill that cries wolf on the healthy case
// gets ignored on the real one.
//
// /to-build and /built-check are prose rather than code, so what can be tested
// is the contract the three files state, and that they state it compatibly.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'plugins', 'build-loop');
const toBuild = fs.readFileSync(path.join(ROOT, 'skills', 'to-build', 'SKILL.md'), 'utf8');
const builtCheck = fs.readFileSync(path.join(ROOT, 'skills', 'built-check', 'SKILL.md'), 'utf8');
const schema = fs.readFileSync(path.join(ROOT, 'reference', 'SCHEMA-BUILD.md'), 'utf8');

let failed = 0;
function check(what, fn) {
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

// --- the field exists in all three places that have to agree ---------------

check('the schema documents `source` as an optional field', () => {
  assert.ok(/\|\s*`source`\s*\|/.test(schema), 'no `source` row in the field reference table');
  const row = schema.split('\n').find((l) => /\|\s*`source`\s*\|/.test(l));
  assert.ok(/\|\s*no\s*\|/.test(row), `\`source\` is not marked optional: ${row}`);
});

check('the schema example carries the field, so a copied example is complete', () => {
  assert.ok(/"source":/.test(schema), 'the example entry has no `source` key');
});

check('$schema_version is not bumped for an optional addition', () => {
  assert.ok(
    /Currently 1\./.test(schema),
    'the field reference no longer says the schema version is 1'
  );
  assert.ok(
    /\$schema_version.{0,40}stays at 1/s.test(schema),
    'the changelog does not record that the version deliberately stayed at 1'
  );
});

check('/to-build writes the field when it composes an item', () => {
  assert.ok(/^source:\s/m.test(toBuild), 'Step A4 does not list `source` among the fields written');
});

check('/to-build shows the field in the draft before writing', () => {
  assert.ok(/^Source:\s*\{source/m.test(toBuild), 'the Step A3 draft does not show Source');
});

// --- the check itself ------------------------------------------------------

check('the list mode checks recorded sources', () => {
  assert.ok(
    /Check recorded sources/i.test(toBuild),
    'no step in /to-build checks whether a source resolves'
  );
});

check('a leading ~ is expanded before the check', () => {
  // `[ -e "~/x" ]` is false for every path, so without this every home-relative
  // source reads as missing. The expansion happens in node, not in the shell.
  assert.ok(
    /p\.startsWith\("~"\)\s*\?\s*h\s*\+\s*p\.slice\(1\)/.test(toBuild),
    'the source check does not expand ~, so ~-relative paths all read as missing'
  );
});

check('the check is batched, not one tool call per item', () => {
  assert.ok(
    /process\.argv\.slice\(1\)/.test(toBuild),
    'the source check does not take many paths in one command'
  );
});

check('settled items are not source-checked', () => {
  // Found in review. `/to-build all` and `/to-build built` would otherwise warn
  // about Built and Dropped items, whose material is expected to be gone and
  // where nothing is actionable.
  assert.ok(
    /Skip `Built` and `Dropped` items even when the filter asked for them/.test(toBuild),
    'the source check runs on Built and Dropped items, where the warning is noise'
  );
});

// --- what the check must NOT do -------------------------------------------

check('`where` is explicitly excluded from the path check', () => {
  assert.ok(
    /Only `source` is checked\.\*\* Not `where`/.test(toBuild),
    '/to-build does not state that `where` is excluded from the source check'
  );
  assert.ok(
    /destination, not a source/i.test(schema),
    'the schema does not warn that `where` is a destination'
  );
});

check('a missing source does not change the item status', () => {
  assert.ok(
    /A missing source does not change the item's status/.test(toBuild),
    'nothing stops a dead source being treated as a status change or a blocker'
  );
});

check('nothing is printed when every source resolves', () => {
  assert.ok(
    /Do not print the block, the heading, or a reassurance/.test(toBuild),
    'the skill may print an all-clear line on every run, which trains the reader to skip it'
  );
});

// --- the dependent skill ---------------------------------------------------

check('/built-check does not treat `source` as evidence of being built', () => {
  assert.ok(
    /`source` is excluded from this sweep/.test(builtCheck),
    'built-check stats paths found in item text and does not exclude `source`, so an item ' +
    'would look built the moment its spec existed'
  );
});

check('/built-check names exactly the fields it reads for paths', () => {
  assert.ok(
    /Only `what` and `why` are read for paths here\./.test(builtCheck),
    'built-check does not pin which fields its path sweep covers'
  );
});

// --- the class of fault this was, across every skill -----------------------

check('no skill names a shell command its allowed-tools does not grant', () => {
  // The bug in review: the source check was written as `stat` and a bare
  // `for ... [ -e ]` loop, and to-build's allowed-tools grants neither. The
  // step read perfectly and would have failed at the moment of use, which is
  // the exact failure this whole change exists to prevent.
  //
  // The repository already pins one instance of this (queue-writes.test.js
  // checks that callers of queue.js grant Bash(node:*)). This generalises it,
  // so the next step written with an ungranted command fails here instead of
  // in front of somebody.
  const SKILLS = path.join(__dirname, '..', 'plugins');
  const files = [];
  for (const plugin of fs.readdirSync(SKILLS)) {
    const dir = path.join(SKILLS, plugin, 'skills');
    if (!fs.existsSync(dir)) continue;
    for (const s of fs.readdirSync(dir)) {
      const f = path.join(dir, s, 'SKILL.md');
      if (fs.existsSync(f)) files.push([`${plugin}/${s}`, f]);
    }
  }
  assert.ok(files.length > 0, 'found no skills to check, so this test proves nothing');

  // Shell keywords and builtins are not commands a permission list names.
  const BUILTIN = new Set([
    'for', 'do', 'done', 'if', 'then', 'fi', 'else', 'elif', 'while', 'case',
    'esac', 'echo', 'cd', 'exit', 'set', 'local', 'read', 'printf', 'return',
  ]);

  const offenders = [];
  for (const [name, file] of files) {
    const text = fs.readFileSync(file, 'utf8');
    const frontmatter = text.slice(0, text.indexOf('---', 4));
    const line = (frontmatter.match(/allowed-tools:\s*(.+)/) || [])[1];
    if (!line) continue;
    // A bare `Bash` grant, with no parenthesised command, permits everything.
    if (/\bBash\b(?!\s*\()/.test(line)) continue;
    const granted = new Set([...line.matchAll(/Bash\(([a-zA-Z0-9_.-]+):/g)].map((m) => m[1]));

    const used = new Set();
    for (const block of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
      // Strip quoted strings first, or the contents of a `node -e '...'`
      // program read as commands. `const` is not a shell command.
      const body = block[1].replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
      for (const raw of body.split('\n')) {
        const stripped = raw.trim();
        if (!stripped || stripped.startsWith('#')) continue;
        for (const seg of stripped.split(/\|\||&&|\||;/)) {
          const word = seg.trim().split(/\s/)[0];
          if (!word || BUILTIN.has(word)) continue;
          if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(word)) continue;
          used.add(word);
        }
      }
    }
    const missing = [...used].filter((c) => !granted.has(c)).sort();
    if (missing.length) offenders.push(`${name}: runs ${missing.join(', ')} but grants ${[...granted].sort().join(', ') || '(nothing)'}`);
  }
  assert.deepStrictEqual(offenders, [], `\n  ${offenders.join('\n  ')}`);
});

// --- the printed text obeys the house style --------------------------------

check('no em dash in the lines these skills print', () => {
  // The Stop hook blocks em dashes in assistant output, so one inside a display
  // template means a rewrite on every single invocation. Section headings are
  // exempt: they reach nobody.
  for (const [name, text] of [['to-build', toBuild], ['built-check', builtCheck]]) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (/^#{1,6}\s/.test(line)) return;
      if (!line.includes('—')) return;
      const quoted = /^>/.test(line.trim()) || /^\s*"/.test(line);
      assert.ok(!quoted, `${name}:${i + 1} prints an em dash: ${line.trim().slice(0, 70)}`);
    });
  }
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  to-build-source.test.js  ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
