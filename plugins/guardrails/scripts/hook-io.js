// Shared stdin/stdout plumbing for the Claude Code hooks.
//
// Every hook here fails open. A guard that crashes the session is worse than a
// guard that misses something, so any error path exits 0 and stays quiet.

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

// Stop a tool call and tell the model why. PreToolUse only, which is the only
// event that can stop anything and the only caller here.
//
// This used to emit a top-level `{ decision: 'block', reason }`. PreToolUse
// does not read that. It reads hookSpecificOutput.permissionDecision, and an
// unrecognised shape is ignored without a word, so through 0.2.0 every guard
// reached the right verdict, printed it, and watched the command run anyway.
// Nothing failed loudly, which is why it survived a full test suite.
function block(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

// Add a note to the conversation without stopping anything.
function advise(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext },
  }));
}

module.exports = { readEvent, block, advise };
