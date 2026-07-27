#!/usr/bin/env node
// Command-line entry point for the skills.
//
// The skills shell out to this file rather than reasoning about the inventory
// themselves, so a verdict reads identically whether it came from Claude Code,
// from Codex, or from a scheduled run with no model attached at all.
//
//   cli.js audit   [--json] [--input rows.json] [--config path]
//   cli.js exhibit [--out FILE] [--json] [--input rows.json] [--now YYYY-MM-DD]
//
// The first line of output is machine-readable on purpose. The skills branch on
// it instead of parsing prose.

'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig, expandHome } = require(path.join(__dirname, 'config'));
const { loadInventory } = require(path.join(__dirname, 'notion'));
const { gather } = require(path.join(__dirname, 'reality'));
const { classify } = require(path.join(__dirname, 'diff'));
const { renderExhibit, exhibitRows, gaps } = require(path.join(__dirname, 'exhibit'));

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

// Rows come from Notion, or from a file when the caller supplies one. The file
// path exists so the tests can drive the real classifier against known-wrong
// rows without a network or a token.
async function getRows(config) {
  const input = argValue('--input');
  if (input) {
    const parsed = JSON.parse(fs.readFileSync(expandHome(input), 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : parsed.rows;
    if (!Array.isArray(rows)) fail(`--input ${input} does not contain an array of rows`);
    return { rows, count: rows.length, missing: [] };
  }
  return loadInventory(config);
}

async function runAudit(config) {
  const inventory = await getRows(config);
  const reality = await gather(inventory.rows, config, { skipGithub: hasFlag('--offline') });
  const result = classify(inventory.rows, reality, config);

  if (hasFlag('--json')) {
    console.log(JSON.stringify({ ...result, missingColumns: inventory.missing }, null, 2));
    return;
  }

  // A run that found nothing has to look different from a run that did not
  // happen, so the count of what was checked is printed either way.
  console.log(`drift: ${result.counts.findings}`);
  console.log('');
  // Naming the sources matters more than the count. An offline run that claims
  // to have checked GitHub is the exact failure this report exists to prevent,
  // only committed by the report itself.
  const sources = reality.offline
    ? 'this machine only, GitHub not contacted'
    : 'GitHub and this machine';
  console.log(
    `Checked ${result.counts.rows} rows against ${sources} `
    + `(${result.checksRun.length} checks per row).`
  );

  if (inventory.missing.length) {
    console.log('');
    console.log('Configured columns that do not exist in the database:');
    for (const item of inventory.missing) {
      console.log(`  ${item.logical} -> "${item.column}" — every row read as blank`);
    }
  }

  if (!result.findings.length) {
    console.log('');
    console.log('No drift. Every repository resolves, every path exists, every version matches.');
  }

  const auto = result.findings.filter((f) => f.verdict === 'auto');
  const queue = result.findings.filter((f) => f.verdict === 'queue');

  if (auto.length) {
    console.log('');
    console.log(`## Safe to fix automatically (${auto.length} rows)`);
    console.log('These have one correct answer.');
    console.log('');
    for (const group of groupFindings(auto)) {
      console.log(`  ${describe(group)} — ${group.field}: ${format(group.was)} -> ${format(group.now)}`);
      console.log(`      ${group.detail}`);
    }
  }

  if (queue.length) {
    console.log('');
    console.log(`## Needs you (${queue.length} rows)`);
    console.log('These are not wrong, they are unknown. Nothing here can be inferred.');
    console.log('');
    for (const group of groupFindings(queue)) {
      console.log(`  ${describe(group)} [${group.check}]`);
      console.log(`      ${group.detail}`);
    }
  }

  if (result.skipped.length) {
    console.log('');
    console.log(`## Not checked (${result.skipped.length})`);
    console.log('Listed because a check that did not run looks exactly like one that passed.');
    console.log('');
    // Grouped for the same reason the findings are. Going offline skips the
    // repository check on every row that has one, and sixty identical lines
    // bury the one skip that is actually specific to a row.
    const bySkip = new Map();
    for (const item of result.skipped) {
      const key = `${item.check}|${item.reason}`;
      if (!bySkip.has(key)) bySkip.set(key, { ...item, names: [] });
      if (item.name) bySkip.get(key).names.push(item.name);
    }
    for (const group of bySkip.values()) {
      console.log(`  ${describe(group)}${group.names.length ? ' — ' : ''}${group.check}: ${group.reason}`);
    }
  }
}

function format(value) {
  if (value === null || value === undefined) return '(blank)';
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return String(value);
}

// Collapses findings that say the same thing about different rows.
//
// One plugin update changes the recorded version on every row that plugin
// ships, so an ungrouped report prints the same sentence twenty times and the
// one finding that is not a version bump gets lost in it.
function groupFindings(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.groupKey
      || [item.check, item.field, format(item.was), format(item.now), item.detail].join(' ');
    if (!groups.has(key)) groups.set(key, { ...item, names: [] });
    groups.get(key).names.push(item.name);
  }
  return [...groups.values()];
}

function describe(group) {
  if (group.names.length === 0) return '';
  if (group.names.length === 1) return group.names[0];
  const shown = group.names.slice(0, 4).join(', ');
  const rest = group.names.length - 4;
  return `${group.names.length} rows (${shown}${rest > 0 ? `, +${rest} more` : ''})`;
}

async function runExhibit(config) {
  const inventory = await getRows(config);
  const now = argValue('--now') || undefined;
  const entries = exhibitRows(inventory.rows, config);
  const gapEntries = gaps(inventory.rows, config);

  if (hasFlag('--json')) {
    console.log(JSON.stringify({
      works: entries.length,
      complete: entries.length - gapEntries.length,
      gaps: gapEntries.map((entry) => ({ name: entry.row.name, missing: entry.missing })),
    }, null, 2));
    return;
  }

  const markdown = renderExhibit(inventory.rows, config, { now });
  const out = argValue('--out');

  console.log(`gaps: ${gapEntries.length} of ${entries.length}`);
  console.log('');
  if (out) {
    const target = expandHome(out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, markdown);
    console.log(`Written to ${target}`);
    console.log('');
    console.log('Draft for a lawyer to review. Not legal advice.');
  } else {
    console.log(markdown);
  }
}

async function main() {
  const subcommand = process.argv[2];
  const config = loadConfig(argValue('--config'));

  if (subcommand === 'audit') await runAudit(config);
  else if (subcommand === 'exhibit') await runExhibit(config);
  else {
    console.error(
      'Usage: cli.js audit [--json] [--input rows.json] [--config path]\n'
      + '       cli.js exhibit [--out FILE] [--json] [--now YYYY-MM-DD]'
    );
    process.exit(2);
  }
}

main().catch((error) => fail(error.message));
