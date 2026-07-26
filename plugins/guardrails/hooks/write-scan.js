#!/usr/bin/env node
// PreToolUse hook for Write and Edit.
//
// Catches injected instructions on the way onto disk. Matters most for files
// another agent will read later: a poisoned note, plan, or memory file becomes
// an instruction the next session treats as trusted context.
//
// Advisory, not blocking. Writing a file that quotes an injection string is a
// completely normal thing to do, and this plugin's own source does it.

'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const { readEvent, advise } = require(path.join(ROOT, 'scripts', 'hook-io'));
const { loadConfig } = require(path.join(ROOT, 'scripts', 'config'));
const { scan, formatReport } = require(path.join(ROOT, 'scripts', 'scan'));

const WATCHED = new Set(['Write', 'Edit']);

readEvent((event) => {
  if (!WATCHED.has(event.tool_name)) return;

  const config = loadConfig();
  if (!config.scanForInjection) return;

  const input = event.tool_input || {};
  const text = input.content || input.new_string || '';
  if (!text) return;

  const extraExcludes = (config.injectionExcludePaths || [])
    .map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);

  const result = scan(text, { filePath: input.file_path || null, extraExcludes });
  const report = formatReport(result, input.file_path || 'the file being written');
  if (report) advise('PreToolUse', report);
});
