# session

Make sessions continuous instead of disposable.

Every session ends one of two ways: you close the window and lose the thread, or
you write yourself a note somewhere you will never look again. The next one
starts with ten minutes of "where was I".

| Command | What it does |
|---|---|
| `/wrap` | Writes what was decided, built and left open into a handoff document |
| `/pickup <slug>` | Loads that handoff back and starts from it |
| `/status-bar` | Sets up Codex's native footer/task title or Claude Code's richer status line |
| `/core-tools` | Picks which connected tools to watch for expired sign-ins |
| `/core-tools-monitor` | Runs the transition-only probe used by a Desktop scheduled task |

Plus a hook that runs at session start and gives the model the small amount of
current state it should not have to rediscover.

## What the hook does

**It states today's date.** A model has a training cutoff and no clock, so left
alone it answers "what is today" with a date near the end of its training data,
confidently, because from the inside a remembered date and a known one feel the
same. Everything downstream inherits it: a file named with the wrong date, a
"last 30 days" window that is really last year, a deadline described as three
weeks out when it is three days out. The line includes the timezone offset,
because a date with no zone gets read as UTC and is off by a day for part of
every day west of Greenwich.

**It says when another session is already live in this directory.** Two sessions
editing one tree overwrite each other, and neither sees the other's changes.
This reads the process table rather than recent file activity, because a
transcript's timestamp is wrong in both directions: a session you closed an hour
ago still looks alive, and a session sitting idle looks dead. It reports what is
actually running, names the directories, and never blocks anything.

Sessions in unrelated directories are counted but not named. Nesting counts as
overlapping, in both directions, since a session at a repository root and one
inside it edit the same files.

**It opens with the build loop.** When build-loop state exists, the hook includes
the active bug queue, the number of open to-build items, the newest weekly
summary when it is no more than 14 days old, and a line when `DEPS.json` holds
an entry whose file is gone. Session does not depend on build-loop being
installed: it reads the state files when they exist and stays quiet when they
do not. The weekly summary appears only on a new startup, not again on resume or
compact, and is clipped at 2,000 characters.

**It no longer counts files edited since their entry was reviewed.** That count
was two thirds of this line's output and none of its value. `last_updated` is a
human review date and is deliberately never bumped by machine, so an entry
reviewed once and edited since counted as drifted forever and the number only
grew. Measured on 2026-08-15: 82 of 127 entries, with nothing actually missing,
printed as a warning not to rely on a map that was sound. A line that is always
on tells a reader nothing. `/audit-deps` makes the same comparison, one entry at
a time, for somebody who asked for it and can act on the answer.

The entire injected context, including the date and parallel-session notices,
is capped at 10,000 characters. A long weekly summary is clipped before it can
turn an opening brief into the first session's largest context expense.

## Status surfaces

### Codex

Codex has a native footer picker. Run `/status-bar` and it will guide you
through `/statusline`, recommending a compact model, context, branch and folder
layout. The selection takes effect immediately and Codex persists it in
`tui.status_line`.

Codex does not expose task progress as a documented footer field. It does
expose it in the terminal title, so the setup also routes you through `/title`.
This uses Codex's native task-progress state and keeps the footer from becoming
too wide. Plugins cannot add arbitrary custom Codex footer segments, so the
Claude-only spend and connected-tool fields below are not promised in Codex.

### Claude Code

```
Claude 4.8 │ my-project ⎇ owner │ ↳ Building the current task │ $0.42 · 30d $81.20 est ████░░░░░░ 41% │ Core tools 5/5
```

Every segment is optional and vanishes rather than erroring when its data is
absent.

The current-task segment reads this session's task files under
`~/.claude/tasks/<sessionId>/`. For older Claude Code versions it falls back to
the main todo file under `~/.claude/todos/`: either `<sessionId>.json` or
`<sessionId>-agent-<sessionId>.json`. It shows the `activeForm` marked
`in_progress` and never borrows a task from another session or a sub-agent. Set
`{"currentTask":{"enabled":false}}` in
`~/.claude/session.config.json` to hide it.

**A plugin cannot switch a status line on.** Claude Code reads `statusLine` from
`settings.json` and from nowhere else, so one line has to go there. `/status-bar`
writes everything else and shows you that line to approve.

It points at `~/.claude/statusline.js`, a small resolver, rather than at the
plugin directly. The plugin installs to a path containing its version number, so
a setting pointing straight at it would keep resolving to the version you
replaced after every update, rendering happily and silently out of date. The
resolver finds the newest installed copy on each render. Set up once.

Optional spend cap:

```bash
export CLAUDE_30D_SPEND_LIMIT_USD=200
```

## Connected tool health

An expired connection is silent. A tool that needs signing in again behaves
exactly like a tool with nothing to report, so you find out when something you
asked for quietly did not happen.

`/core-tools` reads the servers actually connected on this machine and asks
which ones matter. Nothing is hardcoded and the list starts empty, so the
segment stays off until you choose. Config lives at
`~/.claude/session.config.json`:

```json
{
  "coreTools": [
    { "label": "Email", "match": "Gmail" },
    { "label": "Notion", "match": "Notion" }
  ]
}
```

Checking every server takes seconds, which is far too slow for something that
renders as often as a status line. So the probe runs in the background at
session start and the status line only ever reads the cache. That means the
number is as fresh as the cache and no fresher, which is why it starts showing
its age once it gets old, and why it shows nothing at all rather than `0/5`
before the first refresh finishes.

For notification without watching the status line, schedule
`/core-tools-monitor` hourly in Claude Desktop. It speaks only when the state
changes: once for a new failure, once when the affected set changes, and once
when every tool recovers. Repeated runs update one local incident at
`~/.cache/session/core-tools-incident.json` instead of stacking duplicates.
If the health command itself cannot run, that degraded monitor state follows
the same rule: one alert, silence while unchanged, and one recovery.

## Knowing how full the context is

Claude Code sends the status line a `context_window` on every render and tells
the model nothing. So you can watch the bar turn orange while the assistant
deciding whether to open six more files has no idea, and `/context` is the only
way to read it, and only you can run that.

The status line writes the number to a file and a `PostToolUse` hook reads it
back. Two components that cannot talk to each other, joined by the filesystem.

At 35% remaining the model is told to finish what is underway rather than start
something new. At 25% it is told to say so plainly and ask you how to proceed.
Repeats are debounced across five tool calls, because a warning on every single
call would spend context complaining about context, but crossing from warning
into critical is never swallowed.

**The message is advisory and never orders anything written.** An earlier
version of this told the model to save state and write handoff files, so a long
session would produce files nobody asked for at the moment you were busiest.
Reporting a fact is useful; acting on it unasked is not.

**This needs the status line installed.** It is the only component Claude Code
hands the context window to. Without it, no file is written, and the hook stays
quiet rather than inventing a number.

## Work left behind in other repositories

The parallel session check reads the process table, so it answers "is anyone in
here right now". A window you closed ten minutes ago leaves no process and
leaves its uncommitted work sitting in the tree.

So the session notice also reports uncommitted changes and commits from the last
six hours in repositories other than the one you are in. Your own repo is left
out, because you can see it and saying so every time is how a notice gets
ignored.

Repositories are discovered, not listed. The hook this came from held six
absolute paths from one machine, so anywhere else it checked six directories
that did not exist, found nothing, and said nothing, which reads exactly like an
all clear.

**This one is off until you ask for it.** Everything else in the plugin runs on
install. This does not, because it walks a directory of your work and runs git
in every repository it finds there, at every session start. That is bounded at
12 repositories, two directories deep, 400ms per git call, and it costs about a
tenth of a second. The cost is not the reason. Reading your disk is something
to be asked about, not something to be discovered afterwards.

The parallel-session check above does run by default, and reads your process
table to do it. The difference is what each one looks at. That one looks for
Claude Code sessions, which is this plugin's own subject. This one looks at
your unrelated work.

To turn it on:

```json
{
  "gitActivity": { "enabled": true }
}
```

Or turn it on and point it somewhere else, which does the same thing. Naming
any setting here is taken as asking for it, so you do not need `enabled` as
well:

```json
{
  "gitActivity": { "roots": ["~/code", "~/work"], "depth": 2, "recentHours": 6 },
  "contextWarnings": { "warningRemaining": 35, "criticalRemaining": 25 }
}
```

`roots` defaults to `~/Projects`, `depth` to 2, `recentHours` to 6, and at most
12 repositories are checked.

## The memory budget

Notes that load into a session are cheap to write and need a decision to delete,
so nothing ever deletes them. One real directory reached 14,637 words across
eleven files before anyone measured it, and half of that was two files: a
session log nobody had removed anything from, and a status document that had
quietly become the only home for some durable engineering notes. Asking a
question about working style pulled the whole status document.

`/wrap` measures the directory after writing to it and reports what it finds. It
changes nothing and deletes nothing.

The budget depends on what a file declares itself to be, because the kinds have
genuinely different shapes. A `project` file is live state, meant to be replaced
rather than grown, so a long one means nothing has been taken out since it was
written. A `reference` file accumulates slowly and legitimately and is read far
more often than it is written. Holding both to one number would either nag about
a good reference file or stay quiet while a status document turned into a log.

It also checks the index in both directions: files nothing points at, and
entries pointing at files that are not there. That is the failure that makes an
inventory useless, and it happens silently.

```json
{
  "memoryBudget": { "liveFileWords": 900, "durableFileWords": 2500, "totalWords": 10000 }
}
```

## Where handoffs go

A directory with its own work scope gets `HANDOFF.md` alongside the work, so it
travels with the repository. Anywhere else gets a topic-named file under
`~/.planning/handoffs/`, so separate threads do not overwrite one another.

Handoffs untouched for 30 days are swept into `archived/` at the start of the
next wrap. They are moved, never deleted, and `/pickup` still finds them by
name.

A project handoff sits next to the work, so finding one by name means knowing
where repositories live. That was `~/Projects` and nothing else, which found
nothing for anyone whose code is elsewhere. It is now a list you can state:

```json
{
  "projectRoots": ["~/Projects", "~/src", "/Volumes/work/repos"]
}
```

The default is `["~/Projects"]`, so nothing changes unless you set it. Entries
that are not usable strings are dropped, and an empty list falls back to the
default rather than searching nowhere.

This is a convenience, not the mechanism. `/wrap` records where it wrote, and that
record is the only thing that knows where a handoff next to the work actually went.
Every lookup verifies the file is still there, so a stale record degrades to "not
found" rather than to a confident path that resolves to nothing.

When that happens `/pickup` now says which path was recorded and what state it is
in, instead of reporting a miss that looks the same as no handoff ever existing. A
missing document in a surviving directory was deleted or renamed. A missing
directory means the project moved or its volume is not mounted, and nothing here
can tell those apart, so it does not guess.

### Two sessions wrapping at once

The record is written under a lock, held for the read and the write together.

It has to be. The index was read, changed in memory and written back in four
places, and the write renamed a temporary file over the real one. That rename is
atomic and does stop a reader seeing half a file, so it looked like enough. It
covers one writer, not two: session B reads the index before session A renames,
then B renames its own copy over A's entry and A's handoff is unlisted. Forty
concurrent records kept 15 to 18 of them, varying run to run. On the machine this
was found on, 13 of 47 real handoffs had no index entry, so `/pickup` could not
find them by name.

Every change to the index goes through one gate that takes the lock, reads and
writes. Not four locked call sites: a list of guarded call sites has to be
extended by whoever adds the next kind of change, and the one that gets missed is
the bug coming back.

Three things this leaves visible.

A `.index.lock` directory appears in `~/.planning/handoffs/` while a write is in
flight. The listings filter on the `HANDOFF-` prefix, so it is never mistaken for
a handoff.

A lock abandoned by a session that died is taken over after 30 seconds, and says
so on stderr, because it means somebody's write was interrupted.

If the lock cannot be taken within five seconds, the write still goes ahead
without it and says so on stderr, naming what may have been lost. Going ahead is
deliberate: losing an index entry degrades `/pickup` to the guessed locations, and
failing the wrap to protect it would cost the handoff itself, which is the thing
worth keeping. Saying so is equally deliberate, because a skip path quieter than
the pass path is indistinguishable from success.

That wait and that warning happen once per write, not once per step inside it.
The archive sweep changes the index twice, repointing what it moved and then
pruning what has gone, and both run inside one region that asks for the lock
once. Whatever answer it gets, both halves get the same one.

The warning belongs to the write, not to the attempt. A run that changed nothing
says nothing, because nothing could have been lost: a sweep with nothing to move
and nothing to prune is silent, and so is any `--dry-run`.

A dry run does not take the lock at all. It cannot write, so it has nothing to
protect and no reason to queue behind a session that is writing. Reads are safe
unlocked because the index is replaced by renaming a finished file over the old
one, so a reader gets one whole version or the other. A preview of state another
session is changing is approximate whatever you do, and waiting five seconds
does not make it less so.

### Work that is still in flight

Two more ways a handoff could vanish from the index, both closed.

A wrap records where it will write before it writes. Between those two moments
the index names a document that is not there, and a sweep running in that gap
used to call the entry dead and delete it. The wrap then finished and reported
success, and `/pickup` could not find it. So an entry recorded in the last ten
minutes whose document has not appeared is spared, and the sweep says which ones
it spared. It is dropped by a later sweep if the document never arrives.

Nothing on disk separates "not written yet" from "written and then deleted", so
the same ten minutes apply to both. That is the cost, and it is small: a dead
entry survives ten minutes longer, against a live handoff being lost.

The sweep also used to move documents into `archived/` before taking the lock,
so between the move and the repoint the index named a path nothing was at, and
another session pruning in that gap was entitled to drop the entry. Moving,
repointing and pruning are one change to one thing, so they now happen inside one
locked region.

That makes the region as long as the sweep, and a lock is judged abandoned after
30 seconds of an unchanged timestamp. So the sweep pushes that timestamp forward
after each document it moves. Without it, a sweep slow enough to cross the
threshold would have its lock taken over while it was still working, which puts
two writers in the critical section: the failure the lock exists to prevent,
arriving through the recovery path. On a local disk 2000 documents take about
300ms against a 30 second threshold, so this is not reachable today. It is not
left to that margin, because the margin is a fact about one machine and a home
directory on a network share is a different machine.

A command that changes nothing creates nothing. The lock lives inside
`~/.planning/handoffs/`, so taking it means creating that folder, which would put
one on a machine that has never had one on the say-so of a command that did
nothing. Forgetting a slug that is not listed, and pruning an index that is not
there, both leave the disk as they found it. Recording a handoff does create the
folder, because that is what recording a handoff means.

A directory that cannot hold a lock at all, usually one that is not writable, is a
different case and stays quiet. The index write is about to fail there too, and
`indexWritten: false` already reports that properly.

## Constraints that outlive the session that set them

A handoff records what happened. It also has to record what is still binding,
because a decision made in one session does not stop applying when the next
session is about something else.

`/wrap` writes a `## Constraints still in force` section and carries every entry
into the handoff that supersedes it. `/pickup` prints them first, above the next
actions, verbatim. Both read them with:

```bash
cli.js constraints [--cwd <project directory>]
```

Without `--cwd` it answers for the current working directory, which is why
`/pickup` passes the directory recorded inside the handoff rather than relying
on where the session opened.

**Scope is the repository, not the directory.** The command runs `git rev-parse
--git-common-dir` on the directory each handoff records, so a worktree inherits
from its main checkout and two handoffs for the same project group together even
when their recorded paths look unrelated. That call is memoized per directory
and times out after ten seconds, so a recorded path on an unmounted volume slows
the scan rather than hanging it. Directories that are not git checkouts fall
back to their real path and still group with themselves.

`--path-format=absolute` is tried first and the bare form is the fallback, since
the flag arrived in git 2.31 and older versions fail the whole invocation. The
fallback runs only when git says the flag is unsupported, so a directory that is
simply not a repository costs one probe rather than two, and a path on a dead
mount costs one timeout rather than two.

Scope falls back to comparing real paths when git cannot be run, or when a probe
times out. That still groups a directory with itself but cannot recognise a
worktree, so the command says which of the two happened rather than quietly
answering with less.

The directory is read from the handoff's `**Working directory:**` line, which
often carries prose after the path. A trailing parenthetical is stripped only
when the whole string is not a directory that exists, so a project whose folder
name genuinely contains a bracket is not truncated into its parent.

**Retiring one has to be written down.** A constraint that vanishes with no line
explaining why is indistinguishable from one that was forgotten, so removal is
recorded rather than implied:

```
- Retired this session: <the constraint, quoted exactly as it was written>, because <reason>.
```

The quote is matched against the bullet in the earlier handoff, so an
approximation retires nothing. When a retirement matches nothing the command
says so, because a retirement that silently fails is the same defect as a
constraint that silently vanishes.

**Limits worth knowing.** The scan reads at most 500 handoffs, newest first, and
says so when it hits that ceiling. Archived handoffs are read: a constraint does
not stop applying because the document carrying it went quiet for 30 days.

## What pickup deliberately does not do

It does not open the files the handoff mentions. It lists them and waits to be
asked.

The exception is a document a constraint names. That is not context that might
be useful, it is what the work has to comply with, so `/pickup` says which it is
and that it gets read before work starts in the area it governs. It still does
not load it here.

Bulk-loading them is the largest avoidable context cost at the start of a
session, and most are never touched before the conversation goes somewhere else.

## Codex

The skills work in Codex. The hook does not, because Codex plugin manifests do
not accept hooks. Hooks are enforcement and skills are advice, so a Codex
install gets the advice: `/wrap`, `/pickup`, `/status-bar` and `/core-tools` all
run, and the date line and parallel session warning do not fire on their own.
Both runtimes share one copy of the logic in `scripts/`.

## Install

```
/plugin marketplace add sarahcallmesmadds/infra-plugins
/plugin install session@smadds
```

Restart afterwards. Hooks and skills load at startup, so nothing changes in a
session that was already open, and the plugin will look broken until you do.

**Requires Node.js.** The hooks are plain Node scripts with no dependencies
to install, and `node` does not have to be on your `PATH`. Each hook is
started by `bin/hook-node`, which tries `$CLAUDE_HOOK_NODE`, then your
`PATH`, then `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and
`/usr/bin`, and uses the first one it finds.

That list exists because an app launched from the Dock never reads your shell
profile, so it starts with a bare `PATH` that has none of those directories
on it. Before 0.8.6 every hook here exited 127 under Codex for that reason,
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

**The status line is separate.** It is not a hook, so what ends up in your
settings does not go through `bin/hook-node`. `/status-bar` prints a
`settings.json` fragment naming your node by absolute path, resolved when the
installer runs, because that string lives in your settings and has to keep
working after the plugin updates, and `bin/hook-node` sits in a directory whose
name carries a version number. If node moves, re-run `/status-bar` and replace
the value. A status line that cannot start shows nothing and reports nothing,
so there is no error to see.

The installer itself is run through `bin/hook-node`, since it is a Node script
like any other and the host that most needs it is the one with no `node` on
`PATH`.
