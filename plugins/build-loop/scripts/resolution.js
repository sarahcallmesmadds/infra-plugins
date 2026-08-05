// What happened to a closed entry.
//
// `status` says an entry is closed. `resolution` says what closing it meant,
// and those are different questions. Two of the answers cannot be expressed as
// a status at all: an entry that duplicates another, and one that stopped
// being relevant without anybody deciding against it. Both read as `Won't Fix`
// today, which SCHEMA.md defines as "the user explicitly deferred or declined",
// and neither of them is that.
//
// The field is not new and was not unused, which is worth saying because the
// item that asked for this said it was. Nineteen entries in the real queue
// carry one. What none of them carry is the same shape as each other:
//
//   {commit, fixed_at, pr, shipped_in, summary}   12, Resolved primaries
//   {commit, outcome, ts, why}                     5, Resolved dep-reviews
//   {outcome, ts, why}                             2, Won't Fix primaries
//
// So it was being filled in by hand, three ways, while SCHEMA.md described it
// as a string. This file is one shape and one enum, plus a reader that takes
// all three of those and this one.
//
// Nothing rewrites the entries already on disk. That is the same rule the
// pre-v5 `skill`/`skill_path` fields follow, and for the same reason: a
// migration that half-runs leaves a queue in two formats with no way to tell
// which entries were converted, while reading both shapes forever costs one
// function and cannot half-run.

'use strict';

// What closing an entry can mean. The two on the end are the ones the status
// enum cannot say.
const OUTCOMES = new Map([
  ['fix_applied', 'A change was made and it addressed the correction.'],
  ['no_change_needed', 'Looked at, and nothing needed changing.'],
  ['wont_fix', 'Declined on purpose.'],
  ['duplicate', 'The same thing as another entry, which holds the discussion.'],
  ['obsolete', 'Stopped being relevant. Nobody decided against it.'],
]);

// The spellings found in the real queue, mapped to the enum above. Written out
// rather than normalised by rule, because "no change needed" to
// "no_change_needed" is a rule and "wontfix" to "wont_fix" is not, and a rule
// that is right about one and wrong about the other is worse than a list.
const LEGACY_OUTCOMES = new Map([
  ['no change needed', 'no_change_needed'],
  ['wontfix', 'wont_fix'],
  ["won't fix", 'wont_fix'],
  ['fix applied', 'fix_applied'],
  ['obsolete', 'obsolete'],
  ['duplicate', 'duplicate'],
]);

function outcomeList() {
  return [...OUTCOMES.keys()].join(', ');
}

// Which outcomes a closed status can carry.
//
// `status` and `resolution` answer different questions, which is the reason
// both exist, and that is not the same as them being independent. An entry
// cannot be `Resolved`, which SCHEMA.md defines as a fix applied and verified,
// while also recording that the correction was declined on purpose. Both
// directions of that pair were accepted before this, because the status check
// and the resolution check each looked only at its own field and neither
// looked at the two together.
//
// This is the table already written in verify-fix/SKILL.md, moved into code so
// the document and the gate cannot drift. `Won't Fix` carries three outcomes
// because it is the only closed status that does not claim a fix landed, which
// is what `duplicate` and `obsolete` need from it.
//
// Only the two closed statuses appear here. `Open`, `In Progress` and `fix
// applied, watching` are not closures, and an entry sitting on one of them can
// still carry the resolution of an earlier close saying anything at all.
const STATUS_OUTCOMES = new Map([
  ['Resolved', ['fix_applied', 'no_change_needed']],
  ["Won't Fix", ['wont_fix', 'duplicate', 'obsolete']],
]);

function isClosed(status) {
  return STATUS_OUTCOMES.has(status);
}

// A sentence when the pair contradicts, null when it agrees and null when there
// is nothing to judge. It names the status the outcome does belong with,
// because the useful next move is usually to change the status rather than the
// outcome: the outcome is the finer fact and the one somebody decided.
function disagreement(status, outcome) {
  const allowed = STATUS_OUTCOMES.get(status);
  if (!allowed || !outcome || allowed.includes(outcome)) return null;

  const belongsWith = [...STATUS_OUTCOMES].find(([, list]) => list.includes(outcome));
  return `status ${JSON.stringify(status)} and outcome "${outcome}" say different things`
    + (belongsWith ? `. "${outcome}" goes with ${JSON.stringify(belongsWith[0])}` : '')
    + `. ${JSON.stringify(status)} takes: ${allowed.join(', ')}`;
}

// Reads any shape this field has ever had and returns one. Null in, null out.
//
// The inference on the first shape is the only guess here, and it is a narrow
// one: those twelve entries share the exact five-key shape listed above and
// record no outcome because the vocabulary did not exist when they were
// written. That fingerprint denotes the historical fix even after an entry is
// reopened and its current status is no longer Resolved.
//
// It fires only when the field is empty, never when it holds something this
// module cannot read. Two cases, and they are not the same: nothing was said,
// and something was said that is not understood. Guessing at the second
// overwrote a stated outcome with an inferred one, so `{outcome: "reverted",
// commit: "abc1234"}` read as `fix_applied`.
//
// Anything unreadable, and anything with no commit and no outcome, stays null.
// "Closed and cannot say why" is a real answer, and inventing one hides it.
function normalise(resolution) {
  if (resolution === null || resolution === undefined) return null;

  // A string, which is what SCHEMA.md described until now. No entry on disk
  // has one, but the docs invited it, so it reads as a summary with no outcome
  // rather than as a fault.
  if (typeof resolution === 'string') {
    return resolution.trim()
      ? { outcome: null, at: null, by: null, commit: null, duplicate_of: null, summary: resolution.trim(), extra: {} }
      : null;
  }

  if (typeof resolution !== 'object' || Array.isArray(resolution)) return null;

  const known = new Set([
    'outcome', 'at', 'by', 'commit', 'duplicate_of', 'summary',
    'ts', 'fixed_at', 'why',
  ]);
  const extra = {};
  for (const [k, v] of Object.entries(resolution)) {
    if (!known.has(k)) extra[k] = v;
  }

  // A key this function knows about but does not carry into the result is kept
  // here under its own name, exactly like a key it has never heard of. The
  // alternative is a read that drops something somebody wrote and says nothing,
  // and that happened three ways.
  //
  // `at` has three spellings and `summary` has two. When more than one was
  // present the reader took the first and the rest vanished, so `{at, ts}` came
  // back holding one timestamp with no sign there had been another, and the
  // discarded one was the earlier close.
  //
  // A known key of the wrong type read back as null and was gone with it. A
  // hand-written `commit: true` left no trace at all, and the writer refusing
  // that shape today does not help the entries already on disk.
  //
  // `outcome` was already kept this way and is where the rule comes from. Null
  // answers "which of the five is this" and is not an answer to "what did
  // somebody write".
  //
  // An absent key, an explicit `null` and an empty string are all nothing to
  // keep. The middle one matters: the documented shape writes `"duplicate_of":
  // null` on every resolution that is not a duplicate, and preserving those
  // would fill `extra` with nulls on entries that lost nothing.
  const keep = (key) => {
    const value = resolution[key];
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && !value.trim()) return;
    extra[key] = value;
  };

  // The first of the given spellings that holds text wins, and every other one
  // present is kept.
  const pickText = (keys) => {
    const chosen = keys.find((k) => typeof resolution[k] === 'string' && resolution[k].trim());
    for (const k of keys) if (k !== chosen) keep(k);
    return chosen ? resolution[chosen].trim() : null;
  };

  // A string field the reader requires to be a non-empty string. Anything else
  // reads as null and is kept.
  const pickString = (key) => {
    const value = resolution[key];
    if (typeof value === 'string' && value.trim()) return value;
    keep(key);
    return null;
  };

  const rawOutcome = typeof resolution.outcome === 'string' ? resolution.outcome.trim() : '';
  let outcome = null;
  if (rawOutcome) {
    outcome = OUTCOMES.has(rawOutcome)
      ? rawOutcome
      : LEGACY_OUTCOMES.get(rawOutcome.toLowerCase()) || null;
  }

  const commit = pickString('commit');

  // Anything stated in `outcome` that did not become one of the five is kept,
  // whether it was an unreadable word or not a string at all. An empty or
  // whitespace string is the one case where nothing was said, so there is
  // nothing to keep.
  if (!outcome) keep('outcome');

  // The inference fires only when nothing was written in that field, never
  // when what was written could not be read. Conflating those made this the
  // one place in the module that invents an answer: `{outcome: "reverted",
  // commit: "abc1234"}` came back as `fix_applied`, which is not a lossy
  // reading of "reverted" but the opposite of it.
  //
  // The inference is tied to the exact legacy shape, not to the entry's current
  // status. A resolution is the historical record of the latest close, so an
  // entry reopened from Resolved to Open must still read this old shape as the
  // fix that was applied. Depending on current status made the answer disappear
  // on reopen. Depending on a commit alone was worse: a Won't Fix entry could
  // carry the commit that reverted an attempted fix and be called fixed.
  //
  // All twelve values this compatibility rule exists for carry the same five
  // keys. Requiring that fingerprint confines the inference to those records;
  // a later hand-written object with only a commit and summary stays unknown.
  const legacyAppliedFix = commit
    && typeof resolution.fixed_at === 'string' && resolution.fixed_at.trim()
    && typeof resolution.summary === 'string' && resolution.summary.trim()
    && Object.prototype.hasOwnProperty.call(resolution, 'pr')
    && Object.prototype.hasOwnProperty.call(resolution, 'shipped_in');
  if (!outcome && !rawOutcome && legacyAppliedFix) outcome = 'fix_applied';

  return {
    outcome,
    at: pickText(['at', 'ts', 'fixed_at']),
    by: pickString('by'),
    commit,
    duplicate_of: pickString('duplicate_of'),
    summary: pickText(['summary', 'why']),
    extra,
  };
}

// Checked on write, and only when the write changes the field. That is the
// same rule the status gate follows, and it exists because validating
// unconditionally locked every legacy entry out of being annotated: the
// entries most in need of a note were the ones that could not receive one.
//
// Returns an array of problems, empty when there are none. It does not throw,
// so the caller decides what a problem means.
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return 'an empty string';
  return `a ${typeof value}`;
}

function problemsWith(resolution) {
  if (resolution === null || resolution === undefined) return [];

  if (typeof resolution !== 'object' || Array.isArray(resolution)) {
    return [`a resolution is an object, and this is ${Array.isArray(resolution) ? 'an array' : typeof resolution}`];
  }

  const problems = [];
  const outcome = typeof resolution.outcome === 'string' ? resolution.outcome.trim() : '';

  if (!outcome) {
    problems.push(`no outcome. One of: ${outcomeList()}`);
  } else if (!OUTCOMES.has(outcome)) {
    const legacy = LEGACY_OUTCOMES.get(outcome.toLowerCase());
    problems.push(
      legacy
        ? `outcome "${outcome}" is the old spelling of "${legacy}". Readers still take it; write the new one.`
        : `outcome "${outcome}" is not one of: ${outcomeList()}`
    );
  }

  // The link is the entire reason this outcome exists. Without it a duplicate
  // is just a closed entry, and the discussion it points at is lost, which is
  // what dropping duplicates already did.
  if (outcome === 'duplicate' && !resolution.duplicate_of) {
    problems.push('outcome "duplicate" needs duplicate_of naming the entry that holds the discussion');
  }
  if (outcome !== 'duplicate' && resolution.duplicate_of) {
    problems.push(`duplicate_of is set but the outcome is "${outcome}"`);
  }

  // The types the reader requires, checked by the writer. These two functions
  // are separate and nothing forces them to agree, and they did not: a
  // `duplicate_of` of 42 and a `commit` of true both passed the gate and both
  // read back as null, so the write was accepted and the value was gone. The
  // duplicate case is the worse one, because the link is the entire reason
  // that outcome exists.
  for (const key of ['commit', 'duplicate_of', 'by']) {
    const value = resolution[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.trim()) {
      problems.push(`${key} has to be a non-empty string, and this is ${describe(value)}`);
    }
  }

  // The old spellings, refused on write for the same reason the old outcome
  // words are: readers keep taking what is on disk while writers are pushed to
  // one vocabulary. Writing both names is worse than writing the wrong one,
  // because the reader takes the canonical spelling and the other value becomes
  // a second answer nobody reads. It survives under `extra` now rather than
  // disappearing, which is a record and not a fix.
  for (const [alias, canonical] of [['ts', 'at'], ['fixed_at', 'at'], ['why', 'summary']]) {
    if (resolution[alias] === undefined || resolution[alias] === null) continue;
    problems.push(`${alias} is the old name for ${canonical}. Write ${canonical}, and put anything that does not fit it in a note.`);
  }

  if (typeof resolution.at !== 'string' || !resolution.at.trim()) {
    problems.push('no `at` timestamp');
  }

  // Required, because an outcome on its own says what happened and never why,
  // and six weeks later why is the part nobody can reconstruct.
  if (typeof resolution.summary !== 'string' || !resolution.summary.trim()) {
    problems.push('no `summary` saying what happened in plain language');
  }

  return problems;
}

module.exports = {
  OUTCOMES, LEGACY_OUTCOMES, STATUS_OUTCOMES,
  outcomeList, isClosed, disagreement, normalise, problemsWith,
};
