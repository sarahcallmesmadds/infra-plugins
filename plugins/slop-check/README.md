# slop-check

Catch what nobody edited, and rewrite what did not land, in either host.

The useful question about a piece of work is not whether a machine touched it.
Almost everything has been touched by one, and no tool can honestly tell you
otherwise. The useful question is whether a person with judgement went through
it afterwards, because that is the part that actually went missing.

This looks for the evidence that nobody did.

## Four things

**A hook that holds the line on your own writing.** Em dashes and runs of very
short sentences are blocked in the assistant's output, so it has to rewrite
before the turn ends. These are enforced rather than suggested, because a rule
you have to restate every session is not a rule.

It checks the closing message of each turn, which is what the Stop event hands
it, and since 0.7.0 it checks what a subagent hands back as well. A subagent's
report is often the whole substance of an answer, and it was the longest
writing in a session that nothing read. Of the subagent reports measured on one
machine before that was fixed, four of five broke a hard rule and none were
caught, each carrying 24 to 34 em dashes against one for a typical main-agent
break.

Since 0.8.0 it checks the whole turn rather than only the end of it. A turn that
pauses to run a tool and writes a paragraph first had that paragraph read by
nobody, and on the sessions this was measured against, 18 turns out of 702, or
2.6 per cent, carried a hard rule break sitting only in that unread part.
Replaying all 18 against the new hook catches 16. A block now says which part it
means and quotes the start of it, because a rewrite instruction pointed at the
wrong paragraph reads as a false positive and teaches people the guard is
unreliable. Where both halves break a rule, they are listed separately rather
than added into one number, since the reader has to go to each.

To find where the turn began it reads the last megabyte of the session log,
which covers 99.09 per cent of turns across the 3,938 measured. On a turn bigger
than that the opening prose is not checked, rather than partly checked. That is
what the other two of the 18 are: both ran past a megabyte, at 1.12MB and
1.01MB, so the limit is the one described here rather than a second unknown.
Taking whatever the window happens to begin with would mean blocking somebody
for text from the previous turn, and that is exactly the fault this hook was
rewritten to stop committing: it used to take the whole turn from the session
log, which is written a beat behind the conversation, and it was wrong about
which text it was looking at in 70 of 116 real blocks. Narrower and correct
beats wider and misdirected.

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

**A skill, `say-it-simply`, that rewrites an answer that did not land.** The
other three report on writing that already exists. This one shapes an answer as
it is being produced, which is a different job.

It comes out of reading every message across ten days where the answer drew "I
don't understand", 27 of them out of 2,349. The finding was that the failure is
order rather than length: one answer that drew "confusing" was 212 characters.
So it reorders the answer around what you have to do, using five approved
shapes keyed to the kind of reply. A decision leads with numbered options and a
marked recommendation. A finding leads with the problem and then what it has
cost, including "nothing yet" when that is true.

It also replaces jargon instead of defining it, because a defined term is still
a term you are carrying.

Type `/say-it-simply`, or just push back in your own words. It answers to "in
plain english", "i dont understand", "too much text" and the rest.

There is deliberately no hook on this one. It runs when you ask.

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

A phrase inside quotation marks, a code span or a fenced block does not count.
Quoting a rule is mentioning it rather than using it, and without that exception
the tool blocks any document that writes its own rules down, which is what
happened to a session handoff that printed them verbatim. Bullets, headings and
table rows are still checked. Narrowing on Markdown structure instead was the
simpler repair and would have stopped checking posts written in bullets, which
is most of them, so it is deliberately not what this does.

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

Two of those, **no owner and no date** and **never saying what it is not doing**,
run only when you ask for them with `--technical spec`. See "Asking for the spec
checks" below for why.

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

### Asking for the spec checks

`no owner and no date` and `never saying what it is not doing` are off by
default. Run `--technical spec` to turn them on:

```bash
node scripts/cli.js check --file <path> --technical spec
```

They are absence checks, and an absence only means something where the thing was
expected. Neither is expected in a blog post, a newsletter or an email, all of
which are long, unowned and proposing nothing.

Deciding in code which of those a text was took six review rounds and never
worked. It was wrong in both directions at once, flagging posts that committed
to nothing while staying silent on a real plan with a real missing owner, because
that plan happened to avoid the words on the list. The person running the command
saying what the document is turned out to be the only reliable answer.

So a default run does not report on these, and ends by saying so and naming the
flag. A report with neither finding in it means they did not run, never that the
document passed them. `--technical` on its own, `--technical code` and
`--technical data` all leave them off: the label on the report heading has never
selected which checks run, and it does not select these either.

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

These hooks run in both Claude Code and Codex.

Updating a plugin while a session is already open stops the hooks a second
way, unrelated to finding Node. The session is still pointing at the version
folder it started in, and Codex deletes that folder on update, so every hook in
that session fails until you restart. Each hook now checks that the file it is
about to run is still there. If it has gone, it prints one line saying hooks
are off until you restart, and steps aside. That does not keep the hooks
working, which nothing in the plugin can do from a folder that has been
deleted, but it tells you why they stopped instead of leaving you a bare error
code. If the file is there and has simply lost its execute bit, which a zip
download or a checkout without file modes can do, it says that instead and
names the file, because a restart will not fix that one. The line shows up in
the transcript once per hook per event, and blocks nothing.

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
