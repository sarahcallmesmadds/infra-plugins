#!/usr/bin/env node
// Tests for the skill-md-check PostToolUse hook.
//
// Run: node tests/skill-md-check.test.js
//
// The hook is a rebuild of one recovered from the Fermat work laptop on
// 2026-07-28. Two things changed in the port, and both are the point of this
// file.
//
// 1. The original required `type: human|agent`. Eight of the twenty-one skills
//    in this repository do not set it, so requiring it would report eight files
//    that are fine. Here it is validated when present and never required.
//
// 2. The original did not compare the frontmatter name against the directory.
//    That is the fault this repository keeps hitting: /audit-deps carries a
//    `notes` field for the disk-name-versus-frontmatter-name case, and
//    `skill-find` versus `find-skill` is the same skill shipped twice under two
//    names. So the check was added rather than ported.
//
// The hook is driven as a real child process over stdin, because the thing that
// broke guardrails through 0.2.0 was the shape of what a hook writes to stdout,
// and only running it can catch that.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'plugins', 'build-loop', 'hooks', 'skill-md-check.js');
const PLUGINS = path.join(__dirname, '..', 'plugins');

// See deps-keys.test.js for why this is compared rather than printed.
const EXPECTED_CHECKS = 16;

let failed = 0;
let ran = 0;
function check(what, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

// --- harness ---------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-md-check-'));

// Writes a SKILL.md into skills/<dirName>/ and runs the hook against it.
// Returns the parsed advisory, or null when the hook stayed quiet.
function run(dirName, body, toolName = 'Write') {
  const dir = path.join(tmp, 'skills', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, body);
  return runOnPath(file, toolName);
}

function runOnPath(file, toolName = 'Write') {
  const event = JSON.stringify({ tool_name: toolName, tool_input: { file_path: file } });
  const out = execFileSync(process.execPath, [HOOK], { input: event, encoding: 'utf8' });
  if (!out.trim()) return null;
  return JSON.parse(out);
}

const good = (name) => `---\nname: ${name}\ndescription: Does one clear thing.\n---\n\n# ${name}\n`;

// --- the hook stays out of the way -----------------------------------------

check('a well-formed SKILL.md produces no output at all', () => {
  assert.strictEqual(run('tidy', good('tidy')), null);
});

check('a non-SKILL.md write is ignored', () => {
  const file = path.join(tmp, 'README.md');
  fs.writeFileSync(file, 'no frontmatter here');
  assert.strictEqual(runOnPath(file), null);
});

check('a tool other than Write or Edit is ignored', () => {
  const dir = path.join(tmp, 'skills', 'readonly');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, 'no frontmatter');
  assert.strictEqual(runOnPath(file, 'Read'), null);
});

check('a path that does not exist is ignored rather than thrown on', () => {
  assert.strictEqual(runOnPath(path.join(tmp, 'nope', 'SKILL.md')), null);
});

check('Edit is checked as well as Write', () => {
  const r = run('via-edit', '# no frontmatter\n', 'Edit');
  assert.ok(r, 'Edit should be checked; only Write was');
});

// --- the shape of what it writes -------------------------------------------

check('the advisory uses the payload shape Claude Code actually reads', () => {
  // guardrails reached the right verdict and changed nothing for three
  // releases because the payload shape was wrong and nothing said so.
  const r = run('shape', '# no frontmatter\n');
  assert.ok(r.hookSpecificOutput, 'no hookSpecificOutput key');
  assert.strictEqual(r.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(
    typeof r.hookSpecificOutput.additionalContext === 'string'
      && r.hookSpecificOutput.additionalContext.length > 0,
    'additionalContext is what reaches the model; it is missing or empty'
  );
});

check('the hook never blocks', () => {
  const r = run('nonblocking', '# no frontmatter\n');
  const s = JSON.stringify(r);
  assert.ok(!/permissionDecision/.test(s), 'a PostToolUse hook cannot deny, and must not try');
  assert.ok(!/"decision"\s*:\s*"block"/.test(s), 'the hook tried to block');
});

// --- what it catches -------------------------------------------------------

check('missing frontmatter is reported', () => {
  const r = run('bare', '# just a heading\n');
  assert.match(r.hookSpecificOutput.additionalContext, /frontmatter/i);
});

check('an unterminated frontmatter block is reported', () => {
  const r = run('unterminated', '---\nname: unterminated\ndescription: x\n');
  assert.match(r.hookSpecificOutput.additionalContext, /frontmatter/i);
});

check('a missing name is reported', () => {
  const r = run('nameless', '---\ndescription: Does a thing.\n---\n');
  assert.match(r.hookSpecificOutput.additionalContext, /`name:`/);
});

check('a missing description is reported', () => {
  const r = run('undescribed', '---\nname: undescribed\n---\n');
  assert.match(r.hookSpecificOutput.additionalContext, /`description:`/);
});

check('a name that disagrees with its directory is reported', () => {
  // The find-skill versus skill-find case, caught at write time.
  const r = run('find-skill', good('skill-find'));
  const text = r.hookSpecificOutput.additionalContext;
  assert.match(text, /does not match the directory/);
  assert.ok(/find-skill/.test(text) && /skill-find/.test(text),
    'the advisory should name both halves so the fix is obvious');
});

// --- what it deliberately does not catch -----------------------------------

check('a folded description counts as present', () => {
  // Several skills here write `description: >` with the text on the following
  // indented lines. A naive regex reads the value as ">" and calls it set; a
  // stricter one calls it missing. Both are wrong.
  const r = run('folded', '---\nname: folded\ndescription: >\n  Does one clear thing,\n  across two lines.\n---\n');
  assert.strictEqual(r, null, 'a folded description was misread as missing');
});

check('type is validated when present and not required when absent', () => {
  assert.strictEqual(run('untyped', good('untyped')), null,
    'type is absent in some skills here and must not be required');
  const bad = run('mistyped', `---\nname: mistyped\ndescription: x\ntype: huamn\n---\n`);
  assert.match(bad.hookSpecificOutput.additionalContext, /type: huamn/);
});

check('the documented type counts match the repository inventory', () => {
  const files = [];
  for (const plugin of fs.readdirSync(PLUGINS)) {
    const skills = path.join(PLUGINS, plugin, 'skills');
    if (!fs.existsSync(skills)) continue;
    for (const name of fs.readdirSync(skills)) {
      const file = path.join(skills, name, 'SKILL.md');
      if (fs.existsSync(file)) files.push(file);
    }
  }
  const withoutType = files.filter((file) => !/^type:\s*(human|agent)\s*$/m.test(fs.readFileSync(file, 'utf8')));
  const claim = `${withoutType.length} of the ${files.length} skills`;
  const affectedFiles = `${withoutType.length} files that are fine`;
  const hook = fs.readFileSync(HOOK, 'utf8');
  const readme = fs.readFileSync(path.join(PLUGINS, 'build-loop', 'README.md'), 'utf8');
  assert.ok(hook.includes(claim), `hook does not contain the current count: ${claim}`);
  assert.ok(hook.includes(affectedFiles), `hook does not contain the current unaffected-file count: ${affectedFiles}`);
  assert.ok(readme.includes(claim), `README does not contain the current count: ${claim}`);
  assert.ok(readme.includes(affectedFiles), `README does not contain the current unaffected-file count: ${affectedFiles}`);
});

// --- against the real repository -------------------------------------------

check('every SKILL.md in this repository passes its own hook', () => {
  const offenders = [];
  for (const plugin of fs.readdirSync(PLUGINS)) {
    const skills = path.join(PLUGINS, plugin, 'skills');
    if (!fs.existsSync(skills)) continue;
    for (const name of fs.readdirSync(skills)) {
      const file = path.join(skills, name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const r = runOnPath(file);
      if (r) offenders.push(`${plugin}/${name}: ${r.hookSpecificOutput.additionalContext.slice(0, 120)}`);
    }
  }
  assert.strictEqual(offenders.length, 0, `\n        ${offenders.join('\n        ')}`);
});

// --- teardown --------------------------------------------------------------

fs.rmSync(tmp, { recursive: true, force: true });

if (ran !== EXPECTED_CHECKS) {
  failed += 1;
  console.log(
    `  FAIL  the file runs the number of checks it expects to\n`
    + `        expected ${EXPECTED_CHECKS}, ran ${ran}. Update EXPECTED_CHECKS when adding one.`
  );
}

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed === 0 ? 0 : 1);
