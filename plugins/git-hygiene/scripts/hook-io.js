'use strict';

function readEvent(handler, timeoutMs = 5000) {
  let buffer = '';
  const timer = setTimeout(() => process.exit(0), timeoutMs);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { buffer += chunk; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    try { handler(JSON.parse(buffer)); }
    catch (_) { /* a guard bug must not break an unrelated tool call */ }
    process.exit(0);
  });
}

function block(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

module.exports = { block, readEvent };
