#!/usr/bin/env node
// The correction-noticing hook, run the way Claude Code runs it.
//
// Run: node tests/notice-correction.test.js
//
// Spawned as a subprocess and fed real event JSON, because that is the layer
// where this kind of hook fails. The bug it is written against is not a wrong
// verdict, it is a hook that reads a field the event does not carry, gets
// undefined, and stays quiet forever while looking healthy. That shipped once
// in this repository already, in the injection scanner.
//
// Both field names here were nearly wrong for that exact reason. The published
// field list calls the prompt `user_prompt` and says Stop does not receive
// `stop_hook_active`. The captured events say `prompt`, and say Stop does. The
// two `shape` checks at the bottom are what keep this file honest if either
// ever changes: they read the captures rather than trusting these tests.
//
// The half that matters most is the quiet half. This fires on every prompt in
// every session, so a false positive is not one annoying line, it is a line
// that arrives so often nobody reads the true one.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOOKS = path.join(__dirname, '..', 'plugins', 'build-loop', 'hooks');
const PROMPT_HOOK = path.join(HOOKS, 'notice-correction-prompt.js');
const STOP_HOOK = path.join(HOOKS, 'notice-correction-stop.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'hook-events');

function runHook(hook, event) {
  const stdout = execFileSync(process.execPath, [hook], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    cwd: __dirname,
  }).trim();
  return stdout ? JSON.parse(stdout) : null;
}

function onPrompt(prompt) {
  return runHook(PROMPT_HOOK, { hook_event_name: 'UserPromptSubmit', prompt });
}

function onStop(last_assistant_message, extra = {}) {
  return runHook(STOP_HOOK, { hook_event_name: 'Stop', last_assistant_message, ...extra });
}

// A suggestion arrives as additionalContext under the matching event name.
// Anything else is dropped by the harness without a word, which is the failure
// this asserts against rather than the wording of the message.
function assertSuggests(out, eventName, what) {
  assert.ok(out, `${what}: hook said nothing`);
  const specific = out.hookSpecificOutput;
  assert.ok(specific, `${what}: no hookSpecificOutput`);
  assert.strictEqual(specific.hookEventName, eventName, `${what}: wrong hookEventName`);
  assert.ok(
    typeof specific.additionalContext === 'string' && specific.additionalContext.length > 0,
    `${what}: suggested nothing`
  );
  assert.ok(
    !('decision' in out) && !('decision' in specific),
    `${what}: this hook suggests and must never block`
  );
  return specific.additionalContext;
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

// --- the corrections it exists to notice -----------------------------------

const CORRECTIONS = [
  'that was wrong, the wrap skill should file centrally',
  'the stale-branches command should have asked first',
  'next time do not let the hook write without confirming',
  '/pickup gave me the wrong handoff',
  'you keep making the same mistake in that skill',
  'that is not what I asked the plugin to do',
];

for (const prompt of CORRECTIONS) {
  check(`noticed on the way in: "${prompt.slice(0, 42)}..."`, () => {
    assertSuggests(onPrompt(prompt), 'UserPromptSubmit', 'correction');
  });
}

check('noticed on the way out, when the model concedes it', () => {
  // The half that catches what only becomes clear afterwards. The prompt that
  // produced this may have been an ordinary question.
  assertSuggests(
    onStop('You are right, and the hook should have stripped the comment first.'),
    'Stop',
    'conceded correction'
  );
});

// --- the half that matters just as much ------------------------------------
//
// This runs on every prompt of every session, so each of these is a line that
// would otherwise arrive constantly.

const ORDINARY = [
  'can you look at the guardrails plugin and tell me what it does',
  'that was wrong, the revenue figure is 4.2 not 4.8',
  'we should have hired someone for this in January',
  'next time we run the offsite let us book earlier',
  'write a skill that summarises my meetings',
  'the deploy failed again',
  '',
];

for (const prompt of ORDINARY) {
  check(`stayed quiet: "${(prompt || '(empty prompt)').slice(0, 42)}..."`, () => {
    assert.strictEqual(onPrompt(prompt), null, 'hook spoke on ordinary input');
  });
}

// Praise, which read as a complaint until it was pointed out.
//
// The phrase test was one pattern with an optional negation, `that (was|is)n?
// '?t? (wrong|right|correct)`, and every character of `n?'?t?` being optional
// meant the negation could vanish entirely. So the suggestion to file a bug
// arrived at the exact moment somebody said the thing worked, which is the
// worst possible time for it and the opposite of what the hook is for.
const PRAISE = [
  'that is correct, the hook did what I wanted',
  'that was right, the skill handled it',
  'yes that is right about the plugin',
  'the command is correct now, thanks',
];

for (const prompt of PRAISE) {
  check(`praise is not a complaint: "${prompt.slice(0, 40)}..."`, () => {
    assert.strictEqual(onPrompt(prompt), null, 'suggested filing a bug about something that worked');
  });
}

// And the negated forms, which are complaints and have to survive the fix.
for (const prompt of [
  "that isn't right, the skill wrote to the wrong place",
  'that is not correct, the hook fired twice',
]) {
  check(`negated praise is still a complaint: "${prompt.slice(0, 40)}..."`, () => {
    assertSuggests(onPrompt(prompt), 'UserPromptSubmit', 'negated');
  });
}

// --- corrections that said nothing until review found them ----------------
//
// All four went the silent direction, which is the one that looks like a quiet
// week rather than like a bug.

check('a defect in /flag-issue itself is not suppressed by its own name', () => {
  // The one correction nobody else can file. Matching the command name
  // anywhere meant the sentence guaranteed to be about a real defect in the
  // queue tooling was the one sentence guaranteed to be ignored.
  assertSuggests(
    onPrompt('The /flag-issue command should have asked before writing.'),
    'UserPromptSubmit',
    'defect in flag-issue'
  );
});

check('the second person of "supposed to" is noticed', () => {
  assertSuggests(
    onPrompt('You were supposed to make the plugin ask first.'),
    'UserPromptSubmit',
    'were supposed to'
  );
});

for (const message of [
  "You're right, the hook should not have fired.",
  "You're right. The hook should not have fired.",
  "You're right — the hook should not have fired.",
  "You're right - the hook should not have fired.",
]) {
  check(`a concession is noticed however it is punctuated: "${message.slice(0, 30)}..."`, () => {
    assertSuggests(onStop(message), 'Stop', 'punctuated concession');
  });
}

// The noisy direction, from the same round. A buildable word in one clause and
// a plan in another is not a correction.
for (const prompt of [
  'Can you script that? I should have time tomorrow.',
  'What plugin is this? I should have the budget next week.',
]) {
  check(`a plan is not a correction: "${prompt.slice(0, 38)}..."`, () => {
    assert.strictEqual(onPrompt(prompt), null, 'read a plan as a defect report');
  });
}

check('stays quiet when the correction is already being filed', () => {
  assert.strictEqual(
    onPrompt('/flag-issue the wrap skill should have filed centrally, that was wrong'),
    null,
    'suggested the command that is already being run'
  );
});

check('stays quiet when the model merely agrees about something else', () => {
  assert.strictEqual(
    onStop('You are right that the second quarter was stronger.'),
    null,
    'read plain agreement as a defect report'
  );
});

// --- the loop guard --------------------------------------------------------

check('says nothing when stop_hook_active is set', () => {
  // A Stop hook speaking into a stop it already interrupted is the shape that
  // runs forever. This hook never blocks, so the loop is unlikely rather than
  // impossible, which is not a reason to leave the check out.
  assert.strictEqual(
    onStop('I got that wrong, the hook should not have fired.', { stop_hook_active: true }),
    null,
    'ignored stop_hook_active'
  );
});

// --- the fields, read from the captures rather than from these tests -------
//
// Everything above would pass just as well against a hook reading a field that
// does not exist, as long as the tests invented the same field. These two read
// the captured events instead, so a name that drifts fails here rather than
// going quiet in a real session.

function shapeOf(name) {
  const file = path.join(FIXTURES, `${name}.json`);
  const captured = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(
    captured.source,
    'capture-event.js',
    `${name}.json was not written by the capture tool, so it is somebody's belief`
  );
  return captured.shape;
}

check('the prompt really arrives as `prompt`', () => {
  const shape = shapeOf('UserPromptSubmit');
  assert.strictEqual(
    shape.prompt,
    'string',
    'the captured event has no `prompt`. The published docs call this `user_prompt`, '
      + 'and reading that name gives undefined on every event, so the hook goes silent '
      + 'and looks fine. Recapture before changing the hook to match.'
  );
});

check('Stop really carries stop_hook_active and last_assistant_message', () => {
  const shape = shapeOf('Stop');
  assert.strictEqual(
    shape.stop_hook_active,
    'boolean',
    'the captured Stop event has no `stop_hook_active`. The published docs say it does '
      + 'not exist; the capture says it does. If this fails, the loop guard is guarding '
      + 'nothing.'
  );
  assert.strictEqual(
    shape.last_assistant_message,
    'string',
    'the captured Stop event has no `last_assistant_message`, which is the only reason '
      + 'this hook does not have to walk the transcript'
  );
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
