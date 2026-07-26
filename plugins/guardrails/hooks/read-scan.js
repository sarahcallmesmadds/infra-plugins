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

function contentFrom(event) {
  const response = event.tool_response;
  if (typeof response === 'string') return response;
  if (response && typeof response.content === 'string') return response.content;
  if (response && Array.isArray(response.content)) {
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
