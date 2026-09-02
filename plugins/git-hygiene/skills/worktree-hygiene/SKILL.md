---
name: worktree-hygiene
type: human
description: Inspects, creates, relocates, finishes, or removes linked Git worktrees through deterministic checks. Use when the user asks to create an isolated worktree, clean up worktrees, explain duplicate project folders, move branch checkouts out of a project directory, or show which worktrees are finished. Never moves, unlocks, or removes a worktree without exact-path approval.
argument-hint: "[status | create | activate | relocate | cleanup | finish]"
allowed-tools: Read, Bash(node:*), Bash(git:*), Bash(gh:*), Bash(ls:*)
---

You manage linked worktrees without deciding their safety yourself. The script at
`scripts/worktrees.js` owns discovery, placement, classification, and every
mutation precondition. Carry its state and reason through unchanged. Unknown
evidence means keep.

This skill never deletes branches. After a worktree is removed, the branch stays
available for `stale-branches` to review separately.

## Choose the route

- `status`: inspect worktrees without changing anything.
- `create`: create or open an isolated checkout at the configured hidden path.
- `activate`: lock an existing linked checkout as active agent work.
- `relocate`: move an existing clean, unlocked worktree to its configured path.
- `cleanup`: remove only worktrees classified `merged` after exact-path approval.
- `finish`: unlock one clean worktree after the user confirms no session is using it.

If no route was named, infer it from the request. A request about duplicate project
folders means `status` first, not cleanup.

## Status

For the current repository:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktrees.js audit --repo "$PWD" --json
```

For every configured project root:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktrees.js audit --all-configured --json
```

If configuration is missing, the current-repository form still works. Global
discovery, canonical placement, and enforcement stay off until setup is complete.

Group the result by state. Show the exact path, branch, reason, and whether the
script marked it removable or relocatable. A partial audit carries
`truncated: true`; report that the audit is incomplete and offer nothing for
cleanup from it.

## Create

Read the configuration first:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktree-config.js show
```

If it is absent or invalid, route to `/git-hygiene:setup`. Do not guess a project
root or use a visible sibling path.

Show the computed destination before creating anything:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktrees.js destination --repo "<repository>" --branch "<branch>"
```

Ask for approval if the branch does not already exist. If it exists on exactly
one remote but not locally, omit `--base`; the script creates a local tracking
branch at that remote tip. For a truly new branch, show the chosen base and,
after approval, create it:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktrees.js create --repo "<repository>" --branch "<branch>" --base "<base>" --approved
```

For an existing branch, omit `--base`; the script opens that branch rather than
creating another. The resulting worktree is locked as active agent work. Report
its exact path and lock state.

## Activate

Run status first. Show the exact path and branch, then ask before marking that
one existing linked checkout as active agent work. After approval:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktrees.js activate --path "<exact path>" --approved
```

The script refuses the primary checkout, an unregistered path, and a worktree
that is already locked. Activation does not move files or change a branch; it
adds the lock that prevents cleanup while an agent owns the checkout.

## Relocate

Run status first. Offer only entries whose returned `relocatable` value is true.
Show the exact current path and computed destination, then ask before moving that
one path. After approval:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktrees.js move --path "<exact path>" --approved
```

The script refuses primary, dirty, locked, detached-review, or already managed
worktrees. It also refuses the caller's current working directory. Never add
force or substitute another path after approval.

## Cleanup

Run a complete audit. Offer only entries whose returned state is `merged` and
whose `removable` value is true. Show exact paths and branches, and say that the
branches will remain.

Ask which exact paths to remove. Approval for one path does not apply to another.
For each approved path, run the verifier and then the removal separately:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktrees.js verify-remove --path "<exact path>"
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktrees.js remove --path "<exact path>" --approved
```

The remove command repeats the verification immediately before Git removes the
worktree. If either command refuses, report its reason and leave that path alone.
Never use `rm`, `git worktree remove --force`, or a batch command.

After removal, offer `stale-branches` if the user also wants the surviving branch
labels reviewed. Do not invoke branch cleanup automatically.

Missing registrations use Git's repository-wide prune operation, not worktree
removal. Show every exact `missing` path in that repository and ask the user to
approve the complete set. Approval of only some paths must be reported as a
refusal because Git cannot prune one registration by path. Then run the dry-run
verifier and governed prune separately:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktrees.js verify-prune --repo "<repository>" --path "<exact missing path>"
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktrees.js prune --repo "<repository>" --path "<exact missing path>" --approved
```

Repeat `--path` for every approved missing registration. The command re-checks
that the approved set is exactly the set Git can prune, never removes a working
directory, and preserves branches.

## Finish

Finishing means making an active worktree eligible for later review. It does not
remove it. Confirm the exact path and ask the user to confirm that no session is
still using it. Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktrees.js finish --path "<exact path>" --approved
```

For a path that still exists, the script refuses a dirty, unreadable, primary,
already unlocked, or current working directory. After it succeeds, run status
again and report the new classification. Cleanup still requires its own
approval.

A locked registration may remain after its working directory disappears. It
stays `locked`, not `missing`, until the lock is deliberately cleared. After the
same ownership confirmation, finish it by naming the primary checkout as well:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/worktrees.js finish --repo "<primary checkout>" --path "<exact absent path>" --approved
```

Run status again. The unlocked registration can then become `missing` and use
the separately approved prune flow.

## Boundaries

- Treat ignored files as dirty local data. Do not reinterpret `dirty`, `locked`,
  `open`, `unique`, `detached-review`, or `unknown` as removable based on
  conversation or age.
- Do not move or remove review-tool worktrees through the ordinary flow.
- Do not clear stale locks because time passed. A person must establish that no
  session owns the worktree, then use the finish route.
- Do not claim that a GitHub merge can clean a local directory. The next local
  audit is the automatic checkpoint.
- Do not migrate every existing worktree as a side effect of setup or status.
