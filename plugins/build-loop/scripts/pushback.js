#!/usr/bin/env node
'use strict';

// Counts the times the user pushed back on an answer, and what kind of pushback
// it was. Reads Claude Code transcripts, which are already on disk, so nothing
// has to be captured live and no hook is involved.
//
// The number that matters is pushbacks per hundred messages the user actually
// typed. Everything else is detail underneath it. A rate that does not fall is
// how you find out a writing rule is not working, and no amount of extra rules
// in the skill will change a flat line.
//
// What this cannot see: the times the user gave up and worked around the answer
// instead of saying so. Those leave no trace in a transcript, so every number
// here is a floor rather than a measurement, and the report says so out loud.
//
// Privacy, and why quoting is opt-in rather than opt-out.
//
// Transcripts are the user's own words, including the ones they would not want
// quoted anywhere. The quotes exist so a pattern can be acted on when they read
// it themselves, and they must never reach a channel.
//
// The first version of this got that backwards. Quoting was the default and a
// single string comparison, `format !== 'slack'`, was the only thing standing
// between a private message and a Slack post. Devin found three ways past it in
// one pass: `--format=slack` in the equals form, `--format Slack` with a capital
// letter, and `--format` given as the last argument with nothing after it. Each
// produced the full quoting report while looking like the safe command, and the
// skill tells you to paste that output into a channel.
//
// A control whose failure mode is publishing somebody's private messages has to
// fail closed. So there is no format string to get wrong: quoting is off unless
// `--quotes` is passed, and every unrecognised argument is a hard error rather
// than a silently ignored one. Getting it wrong now produces counts, or an
// error, and never the quotes.
//
// The public test fixtures for this file are written for the test and contain
// nobody's real messages. See tests/pushback.test.js.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// Ordered. A message is counted once, under the first kind that matches, so a
// message carrying two complaints does not inflate the total. The order runs
// most-specific first: "are you sure ... i dont understand" is about trust, and
// filing it under jargon would lose the more useful half.
// Typos are load-bearing. The user types fast and the misspellings are as
// frequent as the correct spellings, so a pattern that only matches the
// dictionary form misses roughly a fifth of real hits. Every alternate spelling
// below came out of a real message, not out of imagination.
const KINDS = [
  {
    kind: 'off-track',
    label: 'Stop going off track, do the thing I asked',
    // Behaviour rather than writing. Cannot be fixed by rewording an answer.
    test: /(stay on track|going off track|off track|i did ?n.?t ask (for|about)|that.?s not what i asked|do not do anything but|dont do anything but|before we do anything else|stop,? ?stop|what the fuck|unhappy with this session|i do ?n.?t want .{0,30}(bullshit|skeptics)|bullshit|the info you gave me|no i thought the whole)/i,
  },
  {
    kind: 'distrust',
    label: 'Are you sure, you have been wrong',
    test: /(are you sure|you.?ve been wrong|you have been wrong|prone to lying|i can.?t rely on you|cant rely on you|stop claiming|did you actually|is (this|that) (actually )?(true|fact)|all of this is fact|before i approve|rounds of feedback|that.?s good,? right\??$|thats good right)/i,
  },
  {
    kind: 'cannot-understand',
    label: 'Too jargony, cannot understand it',
    test: /(i do ?n.?t understand|dont understand|idu\b|too jargon|too much jargon|so jargony|jargony|too technical|no idea what|no clue what|i.?m confused|im confused|so confused|i.?m lost|im lost|(so|really|very|f\S*ing|is) confusing|too much (text|info)|what (does|doe s|do es) (all )?(of )?(this|that|it|annn*y+)|what does a+n+y+ of this|hard to understand|couldn.?t repeat|^(huh|what|wat)\?*$|^(huh|what)\?\?+)/i,
  },
  {
    kind: 'no-next-action',
    label: 'Now what, the answer gave me nothing to do',
    // Leading filler is common: "ok great now what", "okay so what should we do".
    test: /^((ok(ay)?|great|cool|so|and|well|right)[\s,!.]*)*((now what|what now|what.?s next|so what (do|should) we|what (do|should) we (do|need to do)|are we done|where is the pr|where.?s the pr|whwere is the pr)\b)|what do you need from me/i,
  },
  {
    kind: 'undecidable',
    label: 'This does not help me decide',
    test: /(does ?n.?t help me|doesnt help me|help me make a decision|what value does|in order to make the decision|how do i (choose|decide))/i,
  },
  {
    kind: 'what-is-this',
    label: 'What is this thing of mine, and how does it differ from that one',
    test: /(how is .{1,40} different from|what is the .{1,40} (needed|for)\??$|are we (talking|takng|takling|talkng) about|sorry,? wh?at|draft wa?ht|wait,? how|what is it that.?s going|what is (hte|the) .{1,40} that matters)/i,
  },
];

// Content the user pasted in rather than wrote. A forwarded review finding, a
// meeting transcript or a block of terminal output can easily contain "I don't
// understand" without the user being confused about anything. Out-of-sample
// checking on 2,445 older messages showed every remaining false positive was
// this and nothing else.
const PASTED = /^(\d+\s+(bugs?|fl|flags?)\b|pr+ ?\d+\b|here is the response|from codex:|session summary:|reply with exactly|run the shell|•\s|❯\s|\[\d{4}-\d{2}-\d{2})/i;
const FINDING_MARKUP = /\*\*[^*]{20,}\*\*|^\s*```|\.js:\d+|\.md:\d+/m;

// Real pushback is short and direct. The longest in a labelled set of 55 was
// 471 characters and the median was 58. A ceiling of 800 keeps every one of
// them while cutting the pasted blocks, which run to thousands.
const MAX_PUSHBACK_LENGTH = 800;

function classify(text) {
  if (text.length > MAX_PUSHBACK_LENGTH) return null;
  if (isPasted(text)) return null;
  for (const k of KINDS) if (k.test.test(text)) return k.kind;
  return null;
}

function isPasted(text) {
  return PASTED.test(text) || FINDING_MARKUP.test(text);
}

// A transcript line is the user's own typing only when it is a plain text
// message from an external user on the main thread. Tool results, sidechain
// turns, slash-command expansions, hook feedback and shell echoes all arrive as
// role "user" and none of them are the user talking.
function userText(record) {
  if (!record || record.type !== 'user') return null;
  if (record.isSidechain) return null;
  if (record.userType && record.userType !== 'external') return null;

  const content = record.message && record.message.content;
  const injected = [
    '<command-message>', '<command-name>', '<local-command-stdout>', '<local-command-stderr>',
    '<local-command-caveat>', '<bash-input>', '<bash-stdout>', '<bash-stderr>',
    '<system-reminder>', '[Request interrupted', 'Caveat:', 'Stop hook feedback:',
    'Base directory for this skill:',
  ];
  const isInjected = (value) => injected.some((marker) => value.trim().startsWith(marker));
  const stripSystemReminders = (value) =>
    value.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
  let text = null;
  if (typeof content === 'string') {
    text = stripSystemReminders(content);
  }
  else if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      // A tool result is the transcript talking to itself.
      if (block && block.type === 'tool_result') return null;
      if (block && block.type === 'text' && typeof block.text === 'string') {
        const clean = stripSystemReminders(block.text);
        if (clean.trim() && !isInjected(clean)) parts.push(clean);
      }
    }
    text = parts.length ? parts.join('\n') : null;
  }
  if (!text) return null;

  const trimmed = text.trim();
  if (!trimmed) return null;

  // Injected wrappers. Each of these is machinery, not a message.
  if (isInjected(trimmed)) return null;

  return trimmed;
}

function collect(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

// Returns { typed, pushbacks, byKind, files } for everything at or after `since`.
// `since` is a millisecond timestamp; pass 0 for all of history.
function scan(since, root) {
  const files = collect(root || PROJECTS, []);
  const typed = [];
  const pushbacks = [];

  for (const file of files) {
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (e) { continue; }
    let previousAnswer = null;

    for (const line of lines) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch (e) { continue; }
      if (record.isSidechain) continue;

      if (record.type === 'assistant') {
        const content = record.message && record.message.content;
        if (Array.isArray(content)) {
          const parts = content.filter((b) => b && b.type === 'text').map((b) => b.text);
          if (parts.length && parts.join('').trim()) {
            previousAnswer = { text: parts.join('\n'), at: record.timestamp };
          }
        } else if (typeof content === 'string' && content.trim()) {
          previousAnswer = { text: content, at: record.timestamp };
        }
        continue;
      }

      const text = userText(record);
      if (text === null) continue;
      if (isPasted(text)) continue;
      const at = record.timestamp ? new Date(record.timestamp).getTime() : 0;
      if (at < since) continue;

      const entry = { at: record.timestamp, text, answer: previousAnswer, file: path.basename(file) };
      typed.push(entry);
      const kind = classify(text);
      if (kind) pushbacks.push(Object.assign({ kind }, entry));
    }
  }

  typed.sort((a, b) => (a.at < b.at ? -1 : 1));
  pushbacks.sort((a, b) => (a.at < b.at ? -1 : 1));

  const byKind = {};
  for (const k of KINDS) byKind[k.kind] = 0;
  for (const p of pushbacks) byKind[p.kind] += 1;

  return { typed, pushbacks, byKind, files: files.length };
}

function rate(pushbacks, typed) {
  if (!typed) return 0;
  return Math.round((pushbacks / typed) * 1000) / 10;
}

// Two signals that separated the answers she pushed back on from the rest, when
// this was measured by hand on 2026-08-16. Kept here so the report can show
// whether they are still separating, rather than restating a finding from a day
// that has passed.
const NARRATES = /(worth flagging|one thing worth|my first pass|the fault was mine|i got wrong|i was wrong|correction on my own|i also did not|i did not (run|test|verify|check)|rather than (assuming|trusting)|why it took)/i;
const HANDS_OVER = /(\?|say the word|tell me|want me to|shall i|next step|do you want|your call|yours to call|recommend)/i;

function signals(entries) {
  let narrates = 0;
  let noHandover = 0;
  let counted = 0;
  const seen = new Set();
  for (const e of entries) {
    if (!e.answer || e.answer.text.length < 400) continue;
    if (seen.has(e.answer)) continue;
    seen.add(e.answer);
    counted += 1;
    if (NARRATES.test(e.answer.text)) narrates += 1;
    if (!HANDS_OVER.test(e.answer.text.slice(-400))) noHandover += 1;
  }
  return {
    counted,
    narrates,
    noHandover,
    narratesPct: counted ? Math.round((narrates / counted) * 100) : 0,
    noHandoverPct: counted ? Math.round((noHandover / counted) * 100) : 0,
  };
}

function report(result, options) {
  const opts = options || {};
  // Explicitly true, not merely truthy and not the absence of something. A
  // caller that passes nothing, passes the wrong key, or passes a value this
  // does not understand gets counts. The only way to the quotes is to ask.
  const quotes = opts.quotes === true;
  const total = result.typed.length;
  const hits = result.pushbacks.length;
  const lines = [];

  lines.push(`Pushback rate: ${rate(hits, total)} per hundred messages (${hits} of ${total} typed).`);
  lines.push('');

  if (!total) {
    lines.push('No messages in this window, so there is nothing to report.');
    return lines.join('\n');
  }

  const ordered = KINDS.slice().sort((a, b) => result.byKind[b.kind] - result.byKind[a.kind]);
  for (const k of ordered) {
    const n = result.byKind[k.kind];
    if (!n) continue;
    lines.push(`${String(n).padStart(3)}  ${k.label}`);
  }

  const pushedAnswers = new Set(result.pushbacks.map((p) => p.answer).filter(Boolean));
  const pushed = signals(result.pushbacks);
  const others = signals(result.typed.filter((t) => t.answer && !pushedAnswers.has(t.answer)));
  if (pushed.counted && others.counted) {
    lines.push('');
    lines.push('In the answers that drew a pushback, against every other answer over 400 characters:');
    lines.push(`  talks about how it was produced   ${pushed.narratesPct}%  against  ${others.narratesPct}%`);
    lines.push(`  ends with nothing to do           ${pushed.noHandoverPct}%  against  ${others.noHandoverPct}%`);
    lines.push('  (Both were roughly double when this was first measured. Level pegging means the');
    lines.push('   signal has stopped separating, which is either progress or a broken detector.)');
  }

  if (quotes && hits) {
    lines.push('');
    lines.push('Most recent, oldest first:');
    for (const p of result.pushbacks.slice(-8)) {
      const when = p.at ? p.at.slice(0, 16).replace('T', ' ') : '?';
      lines.push(`  [${when}] (${p.kind}) ${p.text.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
  }

  lines.push('');
  lines.push('This counts only the times something was said. Working around an answer in');
  lines.push('silence leaves no trace, so treat every number here as a floor.');

  return lines.join('\n');
}

// Measures the detector against a labelled set the user keeps locally, since
// their real messages cannot go in a public repository. Without this the
// detector is a pile of regular expressions nobody has checked, which is the
// exact shape of a test that passes without testing anything.
function selftest(fixturePath) {
  const file = fixturePath || path.join(os.homedir(), '.claude', 'build-loop', 'pushback-fixture.json');
  if (!fs.existsSync(file)) {
    return { ok: false, reason: `no labelled set at ${file}. Nothing was measured.` };
  }
  let cases;
  try {
    cases = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `could not read labelled set at ${file}: ${error.message}` };
  }
  if (!Array.isArray(cases)) {
    return { ok: false, reason: `labelled set at ${file} must be a JSON array.` };
  }
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)
      || typeof c.text !== 'string' || !c.text.trim()
      || typeof c.pushback !== 'boolean') {
      return {
        ok: false,
        reason: `labelled set entry ${i + 1} must be an object with non-empty "text" `
          + 'and boolean "pushback" fields.',
      };
    }
  }
  let caught = 0;
  let missed = [];
  let wrong = [];
  for (const c of cases) {
    const got = classify(c.text);
    if (c.pushback && got) caught += 1;
    else if (c.pushback && !got) missed.push(c.text);
    else if (!c.pushback && got) wrong.push({ text: c.text, as: got });
  }
  const positives = cases.filter((c) => c.pushback).length;
  const negatives = cases.length - positives;
  return {
    ok: true,
    positives,
    negatives,
    caught,
    missed,
    wrong,
    catchPct: positives ? Math.round((caught / positives) * 100) : 0,
    falsePct: negatives ? Math.round((wrong.length / negatives) * 100) : 0,
  };
}

// Parses the whole command line up front and refuses anything it does not
// recognise. The original version read flags positionally and ignored the rest,
// which is how `--format=slack` looked accepted and did nothing, and how
// `--days` could swallow the flag that followed it. CONTRIBUTING asks scripts to
// validate inputs at the boundary and make failures visible; this is that.
const FLAGS = {
  '--days': 'value',
  '--since': 'value',
  '--this-week': 'switch',
  '--root': 'value',
  '--fixture': 'value',
  '--quotes': 'switch',
  '--json': 'switch',
  '--selftest': 'switch',
  '--help': 'switch',
};

const USAGE = [
  'Usage: pushback.js [--days N | --since ISO | --this-week] [--quotes] [--json] [--root DIR]',
  '       pushback.js --selftest [--fixture FILE]',
  '',
  '  --days N    how far back to look, a positive number of days. Default 7.',
  '  --since ISO start at an explicit ISO-8601 timestamp instead of a rolling window.',
  '  --this-week start at Monday 00:00 in the machine\'s local timezone.',
  '  --quotes    include the user\'s own messages in the output. Off by default,',
  '              because this output is pasted into channels and those messages',
  '              are private. Never pass it for anything leaving the machine.',
  '  --json      counts only, machine readable. Never carries quotes.',
].join('\n');

function parseArgs(args) {
  const out = { days: 7, since: null, thisWeek: false, quotes: false, json: false, selftest: false, root: null, fixture: null, help: false };
  let daysWasSet = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const kind = Object.prototype.hasOwnProperty.call(FLAGS, arg) ? FLAGS[arg] : null;

    if (!kind) {
      // Named separately because it is the exact shape that failed before: it
      // looks like it was understood and was silently dropped.
      const equals = arg.indexOf('=');
      const base = equals === -1 ? null : arg.slice(0, equals);
      if (arg.startsWith('--') && base && Object.prototype.hasOwnProperty.call(FLAGS, base)) {
        throw new Error(FLAGS[base] === 'switch'
          ? `${base} takes no value. Write "${base}" on its own rather than "${arg}".`
          : `${base} takes its value as a separate word. `
            + `Write "${base} ${arg.slice(equals + 1)}" rather than "${arg}".`);
      }
      throw new Error(`unknown argument "${arg}".`);
    }

    if (kind === 'switch') {
      if (arg === '--this-week') out.thisWeek = true;
      else out[arg.slice(2)] = true;
      continue;
    }

    const value = args[i + 1];
    if (value === undefined
      || Object.prototype.hasOwnProperty.call(FLAGS, value)
      || value.startsWith('--')) {
      throw new Error(`${arg} needs a value after it.`);
    }
    i += 1;

    if (arg === '--days') {
      const days = Number(value);
      // Number("seven") is NaN, and every comparison against NaN is false, so
      // an unchecked value here does not narrow the window: it removes it, and
      // a weekly figure silently becomes an all-time one under a header that
      // reads "last NaN days".
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error(`--days needs a positive number, not "${value}". `
          + 'An unusable value here would report every conversation ever recorded '
          + 'as though it were the window you asked for.');
      }
      out.days = days;
      daysWasSet = true;
    } else if (arg === '--since') {
      const since = Date.parse(value);
      if (!Number.isFinite(since) || since > Date.now()) {
        throw new Error(`--since needs an ISO-8601 timestamp that is not in the future, not "${value}".`);
      }
      out.since = new Date(since).toISOString();
    } else {
      out[arg.slice(2)] = value;
    }
  }

  const windows = Number(daysWasSet) + Number(Boolean(out.since)) + Number(out.thisWeek);
  if (windows > 1) {
    throw new Error('--days, --since, and --this-week describe different windows; pass exactly one.');
  }

  return out;
}

function localWeekStart(now) {
  const start = new Date(now === undefined ? Date.now() : now);
  const day = start.getDay() || 7;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1 - day);
  return start.getTime();
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv.slice(2));
  } catch (error) {
    console.error(`pushback: ${error.message}\n`);
    console.error(USAGE);
    process.exit(2);
    return;
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }

  if (args.selftest) {
    const r = selftest(args.fixture);
    if (!r.ok) {
      console.log(r.reason);
      console.log('Create ~/.claude/build-loop/pushback-fixture.json as a JSON array of');
      console.log('objects with "text" (string) and "pushback" (boolean), then run this again.');
      process.exit(1);
    }
    console.log(`Labelled set: ${r.positives} pushbacks, ${r.negatives} not.`);
    console.log(`Caught ${r.caught} of ${r.positives} (${r.catchPct}%).`);
    console.log(`Wrongly flagged ${r.wrong.length} of ${r.negatives} (${r.falsePct}%).`);
    if (r.missed.length) {
      console.log('\nMissed:');
      for (const m of r.missed.slice(0, 20)) console.log('  ' + m.replace(/\s+/g, ' ').slice(0, 90));
    }
    if (r.wrong.length) {
      console.log('\nWrongly flagged:');
      for (const w of r.wrong.slice(0, 20)) console.log(`  (${w.as}) ` + w.text.replace(/\s+/g, ' ').slice(0, 90));
    }
    process.exit(0);
  }

  const fixedWindow = args.since || args.thisWeek;
  const days = fixedWindow ? null : args.days;
  const since = args.since ? Date.parse(args.since)
    : args.thisWeek ? localWeekStart()
      : Date.now() - days * 24 * 3600 * 1000;
  const sinceIso = fixedWindow ? new Date(since).toISOString() : null;
  const result = scan(since, args.root);

  if (args.json) {
    console.log(JSON.stringify({
      days,
      since: sinceIso,
      files: result.files,
      typed: result.typed.length,
      pushbacks: result.pushbacks.length,
      rate: rate(result.pushbacks.length, result.typed.length),
      byKind: result.byKind,
    }, null, 2));
    return;
  }

  const window = fixedWindow ? `since ${sinceIso}` : `last ${days} days`;
  console.log(`Window: ${window}, ${result.files} transcript files.\n`);
  console.log(report(result, { quotes: args.quotes }));

  if (args.quotes) {
    console.log('');
    console.log('This report quotes your own messages because --quotes was passed.');
    console.log('Do not paste it anywhere but here. Run it without that flag for a');
    console.log('version that carries the counts and none of the words.');
  }
}

if (require.main === module) main(process.argv);

module.exports = { classify, userText, scan, report, signals, selftest, rate, localWeekStart, KINDS, parseArgs };
