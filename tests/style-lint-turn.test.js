#!/usr/bin/env node
// The half of a turn the Stop event does not carry.
//
// Run: node tests/style-lint-turn.test.js
//
// A turn that pauses to run a tool and writes a paragraph first had that
// paragraph read by nobody: the event carries the closing message alone.
// Measured on 2026-08-18 across 651 main-agent turns, 414 wrote something
// before a tool call and 18 carried a hard rule break that nothing caught.
//
// The danger in fixing it is not missing something, it is reporting the wrong
// thing. Widening the source back to the session log is what the guard used to
// do, and it linted the message before the one it was blocking in 70 of 116
// real cases. So the cases below care as much about what is NOT checked, and
// about which text a block names, as about what is caught.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'plugins', 'slop-check', 'hooks', 'style-lint.js');
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-turn-home-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-turn-'));

const DIRTY = 'The build finished — it took four minutes.';
const DIRTY2 = 'One dash — here, and another — there.';
const CLEAN = 'This sentence carries no forbidden punctuation at all, and it runs long enough to avoid the choppy rule.';
// What the hook actually says about an earlier paragraph. It quotes the text,
// and that quotation is what ties the objection to the paragraph.
const OBJECTION_TO_OPENING =
  'Stop hook feedback:\nStyle violation in this turn, in text written earlier in this turn: '
  + '1 em dash. It is not in your closing message, so re-reading that will not find it. '
  + 'The text begins: "' + 'The build finished — it took four minutes.' + '". Rewrite that part.';
const CLEAN2 = 'A different clean sentence, also free of forbidden punctuation and also long enough not to read as choppy.';

let failed = 0, ran = 0;
function check(what, fn) {
  ran += 1;
  try { fn(); console.log(`  ok    ${what}`); }
  catch (e) { failed += 1; console.log(`  FAIL  ${what}`); console.log(`        ${e.message}`); }
}

const user = (text) => ({ type: 'user', message: { content: text } });
const meta = (text) => ({ type: 'user', isMeta: true, message: { content: text } });
const said = (text, extra) => Object.assign(
  { type: 'assistant', message: { content: [{ type: 'text', text }] } }, extra || {});
const toolCall = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } });
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });

function transcript(name, rows) {
  const p = path.join(WORK, name);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function run(event) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(event), encoding: 'utf8', cwd: WORK,
    env: Object.assign({}, process.env, { HOME: FAKE_HOME }),
  });
  return out.trim() ? JSON.parse(out) : null;
}

console.log('style-lint whole turn\n');

// ------------------------------------------------- the gap being closed -----

check('a rule break before a tool call is caught', () => {
  const t = transcript('opening-dirty.jsonl', [
    user('do the thing'), said(DIRTY), toolCall(), toolResult(),
  ]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN, stop_hook_active: false });
  assert.ok(out, 'the opening paragraph went unchecked, which is the whole bug');
  assert.match(out.reason, /em dash/);
});

check('the block names where the text is, and says it is not the closing message', () => {
  const t = transcript('opening-dirty-2.jsonl', [
    user('do the thing'), said(DIRTY), toolCall(), toolResult(),
  ]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN, stop_hook_active: false });
  assert.match(out.reason, /earlier in this turn/);
  assert.match(out.reason, /not in your closing message/);
  // Enough of the text to find it. Without this the writer is told a paragraph
  // somewhere behind them is wrong and left to guess which.
  assert.match(out.reason, /The build finished/);
});

check('a clean turn with prose before a tool call is not blocked', () => {
  // Two DIFFERENT clean strings. With the same one for both, the dedupe drops
  // the earlier copy before anything judges it, and the case passes whether or
  // not earlier prose is checked at all.
  const t = transcript('opening-clean.jsonl', [
    user('do the thing'), said(CLEAN), toolCall(), toolResult(),
  ]);
  assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN2, stop_hook_active: false }), null);

  // Control. The same shape with the opening dirty has to block, or the silence
  // above says only that nothing was ever read.
  const dirty = transcript('opening-clean-control.jsonl', [
    user('do the thing'), said(DIRTY), toolCall(), toolResult(),
  ]);
  assert.ok(run({ hook_event_name: 'Stop', transcript_path: dirty,
    last_assistant_message: CLEAN2, stop_hook_active: false }),
    'the same fixture with a dirty opening did not block either, so this proves nothing');
});

// ------------------------------------------- both halves, counted apart -----

check('two dirty places are listed separately, not added together', () => {
  const t = transcript('both.jsonl', [
    user('do the thing'), said(DIRTY2), toolCall(), toolResult(),
  ]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: DIRTY, stop_hook_active: false });
  assert.ok(out);
  assert.match(out.reason, /2 places/);
  assert.match(out.reason, /earlier in this turn/);
  assert.match(out.reason, /the response just written/);
  // "3 em dashes" with no location is the same failure as naming the wrong one.
  assert.ok(!/3 em dashes/.test(out.reason),
    'the counts were added up, so neither number points anywhere');
});

// ------------------------------------------------ what must NOT change ------

check('a closing-only break still reads exactly as it did before', () => {
  const t = transcript('closing-only.jsonl', [user('do the thing')]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: DIRTY, stop_hook_active: false });
  assert.strictEqual(out.reason,
    'Style violation in the response just written: 1 em dash. Rewrite it now. '
    + 'Replace each em dash with a comma, a period, parentheses, or a restructured clause. '
    + 'Acknowledge it in at most one short line, then give the corrected version. '
    + 'Do not apologise at length or explain the rule.',
    'the common-case wording moved, and the pushback measurements count that sentence');
});

// -------------------------------------------- what must NOT be checked ------

check('the turn before this one is never read', () => {
  // The previous turn is dirty and finished. Reading past the boundary would
  // block someone for writing something they already sent.
  const t = transcript('previous-turn.jsonl', [
    user('first thing'), said(DIRTY),
    user('second thing'), said(CLEAN), toolCall(), toolResult(),
  ]);
  assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN, stop_hook_active: false }), null,
    'a previous turn was linted, which is the fault this hook was rewritten to stop');

  // Control: the same dirty sentence inside the current turn must block.
  const own = transcript('previous-turn-control.jsonl', [
    user('first thing'), said(CLEAN),
    user('second thing'), said(DIRTY), toolCall(), toolResult(),
  ]);
  assert.ok(run({ hook_event_name: 'Stop', transcript_path: own,
    last_assistant_message: CLEAN, stop_hook_active: false }),
    'the same sentence inside this turn was not caught either');
});

check('nothing is checked when the turn start is outside the read window', () => {
  // Over the 1MB window, so the boundary is unreachable. Taking whatever the
  // window happens to begin with is how the previous turn gets blocked.
  //
  // The dirty text has to be INSIDE the window while the turn boundary is
  // outside it, or the case passes because there was nothing to read at all
  // rather than because the guard held. The first version of this fixture put
  // both outside and proved nothing, which a mutation caught.
  const bulk = (n) => Array.from({ length: n }, () => (
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(4096) }] } }));
  const t = transcript('huge-turn.jsonl', [
    user('do the thing'), ...bulk(280), said(DIRTY), ...bulk(4),
  ]);
  assert.ok(fs.statSync(t).size > 1024 * 1024, 'the fixture is not actually over the window');
  const tail = fs.readFileSync(t, 'utf8').slice(-1024 * 1024);
  assert.ok(tail.includes('The build finished'), 'the dirty text is not inside the window, so this proves nothing');
  assert.ok(!tail.includes('do the thing'), 'the turn boundary is inside the window, so this is not the case being tested');
  assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN, stop_hook_active: false }), null);

  // Control: the same rows under the window must block, so the silence above is
  // the window and not the fixture.
  const small = transcript('huge-turn-control.jsonl', [user('do the thing'), said(DIRTY)]);
  assert.ok(run({ hook_event_name: 'Stop', transcript_path: small,
    last_assistant_message: CLEAN, stop_hook_active: false }),
    'the same content inside the window said nothing either');
});

check('an already-blocked opening is not reported a second time', () => {
  // The hook's feedback is isMeta, so it does not start a new turn, and the
  // rewrite sits in this same one. Without this the original is found again and
  // reported as though nothing had been done about it.
  const t = transcript('already-blocked.jsonl', [
    user('do the thing'),
    said(DIRTY),
    toolCall(), toolResult(),
    said(CLEAN),                                   // the turn's closing message
    meta(OBJECTION_TO_OPENING),                    // the block, which lands after it
    said('Fixed. The build finished. It took four minutes.'),
  ]);
  assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN, stop_hook_active: false }), null);

  // Control: the same turn without the feedback row must block.
  const unblocked = transcript('already-blocked-control.jsonl', [
    user('do the thing'), said(DIRTY),
    said('Fixed. The build finished. It took four minutes.'),
    toolCall(), toolResult(),
  ]);
  assert.ok(run({ hook_event_name: 'Stop', transcript_path: unblocked,
    last_assistant_message: CLEAN, stop_hook_active: false }),
    'without the feedback row it still said nothing, so the skip is not what is being tested');
});

check("Claude Code's own API error text is not linted as the writer's prose", () => {
  const t = transcript('api-error.jsonl', [
    user('do the thing'),
    said('API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
      { isApiErrorMessage: true }),
    toolCall(), toolResult(),
  ]);
  assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN, stop_hook_active: false }), null);

  // Control: the identical text without the flag must block, or this case only
  // shows that nothing looked at the row at all.
  const authored = transcript('api-error-control.jsonl', [
    user('do the thing'),
    said('API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.'),
    toolCall(), toolResult(),
  ]);
  assert.ok(run({ hook_event_name: 'Stop', transcript_path: authored,
    last_assistant_message: CLEAN, stop_hook_active: false }),
    'the same words without the flag were ignored too, so the flag is not what is being tested');
});

check('the closing message is not counted twice when the log has caught up', () => {
  const t = transcript('caught-up.jsonl', [user('do the thing'), said(DIRTY)]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: DIRTY, stop_hook_active: false });
  assert.ok(out);
  assert.match(out.reason, /the response just written: 1 em dash/);
  assert.ok(!/2 places/.test(out.reason),
    'the same message was read from both sources and reported as two');

  // Control. A hook that never opened the log would also say one place here, so
  // the fixture has to show the log being read at all: a second dirty message,
  // which only the transcript can supply, has to make it two.
  const two = transcript('caught-up-control.jsonl', [
    user('do the thing'), said(DIRTY2), toolCall(), toolResult(),
  ]);
  const twoOut = run({ hook_event_name: 'Stop', transcript_path: two,
    last_assistant_message: DIRTY, stop_hook_active: false });
  assert.ok(twoOut && /2 places/.test(twoOut.reason),
    'the transcript was never read, so the assertion above is about nothing');
});

check('with no last_assistant_message the old fallback stands alone', () => {
  // The degraded path keeps its old behaviour rather than gaining a
  // half-working version of the new one: with no reliable closing message there
  // is no way to tell it apart from the earlier parts.
  //
  // Two distinct dirty messages, or the case cannot tell the paths apart: with
  // one, it is both the closing message and the only earlier candidate, the
  // dedupe drops it, and the result is identical either way.
  const t = transcript('no-direct.jsonl', [
    user('do the thing'), said(DIRTY2), toolCall(), toolResult(), said(DIRTY),
  ]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t, stop_hook_active: false });
  assert.ok(out, 'the fallback stopped working');
  assert.match(out.reason, /the response just written/);
  assert.ok(!/earlier in this turn/.test(out.reason),
    'the degraded path grew a half-working version of the new one');
  assert.ok(!/places/.test(out.reason));
});


// ------------------------------------- what the first review round found ----

check('a tool result quoting the marker does not silence a real violation', () => {
  // Any grep of this repository prints the marker. Matching it anywhere in a
  // serialised user entry made the guard go quiet on a genuine break, which is
  // worse than never running: it reports nothing and looks like a clean turn.
  const t = transcript('marker-in-tool-result.jsonl', [
    user('do the thing'),
    said(DIRTY),
    toolCall(),
    { type: 'user', message: { content: [{ type: 'tool_result',
      content: 'style-guard.js:  return `Style violation in ${subject}: ...`' }] } },
  ]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN, stop_hook_active: false });
  assert.ok(out, 'a tool result containing the marker suppressed a real violation');
  assert.match(out.reason, /earlier in this turn/);
});

check('a turn that opens and closes with the same sentence reports both', () => {
  // Text is not identity. Dropping every earlier copy that read the same as the
  // closing message named one place while two needed rewriting.
  const t = transcript('repeated.jsonl', [
    user('do the thing'), said(DIRTY), toolCall(), toolResult(),
  ]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: DIRTY, stop_hook_active: false });
  assert.ok(out);
  assert.match(out.reason, /2 places/,
    'the opening copy was dropped for reading the same as the closing one');
});

check('the tail read survives a window that begins mid-character', () => {
  // An em dash is three bytes and the window is a byte offset, so the read can
  // begin inside one. The damaged bytes can only ever land before the first
  // newline, which is what gets dropped. Asserted at every offset rather than
  // argued, because the drop looks removable to anyone tidying this later.
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(JSON.stringify({ type: 'user',
    message: { content: 'padding — with an em dash and a café, line ' + i } }));
  const buf = Buffer.from(rows.join('\n') + '\n', 'utf8');

  let midChar = 0, damaged = 0;
  for (let start = 1; start < buf.length; start++) {
    if ((buf[start] & 0xC0) === 0x80) midChar += 1;
    let text = buf.subarray(start).toString('utf8');
    text = text.slice(text.indexOf('\n') + 1);
    if (text.includes('\uFFFD')) damaged += 1;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { JSON.parse(line); } catch { damaged += 1; }
    }
  }
  assert.ok(midChar > 0, 'no offset landed mid-character, so this proves nothing');
  assert.strictEqual(damaged, 0,
    'a split character survived past the first newline, so a parsed row can carry one');
});


check('a transcript that changes size under the read is not used', () => {
  // A race is not observable from outside the process, so this one case reaches
  // in rather than spawning the hook. Without it the guard is a line of code
  // nothing exercises, which is the shape this repository keeps finding.
  process.env.HOME = FAKE_HOME;
  const guard = require('../plugins/slop-check/scripts/style-guard.js');
  const { loadConfig } = require('../plugins/slop-check/scripts/config.js');

  const t = transcript('race.jsonl', [
    user('do the thing'), said(DIRTY), toolCall(), toolResult(),
  ]);

  const real = fs.fstatSync;
  let calls = 0;
  // The first call sizes the buffer, the second checks the file has not moved.
  fs.fstatSync = function (fd) {
    calls += 1;
    const st = real.call(fs, fd);
    return calls === 2 ? { size: st.size + 1 } : st;
  };
  try {
    const out = guard.blockMessage(CLEAN2, t, loadConfig(), 'the response just written');
    assert.strictEqual(out, null,
      'earlier parts were taken from a transcript that grew under the read, so the '
      + 'window may have ended before this turn began and the walk can land in the last one');
  } finally {
    fs.fstatSync = real;
  }

  // And the same call without the interference still finds it, or the case
  // above passes because nothing was ever going to be found.
  // blockMessage returns the message itself. Only the hook wraps it into the
  // {decision, reason} shape the harness reads, which is why every other case
  // here goes through the subprocess.
  const found = guard.blockMessage(CLEAN2, t, loadConfig(), 'the response just written');
  assert.ok(typeof found === 'string' && /earlier in this turn/.test(found),
    'the undisturbed call found nothing either, so the assertion above proves nothing');
});


check('a delegated conversation is not read as part of this turn', () => {
  // The shape the first Devin round described. A subagent prompt is a
  // plain-string user row, which is exactly what the boundary walk looks for, so
  // without the guard the boundary lands inside the delegation: the subagent's
  // writing is reported against the main agent, and the main agent's own
  // opening paragraph, before the delegation, is never read.
  //
  // Both halves are asserted, because fixing only the attribution and still
  // skipping the real opening would look identical from the outside.
  const t = transcript('sidechain.jsonl', [
    user('do the thing'),
    said(DIRTY),                                   // the main agent's own opening
    toolCall(),                                    // the delegation
    { type: 'user', isSidechain: true, message: { content: 'go and check the repo' } },
    { type: 'assistant', isSidechain: true,
      message: { content: [{ type: 'text', text: 'A helper wrote this — with its own dash.' }] } },
    toolResult(),
  ]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN2, stop_hook_active: false });

  assert.ok(out, "the main agent's own opening paragraph was skipped");
  assert.match(out.reason, /The build finished/,
    "the block did not name the main agent's own text");
  assert.ok(!/A helper wrote this/.test(out.reason),
    'the block quoted a delegated conversation, so it is demanding a rewrite of '
    + 'writing this agent never produced');
});


// ------------------------------- what the second review round found ---------

check('block feedback carried as text blocks is still recognised', () => {
  // isMeta is what draws the line, not the shape of the content. Requiring a
  // plain string meant a host handing the same feedback over as text blocks,
  // which is how the assistant's own messages arrive, went unrecognised, and the
  // paragraph that had just been rewritten was reported all over again.
  const t = transcript('meta-as-blocks.jsonl', [
    user('do the thing'),
    said(DIRTY),
    toolCall(), toolResult(),
    said(CLEAN),
    { type: 'user', isMeta: true, message: { content: [{ type: 'text',
      text: OBJECTION_TO_OPENING }] } },
    said('Fixed. The build finished. It took four minutes.'),
  ]);
  assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN, stop_hook_active: false }), null,
    'the rewritten paragraph was reported again, because the feedback was not recognised');

  // Control: without the feedback row the same turn must block.
  const bare = transcript('meta-as-blocks-control.jsonl', [
    user('do the thing'), said(DIRTY),
    said('Fixed. The build finished. It took four minutes.'),
    toolCall(), toolResult(),
  ]);
  assert.ok(run({ hook_event_name: 'Stop', transcript_path: bare,
    last_assistant_message: CLEAN, stop_hook_active: false }),
    'nothing blocked without the feedback row, so the recognition is untested');
});

check('echoed command output does not act as the start of a turn', () => {
  // 55 of these exist across the session logs on this machine, as ordinary
  // non-isMeta user rows.
  //
  // The consequence is narrower than it first looks, and worth stating exactly.
  // The walk runs backwards and stops at the newest qualifying row, so treating
  // one of these as the boundary moves the start of the turn FORWARD, not back.
  // Nothing from the previous turn can be dragged in. What happens instead is
  // that this turn's own earlier prose falls outside the boundary and is never
  // read, which is the coverage this function exists to add, quietly not
  // happening on any turn that ran a slash command mid-way.
  //
  // So the fixture puts the echoed row AFTER the dirty prose. An earlier version
  // put it before a later real user message, where the walk never reached it,
  // and the case passed with the guard removed.
  const t = transcript('stdout-row.jsonl', [
    user('do the thing'),
    said(DIRTY),                                            // must still be found
    { type: 'user', message: { content: '<local-command-stdout>done</local-command-stdout>' } },
    said(CLEAN), toolCall(), toolResult(),
  ]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN2, stop_hook_active: false });
  assert.ok(out, 'the walk stopped at echoed output, so this turn\'s own opening was skipped');
  assert.match(out.reason, /The build finished/);
});

check('a slash command IS the start of a turn', () => {
  // The other half, and the reason the list above is not copied wholesale from
  // pushback.js. A slash command is the user speaking. Treating it as noise
  // would put the boundary further back and drag in the previous turn.
  const t = transcript('slash.jsonl', [
    user('first thing'),
    said(DIRTY),                                            // the PREVIOUS turn again
    { type: 'user', message: { content: '<command-message>pickup</command-message>' } },
    said(CLEAN), toolCall(), toolResult(),
  ]);
  assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN2, stop_hook_active: false }), null,
    'a slash command stopped acting as a boundary, so the previous turn came with it');

  // Control: dirty prose after the slash command must be caught.
  const own = transcript('slash-control.jsonl', [
    user('first thing'), said(CLEAN),
    { type: 'user', message: { content: '<command-message>pickup</command-message>' } },
    said(DIRTY), toolCall(), toolResult(),
  ]);
  assert.ok(run({ hook_event_name: 'Stop', transcript_path: own,
    last_assistant_message: CLEAN2, stop_hook_active: false }),
    'prose after the slash command was not read');
});


check('an objection naming the closing message does not silence an earlier one', () => {
  // The other half of matching by quotation. A block about the closing message
  // says nothing about a paragraph three tool calls back, and treating any
  // objection in the turn as covering everything in it would let a real break
  // through on the strength of an unrelated one.
  const t = transcript('objection-elsewhere.jsonl', [
    user('do the thing'),
    said(DIRTY),                                   // never objected to
    toolCall(), toolResult(),
    said('An earlier closing attempt.'),
    meta('Stop hook feedback: Style violation in the response just written: 1 em dash. '
      + 'Rewrite it now.'),
    said('A corrected closing attempt.'),
  ]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN2, stop_hook_active: false });
  assert.ok(out, 'an objection about the closing message silenced an unrelated paragraph');
  assert.match(out.reason, /The build finished/);
});

check('machinery carried as text blocks does not start a turn', () => {
  // 155 interrupt notices on this machine arrive as text blocks rather than as
  // plain strings, so a check that only looked at strings saw none of them and
  // reported the shape as absent. That is how the first version of this passed.
  const t = transcript('machinery-blocks.jsonl', [
    user('do the thing'),
    said(DIRTY),
    { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    said(CLEAN), toolCall(), toolResult(),
  ]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN2, stop_hook_active: false });
  assert.ok(out, 'an interrupt notice acted as the start of the turn, so the opening was skipped');
  assert.match(out.reason, /The build finished/);
});

check('a bash echo row does not start a turn either', () => {
  const t = transcript('bash-row.jsonl', [
    user('do the thing'),
    said(DIRTY),
    { type: 'user', message: { content: '<bash-input>ls</bash-input>' } },
    said(CLEAN), toolCall(), toolResult(),
  ]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN2, stop_hook_active: false });
  assert.ok(out, 'a bash echo row acted as the start of the turn');
  assert.match(out.reason, /The build finished/);
});


check('a row that speaks and calls a tool at once is not the closing message', () => {
  // An assistant row can carry text and a tool_use together. Nothing follows the
  // row, so a check that only looked at later rows called the text the closing
  // message and skipped it, which is a hard rule break going out unread.
  //
  // Nothing after the row, or a trailing tool result cancels the candidate on
  // its own and the fix is never reached. And the closing message has to match
  // the row's text, because that is the only condition under which the row
  // would be dropped as a duplicate. The first version of this had both wrong
  // and passed with the fix removed.
  const t = transcript('text-and-tool.jsonl', [
    user('do the thing'),
    { type: 'assistant', message: { content: [
      { type: 'text', text: DIRTY }, { type: 'tool_use', name: 'Bash' }] } },
  ]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: DIRTY, stop_hook_active: false });
  assert.ok(out, 'nothing was reported at all');
  assert.match(out.reason, /2 places/,
    'the text was taken for the closing message, so the paragraph that also '
    + 'called a tool went unread');
});

check('the degraded path does not blame this agent for a delegated message', () => {
  // With no last_assistant_message there is no turn to bound, so the newest
  // assistant row is taken as the text. If that row belongs to a subagent, the
  // block names the wrong writer. The guard for this went into earlierParts a
  // round earlier and was missed here, which is why it was found twice.
  const t = transcript('sidechain-fallback.jsonl', [
    user('do the thing'),
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text',
      text: 'A helper wrote this — with its own dash.' }] } },
  ]);
  assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: t,
    stop_hook_active: false }), null,
    'the fallback blocked this agent for a delegated conversation');

  // Control: the same row without the flag must block, or the silence above is
  // just the fallback not working.
  const own = transcript('sidechain-fallback-control.jsonl', [
    user('do the thing'),
    said('A helper wrote this — with its own dash.'),
  ]);
  assert.ok(run({ hook_event_name: 'Stop', transcript_path: own,
    stop_hook_active: false }), 'the fallback found nothing either');
});

check('a window that begins exactly on a line start keeps that line', () => {
  // The drop that removes a partial first line was removing a whole good one
  // whenever the cut landed on a line boundary. When that line is the start of
  // the turn, the turn then has no start and nothing is checked at all.
  //
  // The alignment is constructed rather than searched for. The window begins at
  // size - 1MB, so it begins exactly at the turn's first byte when everything
  // from that row onwards is exactly 1MB. An earlier version of this case tried
  // to solve for it with arithmetic, failed, and reported itself as passing
  // while printing that it had not run.
  const WINDOW = 1024 * 1024;
  const enc = (r) => JSON.stringify(r) + '\n';
  const turn = [user('do the thing'), said(DIRTY), toolCall(), toolResult()];
  let bytes = turn.reduce((n, r) => n + Buffer.byteLength(enc(r), 'utf8'), 0);

  // Pad the turn out to exactly one window, with tool results, which are inert.
  const rows = [...turn];
  const chunk = (n) => ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(n) }] } });
  while (WINDOW - bytes > 5000) {
    rows.push(chunk(4096));
    bytes += Buffer.byteLength(enc(chunk(4096)), 'utf8');
  }
  // One last row sized so the total lands on the window exactly.
  const overhead = Buffer.byteLength(enc(chunk(0)), 'utf8');
  const need = WINDOW - bytes - overhead;
  assert.ok(need >= 0, 'could not pad the turn to exactly one window');
  rows.push(chunk(need));

  // Anything at all in front, so the window does not simply start at zero.
  const t = transcript('edge-aligned.jsonl', [user('an earlier turn'), said(CLEAN), ...rows]);

  const size = fs.statSync(t).size;
  const edge = size - WINDOW;
  const buf = fs.readFileSync(t);
  assert.ok(edge > 0, 'the file is not larger than the window, so nothing is cut');
  assert.strictEqual(buf[edge - 1], 0x0a,
    'the window edge did not land on a line start, so this case is not exercising the fix');

  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN2, stop_hook_active: false });
  assert.ok(out, 'the turn start was dropped with the partial line, so the turn had no start');
  assert.match(out.reason, /The build finished/);
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
