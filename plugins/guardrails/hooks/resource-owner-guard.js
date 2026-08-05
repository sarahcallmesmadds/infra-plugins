#!/usr/bin/env node
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { readEvent, block } = require(path.join(ROOT, 'scripts', 'hook-io'));
const { activeOwner, loadRegistry, matchedResource } = require(path.join(ROOT, 'scripts', 'resource-ownership'));

readEvent((event) => {
  const resource = matchedResource(event, loadRegistry(ROOT));
  if (!resource) return;
  if (activeOwner(resource, event.session_id)) return;

  const owners = (resource.owners || []).map((owner) => `/${owner}`).join(' or ');
  block(
    `Direct write blocked: ${resource.label || resource.id} is owned by ${owners}.\n\n`
    + `Invoke the owning skill so its validation and confirmation steps run. `
    + `To customize protected resources, edit ~/.claude/guardrails.resources.json.`
  );
});
