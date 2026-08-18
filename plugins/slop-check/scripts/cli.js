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

  // House rules are reported apart from the hard rules, and said differently.
  //
  // Found by review. checkAll delegates to checkHard, so this half runs over
  // whatever the skill was pointed at, and the skill is pointed at other
  // people's documents as often as at your own. A pull request somebody sent
  // you came back reading "Hard rules: BROKEN. phrases ruled out for this
  // author", which is the tier that has no defence, about an author who never
  // agreed to the rule and cannot be expected to know it.
  //
  // The detection stays, because running this over your own draft is exactly
  // when you want it, and suppressing it here would take that away to fix a
  // sentence. Only the framing changes: named as yours, kept out of the
  // verdict tier, and printed as the bare phrases rather than through a
  // sentence that names the wrong person.
  const houseRules = result.hard.filter((v) => v.name === 'house-rule');
  const hard = result.hard.filter((v) => v.name !== 'house-rule');

  if (hard.length === 0) {
    lines.push('Hard rules: clean. No em dashes, no runs of very short sentences.');
  } else {
    lines.push('Hard rules: BROKEN.');
    for (const v of hard) lines.push(`  ${v.what}`);
  }

  if (houseRules.length) {
    lines.push('');
    lines.push('Your own standing phrase rules, which count only if this is your draft:');
    for (const v of houseRules) {
      lines.push(`  ${(v.phrases || []).join(', ')}`);
    }
  }

  lines.push('');
  if (result.soft.length === 0) {
    lines.push('Softer tells: none worth reporting.');
  } else {
    lines.push(`Softer tells: ${result.categories} categor${result.categories === 1 ? 'y' : 'ies'} present.`);
    for (const s of result.soft) {
      if (s.hits && s.hits.length && s.hits[0] && s.hits[0].phrase) {
        lines.push(`  ${s.name}: ${s.hits.map((h) => `"${h.phrase}"${h.count > 1 ? ` x${h.count}` : ''}`).join(', ')}`);
      } else if (s.name === 'uniform-rhythm') {
        lines.push(`  ${s.name}: ${s.sentences} sentences averaging ${s.mean} words, with unusually little variation`);
      } else {
        lines.push(`  ${s.name}: ${detailOf(s)}`);
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

// Findings carry whatever fields fit them: a list of hits, a count, a total, a
// ratio. Printing one assumed shape is how `percentages-do-not-total-100`,
// which has only a total, came out as "undefined occurrences" on the check the
// README tells you to trust most.
function detailOf(finding) {
  if (finding.hits && finding.hits.length) return finding.hits.join(', ');
  if (typeof finding.count === 'number') {
    return `${finding.count} occurrence${finding.count === 1 ? '' : 's'}`;
  }
  const rest = Object.entries(finding)
    .filter(([k]) => !['name', 'hard', 'over', 'hits', 'count'].includes(k))
    .map(([k, v]) => `${k}=${v}`);
  return rest.length ? rest.join(' ') : 'present';
}

function formatTechnical(result, kind) {
  const lines = [`Technical check (${kind}):`, ''];

  if (result.hard.length) {
    lines.push('Checkable problems, not matters of taste:');
    for (const f of result.hard) {
      lines.push(`  ${f.name}: ${detailOf(f)}`);
    }
    lines.push('');
  }

  if (result.soft.length === 0) {
    lines.push('Nothing else worth flagging.');
  } else {
    lines.push(`Signals of unreviewed work: ${result.soft.length} categor${result.soft.length === 1 ? 'y' : 'ies'}.`);
    for (const f of result.soft) {
      lines.push(`  ${f.name}: ${detailOf(f)}`);
    }
  }

  lines.push('');
  lines.push({
    strong: 'Reads as work nobody checked before shipping.',
    some: 'Some signs it was not reviewed closely.',
    little: 'Little sign of unreviewed work.',
  }[result.reading]);

  // Reported apart, because it answers a different question. Work can be
  // carefully reviewed and still take the long way round, and the reverse.
  if (result.over && result.over.length) {
    lines.push('');
    lines.push(`Heavier than the problem: ${result.over.length} signal${result.over.length === 1 ? '' : 's'}.`);
    for (const f of result.over) {
      lines.push(`  ${f.name}: ${detailOf(f)}`);
    }
    lines.push('');
    lines.push({
      strong: 'Takes a much longer path than the problem needed.',
      some: 'Somewhat heavier than the problem needed.',
      little: 'Roughly proportionate to the problem.',
    }[result.weight]);
  }

  lines.push('');
  lines.push('This says nothing about who or what wrote it. It reports whether');
  lines.push('someone who knew the subject appears to have looked at it, and');
  lines.push('whether the solution is the size of the problem.');

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
  //
  // That second sentence was a comment describing an intention the code did not
  // carry out. The technical half printed unconditionally, so a LinkedIn draft
  // came back with a heading calling it a spec, a verdict on whether it had been
  // reviewed, and three closing lines answering a question nobody had asked. A
  // heading plus "nothing worth flagging" is not reporting nothing, it is
  // reporting at length that there is nothing to report.
  //
  // Silence is conditional on there being no findings, not on the guessed kind.
  // Kind is a label here: `checkTechnical` deliberately runs every group over
  // every input, so gating on it would rebuild the bug its own comment records.
  //
  // An explicit `--technical` prints either way, above. Asking for a half and
  // getting silence is its own failure, and that caller asked.
  const prose = checkAll(text, config);
  const technical = checkTechnical(text, kind);

  process.stdout.write(formatReport(prose) + '\n');

  const technicalHasSomethingToSay =
    technical.hard.length > 0 || technical.soft.length > 0 || technical.over.length > 0;

  if (technicalHasSomethingToSay) {
    process.stdout.write('\n' + '-'.repeat(60) + '\n\n');
    process.stdout.write(formatTechnical(technical, kind) + '\n');
  }
})();
