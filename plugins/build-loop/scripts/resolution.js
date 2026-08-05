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

// Reads any shape this field has ever had and returns one. Null in, null out.
//
// The inference on the first shape is the only guess here, and it is a narrow
// one: those twelve entries carry a commit and a summary, sit on Resolved
// primaries, and record no outcome because the vocabulary did not exist when
// they were written. A commit against a Resolved entry is a fix that was
// applied.
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

  const rawOutcome = typeof resolution.outcome === 'string' ? resolution.outcome.trim() : '';
  let outcome = null;
  if (rawOutcome) {
    outcome = OUTCOMES.has(rawOutcome)
      ? rawOutcome
      : LEGACY_OUTCOMES.get(rawOutcome.toLowerCase()) || null;
  }

  const commit = typeof resolution.commit === 'string' && resolution.commit ? resolution.commit : null;

  // Only when nothing was written in that field, not merely when what was
  // written could not be read. Those are different, and conflating them made
  // this the one place in the module that invents an answer: `{outcome:
  // "reverted", commit: "abc1234"}` came back as `fix_applied`, which is not a
  // lossy reading of "reverted", it is the opposite of it. A typo and a cased
  // variant went the same way, silently, because the enum is matched exactly.
  //
  // An outcome nobody can read stays null now, which is what the rule three
  // paragraphs up already claimed. Null means "closed, cannot say why", which
  // is a real answer, and it leaves the odd spelling visible instead of
  // dressing it up as a fix.
  if (!outcome && !rawOutcome && commit) outcome = 'fix_applied';

  const summary = [resolution.summary, resolution.why]
    .find((s) => typeof s === 'string' && s.trim());

  const at = [resolution.at, resolution.ts, resolution.fixed_at]
    .find((s) => typeof s === 'string' && s.trim());

  return {
    outcome,
    at: at ? at.trim() : null,
    by: typeof resolution.by === 'string' && resolution.by ? resolution.by : null,
    commit,
    duplicate_of: typeof resolution.duplicate_of === 'string' && resolution.duplicate_of
      ? resolution.duplicate_of
      : null,
    summary: summary ? summary.trim() : null,
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

module.exports = { OUTCOMES, LEGACY_OUTCOMES, outcomeList, normalise, problemsWith };
