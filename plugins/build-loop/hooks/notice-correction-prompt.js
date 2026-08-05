#!/usr/bin/env node
// notice-correction-prompt.js — UserPromptSubmit.
//
// /flag-issue only runs when somebody remembers to type it, so the queue holds
// the corrections that were noticed and nothing else. This is half the
// noticing. It suggests, it never writes, and it never blocks.
//
// The other half is notice-correction-stop.js, which catches the corrections
// that only become clear after the answer. Both read scripts/corrections.js,
// so what counts as a correction is decided once.
//
// The field is `prompt`. The published field list calls it `user_prompt`, and
// that name reads as undefined on every event, so the hook would have gone
// quiet and looked healthy, which is the same failure the injection scanner
// shipped with. tests/fixtures/hook-events/UserPromptSubmit.json is a live
// capture and is what the test asserts against.

'use strict';

const { readEvent, advise } = require('../scripts/hook-io.js');
const { SAID_IT_WAS_WRONG, SUGGESTION, looksLikeCorrection } = require('../scripts/corrections.js');

readEvent((event) => {
  if (looksLikeCorrection(event.prompt, SAID_IT_WAS_WRONG)) {
    advise('UserPromptSubmit', SUGGESTION);
  }
});
