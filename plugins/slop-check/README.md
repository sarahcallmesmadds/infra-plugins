# slop-check

Catch the habits that mean nobody edited it.

The useful question about a piece of work is not whether a machine touched it.
Almost everything has been touched by one, and no tool can honestly tell you
otherwise. The useful question is whether a person with judgement went through
it afterwards, because that is the part that actually went missing.

This looks for the evidence that nobody did.

## Three things

**A hook that holds the line on your own writing.** Em dashes and runs of very
short sentences are blocked in the assistant's output, so it has to rewrite
before the turn ends. These are enforced rather than suggested, because a rule
you have to restate every session is not a rule.

**A hook that catches a markdown file contradicting itself**, the moment it is
written. It warns and never blocks. Three checks, all of them about the file
and nothing outside it:

| Check | The fault |
|---|---|
| a stated count | "checks four things" sitting above a table of five |
| surviving text | a value corrected here and left standing three lines down |
| a broken own rule | a file that says "no em dashes" and then uses one |

The count fault landed three times in three days here, each time caught by
somebody reading carefully, which is not a control. The surviving-text check
runs on an edit only, because an edit is the only thing that says what the old
text was.

**A skill, `slop-check`, that reads anything.** Your draft, a document someone
sent you, a pull request, a chart, a scope doc. It names the specific lines and
says why each is a problem, so the result is something you can act on yourself
or send back to whoever produced it.

## What it looks for

### Prose

Hard, and worth fixing every time: em dashes, runs of sentences under four
words, and generation artefacts left in the text (`oaicite`, `[cite: 1]`, "As
of my last update"). Artefacts are proof rather than taste. Nobody types
`oaicite` by hand.

House rules are phrases the author has ruled out for her own writing, and one
hit is the whole threshold. A phrase you have decided never to use does not
become a violation on the second use, which is what separates these from the
graded signals below. Add your own with `bannedPhrases` in the config.

They are checked alongside the hard rules and reported apart from them, because
the two answer to different people. The Stop hook and `--hard-only` are looking
at writing that is yours, so a hit there is an instruction you gave being
ignored. A report is as often about a document somebody else sent you, and
telling them their draft is broken by a rule they never agreed to is the report
being wrong rather than the draft. So a report lists them under a heading that
names them as yours and counts them towards no verdict.

Softer, and only meaningful together: filler, machine vocabulary, avoiding
plain "is" and "has" in favour of "serves as", participles bolted onto sentence
ends, claims sourced to nobody, hedging with no position, "not X but Y"
antithesis, lists of three, forced enthusiasm, melodrama, and sentences that
are all suspiciously similar lengths.

### Code

Placeholders that shipped, broad catches that swallow every error, comments
restating the line below them, naming styles fighting inside one file, and
everything named `data`, `result` or `temp`.

Note the narrowness on error handling: `except ValueError: pass` is a decision
by someone who knew which failure they were ignoring. A bare `except:` is
every failure, including the ones nobody thought about, discarded silently.
Only the second is flagged.

### Charts and data

Numbers too round to have been measured, every decimal carried to the same
place, percentages that do not total 100, and default labels nobody renamed.

### Scope and spec documents

Generic risk lists, success criteria nobody can measure, estimates that are all
identical or all round, no owner and no date, TBDs in a document presented as
finished, and options laid out with no recommendation.

That last one is the most useful signal in the whole plugin. In a spec, the
tell is not the prose. It is that the document decides nothing, which is the
shape work takes when whatever produced it had no stake in the outcome.

### Whether the solution is the size of the problem

Reported separately, with its own reading, because it answers a different
question. Work can be carefully reviewed and still take a much longer path
than it needed, and the reverse is just as common.

**In code:** layers that only forward calls, functions whose whole body
delegates elsewhere, utilities rebuilt that the language already has, `async`
with nothing to await, classes used only as namespaces, deep nesting
throughout.

**In a plan:** building a framework for a one-off, more phases than the work
needs, more process than work, reaching for a scale nobody asked for
("enterprise-grade", "fully scalable", "production-ready"), handing the reader
back their own context before getting to the work, and **never saying what it
is not doing**.

That last check is the most useful question to ask of any proposal. A first
version is defined by what it leaves out, so work that names no cut line has
not been thought about, it has been enumerated.

## How to read a result

Distinct categories, never a single hit. Every soft signal here appears in
good human work, and treating one "robust" as evidence produces nonsense.

Measured against 68 real documents and 26 real source files from the author's
own repositories: none scored strong. Deliberately sloppy samples of both kinds
score strong. Adding nine new soft categories did not move the false-positive
rate at all.

Splitting the copular contrast into its own category moved one document of the
41 in this repository from "little" to "some", on a real hit rather than a
false one. That measurement is worth repeating whenever a category is added,
because the first version of this change also added a reversed-order contrast
pattern, and that one carried the contrast category onto 16 of the 41 before it
was withdrawn.

The checkable problems are worth much more than the stylistic ones. A shipped
`your-api-key`, percentages that do not add up, or a left-in `oaicite` are
facts. "Uses the word robust" is an opinion. Those facts are marked hard and
weigh more heavily, but one on its own still reads as "some" rather than a
verdict, because a single placeholder can be a genuine template.

## A known blind spot

It cannot tell a document **about** these patterns from a document **exhibiting**
them. Run it on a style guide, a linter config, a security checklist, a code
review rubric, or a writing-rules file, and it will flag the examples those
documents quote on purpose.

This plugin fails its own check for exactly that reason. `patterns.js` is a list
of machine-writing tells, so it reads as full of machine-writing tells. The
README breaks the hard rules by writing `oaicite` while explaining that
`oaicite` is a giveaway. The files that do the work come back clean.

So: on a document whose subject is writing quality, ignore the result.

## Install

```
/plugin marketplace add sarahcallmesmadds/infra-plugins
/plugin install slop-check@smadds
```

Add the marketplace **by repository**, as above. Adding it by pasting a direct
URL to `marketplace.json` downloads only that file, the plugin folders never
arrive, and the install fails.

**Requires Node.js.** The hooks are plain Node scripts with no dependencies
to install, and `node` does not have to be on your `PATH`. Each hook is
started by `bin/hook-node`, which tries `$CLAUDE_HOOK_NODE`, then your
`PATH`, then `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and
`/usr/bin`, and uses the first one it finds.

That list exists because an app launched from the Dock never reads your shell
profile, so it starts with a bare `PATH` that has none of those directories
on it. Before 0.3.2 every hook here exited 127 under Codex for that reason,
and silently, because a failed hook does not interrupt your session.

If your Node is somewhere else, name it:

```
export CLAUDE_HOOK_NODE=/path/to/node
```

Name the node program itself, not the directory holding it. When that variable
is set it is the only interpreter tried, and a value that is not an executable
file is an error rather than a reason to look elsewhere. Naming an interpreter
and silently getting a different one hides the mistake, and a directory passes
an executable check while starting nothing.

## Configuration

Works with no configuration. To change something, create
`~/.claude/slop-check.config.json`. Keys are merged over the defaults one at
a time, so setting one does not reset the others.

```json
{
  "allowEmDash": false,
  "choppyRunLimit": 3,
  "enforce": true,
  "houseRules": true,
  "bannedPhrases": []
}
```

Set `enforce` to false to keep the skill and turn the hook off, for when you
are deliberately drafting something that needs the forbidden shapes.

`bannedPhrases` is added to the built-in house rules rather than replacing
them, so adding one phrase later cannot quietly drop the rest. Matching is on
lowercased text by substring, so keep each entry to the shortest distinctive
form. Set `houseRules` to false to turn that check off on its own and leave the
other hard rules running.

## What this is not

**It does not detect AI authorship**, and should never be described as though
it does. Plenty of people write and code this way without help, and plenty of
generated work has been carefully edited. The honest claim is "consistent with
work nobody reviewed", never "proves a machine wrote it".

Aimed at the missing editor, not at the tool. "You own what ships under your
name" is a fair thing to say to someone. "A robot wrote this" is an accusation
this cannot support.

## Sources

The prose catalogue draws on Wikipedia's [Signs of AI
writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) project
page, which is the most thorough public list and tracks per-model citation
artefacts, and on The Algorithmic Bridge's [ten
signs](https://www.thealgorithmicbridge.com/p/10-signs-of-ai-writing-that-99-of).
The technical checks are not drawn from either; nothing comparable seems to
exist for code, charts and specs.

## Licence

MIT. See `LICENSE` at the repository root.
