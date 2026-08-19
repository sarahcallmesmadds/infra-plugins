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
  const t = transcript('opening-clean.jsonl', [
    user('do the thing'), said(CLEAN), toolCall(), toolResult(),
  ]);
  assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: t,
    last_assistant_message: CLEAN, stop_hook_active: false }), null);
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

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
