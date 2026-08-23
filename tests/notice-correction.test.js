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
// tests/fixtures/correction-cases.json holds every case from rounds 0 to 5
// for that, and it needs a real session to score. A test that scored it with
// another regex would be back where this started.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

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
  // Every case above is lowercase and singular, and the command cases use only
  // start-of-string, a backtick and an open paren. So a gate that had lost its
  // `i` flag, its `s?`, and every delimiter but those three passed the lot. The
  // four below hold the parts nothing was holding.
  'Hooks failed on that turn',
  'please run /pickup',
  "'/pickup' gave me the wrong handoff",
  '[/pickup] gave me the wrong handoff',
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
// Each boundary is named by a phrase, built into a pattern by `phrase()` below
// rather than written by hand, and that does pin wording to the extent that the
// phrase has to survive. So each one is the shortest phrase that still carries
// its boundary and nothing else: a reword keeping the boundary keeps the test
// green, and one dropping the boundary fails. Reaching for a longer, more
// natural-reading phrase is what makes this brittle, and a whole sentence was
// matched here until a review pointed out that tuning the sentence would break
// a check that was not about the sentence.

// Match a phrase wherever the line breaks fall. POLICY is an array of short
// strings joined with newlines, so every space inside a phrase is a newline in
// waiting, and a pattern with a literal space fails against text that plainly
// contains the phrase. Twice now, one word apart: `cannot finish without it
// fixed` was written with a literal space, fixed by escaping the one gap that
// happened to wrap, and broke again on the next gap when a paragraph was
// reflowed. Escaping the gap that broke is not the fix. Escaping every gap is,
// which is why this is a function and not a habit.
const phrase = (text) =>
  new RegExp(
    text
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+'),
    'i'
  );

check('the phrase matcher survives a line break and still says no', () => {
  // Without this the helper is load bearing and unchecked: one that returned
  // /(?:)/ would match everything, and all nine boundary checks below would
  // pass against a policy that had lost every one of them.
  //
  // Each case below names the wrong implementation it rules out. The first
  // version of this case ruled out only the empty matcher, and a review pointed
  // out it would have accepted four other wrong ones, which is the same fault
  // as an empty matcher wearing a coat.
  assert.ok(phrase('cannot finish without it fixed').test('you cannot\nfinish without it\nfixed.'), 'did not match across newlines');
  assert.ok(phrase('has to be theirs').test('It has to be theirs.'), 'did not match on one line');
  assert.ok(!phrase('has to be theirs').test('It has to be ours.'), 'matched a policy missing the phrase');
  assert.ok(!phrase('not block').test('this hook may block'), 'matched without the first word present');
  // rules out an implementation that ignores order
  assert.ok(!phrase('not block').test('block not'), 'matched the words in the wrong order');
  // rules out joining on `.*`, which lets unrelated text sit between the words
  assert.ok(!phrase('not block').test('not really block'), 'matched with other words in between');
  // rules out joining on `\s*`, which makes the separator optional
  assert.ok(!phrase('not block').test('notblock'), 'matched with no separator at all');
  // rules out joining on `\s`, exactly one whitespace character. Every other
  // string here has single spaces, so a one-character join passes all of them
  // and then fails on a double space, a tab, or a blank line in the policy.
  assert.ok(phrase('has to be theirs').test('has  to\tbe\n\ntheirs'), 'needed exactly one whitespace between words');
  // rules out dropping the `i` flag
  assert.ok(phrase('has to be theirs').test('IT HAS TO BE THEIRS'), 'was case sensitive');
  // rules out skipping the escape: unescaped, `a.c` matches `abc`
  assert.ok(phrase('a.c').test('a.c'), 'escaping broke an ordinary match');
  assert.ok(!phrase('a.c').test('abc'), 'did not escape a regex metacharacter');

  // rules out escaping only some metacharacters. Both reviewers found this
  // independently: with only the `a.c` case above, a helper escaping `.` and
  // nothing else passed every assertion here and all nine boundary checks,
  // because no phrase in the policy today contains another metacharacter. So
  // the suite would have stayed green while the helper became unsafe for the
  // first phrase that did, and nothing would have connected the two events.
  for (const meta of ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']) {
    const literal = `a${meta}b`;
    assert.ok(phrase(literal).test(literal), `an unescaped ${meta} stopped the phrase matching itself`);
  }
  // the positive loop alone misses the metacharacters whose unescaped meaning
  // still matches the literal, so these pin what each would leak instead
  assert.ok(!phrase('a*b').test('b'), 'left `*` unescaped, so the first word became optional');
  assert.ok(!phrase('a?b').test('b'), 'left `?` unescaped, so a character became optional');
  assert.ok(!phrase('a|b').test('a'), 'left `|` unescaped, so the phrase became an alternation');
  assert.ok(!phrase('a+b').test('aab'), 'left `+` unescaped, so a character became repeatable');
  assert.ok(!phrase('a\\b').test('a b'), 'left the backslash unescaped, so it became an escape sequence');
});

check('the policy states every boundary it needs', () => {
  const policy = onPrompt('the hook fired twice').hookSpecificOutput.additionalContext;
  const required = [
    [phrase('/flag-issue'), 'names the command to suggest'],
    [phrase('once'), 'says once, or it will be repeated every turn'],
    [phrase('not run it'), 'says not to run it, since this must never write'],
    [phrase('not block'), 'says not to block'],
    [phrase('queue command is already being invoked'), 'excludes a turn already filing one'],
    [phrase('skill, hook, command, plugin or script'), 'says what counts as built here'],
    [phrase('answer you are about to give'), 'covers the correction the answer itself concedes'],
    [phrase('has to be theirs'), 'excludes a defect the user never raised'],
    [phrase('cannot finish without it fixed'), 'anchors blocking to something with an answer'],
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
  // 42 alone cannot fail this. `RegExp.test` coerces it to "42", which the gate
  // does not match, so deleting the `typeof` guard leaves the hook quiet and the
  // case green. An array coerces to "hook", which the gate does match, so this
  // is the one that actually holds the guard in place.
  ['a prompt that is an array', { hook_event_name: 'UserPromptSubmit', prompt: ['hook'] }],
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
});

check('the manifest really runs this hook, proved by running it', () => {
  // Three review rounds landed on this check and every one of them was the same
  // fault: it read the command as text and its comment claimed more than
  // reading text can deliver. Searching the serialized JSON for the filename
  // passed `true # notice-correction.js`. Anchoring the name to the end of the
  // command passed `echo .../notice-correction.js` and rejected real wirings
  // with a trailing argument. Requiring the launcher before the hook passed
  // `echo 'bin/hook-node is not running /hooks/notice-correction.js'`.
  //
  // Every one of those was a closer approximation of the same wrong idea. A
  // shell command means what the shell does with it, so the only honest check
  // runs it. The plugin root here is a real directory carrying a launcher that
  // records its arguments rather than executing anything, which satisfies the
  // three guards in front of the invocation and then reports whether the
  // invocation happened and what it was handed.
  //
  // This does prove the wiring. What it deliberately does not cover is the
  // guards' own messages and exit codes, which hook-executable.test.js owns.
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const commands = manifest.hooks.UserPromptSubmit
    .flatMap((group) => group.hooks || [])
    .filter((entry) => entry.type === 'command')
    .map((entry) => entry.command);
  assert.ok(commands.length, 'no UserPromptSubmit commands in the manifest at all');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-correction-wiring-'));
  try {
    const argv = path.join(root, 'argv');
    fs.mkdirSync(path.join(root, 'bin'));
    const launcher = path.join(root, 'bin', 'hook-node');
    // `"$@"` and not `$*`, so a path containing a space is still one argument.
    fs.writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(argv)}\n`);
    fs.chmodSync(launcher, 0o755);

    for (const command of commands) {
      spawnSync('/bin/sh', ['-c', command], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'the hook fired twice' }),
        encoding: 'utf8',
      });
    }

    const handed = fs.existsSync(argv) ? fs.readFileSync(argv, 'utf8').split('\n').filter(Boolean) : [];
    assert.ok(
      handed.includes(path.join(root, 'hooks', 'notice-correction.js')),
      `the launcher was never handed this hook. It received: ${JSON.stringify(handed)}`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

  // `either` is a verdict, not a gap in the policy, and this pins that so the
  // point does not get relitigated. A review round asked for a rule that
  // disambiguates the `either` cases, having itself recommended marking one of
  // them `either` a round earlier. Those two asks cannot both be met: a case is
  // marked `either` precisely because both readings are defensible, and writing
  // a rule that forces one is how the policy grew the phrase lists this hook
  // spent four rounds removing. Some sentences are genuinely ambiguous and the
  // corpus records which, rather than pretending a rule settles them.
  assert.ok(kinds.has('either'), 'no ambiguous cases, so nothing records where judgement runs out');

  // The file claims to hold every round, and nothing held it to that: deleting
  // every case from the newest round left the suite green, because the older
  // ones already supply a non-empty corpus and all three verdicts. So the rounds
  // present have to run from 0 with no gaps, and the highest one has to be the
  // one the documentation names. Delete a round and one of these fails.
  const rounds = [...new Set(corpus.cases.map((c) => c.found))].sort((a, b) => a - b);
  const highest = rounds[rounds.length - 1];
  assert.deepStrictEqual(
    rounds,
    Array.from({ length: highest + 1 }, (_, i) => i),
    `rounds present are ${rounds.join(', ')}, which skips one, so a round was dropped rather than added`
  );
  assert.ok(
    new RegExp(`round ${highest}\\b`, 'i').test(corpus.how_to_read_a_case.found),
    `the newest round is ${highest} and the documentation does not mention it`
  );
  assert.ok(
    /must not be counted as a failure/i.test(corpus.how_to_read_a_case.expected),
    'the corpus no longer says an `either` case cannot fail, which is the whole meaning of the verdict'
  );
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
