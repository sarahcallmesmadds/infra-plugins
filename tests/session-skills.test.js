#!/usr/bin/env node
// The load-bearing instructions in /wrap and /pickup, pinned so they cannot be
// deleted quietly.
//
// Run: node tests/session-skills.test.js
//
// Everything under plugins/session/scripts is covered end to end by
// session-handoffs.test.js. None of that was the bug.
//
// The bug was that /wrap reported saving a handoff it had never written. The
// plumbing behaved correctly throughout: `cli.js target` recorded the intended
// path, `cli.js find` would have reported no file at that path, and nothing
// ever asked it. The fix was three paragraphs of instruction added to
// wrap/SKILL.md telling the skill to run that check and to change what it says
// when the check comes back empty.
//
// CORRECTION, and the reason this header no longer says what it did.
//
// The first version of this file claimed nothing read wrap/SKILL.md. That was
// wrong. session-handoffs.test.js has read it since e419218, the commit that
// made the fix, and pins four things there: that Step 2 ends by checking the
// file, that the summary template does not carry the success lines, that the
// condition precedes the ending it governs, and that the failure ending offers
// no pickup slug. Those cover the wrap half of this file almost exactly.
//
// The claim survived a grep because that suite builds the path as
// path.join(ROOT, 'skills', 'wrap', 'SKILL.md'), and the grep looked for the
// literal 'skills/wrap'. Worth remembering before concluding that anything
// here is uncovered: a constructed path matches no search for the path.
//
// What was genuinely uncovered is pickup/SKILL.md, which nothing read at all.
// The pickup checks below are the part of this file that earns its place. The
// wrap checks are kept deliberately, and the duplication is the point: they
// assert against the whole file where the older ones slice it by section, so a
// step moved wholesale out of Step 2 fails here and passes there.
//
// These checks pin behaviour rather than sentences. Rewording is fine. Removing
// the step, or moving the success line back inside the template that gets
// copied, is not.
//
// The subtlest one is the third. An earlier version of Step 4 had "Handoff
// saved to [path]" and the /pickup line sitting inside the summary template,
// with the condition written as prose underneath. A template that can be copied
// without reading the condition will be, which is the same failure one level
// along: the good outcome is stated where it is read first and the qualification
// arrives where it is skimmed past. Nothing about that is visible to a check
// that only greps for the presence of words, because all the right words are
// present. It needs the position.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SKILLS = path.join(__dirname, '..', 'plugins', 'session', 'skills');

function skill(name) {
  const file = path.join(SKILLS, name, 'SKILL.md');
  assert.ok(fs.existsSync(file), `${name}/SKILL.md is missing`);
  return fs.readFileSync(file, 'utf8');
}

// Fenced blocks, with the text inside them. Used to ask where a line sits
// rather than only whether it exists.
function fences(text) {
  const out = [];
  let open = null;
  for (const line of text.split('\n')) {
    const marker = line.match(/^\s*```(\S*)/);
    if (marker) {
      if (open) { out.push(open); open = null; } else { open = { info: marker[1], lines: [] }; }
      continue;
    }
    if (open) open.lines.push(line);
  }
  if (open) out.push(open);
  return out.map((f) => ({ info: f.info, body: f.lines.join('\n') }));
}

// --------------------------------------------------------- status bar ----

check('status-bar routes Codex through its native pickers', () => {
  const text = skill('status-bar');
  const codexAt = text.indexOf('## Codex');
  const claudeAt = text.indexOf('## Claude Code');
  assert.ok(codexAt !== -1 && claudeAt > codexAt, 'runtime-specific status-bar routes are missing');
  const codex = text.slice(codexAt, claudeAt);
  assert.match(codex, /\/statusline/);
  assert.match(codex, /tui\.status_line/);
  assert.match(codex, /\/title/);
  assert.match(codex, /task progress/i);
  assert.match(codex, /cannot add arbitrary custom segments/i);
});

check('status-bar does not promise Claude-only fields in Codex', () => {
  const text = skill('status-bar');
  const codex = text.slice(text.indexOf('## Codex'), text.indexOf('## Claude Code'));
  assert.doesNotMatch(codex, /session cost|30 day spend|Core tools 5\/5/);
  assert.match(text.slice(text.indexOf('## Claude Code')), /Session cost so far/);
});

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

// ----------------------------------------------------------------- wrap ----

check('wrap checks the handoff exists after writing it', () => {
  const text = skill('wrap');
  const writeAt = text.indexOf('## Step 2');
  const findAt = text.indexOf('cli.js find');
  assert.ok(findAt !== -1, 'wrap no longer runs `cli.js find`, so nothing verifies the write landed');
  assert.ok(
    findAt > writeAt,
    'wrap runs `cli.js find` before the write step, which checks for a file that is not there yet'
  );
});

check('wrap says the index is not evidence the file exists', () => {
  const text = skill('wrap');
  // The reason the check exists. Without it the step reads as a formality and
  // a future edit removes it as redundant, since `target` already succeeded.
  assert.match(
    text,
    /index[^.]*\bnot\b[^.]*evidence|not evidence that it does/i,
    'wrap no longer explains that a recorded path is not a written file, so the check reads as redundant'
  );
});

check('the summary template does not contain the success lines', () => {
  // The regression that e419218 fixed. Presence checks cannot see this one:
  // every word is still in the file either way. Only the position differs.
  const blocks = fences(skill('wrap'));
  const summary = blocks.find((b) => b.body.includes('## Session wrapped'));
  assert.ok(summary, 'the Step 4 summary template is gone or no longer starts with "## Session wrapped"');
  assert.ok(
    !/Handoff saved to/i.test(summary.body),
    'the "Handoff saved to" line is back inside the copyable summary template, '
    + 'so it gets printed whether or not the handoff was written'
  );
  assert.ok(
    !summary.body.includes('/pickup'),
    'the /pickup line is back inside the copyable summary template, '
    + 'so a slug that resolves to nothing gets handed to the next session'
  );
});

check('wrap has a failure ending', () => {
  const text = skill('wrap');
  assert.match(
    text,
    /NOT written|was not written/i,
    'wrap has no wording for the case where the handoff is missing, so there is only one thing it can say'
  );
});

check('wrap forbids printing the pickup line when the check found nothing', () => {
  const text = skill('wrap');
  assert.match(
    text,
    /Do not print the `?\/pickup`? line/i,
    'the instruction not to print /pickup on a failed check is gone, '
    + 'so the failure ending can be printed alongside the slug it contradicts'
  );
});

// --------------------------------------------------------------- pickup ----

check('pickup resolves the slug with the CLI rather than guessing', () => {
  const text = skill('pickup');
  assert.ok(
    text.includes('cli.js find'),
    'pickup no longer runs `cli.js find`. Guessing the path is the bug that '
    + 'broke every repository not kept under ~/Projects'
  );
});

check('pickup shows the paths it tried when nothing matched', () => {
  // Scoped to the edge case that governs a miss, not the whole file. The same
  // instruction appears in Step 1 as well, and a check that accepts either
  // passes while one of them is removed. Which is what it did: the first
  // version of this check survived deleting the Step 1 copy because the edge
  // case still matched, and it would equally have survived the reverse.
  const text = skill('pickup');
  const at = text.indexOf('**No match.**');
  assert.ok(at !== -1, 'pickup no longer has a "No match" edge case at all');
  const region = text.slice(at, at + 400);
  assert.match(
    region,
    /\b(show|print|display|surface|give)\b/i,
    'the "No match" case no longer tells the model to show anything'
  );
  assert.match(
    region,
    /\btried\b|\blooked\b/i,
    'the "No match" case no longer surfaces the search order, which is the one '
    + 'moment the order is worth seeing'
  );
});

check('pickup still refuses to bulk-load the referenced files', () => {
  // The whole reason the skill exists. Dropping it turns a cheap summary into
  // the most expensive opening move of a session, and nothing looks wrong.
  const text = skill('pickup');
  assert.match(
    text,
    /Do not load the referenced files|Read nothing beyond the handoff/i,
    'pickup no longer tells the model to leave the referenced files alone'
  );
  assert.match(
    text,
    /Never open the list|only once it is named/i,
    'pickup no longer requires a file to be named before it is opened'
  );
});

check('pickup does not invent a summary it cannot support', () => {
  const text = skill('pickup');
  assert.match(
    text,
    /Do not fill a gap with a guess|fabricated/i,
    'pickup no longer warns against inventing sections, and an invented handoff '
    + 'summary reads exactly like a real one'
  );
});

// ------------------------------------------------------------ self-test ----

check('the position check would actually catch one', () => {
  // A linter nobody has seen fail is a linter nobody should trust. The third
  // check is the only one here that is not a grep, so it is the only one that
  // can pass for the wrong reason.
  const bad = [
    '```',
    '## Session wrapped',
    '',
    'Handoff saved to [path].',
    '',
    '/pickup [slug]',
    '```',
  ].join('\n');
  const summary = fences(bad).find((b) => b.body.includes('## Session wrapped'));
  assert.ok(summary, 'the fence parser did not find a block it was handed directly');
  assert.ok(/Handoff saved to/i.test(summary.body), 'the parser missed a success line sitting in the template');
  assert.ok(summary.body.includes('/pickup'), 'the parser missed a /pickup line sitting in the template');

  const good = ['```', '## Session wrapped', '```', '', '```', 'Handoff saved to [path].', '```'].join('\n');
  const clean = fences(good).find((b) => b.body.includes('## Session wrapped'));
  assert.ok(
    !/Handoff saved to/i.test(clean.body),
    'the parser ran two separate fences together, which would flag the fixed version as broken'
  );
});

console.log(`\n10 checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
