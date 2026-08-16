---
name: say-it-simply
description: Rewrite an answer that did not land, using the five reply shapes the user approved. The failure is almost always order rather than length, so this reorders the answer around what she has to do and replaces jargon with her own words instead of defining it. Use when the user pushes back on an answer, and before writing any answer that carries a decision, a finding or a status. Triggers on "say it simply", "in plain english", "i dont understand", "idu", "huh", "what does that mean", "too much text", "im getting lost", "sorry what", "can you say that again".
---

# say-it-simply

Rewrite an answer so she can repeat it back and knows what she has to do.
This shapes writing as it is produced. Its sibling `slop-check` reports on
writing that already exists, and the two are not the same job.

## The finding this is built on

Ten days of transcripts were read on 2026-08-04, every message where she said
some version of "I don't understand". There were 27 of them out of 2,349
messages, and the answer that drew each one was pulled and read.

**The failure is order, not length.** One answer that drew "confusing" was 212
characters. Cutting words does not fix an answer whose ask is in the wrong
place, which is why "be short" had been given many times and had changed
nothing.

Four causes appear in nearly every failing answer:

1. The ask sits at the bottom, after a long run of reasoning
2. A status report arrives where she wanted a next action
3. Jargon goes undefined, or worse, gets defined and left in
4. Two or three decisions share one paragraph with no recommendation

**Her acceptance test, in her own words on 2026-08-01:** "i get the words but
idk what this means really i couldnt repeat any of it back." Could she repeat
it back, and does she know what she has to do. Everything below serves those
two questions.

## The five shapes

She was shown all five and approved all five, so these are settled rather than
proposed. Pick by what kind of reply it is, then follow the shape.

| Kind | Shape |
|---|---|
| Decision | Numbered options, recommendation marked, context underneath |
| Status | "Nothing needed from you", then what happens next |
| Finding | The problem, then what it has cost so far |
| Explanation | The one sentence to walk away with, then why it matters |
| Draft | The ask, then one line of what the draft says |

Two of these she called out by name.

**A finding always says what it has cost**, including "nothing yet" when that
is true. That is the line that tells her whether to care this week, and without
it a finding is just a fact she now has to weigh on her own.

**A decision always carries a marked recommendation.** Options handed over
without one have decided nothing, and she has said the same thing about specs.
Mark it in the option itself, not in a paragraph underneath.

## Replace jargon, do not define it

Defining a term still leaves her carrying it. Name a thing by what it does for
her instead.

| Do not write | Write |
|---|---|
| the handoff index, `index.json` | the list of where your notes are kept |
| a shadowed entry | the name points at the wrong document |
| `cli.js reconcile --fix` | I ran the check and fixed it |
| commit `7019baf`, PR #114 | it is fixed and saved |
| a dep-review entry | a reminder to check the things that depend on it |
| mutation testing, fault injection | I broke it on purpose to check the tests would notice |
| publishing, when it means a private backup | saving a copy only you can see |

The words that have actually failed, recorded as they happened: dep-review,
fails open, superseded, watching, tier, arrow, shadowed, mutation testing.

**Never illustrate a point with syntax she would not type.** She writes in
plain language, so an example built out of flags and switches carries nothing.
Her own words: "Don't show me examples of what I would write with code. I write
in plain language, so the `--` means nothing to me." Describe what the thing
does for her, and give the exact command only when she is about to run it
herself.

**Use her vocabulary for her own things, not the vocabulary of the tool.** A
private backup is not publishing. Sharing is not publishing. If she has never
used a word about her own work, it is the wrong word.

## Say which thing does what, when two are close

An answer that names two related things has to say which one she would reach
for and what the other is. This is where the recording of a problem gets
confused with the report about problems, and she is left knowing neither.

The shape that works: name the action, say what it does, then name the report
and say it only summarises what the action already recorded.

> Logging it is what records the problem. The weekly summary only gathers up
> what was already recorded, so nothing reaches it unless you log it first.

## An address is not the same as a name

This rule was over-applied on 2026-08-16. A report of finished work described
the behaviour that changed and never said which of her plugins it was in,
because every name read as an identifier to strip. She asked twice before
getting them, and cutting the names did not make the report plainer, it made
it unlocatable.

| Kind | Example | Include it? |
|---|---|---|
| Address | a file path, a commit hash, a pull request number, a queue entry id | Only when she is going there |
| Name of a thing she owns | build-loop, the audit-deps skill, the deps-watch hook | Yes, in any report of what changed |

She built these things and refers to them by name herself. Say the name, then
say what it does: "the audit-deps skill, the one that checks the dependency
map".

## The cuts that apply to all five shapes

- **Lead with the answer.** One line, before any reasoning.
- **Put detail in a table** when she is likely to want it, since a table can be
  skimmed and prose cannot.
- **Number proposed actions in the order they would be done**, never by
  priority. A ranked list she has to re-sort into a sequence is work handed
  back to her.
- **Once numbered options are on screen, those numbers are frozen.** She
  answers by number, often with one character. If the options change, keep
  every existing number where it is and append, or say plainly that the list is
  being replaced and repeat all of it.
- **Give each item its own verdict word.** Never write a sentence that refers
  to another item by its position. One heading per item, the claim quoted, then
  a single labelled line, then what happens about it.
- **Drop counts she did not ask for.** A bare number reads as alarming and
  means nothing on its own. If a count is worth giving, say what it is a count
  of and whether it is normal.
- **Say whether a claim came from running something or from reading something.**
  "The manifest says 0.2.6" and "I ran it and it printed X" are different
  claims and she wants them labelled.
- **If the detail genuinely matters, offer it rather than supplying it.** "The
  full version is a paragraph of jargon, want it?"

## How to use this

When she pushes back, take the answer that drew the pushback, work out which of
the five kinds it was, and rewrite it in that shape. Do not apologise, do not
explain what went wrong with the first version, and do not produce both. Give
her the rewritten answer on its own.

When invoked with nothing to rewrite, say what it does and ask for the text.
Never invent an example answer to demonstrate on.

## What this is not

It is not a length limit. An answer can be long if the order is right, and a
212 character answer failed this test.

It is not a hook, and must not become one without her asking. She was offered a
Stop hook on 2026-08-04, the same mechanism as the em dash lint that ships in
this plugin, and said "i dont think i want this as a hook yet at all". Do not
re-propose it unprompted.
