# session

Make sessions continuous instead of disposable.

Every session ends one of two ways: you close the window and lose the thread, or
you write yourself a note somewhere you will never look again. The next one
starts with ten minutes of "where was I".

| Command | What it does |
|---|---|
| `/wrap` | Writes what was decided, built and left open into a handoff document |
| `/pickup <slug>` | Loads that handoff back and starts from it |
| `/status-bar` | Sets up the status line: model, folder, cost, context used |
| `/core-tools` | Picks which connected tools to watch for expired sign-ins |

Plus a hook that runs at session start and does two things without being asked.

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

## The status line

```
Claude 4.8 │ my-project ⎇ owner │ $0.42 · 30d $81.20 est ████░░░░░░ 41% │ Core tools 5/5
```

Every segment is optional and vanishes rather than erroring when its data is
absent.

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

## Where handoffs go

A directory with its own work scope gets `HANDOFF.md` alongside the work, so it
travels with the repository. Anywhere else gets a topic-named file under
`~/.planning/handoffs/`, so separate threads do not overwrite one another.

Handoffs untouched for 30 days are swept into `archived/` at the start of the
next wrap. They are moved, never deleted, and `/pickup` still finds them by
name.

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
