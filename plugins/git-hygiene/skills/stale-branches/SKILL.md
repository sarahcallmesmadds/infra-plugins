---
name: stale-branches
type: human
description: Lists old branches and separates the ones that are safe to delete from the ones still holding unmerged work, then deletes the safe ones after you approve them. Works on the current checkout, on a named GitHub repository, or across every repository you own. Use when the user asks "what branches can I delete", "clean up my branches", "do I have stale branches", "am I still carrying old branches", "tidy up git", or explicitly invokes /stale-branches. Never deletes anything without an explicit yes, and never deletes a branch holding commits that exist nowhere else.
argument-hint: "[nothing for this repo | owner/name | all]"
allowed-tools: Read, Bash(node:*), Bash(git:*), Bash(gh:*), Bash(ls:*)
---

You are finding branches that can be cleaned up, and deleting the ones the user approves.

Everything here rests on positive evidence that the work is already in the default branch. There are two kinds, and a branch needs only one.

The first is a count: how many commits a branch has that are not already in the default branch. Zero means the work is safely there and the branch is just a label. One or more means those commits exist in exactly one place, and deleting the branch destroys them.

The second exists because that count cannot see a squash merge, which rewrites a branch into one new commit and leaves the originals unreachable. In a repository that squash-merges every pull request the count never reaches zero, so a merged pull request into the default branch counts too, and on a local checkout so does a comparison showing the branch adds nothing the default branch does not already have.

A branch with neither kind of evidence is kept, whatever its age.

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

**When you render the summary yourself, carry the caveats with it.** The JSON has two boolean keys beside `safe` and `keep`, and both mean the answer below them is less certain than it looks:

- `remoteStale` — the comparison ran against a ref the remote has moved past, named in `remoteStaleRef`. Anything merged since then is sitting in "Keep" with a commit count, which is exactly what unmerged work looks like. Say so, and say to run `git fetch` and try again.
- `mergeCheckUnavailable` — this git is too old to spot a squash merge, so every squash-merged branch is in "Keep".

Printing the counts without these turns a hedged answer into a confident one, which is the one thing this command must never do. The text output prints both as notes on its own; it is only the sweep, where you do the rendering, that can lose them.

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

**Re-check each branch immediately before deleting it, and re-check it with the same command that listed it.** The listing may be minutes old by the time the user answers, and on the remote side the GitHub API deletes whatever ref you name with no second opinion at all.

Do not compose your own re-check. An ancestry count is not the question any more: a squash merge never brings it to zero, so a check written that way refuses every branch the merge signal cleared and then reports it as though something landed in between. Nothing landed. The check asked a question the listing had already answered differently.

For each branch, one at a time, never batched:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" --verify {name}
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" --repo {owner/name} --verify {name}
```

The full `${CLAUDE_PLUGIN_ROOT}` form, as everywhere else in this skill. This command runs in the user's own repository, which has no `scripts/` directory of ours, so a relative path exits with a module error rather than with 0 or 3 and the branching below has nothing to match.

**Exit 0** means still safe. **The delete command is the last line of the output. Run that line exactly, and do not count lines from the top.**

Everything above the last line is explanation, and how many lines of it there are varies: a branch cleared by merge evidence gets an extra `needs-force:` line that a branch cleared by ancestry does not. Taking "the second line" would run that prose as a shell command.

```
squashed is safe to delete: already in the default branch
needs-force: git branch -d will refuse this. ...      <- explanation, varies
git branch -d squashed                                <- always last, always the command
```

**Exit 3** means do not delete. It says why on stderr. Report that verbatim and move to the next branch. Do not ask again in this run.

Never check everything first and then delete everything, so a change part way through cannot affect a branch already cleared.

### When `--verify` prints a `needs-force:` line

That line means `git branch -d` is going to refuse this branch and the refusal is expected. `-d` asks only whether the branch's commits are reachable from the default branch. A squash merge rewrites them into one new commit, so they never are, however certain the evidence is.

Run the printed `-d` anyway and let it refuse. Then, **once for the whole group rather than once per branch**:

> "{n} of these were squash merges, so `git branch -d` refused them. That is expected: it only checks whether the commits are reachable, and a squash merge rewrites them. Each one was verified another way, by {the reason `--verify` printed}. The work is in the default branch either way. Deleting them needs `git branch -D`. Say go and I will run it on those {n}."

Only on an explicit yes. Then, **for each branch in that group, one at a time**, run `--verify` again immediately before its `-D`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" --verify {name}
git branch -D {name}
```

Exit 0, delete it. Anything else, skip that branch, say what the check reported, and carry on with the rest.

The second check is not paperwork. The user's approval covers the group, and answering it takes as long as it takes, so the verdict that earned each branch its place in that group is by then arbitrarily old. This is also the one group running without git's own reachability check, which everything else in the local flow leans on. A branch that gained commits while the question sat unanswered is exactly what `-D` destroys with no recovery.

Ask once, check each. If they say no, leave them all and say what is left.

Never present this as git disagreeing with the classification. It is not a disagreement. Git was asked a question it cannot answer for a squash-merged branch, and the tool already answered it a different way.

Anything `--verify` did not clear is never deleted, with `-d` or `-D` or anything else. A refusal on a branch with no `needs-force:` line is a genuine disagreement and stops the run:

> "git refused to delete `{name}` and nothing said to expect that. I have left it alone. Worth a look before forcing it."

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
