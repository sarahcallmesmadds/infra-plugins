---
name: ip-audit
type: human
description: Checks every row of the IP inventory against what actually exists. Resolves each repository on GitHub, confirms every recorded path still resolves on this machine, compares versions to the installed copies, and reports what has drifted. Reads the database id from ~/.claude/ip-inventory.config.json. Use when the user asks "is my inventory still right", "check my IP inventory", "what has drifted", "audit the inventory", or explicitly invokes /ip-audit. Read-only; it never edits the inventory.
argument-hint: "[optional: --offline to skip the GitHub checks]"
allowed-tools: Read, Bash(node:*)
---

# ip-audit

An inventory of your own work rots quietly. Repositories get deleted, plugins
get updated, paths move, and none of it announces itself, so the record is wrong
at exactly the moment you need it to be right.

This compares the record against reality and reports the difference. It changes
nothing.

## Run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" audit
```

Add `--offline` to skip the GitHub calls and check only this machine. Add
`--json` if you want to process the result rather than read it.

## Read the result

The first line is `drift: N`. Branch on that.

**`drift: 0`** — say so plainly, and say what was checked. The report prints the
row count and the number of checks per row. Repeat those numbers back. A run
that found nothing and a run that never happened look identical if you only
report the verdict, and the whole point of this skill is that nobody noticed for
three months last time.

**`drift: N`** — the report is already grouped into three sections. Present them
in this order and do not merge them:

1. **Safe to fix automatically.** Facts with one correct answer: a renamed
   repository, a changed visibility, a version bump, a path into a superseded
   plugin directory. Summarise these; do not list every row when the report has
   already collapsed twenty rows into one cause.

2. **Needs you.** Not wrong, unknown. A repository that returns 404 does not
   tell you whether the work is retired, moved, or still running somewhere and
   billing. Never guess which. Ask.

3. **Not checked.** Say this section out loud even when it is short. A check
   that did not run looks exactly like one that passed.

## What it will not do

It does not write to the inventory, so there is nothing to approve and nothing
to undo. Applying fixes is a separate command that does not exist yet; until it
does, changes are made by hand.

It cannot tell you which version of a plugin is *running*. Several versions sit
in the cache at once because updating leaves the old directory behind, and the
live one is whatever loaded at session start. The report says the newest on
disk and says that is what it means.

It reports a repository as missing only when GitHub answers 404 with a token
attached. Without one, a private repository is indistinguishable from a deleted
one, so the check is skipped and listed as skipped.
