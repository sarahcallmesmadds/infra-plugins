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
    const listed = violations.find((v) => v.name === 'house-rule');
    parts.push(
      `Remove the phrase this author has ruled out (${listed ? listed.what : 'see the finding'}). `
      + 'Say the thing plainly instead. This is a standing instruction rather than a style preference, so rephrasing around it is the fix, not softening it.'
    );
  }
  return parts.join(' ');
}

readEvent((payload) => {
  // Already inside a forced continuation. Blocking again would loop forever.
  if (payload.stop_hook_active) return;

  const config = loadConfig();
  if (config.enforce === false) return;

  const transcript = payload.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) return;

  let lines;
  try {
    lines = fs.readFileSync(transcript, 'utf8').trim().split('\n');
  } catch {
    return;
  }

  // Walk back to the most recent assistant message that actually said
  // something. Tool calls and empty turns are not prose.
  let latest = '';
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
    if (text.trim()) {
      latest = text.trim();
      break;
    }
  }

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
