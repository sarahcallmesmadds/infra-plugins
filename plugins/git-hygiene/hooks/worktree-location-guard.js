#!/usr/bin/env node
'use strict';

const { loadPolicy, misplacedTarget } = require('../scripts/worktree-location');

function main(event) {
  const command = event.tool_input && event.tool_input.command;
  if (event.tool_name !== 'Bash' || typeof command !== 'string') return;

  const policy = loadPolicy();
  if (!policy) return;
  const target = misplacedTarget(command, event.cwd, policy);
  if (!target) return;

  const detail = typeof target === 'string'
    ? `The destination is ${target}.`
    : 'The destination uses shell expansion and cannot be checked safely.';
  const reason = `Keep project worktrees in ${policy.worktreeRoot}. ${detail} Use ${policy.worktreeRoot}/<repo>/<task> for this worktree.`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

let input = '';
const timer = setTimeout(() => process.exit(0), 1500);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  clearTimeout(timer);
  try {
    main(JSON.parse(input));
  } catch (_) {
    // A convenience guard must never break the shell when its own input is bad.
  }
  process.exit(0);
});
