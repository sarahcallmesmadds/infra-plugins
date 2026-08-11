#!/usr/bin/env node
// Opens a lease when an owning skill is typed as a slash command.
//
// This is the case the gate was wrong about for its whole life. The lease was
// written only on the Skill tool, and typing `/session:wrap` produces no tool
// call at all, so no lease was written and the guard then refused the one
// caller it holds the directory for. Leases from earlier sessions existed only
// because those wraps happened to go through the tool instead.
//
// The prompt arrives as the raw typed line, `"/session:wrap"`, verified by
// capturing a real UserPromptSubmit event rather than assuming the shape. A
// command that does not resolve never reaches here, because Claude Code rejects
// it before any hook runs.
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { readEvent } = require(path.join(ROOT, 'scripts', 'hook-io'));
const {
  loadRegistry, ownerFromPrompt, ownerNames, writeLease,
} = require(path.join(ROOT, 'scripts', 'resource-ownership'));

readEvent((event) => {
  const sessionId = event.session_id;
  if (!sessionId) return;

  const owners = ownerNames(loadRegistry(ROOT));
  if (!owners.size) return;

  const owner = ownerFromPrompt(event.prompt, owners);
  if (owner) writeLease(owner, sessionId);
});
