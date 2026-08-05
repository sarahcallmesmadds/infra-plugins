// What counts as a correction, in one place.
//
// Two hooks use this: one on the way in, one on the way out. They are separate
// files because each event carries different fields and a hook wired to both
// necessarily reads fields the other does not have, which
// hook-event-shape.test.js flags and should flag. That check is the reason the
// injection scanner's silent failure is not repeatable, so weakening it to
// allow one convenient file would be the wrong trade.
//
// The judgement stays here rather than being written out twice. Two copies of
// the same decision drift the moment one of them is refined, and this
// repository has already paid for that once, in the consistency lint where a
// rule scan and an edit test disagreed in both directions at the same time.
//
// Read as a whole rather than patched, after three rounds of review. Every
// finding in those rounds was a pattern that had picked up a reading nobody
// intended, and a fourth layer of exceptions on top of the third is how that
// keeps happening. The comments below record what each rule is for and what it
// was wrong about, because the wrongness is the part that repeats.

'use strict';

// --- the two signals ------------------------------------------------------
//
// A correction needs both: phrasing that says something went wrong, and a
// target that says what. Phrasing alone fires on any disagreement about
// anything, and a suggestion that arrives during a conversation about hiring
// is noise that trains her to ignore the one that arrives about a hook.
//
// This is the signals-must-stack rule the injection scanner already uses, on
// a much smaller problem.

// Something buildable: a slash command, or one of five words.
//
// The delimiters before the slash matter more than they look. Written as
// `(^|\s)` it accepted `/pickup` bare and rejected `` `/pickup` `` and
// `(/pickup)`, which is how a command is written whenever anyone is being
// careful about formatting. So the more precisely somebody wrote it, the less
// likely this was to notice.
const NAMES_SOMETHING_BUILT =
  /(^|[\s`("'[{])\/[a-z][a-z0-9-]{2,}|\b(skill|hook|command|plugin|script)s?\b/i;

// Already reaching for it, so saying so is pure noise.
//
// Anchored to the start, because matching the name anywhere suppressed the one
// correction nobody else can file: a defect in /flag-issue itself. "The
// /flag-issue command should have asked before writing" is exactly what this
// hook exists to catch, and it was the one sentence guaranteed to be ignored.
// Invoking a command and talking about one are different things, and only the
// first is a reason to stay quiet.
const INVOKING_A_QUEUE_COMMAND = /^\s*\/(flag-issue|list-bugs|apply-fix|verify-fix|to-build)\b/i;

// --- what she says on the way in ------------------------------------------
//
// Written fresh. The to-build item said the original signal list was already
// tuned against real usage, and a later note records that both originals went
// with hq-skills and are not recoverable, so there was nothing to lift.
//
// Bounded and literal. Nothing here reads sentiment, because a suggestion that
// fires on ordinary disagreement is one that gets ignored, and this runs on
// every prompt of every session.
const SAID_IT_WAS_WRONG = [
  // Two patterns, not one, and the reason is that the one they replace read
  // praise as a complaint. It was written `that (was|is)n?'?t? (wrong|right|
  // correct)`, where every character of the negation is optional, so the whole
  // `n?'?t?` collapses to nothing and "that is correct, the hook did what I
  // wanted" matched. The suggestion to file a bug then arrived at the exact
  // moment somebody said the thing worked.
  //
  // "wrong" carries the complaint on its own. "right" and "correct" only carry
  // it when negated, so the negation is required there rather than optional.
  /\bthat (was|is) wrong\b/i,
  /\bthat (wasn'?t|isn'?t|was not|is not) (right|correct)\b/i,
  /\bthat'?s not (what|right|correct)\b/i,
  /\bnot what i (asked|wanted|meant)\b/i,
  // The subject is required, and that is what keeps this one usable. A bare
  // `should have` is how people talk about plans and expectations, so it fired
  // on "I should have time tomorrow" whenever a buildable word happened to sit
  // elsewhere in the message.
  //
  // "The script should have finished by now" still matches, and that is left
  // deliberately. It reads as a complaint about a thing she built, the reading
  // is genuinely ambiguous, and this errs toward firing because a suggestion
  // that is occasionally unwanted costs a line while one that never arrives
  // costs the whole feature.
  /\b(you|it|that|this|they|the\b[^.!?\n]{0,30}?) should(n'?t| not)? have\b/i,
  // Both persons. Only the third was written, so "you were supposed to make
  // the plugin ask first" said nothing, and that is the more direct way to
  // phrase a correction of the two.
  /\b(was|were) supposed to\b/i,
  /\bnext time\b/i,
  /\b(from now on|going forward|in future)\b/i,
  /\b(don'?t|do not|never) do that\b/i,
  /\bstop doing\b/i,
  /\byou keep\b/i,
  /\bi told you\b/i,
  // Anchored on a verb rather than on "wrong" alone. Half of real corrections
  // never say the word wrong about the turn, they say it about the output:
  // "/pickup gave me the wrong handoff" is a defect report and matches none of
  // the phrases above. A bare `\bwrong\b` would also catch "is the wrong
  // plugin installed", which is a question.
  /\b(gave|got|used|picked|showed|wrote|opened|returned|loaded) (me |us )?the wrong\b/i,
];

// --- what the answer says on the way out ----------------------------------
//
// Narrower on purpose, because agreement is not a defect report.
const ADMITTED_IT_WAS_WRONG = [
  /\bi (got that|had that|was) wrong\b/i,
  /\bmy (mistake|error)\b/i,
  /\bi mis(read|understood|remembered)\b/i,
  /\bthat was (a bug|my bug|wrong)\b/i,
  // A participle is required after it. Bare `i should have` reads a forecast
  // as a confession: "I should have the plugin ready by tomorrow" and "I
  // should have time to update the plugin" are both plans, and both fired.
  // What follows the phrase is what separates them, a verb meaning something
  // was not done against a noun meaning something is expected.
  /\bi should have (?:been|caught|checked|done|gone|had|kept|known|left|made|read|run|said|seen|sent|set|told|thought|used|written|[a-z]+ed)\b/i,
  // The punctuation is load-bearing and is the whole difference between the
  // two readings. "You're right, the hook should not have fired" concedes a
  // defect and carries on to name it. "You are right that the second quarter
  // was stronger" is agreement about a fact, and stays excluded because it has
  // no punctuation there.
  //
  // Three things here were wrong in three separate rounds, which is why they
  // are spelled out. Writing only `you'?re` missed "you are", which is the
  // commoner spelling. Requiring a literal comma missed the full stop and the
  // dash. Anchoring the punctuation tight against the word missed the dashed
  // form, which is written with a space on both sides. And the subject list
  // stopped at `the|it|that|and|i`, so "you're right, this hook should have
  // failed open" and the same sentence beginning "we" both said nothing.
  /\byou('?re| are) right\s*[,.;:—–-]\s*(the|this|that|it|they|we|and|i)\b/i,
];

const SUGGESTION =
  'That reads like a correction to something in this setup. If it is, `/flag-issue` '
  + 'records it against the skill, hook or command it belongs to, so the fix can be '
  + 'made once rather than remembered. Mention it briefly, take the answer, and do not '
  + 'ask twice in a session or press it if the correction was about something else.';

// --- putting the two signals together -------------------------------------
//
// The two halves differ in one way, and it is not cosmetic.
//
// On the way in, both signals have to land in the same sentence. Without that,
// a buildable word in one sentence and an unrelated expectation in the next
// were read together: "What plugin is this? The meeting should have a room."
// Two unrelated thoughts in one message are the ordinary way people write, so
// this fired often and on nothing.
//
// On the way out, the whole text is read at once, because a concession
// routinely straddles the boundary. "You're right. The hook should not have
// fired." is one thought in two sentences, and the phrase that recognises it
// spans the full stop by design. Requiring one sentence there would undo the
// fix from the round before.
//
// So they are two functions rather than one with a flag. A flag invites the
// wrong default at the call site, and each hook should not have to know which
// rule it needs.

function hasBothSignals(text, phrases) {
  return NAMES_SOMETHING_BUILT.test(text) && phrases.some((re) => re.test(text));
}

function usable(text) {
  return typeof text === 'string' && text.length > 0 && !INVOKING_A_QUEUE_COMMAND.test(text);
}

function saidItWasWrong(text) {
  if (!usable(text)) return false;
  return text
    .split(/[.!?\n]+/)
    .some((sentence) => hasBothSignals(sentence, SAID_IT_WAS_WRONG));
}

function admittedItWasWrong(text) {
  if (!usable(text)) return false;
  return hasBothSignals(text, ADMITTED_IT_WAS_WRONG);
}

module.exports = {
  SAID_IT_WAS_WRONG,
  ADMITTED_IT_WAS_WRONG,
  SUGGESTION,
  saidItWasWrong,
  admittedItWasWrong,
};
