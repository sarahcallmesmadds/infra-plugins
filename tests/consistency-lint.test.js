#!/usr/bin/env node
// Tests for the consistency-lint PostToolUse hook.
//
// Run: node tests/consistency-lint.test.js
//
// Most of these drive the hook as a subprocess and read the bytes it writes,
// rather than calling the detectors underneath it. That is deliberate and it is
// the lesson from `guardrails`, which blocked nothing at all for three releases:
// the detector was right, the hook was wired right, and the answer went out in
// a shape Claude Code ignores without an error. Both halves passed separately
// and the guard did nothing. Only a real event through the real process, with
// the output parsed as the harness parses it, would have shown that.
//
// The event shapes here were taken from real Write and Edit calls in a live
// session transcript, not written from memory. `tool_input` for an Edit carries
// file_path, old_string, new_string and replace_all; for a Write it carries
// file_path and content.
//
// The last check is the one that decides whether this ships: every markdown
// file in the repository goes through all three detectors, and a single finding
// on real work fails the suite. A prose-pattern check that fires on correct
// text gets switched off, after which it catches nothing.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'plugins', 'slop-check', 'hooks', 'consistency-lint.js');
const {
  staleCounts, survivingText, brokenOwnRule, replacedFragments, isDistinctive, ruleChange, editStanding,
} = require(path.join(ROOT, 'plugins', 'slop-check', 'scripts', 'consistency.js'));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'consistency-lint-'));
function write(name, text) {
  const full = path.join(tmp, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

// Run the hook exactly as Claude Code runs it: a fresh process, the event as
// JSON on stdin, and whatever it writes to stdout read back.
function run(event) {
  const proc = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
  return { status: proc.status, stdout: (proc.stdout || '').trim(), stderr: proc.stderr || '' };
}

// The advice the hook gave, or null when it said nothing. Parsed the way the
// harness parses it: a PostToolUse note lives at
// hookSpecificOutput.additionalContext and nowhere else.
function adviceFrom(result) {
  if (!result.stdout) return null;
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.hookSpecificOutput, 'output has no hookSpecificOutput, so Claude Code ignores it');
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  return parsed.hookSpecificOutput.additionalContext;
}

function writeEvent(file) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: file, content: fs.readFileSync(file, 'utf8') },
  };
}

function editEvent(file, oldString, newString) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: {
      file_path: file,
      old_string: oldString,
      new_string: newString,
      replace_all: false,
    },
  };
}

// --- the shape of the answer ------------------------------------------------

check('a stale count is reported, in the shape Claude Code actually reads', () => {
  const file = write('counts.md', [
    'The loader runs four checks before it gives up:',
    '',
    '- one',
    '- two',
    '- three',
    '- four',
    '- five',
    '',
  ].join('\n'));

  const result = run(writeEvent(file));
  assert.strictEqual(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  const advice = adviceFrom(result);
  assert.ok(advice, 'the hook said nothing about a count that disagrees with its list');
  assert.match(advice, /four checks/);
  assert.match(advice, /list of 5/);
});

check('a clean file gets no output at all', () => {
  const file = write('clean.md', [
    'The loader runs five checks before it gives up:',
    '',
    '- one',
    '- two',
    '- three',
    '- four',
    '- five',
    '',
  ].join('\n'));
  const result = run(writeEvent(file));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '', `expected silence, got: ${result.stdout}`);
});

check('it never blocks, whatever it finds', () => {
  // A PostToolUse hook can block by writing a decision. This one must not, and
  // the assertion is on the bytes rather than on the intent, because "never
  // blocks" written in a comment has stopped nothing.
  const file = write('blocky.md', 'It runs two checks:\n\n- a\n- b\n- c\n');
  const result = run(writeEvent(file));
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.decision, undefined, 'the hook emitted a decision and can therefore block');
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, undefined);
  assert.strictEqual(result.status, 0);
});

// --- what it declines to look at --------------------------------------------

check('it ignores anything that is not markdown', () => {
  // The content has to be text the detector would genuinely fire on, or this
  // passes whether the extension is checked or not. The first version used
  // markdown commented out with `//`, which no detector reads as a list, so
  // deleting the extension check left every assertion green.
  const text = 'It runs two checks:\n\n- a\n- b\n- c\n';
  assert.strictEqual(staleCounts(text).filter((c) => !c.ok).length, 1,
    'the fixture no longer trips the detector, so this proves nothing about the extension check');

  for (const name of ['notes.txt', 'code.js', 'README']) {
    const file = write(name, text);
    assert.strictEqual(run(writeEvent(file)).stdout, '', `${name} was linted as markdown`);
  }
});

check('it ignores a tool that is not Write or Edit', () => {
  const file = write('read-me.md', 'It runs two checks:\n\n- a\n- b\n- c\n');
  const event = writeEvent(file);
  event.tool_name = 'Read';
  assert.strictEqual(run(event).stdout, '');
});

check('it ignores a handoff, whose counts go stale by design', () => {
  // A handoff is rewritten wholesale at the end of every session and its
  // numbers describe a moment rather than the file. Warning on one would put a
  // notice on every single wrap, which is how a hook gets switched off.
  const file = write('HANDOFF.md', 'It runs two checks:\n\n- a\n- b\n- c\n');
  assert.strictEqual(run(writeEvent(file)).stdout, '');
});

check('a write that did not land is not reported on', () => {
  const event = writeEvent(write('gone.md', 'It runs two checks:\n\n- a\n- b\n- c\n'));
  fs.unlinkSync(event.tool_input.file_path);
  const result = run(event);
  assert.strictEqual(result.status, 0, 'the hook crashed on a missing file');
  assert.strictEqual(result.stdout, '');
});

check('malformed input does not crash it', () => {
  const proc = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(proc.status, 0, 'the hook exited non-zero on unparseable stdin');
  assert.strictEqual((proc.stdout || '').trim(), '');
});

// --- text replaced here and left standing there -----------------------------

check('text replaced in one place and left in another is reported', () => {
  const file = write('rounds.md', [
    'The review took nine rounds before it was clean.',
    '',
    'Every one of those eight rounds produced another finding.',
    '',
  ].join('\n'));

  const advice = adviceFrom(run(editEvent(file, 'eight rounds', 'nine rounds')));
  assert.ok(advice, 'the surviving copy of the replaced text was not reported');
  assert.match(advice, /eight rounds/);
  assert.match(advice, /line 3/);
});

check('a replacement with nothing left behind is silent', () => {
  const file = write('rounds-fixed.md', 'The review took nine rounds before it was clean.\n');
  assert.strictEqual(run(editEvent(file, 'eight rounds', 'nine rounds')).stdout, '');
});

check('a Write is not put through the surviving-text check', () => {
  // A Write replaces the whole file and carries no old_string, so there is no
  // "before" to compare against. The check does not apply, and inventing a
  // weaker version that guesses at one would be worse than not running it.
  const file = write('whole.md', 'Still says eight rounds here.\n');
  const event = writeEvent(file);
  event.tool_input.old_string = 'eight rounds';
  event.tool_input.new_string = 'nine rounds';
  assert.strictEqual(run(event).stdout, '', 'the surviving-text check ran on a Write');
});

check('replacing a common word reports nothing', () => {
  // The check turns entirely on this. Swapping "the" for "a" somewhere and
  // then listing every other "the" in the file is the check making itself
  // useless in a single run.
  const file = write('common.md', 'The one and the other and the third.\n');
  assert.strictEqual(run(editEvent(file, 'the', 'a')).stdout, '');
  assert.strictEqual(isDistinctive('the'), false);
  assert.strictEqual(isDistinctive('and the'), false);

  // The length floor, tested on its own. Everything above is refused for
  // having no solid words, so all of it passed while the floor was deleted.
  // A short string carrying a digit clears every other test in isDistinctive
  // and is refused by the floor alone, which makes it the only case that
  // pins it. `v2` as a substring is in "v20", "rev2" and "v2.1".
  assert.strictEqual(isDistinctive('v2'), false, 'a two-character fragment is specific enough to search for');
  assert.strictEqual(isDistinctive('#4'), false);
  assert.strictEqual(isDistinctive('step 41'), true, 'the floor is now refusing fragments that are long enough');
});

check('a fragment is grown out to whole words before it is searched for', () => {
  // Trimming the common prefix cuts through the middle of a word: "eight" and
  // "nine" share nothing, but "eighteen" and "eighty" share "eight". A cut
  // fragment is distinctive, matches nothing, and would quietly make this
  // check useless on exactly the edits it exists for.
  const [fragment] = replacedFragments('it took eighteen rounds', 'it took eighty rounds');
  assert.ok(/^eighteen/.test(fragment.trim()), `fragment was cut mid-word: ${JSON.stringify(fragment)}`);
});

// --- a file that breaks a rule it states ------------------------------------

check('a file that bans em dashes and then uses one is reported', () => {
  const file = write('rules.md', [
    '# House style',
    '',
    'Never use em dashes in anything that ships.',
    '',
    'The result is a document that reads well — and nobody had to edit it.',
    '',
  ].join('\n'));

  const advice = adviceFrom(run(writeEvent(file)));
  assert.ok(advice, 'a file broke a rule it states and nothing was said');
  assert.match(advice, /em dash/);
  assert.match(advice, /line 5/);
});

check('the line stating the rule is not itself a breach of it', () => {
  // "Never use an em dash — like this one" is the rule and its illustration on
  // one line. Reporting it reports the documentation of a rule as a violation.
  const file = write('rule-with-example.md', [
    '# House style',
    '',
    'Never use em dashes — this character is banned.',
    '',
  ].join('\n'));
  assert.strictEqual(run(writeEvent(file)).stdout, '');
});

check('quoting the forbidden character inline is showing it, not using it', () => {
  // The breach scan skipped fenced and indented blocks, on the reasoning that
  // showing the character is how you document a rule about characters. An
  // inline span is the other way of doing that and was not covered, so a file
  // explaining its own rule was warned by it. The file most likely to quote an
  // em dash while banning em dashes is the one explaining the rule, which made
  // this plugin's own documentation the first thing it would have fired on.
  const inline = write('inline.md', ['Never use em dashes.', '', 'The `—` character is banned in prose.', ''].join('\n'));
  assert.strictEqual(run(writeEvent(inline)).stdout, '', 'a character quoted in backticks was read as a use of it');

  const double = write('inline2.md', ['Never use em dashes.', '', 'Write ``a — b`` to show it.', ''].join('\n'));
  assert.strictEqual(run(writeEvent(double)).stdout, '', 'a double-backtick span was not removed whole');

  // A breach outside a span, on a line that also has a span, still counts.
  const mixed = write('inline3.md', ['Never use em dashes.', '', 'The `x` marker — like this.', ''].join('\n'));
  assert.ok(adviceFrom(run(writeEvent(mixed))), 'stripping spans swallowed a real breach on the same line');
});

check('marking up part of the rule does not stop it being the rule', () => {
  // Found by writing the test above. The rule test ran against the raw line,
  // and the pattern wants whitespace between "use" and "em" where a backtick
  // was sitting, so a rule written this way was never detected at all and the
  // file was held to nothing. Predates the code-span work.
  //
  // Removing whole spans would not fix it either: "Never use `em dashes`"
  // becomes "Never use ." and the rule disappears a second way. The rule test
  // drops only the backticks and keeps the words, which is the opposite of
  // what the breach test needs.
  const file = write('markup.md', ['Never use `em dashes`.', '', 'This reads well — and nobody edited it.', ''].join('\n'));
  const advice = adviceFrom(run(writeEvent(file)));
  assert.ok(advice, 'a rule written with backticks was never detected, so the file was held to nothing');
  assert.match(advice, /line 3/);
});

check('a code example showing the forbidden character is left alone', () => {
  // Documenting a rule about a character means showing the character. This
  // plugin's own README does exactly that and would otherwise be the first
  // thing flagged by its own hook.
  const file = write('rule-with-fence.md', [
    '# House style',
    '',
    'Never use em dashes.',
    '',
    'What the check looks for:',
    '',
    '```',
    'a sentence — with one in it',
    '```',
    '',
  ].join('\n'));
  assert.strictEqual(run(writeEvent(file)).stdout, '');
});

check('a file that never states the rule is not held to it', () => {
  const file = write('no-rule.md', 'An ordinary document — with an em dash in it.\n');
  assert.strictEqual(run(writeEvent(file)).stdout, '');
});

// --- what the corpus sweep found, which no test above would have -------------

check('a range is not a count', () => {
  // "Build a comparison table with 3-5 options:" was read as claiming five, and
  // compared against a two-row template. Found by sweeping 593 markdown files;
  // every test written before that sweep passed while this was broken.
  const enDash = ['Build a comparison table with 3–5 options:', '', '| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
  assert.deepStrictEqual(staleCounts(enDash).filter((c) => !c.ok), [], 'an en-dash range was read as a count');

  const hyphen = ['It has 3-5 options:', '', '- a', '- b'].join('\n');
  assert.deepStrictEqual(staleCounts(hyphen).filter((c) => !c.ok), [], 'a hyphen range was read as a count');

  // And a plain count next to a list is still checked.
  const plain = ['It has 5 options:', '', '- a', '- b'].join('\n');
  assert.strictEqual(staleCounts(plain).filter((c) => !c.ok).length, 1, 'the range guard silenced an ordinary count');
});

check('a fraction is not a count', () => {
  // "7/7 success criteria, 49/49 requirements" was read as claiming 49.
  const text = ['We hit 7/7 success criteria, 49/49 requirements.', '', '- a', '- b'].join('\n');
  assert.deepStrictEqual(staleCounts(text).filter((c) => !c.ok), [], 'a fraction was read as a count');
});

check('a count that points backwards is not announcing the list', () => {
  // "that build path and those five steps, which is what the handout
  // describes" sits above a four-row table of files, and was reported as
  // claiming five of them. "those" refers to something already named.
  const back = ['that build path and those five steps, which the handout describes',
    '', '| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |', '| 7 | 8 |'].join('\n');
  assert.deepStrictEqual(staleCounts(back).filter((c) => !c.ok), [], '"those five steps" was read as announcing the table');

  // Narrow on purpose. "these" can genuinely introduce a list, so it is not
  // covered, and an ordinary announcement is untouched.
  const ordinary = ['It runs five steps:', '', '- a', '- b', '- c'].join('\n');
  assert.strictEqual(staleCounts(ordinary).filter((c) => !c.ok).length, 1, 'the guard silenced an ordinary announcement');
  const these = ['These five steps matter:', '', '- a', '- b', '- c'].join('\n');
  assert.strictEqual(staleCounts(these).filter((c) => !c.ok).length, 1, '"these" was swept up with "those"');
});

check('an estimate is not a count', () => {
  for (const hedge of ['up to', 'about', 'at least', 'roughly', 'around']) {
    const text = [`It shows ${hedge} 8 options:`, '', '- a', '- b'].join('\n');
    assert.deepStrictEqual(staleCounts(text).filter((c) => !c.ok), [],
      `"${hedge} 8 options" was treated as an exact claim`);
  }
});

check('a name at the end of a sentence does not take the full stop with it', () => {
  // The word-growing class holds a dot, or "queue.js" is cut at the dot and
  // searched for as "queue". That made a name at the end of a sentence absorb
  // the full stop, so renaming it went looking for "queue.js." and missed
  // every other mention, none of which have a full stop after them. The most
  // ordinary shape there is, and the check was silent on it.
  const [fragment] = replacedFragments('Renamed to queue.js.', 'Renamed to store.js.');
  assert.strictEqual(fragment.trim(), 'queue.js', `fragment kept its sentence punctuation: ${JSON.stringify(fragment)}`);

  const hits = survivingText('See queue.js for the rest.\n', 'Renamed to queue.js.', 'Renamed to store.js.');
  assert.strictEqual(hits.length, 1, 'a leftover mention without a full stop after it was missed');

  // The dot inside the name still has to survive, or this searches for
  // "queue" and matches "queue-runner" and "queuing".
  assert.ok(fragment.includes('.js'), 'the dot inside the name was trimmed too');
});

check('a longer token that merely starts the same way is not a leftover', () => {
  // "Step 4" was reported as surviving on a line reading "Step 41", which sends
  // the writer to correct text that is already right. Renumbering is the shape
  // this check fires on most, so 4 and 41 in one file is the likely case rather
  // than a contrived one. The length floor in isDistinctive was written for
  // this hazard and does not reach it: "Step 4" is six characters.
  const file = write('steps.md', ['# Doc', '', '## Step 5: Review', 'See Step 41 for the rest.', ''].join('\n'));
  assert.strictEqual(run(editEvent(file, '## Step 4: Review', '## Step 5: Review')).stdout, '',
    '"Step 41" was reported as a surviving copy of "Step 4"');

  // And the leftover it is actually for still reports.
  const real = write('steps-real.md', ['# Doc', '', '## Step 5: Review', 'See Step 4 for the rest.', ''].join('\n'));
  const advice = adviceFrom(run(editEvent(real, '## Step 4: Review', '## Step 5: Review')));
  assert.ok(advice, 'a genuine leftover stopped being reported');
  assert.match(advice, /line 4/);

  // Two shapes that must survive the boundary. A fragment at the end of a
  // sentence has punctuation after it, and a substep has to move when its
  // parent does, so both are real.
  assert.strictEqual(survivingText('Go to Step 4.\n', '## Step 4: Review', '## Step 5: Review').length, 1,
    'a leftover at the end of a sentence stopped matching');
  assert.strictEqual(survivingText('See Step 4.2.\n', '## Step 4: Review', '## Step 5: Review').length, 1,
    'a substep of the renamed step stopped matching');
});

check('a file with hundreds of breaches does not produce hundreds of numbers', () => {
  // One archived file in her own work states a rule against em dashes and then
  // breaks it on 509 lines. The advice goes into the conversation and is paid
  // for by the token, so naming every line is both unreadable and expensive.
  const lines = ['Never use em dashes.', ''];
  for (let i = 0; i < 200; i++) lines.push(`Line ${i} — with one in it.`);
  const file = write('many.md', lines.join('\n'));

  const advice = adviceFrom(run(writeEvent(file)));
  assert.ok(advice, 'a file breaking its own rule 200 times was not reported');
  assert.match(advice, /200 lines, starting/);
  assert.ok(advice.length < 600, `the advice ran to ${advice.length} characters`);
});

// --- only what this edit could have caused ----------------------------------

check('an edit far from an existing contradiction says nothing about it', () => {
  // Without this, the two whole-file checks re-report every pre-existing
  // finding on every later edit to the file. MEMORY.md in her own history was
  // written 28 times while stating a rule it breaks on 68 lines, so the same
  // advice would have gone into the conversation 28 times.
  const before = [
    'It runs two checks:',
    '',
    '- a',
    '- b',
    '- c',
    '',
    'A paragraph far below, which is the one being edited.',
    '',
  ].join('\n');
  const file = write('faraway.md', before.replace('A paragraph far below', 'A paragraph well below'));
  assert.strictEqual(run(editEvent(file, 'A paragraph far below', 'A paragraph well below')).stdout, '',
    'an untouched contradiction elsewhere in the file was reported again');
});

check('an edit that creates the contradiction still reports it', () => {
  // The case the whole check exists for: a row is added to the list and the
  // sentence above it is not updated. The sentence is outside the edited text,
  // so a narrower rule keyed on the changed line alone would miss it. The span
  // runs from the sentence to the end of the list, which is why it does not.
  const file = write('grew.md', ['It runs two checks:', '', '- a', '- b', '- c', ''].join('\n'));
  const advice = adviceFrom(run(editEvent(file, '- b', '- b\n- c')));
  assert.ok(advice, 'adding a row to the list did not re-check the count above it');
  assert.match(advice, /two checks/);
});

check('an edit that introduces a breach of a stated rule reports it', () => {
  const file = write('newbreach.md', ['Never use em dashes.', '', 'A line — with one.', ''].join('\n'));
  const advice = adviceFrom(run(editEvent(file, 'A line.', 'A line — with one.')));
  assert.ok(advice, 'an em dash added by this very edit was not reported');
  assert.match(advice, /line 3/);
});

check('editing beside a rule line is not the same as introducing the rule', () => {
  // The scoping had one exception, for a rule the edit added, and the
  // exception was tested by asking whether the rule's line fell inside the
  // edited span. An Edit routinely carries surrounding lines so its match is
  // unique, so an untouched rule sentence landed inside the span constantly
  // and every old breach in the file came back as this edit's doing. The noise
  // the scoping was added to stop, arriving through the exception to it.
  const body = ['# Doc', '', 'Never use em dashes.', '', 'Old one — here.', '', 'Old two — here.', ''].join('\n');
  const file = write('beside.md', body);

  const span = 'Never use em dashes.\n\nOld one — here.';
  assert.strictEqual(run(editEvent(file, span, span)).stdout, '',
    'an edit spanning the unchanged rule line re-reported every old breach');

  // Stated on the detector too, so this cannot pass because the hook went
  // quiet for some unrelated reason.
  assert.deepStrictEqual(ruleChange('em-dash', span, span), { addedRule: false, addedBreach: false });
});

check('the edit test and the file scan ask the same question', () => {
  // There used to be two definitions of "states the rule" and "breaks the
  // rule": one in brokenOwnRule, one in ruleChange. The moment the file scan
  // learned to normalise for code spans they drifted, and in both directions
  // at once. This is the check that the split is gone rather than repaired.
  //
  // Adding the rule with the phrase marked up is adding the rule.
  assert.deepStrictEqual(ruleChange('em-dash', 'Something else.', 'Never use `em dashes`.'),
    { addedRule: true, addedBreach: false },
    'a rule added with backticks was not seen as added, so the file it contradicts went unreported');

  // Quoting the character in a code span is showing it, not using it, and the
  // file scan has said so since the round before this one.
  assert.deepStrictEqual(ruleChange('em-dash', 'Show inline.', 'Show `a — b` inline.'),
    { addedRule: false, addedBreach: false },
    'an em dash inside a code span counted as a breach, so an old breach elsewhere was blamed on this edit');

  // The pairing stated directly: whatever the file scan calls a breach on a
  // line, the edit test has to agree with, or one of them is wrong again.
  //
  // The first four cases are the ones this test shipped with, and they are all
  // single plain lines. That is how the seventh finding got through: the two
  // sides also disagreed about a fenced example and about the rule sentence
  // itself, and nothing here asked. The rest of the list is those gaps.
  const bodies = [
    'plain — here',
    'span `a — b` only',
    'both `a — b` and — here',
    'nothing at all',
    // A fence is where you show the fault. Neither side may call it a breach.
    '```\nbad — example\n```',
    '~~~\nbad — example\n~~~',
    'before\n\n```\nbad — example\n```\n\nafter',
    // Four spaces after a blank line is the other kind of example.
    '\n    bad — example',
    // A fence that also contains the rule sentence still states nothing.
    '```\nNever use em dashes — ever.\n```',
    // Real prose next to a shown one: the prose counts, the fence does not.
    'real — breach\n\n```\nshown — only\n```',
  ];
  for (const body of bodies) {
    const scanSaysBreach = brokenOwnRule(`Never use em dashes.\n\n${body}\n`).length > 0;
    const editSaysBreach = ruleChange('em-dash', '', body).addedBreach;
    assert.strictEqual(editSaysBreach, scanSaysBreach,
      `the two disagree about ${JSON.stringify(body)}: scan=${scanSaysBreach} edit=${editSaysBreach}`);
  }

  // The other half of the same asymmetry. The scan never counts the line that
  // states the rule as breaking it; the edit test used to, so adding the rule
  // and the em dash in one sentence reported a breach the scan denied.
  assert.deepStrictEqual(ruleChange('em-dash', 'x', 'Never use em dashes — ever.'),
    { addedRule: true, addedBreach: false },
    'the sentence stating the rule counted as breaking it, which the file scan has never done');
  assert.deepStrictEqual(brokenOwnRule('Never use em dashes — ever.'), [],
    'the file scan changed its mind about the rule sentence, so the pairing above is now wrong');
});

// An index names what its entries are about, and that is not the same as
// stating a rule for itself. Reported 2026-08-09 against MEMORY.md, which is
// exactly this shape: 30 entries of `- [Title](file.md) — one line about it`,
// one of them naming the no-em-dashes rule, and the format's own separator on
// 45 of 66 lines. It fired on every edit and always would have.
check('a rule named in a list item that links elsewhere is that document\'s rule, not this one\'s', () => {
  const index = [
    '# Index',
    '',
    '- [Handoff](HANDOFF.md) — where the live threads are',
    '- [Writing style rules](writing-style-rules.md) — no em dashes, plain English',
    '- [Hard rules](hard-rules.md) — never touch her email',
    '',
  ].join('\n');
  assert.deepStrictEqual(brokenOwnRule(index), [],
    'an index entry describing another document was read as a rule binding the index');
});

check('a rule in a plain list item is still this file\'s own rule', () => {
  // The exclusion above turns on the link, not on the list item. Without that,
  // any rule written as a bullet would stop counting, which is how most rules
  // files write them.
  const rules = '# Rules\n\n- No em dashes in prose.\n\nIt ran — and finished.\n';
  const found = brokenOwnRule(rules);
  assert.strictEqual(found.length, 1, 'a bulleted rule with no link stopped being a rule');
  assert.deepStrictEqual(found[0].lines, [5], 'the breach line moved');
});

check('a link into this same document is not somewhere else', () => {
  // An anchor points into the file stating it, so the rule is still its own.
  const anchored = '# Rules\n\n- [See below](#style) no em dashes here.\n\nIt ran — and finished.\n';
  assert.strictEqual(brokenOwnRule(anchored).length, 1,
    'an anchor link was treated as pointing at another document');
});

check('index entries are not breaches either, when another line does state the rule', () => {
  // Skipping only the rule test is half a fix. The file below states the rule
  // in prose, so the statement is found somewhere else, and the two index
  // separators then get reported as breaking it. They are that index format's
  // punctuation, and reporting them is the same false finding with a different
  // sentence on it.
  const withIndex = [
    '# House rules',
    '',
    'No em dashes in this document.',
    '',
    '- [Handoff](HANDOFF.md) — where the live threads are',
    '- [Hard rules](hard-rules.md) — never touch the mailbox',
    '',
  ].join('\n');
  assert.deepStrictEqual(brokenOwnRule(withIndex), [],
    'an index separator was reported as breaking a rule stated elsewhere in the file');
});

check('link syntax shown in a code span does not swallow a rule on the same line', () => {
  // Every other predicate here reads past code spans, because showing a thing
  // is not using it. Without that, the bullet below looks like an index entry
  // and the rule it plainly states is never found.
  const showsSyntax = '# Rules\n\n- No em dashes, write links as `[Title](file.md)`.\n\nIt ran — and finished.\n';
  const found = brokenOwnRule(showsSyntax);
  assert.strictEqual(found.length, 1, 'a rule stated beside a code span link was missed');
  assert.deepStrictEqual(found[0].lines, [5], 'the breach line moved');
});

check('an index entry does not state the rule either, so a breach elsewhere goes unreported', () => {
  // The other half of the pair, and the only case that pins it. Every test
  // above would still pass if the line were skipped before the breach test
  // alone and still counted as a statement, because an index on its own has no
  // other breach to report. Here it does: the prose line is a genuine em dash.
  // If the entry counted as stating the rule, that line would be reported
  // against a rule this document never set.
  const indexPlusProse = [
    '# Index',
    '',
    '- [Writing style rules](writing-style-rules.md) — no em dashes, plain English',
    '',
    'It ran — and finished.',
    '',
  ].join('\n');
  assert.deepStrictEqual(brokenOwnRule(indexPlusProse), [],
    'an index entry was counted as setting a rule for the file listing it');
});

check('an anchor is still an anchor with space or angle brackets around it', () => {
  // The lookahead has to cover the whole leading run. Checking one position
  // inside it lets the whitespace backtrack until the test passes, so `(  #x)`
  // read as a link somewhere else and the rule on that line was dropped with
  // nothing said. `(<#x>)` went the same way.
  for (const target of ['#style', '  #style', '<#style>']) {
    const text = `# Rules\n\n- [See below](${target}) no em dashes here.\n\nIt ran — and finished.\n`;
    assert.strictEqual(brokenOwnRule(text).length, 1,
      `a same-document anchor written as (${target}) was treated as pointing elsewhere`);
  }
});

check('angle brackets around a filename do not make it this document', () => {
  // The fix for the case above read every `<` as the start of an anchor.
  // Markdown uses that wrapper for ordinary targets too, which is the whole
  // reason it exists, so an index written that way went back to the report this
  // change removes. The `#` is what decides, not the bracket.
  // The prose line is load-bearing. brokenOwnRule wants a statement and a
  // breach before it says anything, and every list line here is skipped, so
  // without a breach that is never skipped the pair cannot complete and the
  // case passes whether the entry was excluded or not.
  for (const target of ['<file.md>', '<my file.md>']) {
    const index = [
      '# Index',
      '',
      `- [Writing style rules](${target}) — no em dashes, plain English`,
      '',
      'It ran — and finished.',
      '',
    ].join('\n');
    assert.deepStrictEqual(brokenOwnRule(index), [],
      `an index entry written as (${target}) was read as this document's own rule`);
  }
});

check('an image in a list item is not a link to another document', () => {
  // The bracket has to be the link's, not an image's. The `.*` ahead of it
  // swallowed the `!`, so a captioned screenshot was read as an index entry and
  // its caption stopped being checked.
  const caption = '# Rules\n\nNo em dashes.\n\n- ![a screenshot](shot.png) — the caption\n';
  assert.strictEqual(brokenOwnRule(caption).length, 1,
    'an image caption was skipped as though it were an index entry');
});

check('adding an index entry is not adding a rule', () => {
  // ruleChange asks the same two questions through ruleLines, so it inherits
  // the exclusion. Pinned separately because nothing else here would notice if
  // the two ever stopped sharing a path.
  assert.deepStrictEqual(
    ruleChange('em-dash', '# Index\n', '# Index\n\n- [Style](style.md) — no em dashes\n'),
    { addedRule: false, addedBreach: false },
    'listing a document that has a rule read as giving the index that rule');
});

check('a prose sentence containing a link still states the file\'s own rule', () => {
  // The exclusion is scoped to list items on purpose, and this is what pins
  // that. An implementation that skipped any line holding a link would pass
  // the three cases above and fail this one.
  const prose = '# Rules\n\nSee [style](style.md). No em dashes here.\n\nIt ran — and finished.\n';
  assert.strictEqual(brokenOwnRule(prose).length, 1,
    'a link in ordinary prose was treated as an index entry');
});

check('adding an example does not re-report an untouched line', () => {
  // The seventh review finding, at the level it was reported. A file states the
  // rule and already breaks it on line 5. The edit appends a fenced example,
  // which is not a breach by the file scan's own rules, and touches nothing
  // else. Line 5 is not this edit's doing and must not come back.
  //
  // Measured, not hypothetical: 36 of 833 markdown Edit calls in her history
  // added a fenced block, so this fired on roughly one edit in 23.
  const before = ['# Style', '', 'Never use em dashes.', '', 'Already wrong — here.', ''].join('\n');
  const oldStr = 'Already wrong — here.';
  const newStr = 'Already wrong — here.\n\n```\nbad — example\n```';
  const file = write('fenced-example.md', before.replace(oldStr, newStr));

  assert.strictEqual(adviceFrom(run(editEvent(file, oldStr, newStr))), null,
    'an edit that only added an example was blamed for a contradiction that was already there');
});

check('an edit that did not land says nothing', () => {
  // A denied or errored call does not reach a PostToolUse hook at all: the
  // documented lifecycle sends those to PermissionRequest and
  // PostToolUseFailure. What is left is a file something else changed in
  // between, where the new text is nowhere on disk. Nothing found in it can be
  // attributed to this event, and every check would otherwise fall back to the
  // whole file, which is the noisiest answer available.
  //
  // The count check is what this is asserted through, deliberately. The rule
  // check goes quiet here for its own reason, having no before to rebuild, so a
  // test written against that one passes whether this guard exists or not and
  // says nothing about it. Two guards covering each other is how the round
  // before this shipped three assertions with nothing under them.
  const file = write('never-landed.md', ['It runs two checks:', '', '- a', '- b', '- c', ''].join('\n'));

  assert.ok(adviceFrom(run(editEvent(file, '- b', '- b'))),
    'the fixture stopped producing a finding, so the assertion below proves nothing');
  assert.strictEqual(adviceFrom(run(editEvent(file, 'anything', 'text that is nowhere in the file'))), null,
    'an edit whose text never reached the file was still blamed for what the file already said');
});

check('editStanding answers both questions separately', () => {
  // Asserted directly rather than through the hook. Each guard below is one an
  // end-to-end test agrees with for its own reasons, the rule check going quiet
  // without a before regardless, so a suite that only drives the hook stays
  // green with any of them deleted. That is how the previous round shipped
  // three assertions with nothing underneath them.
  const file = 'alpha\nbravo\ncharlie\n';

  // The ordinary case: the whole prior document, not the fragment.
  assert.deepStrictEqual(editStanding('alpha\ndelta\ncharlie\n', { old_string: 'bravo', new_string: 'delta' }),
    { landed: true, text: 'alpha\nbravo\ncharlie\n' },
    'a rebuilt before must be the whole file with the old text put back');

  // Not on disk as written: the edit did not land here.
  assert.deepStrictEqual(editStanding(file, { old_string: 'x', new_string: 'nowhere in the file' }),
    { landed: false, text: null });

  // Landed, but not rebuildable. Both of these must keep `landed` true, or the
  // other two checks stop running on an edit that really did happen.
  assert.deepStrictEqual(editStanding('a\na\n', { old_string: 'b', new_string: 'a' }),
    { landed: true, text: null }, 'an ambiguous match must not be rebuilt from a guessed occurrence');
  assert.deepStrictEqual(editStanding(file, { old_string: 'b', new_string: 'alpha', replace_all: true }),
    { landed: true, text: null }, 'a replace_all edit must not be rebuilt by replacing every occurrence');

  // A deletion carries no new text to find, so it is taken at its word.
  assert.deepStrictEqual(editStanding(file, { old_string: 'bravo\n', new_string: '' }),
    { landed: true, text: null });
});

check('a replace_all edit is not credited with a rule that was already stated', () => {
  // Why the guard above is not merely cautious. Rebuilding a replace_all turns
  // every copy of the new text back into the old, including copies that were
  // there before the edit. Here that erases the file's own statement of the
  // rule from the reconstructed before, so an untouched rule reads as one this
  // edit introduced, and introducing a rule reports every breach in the file
  // however far away it is.
  const file = write('replace-all-rule.md', [
    'Never use em dashes.', '', 'Already wrong — here.', '', 'Never use em dashes.', '',
  ].join('\n'));

  const event = editEvent(file, 'plain', 'Never use em dashes.');
  event.tool_input.replace_all = true;
  assert.strictEqual(adviceFrom(run(event)), null,
    'a replace_all edit was credited with stating a rule the file already stated, and blamed for every breach in it');
});

check('an edit that cannot be rebuilt makes no claim about a rule', () => {
  // Landed, but in more than one place, so the document it replaced cannot be
  // reconstructed. The other two checks still run and fail towards reporting;
  // this one cannot, because "did this edit add a breach" has no meaning
  // without a before, and answering it against an empty before calls every
  // breach in the file new.
  const file = write('unrebuildable.md', ['# Style', '', 'Never use em dashes.', '', 'Already wrong — here.', '', 'x', '', 'x', ''].join('\n'));

  assert.strictEqual(adviceFrom(run(editEvent(file, 'y', 'x'))), null,
    'an edit that could not be placed blamed itself for a contradiction that was already there');

  const all = editEvent(file, 'x', 'x');
  all.tool_input.replace_all = true;
  assert.strictEqual(adviceFrom(run(all)), null,
    'a replace_all edit blamed itself for a contradiction that was already there');
});

check('a tool call that reports failure says nothing', () => {
  // Belt to the above, and unreachable by the documented lifecycle. Written so
  // that the same event without the failure signal does speak, or it would pass
  // on the strength of some other silence.
  const file = write('reported-failure.md', ['# Style', '', 'Never use em dashes.', '', 'Already wrong — here.', ''].join('\n'));
  const claimed = () => editEvent(file, 'Already wrong.', 'Already wrong — here.');

  assert.ok(adviceFrom(run(claimed())), 'the fixture stopped producing a finding, so the assertions below prove nothing');

  for (const response of [
    { success: false, error: "The user doesn't want to proceed with this tool use." },
    { is_error: true, content: 'String to replace not found in file.' },
  ]) {
    const event = claimed();
    event.tool_response = response;
    assert.strictEqual(adviceFrom(run(event)), null,
      `a tool call reporting ${JSON.stringify(response)} still produced advice`);
  }

  // Asymmetric on purpose. A missing or unfamiliar tool_response must leave the
  // hook exactly as it behaves without one, or an unrelated harness change
  // silences the check instead of loosening it.
  const ok = claimed();
  ok.tool_response = { filePath: file, somethingUnfamiliar: true };
  assert.ok(adviceFrom(run(ok)), 'an unrecognised tool_response shape silenced the hook');
});

check('an edit that adds a breach reports that breach', () => {
  const file = write('addedbreach.md', ['Never use em dashes.', '', 'A new line — here.', ''].join('\n'));
  const advice = adviceFrom(run(editEvent(file, 'A new line.', 'A new line — here.')));
  assert.ok(advice, 'an em dash this edit added was not reported');
  assert.match(advice, /line 3/);

  // Changing the text around a breach that was already there is not adding one.
  assert.deepStrictEqual(ruleChange('em-dash', 'a — b', 'a — c'), { addedRule: false, addedBreach: false });
});

check('an edit that introduces the rule reports every breach, however far', () => {
  // Adding "never use em dashes" to a file already full of them is a
  // contradiction this edit created, so all of it is news even though the
  // breaches are nowhere near the change.
  const lines = ['# Doc', ''];
  for (let i = 0; i < 5; i++) lines.push(`Line ${i} — with one.`);
  lines.push('', 'Never use em dashes.', '');
  const file = write('newrule.md', lines.join('\n'));

  const advice = adviceFrom(run(editEvent(file, 'Never use dashes.', 'Never use em dashes.')));
  assert.ok(advice, 'a rule added to a file that already breaks it was not reported');
  assert.match(advice, /lines 3, 4, 5, 6, 7/);
});

check('deleting prose does not re-report old problems elsewhere', () => {
  // A deletion sends new_string: "", so there is nothing to search the file
  // for and the edit cannot be placed. Falling back to the whole file made a
  // deletion the noisiest event there is: take one line out of a long document
  // and every old contradiction in it comes back.
  const file = write('deleted.md', [
    'It runs two checks:',
    '',
    '- a',
    '- b',
    '- c',
    '',
    'Never use em dashes.',
    '',
    'A line — with one.',
    '',
  ].join('\n'));

  // A paragraph of prose came out, well away from both findings, and took no
  // list structure with it.
  const event = editEvent(file, 'An unrelated sentence that was here.', '');
  assert.strictEqual(run(event).stdout, '',
    'deleting unrelated prose re-reported contradictions the author has already seen');
});

check('an edit that only changes punctuation is not a leftover of itself', () => {
  // Caused by the trailing-punctuation trim added a round earlier, which is
  // the shape where the fix is the next bug. When the only thing the edit
  // changed was the punctuation after a word, the trim removes the one
  // character that differed, so the fragment becomes exactly the text now
  // standing at the edit site and the line reports itself.
  const comma = write('punct.md', 'The release shipped 5 fixes,\n');
  assert.strictEqual(run(editEvent(comma, 'The release shipped 5 fixes.', 'The release shipped 5 fixes,')).stdout, '',
    'swapping a full stop for a comma was reported as an unfinished change');

  const bang = write('punct2.md', 'Renamed to queue.js!\n');
  assert.strictEqual(run(editEvent(bang, 'Renamed to queue.js.', 'Renamed to queue.js!')).stdout, '',
    'swapping a full stop for an exclamation mark was reported as an unfinished change');

  // Stated directly, because the hook path above can go quiet for other
  // reasons and would then pass while this was broken.
  assert.strictEqual(survivingText('The release shipped 5 fixes,\n',
    'The release shipped 5 fixes.', 'The release shipped 5 fixes,').length, 0);

  // And a real leftover, where the replacement does not contain the fragment,
  // is untouched by the guard.
  assert.strictEqual(survivingText('Those eight rounds hurt.\n', 'eight rounds', 'nine rounds').length, 1,
    'the guard silenced a genuine leftover');
});

check('deleting an ordinary paragraph stays quiet, blank line and all', () => {
  // The hole in the previous round's own fix. A blank line counted as list
  // structure, on the sound reasoning that removing one joins two lists. But
  // a real paragraph deletion carries its trailing blank, so the guard let
  // through the commonest edit there is and quietly restored the noise it was
  // added to stop.
  //
  // The test written alongside that fix deleted a sentence with no newline,
  // the one paragraph shape that carries no blank. It was built to pass.
  const file = write('para.md', ['It runs two checks:', '', '- a', '- b', '- c', '', ''].join('\n'));
  assert.strictEqual(run(editEvent(file, 'An unrelated paragraph.\n\n', '')).stdout, '',
    'deleting a paragraph with its trailing blank re-reported an old count');
});

check('deleting a list item still re-checks the count above it', () => {
  // The half of a deletion that genuinely creates the fault: the list gets
  // shorter and the sentence announcing it does not change.
  const file = write('shrunk.md', ['It runs four checks:', '', '- a', '- b', '- c', ''].join('\n'));
  const advice = adviceFrom(run(editEvent(file, '- d\n', '')));
  assert.ok(advice, 'removing a list item did not re-check the count above it');
  assert.match(advice, /four checks/);
});

check('a deletion is never reported as breaking a stated rule', () => {
  // Taking text out cannot put an em dash in, nor state a rule that was not
  // already there, so every breach after a deletion predates it.
  const file = write('deleted-rule.md', ['Never use em dashes.', '', 'A line — with one.', ''].join('\n'));
  const event = editEvent(file, 'Another line — with one.\n', '');
  const out = run(event).stdout;
  if (out) {
    assert.ok(!JSON.parse(out).hookSpecificOutput.additionalContext.includes('states a rule'),
      'a pre-existing em dash was reported as though the deletion caused it');
  }
});

check('an edit that cannot be located checks the whole file', () => {
  // Every uncertain case fails towards reporting, because a repeated finding
  // is a nuisance and a missed one is the thing this exists to prevent.
  const file = write('ambiguous.md', ['It runs two checks:', '', '- a', '- b', '- c', '', 'x', '', 'x', ''].join('\n'));

  // replace_all: many regions, not one.
  const all = editEvent(file, 'x', 'x');
  all.tool_input.replace_all = true;
  assert.ok(adviceFrom(run(all)), 'a replace_all edit did not fall back to the whole file');

  // new_string appearing twice: which one landed is unknowable.
  assert.ok(adviceFrom(run(editEvent(file, 'y', 'x'))), 'an ambiguous edit did not fall back to the whole file');
});

check('a Write is always checked in full', () => {
  const file = write('written.md', ['It runs two checks:', '', '- a', '- b', '- c', ''].join('\n'));
  assert.ok(adviceFrom(run(writeEvent(file))), 'a Write stopped being checked in full');
});

check('surviving text is searched inside code examples, unlike the other two', () => {
  // The asymmetry is deliberate and was not obvious, so it is pinned here.
  //
  // The other two checks skip fenced blocks because a fence is where you
  // demonstrate the fault: an example of a stale count, or of the forbidden
  // character. A fence is not demonstrating anything for this check, it is
  // using the value. Renaming queue.js to store.js and leaving `node
  // scripts/queue.js` in a code block is the most ordinary version of exactly
  // the fault this looks for, and skipping fences would silence it.
  //
  // Measured: of the 11 real firings across 790 edits in her transcripts, none
  // were inside a fence, so this has cost nothing so far either way.
  const content = ['# Doc', '', 'Renamed to store.js.', '', '```', 'node scripts/queue.js lint', '```', ''].join('\n');
  const hits = survivingText(content, 'Renamed to queue.js.', 'Renamed to store.js.');
  assert.strictEqual(hits.length, 1, 'a stale reference inside a code block was skipped');
  assert.deepStrictEqual(hits[0].lines, [6]);

  // A backtick is part of the token, so a fragment taken from `queue.js` in
  // prose does not match a bare queue.js in a code block. That is the same
  // rule that keeps `x` and x apart everywhere else here, and it costs this
  // case. Recorded rather than argued with: widening it is a change to make
  // against a real example, not a hypothetical one.
  const quoted = survivingText(content, 'Renamed to `queue.js`.', 'Renamed to `store.js`.');
  assert.strictEqual(quoted.length, 0, 'the backtick rule has changed, which may now be the better behaviour');
});

// --- false positives on real work -------------------------------------------

check('no finding on any markdown file in this repository', () => {
  // The measurement that decides whether this is worth shipping. Every check is
  // prose-pattern based, so the question is not whether it catches the sample
  // it was written for, it is what it says about work that is already correct.
  //
  // A finding here is not automatically a bug in the file. It is a claim that
  // wants reading, and if the file is right then the detector is wrong and the
  // suite should stop the merge either way.
  const IGNORED = new Set(['node_modules', '.git', 'HANDOFF.md']);
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) files.push(full);
    }
  }(ROOT));

  const findings = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (const c of staleCounts(text)) {
      if (!c.ok) findings.push(`${rel}:${c.line} "${c.stated}" over a ${c.kind} of ${c.count}`);
    }
    for (const b of brokenOwnRule(text)) {
      findings.push(`${rel}: states a rule against ${b.what} at line ${b.statedAt}, breached at ${b.lines.join(', ')}`);
    }
  }

  console.log(`        (${files.length} markdown files swept, ${findings.length} findings)`);
  assert.deepStrictEqual(findings, [],
    `the detectors fire on work that is already correct:\n        ${findings.join('\n        ')}`);
});

check('the sweep is actually reading files', () => {
  // A sweep that matches nothing passes forever. The same fault the counts
  // suite already carries an assertion for, one level along.
  const seeded = 'It runs two checks:\n\n- a\n- b\n- c\n';
  assert.strictEqual(staleCounts(seeded).filter((c) => !c.ok).length, 1,
    'the count detector no longer fires on a known-bad sample, so the sweep proves nothing');
  const banned = 'Never use em dashes.\n\nAnd then — this.\n';
  assert.strictEqual(brokenOwnRule(banned).length, 1,
    'the own-rule detector no longer fires on a known-bad sample, so the sweep proves nothing');
  assert.strictEqual(survivingText('still eight rounds here', 'eight rounds', 'nine rounds').length, 1,
    'the surviving-text detector no longer fires on a known-bad sample');
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
