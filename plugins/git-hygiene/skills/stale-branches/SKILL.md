---
name: stale-branches
type: human
description: Lists old branches and separates the ones that are safe to delete from the ones still holding unmerged work, then deletes the safe ones after you approve them. Works on the current checkout, on a named GitHub repository, or across every repository you own. Use when the user asks "what branches can I delete", "clean up my branches", "do I have stale branches", "am I still carrying old branches", "tidy up git", or explicitly invokes /stale-branches. Never deletes anything without an explicit yes, and never deletes a branch holding commits that exist nowhere else.
argument-hint: "[nothing for this repo | owner/name | all]"
allowed-tools: Read, Bash(node:*), Bash(git:*), Bash(gh:*), Bash(ls:*)
---

You are finding branches that can be cleaned up, and deleting the ones the user approves.

Everything here rests on one number: how many commits a branch has that are not already in the default branch. Zero means the work is safely in the default branch and the branch is just a label. One or more means those commits exist in exactly one place, and deleting the branch destroys them.

**Age is not the test.** A branch untouched since March with three unmerged commits is far more dangerous to delete than one from this morning with none. Old is why something is worth looking at. Merged is the only thing that makes it safe to remove.

Do not compute any of this yourself. `scripts/cli.js` does it, is tested, and fails safe on every input it cannot classify.

---

## Step 1 — Work out what to look at

Read `$ARGUMENTS`:

- **Empty**: if the current directory is a git repository, use it. If it is not, do not stop. Say so and offer the alternatives:

  > "This isn't a git repository, so there's nothing local to check. I can check a repository on GitHub instead, or all of them. Which?"

- **`owner/name`**: that GitHub repository.
- **`all`, `everything`, `my repos`, or similar**: every repository the user owns. Get the list with:

  ```bash
  gh repo list --limit 100 --json nameWithOwner -q '.[].nameWithOwner'
  ```

  Then run the command once per repository. Skip any that errors, count the skips, and report the count at the end. One unreadable repository must never stop the sweep.

---

## Step 2 — Run the command

For the current checkout:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js"
```

For a GitHub repository:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" --repo {owner/name}
```

Add `--json` when sweeping several repositories, so you can total them up, and render the summary yourself. For a single repository the text output is already in the right shape, so show it as it comes rather than rewriting it.

Across many repositories this takes a few seconds per repository, because working out the commit count is one API call per branch. Say that before starting a sweep of more than about five, so the wait is expected rather than alarming.

---

## Step 3 — Show what was found

For one repository, print the command's own output. It is already grouped into "Safe to delete" and "Keep", with the reason spelled out for every kept branch.

For a sweep, lead with the totals and then break down by repository, listing only repositories that have something in them:

```
{N} branches across {M} repositories.
{S} are safe to delete. {K} still have work on them.

{owner/repo}  - {s} safe, {k} to keep
  safe:  {names}
  keep:  {name} ({reason})
```

Never present a single combined list of all branches. The whole value is the split, and a flat list is what makes someone delete the wrong thing.

If nothing is safe to delete anywhere, say that plainly and stop. Do not ask a question with only one answer.

---

## Step 4 — Ask

```
Delete the {S} safe ones? (all / a list of names / none)
```

Rules:

- `all` means every branch under "Safe to delete", and never anything under "Keep".
- A list of names means exactly those. If a named branch is under "Keep", stop and say why it is there, then ask again. Do not silently comply, and do not silently refuse.
- `none` or any negative: say "Nothing deleted." and stop.
- Anything ambiguous: ask once more. Deleting the wrong branch is not undoable by the user.

**If the user asks to delete something under "Keep"**, tell them what would be lost and what to do instead:

> "`{name}` has {n} commits that are not in {default}. Deleting it loses them. If you want the work, open a pull request. If you are sure you do not, say 'force delete {name}' and I will do it, but the commits will not be recoverable from GitHub afterwards."

Only on that explicit second phrasing, act. Even then, for a local branch use `git branch -D` and tell them plainly that this is the one command in the flow that skips git's own safety check.

---

## Step 5 — Delete

### Local branches

```bash
git branch -d {name}
```

The lowercase `-d` refuses to delete a branch holding unmerged commits, so git independently checks the classification. If it refuses, that is a disagreement between git and this plugin and it is worth surfacing rather than working around:

> "git refused to delete `{name}`, which means it thinks the branch still has unmerged work even though the comparison said otherwise. I have left it alone. Worth a look before forcing it."

Never reach for `-D` to get past that.

### Remote branches

**Re-check each branch immediately before deleting it.** The GitHub API deletes whatever ref you name without checking whether it is merged, so there is no second opinion the way there is locally. The listing may also be minutes old by the time the user answers.

For each branch, in order:

1. Re-read the count:

   ```bash
   gh api repos/{owner/name}/compare/{default}...{branch} --jq '.ahead_by'
   ```

2. If it is not exactly `0`, skip that branch and say so. Do not delete, do not ask again in this run:

   > "Skipped `{name}`: it now has {n} commits not in {default}. It was safe when I listed it, so something landed in between."

3. If it is `0`, delete:

   ```bash
   gh api -X DELETE repos/{owner/name}/git/refs/heads/{branch}
   ```

Never batch the re-check and the deletes into one loop that checks everything first and then deletes everything. Check and delete one branch at a time, so a change part way through cannot affect a branch already cleared.

---

## Step 6 — Report

```
Deleted {n} branches: {names}.
{k} left alone, still holding work.
```

Add these lines only when they apply:

- `Skipped {name}: it gained commits between listing and deleting.`
- `git refused to delete {name}. Left alone.`
- `{p} repositories could not be read and were skipped: {names}.`

If a deleted branch was the last one in a repository besides the default, that is worth one line, because it usually means a piece of work finished and nobody closed it out.

---

## What this never does

- **It never deletes a branch with unmerged commits** without the user saying so in a second, explicit sentence.
- **It never treats "could not compare" as "merged".** A branch whose state cannot be determined is kept, and the reason is shown.
- **It never touches the default branch, a protected branch, the branch that is checked out, or a branch with an open pull request**, whatever their merge state.
- **It never pushes, merges, or rebases anything.** Deleting a merged label is the entire scope.

## Failure handling

- If `gh` is not installed or not logged in, say exactly that and stop. Do not fall back to guessing from branch names.
- If the command exits non-zero, show its message as it came. It is written to be read by the user rather than parsed.
- If a repository has no branches besides the default, say so in one line rather than printing two empty groups.
