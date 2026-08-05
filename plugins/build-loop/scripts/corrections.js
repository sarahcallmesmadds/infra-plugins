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

'use strict';

// Phrases that say the last turn got something wrong.
//
// Written fresh. The to-build item said the original signal list was already
// tuned against real usage, and a later note records that both originals went
// with hq-skills and are not recoverable, so there was nothing to lift.
//
// Bounded and literal. Nothing here reads sentiment, because a suggestion that
// fires on ordinary disagreement is one that gets ignored, and this runs on
// every prompt of every session.
const SAID_IT_WAS_WRONG = [
  /\bthat (was|is)n?'?t? (wrong|right|correct)\b/i,
  /\bthat'?s not (what|right|correct)\b/i,
  /\bnot what i (asked|wanted|meant)\b/i,
  /\bshould(n'?t| not)? have\b/i,
  /\bwas supposed to\b/i,
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

// The model conceding the point. Narrower on purpose, because agreement is not
// a defect report.
const ADMITTED_IT_WAS_WRONG = [
  /\bi (got that|had that|was) wrong\b/i,
  /\bmy (mistake|error)\b/i,
  /\bi should have\b/i,
  /\bi mis(read|understood|remembered)\b/i,
  /\bthat was (a bug|my bug|wrong)\b/i,
  // The comma is load-bearing and is the whole difference between the two
  // readings. "You're right, the hook should not have fired" concedes a defect
  // and carries on to name it. "You are right that the second quarter was
  // stronger" is agreement about a fact. Requiring the comma separates them on
  // the text itself rather than leaning on the target test below to catch it.
  // Both spellings of the contraction, because writing only `you'?re` missed
  // "you are" entirely, which is how it is written more often than not.
  /\byou('?re| are) right,\s*(the|it|that|and|i)\b/i,
];

// The second signal, and the one that keeps this quiet.
//
// /flag-issue logs corrections against something Sarah built: a skill, a hook,
// a command, a plugin, a script. Correction phrasing alone fires on any
// disagreement about anything, and a suggestion that arrives during a
// conversation about hiring is noise that trains her to ignore the one that
// arrives about a hook.
//
// So a correction has to name something buildable. A slash command, or one of
// those five words. This is the signals-must-stack rule the injection scanner
// already uses, on a much smaller problem.
const NAMES_SOMETHING_BUILT = /(^|\s)\/[a-z][a-z0-9-]{2,}|\b(skill|hook|command|plugin|script)s?\b/i;

// Already reaching for it, so saying so is pure noise.
const ALREADY_FLAGGING = /(^|\s)\/(flag-issue|list-bugs|apply-fix|verify-fix|to-build)\b/i;

const SUGGESTION =
  'That reads like a correction to something in this setup. If it is, `/flag-issue` '
  + 'records it against the skill, hook or command it belongs to, so the fix can be '
  + 'made once rather than remembered. Mention it briefly, take the answer, and do not '
  + 'ask twice in a session or press it if the correction was about something else.';

function looksLikeCorrection(text, phrases) {
  if (typeof text !== 'string' || !text) return false;
  if (ALREADY_FLAGGING.test(text)) return false;
  if (!NAMES_SOMETHING_BUILT.test(text)) return false;
  return phrases.some((re) => re.test(text));
}

module.exports = {
  SAID_IT_WAS_WRONG,
  ADMITTED_IT_WAS_WRONG,
  SUGGESTION,
  looksLikeCorrection,
};
