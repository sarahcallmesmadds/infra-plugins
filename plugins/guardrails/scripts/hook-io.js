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

// Put the decision to the user and tell them why. PreToolUse only, same as
// `block`, and the difference between the two is who gets to answer.
//
// `deny` ends the question. It is right where the guard knows a better command
// and can name it, so the reason reads as an instruction: branch first, fix the
// message, then carry on.
//
// `ask` is right where the guard cannot know. "This deletes a branch even if it
// was never merged" is a fact about the command, not a verdict on whether the
// user wants it, and the person typing it is the only one who can settle that.
// Every one of those reasons ended with "confirm this is intended before
// running it" while arriving as a `deny`, which offers a confirmation the shape
// cannot accept. The command was then unreachable through the tool at all, and
// the way past it was to leave the session and run it by hand, which is worse
// than either answer: the guard stopped being a checkpoint and became something
// to walk around.
function confirm(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
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

module.exports = { readEvent, block, confirm, advise };
