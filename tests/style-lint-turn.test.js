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
  assert.match(out.reason, /before a tool call/);
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
  assert.match(out.reason, /before a tool call/);
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
});

check('an already-blocked opening is not reported a second time', () => {
  // The hook's feedback is isMeta, so it does not start a new turn, and the
  // rewrite sits in this same one. Without this the original is found again and
  // reported as though nothing had been done about it.
  const t = transcript('already-blocked.jsonl', [
    user('do the thing'),
    said(DIRTY),
    meta('Stop hook feedback: Style violation in the response just written: 1 em dash.'),
    said('Fixed. The build finished. It took four minutes.'),
    toolCall(), toolResult(),
  ]);
  assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN, stop_hook_active: false }), null);
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
});

check('the closing message is not counted twice when the log has caught up', () => {
  const t = transcript('caught-up.jsonl', [user('do the thing'), said(DIRTY)]);
  const out = run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: DIRTY, stop_hook_active: false });
  assert.ok(out);
  assert.match(out.reason, /the response just written: 1 em dash/);
  assert.ok(!/2 places/.test(out.reason),
    'the same message was read from both sources and reported as two');
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
  assert.ok(!/before a tool call/.test(out.reason),
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
  assert.match(out.reason, /before a tool call/);
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
  assert.ok(typeof found === 'string' && /before a tool call/.test(found),
    'the undisturbed call found nothing either, so the assertion above proves nothing');
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
