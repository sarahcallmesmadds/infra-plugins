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
const CODEX_SURFACES = path.join(__dirname, '..', 'plugins', 'session', 'skills', 'status-bar', 'references', 'codex-status-surfaces.md');

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
  assert.match(text, /CLAUDE_PLUGIN_ROOT/);
  assert.match(text, /session context/);
  assert.match(text, /CODEX_HOME.*not required/);
  assert.match(text, /Do not use the\s+existence of `\/statusline` as detection/);
  assert.ok(fs.existsSync(CODEX_SURFACES), 'Codex surface evidence note is missing');
  const sources = fs.readFileSync(CODEX_SURFACES, 'utf8');
  assert.match(sources, /developers\.openai\.com\/codex\/codex-manual\.md/);
  assert.match(sources, /tui\.status_line/);
  assert.match(sources, /`\/statusline`/);
  assert.match(sources, /`\/title`/);
});

check('status-bar does not promise Claude-only fields in Codex', () => {
  const text = skill('status-bar');
  const codex = text.slice(text.indexOf('## Codex'), text.indexOf('## Claude Code'));
  assert.doesNotMatch(codex, /session cost|30 day spend|Core tools 5\/5/);
  assert.match(text.slice(text.indexOf('## Claude Code')), /Session cost so far/);
});

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

// Added 2026-08-09. A design system was approved, named in that day's handoff
// with its full path, and mentioned zero times by the handoff three days later
// that superseded it. Every pickup after that began without it,
// and a homepage was built and rejected as a result. Nothing was broken: wrap
// recorded state, next actions and traps exactly as instructed, and constraints
// were simply not a category it carried.
//
// These pin the three parts that make a constraint survive: gathering it,
// giving it somewhere to live, and making removal say so out loud. The third is
// the load-bearing one. Without it a constraint can leave by omission, which is
// indistinguishable from being forgotten and is precisely what happened.

check('wrap gathers constraints from earlier handoffs before writing', () => {
  const text = skill('wrap');
  const gatherAt = text.indexOf('cli.js constraints');
  const writeAt = text.indexOf('## Step 2');
  assert.ok(gatherAt !== -1, 'wrap no longer runs `cli.js constraints`, so nothing carries a constraint past the session that set it');
  assert.ok(
    gatherAt < writeAt,
    'wrap gathers constraints after the write step, so the handoff is composed before it knows what is binding'
  );
});

check('the template does not tell the writer to annotate a constraint', () => {
  // Matching is on the bullet text, so "(from HANDOFF-x)" makes the carried
  // copy a different constraint from the original. Both then read as live, the
  // list grows a near duplicate at every wrap, and a retirement quoting one
  // leaves the other in force. The command reports provenance separately.
  const text = skill('wrap');
  const template = fences(text).find((f) => f.info === 'markdown' && f.body.includes('# Session Handoff'));
  assert.ok(template, 'the handoff template is gone');
  const section = template.body.slice(template.body.indexOf('## Constraints still in force'));
  const firstBullet = section.split('\n').find((l) => l.trim().startsWith('- '));
  assert.doesNotMatch(firstBullet, /came from|from HANDOFF|provenance/i,
    'the template asks for provenance inside the bullet, which contradicts carrying it verbatim');
  assert.match(text, /the bullet holds the constraint and nothing else/i,
    'wrap no longer says the bullet carries the constraint alone');
});

check('wrap is told to act on the near-duplicate warning, not just read it', () => {
  // The one warning a wrap can make worse rather than merely inherit: carrying
  // both wordings forward verbatim, which every other instruction in the step
  // tells it to do, writes the fork into another document. The bullet listing
  // untrustworthy-list warnings named only truncation and unmatched retirement,
  // so the model had no instruction covering this one.
  const text = skill('wrap');
  assert.match(
    text,
    /two constraints look like one rule in two wordings/i,
    'wrap no longer mentions the near-duplicate warning, so it will carry both wordings forward and grow the fork'
  );
  // Naming it is not enough. Without the remedy the model knows something is
  // wrong and not what to do, and the plausible guess, picking the better
  // wording and dropping the other silently, is a constraint leaving by
  // omission.
  assert.match(
    text,
    /retire the other by quoting it\s+exactly/i,
    'wrap names the near-duplicate warning without saying how to resolve it'
  );
});

check('wrap forbids a value inside a constraint that changes between sessions', () => {
  // A running count inside the text forks a new constraint at every increment,
  // because matching is on the whole text. Measured on 2026-08-15: five
  // numbered wordings of one rule live at once, from "Sixth" to "Tenth session
  // running", with five retirement lines chasing four of them. Carrying it
  // verbatim preserves a stale figure and correcting it produces a near
  // duplicate, and there is no third option.
  const text = skill('wrap');
  assert.match(
    text,
    /^\*\*Nothing inside a constraint may change between sessions\.\*\*/m,
    'wrap no longer forbids a changing value inside constraint text, so a running count goes back in and forks the constraint every session'
  );
  // Top level, not indented under the "It lists constraints" bullet. This is
  // authoring guidance, so it has to reach a constraint written for the first
  // time and one proposed out of an older handoff, not only one carried
  // forward. Nested under that bullet it reads as carry-forward only. The
  // anchored match above is what proves it is unindented; this pins that it is
  // still inside the constraints step rather than adrift elsewhere.
  const ruleAt = text.indexOf('**Nothing inside a constraint may change between sessions.**');
  const dropAt = text.indexOf('**Dropping one requires saying so.**');
  assert.ok(dropAt !== -1, 'the retirement rule is gone, so this check cannot locate the constraints step');
  assert.ok(
    ruleAt < dropAt,
    'the changing-value rule moved out of the constraints step, where a writer looking up how to word one will not meet it'
  );
});

check('no line of the template parses as real content', () => {
  // The live placeholder was excluded from the start. The retirement placeholder
  // beside it was not, and parsed as a retirement targeting "[the constraint,
  // quoted exactly]", so a template copied wholesale reported a phantom
  // unmatched retirement at every run, which wrap then tells the model to go and
  // resolve. The earlier check only asked about constraintsIn, which passed
  // either way.
  const handoffs = require(path.join(__dirname, '..', 'plugins', 'session', 'scripts', 'handoffs.js'));
  const template = fences(skill('wrap')).find((f) => f.info === 'markdown' && f.body.includes('# Session Handoff'));
  assert.ok(template, 'the handoff template is gone');
  assert.deepStrictEqual(handoffs.constraintsIn(template.body), [], 'a placeholder reads back as a live constraint');
  assert.deepStrictEqual(handoffs.retiredIn(template.body), [], 'a placeholder reads back as a real retirement');
});

check('the handoff template has somewhere for constraints to live', () => {
  const text = skill('wrap');
  const template = fences(text).find((f) => f.info === 'markdown' && f.body.includes('# Session Handoff'));
  assert.ok(template, 'the handoff template is gone');
  // The exact heading, because cli.js constraints matches on it. Reword it here
  // and the command silently reads back nothing for ever.
  assert.match(
    template.body,
    /^##\s*Constraints still in force\s*$/m,
    'the template has no "Constraints still in force" heading, which is the string cli.js constraints matches on'
  );
});

check('wrap requires a dropped constraint to say it was dropped', () => {
  const text = skill('wrap');
  assert.match(
    text,
    /silence is not retirement/i,
    'wrap no longer says that dropping a constraint requires saying so, so one can leave by omission again'
  );
});

check('wrap forbids backfilling constraints into old handoffs', () => {
  const text = skill('wrap');
  assert.match(
    text,
    /never edit an old handoff/i,
    'wrap no longer forbids editing earlier handoffs, which rewrites the record of what was true when they were written'
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

// Added 2026-08-09, the other half of the constraints fix. Wrap carrying them
// forward is worth nothing if the skill that loads a handoff buries them under
// the next actions or paraphrases them into a gist.

check('pickup asks the project what still binds', () => {
  const text = skill('pickup');
  assert.match(text, /cli\.js constraints/,
    'pickup no longer asks for constraints, so one recorded on another thread of work stays invisible');
});

check('pickup pins the scope instead of inheriting the session cwd', () => {
  const text = skill('pickup');
  const cmd = text.slice(text.indexOf('cli.js constraints'));
  assert.match(cmd.slice(0, 120), /--cwd/,
    'the documented command omits --cwd, so it answers for wherever the session opened rather than for the project');
  // The step that moves to the project runs later, so the flag is the only
  // thing making this deterministic.
  assert.ok(
    text.indexOf('cli.js constraints') < text.indexOf('Move to the right directory'),
    'this check assumes the scan still precedes the directory change; if that changed, the reasoning here needs revisiting'
  );
  assert.match(text, /not `?dirname`? of the handoff/i,
    'pickup no longer warns that a central handoff lives in the handoffs folder, which is nobody project directory');
});

check('pickup asks even when the handoff already lists constraints', () => {
  const text = skill('pickup');
  // Without this the command reads as a fallback, and the case it exists for is
  // the one where the handoff looks complete and is missing something.
  assert.match(
    text,
    /run it even when the handoff has/i,
    'pickup treats the handoff section as sufficient, so a constraint dropped by the last wrap is never noticed'
  );
});

check('constraints are surfaced first and are not optional', () => {
  const text = skill('pickup');
  const template = fences(text).find((f) => f.body.includes('Resuming from:'));
  assert.ok(template, 'the pickup output template is gone');
  const binding = template.body.indexOf('Still binding');
  const next = template.body.indexOf('Next actions');
  assert.ok(binding !== -1, 'the output no longer surfaces constraints at all');
  assert.ok(binding < next,
    'constraints print below the next actions, which is where they get skimmed past on the way to the task');
  assert.match(text, /never shortened, never\s*summarized/i,
    'pickup no longer forbids summarizing a constraint, and a paraphrased one is not checkable');
});

check('pickup keeps constraint documents out of the do-not-load rule', () => {
  const text = skill('pickup');
  const dontLoad = text.indexOf('Do not load the referenced files');
  assert.ok(dontLoad !== -1, 'the do-not-load step is gone');
  assert.match(
    text.slice(dontLoad),
    /not on that list/i,
    'a document a constraint names reads as optional context again, which is how the design system got skipped'
  );
});

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

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
