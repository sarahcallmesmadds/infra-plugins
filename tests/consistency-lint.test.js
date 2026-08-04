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
  staleCounts, survivingText, brokenOwnRule, replacedFragments, isDistinctive,
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

check('an estimate is not a count', () => {
  for (const hedge of ['up to', 'about', 'at least', 'roughly', 'around']) {
    const text = [`It shows ${hedge} 8 options:`, '', '- a', '- b'].join('\n');
    assert.deepStrictEqual(staleCounts(text).filter((c) => !c.ok), [],
      `"${hedge} 8 options" was treated as an exact claim`);
  }
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
