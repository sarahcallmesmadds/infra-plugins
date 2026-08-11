#!/usr/bin/env node
// Opens a lease when an owning skill is invoked as a tool call.
//
// Its pair, resource-owner-lease-prompt.js, does the same for a skill typed as
// a slash command. They are two files rather than one with a branch because
// tests/hook-event-shape.test.js holds every hook to reading only the fields
// its event actually carries, and one file wired to both events reads
// `tool_input` on an event that has no tools and `prompt` on one that has no
// prompt. That check is worth more than the saved file: a hook reading a field
// its event does not carry is exactly how this gate was broken in the first
// place, silently and with a passing suite.
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { readEvent } = require(path.join(ROOT, 'scripts', 'hook-io'));
const {
  loadRegistry, ownerNames, resolveOwner, writeLease,
} = require(path.join(ROOT, 'scripts', 'resource-ownership'));

readEvent((event) => {
  const sessionId = event.session_id;
  if (!sessionId) return;

  const owners = ownerNames(loadRegistry(ROOT));
  if (!owners.size) return;

  const owner = resolveOwner((event.tool_input || {}).skill, owners);
  if (owner) writeLease(owner, sessionId);
});
