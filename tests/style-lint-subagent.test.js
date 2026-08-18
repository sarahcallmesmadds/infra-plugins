#!/usr/bin/env node
// The style guard on the surface nothing was watching: what a subagent returns.
//
// Run: node tests/style-lint-subagent.test.js
//
// These spawn the hooks as subprocesses and assert on the bytes they write,
// for the reason bash-guard.test.js gives: a verdict reached correctly and
// then written in a shape the harness ignores is a guard that blocks nothing,
// and importing the logic directly cannot see that.
//
// The case this file exists for is `agent_transcript_path`. A SubagentStop
// event carries two transcript paths: `transcript_path` for the session the
// subagent was launched from, and `agent_transcript_path` for the subagent's
// own. Reading the first is not a crash and not an empty result. It is real
// prose by a different writer, linted and reported as the subagent's, which is
// the same class of fault as the one that made this hook read the event
// directly in the first place. hook-event-shape.test.js cannot catch it,
// because both fields are genuinely present on the event: swapping them passed
// all 50 suites before this file was written.
//
// HOME is redirected to an empty directory so these describe the shipped
// defaults rather than whatever config sits on the machine running them.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SUBAGENT_HOOK = path.join(__dirname, '..', 'plugins', 'slop-check', 'hooks', 'style-lint-subagent.js');
const STOP_HOOK = path.join(__dirname, '..', 'plugins', 'slop-check', 'hooks', 'style-lint.js');
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-home-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-work-'));

const DIRTY = 'This sentence carries an em dash — right here in the middle.';
const CLEAN = 'This sentence carries no forbidden punctuation at all, and it runs long enough to avoid the choppy rule.';

let failed = 0;
let ran = 0;
function check(what, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL  ${what}`);
    console.log(`        ${e.message}`);
  }
}

// A transcript in the shape the walk expects: one JSON object per line.
function writeTranscript(name, entries) {
  const p = path.join(WORK, name);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}
function assistantSaying(text, extra) {
  return Object.assign({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  }, extra || {});
}

function run(hook, event) {
  const stdout = execFileSync(process.execPath, [hook], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    cwd: WORK,
    env: Object.assign({}, process.env, { HOME: FAKE_HOME }),
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

console.log('style-lint-subagent\n');

// -------------------------------------------------- the direct field --------

check('a subagent report with an em dash is blocked', () => {
  const out = run(SUBAGENT_HOOK, {
    hook_event_name: 'SubagentStop',
    last_assistant_message: DIRTY,
    stop_hook_active: false,
  });
  assert.ok(out, 'hook stayed silent on a report breaking a hard rule');
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /em dash/);
});

check('the block addresses a report, not a response', () => {
  const out = run(SUBAGENT_HOOK, {
    hook_event_name: 'SubagentStop',
    last_assistant_message: DIRTY,
    stop_hook_active: false,
  });
  // Wording matters here: blocking SubagentStop sends the subagent back, so
  // the sentence is read by whoever wrote the report. Calling it "the response
  // just written" describes something the reader did not write.
  assert.match(out.reason, /the report just written/);
});

check('a clean subagent report is not blocked', () => {
  assert.strictEqual(run(SUBAGENT_HOOK, {
    hook_event_name: 'SubagentStop',
    last_assistant_message: CLEAN,
    stop_hook_active: false,
  }), null);
});

check('stop_hook_active suppresses the block, so a rewrite cannot loop', () => {
  assert.strictEqual(run(SUBAGENT_HOOK, {
    hook_event_name: 'SubagentStop',
    last_assistant_message: DIRTY,
    stop_hook_active: true,
  }), null);
});

// ---------------------------------------- which transcript the walk reads ----

check('the fallback reads the subagent transcript, not the session transcript', () => {
  // The session's last message is dirty; the subagent's is clean. Reading the
  // wrong one blocks a subagent for prose the main agent wrote.
  const session = writeTranscript('session-dirty.jsonl', [assistantSaying(DIRTY)]);
  const agent = writeTranscript('agent-clean.jsonl', [assistantSaying(CLEAN)]);
  const out = run(SUBAGENT_HOOK, {
    hook_event_name: 'SubagentStop',
    transcript_path: session,
    agent_transcript_path: agent,
    stop_hook_active: false,
    // last_assistant_message deliberately absent, which is what puts the walk
    // in play at all.
  });
  assert.strictEqual(out, null,
    'blocked on the session transcript, so the hook linted the wrong writer');
});

check('the fallback still catches a dirty subagent transcript', () => {
  // The mirror of the case above. Without it, a hook that reads no transcript
  // at all would pass the previous check for the wrong reason.
  const session = writeTranscript('session-clean.jsonl', [assistantSaying(CLEAN)]);
  const agent = writeTranscript('agent-dirty.jsonl', [assistantSaying(DIRTY)]);
  const out = run(SUBAGENT_HOOK, {
    hook_event_name: 'SubagentStop',
    transcript_path: session,
    agent_transcript_path: agent,
    stop_hook_active: false,
  });
  assert.ok(out, 'the walk found nothing in the subagent transcript');
  assert.strictEqual(out.decision, 'block');
});

check('an empty direct field is not a reason to walk the transcript', () => {
  // Present and empty means the subagent ended without prose. Falling back
  // there blocks an older message under a sentence reading "just written".
  const agent = writeTranscript('agent-older-dirty.jsonl', [assistantSaying(DIRTY)]);
  assert.strictEqual(run(SUBAGENT_HOOK, {
    hook_event_name: 'SubagentStop',
    last_assistant_message: '',
    agent_transcript_path: agent,
    stop_hook_active: false,
  }), null);
});

check("Claude Code's own API error text is not linted as the subagent's prose", () => {
  // The host's 500 and 529 strings contain an em dash. Linting one blocks a
  // report for wording nobody involved can reach. These were 7 of 12 apparent
  // misses when the two coverage gaps were re-measured on 2026-08-18.
  const agent = writeTranscript('agent-api-error.jsonl', [
    assistantSaying(CLEAN),
    assistantSaying('API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
      { isApiErrorMessage: true }),
  ]);
  assert.strictEqual(run(SUBAGENT_HOOK, {
    hook_event_name: 'SubagentStop',
    agent_transcript_path: agent,
    stop_hook_active: false,
  }), null);
});

// ------------------------------------------------ the Stop hook is intact ----

check('the Stop hook still addresses a response and reads the session transcript', () => {
  const out = run(STOP_HOOK, {
    hook_event_name: 'Stop',
    last_assistant_message: DIRTY,
    stop_hook_active: false,
  });
  assert.ok(out, 'the Stop hook stopped blocking');
  assert.match(out.reason, /the response just written/);
});

check('the Stop hook falls back to transcript_path', () => {
  const session = writeTranscript('stop-dirty.jsonl', [assistantSaying(DIRTY)]);
  const out = run(STOP_HOOK, {
    hook_event_name: 'Stop',
    transcript_path: session,
    stop_hook_active: false,
  });
  assert.ok(out, 'the Stop fallback stopped reading transcript_path');
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
