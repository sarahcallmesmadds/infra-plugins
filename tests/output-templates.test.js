#!/usr/bin/env node
// No em dashes in text a skill tells the model to say out loud.
//
// Run: node tests/output-templates.test.js
//
// These plugins ship a Stop hook that blocks em dashes in the assistant's own
// writing. Twenty-four output templates across build-loop instructed the model
// to print one, so a skill would produce a message, the hook would block it,
// and the model would rewrite it. Every time. Nobody noticed because the
// rewrite succeeds and the answer still arrives.
//
// The distinction that matters: an em dash in prose explaining behaviour, or
// in a SKILL.md section heading, never reaches anybody. One in text the skill
// reproduces does. Prose and section headings stay as they are, since
// rewriting them would churn a lot of files to fix nothing.
//
// Two kinds of output are checked, because the first pass only looked at one
// and the miss was not the harmless category the comment claimed.
//
//   1. A quoted string on a line that says to print it.
//   2. A fenced block that a skill reproduces verbatim.
//
// The second was originally excluded on the reasoning that a `##` heading is
// structure. That is true of a SKILL.md section heading and false of a `##`
// line inside a display template: `## Build loop queue — {filter_label}` is
// printed exactly as written, every time /list-bugs runs. The same went for
// the numbered findings in /built-check and the routing list in /find-skill.
// So the previous version of this file passed while three commands still
// tripped the hook on every invocation.
//
// Still not covered, and genuinely so this time: values written into a file
// that gets displayed later, such as a queue entry's what_expected. Those have
// no syntax marking them as output and reaching them means flagging prose. A
// linter that cries wolf gets switched off, and then catches nothing at all.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PLUGINS = path.join(__dirname, '..', 'plugins');

// Lines that make the model emit text. A quoted string on one of these reaches
// the user; a quoted string anywhere else is being talked about, not printed.
const SAYS = [
  /^\s*>\s*"/,                       // > "..."      a displayed message
  /^\s*>\s*`?Print:/i,               // > Print: "..."
  /\bDisplay:\s*"/,                  // Display: "..."
  /\b(say|respond|ask)(s|ed)?:?\s+"/i, // say "...", respond "...", ask: "..."
];

// Real exceptions, each with a reason. An entry here is a decision, not a
// silencer, so it names the file and what the string actually is.
const ALLOWED = [
  // A placeholder telling the author what belongs in the slot. The text inside
  // the braces describes the content and is substituted away, so the em dash
  // is never printed.
  { file: 'build-loop/skills/verify-fix/SKILL.md', contains: 'verbatim old text from the target file' },
  { file: 'build-loop/skills/verify-fix/SKILL.md', contains: 'verbatim new text as it will appear' },
  { file: 'build-loop/skills/verify-fix/SKILL.md', contains: 'the lines most likely changed' },
  { file: 'build-loop/skills/apply-fix/SKILL.md', contains: 'verbatim or close paraphrase' },
  // A fenced block describing the shape of a queue entry for the author's
  // benefit. Field notes, not a template that gets reproduced.
  { file: 'build-loop/skills/whats-breaking/SKILL.md', contains: 'the name of the thing corrected' },
  // The session_id field note was excused here until 0.9.6. That line was
  // rewritten when the counting rule stopped reading an empty session_id, and
  // it carries no em dash now, so the exception went with it rather than
  // staying behind to excuse something else.
  { file: 'build-loop/skills/whats-breaking/SKILL.md', contains: 'free text' },
  { file: 'build-loop/skills/whats-breaking/SKILL.md', contains: 'absolute path to the file a fix would edit' },
];

// Fences holding text a skill reproduces. A `bash` or `json` fence is a command
// or a data shape, and an em dash in either is a comment about the code rather
// than something anybody sees.
const DISPLAY_FENCE = new Set(['', 'text', 'markdown', 'md']);

function skillFiles() {
  const out = [];
  for (const plugin of fs.readdirSync(PLUGINS)) {
    const skills = path.join(PLUGINS, plugin, 'skills');
    if (!fs.existsSync(skills)) continue;
    for (const skill of fs.readdirSync(skills)) {
      const f = path.join(skills, skill, 'SKILL.md');
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

// The em dash has to be inside the quotes to count. `say "x" — and then` is
// prose with a quote in it, not a quote with an em dash in it.
function quotedSpansWithEmDash(line) {
  const spans = line.match(/"[^"]*"/g) || [];
  return spans.filter((s) => s.includes('—'));
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

check('no skill tells the model to print an em dash', () => {
  const offenders = [];
  for (const file of skillFiles()) {
    const rel = file.slice(PLUGINS.length + 1);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!SAYS.some((re) => re.test(line))) return;
      for (const span of quotedSpansWithEmDash(line)) {
        const excused = ALLOWED.some((a) => a.file === rel && span.includes(a.contains));
        if (!excused) offenders.push(`${rel}:${i + 1}  ${span.slice(0, 90)}`);
      }
    });
  }
  assert.strictEqual(
    offenders.length, 0,
    `these templates would be blocked by the slop-check Stop hook:\n        `
    + offenders.join('\n        ')
  );
});

check('no fenced display block prints an em dash', () => {
  // The category the first version of this file waved through. A `##` line in
  // a display template is not a section heading, it is a line the model copies
  // out verbatim.
  const offenders = [];
  for (const file of skillFiles()) {
    const rel = file.slice(PLUGINS.length + 1);
    let inFence = false;
    let info = '';
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const fence = line.match(/^\s*```(\S*)/);
      if (fence) {
        if (!inFence) { inFence = true; info = fence[1]; } else { inFence = false; }
        return;
      }
      if (!inFence || !DISPLAY_FENCE.has(info) || !line.includes('—')) return;
      const excused = ALLOWED.some((a) => a.file === rel && line.includes(a.contains));
      if (!excused) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 80)}`);
    });
  }
  assert.strictEqual(
    offenders.length, 0,
    `these lines are printed verbatim and would be blocked:\n        ` + offenders.join('\n        ')
  );
});

check('no output template repeats a conjunction', () => {
  // Swapping an em dash for punctuation is mechanical and the grammar is not.
  // One substitution produced "failed, but the revert DID succeed …, but the
  // queue file was not updated", two `but` clauses in a row, in the message
  // someone reads at the exact moment something has gone wrong.
  //
  // This will not catch every clumsy sentence. It catches the one shape that a
  // find-and-replace reliably creates: a joining word that now appears twice in
  // a sentence that only ever wanted it once.
  const JOINERS = ['but', 'then', 'however', 'although', 'because'];
  const offenders = [];
  for (const file of skillFiles()) {
    const rel = file.slice(PLUGINS.length + 1);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!SAYS.some((re) => re.test(line))) return;
      for (const span of (line.match(/"[^"]*"/g) || [])) {
        for (const word of JOINERS) {
          const hits = (span.match(new RegExp(`(^|[\\s,;(])${word}\\b`, 'gi')) || []).length;
          if (hits > 1) offenders.push(`${rel}:${i + 1}  "${word}" ${hits}x  ${span.slice(0, 80)}`);
        }
      }
    });
  }
  assert.strictEqual(
    offenders.length, 0,
    `a joining word repeats inside one displayed message:\n        ` + offenders.join('\n        ')
  );
});

check('the exception list still describes strings that exist', () => {
  // An allowlist that has drifted off its target silences a real finding
  // without anybody noticing, which is the failure mode of allowlists.
  for (const a of ALLOWED) {
    const full = path.join(PLUGINS, a.file);
    assert.ok(fs.existsSync(full), `allowed entry names a file that is gone: ${a.file}`);
    assert.ok(
      fs.readFileSync(full, 'utf8').includes(a.contains),
      `allowed entry no longer matches anything in ${a.file}: "${a.contains}". `
      + 'Remove it rather than leaving it to excuse something else.'
    );
  }
});

check('the check would actually catch one', () => {
  // A linter nobody has seen fail is a linter nobody should trust.
  const sample = '  > "Logged with missing {field} — you can edit it later."';
  assert.ok(SAYS.some((re) => re.test(sample)), 'the pattern list no longer matches a displayed message');
  assert.strictEqual(quotedSpansWithEmDash(sample).length, 1, 'an em dash inside a displayed quote was not seen');

  const prose = 'Do not hide broken entries — the user needs to see "them".';
  assert.strictEqual(
    quotedSpansWithEmDash(prose).length, 0,
    'prose with a quote in it was counted, which would flag explanation as output'
  );
});

console.log(`\n5 checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
