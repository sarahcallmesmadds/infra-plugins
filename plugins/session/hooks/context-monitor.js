#!/usr/bin/env node
// PostToolUse: say out loud how full the context is, when it matters.
//
// The status line receives the context window on every render and the model
// receives nothing, so the person watching the terminal can see the bar fill
// while the assistant deciding whether to open six more files has no idea.
// The status line writes the number to a file and this reads it back.
//
// Runs after every tool call, so it has to be close to free. It reads one small
// file, decides, and usually says nothing. No process is spawned and no network
// is touched.
//
// The logic lives in scripts/context.js so the debounce and the escalation rule
// can be tested without matching on prose.

'use strict';

const path = require('path');

const STDIN_WAIT_MS = 1000;

function main(event) {
  const ctx = require(path.join(__dirname, '..', 'scripts', 'context.js'));
  const config = require(path.join(__dirname, '..', 'scripts', 'config.js')).load();
  const cfg = { ...ctx.DEFAULTS, ...(config.contextWarnings || {}) };

  if (config.contextWarnings && config.contextWarnings.enabled === false) return;

  const sessionId = event && event.session_id;
  if (!ctx.safeSessionId(sessionId)) return;

  const reading = ctx.readBridge(sessionId, { staleSeconds: cfg.staleSeconds });
  // No reading means the status line is not installed, or has not rendered yet,
  // or stopped. All three are "we do not know", and a warning invented from no
  // data is worse than no warning.
  if (!reading) return;

  const state = ctx.readState(sessionId);
  const verdict = ctx.decide({ remaining: reading.remaining_percentage, state, config: cfg });

  ctx.writeState(sessionId, verdict.state);
  if (!verdict.speak) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: ctx.message({
        level: verdict.level,
        usedPct: reading.used_pct,
        remaining: reading.remaining_percentage,
      }),
    },
  }));
}

function run() {
  const timer = setTimeout(() => process.exit(0), STDIN_WAIT_MS);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buffer += c; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    try {
      main(buffer ? JSON.parse(buffer) : {});
    } catch (_) {
      // Never surface a bug here as a failed tool call. This runs after every
      // single tool use, so anything that throws would break everything.
    }
    process.exit(0);
  });
}

if (require.main === module) run();

module.exports = { main };
