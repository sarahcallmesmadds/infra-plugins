# session

Make sessions continuous instead of disposable.

Every session ends one of two ways: you close the window and lose the thread, or
you write yourself a note somewhere you will never look again. The next one
starts with ten minutes of "where was I".

| Command | What it does |
|---|---|
| `/wrap` | Writes what was decided, built and left open into a handoff document |
| `/pickup <slug>` | Loads that handoff back and starts from it |
| `/status-bar` | Sets up the status line: model, folder, current task, cost, context used |
| `/core-tools` | Picks which connected tools to watch for expired sign-ins |

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
summary when it is no more than 14 days old, and a warning when `DEPS.json`
points at missing or newer files. Session does not depend on build-loop being
installed: it reads the state files when they exist and stays quiet when they
do not. The weekly summary appears only on a new startup, not again on resume or
compact, and is clipped at 2,000 characters.

The entire injected context, including the date and parallel-session notices,
is capped at 10,000 characters. A long weekly summary is clipped before it can
turn an opening brief into the first session's largest context expense.

## The status line

```
Claude 4.8 │ my-project ⎇ owner │ ↳ Building the current task │ $0.42 · 30d $81.20 est ████░░░░░░ 41% │ Core tools 5/5
```

Every segment is optional and vanishes rather than erroring when its data is
absent.

The current-task segment reads this session's files under `~/.claude/todos/`
and shows the `activeForm` marked `in_progress`. It never borrows a task from a
different session. Set `{"currentTask":{"enabled":false}}` in
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

## What pickup deliberately does not do

It does not open the files the handoff mentions. It lists them and waits to be
asked.

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
/plugin marketplace add sarahcallmesmadds/plugins
/plugin install session@smadds
```

Restart afterwards. Hooks and skills load at startup, so nothing changes in a
session that was already open, and the plugin will look broken until you do.
