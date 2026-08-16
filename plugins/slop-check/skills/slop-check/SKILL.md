---
name: slop-check
description: Check any work, writing or technical, for the habits that mean nobody edited or reviewed it before shipping. Names the specific lines and says why each one is a problem, so the finding can be acted on or sent back to whoever produced it. Read-only, changes nothing unless asked. Works on drafts, documents, code, charts and data, and scope or spec documents. Triggers on "slop-check this", "does this read like AI", "how AI is this", "did anyone review this", "check this before I send it", "check this PR/doc/deck".
allowed-tools: Read, Write, Edit, Bash(node:*)
---

# slop-check

Report how much a piece of work looks like it was generated and shipped
without anyone editing it, and point at exactly where. Safe tier: this reads
and reports, and changes nothing unless the user asks for a rewrite.

Works the same on the user's own draft and on something somebody sent them.
The question is the same either way: did a person with judgement go through
this. What changes is what they do with the answer, so always give findings
they could either act on themselves or forward to whoever produced it.

## Run it

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js check --file <path>
```

Stdin works when there is no file. `--prose` or `--technical` narrows it to one
half, and `--technical code|data|spec` forces the kind when the guess is wrong.

By default it runs both halves. Whichever half does not apply reports nothing,
which is why one command handles a LinkedIn draft and a pull request equally.

## What it looks for

**Prose.** Hard rules first: em dashes, runs of very short sentences, and
generation artefacts left in the text (`oaicite`, `[cite: 1]`, "As of my last
update"). Artefacts are proof rather than taste, so one is enough.

House rules are phrases the author has ruled out for her own writing, extended
with `bannedPhrases` in the config, and they sit beside the hard rules rather
than inside them. Where the writing is hers, in the Stop hook and in
`--hard-only`, a hit is a standing instruction that was broken, never a
stylistic suggestion, and the fix is to say the thing plainly rather than to
soften the banned phrase. In a report, which is as often about a document
somebody else wrote, they are listed under a heading that says whose rules they
are and counted against nothing. A rule the writer never agreed to is not a
fault in their draft. Then the
softer habits: filler, machine vocabulary, avoiding plain "is" and "has",
participles bolted onto sentence ends, claims sourced to nobody, hedging with
no position, antithesis, lists of three, forced enthusiasm, melodrama, and
sentences that are all the same length.

**Code.** Placeholders that shipped (`your-api-key`, `TODO: implement`), broad
catches that swallow every error, comments restating the line below them,
naming styles fighting inside one file, and everything called `data`, `result`
or `temp`.

**Charts and data.** Numbers too round to be measured, every decimal carried to
the same place, percentages that do not total 100, and default labels nobody
renamed.

**Scope and spec documents.** Generic risk lists, success criteria nobody can
measure, estimates that are all identical or all round, options laid out with
no recommendation, no owner and no date, and TBDs sitting in a document that
presents itself as finished.

That last group matters most. In a spec the tell is not the prose, it is that
the document decides nothing. Options with no recommendation is the single
most common shape of work produced by something with no stake in the outcome.

**Whether the solution is the size of the problem.** Reported separately,
because it answers a different question. Work can be carefully reviewed and
still take a far longer path than it needed, and the reverse.

In code: layers that only forward calls, functions whose whole body delegates
elsewhere, utilities rebuilt that the language already provides, `async` with
nothing to await, classes used only as namespaces, deep nesting throughout.

In a plan: building a framework for a one-off, more phases than the work needs,
more process than work, language reaching for a scale nobody asked for
("enterprise-grade", "fully scalable"), handing the reader back their own
context before getting to the work, and never saying what it is NOT doing.

**That last one is the most useful question to ask of any proposal.** A first
version is defined by what it leaves out. Work that names no cut line has not
been thought about, it has been enumerated. Default to wanting the smallest
version that works, and treat a missing cut line as the finding.

## Reading the result

Never quote a single hit as evidence. Every soft signal here appears in good
human work, which is why the scorer counts distinct categories rather than
total matches. Measured against 68 real documents and 26 real source files
from the user's own repositories, none scored strong, so a strong reading is
signal rather than noise.

The checkable problems are worth far more than the stylistic ones. A shipped
`your-api-key`, percentages that do not add up, or a left-in `oaicite` are
facts you can point at. "Uses the word robust" is not. They are marked hard and
weigh more, but report one on its own as a finding rather than as a verdict.

## How to report it

1. **Lead with the checkable problems.** These are indefensible and specific.
2. **Then the aggregate reading**, in one line.
3. **Then the specific lines**, quoted. "There is filler" is useless.
   "This sentence is the filler" is actionable.
4. **Then one thing to do about it.** If it is the user's own work, offer the
   rewrite. If it is someone else's, give them the single line they could
   actually send, aimed at the missing review rather than at the tool. "This
   reads as unreviewed, the estimates are all identical and nothing names an
   owner" is a sendable sentence. "This is AI-generated" is an accusation, and
   not one this can support.

## When they want it fixed

Offer, do not assume. Replace em dashes with commas, periods, parentheses or a
restructured clause. Cut filler outright. Swap generic vocabulary for the
specific thing meant, "leverage" is nearly always "use". Where the work hedges
symmetrically, ask what they actually think and write that, because a
recommendation is what the reader wanted. Keep their voice: the goal is their
work with the tics removed, not this skill's voice in place of theirs.

## What this is not

It does not detect AI authorship and must never be described as doing so.
Plenty of people write and code this way, and plenty of generated output does
not. It reports patterns, and the honest claim is always "consistent with work
nobody reviewed", never "proves a machine wrote it".
