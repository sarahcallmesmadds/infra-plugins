#!/usr/bin/env node
// Stop hook. Reads the assistant's own last turn and blocks it if it contains
// a hard tell, forcing a rewrite before the turn is allowed to end.
//
// Only the hard rules are enforced here. The soft signals in tells.js are
// aggregate evidence about a body of text, and blocking a turn on a single
// "leverage" would be both wrong and infuriating.
//
// The judging, the wording and the transcript walk live in scripts/style-guard.js,
// shared with style-lint-subagent.js. What stays here is every read of the
// event, deliberately: hook-event-shape.test.js checks those reads against a
// captured Stop event, and a read moved out of this file is a read it cannot
// check.
//
// Fails open throughout. A guard that breaks a session is worse than a guard
// that misses something, so every error path exits quietly.

'use strict';

const path = require('path');

const { readEvent, block } = require(path.join(__dirname, '..', 'scripts', 'hook-io.js'));
const { blockMessage } = require(path.join(__dirname, '..', 'scripts', 'style-guard.js'));
const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'config.js'));

readEvent((payload) => {
  // Already inside a forced continuation. Blocking again would loop forever.
  if (payload.stop_hook_active) return;

  // `transcript_path` is this session's own, which on a Stop event is the only
  // one there is. The subagent hook has to choose between two and does not
  // get to copy this line.
  const message = blockMessage(
    payload.last_assistant_message,
    payload.transcript_path,
    loadConfig(),
    'the response just written'
  );

  if (message) block(message);
});
