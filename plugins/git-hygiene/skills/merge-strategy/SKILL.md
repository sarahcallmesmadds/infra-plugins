---
name: merge-strategy
type: human
description: Recommends squash-and-merge, rebase-and-merge, or a merge commit for the branch in front of you, based on its actual commits, whether the branch is shared, and whether its history is already public. Use when the user asks which merge method to use, whether to squash or rebase, how to merge a pull request, or invokes /merge-strategy. Read-only: it recommends and explains; it never merges, rebases, pushes, or deletes.
argument-hint: "[optional repository or pull request]"
allowed-tools: Read, Bash(git:*), Bash(gh:*)
---

You are choosing a merge strategy for one branch or pull request. Inspect the
actual branch and state the evidence before recommending anything. This skill
does not perform the merge.

## Step 1: Identify the change

If the user named a pull request, use it. Otherwise use the current branch and
its upstream. If there is no current branch, no upstream, or no pull request,
say what is missing and stop. Do not infer a strategy from the branch name.

For a local branch, gather:

```bash
git branch --show-current
git rev-parse --abbrev-ref --symbolic-full-name @{upstream}
git rev-list --count <default>..<branch>
git log --oneline --decorate <default>..<branch>
git log --merges --oneline <default>..<branch>
git status --short
```

For a GitHub pull request, gather the repository, base and head branch, draft
state, review state, commit count, and whether the head branch is already on
the remote:

```bash
gh pr view <number-or-url> --json baseRefName,headRefName,headRepositoryOwner,isCrossRepository,isDraft,reviewDecision,commits,url
```

If any comparison or review fact cannot be read, say so and withhold a precise
recommendation. Unknown is not a reason to choose the least disruptive-looking
option.

## Step 2: Ask about shared history when it is not observable

A remote branch proves the history is public to that remote; it does not prove
that nobody else has based work on it. Do not treat “the branch is pushed” as
“the branch is private.” If the user has not said whether another contributor
or branch depends on this history, ask one short question:

> Has anyone else based work on this branch, or is it yours alone?

Record the answer as `shared` or `private`. If the user cannot tell, treat it as
shared and explain that the conservative choice preserves the existing graph.

## Step 3: Choose from the evidence

Use these rules in order:

1. **Merge commit** when the branch is shared, its history is already public
   and others may have based work on it, or the branch contains meaningful
   merge commits whose topology is part of the record. This preserves the
   branch graph and avoids rewriting commits other people may have pulled.
2. **Rebase-and-merge** when the branch is private, has a small number of
   meaningful commits, and its commits are already cleanly ordered for the
   target branch. This preserves each commit while producing a linear target
   history. It is not appropriate for shared history.
3. **Squash-and-merge** when the branch is private and its commits are mostly
   fixups, review corrections, or implementation steps that do not deserve
   separate long-lived entries in the target history. It produces one
   reviewable change and discards the branch's noisy intermediate commits from
   the target history.

If the branch is a draft, has unresolved review changes, has uncommitted local
files, or has no successful comparison with the target, say **not ready to
merge** before discussing the three methods. A strategy is not approval to
merge.

## Step 4: Explain the recommendation

Return:

```text
Recommendation: {squash-and-merge | rebase-and-merge | merge commit | not ready}

Evidence:
- {commit count and whether the commits are meaningful or fixups}
- {private/shared and public/unshared facts}
- {review/draft/working-tree state}

Why this fits: {one or two sentences}
Why not the other two: {brief tradeoff}

Next step: {the user can choose the merge method in GitHub or run the exact
command themselves; this skill did not merge, rebase, push, or delete anything}
```

Never claim that one strategy is universally correct. The point is to make the
tradeoff visible from the branch in front of the user.
