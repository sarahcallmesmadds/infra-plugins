#!/usr/bin/env node
// skill-md-check.js — PostToolUse hook on Write and Edit.
//
// Validates a SKILL.md the moment it is written. Never blocks: it reports back
// into the conversation so the model that just wrote the file is the one that
// fixes it.
//
// What it checks and why each one is here:
//
//   frontmatter present   Without it the file is markdown, not a skill, and
//                         nothing loads it. Silent.
//   name                  Required by the loader.
//   name matches its dir  The one this repository actually keeps hitting.
//                         /audit-deps carries a `notes` field for exactly this
//                         case, and `skill-find` versus `find-skill` is the
//                         same fault shipped twice under two names. The name on
//                         disk is what the composite key uses; the frontmatter
//                         name is what the model reads. When they disagree,
//                         both are right and neither resolves.
//   description           This is the discovery surface. A skill with no
//                         description never triggers, and never triggering
//                         looks exactly like never being needed.
//   type, when present    11 of the 22 skills in this repository set it and 11
//                         do not, so it is checked but not required. Requiring
//                         it would flag 11 files that are fine.

'use strict';

const fs = require('fs');
const path = require('path');
const { readEvent, advise } = require('../scripts/hook-io.js');

// Parses just enough YAML for a SKILL.md header: top-level `key: value`, plus
// folded and literal scalars, which several skills here use for description.
// Not a YAML parser and not trying to be. It answers one question, which is
// whether a key has a non-empty value.
function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;

  const lines = content.slice(4, end).split('\n');
  const fields = {};
  let key = null;
  let folded = [];

  const flush = () => {
    if (key) fields[key] = folded.join(' ').trim();
    key = null;
    folded = [];
  };

  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match) {
      flush();
      const [, k, v] = match;
      if (v === '>' || v === '|' || v === '>-' || v === '|-') {
        key = k;                    // value continues on the indented lines
      } else {
        fields[k] = v.trim();
      }
    } else if (key && /^\s+\S/.test(line)) {
      folded.push(line.trim());
    } else if (line.trim() !== '') {
      flush();
    }
  }
  flush();
  return fields;
}

function inspect(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const issues = [];

  const fields = parseFrontmatter(content);
  if (!fields) {
    return ['no YAML frontmatter. The file has to open with `---` and close the '
      + 'block with `---` before any prose, or nothing loads it as a skill.'];
  }

  if (!fields.name) {
    issues.push('no `name:` in the frontmatter.');
  } else {
    // Only meaningful in the skills/<name>/SKILL.md layout. A SKILL.md kept
    // anywhere else, a template or a reference copy, has no directory to agree
    // with and is not a finding.
    const dir = path.basename(path.dirname(filePath));
    const parent = path.basename(path.dirname(path.dirname(filePath)));
    if (parent === 'skills' && fields.name !== dir) {
      issues.push(`\`name: ${fields.name}\` does not match the directory \`${dir}/\`. `
        + 'Pick one. The directory name is what the dependency map keys on and what '
        + '/flag-issue resolves to a file; the frontmatter name is what the model '
        + 'reads. While they disagree, a fix filed against one will not find the other.');
    }
  }

  if (!fields.description) {
    issues.push('no `description:` in the frontmatter. This is the text the model '
      + 'matches a request against, so without it the skill is installed but '
      + 'unreachable, which reads the same as never being needed.');
  }

  if (fields.type !== undefined && fields.type !== 'human' && fields.type !== 'agent') {
    issues.push(`\`type: ${fields.type}\` is not a value this repository uses. `
      + 'Use `human` when you invoke it or `agent` when it runs on its own, or drop '
      + 'the field, which 11 of the 22 skills here do.');
  }

  return issues;
}

readEvent((event) => {
  if (event.tool_name !== 'Write' && event.tool_name !== 'Edit') return;

  const filePath = event.tool_input && event.tool_input.file_path;
  if (!filePath || path.basename(filePath) !== 'SKILL.md') return;
  if (!fs.existsSync(filePath)) return;   // the write did not land

  const issues = inspect(filePath);
  if (issues.length === 0) return;

  advise('PostToolUse', [
    `skill-md-check: ${filePath} has ${issues.length} frontmatter `
    + `${issues.length === 1 ? 'problem' : 'problems'}.`,
    ...issues.map((i, n) => `${n + 1}. ${i}`),
    'Fix these before moving on. Nothing is blocked, but a skill with a broken '
    + 'header fails quietly rather than loudly.',
  ].join(' '));
});
