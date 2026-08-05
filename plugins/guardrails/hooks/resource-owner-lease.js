#!/usr/bin/env node
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { readEvent } = require(path.join(ROOT, 'scripts', 'hook-io'));
const { loadRegistry, renewLeases, writeLease } = require(path.join(ROOT, 'scripts', 'resource-ownership'));

readEvent((event) => {
  const resources = loadRegistry(ROOT);
  const sessionId = event.session_id;
  if (!sessionId) return;

  if (event.tool_name === 'Skill') {
    const input = event.tool_input || {};
    const skill = input.skill || input.name;
    const owners = new Set(resources.flatMap((resource) => resource.owners || []));
    if (skill && owners.has(skill)) writeLease(skill, sessionId);
    return;
  }

  renewLeases(resources, sessionId);
});
