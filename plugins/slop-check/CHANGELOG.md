# slop-check release notes

Upgrade notes for past versions. Nothing here is needed to install or run the
plugin.

## Upgrading to 0.10.0

**Two structural tells join the soft categories, and three structural questions
are printed beside the reading.** Nothing to change on your side.

A document can pass every sentence-level check and still read as unedited,
because the habits sit above the sentence. The two that now count as
categories: a short sentence that announces a point and leaves it to the next
sentence ("It matters now because of what the change removes."), and a table
column or list said again as a paragraph in another section. Both quote the
lines they rest on.

Three more are printed under "Worth asking about the structure, counted
against nothing" and never move the reading: two or more paragraphs opening on
a very short pronoun sentence, three or more consecutive paragraphs opening
with a bold label sharing its first two words, and an opening that names the
event (a date, the room, the minutes, who co-teaches) under a title that names
a subject. Each of those is also how a sound document can be organised, so the
report asks and the reader decides.

Measured over 213 documents from four repositories, the two categories moved
two readings from "little" to "some", each on a schema whose field table is
restated in a paragraph beside an announcing sentence, and none to "strong". Two detectors that were tried were
left out after that measurement and the reasons are in `scripts/structure.js`.

## Upgrading to 0.9.0

**A third skill, `slide-titles`, writes and repairs slide titles.** Nothing to
change on your side, and nothing about the other two skills or the hook moves.

It makes each title the one thing to remember from its slide, written as a
sentence, so that the titles read top to bottom tell the story of the deck. On
an existing deck it lists every title, gives each a verdict, and proposes a
replacement taken from what the slide's body shows for each title that needs
one. A title that already says something is left alone, and so is the repeated
title of a build. On that deck it reads every slide before judging any title.
An outline or a single slide works without a whole deck. It never invents a
claim the slide does not support, and it does not edit the deck unless asked.

## Upgrading to 0.8.3

**Repeated brochure-style bullet headlines are now reported as a soft writing
signal.** Nothing to change on your side.

A list reports only when two consecutive bullets each begin with a bold
headline built around "that" or "where" and continue with explanatory copy.
Ordinary bold instructions and labels, plain keyword lists, isolated styled
bullets and examples inside code fences stay quiet. The repeated structure can
support a "some" reading on its own, but never a "strong" reading without other
categories beside it.
