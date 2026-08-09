#!/usr/bin/env node
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { readEvent, block } = require(path.join(ROOT, 'scripts', 'hook-io'));
const {
  activeOwner, loadRegistry, matchedResource, unreadRequirements,
} = require(path.join(ROOT, 'scripts', 'resource-ownership'));

readEvent((event) => {
  const resource = matchedResource(event, loadRegistry(ROOT));
  if (!resource) return;

  // Two independent gates, and a resource may set either or both.
  //
  // `owners` asks who is allowed to write. `requiresRead` asks what has to be
  // in front of you first. They are different questions: a skill can own a
  // document without any prior reading being required, and a directory can
  // require a standard be read without belonging to any skill at all.
  const owners = resource.owners || [];
  if (owners.length && !activeOwner(resource, event.session_id)) {
    const list = owners.map((owner) => `/${owner}`).join(' or ');
    return block(
      `Direct write blocked: ${resource.label || resource.id} is owned by ${list}.\n\n`
      + 'Invoke the owning skill so its validation and confirmation steps run. '
      + 'To customize protected resources, edit ~/.claude/guardrails.resources.json.'
    );
  }

  const unread = unreadRequirements(resource, event.transcript_path, event.cwd);
  if (unread.length) {
    return block(
      `Write blocked: ${resource.label || resource.id} is governed by a document you have not read this session.\n\n`
      + `${unread.map((file) => `  Read ${file}`).join('\n')}\n\n`
      + (resource.readReason ? `${resource.readReason}\n\n` : '')
      + 'Read it, then make the edit. This checks the session transcript, so opening '
      + 'the file with the Read tool is what satisfies it; `cat` in a shell command '
      + 'does not, because the point is that the document is loaded rather than that '
      + 'it scrolled past.\n\n'
      + 'To change what is required here, edit ~/.claude/guardrails.resources.json.'
    );
  }
});
