#!/usr/bin/env node
// Stop hook. Reads the assistant's own last turn and blocks it if it contains
// a hard tell, forcing a rewrite before the turn is allowed to end.
//
// Only the hard rules are enforced here. The soft signals in tells.js are
// aggregate evidence about a body of text, and blocking a turn on a single
// "leverage" would be both wrong and infuriating.
//
// Fails open throughout. A guard that breaks a session is worse than a guard
// that misses something, so every error path exits quietly.

'use strict';

const fs = require('fs');
const path = require('path');

const { readEvent, block } = require(path.join(__dirname, '..', 'scripts', 'hook-io.js'));
const { checkHard } = require(path.join(__dirname, '..', 'scripts', 'tells.js'));
const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'config.js'));

// What to tell the model, matched to what was actually found. An artefact left
// in the text needs deleting, not rephrasing, so the em dash advice would be
// nonsense for it.
function remedyFor(violations) {
  const names = new Set(violations.map((v) => v.name));
  const parts = [];

  if (names.has('em-dash')) {
    parts.push('Replace each em dash with a comma, a period, parentheses, or a restructured clause.');
  }
  if (names.has('choppy-run')) {
    parts.push('Break up the run of very short sentences by joining or expanding them, and vary the lengths.');
  }
  if (names.has('tool-artefact')) {
    parts.push('Delete the leftover generation artefacts. They are not prose and should never have been in the output.');
  }
  if (names.has('house-rule')) {
    // No parenthetical naming the phrase. The caller below already opens with
    // every violation's `what`, and this one's `what` is itself the sentence
    // "phrases ruled out for this author (worth stealing)". Interpolating it
    // again nested that whole sentence inside these brackets, so the writer was
    // handed the same wording twice in one message, the second time inside its
    // own parentheses. The other three remedies say what to do and leave the
    // naming to the opening sentence, which is the shape that reads.
    parts.push(
      'Remove the phrase this author has ruled out, named above. '
      + 'Say the thing plainly instead. This is a standing instruction rather than a style preference, so rephrasing around it is the fix, not softening it.'
    );
  }
  return parts.join(' ');
}

// The fallback, and formerly the only path. Walk back to the most recent
// assistant message that actually said something. Tool calls and empty turns
// are not prose.
function fromTranscript(transcript) {
  if (!transcript || !fs.existsSync(transcript)) return '';

  let lines;
  try {
    lines = fs.readFileSync(transcript, 'utf8').trim().split('\n');
  } catch {
    return '';
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const content = entry.message && entry.message.content;
    if (!content) continue;
    const text = Array.isArray(content)
      ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      : String(content);
    if (text.trim()) return text.trim();
  }
  return '';
}

// The turn that just ended.
//
// The event carries it directly as `last_assistant_message`. The transcript
// does not, and asking the transcript was the bug: the file is written a beat
// behind the conversation, so at Stop time the finished turn is usually not in
// it yet and the walk lands on the message before. The guard then blocked a
// clean turn for the previous one's count, while the turn that really broke the
// rule went out unchecked.
//
// Measured on 2026-08-15 over 116 real blocks in the saved sessions: 70 linted
// the wrong text. A live probe over five firings found the event correct every
// time and the transcript short every time. On one firing the hook saw 11 lines
// and 66794 bytes of a file that ends at 14 lines and 68998 bytes, with the
// reply stamped 60ms before the read and still not written.
//
// The walk stays as a fallback. `last_assistant_message` is captured in
// tests/fixtures/hook-events/Stop.json and hook-event-shape.test.js checks this
// read against it, but it is not a contract anyone published, so if it goes
// away the guard degrades to its old behaviour rather than to nothing.
function finishedTurn(payload) {
  const direct = payload.last_assistant_message;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return fromTranscript(payload.transcript_path);
}

readEvent((payload) => {
  // Already inside a forced continuation. Blocking again would loop forever.
  if (payload.stop_hook_active) return;

  const config = loadConfig();
  if (config.enforce === false) return;

  const latest = finishedTurn(payload);
  if (!latest) return;

  // Guarded: this is pure string work, but a guard that is supposed to never
  // break a session must not be the thing that throws.
  let result;
  try {
    result = checkHard(latest, config);
  } catch {
    return;
  }

  if (result.ok) return;

  const found = result.violations.map((v) => v.what).join(', and ');
  block(
    `Style violation in the response just written: ${found}. ` +
    `Rewrite the response now. ${remedyFor(result.violations)} ` +
    `Acknowledge it in at most one short line, then give the corrected response. ` +
    `Do not apologise at length or explain the rule.`
  );
});
