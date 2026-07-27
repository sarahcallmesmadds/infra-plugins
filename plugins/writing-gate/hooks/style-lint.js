#!/usr/bin/env node
// Stop hook. Reads the assistant's own last turn and blocks it if it contains
// a hard tell, forcing a rewrite before the turn is allowed to end.
//
// Only the hard rules are enforced here. The soft signals in tells.js are
// aggregate evidence about a body of text, and blocking a turn on a single
// "leverage" would be both wrong and infuriating.

'use strict';

const fs = require('fs');
const path = require('path');

const { checkHard } = require(path.join(__dirname, '..', 'scripts', 'tells.js'));
const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'config.js'));

(async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // Already inside a forced continuation. Blocking again would loop forever.
  if (payload.stop_hook_active) process.exit(0);

  const config = loadConfig();
  if (config.enforce === false) process.exit(0);

  const transcript = payload.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) process.exit(0);

  let lines;
  try {
    lines = fs.readFileSync(transcript, 'utf8').trim().split('\n');
  } catch {
    process.exit(0);
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

  if (!latest) process.exit(0);

  const { ok, violations } = checkHard(latest, config);
  if (ok) process.exit(0);

  const found = violations.map((v) => v.what).join(', and ');
  const reason =
    `Style violation in the response just written: ${found}. ` +
    `Em dashes and runs of very short sentences are banned outright here. ` +
    `Rewrite the response now. Replace each em dash with a comma, a period, ` +
    `parentheses, or a restructured clause, and vary the sentence lengths. ` +
    `Acknowledge it in at most one short line, then give the corrected response. ` +
    `Do not apologise at length or explain the rule.`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
})();
