#!/usr/bin/env node
// Command-line entry point for the two skills.
//
// The hooks and the skills share this file so a finding reads the same whether
// it surfaced automatically in Claude Code or was asked for in Codex.
//
//   cli.js scan --file <path>
//   cli.js scan                  (reads stdin)
//   cli.js check --command '<shell command>'

'use strict';

const fs = require('fs');
const path = require('path');

const { scan, formatReport } = require(path.join(__dirname, 'scan'));
const { checkCommand } = require(path.join(__dirname, 'command'));
const { loadConfig } = require(path.join(__dirname, 'config'));

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : null;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function runScan() {
  const file = argValue('--file');
  let text;
  let label;

  if (file) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      console.error(`Could not read ${file}: ${error.message}`);
      process.exit(2);
    }
    label = file;
  } else {
    text = readStdin();
    label = 'stdin';
    if (!text.trim()) {
      console.error('No input. Pass --file <path>, or pipe text on stdin.');
      process.exit(2);
    }
  }

  const config = loadConfig();
  const extraExcludes = (config.injectionExcludePaths || [])
    .map((pattern) => { try { return new RegExp(pattern); } catch (_) { return null; } })
    .filter(Boolean);

  const result = scan(text, { filePath: file, extraExcludes });

  if (result.skipped) {
    console.log(`severity: none (${label} is on the exclusion list)`);
    return;
  }
  console.log(`severity: ${result.severity}`);
  if (result.severity === 'none') {
    console.log('No injection patterns matched.');
    return;
  }
  console.log(formatReport(result, label));
}

function runCheck() {
  const command = argValue('--command');
  if (!command) {
    console.error("No command. Pass --command '<shell command>'.");
    process.exit(2);
  }
  const verdict = checkCommand(command, loadConfig());
  console.log(`verdict: ${verdict.verdict}`);
  if (verdict.reason) console.log(verdict.reason);
}

const subcommand = process.argv[2];
if (subcommand === 'scan') runScan();
else if (subcommand === 'check') runCheck();
else {
  console.error('Usage: cli.js scan [--file <path>] | cli.js check --command \'<cmd>\'');
  process.exit(2);
}
