// Shared stdin/stdout plumbing for the build-loop hooks.
//
// A copy rather than an import. guardrails and slop-check each carry their own,
// for the same reason: a plugin that reaches into a sibling plugin's scripts/
// stops being installable on its own.
//
// Every hook here fails open. A check that crashes the session is worse than a
// check that misses something, so any error path exits 0 and stays quiet.

'use strict';

// Reads the hook event JSON from stdin and hands it to `handler`.
// Exits 0 on any parse failure, timeout, or thrown error.
function readEvent(handler, timeoutMs = 5000) {
  let buffer = '';
  const timer = setTimeout(() => process.exit(0), timeoutMs);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { buffer += chunk; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    try {
      handler(JSON.parse(buffer));
    } catch (_) {
      // Never surface a hook bug as a broken tool call.
    }
    process.exit(0);
  });
}

// Add a note to the conversation without stopping anything.
//
// The shape matters and is not guessable: an unrecognised payload is dropped
// without a word, so a hook can reach the right verdict, print it, and change
// nothing. guardrails shipped that bug through 0.2.0. `additionalContext` is
// what reaches the model, which is the point here, because the model is what
// just wrote the file and what can fix it.
function advise(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext },
  }));
}

module.exports = { readEvent, advise };
