---
name: setup
type: human
description: Sets up Git Hygiene's optional project worktree location guard by choosing the project and worktree folders and writing them to user-owned configuration. Use when the user asks to configure or enable the worktree location guard, or invokes /git-hygiene:setup.
allowed-tools: Read, Bash(git worktree list:*), Bash(node:*)
---

Configure the optional worktree location guard in `~/.claude/git-hygiene.config.json`.
Do not edit files inside the installed plugin directory.

## 1. Read the current setting

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/configure-worktree-location.js --show
```

If a setting already exists, show its two paths and include them in the confirmation below. Do not replace it silently.

## 2. Propose the folders

If the current directory is inside a Git repository, find its primary checkout.
Git lists it first:

```bash
git worktree list --porcelain
```

Use the path on the first `worktree` line. Do not use `git rev-parse
--show-toplevel`: inside a linked worktree it names that worktree, and proposing
its parent would put future worktrees inside an existing one.

By default, propose the primary checkout's parent as `projectRoot` and `<projectRoot>/Worktrees` as `worktreeRoot`. If the surrounding folder layout clearly indicates a different shared project folder, propose that instead. If there is no current repository, ask for both paths together. Both must be absolute paths, or start with `~/`.

Show both proposed paths and ask once:

> Use these project and worktree folders? (yes / give me different paths)

If changing an existing setting, say that it will be replaced. Do not write anything until the user confirms the displayed paths. A correction gives the paths to use and counts as confirmation for that pair; do not ask the same question twice.

## 3. Write and verify

For a new setting:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/configure-worktree-location.js --project-root "{projectRoot}" --worktree-root "{worktreeRoot}"
```

To replace an existing setting, include `--replace-existing` after the user's confirmation. The script validates the project folder and nesting, preserves other keys, and writes atomically. If validation fails, show the error and leave the prior configuration untouched.

Then verify:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/configure-worktree-location.js --show
```

Report the configured paths. The hook reads this user-owned file for each Bash command, so the new setting applies to the next command.
