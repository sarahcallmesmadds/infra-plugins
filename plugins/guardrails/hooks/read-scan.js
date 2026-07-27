#!/usr/bin/env node
// PostToolUse hook for Read and WebFetch.
//
// Scans content at the moment it enters the conversation. This is the more
// valuable of the two scanners: once text is in context, a later compaction
// pass cannot tell the difference between something the user asked for and
// something a file told the model to do. Flagging at ingestion is the last
// point where that distinction is still obvious.

'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const { readEvent, advise } = require(path.join(ROOT, 'scripts', 'hook-io'));
const { loadConfig } = require(path.join(ROOT, 'scripts', 'config'));
const { scan, formatReport } = require(path.join(ROOT, 'scripts', 'scan'));

const WATCHED = new Set(['Read', 'WebFetch']);

// Where the text actually is in a PostToolUse event, per tool.
//
// This function used to handle three shapes and the two real tools used
// neither of them, so it returned '' every time and the scanner exited before
// doing anything. It was the same failure as the block-shape bug: the logic was
// right, the wiring was wrong, and silence is what both look like.
//
// The two shapes below are copied from events captured off a live Claude Code
// run, not from memory and not from the docs, which do not currently spell out
// tool_response. The fixtures are in tests/fixtures/ so this stays checkable.
//
//   Read      tool_response.file.content
//   WebFetch  tool_response.result
//
// The older three are kept because they cost nothing and a future tool may
// well use one. They are no longer the only ones.
function contentFrom(event) {
  const response = event.tool_response;
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';

  // Read. The whole file arrives under `file`, alongside its line counts.
  if (response.file && typeof response.file.content === 'string') {
    return response.file.content;
  }

  // WebFetch. Worth being straight about what this is: `result` is the
  // processed answer for the page, not the raw HTML, so an injection that
  // never made it into that text is not visible here. Scanning it is still
  // worth doing, because instructions aimed at a model tend to survive being
  // summarised, that being the entire point of them. It is not the same
  // coverage as scanning the page itself.
  if (typeof response.result === 'string') return response.result;

  if (typeof response.content === 'string') return response.content;
  if (Array.isArray(response.content)) {
    return response.content
      .map((block) => (typeof block === 'string' ? block : block && block.text) || '')
      .join('\n');
  }
  return '';
}

function labelFrom(event) {
  const input = event.tool_input || {};
  return input.file_path || input.url || event.tool_name;
}

readEvent((event) => {
  if (!WATCHED.has(event.tool_name)) return;

  const config = loadConfig();
  if (!config.scanForInjection) return;

  const text = contentFrom(event);
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

  const label = labelFrom(event);
  const result = scan(text, {
    filePath: (event.tool_input && event.tool_input.file_path) || null,
    extraExcludes,
  });

  const report = formatReport(result, label);
  if (report) advise('PostToolUse', report);
});
