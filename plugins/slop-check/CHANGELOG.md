# slop-check release notes

Upgrade notes for past versions. Nothing here is needed to install or run the
plugin.

## Upgrading to 0.9.0

**A third skill, `slide-titles`, writes and repairs slide titles.** Nothing to
change on your side, and nothing about the other two skills or the hook moves.

It makes each title the one thing to remember from its slide, written as a
sentence, so that the titles read top to bottom tell the story of the deck. On
an existing deck it lists every title, gives each a verdict, and proposes a
replacement taken from what the slide's body shows. It reads every slide before
judging any title, it never invents a claim the slide does not support, and it
does not edit the deck unless asked.

## Upgrading to 0.8.3

**Repeated brochure-style bullet headlines are now reported as a soft writing
signal.** Nothing to change on your side.

A list reports only when two consecutive bullets each begin with a bold
headline built around "that" or "where" and continue with explanatory copy.
Ordinary bold instructions and labels, plain keyword lists, isolated styled
bullets and examples inside code fences stay quiet. The repeated structure can
support a "some" reading on its own, but never a "strong" reading without other
categories beside it.
