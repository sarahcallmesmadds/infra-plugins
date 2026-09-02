---
name: setup
type: human
description: Configures Git Hygiene's visible project roots, hidden worktree root, placement enforcement, and session notice. Use when the user installs worktree hygiene, asks where agent worktrees should live, or must repair git-hygiene configuration. Writes only ~/.claude/git-hygiene.config.json after confirmation.
argument-hint: ""
allowed-tools: Read, Bash(node:*), Bash(ls:*)
---

Configure the machine-specific paths that worktree hygiene cannot infer safely
from shipped plugin code.

## Discover before asking

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktree-config.js propose
```

It checks common local project roots and the current repository without
descending through their working trees. Present the proposed project roots,
hidden worktree root, enforcement setting, and session-notice setting.

If no project root was found, ask one question: where are the user's primary Git
repositories kept? Do not ask for paths already discovered.

## Confirm and write

Ask the user to confirm or correct the complete proposal. Nothing is written
before that response. Then call the writer with one `--project-root` per approved
root and the approved hidden root:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktree-config.js write \
  --project-root "<root>" \
  --worktree-root "<hidden root>" \
  --enforce \
  --session-notice \
  --approved
```

Use `--no-enforce` or `--no-session-notice` only when the user selected that
setting. The script writes only `~/.claude/git-hygiene.config.json`, uses an
atomic replacement, and reads it back before reporting success.

Show the read-back result. Explain that setup does not create, move, unlock, or
remove a worktree. Existing worktrees are handled later through
`/git-hygiene:worktree-hygiene` with separate approvals.
