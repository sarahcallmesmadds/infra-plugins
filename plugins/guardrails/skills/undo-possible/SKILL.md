---
name: undo-possible
description: Assess a shell command for irreversible destructive potential before running it, and explain what it would do. Read-only, runs nothing. Use when a command involves rm, git reset, git clean, force push, or branch deletion, or when you are about to run something you did not write. Triggers on "undo-possible", "can I undo this", "is this command safe", "what will this do", "should I run this".
---

# undo-possible

Judge whether a shell command does something that cannot be undone, and say so
before it runs. Safe tier: this inspects a string and reports, and never
executes the command.

## When this matters

Most shell commands are recoverable. A handful are not, and the gap between
those two groups is not obvious unless you already know git well. `git reset
--hard` and `git reset --soft` differ by one word and by whether your afternoon
survives.

This is aimed squarely at people who are building without a systems background.
The point is not to slow you down. It is that the small set of genuinely
one-way commands should announce themselves.

## How to run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" check --command 'rm -rf ./build'
```

It prints either `allow` or `confirm`, with a reason.

## What it flags

| Command | Why |
|---|---|
| `rm -rf` outside disposable paths | No undo, no trash, no confirmation |
| `git reset --hard` | Discards uncommitted work in the tree |
| `git clean -fd` | Deletes untracked files permanently |
| `git push --force` | Can overwrite a branch other people have pulled |
| `git branch -D` | Deletes a branch even if it was never merged |

`git push --force-with-lease` is deliberately not flagged. It refuses to
overwrite work you have not seen, which is the whole point of it.

Paths that are routinely disposable (`node_modules`, `/tmp`, build output) are
allowed without a prompt. That list lives in
`~/.claude/guardrails.config.json` under `safeDeletePaths`, so if you keep
approving the same deletion, add it there rather than approving it again.

## What to tell the user

If the verdict is `confirm`, do not just repeat the warning. Say what the
command would delete or overwrite in this specific repository, and say how it
could be recovered. For most git cases the honest answer is `git reflog`, which
usually still holds what is about to be discarded.

If the verdict is `allow`, say so in one line and move on. Do not manufacture
concern about a safe command.
