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

function bashGrantPrefixes(line) {
  return [...line.matchAll(/Bash\(([^):]+):\*\)/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function commandIsGranted(command, grants) {
  return grants.some((grant) => {
    const pattern = grant.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${pattern}(?:$| )`).test(command);
  });
}

function commandForGrantCheck(command) {
  const token = command.split(/\s/)[0];
  if (!token) return null;
  const normalizedToken = token.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const executable = normalizedToken.replace(/["']/g, '').split('/').pop();
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(executable)) return null;
  const args = command.slice(token.length)
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
  return {
    command: `${normalizedToken}${args}`,
    executable,
  };
}

function shellSegments(block) {
  // Heredocs must be removed before quoted strings, or stripping a quoted
  // delimiter such as 'PY' leaves the program body behind. Quoted arguments
  // are then blanked before separators are split, so `git commit -m "a; b"`
  // cannot invent a command called `b`.
  const body = block
    .replace(/<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\n[\s\S]*?\n\1\n?/g, '\n')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
  return body.split('\n').flatMap((raw) => {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith('#')) return [];
    return stripped.split(/\|\||&&|\||;/).map((segment) => segment.trim()).filter(Boolean);
  });
}

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

check('a leading ~ is expanded in every copy of the check', () => {
  // `[ -e "~/x" ]` is false for every path, so without this every home-relative
  // source reads as missing. The expansion happens in node, not in the shell.
  //
  // Counted rather than merely present. The one-liner appears twice, in Step A3
  // and Step L4, and an earlier version of this assertion passed while one of
  // the two had its expansion removed. "It appears somewhere" is not the claim
  // worth making about a snippet that is duplicated.
  const invocations = (toBuild.match(/process\.argv\.slice\(1\)/g) || []).length;
  const expansions = (toBuild.match(/p\.startsWith\("~"\)\s*\?\s*h\s*\+\s*p\.slice\(1\)/g) || []).length;
  assert.ok(invocations >= 2, `expected the check in both Step A3 and Step L4, found ${invocations}`);
  assert.strictEqual(
    expansions, invocations,
    `${invocations} copies of the source check but only ${expansions} expand ~, so at least one reports every home-relative path as missing`
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
    // Assignment-shaped builtins. The comment above says builtins are not
    // commands a permission list names, and these are builtins, so their
    // absence was an oversight rather than a decision. `export FOO=1` in
    // status-bar read as a command called export and would have forced a
    // grant for it.
    'export', 'unset', 'shift', 'trap', 'eval', 'source', 'true', 'false',
  ]);

  const offenders = [];
  for (const [name, file] of files) {
    const text = fs.readFileSync(file, 'utf8');
    const frontmatter = text.slice(0, text.indexOf('---', 4));
    const line = (frontmatter.match(/allowed-tools:\s*(.+)/) || [])[1];
    if (!line) continue;
    // A bare `Bash` grant, with no parenthesised command, permits everything.
    if (/\bBash\b(?!\s*\()/.test(line)) continue;
    // Grants may restrict a binary to a subcommand or exact argument prefix.
    // Keep that complete prefix so `git log` cannot authorize `git push`.
    const granted = bashGrantPrefixes(line);

    const used = new Set();
    for (const block of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
      const lead = text.slice(Math.max(0, block.index - 80), block.index);
      // Some dynamic absolute paths cannot be expressed as a portable scoped
      // permission. They must say explicitly that normal approval is expected
      // instead of widening allowed-tools or silently bypassing this audit.
      if (/<!-- bash-approval-required -->\s*$/.test(lead)) continue;
      // Strip quoted strings first, or the contents of a `node -e '...'`
      // program read as commands. `const` is not a shell command.
      // Heredoc bodies go first, for the reason the quote stripping below
      // already gives: a program handed to another interpreter is not shell.
      // `python3 - <<'PY'` in find-skill put `import`, `CONFIG` and `rel` into
      // the used set, and stripping quotes cannot reach them because a heredoc
      // is not quoted.
      for (const command of shellSegments(block[1])) {
        const parsed = commandForGrantCheck(command);
        if (!parsed || BUILTIN.has(parsed.executable)) continue;
        used.add(parsed);
      }
    }
    const missing = [...used]
      .filter(({ command }) => !commandIsGranted(command, granted))
      .map(({ command, executable }) => command.startsWith(executable) ? command : `${executable} (${command})`)
      .sort();
    if (missing.length) offenders.push(`${name}: runs ${missing.join(', ')} but grants ${granted.sort().join(', ') || '(nothing)'}`);
  }
  assert.deepStrictEqual(offenders, [], `\n  ${offenders.join('\n  ')}`);
});

check('quoted path commands remain visible to the grant check', () => {
  const parsed = commandForGrantCheck(
    '"${CLAUDE_PLUGIN_ROOT}"/bin/hook-node "${CLAUDE_PLUGIN_ROOT}"/statusline/install.js'
  );
  assert.deepStrictEqual(parsed, {
    command: '""/bin/hook-node ""/statusline/install.js',
    executable: 'hook-node',
  });
  assert.ok(!commandIsGranted(parsed.command, ['node']));
});

check('status-bar scopes ls and marks its dynamic launcher as approval-required', () => {
  const statusBar = fs.readFileSync(
    path.join(__dirname, '..', 'plugins', 'session', 'skills', 'status-bar', 'SKILL.md'),
    'utf8'
  );
  const frontmatter = statusBar.slice(0, statusBar.indexOf('---', 4));
  assert.match(frontmatter, /Bash\(ls:\*\)/);
  assert.doesNotMatch(frontmatter, /Bash\(\*\/bin\/hook-node:\*\)/);
  assert.match(statusBar, /<!-- bash-approval-required -->\s*```bash\n"\$\{CLAUDE_PLUGIN_ROOT\}"\/bin\/hook-node/);
});

check('quoted separators do not invent shell commands', () => {
  assert.deepStrictEqual(shellSegments('git commit -m "add; stuff | more"\n'), [
    'git commit -m ""',
  ]);
});

check('restricted Bash grants retain their full prefix and stop at delimiters', () => {
  const grants = bashGrantPrefixes('Read, Bash(ls), Bash(git log:*), Bash(gh pr view:*)');
  assert.deepStrictEqual(grants, ['git log', 'gh pr view']);
  assert.ok(commandIsGranted('git log --oneline main..topic', grants));
  assert.ok(commandIsGranted('gh pr view 77 --json url', grants));
  assert.ok(!commandIsGranted('git push --force', grants));
  assert.ok(!commandIsGranted('gh pr merge 77', grants));
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
