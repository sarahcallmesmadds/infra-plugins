# build-loop release notes

Upgrade notes for past versions, moved out of the README so that file says what
the plugin is and how to use it. Nothing here is needed to install or run it.

## Upgrading to 0.10.14

**`/devin-review-response` recovers a hidden finding instead of stopping to ask
for it.** Nothing to change on your side. The skill used to stop whenever
Devin's web interface held findings the API had not returned, and wait for you
to open the app and paste them back. It now runs the CLI against the same commit
first and only asks if that returns nothing or refuses.

Two things it now tells the reader, both of which cost a real session:

- Read the review body, not the check status. A green check has sat above a body
  reporting findings.
- A clean round is evidence for the commit it ran against and no other, so
  re-run it on the final head. Commits answering earlier findings are exactly
  where the next one turns up.

One case still stops to ask you, on purpose. If the CLI refuses because the
directory has not been trusted, the flag that skips that check is documented in
the skill but deliberately not pre-approved, so you get to say yes.

## Upgrading to 0.10.13

**`/whats-breaking` is now `/flag-patterns`.** The old command no longer exists.
Nothing else changed: same report, same weekly cadence, same file at
`~/.claude/build-loop/summaries/YYYY-WW.md`.

The old name was a question rather than a thing, and it did not say that the
output is a report about patterns. The new one sits next to `/flag-issue`, which
is the command it belongs with: `/flag-issue` records one correction as it
happens, and `/flag-patterns` reads the accumulated corrections once a week and
names the targets that keep coming back.

You do not have to change how you ask for it. The phrases that reach it are
unchanged, including "what keeps breaking" and "what's breaking". Only the slash
command is different.

If you scheduled the old name, update the job. Note that this report can only run
on a local machine: a cloud runtime cannot see `~/.claude/` and will report
success having read nothing.

Entries in this file for versions before 0.10.13 still say `/whats-breaking`,
because that is what the command was called at the time.

## Upgrading to 0.10.0

Nothing to do on upgrade. Two rules that the documents claimed and the code did
not are settled, in opposite directions: one was dropped from the code, the
other from the documents.

**`deps-watch` no longer writes anything.** It used to stamp a machine-check
date, `last_auto_checked`, onto a map entry after any edit that added no new
dependency. That field's only reader was the session brief's drift line, removed
in session 0.8.7, so the write had gone nowhere for a while. The field, the code
that wrote it, and the lock that existed only to guard that one write are all
removed. What the hook still does is the half worth having: when an edited file
calls something the map does not record, it says so in the conversation.

Three things follow, and none of them need action. The plugin no longer touches
`DEPS.json` outside `/audit-deps`, so an ordinary save cannot contend with an
audit for that file. There is one lock implementation in this plugin now rather
than two that could drift, which closes the duplication behind queue entry
`2026-08-08T02-20-54-deps-refs`. And a map entry no longer records that anything
looked at it between audits, which is correct: the hook read what a file
mechanically calls, and that was never evidence a person had judged the edges.

**`dependents` is direct-only, and now says so.** The schema claimed since v1
that transitive dependents were tracked, meaning that if A depends on B and B
depends on C then A appears in C's dependents. Nothing ever implemented it. It
is retracted rather than built, because `/flag-issue` writes one dep-review per
dependent, so storing the closure would fan reviews across most of a repository
every time a shared module was corrected.

One distinction survives the retraction and matters if you ever read that code:
generation is direct-only, but **acceptance is not**. A `dependents` row that
only a chain explains is still valid, and `/audit-deps` still walks forward
edges before calling a row one-sided. Without that, it would offer to "repair" a
correct indirect relationship by inventing a direct edge.

**`DEPS.json` moves to schema v5** and no migration is needed. A pre-v5 map may
carry `last_auto_checked` on some entries; it is ignored, and the next
`/audit-deps` run drops it. No `dependents` row changes meaning: every row in
the live map was already explained by a direct edge when the rule changed, so
it reclassifies nothing. SCHEMA-DEPS.md carries that measurement and is the
only place it is written down.

## Upgrading to 0.9.9

Documentation only. No behaviour in this plugin changes, and nothing needs doing
on upgrade.

**The drift warning is gone, and two documents here still described it.** Session
0.8.7 removed it from the session brief. It compared a file's modification time
against `last_updated` and, on 2026-08-15, reported 82 of 127 entries as changed
with nothing actually missing, because `last_updated` is a human review date that
is deliberately never bumped by machine. An entry reviewed once and edited since
counted as drifted forever, so the number only grew and the line was always on.
The brief now reports only an entry whose file is gone, which is a fact somebody
can act on in one command.

**What that means here.** `last_auto_checked` had no reader. The brief was its
only one: `deps-refs.js` wrote it, and `/audit-deps` carried it through while
its own skill said explicitly never to compare against it. `SCHEMA-DEPS.md` said
the brief read it, which is the sharper error of the two, since a schema
reference is where somebody goes to learn what is true.

**What still holds, and it is the half worth having.** `deps-watch` reporting a
file that calls a mapped target with no recorded edge is untouched and is the
reason the hook earns its place. Only the silent stamping lost its purpose.

**Since decided: the field is gone.** Whether `deps-watch` should keep writing a
field nothing reads was left open here and answered on 2026-08-15. It should
not. The field, its writer, and the second lock implementation that existed only
to guard that one write were all removed together, `DEPS.json` moved to schema
v5, and `deps-watch` became read-only. A map written before v5 may still carry
the field on some entries; it is ignored and the next `/audit-deps` run drops
it.

## Upgrading to 0.9.0

> **Partly superseded by session 0.8.7.** The drift warning described below no
> longer exists. Quieting it was the stated purpose of the `last_auto_checked`
> stamp, so that half of this section is now history rather than behaviour.
> Everything about what `deps-watch` reports in the conversation still holds, and
> that was always the more useful half. See "Upgrading to 0.9.9" above.

The dependency map now keeps itself current for ordinary edits, and the drift
warning finally means something. **The second half of that no longer applies.**
Session 0.8.7 removed the warning rather than sharpening it further, so what
survives from this release is the first half, the map keeping itself current.

**What was wrong.** The session brief called a target drifted when its file had
been modified more recently than the date its entry was confirmed. Any edit
tripped it: a typo, a comment, a test tweak. On 2026-08-07 it reported 12
changed targets, and checking each one by hand found that all 12 already
recorded the right dependencies. The warning had never once been real, so it was
correctly ignored every session, and the edit that does move a dependency
produces an identical-looking line.

**What replaces it.** `deps-watch` runs after any Write or Edit. When the file
is in the map, it reads what the file now actually calls and compares that to
the recorded edges.

| Outcome | What happens |
|---|---|
| Nothing new appeared | `last_auto_checked` is stamped, silently. No warning accumulates. **Both halves are now history: the warning meant here was removed in session 0.8.7, and the stamp itself was removed in schema v5. Nothing happens on this branch at all.** |
| The file calls a mapped target with no recorded edge | It says so in the conversation and does **not** stamp, so the drift stays visible until `/audit-deps` records the edge. **"Stays visible" meant the brief's drift line, which is gone, and there is no stamp left to withhold. What stays visible is the report in the conversation, which is the half that still works and is now the whole hook.** |

**Two dates, kept apart.** **There is one date now: schema v5 removed the
second, and the hook writes neither.** As shipped in 0.9.0 the hook wrote
`last_auto_checked` and never
`last_updated`. `last_updated` is the review date, and `/audit-deps` compares it
against the file's modification time to decide an entry is stale and may need
its dependencies worked out again. Writing a machine check into that field
would have emptied that bucket: the hook cannot see a dependency that no call
expresses, one thing reading a file another writes, so an edit adding one would
have left the entry looking freshly reviewed and it would never have come up
again. The map's own top-level `last_updated` is left alone for the same reason.

**It yielded rather than overwrote, and now there is nothing to yield.** As
shipped in 0.9.0 the hook took a lock, wrote through a temporary file, and
compared the map before renaming, so that edges approved mid-write were never
overwritten by a stamp. **All of that went with the stamp in schema v5.** The
hook does not open the map for writing at all, which removes the race rather
than handling it. See "Upgrading to 0.10.0" above.

**It reports one direction only, on purpose.** A call with no recorded edge is
dangerous, because `/flag-issue` reads the map to decide what a fix puts at
risk, so a missing edge means a dependent never gets reviewed. The reverse, a
recorded edge with no visible call, is usually correct: plenty of real
dependencies are semantic, `/apply-fix` reads what `/flag-issue` wrote and
neither file names the other. Extraction cannot see those, and reporting them as
gone would rebuild the false alarms this removes. A clean result means "nothing
new appeared", never "the map is complete". `/audit-deps` still judges that.

**What counts as a call** is only what is mechanically certain:

| File | What is read |
|---|---|
| `.js` | A `require()` of a relative path that resolves on disk, and a `path.join()` or `path.resolve()` built entirely from string literals that resolves on disk. The second form is how a test suite names its subject: it spawns the thing it tests rather than importing it, so `const HOOK = path.join(__dirname, '..', 'plugins', 'guardrails', 'hooks', 'bash-guard.js')` is the only written record of the dependency. The first segment has to be `__dirname` or a const already resolved the same way, and every later segment has to be a literal, so a fixture path starting at `os.tmpdir()` is dropped rather than guessed at. Both `<path>` and `<path>.js` are tried, since `require(path.join(ROOT, 'scripts', 'hook-io'))` is how every hook here reaches its modules and node resolves it. |
| `.md` | A `scripts/<name>.js` inside a fenced code block, which is how a skill invokes one. A `plugins/<other>/` written in front of it resolves to that plugin, since `hook-io.js`, `cli.js`, `config.js` and `patterns.js` each exist in more than one plugin here. |
| `hooks.json` | The `hooks/` and `scripts/` paths named in each `command`. |

Prose is excluded deliberately. `queue.js` names `roots.js` in a line comment
and never calls it, and a text search would have called that a dependency,
reproducing the exact problem being fixed. That case is pinned in
`tests/deps-watch.test.js`.

**Where the old warning can still appear, deliberately.** **It cannot appear
anywhere now: session 0.8.7 removed it. Read "stays drifted" below as "is left
unstamped", which is what it always meant underneath and is still exactly what
happens.** The rule survives the warning and still matters, because `/audit-deps`
is where an unstamped entry now surfaces.

The hook stamps only a file it could actually read. Three cases stay drifted on
purpose, because in each of them nothing was checked and saying otherwise would
be a lie the map cannot recover from:

- A mapped target nothing can be read from, which today means the six
  `plugin.json` manifests, and any `SKILL.md` living outside a plugin, which is
  where the default roots put every one of them.
- A `hooks.json` that will not parse. Unreadable is not clean.
- Any edit made outside Write and Edit: a shell `sed`, a `git checkout`, an
  external editor.

There is a fourth case that does not stay drifted, and it is worth naming rather
than leaving to be discovered. A `.js` file whose references are genuinely
computed, a path assembled at run time from a variable rather than from
literals, reads as clean and gets stamped. `plugins/session/statusline/install.js`
is the one example here: it depends on `statusline.js` by generating a shim that
requires it, and no path in its own source names the file. That is the same
semantic dependency extraction has never been able to see, so it is bounded by
the paragraph above rather than by this list. It is called out because the
literal-path reading added in 0.9.0 closes the mechanical cases and could
otherwise be mistaken for closing all of them.

The first two are the difference between "checked, nothing new" and "could not
check". Collapsing them is what made an early version of this hook mark files as
verified that it had never opened. The third is a real gap, and retiring the
brief's mtime comparison outright belongs with the Session plugin.

**Superseded: this release was described as Claude Code only, on the belief that
Codex does not run plugin hooks. It does.** See the Codex section below.

**`DEPS.json` moves to schema v4.** The only change is the new
`last_auto_checked` field, which is simply absent on an older map, so nothing
needs migrating and older readers are unaffected. **Superseded: v5 removed that
field again, on 2026-08-15, once it was clear nothing read it.**

This release originally also required Session 0.8.1, which was what taught the
brief to read the new field. **That requirement is void.** Session 0.8.7 removed
the reading altogether, so no version of Session does anything with
`last_auto_checked` and there is no drift line left to fire. Pinning Session on
account of this paragraph buys nothing.

Corrected here rather than left to the banner at the top of this section. That
banner gives context, and this was an instruction: a reader following it acts,
and context above the fold does not undo a sentence telling somebody to install
something.

Nothing else to do on upgrade. The hook registers itself and stays quiet.

## Upgrading to 0.8.1

`/address-devin-review` is now `/devin-review-response`, paired by name with
the planned `/devin-review` persona reviewer. Update saved prompts and muscle
memory to use the new command; the old command name is not retained as an alias.

## Upgrading to 0.3.1

One fewer status. `fix attempted / unresolved` is retired.

Rejecting a fix at the verify gate used to move the entry to that status. It
means "the fix did not land and the file is unchanged", which is an open bug by
any reading, and **no `/list-bugs` filter reached it.** Not the default, not
`open`, not `in progress`. So saying no to a diff removed the entry from every
view that lists outstanding work. It stayed on disk, still counted by
`/whats-breaking`, and invisible to the person who filed it.

A rejected fix now stays `Open`, and the attempt is written to `notes`. Same for
a write that fails partway: the entry stays `Open` with the error in `notes`.
Nothing is lost, because a note is visible in a place a status was not.

The oldest version of this skill, before it was a plugin, did show the status in
its default view, and said why: failed fixes need re-attention so they stay
beside open work. The behaviour and the sentence explaining it were dropped
together in a rewrite, which is why nothing left could say it had been deliberate.

**Nothing to do on upgrade.** Readers still accept the old value, so an entry
written by an earlier version keeps working, and `/apply-fix` treats it as open.
The schema stays at v5: the change is compatible in both directions, and bumping
it would signal a migration that does not exist.

`tests/queue-status-reachable.test.js` now asserts the general rule, that any
status a skill writes is either shown by the default view or marked terminal in
the schema, so this cannot come back under a different name.

## Upgrading to 0.3.0

The first hook in this plugin. `skill-md-check` runs after any Write or Edit,
and when the file is a `SKILL.md` it checks five things and reports back into
the conversation. It never blocks and it never writes.

| Checked | Why |
|---|---|
| Frontmatter is present and closed | Without it the file is markdown, not a skill, and nothing loads it |
| `name:` is set | Required by the loader |
| `name:` matches its directory | The failure this plugin already works around |
| `description:` is set | This is the discovery surface; an undescribed skill never triggers |
| `type:` is `human` or `agent`, **when present** | Validated, not required |

The name-versus-directory check is the reason the hook is worth having. The
directory name is what `/audit-deps` keys on and what `/flag-issue` resolves to
a file. The frontmatter name is what the model reads. While the two disagree
both are correct and neither resolves, so a fix filed against one silently
misses the other. `/audit-deps` carries a `notes` field to record this after the
fact; the hook catches it at the moment of writing instead.

Nothing to do on upgrade. The hook registers itself and stays quiet on a
well-formed file.

## Upgrading to 0.2.6

The other half of the window bug from 0.2.1. That release gave the cutoff a time
so git would stop filling in the current hour. It still had no timezone, and
git reads an unzoned timestamp as **local time** while the cutoff is computed
with `date -u`.

Measured on a machine at UTC-4, at 19:53 local:

```
--since="2026-07-27 21:53:54"    ->  0 commits   the UTC string, read as local, still in the future
--since="2026-07-27 17:53:54"    -> 13 commits   the same instant written in local time
--since="2026-07-27T21:53:54Z"   -> 13 commits   the same instant, said unambiguously
```

So the window started four hours late here, and would start early east of UTC.
Every count it produced was plausible.

The cutoff is now `YYYY-MM-DDT00:00:00Z`, which also matches the `created_at`
written on every queue and to-build item, so the cutoff and the thing it gets
compared against are finally in the same units.

Found by `/built-check` noticing mid-run that its own window had come back
empty and correcting for the offset by hand. It reported the discrepancy in its
own output.

## Upgrading to 0.2.5

`/built-check` decided where to look on disk purely from an item's `kind`, and
for kind `other` the answer was that disk evidence is not available at all. So
an item whose own text names the file it produced was told there was no sign of
it, even with the file sitting exactly where the item said it would be.

It now reads the item's text first. If `what` or `why` names an explicit
filesystem path, that path is checked whatever the `kind` is, and the kind
conventions are the fallback for items that name nothing. The rule that
evidence must be newer than the item still applies, so a file that was already
there does not close anything.

`reference/SCHEMA.md` changed in the same commit, because it stated the same
rule in different words. "No convention" means there is no layout to guess
from, not that a path is unreachable.

Found by driving `/built-check` during an audit of the skills that had never
been run. It reached the right answer on an item of kind `other` by reading a
path out of the item's text, which nothing in the spec told it to do, so the
next run was free not to.

## Upgrading to 0.2.4

Twenty-four output templates across seven skills told the model to print an em
dash. `slop-check` ships a Stop hook that blocks exactly that, so a skill would
produce its message, the hook would block it, and the model would rewrite it.
Every single time.

Nobody noticed because the rewrite succeeds and the answer still arrives, just
after an extra round trip. The plugins were failing a rule their sibling plugin
enforces.

Two kinds of place had them.

**Quoted messages**, in `flag-issue`, `apply-fix`, `verify-fix`, `revert-fix`,
`list-bugs` and `audit-deps`. The messages say the same things now with a comma
or a full stop.

**Display templates**, the fenced blocks a skill reproduces line for line. These
were missed on the first pass, on the reasoning that a `##` line is a heading
and headings are structure. True of a section heading in a SKILL.md, false
inside a display template: `/list-bugs` printed its table header verbatim on
every single run, and so did `/to-build`. `/built-check` did the same with its
numbered findings, `/find-skill` with its routing list, `/whats-breaking` with
its weekly report, and `/stale-branches` with its per-repository line. Those are
now a plain hyphen or a colon, which the hook does not touch since it blocks
only the em dash character itself.

Prose and section headings keep theirs. Those reach nobody, and rewriting them
would churn a lot of files to fix nothing.

`tests/output-templates.test.js` keeps new ones out, checking both kinds. It is
still not exhaustive: a value written into a file that gets displayed later,
such as a queue entry's `what_expected`, has no syntax marking it as output, and
reaching those means flagging prose. A linter that cries wolf gets switched off.

## Upgrading to 0.2.3

0.2.2 gave the composite key a plugin segment and stopped there. The
**dependency edges** that point at those keys were left as they were, and they
have no way to name a plugin.

An edge is `{target, kind, repo, reason}`. Under a `plugin-repo` root that is
ambiguous, because `cli`, `config`, `hook-io` and `patterns` each exist in more
than one plugin, so an edge naming `cli` cannot say which one is at risk. That is
the same ambiguity the composite key was introduced to remove, still present one
field along.

Edges now carry `plugin` as a **separate field**, with `target` staying bare:

```json
{ "target": "hook-io", "plugin": "guardrails", "kind": "script", "repo": "plugins" }
```

**Folding the plugin into `target` looks equivalent and is not.** `/flag-issue`
copies an edge's `target` verbatim into the `target` field of the dep-review
entry it writes, and a queue entry's `target` is a name on disk that
`/apply-fix` later has to resolve to a file. An edge saying
`"target": "guardrails/hook-io"` produces a queue entry for something called
`guardrails/hook-io`, and nothing on disk is called that.

So the edge needs both halves, because two readers want different things from
it: the key wants the plugin, and the queue entry must not have it.

An existing map keeps working. An edge with no `plugin` resolves through the
same ordered lookup as a key, and one with a slashed `target` is split on the
last `/`. Run `/audit-deps` to rewrite them properly.

## Upgrading to 0.2.2

Two faults, both found the first time `/audit-deps` was run against a real
`plugin-repo` checkout.

**`scripts/` was invisible to every search.** The plugin-repo lookup covered
`skills/`, `hooks/` and `commands/`, and stopped there. In a well-built plugin
the hook and the skill are thin wrappers and the logic sits in `scripts/`, so
that is the file a fix edits. `/flag-issue hook-io` could not resolve and fell
through to asking for a path by hand. Two of the four `guardrails` bugs fixed on
2026-07-27 were in `scripts/`, so this was the ordinary case rather than the
edge. `/flag-issue`, `/audit-deps` and `/built-check` all search it now.

**`DEPS.json` keys collided.** The rule was `{repo}:{name on disk}`, which
assumes the root name tells two things apart. Under a `plugin-repo` root it does
not, because one root holds many plugins. A single root named `plugins` produced:

```
plugins:cli       <- 3 different files
plugins:config    <- 2
plugins:hook-io   <- 2
plugins:patterns  <- 2
```

Later entries overwrote earlier ones, so the map described the wrong file and a
fix to one plugin would flag another plugin's dependents for review.

Under a `plugin-repo` root the key is now `{repo}:{plugin}/{name}`, so
`plugins:guardrails/hook-io` and `plugins:slop-check/hook-io` are separate. The
plugin's own entry keeps a bare key and cannot collide with anything inside it,
since everything inside carries a `/`. `DEPS.json` is now schema v3.

**Lookups fall back rather than failing quietly.** A map can be older or newer
than the reader, so both directions are handled. Readers try the exact key
first, then the bare `{repo}:{target}`, which is what a pre-v3 map stored, then a
match on any key ending `/{target}`, which covers a bare lookup against an
already-qualified map. More than one match is reported as ambiguous rather than
guessed at, because picking sends a fix to the wrong plugin.

A lookup that silently finds nothing is indistinguishable from a target with no
dependents, and those two needed to stay different.

If you already have a `DEPS.json`, it keeps working, via the bare-key step. That
step matches on name alone, so on a pre-v3 map, which is exactly the file where
`plugins:cli` meant three different things, the entry it finds may describe a
different plugin. Readers say so when it happens rather than presenting it as
exact. Run `/audit-deps` to rebuild the keys and the caveat goes away.

## Upgrading to 0.2.1

**If you are on 0.2.0, `/built-check` never read the git log.** It gathered
evidence from three places and one of them silently returned nothing on every
run, so work that was committed hours earlier came back as "no sign of it".

The cutoff was built as a bare `YYYY-MM-DD` and handed to `git log --since=`.
Given a date with no time, git fills in the **current clock time** rather than
midnight. Measured in a real repository on 2026-07-27 at 16:53:

```
--since="2026-07-27"           ->  0 commits
--since="2026-07-27 00:00:00"  -> 39 commits
--since="2026-07-27 16:53"     ->  0 commits
```

So it dropped every commit made before whatever time of day you ran it. Run it
in the morning and most of the boundary day is there. Run it after lunch and it
is gone. For anything added to the list today, the git evidence was empty every
time.

The cutoff now carries an explicit `00:00:00`.

Disk evidence and session evidence were never affected, which is why this was
not obvious: `/built-check` still found things, just never from the log.

**It also now says when the window comes back empty.** Every way that step can
fail, a malformed cutoff, the wrong `date` flag, or a root that is not a
repository, ends at the same place: no commits, and a confident "no sign of it".
One line saying the log returned nothing is the only thing that separates
"nothing was built" from "nothing was looked at".

