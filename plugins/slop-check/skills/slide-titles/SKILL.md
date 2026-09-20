---
name: slide-titles
description: Write or repair slide titles so each one states the takeaway of its slide as a sentence, and the titles alone tell the story of the deck. Use when drafting a deck outline, when the user asks for a title pass or "headline" pass on slides, when titles read like a table of contents, or when the user says a deck's titles are labels, summaries, or boring.
type: human
---

# slide-titles

Make every slide title the one thing the audience should remember from that
slide, written as a sentence. Its sibling `slop-check` reports on writing that
already exists, and `say-it-simply` reshapes an answer. This one does a single
job on a single kind of text: the title line of a slide.

## The core test

Read only the titles, top to bottom, as one paragraph. If someone who never saw
the slides would understand the argument, the titles are done. If they would
hear a table of contents, they are not.

A title that names a topic ("Pricing", "The margin math", "#2 Context") fails
the test even when the slide under it is good, because the reader has to open
the slide to learn what it says.

## Read the whole deck first

Read every slide, title and body, before judging any title. A title can only be
checked against the body it sits on, and the story can only be checked end to
end. Say how many slides were read out of how many exist. Never write or judge
a title from a file name, an outline, or a sample of slides.

## For a new deck: story before slides

1. Write the argument as five to nine plain sentences. Each sentence is the
   claim of one section.
2. For each slide, finish this sentence: "If you remember one thing from this
   slide, it is that ___." What fills the blank is the title.
3. Give the body one job, which is to prove the title: one chart, one table,
   one screenshot, one worked example. If the body does not prove the title,
   change one of them.

## For an existing deck: the title pass

1. List every title in order, numbered by slide.
2. Read the list as a paragraph and mark each title with one verdict:
   **says something**, **names a topic**, **repeats the slide before**, or
   **needs the slide to make sense**.
3. For every title that is not "says something", write a replacement using the
   "one thing" sentence, taken from what the slide's body actually shows.
4. Read the new list as a paragraph again. Fix gaps in the story and claims
   that appear twice.

Return the result as a table: slide number, current title, verdict, proposed
title, and the evidence on the slide that supports it. Then give the full list
of final titles as one paragraph, so the user can run the core test themselves.

## The checks

- **It says something.** A claim, an instruction, or a question the slide then
  answers. Never a label.
- **It has a verb.** A full sentence, not a noun phrase.
- **It is short.** Aim for about eight words. Past fourteen, cut it or split
  the slide in two.
- **Present tense, active voice.** Speak to "you" when the slide asks the
  audience to do something.
- **The number stays in the body.** The title says what the number means, and
  the slide shows the number.
- **At most one stressed word.** One underlined or italic word can carry the
  emphasis. Two is none.
- **A build keeps its title.** When a slide is revealed in steps across several
  slides, the title holds still while the body fills in.
- **No forced line breaks.** Let the title run the width of the slide and wrap
  where it naturally does.

## Three shapes

| Shape | Example |
|---|---|
| The claim | Usage-based pricing protects the margin |
| The instruction | Test your plan against the market before you present it |
| The question the slide answers | Is this team growing, or earning? |

## The two common ways a title goes wrong

**The label on a table.** Tables and worked examples attract label titles
("The margin math"), and the real claim ends up in a banner at the bottom of
the slide or in the speaker's head. Move that sentence up. The title is the
claim, and the table is the proof.

**The label with a subtitle.** A short label as the title, with the claim in a
smaller line underneath, looks tidy and fails the core test, because read
title-only the deck becomes a glossary. Promote the subtitle to the title and
delete the label. If the term itself has to be on the slide, put it in the
body.

## The one-sentence slide

Between runs of evidence, a slide that holds a single sentence or a single
attributed quote, and nothing else, carries the line people repeat afterwards.
Its sentence is its title. Use it for the point of a section, not for
decoration, and no more than once per section.

## Do not invent

A proposed title states only what the slide's body supports. If no claim can be
written from what is on the slide, say so and ask what the slide is for. That is
a finding about the slide, not a title problem. Do not add a number, a name, or
a result the deck does not contain.

## How to use this

With a deck in hand, run the title pass and return the table and the paragraph.
With an outline or an idea, start from the story sentences. With a single slide,
give two or three candidate titles in different shapes and say which one you
would use.

When invoked without a deck, an outline, or a slide, briefly state what the
skill does and ask for one. Do not invent an example deck.

Do not edit the deck itself unless the user asks for the titles to be applied.
A title pass is a proposal until they accept it.

## User-owned preferences

House style belongs outside this shipped skill: a reference deck the user
admires, their own word limits, banned phrases, how they mark emphasis, whether
section openers carry a small topic word. If the user supplies these, follow
the connected product's documented user-owned configuration or memory
mechanism, and let them override the defaults above. The rules in this file
stay neutral for every installer.

## What this is not

It is not a copywriting pass on the body of the slides, and it is not a design
review. A deck can pass this skill and still have slides that are too dense.

It is not an automatic hook. Do not turn it into one without explicit user
approval.
