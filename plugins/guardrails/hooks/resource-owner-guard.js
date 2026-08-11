#!/usr/bin/env node
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { readEvent, block } = require(path.join(ROOT, 'scripts', 'hook-io'));
const {
  activeOwner, loadRegistry, matchedResources, unreadRequirements,
} = require(path.join(ROOT, 'scripts', 'resource-ownership'));

readEvent((event) => {
  const resources = matchedResources(event, loadRegistry(ROOT));
  if (!resources.length) return;

  // Two independent gates, and a resource may set either or both.
  //
  // `owners` asks who is allowed to write this. `requiresRead` asks what has to
  // be in front of you before you write it. They are different questions: a
  // resource can belong to a skill, or belong to nobody and still be governed
  // by a document, which is the case this exists for.
  //
  // Every matching resource is checked rather than only the first, so a rule on
  // a directory and a rule on something inside it both apply. The first refusal
  // wins, since one blocked write only needs one reason.
  for (const resource of resources) {
    const owners = resource.owners || [];
    if (owners.length && !activeOwner(resource, event.session_id)) {
      return block(
        `Direct write blocked: ${resource.label || resource.id} is owned by `
        + `${owners.map((owner) => `/${owner}`).join(' or ')}.\n\n`
        + 'Invoke the owning skill so its validation and confirmation steps run. '
        + 'To customize protected resources, edit ~/.claude/guardrails.resources.json.'
      );
    }
  }

  for (const resource of resources) {
    const unread = unreadRequirements(resource, event.transcript_path, event.cwd);
    if (!unread.length) continue;
    return block(
      `Write blocked: ${resource.label || resource.id} is governed by a document `
      + 'you have not read this session.\n\n'
      + `${unread.map((file) => `  Read ${file}`).join('\n')}\n\n`
      + (resource.readReason ? `${resource.readReason}\n\n` : '')
      + 'Read it, then make the edit. This checks the session record, so opening the '
      + 'file with the Read tool is what satisfies it; `cat` in a shell command does '
      + 'not, because the point is that the document is loaded where the work can see '
      + 'it rather than that it scrolled past.\n\n'
      + 'To change what is required here, edit ~/.claude/guardrails.resources.json.'
    );
  }
});
