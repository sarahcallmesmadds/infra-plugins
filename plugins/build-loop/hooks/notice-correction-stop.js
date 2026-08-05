#!/usr/bin/env node
// notice-correction-stop.js — Stop.
//
// The other half of the noticing. Some corrections only become clear after the
// answer: the prompt was an ordinary question, and the turn ends "you're
// right, the hook should not have done that". That is a defect report, and the
// prompt hook cannot see it.
//
// Reads `last_assistant_message` straight off the event. It does not walk the
// transcript, and that is deliberate rather than incidental: slop-check's Stop
// hook does walk it, lands on the previous turn because the one that just
// ended is not written there yet, and reports a violation against a turn that
// does not contain it. Queue entry 2026-08-05T14-33-26-style-lint has the
// detail. The field is on the payload, so there is nothing to look up.
//
// `stop_hook_active` is on the payload too, which the published field list
// denies. It is the loop guard, so believing the docs over the capture would
// have been the expensive way to be wrong.

'use strict';

const { readEvent, advise } = require('../scripts/hook-io.js');
const { ADMITTED_IT_WAS_WRONG, SUGGESTION, looksLikeCorrection } = require('../scripts/corrections.js');

readEvent((event) => {
  // First, before anything else. A Stop hook that speaks into a stop it has
  // already interrupted is the shape that runs forever. This hook never
  // blocks, so the loop is unlikely rather than impossible, and unlikely is
  // not a reason to leave the check out.
  if (event.stop_hook_active) return;

  if (looksLikeCorrection(event.last_assistant_message, ADMITTED_IT_WAS_WRONG)) {
    advise('Stop', SUGGESTION);
  }
});
