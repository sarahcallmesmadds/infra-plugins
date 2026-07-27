#!/usr/bin/env node
// Command-line entry point for the skills.
//
// The hook and the skills share this file, so a finding reads the same whether
// it surfaced automatically in Claude Code or was asked for in Codex.
//
//   cli.js check --file <path>
//   cli.js check                 (reads stdin)
//   cli.js check --hard-only     (only the enforceable rules)

'use strict';

const fs = require('fs');
const path = require('path');

const { checkAll, checkHard } = require(path.join(__dirname, 'tells.js'));
const { checkTechnical, guessKind } = require(path.join(__dirname, 'technical.js'));
const { loadConfig } = require(path.join(__dirname, 'config.js'));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

function formatReport(result) {
  const lines = [];

  if (result.hard.length === 0) {
    lines.push('Hard rules: clean. No em dashes, no runs of very short sentences.');
  } else {
    lines.push('Hard rules: BROKEN.');
    for (const v of result.hard) lines.push(`  ${v.what}`);
  }

  lines.push('');
  if (result.soft.length === 0) {
    lines.push('Softer tells: none worth reporting.');
  } else {
    lines.push(`Softer tells: ${result.categories} categor${result.categories === 1 ? 'y' : 'ies'} present.`);
    for (const s of result.soft) {
      if (s.hits) {
        lines.push(`  ${s.name}: ${s.hits.map((h) => `"${h.phrase}"${h.count > 1 ? ` x${h.count}` : ''}`).join(', ')}`);
      } else if (s.name === 'uniform-rhythm') {
        lines.push(`  ${s.name}: ${s.sentences} sentences averaging ${s.mean} words, with unusually little variation`);
      } else {
        lines.push(`  ${s.name}: ${s.count} occurrences`);
      }
    }
  }

  lines.push('');
  const verdict = {
    strong: 'Reads strongly of unedited machine output.',
    some: 'Some machine-writing habits present.',
    little: 'Little sign of machine-writing habits.',
  }[result.reading];
  lines.push(verdict);
  lines.push('');
  lines.push('The softer signals are aggregate only. Any one of them appears in good');
  lines.push('human writing, so they mean something together and nothing alone.');

  return lines.join('\n');
}

function formatTechnical(result, kind) {
  const lines = [`Technical check (${kind}):`, ''];

  if (result.hard.length) {
    lines.push('Checkable problems, not matters of taste:');
    for (const f of result.hard) {
      const detail = f.hits ? f.hits.join(', ') : `${f.count} occurrences`;
      lines.push(`  ${f.name}: ${detail}`);
    }
    lines.push('');
  }

  if (result.soft.length === 0) {
    lines.push('Nothing else worth flagging.');
  } else {
    lines.push(`Signals of unreviewed work: ${result.soft.length} categor${result.soft.length === 1 ? 'y' : 'ies'}.`);
    for (const f of result.soft) {
      const detail = f.hits ? f.hits.join(', ')
        : Object.entries(f).filter(([k]) => k !== 'name').map(([k, v]) => `${k}=${v}`).join(' ');
      lines.push(`  ${f.name}: ${detail}`);
    }
  }

  lines.push('');
  lines.push({
    strong: 'Reads as work nobody checked before shipping.',
    some: 'Some signs it was not reviewed closely.',
    little: 'Little sign of unreviewed work.',
  }[result.reading]);
  lines.push('');
  lines.push('This says nothing about who or what wrote it. It reports whether');
  lines.push('someone who knew the subject appears to have looked at it.');

  return lines.join('\n');
}

(async () => {
  const command = process.argv[2];
  if (command !== 'check') {
    process.stderr.write('usage: cli.js check [--file <path>] [--hard-only] [--technical [kind]]\n');
    process.exit(2);
  }

  const file = argValue('--file');
  let text;
  if (file) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      process.stderr.write(`cannot read ${file}: ${err.message}\n`);
      process.exit(2);
    }
  } else {
    text = await readStdin();
  }

  if (!text.trim()) {
    process.stderr.write('nothing to check\n');
    process.exit(2);
  }

  const config = loadConfig();

  const asked = argValue('--technical');
  const kind = ['code', 'data', 'spec'].includes(asked) ? asked : guessKind(file, text);

  if (process.argv.includes('--technical')) {
    process.stdout.write(formatTechnical(checkTechnical(text, kind), kind) + '\n');
    process.exit(0);
  }

  if (process.argv.includes('--prose')) {
    process.stdout.write(formatReport(checkAll(text, config)) + '\n');
    process.exit(0);
  }

  if (process.argv.includes('--hard-only')) {
    const { ok, violations } = checkHard(text, config);
    process.stdout.write(ok ? 'clean\n' : violations.map((v) => v.what).join('\n') + '\n');
    process.exit(0);
  }

  // Default: both halves. One skill runs this against anything, and whichever
  // half is irrelevant reports nothing rather than being wrong.
  const prose = checkAll(text, config);
  const technical = checkTechnical(text, kind);

  process.stdout.write(formatReport(prose) + '\n\n');
  process.stdout.write('-'.repeat(60) + '\n\n');
  process.stdout.write(formatTechnical(technical, kind) + '\n');
})();
