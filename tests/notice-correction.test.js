#!/usr/bin/env node
// The correction hook, run the way Claude Code runs it.
//
// Run: node tests/notice-correction.test.js
//
// This file used to assert which sentences count as a correction. It does not
// any more, and the reason is the point of the change it accompanies.
//
// Four rounds of review found thirteen defects in the phrase lists that used
// to live here, every one the same shape: a regular expression reading a
// sentence the way its author imagined rather than the way somebody wrote it.
// The tests passed throughout, because a test written alongside a pattern is
// written from the same misunderstanding. Sentences the author did not think
// of are exactly the ones neither the pattern nor its test contains.
//
// So the judgement moved to the model, which is the thing here that judges
// language and has the conversation the sentence arrived in, and what is left
// in code is a gate that answers a question about topic. That is testable, and
// these are the parts worth pinning:
//
//   the field the event actually carries
//   the gate routing, in both directions
//   failing open on anything malformed
//   the output shape the harness reads
//   the boundaries the policy has to state
//   no Stop hook, and therefore no loop
//
// What cannot be pinned here is whether the model gets the judgement right.
// tests/fixtures/correction-cases.json holds every case from all five rounds
// for that, and it needs a real session to score. A test that scored it with
// another regex would be back where this started.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'build-loop');
const HOOK = path.join(PLUGIN, 'hooks', 'notice-correction.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'hook-events');

function runHook(event) {
  const stdout = execFileSync(process.execPath, [HOOK], {
    input: typeof event === 'string' ? event : JSON.stringify(event),
    encoding: 'utf8',
    cwd: __dirname,
  }).trim();
  return stdout ? JSON.parse(stdout) : null;
}

function onPrompt(prompt) {
  return runHook({ hook_event_name: 'UserPromptSubmit', prompt });
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

// --- the output shape ------------------------------------------------------

check('the policy arrives in the shape UserPromptSubmit reads', () => {
  // An unrecognised payload is dropped without a word, so a hook can reach the
  // right answer, print it, and change nothing. guardrails shipped that for
  // three releases.
  const out = onPrompt('the hook wrote to the wrong place');
  assert.ok(out, 'hook said nothing on a turn about a hook');
  const specific = out.hookSpecificOutput;
  assert.ok(specific, 'no hookSpecificOutput');
  assert.strictEqual(specific.hookEventName, 'UserPromptSubmit', 'wrong hookEventName');
  assert.ok(
    typeof specific.additionalContext === 'string' && specific.additionalContext.length > 0,
    'injected nothing'
  );
  assert.ok(
    !('decision' in out) && !('decision' in specific),
    'this hook suggests and must never block'
  );
});

// --- the gate, which is routing rather than judgement ----------------------
//
// It answers "could this turn be about something built here", not "is this a
// correction". Every case below is about topic. None is about intent, and that
// is deliberate: intent is what the model decides now.

for (const prompt of [
  'the hook wrote to the wrong place',
  'can you look at the guardrails plugin',
  'write a skill that summarises my meetings',
  '/pickup gave me the wrong handoff',
  '`/pickup` gave me the wrong handoff',
  '(/pickup) gave me the wrong handoff',
  'that command needs a confirm step',
  'the script is fine now',
]) {
  check(`routed, because the topic could be built here: "${prompt.slice(0, 38)}..."`, () => {
    assert.ok(onPrompt(prompt), 'gate did not route a turn about tooling');
  });
}

for (const prompt of [
  'what did we agree about the offsite',
  'the revenue figure is 4.2 not 4.8',
  'we should have hired someone in January',
  'summarise this document for me',
  'that was wrong',
]) {
  check(`not routed, nothing here is buildable: "${prompt.slice(0, 38)}..."`, () => {
    assert.strictEqual(onPrompt(prompt), null, 'gate routed an unrelated turn');
  });
}

check('a turn already running a queue command is still routed', () => {
  // Deliberately not suppressed. Suppressing at the gate is what silenced "the
  // /flag-issue command should have asked before writing" by its own name, the
  // one correction nobody else can file. The policy carries that rule, where
  // it can tell invoking a command from talking about one.
  assert.ok(
    onPrompt('/flag-issue the wrap skill filed to the wrong place'),
    'the gate suppressed a queue command again'
  );
});

// --- what the policy has to say -------------------------------------------
//
// Not the wording, which will be tuned from real failures. These are the
// boundaries that stop it being a nuisance, and each one exists because
// something went wrong without it.
//
// Every pattern here is literal prose, which does pin wording to the extent
// that the phrase it names has to survive. So each one is the shortest phrase
// that still carries its boundary and nothing else: a reword keeping the
// boundary keeps the test green, and one dropping the boundary fails. Reaching
// for a longer, more natural-reading phrase is what makes this brittle, and a
// whole sentence was matched here until a review pointed out that tuning the
// sentence would break a check that was not about the sentence.

check('the policy states every boundary it needs', () => {
  const policy = onPrompt('the hook fired twice').hookSpecificOutput.additionalContext;
  const required = [
    [/\/flag-issue/, 'names the command to suggest'],
    [/once/i, 'says once, or it will be repeated every turn'],
    [/not run it/i, 'says not to run it, since this must never write'],
    [/not block/i, 'says not to block'],
    [/queue command is\s+already being invoked/i, 'excludes a turn already filing one'],
    [/skill, hook, command, plugin or script/i, 'says what counts as built here'],
    [/answer you are about to give/i, 'covers the correction the answer itself concedes'],
    [/has to be theirs/i, 'excludes a defect the user never raised'],
    // `\s+` because POLICY is an array joined with newlines, so any phrase can
    // fall across a line break. The queue-command pattern above needs it for the
    // same reason, and this one was written without it and failed on the wrap.
    [/cannot\s+finish without it fixed/i, 'anchors blocking to something with an answer'],
  ];
  for (const [re, why] of required) {
    assert.ok(re.test(policy), `the policy no longer ${why}`);
  }
});

// --- failing open ----------------------------------------------------------
//
// A hook that crashes a session is worse than one that misses something, and
// every one of these used to be a way in.

for (const [name, payload] of [
  ['a malformed body', '{not json at all'],
  ['an empty body', ''],
  ['an event with no prompt', { hook_event_name: 'UserPromptSubmit' }],
  ['a prompt that is not a string', { hook_event_name: 'UserPromptSubmit', prompt: 42 }],
  ['an empty prompt', { hook_event_name: 'UserPromptSubmit', prompt: '' }],
  ['a null prompt', { hook_event_name: 'UserPromptSubmit', prompt: null }],
]) {
  check(`fails open on ${name}`, () => {
    assert.strictEqual(runHook(payload), null, 'spoke, or threw, on a payload it cannot use');
  });
}

// --- the wiring ------------------------------------------------------------

check('the field really arrives as `prompt`', () => {
  // Read from the capture rather than from the tests above, which would pass
  // just as well against an invented field name as long as they invented the
  // same one. The published docs call this `user_prompt`.
  const captured = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'UserPromptSubmit.json'), 'utf8'));
  assert.strictEqual(
    captured.source,
    'capture-event.js',
    'the fixture was not written by the capture tool, so it is somebody\'s belief'
  );
  assert.strictEqual(
    captured.shape.prompt,
    'string',
    'the captured event has no `prompt`. Recapture before changing the hook to match.'
  );
});

check('no Stop hook is wired, so there is no loop to guard against', () => {
  // The Stop half is gone. The policy is injected before the answer is
  // written, so it is already in context when the answer concedes something,
  // which is what the Stop hook existed to catch.
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(!manifest.hooks.Stop, 'a Stop hook is wired again, which brings the loop back');
  const wired = JSON.stringify(manifest.hooks.UserPromptSubmit);
  assert.ok(wired.includes('notice-correction.js'), 'the hook is not wired to UserPromptSubmit');
});

// --- the corpus, which this file cannot score ------------------------------

check('the case file is well formed, so it does not rot unnoticed', () => {
  const file = path.join(__dirname, 'fixtures', 'correction-cases.json');
  const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(corpus.cases) && corpus.cases.length > 0, 'no cases');
  for (const c of corpus.cases) {
    assert.ok(['user', 'assistant'].includes(c.side), `bad side: ${JSON.stringify(c)}`);
    assert.ok(['suggest', 'quiet', 'either'].includes(c.expected), `bad expected: ${JSON.stringify(c)}`);
    assert.ok(typeof c.input === 'string' && c.input.length > 0, `empty input: ${JSON.stringify(c)}`);
    assert.ok(Number.isInteger(c.found), `no round recorded: ${JSON.stringify(c)}`);
  }
  // Both answers have to be represented or the corpus only measures one
  // direction, and the quiet direction is the one that makes this a nuisance.
  const kinds = new Set(corpus.cases.map((c) => c.expected));
  assert.ok(kinds.has('suggest') && kinds.has('quiet'), 'the corpus only tests one direction');
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
