#!/usr/bin/env node
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { readEvent, block } = require(path.join(ROOT, 'scripts', 'hook-io'));
const {
  loadRegistry, matchedResources, unreadRequirements,
} = require(path.join(ROOT, 'scripts', 'resource-ownership'));

// This hook used to run two gates. The `owners` gate asked who was allowed to
// write a resource and refused anyone but the owning skill; it was removed in
// 0.5.0 and only `requiresRead` remains. The filename is left alone in that
// change so the diff stays reviewable, and renaming it is its own small piece
// of work.
//
// Why the owner gate went, recorded here because a removal leaves no code to
// read: it was added on 2026-08-05 as a backstop rather than in response to
// anything going wrong, and in the six days it ran there was no case of it
// stopping a bad write. It twice refused the owning skill itself, which is the
// one caller it existed to let through. The failure it was reached for, a
// handoff landing somewhere it should not, is not a thing it could ever have
// caught: it only inspects writes going into the protected directory, and a
// handoff written to the wrong place is by definition not in that directory.
//
// `requiresRead` is a different gate with a different history and it stays. It
// exists because an approved design system sat unread in a planning folder for
// three days while a page was built against nothing and thrown away on sight.
readEvent((event) => {
  const resources = matchedResources(event, loadRegistry(ROOT));
  if (!resources.length) return;

  // Every matching resource is checked rather than only the first, so a rule on
  // a directory and a rule on something inside it both apply. The first refusal
  // wins, since one blocked write only needs one reason.
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
      + 'If you already opened it: a Read that failed does not count, and neither does '
      + 'one narrowed with offset or limit, since part of a governing document is not '
      + 'the document. Read the whole file.\n\n'
      + 'To change what is required here, edit ~/.claude/guardrails.resources.json.'
    );
  }
});
