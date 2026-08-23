#!/usr/bin/env node
// notice-correction.js — UserPromptSubmit.
//
// /flag-issue only runs when somebody remembers to type it, so the queue holds
// the corrections that were noticed and nothing else. This is the noticing
// half. It suggests, it never writes, and it never blocks.
//
// Code routes. The model decides.
//
// The first four versions of this decided in code, with two phrase lists, a
// sentence-splitting rule on one half and not the other, and a growing pile of
// exceptions. Four review rounds found thirteen defects and every one was the
// same shape: a regular expression reading a sentence the way its author
// imagined rather than the way somebody wrote it. Praise read as a complaint.
// A defect in /flag-issue silenced by its own name. A forecast read as a
// confession. A backticked command not recognised as a command. Two unrelated
// sentences joined into one correction.
//
// None of that was unlucky. Whether a sentence is a correction is a judgement
// about language, and the thing here that judges language is the model, which
// also has the conversation the sentence arrived in. The regexes had one field
// and no context.
//
// So the only decision left in code is the gate below, and it is routing
// rather than classification: could this turn plausibly be about something
// built here. It answers a question about topic, not about intent, and when it
// is wrong the cost is a few lines of context nobody sees.
//
// The gate exists at all because the alternative was injecting the policy on
// every prompt of every session. An instruction that is always present
// competes with everything else in context, on turns that have nothing to do
// with tooling.
//
// The known limit, recorded rather than fixed: a correction that names nothing
// buildable does not reach the model as a correction. "That was wrong", on its
// own, after a turn about a hook, is the case. That limit was already there
// when the rule was two phrase lists, so this loses nothing. If it turns out
// to matter, widen the gate or drop it. Do not rebuild a phrase list inside
// it, which is the road this came off.
//
// The field is `prompt`. The published field list calls it `user_prompt`, and
// that name reads as undefined on every event, so this would be inert while
// looking healthy, which is exactly how the injection scanner shipped.
// tests/fixtures/hook-events/UserPromptSubmit.json is a live capture and the
// test asserts against it rather than against itself.

'use strict';

const { readEvent, advise } = require('../scripts/hook-io.js');

// Could this turn involve something built here. Topic, not intent.
//
// The delimiters before the slash matter more than they look. Written as
// `(^|\s)` this accepted `/pickup` bare and rejected `` `/pickup` `` and
// `(/pickup)`, so the more carefully somebody wrote a command, the less likely
// it was to be noticed.
const MAY_INVOLVE_BUILT_TOOL =
  /(?:^|[\s`("'[{])\/[a-z][a-z0-9-]{2,}|\b(?:skill|hook|command|plugin|script)s?\b/i;

// No suppression here for a turn already running a queue command, and that is
// deliberate. Suppressing at the gate produced the worst defect of the four
// rounds: matching `/flag-issue` anywhere silenced "the /flag-issue command
// should have asked before writing" by its own name, which is the one
// correction nobody else can file. The policy carries that rule instead, where
// it can tell invoking a command from talking about one. A few lines of
// harmless context during a real /flag-issue run costs nothing; another early
// return is another edge to get wrong.
//
// The line about a correction having to be the user's is doing more work than
// it looks. Without it this fires on anything true rather than anything asked
// for: running one skill turns up a real defect in a neighbouring one, the
// answer offers to file it, and because the gate routes any turn that mentions
// a skill or a plugin, that happens on most turns of a session about tooling,
// which is most sessions here. Every suggestion was defensible on its own and
// the sum of them was a nuisance the user asked to have switched off. Truth
// was never the bar, and a version of this that only checks truth reads as
// relentless no matter how good each finding is.
//
// The boundary is deliberately not "did the user speak first". Conceding a
// correction inside your own answer, "you're right, the hook should have
// failed open", is the case the corpus has most of, and it belongs here. What
// does not belong is a finding nobody was looking for.
//
// Those two are close enough that the first draft of this let them collapse.
// It said the trigger was the user speaking "or you realising while answering
// that it did", and then said a defect you turned up on your own was not one.
// Realising while answering and turning something up on your own describe the
// same event, so the reader had a rule and its exception with no way to tell
// them apart, and the safe reading of that is to keep flagging, which is the
// behaviour being removed. The trigger now says conceding rather than
// realising: a concession is anchored to something the user said, a
// realisation is not.
//
// "Blocking" is anchored for the same reason. Left bare it is a mood, and the
// same aside reads as blocking on a bad day and trivial on a good one, so the
// boundary drifts between sessions. It means you cannot finish what they asked
// without it fixed, which is a question with an answer.
const POLICY = [
  'The current topic may involve tooling built in this setup. Using the',
  'conversation so far and the answer you are about to give, watch for a real',
  'correction to a skill, hook, command, plugin or script built here.',
  '',
  'That is either the user saying something behaved wrongly, or your own answer',
  'conceding to them that it did.',
  '',
  'It has to be theirs, and those two are the whole list. A defect you turned up',
  'on your own, that they never raised and that your answer is not conceding, is',
  'not a correction however real it is and however sure you are. Raise one of',
  'those only when it blocks what they actually asked for, meaning you cannot',
  'finish without it fixed. Otherwise fix it if the tooling is the work, and say',
  'nothing if it is not.',
  '',
  'If one occurs, suggest `/flag-issue` once, briefly, at the end of your',
  'answer. Do not run it and do not block. Say nothing for plans, questions,',
  'disagreement about facts, ordinary discussion, or when a queue command is',
  'already being invoked. A correction about anything other than tooling built',
  'here is not one of these.',
].join('\n');

readEvent((event) => {
  if (typeof event.prompt !== 'string' || !event.prompt) return;
  if (!MAY_INVOLVE_BUILT_TOOL.test(event.prompt)) return;
  advise('UserPromptSubmit', POLICY);
});
