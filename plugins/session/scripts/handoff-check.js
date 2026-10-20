// Measures a handoff draft against what a thread's document is meant to be:
// the current state of a subject, not a log of every session that touched it.
//
// The wrap skill already says "current state, not a log", and thread handoffs
// grew anyway, one dated paragraph per session stacked under "What was worked
// on". A rule nobody measures is advice. This is the measurement, run on the
// draft before it is saved.
//
// Every flag here is structural on purpose: dated paragraphs, dated headings,
// repeated session lines, word counts, dated rows in the files table. None of
// them reads the prose to decide what it means. Whether a constraint is still
// true this week is a judgement, and judging language with a pattern has failed
// in this repository every time it was tried, so that stays in the skill.
//
// Read-only. It never writes the draft or anything else.

'use strict';

const fs = require('fs');

const { withoutFences, headerOf } = require('./handoffs');

const DEFAULT_BUDGET = {
  // Off by default: a check that refuses most real handoffs on its first day
  // gets switched off, and then nothing measures them at all. The numbers are
  // reported either way, so turning this on is a decision made against them.
  enforce: false,
  bodyWords: 1500,
  sectionWords: 600,
  workedOnWords: 80,
};

// The two sections that hold rules. Excluded from the body total because
// their size is a separate question from whether the narrative has turned
// into a log: a thread with forty standing rules is not a long handoff in the
// sense this check is about.
const CONSTRAINTS = 'constraints still in force';
const STANDING = 'standing rules';

const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const ISO_ALL = /\b\d{4}-\d{2}-\d{2}\b/g;

function budgetFrom(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const out = { ...DEFAULT_BUDGET };
  if (typeof raw.enforce === 'boolean') out.enforce = raw.enforce;
  // A number that is not a positive integer would make every section either
  // pass or fail regardless of its size, so it is ignored, not honoured.
  for (const k of ['bodyWords', 'sectionWords', 'workedOnWords']) {
    if (Number.isInteger(raw[k]) && raw[k] > 0) out[k] = raw[k];
  }
  return out;
}

function words(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

// Splits on level-two headings only. A `###` inside a section belongs to it:
// the standing rules section carries its areas that way, and splitting there
// would report each area as a section of its own.
// Headings inside a fenced block are examples, not sections: one there either
// hid the narrative after it under a fake rule section or exposed real rules
// to the body cap. The fence decides where sections split; the words counted
// are the document's own, fences included.
function sections(text) {
  const raw = String(text).replace(/\r\n/g, '\n').split('\n');
  const bare = withoutFences(text).split('\n');
  const out = [{ heading: null, lines: [] }];
  raw.forEach((line, i) => {
    const m = /^##\s+(.+?)\s*$/.exec(bare[i]);
    if (m) out.push({ heading: m[1], lines: [] });
    else out[out.length - 1].lines.push(line);
  });
  // A heading written twice is one section. Measured separately, a short
  // first copy let a long second one escape its cap.
  const merged = [];
  for (const s of out) {
    const prior = s.heading && merged.find((x) => x.heading && x.heading.trim().toLowerCase() === s.heading.trim().toLowerCase());
    if (prior) prior.lines.push('', ...s.lines);
    else merged.push({ heading: s.heading, lines: [...s.lines] });
  }
  return merged.map((s) => ({ heading: s.heading, body: s.lines.join('\n') }));
}

function key(heading) {
  return String(heading || '').trim().toLowerCase();
}

// The date the handoff describes: its Last session line when it has one,
// otherwise its Date line. Used only to tell a dated row from an older one.
function handoffDate(text) {
  // From the header only, fences blanked, like the other header readers: an
  // example date further down made every real dated paragraph look future.
  const head = headerOf(text);
  const last = /^\*\*Last session:\*\*\s*(.*)$/mi.exec(head);
  const fromLast = last && ISO.exec(last[1]);
  if (fromLast) return fromLast[0];
  const date = /^\*\*Date:\*\*\s*(.*)$/mi.exec(head);
  const fromDate = date && ISO.exec(date[1]);
  return fromDate ? fromDate[0] : null;
}

function paragraphs(body) {
  return String(body).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function checkText(text, budget = DEFAULT_BUDGET) {
  const all = sections(text);
  const flags = [];
  const date = handoffDate(text);

  const rows = all.map((s) => ({ heading: s.heading, words: words(s.body) + (s.heading ? words(s.heading) : 0) }));
  const total = rows.reduce((n, r) => n + r.words, 0);
  const isRules = (h) => key(h) === CONSTRAINTS || key(h) === STANDING;
  const body = rows.filter((r) => !isRules(r.heading)).reduce((n, r) => n + r.words, 0);

  // A log, measured three ways, each of which is what a rewrite in place does
  // not produce: two Last session lines, two dated paragraphs describing what
  // was worked on, or two dated headings.
  // Only dates on or before the handoff's own count: a paragraph naming a
  // date still to come is a plan, not a record of a session.
  const bare = withoutFences(text);
  const past = (s) => (s.match(ISO_ALL) || []).some((d) => !date || d <= date);
  const lastLines = (bare.match(/^\*\*Last session:\*\*/gmi) || []).length;
  const worked = all.find((s) => key(s.heading) === 'what was worked on');
  // Distinct dates, not paragraphs: one session told in two paragraphs that
  // both name today is one entry. A log carries a different date per session.
  const pastDates = (p) => (p.match(ISO_ALL) || []).filter((d) => !date || d <= date);
  const datedParas = worked
    ? new Set(paragraphs(withoutFences(worked.body)).filter(past).map((p) => pastDates(p)[0])).size
    : 0;
  const datedHeadings = bare.split('\n')
    .filter((l) => /^#{2,6}\s/.test(l) && past(l)).length;
  const entries = Math.max(lastLines, datedParas, datedHeadings);
  if (entries > 1) {
    flags.push({
      kind: 'log',
      count: entries,
      detail: `${entries} dated session entries; a thread's handoff holds the current state, so fold them into one`,
    });
  }

  if (worked) {
    const w = words(worked.body);
    if (w > budget.workedOnWords) {
      flags.push({ kind: 'worked-on-long', section: worked.heading, words: w, limit: budget.workedOnWords, detail: `"What was worked on" is ${w} words, over ${budget.workedOnWords}` });
    }
  }

  // Only rows that carry a date older than the handoff's own are counted. A
  // row with no date cannot be told apart, so it is not guessed at.
  const files = all.find((s) => key(s.heading) === 'files created or changed');
  if (files && date) {
    // The first column is the file, and a dated filename says when the file
    // was named, not which session touched it. Only the other cells count,
    // and only a date standing on its own there.
    const older = files.body.split('\n')
      .filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
      .filter((l) => {
        const cells = l.trim().replace(/^\||\|$/g, '').split('|').slice(1).join(' ');
        return (cells.match(/(?<![\w./-])\d{4}-\d{2}-\d{2}(?![\w/-])/g) || []).some((d) => d < date);
      });
    if (older.length) {
      flags.push({ kind: 'old-file-rows', section: files.heading, count: older.length, detail: `${older.length} row${older.length === 1 ? '' : 's'} in "Files created or changed" dated before ${date}; list this session's files only` });
    }
  }

  if (body > budget.bodyWords) {
    flags.push({ kind: 'body-long', words: body, limit: budget.bodyWords, detail: `the body is ${body} words without the two rule sections, over ${budget.bodyWords}` });
  }

  // Standing rules are exempt: that section is meant to hold every rule the
  // thread keeps, and its length is measured by reading it, not by this cap.
  for (const r of rows) {
    if (!r.heading || key(r.heading) === STANDING) continue;
    if (r.words > budget.sectionWords) {
      flags.push({ kind: 'section-long', section: r.heading, words: r.words, limit: budget.sectionWords, detail: `"${r.heading}" is ${r.words} words, over ${budget.sectionWords}` });
    }
  }

  return {
    date,
    total,
    body,
    sections: rows.filter((r) => r.heading).map((r) => ({ heading: r.heading, words: r.words })),
    flags,
    budget,
  };
}

function checkFile(file, budget) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, file, error: `${file} could not be read: ${e.message}` };
  }
  return { ok: true, file, ...checkText(text, budget) };
}

module.exports = { DEFAULT_BUDGET, budgetFrom, checkText, checkFile, sections };
