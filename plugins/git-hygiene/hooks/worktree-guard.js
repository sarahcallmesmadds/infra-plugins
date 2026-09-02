#!/usr/bin/env node
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { block, readEvent } = require(path.join(ROOT, 'scripts', 'hook-io'));
const { loadConfig } = require(path.join(ROOT, 'scripts', 'worktree-config'));
const { decisionFor } = require(path.join(ROOT, 'scripts', 'worktree-command'));

const ROUTES = {
  add: 'create',
  move: 'relocate',
  remove: 'cleanup',
  prune: 'cleanup',
  lock: 'activate',
  unlock: 'finish',
};

readEvent((event) => {
  if (!event || event.tool_name !== 'Bash') return;
  const command = (event.tool_input && event.tool_input.command) || '';
  if (!command) return;

  const config = loadConfig();
  if (!config.exists) return;
  if (config.valid && !config.enforceWorktreeRoot) return;
  const decision = decisionFor(command, { cwd: event.cwd || process.cwd() });
  if (!decision) return;
  if (!config.valid) {
    block(`Git Hygiene could not validate ${config.file}, so it refused a direct mutating worktree command. Run /git-hygiene:setup to repair the configuration.`);
    return;
  }
  const route = ROUTES[decision.action] || 'status';
  block(`${decision.reason}. Run /git-hygiene:worktree-hygiene ${route} instead.`);
});
