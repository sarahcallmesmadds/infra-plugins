# slop-check release notes

Upgrade notes for past versions. Nothing here is needed to install or run the
plugin.

## Upgrading to 0.11.0

**Four more soft categories, one more question, and HTML comments are no longer
read as prose.** Nothing to change on your side.

The new categories come from drafts that were rejected while every check
passed. An empty bridge sentence asserts a link the reader can already see and
adds no word the two sentences before it did not have ("This agenda is built
around that same question."). The negating reversal now also catches the
version split over two sentences ("It isn't a skills day. It's about deciding
when nobody's certain."). A mirrored closer pairs "One is..." with "The other
is..." on the same opening and closing words. A fragment beat is a two to five
word sentence such as "And the people." A run of three paragraphs that each
open on a name and "on X, because" counts as one more.

Three or more sentences of eight to fourteen words, within three words of each
other in one paragraph, print as a question with the sentences quoted. As a
counted category that shape fired on 56 of 697 documents and moved 17 readings
on its own, because plain instruction prose reads that way.

Text inside an HTML comment, whole-line, inline or spanning lines, and inside a
tilde fence is now hidden from every lexical check and from the choppy-run rule
the hook enforces. A draft note left in a comment could raise a reading, or
block a reply, on a document whose visible text was clean.

Measured over 697 Markdown documents in five repositories, two readings moved
from "little" to "some", each on a sentence checked by hand, and none to
"strong".

## Upgrading to 0.10.0

**Two structural tells join the soft categories, and three structural questions
are printed beside the reading.** Nothing to change on your side.

A document can pass every sentence-level check and still read as unedited,
because the habits sit above the sentence. The two that now count as
categories: a short sentence that announces a point and leaves it to the next
sentence ("It matters now because of what the change removes."), and a table
column, bullet list or run of bold paragraph labels whose items are said again
in a paragraph, list or column of another section. Both quote the lines they
rest on.

Three more are printed under "Worth asking about the structure, counted
against nothing" and never move the reading: two or more paragraphs opening on
a very short pronoun sentence, three or more consecutive paragraphs opening
with a bold label of which at least two share their first two words, and an
opening that names the
event (a date, the room, the minutes, who co-teaches) under a title that names
a subject. Each of those is also how a sound document can be organised, so the
report asks and the reader decides.

Measured over 213 documents from four repositories, the two categories moved
three readings from "little" to "some", each on a list or field table restated
in a paragraph beside a category that was already there, and none to "strong". Two detectors that were tried were
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
