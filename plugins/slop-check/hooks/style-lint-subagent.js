#!/usr/bin/env node
// SubagentStop hook. The same hard rules, applied to what a subagent hands back.
//
// Why this is a second file rather than the Stop hook wired to a second event:
// the two events carry different transcript fields. Stop has `transcript_path`.
// SubagentStop has `transcript_path` too, pointing at the *main* session, and
// `agent_transcript_path` beside it for the subagent's own. One file reading
// both would read a field that does not exist on Stop, which hook-event-shape
// refuses, and its fallback would have linted the main session's last message
// and told a subagent to rewrite prose it never wrote.
//
// Blocking here prevents the subagent from stopping, which is what sends it
// back to rewrite its report before the main agent ever sees it. Confirmed
// against the documented exit-code behaviour, and `stop_hook_active` is present
// on this event too, so the loop guard below is the same one Stop uses rather
// than a hopeful copy.
//
// Measured before it was written: of the subagent reports on this machine since
// slop-check 0.4.2, four of five broke a hard rule and none were caught, each
// carrying 24 to 34 em dashes against one for a typical main-agent break. A
// subagent's report is often the whole substance of an answer, so this was the
// longest writing in a session going out unread.
//
// Fails open throughout, like the Stop hook.

'use strict';

const path = require('path');

const { readEvent, block } = require(path.join(__dirname, '..', 'scripts', 'hook-io.js'));
const { blockMessage } = require(path.join(__dirname, '..', 'scripts', 'style-guard.js'));
const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'config.js'));

readEvent((payload) => {
  // Already inside a forced continuation. Blocking again would loop forever.
  if (payload.stop_hook_active) return;

  // The subagent's own transcript, never the session's. Getting this wrong is
  // silent: the walk would return real prose from the wrong writer, and the
  // block would read as a true finding.
  const message = blockMessage(
    payload.last_assistant_message,
    payload.agent_transcript_path,
    loadConfig(),
    'the report just written'
  );

  if (message) block(message);
});
