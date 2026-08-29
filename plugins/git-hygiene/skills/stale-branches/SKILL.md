---
name: stale-branches
type: human
description: Lists old branches and separates the ones proved safe to delete from the ones not proved safe, then deletes the proved-safe ones after you approve them. Works on the current checkout, on a named GitHub repository, or across every repository you own. Use when the user asks "what branches can I delete", "clean up my branches", "do I have stale branches", "am I still carrying old branches", "tidy up git", or explicitly invokes /stale-branches. Never deletes anything without an explicit yes, and never routes a held branch into deletion.
argument-hint: "[nothing for this repo | owner/name | all]"
allowed-tools: Read, Bash(node:*), Bash(git:*), Bash(gh:*), Bash(ls:*)
---

You are finding branches that can be cleaned up, and deleting the ones the user approves.

Everything here rests on positive evidence that the work is already in the default branch. There are two kinds, and a branch needs only one.

The first is a count: how many branch commits are not reachable from the default branch. Zero is positive evidence that the branch is just a label over reachable history. One or more is not proof that the content is absent from the default branch, so the count cannot clear the branch by itself.

The second is separate content or merge evidence. On a local checkout, a comparison showing the branch adds nothing to the default branch counts. On `--repo`, where no local trees exist, a merged pull request into the default branch counts instead.

Local cleanup deliberately avoids the GitHub API. It does not read merged or open pull requests, so it may keep a branch that GitHub can prove safe using evidence unavailable locally. A normal listing may make one bounded `git ls-remote` freshness check; the pre-delete check is fully local and does not repeat network work per branch. Never upgrade a local Keep result using GitHub evidence yourself.

A branch with neither kind of evidence is kept, whatever its age.

**Age is not the test.** Old is why something is worth looking at. Positive reachability, content, or merge evidence is what makes it safe to remove.

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

**When you render the summary yourself, carry the caveats with it.** The JSON has four boolean keys beside `safe` and `keep`, and each means the answer below it is less certain than it looks:

- `remoteStale` — the comparison ran against a ref the remote has moved past, named in `remoteStaleRef`. Anything cleared by newer evidence may be sitting in "Keep" with an unreachable commit count. Say so, and say to run `git fetch` and try again.
- `mergeCheckUnavailable` — this git is too old to run the separate content comparison, so affected branches stay in "Keep".
- `mergedPRCheckUnavailable` — on `--repo`, merged pull requests could not be read, so branches that evidence would clear may be in "Keep". Say to check `gh auth status`.
- `openPRCheckUnavailable` — on `--repo`, every branch is held in "Keep" because the API has no safe-delete second opinion. Recommend `gh auth status`; never present the result as a normal complete listing.

Printing the counts without these turns a hedged answer into a confident one, which is the one thing this command must never do. The text output prints them as notes on its own; it is only the sweep, where you do the rendering, that can lose them.

Across many repositories this takes a few seconds per repository, because working out the commit count is one API call per branch. Say that before starting a sweep of more than about five, so the wait is expected rather than alarming.

---

## Step 3 — Show what was found

For one repository, print the command's own output. It is already grouped into "Safe to delete" and "Keep", with the reason spelled out for every kept branch.

For a sweep, lead with the totals and then break down by repository, listing only repositories that have something in them:

```
{N} branches across {M} repositories.
{S} are safe to delete. {K} are not proved safe to delete.

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
- A list of names means exactly those. If a named branch is under "Keep", stop and say why it is there. Do not route it into deletion or ask for force-delete confirmation.
- `none` or any negative: say "Nothing deleted." and stop.
- Anything ambiguous: ask once more. Deleting the wrong branch is not undoable by the user.

**If the user asks to delete something under "Keep"**, say that the plugin has not proved it safe to delete and stop that branch's workflow:

> "`{name}` is under Keep because {reason}. That is not proof that its content is absent from `{default}`, but it is also not enough evidence to delete it safely. I have left it alone. Inspect or preserve the branch before making any separate deletion decision."

Do not print or run `git branch -d`, `git branch -D`, or a remote ref deletion for a branch that remains under Keep. The force path below is only for a branch that `--verify` has already cleared using separate content evidence.

---

## Step 5 — Delete

**Re-check each branch immediately before deleting it, and re-check it with the same command that listed it.** The listing may be minutes old by the time the user answers, and on the remote side the GitHub API deletes whatever ref you name with no second opinion at all.

Do not compose your own re-check. An ancestry count is only one kind of evidence. A check written from that count alone refuses branches the separate content signal cleared and then reports the refusal as though something landed in between. Nothing landed. The check asked a narrower question than the listing.

For each branch, one at a time, never batched:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" --verify {name}
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" --repo {owner/name} --verify {name}
```

The full `${CLAUDE_PLUGIN_ROOT}` form, as everywhere else in this skill. This command runs in the user's own repository, which has no `scripts/` directory of ours, so a relative path exits with a module error rather than with 0 or 3 and the branching below has nothing to match.

**Exit 0** means still safe. **The delete command is the last line of the output. Run that line exactly, and do not count lines from the top.**

Everything above the last line is explanation, and how many lines of it there are varies: a branch cleared by merge evidence gets an extra `needs-force:` line that a branch cleared by ancestry does not. Taking "the second line" would run that prose as a shell command.

```
content-verified is safe to delete: already in the default branch
needs-force: git branch -d will refuse this. ...      <- explanation, varies
git branch -d content-verified                        <- always last, always the command
```

**Exit 3** means do not delete. It says why on stderr. Report that verbatim and move to the next branch. Do not ask again in this run.

Never check everything first and then delete everything, so a change part way through cannot affect a branch already cleared.

### When `--verify` prints a `needs-force:` line

That line means `git branch -d` is going to refuse this branch and the refusal is expected. `-d` asks only whether the branch's commits are reachable from the default branch. This branch was cleared by separate content evidence, which answers a different question.

Run the printed `-d` anyway and let it refuse. Then, **once for the whole group rather than once per branch**:

> "`git branch -d` refused {n} branches. That is expected: it only checks whether their commits are reachable from the default branch. Each branch was cleared by separate content evidence, specifically {the reason `--verify` printed}. Deleting them needs `git branch -D`. Say go and I will run it on those {n}."

Only on an explicit yes. Then, **for each branch in that group, one at a time**, run `--verify` again immediately before its `-D`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" --verify {name}
git branch -D {name}
```

Exit 0, delete it. Anything else, skip that branch, say what the check reported, and carry on with the rest.

The second check is not paperwork. The user's approval covers the group, and answering it takes as long as it takes, so the verdict that earned each branch its place in that group is by then arbitrarily old. This is also the one group running without git's own reachability check, which everything else in the local flow leans on. A branch that gained commits while the question sat unanswered is exactly what `-D` destroys with no recovery.

Ask once, check each. If they say no, leave them all and say what is left.

Never present this as git disagreeing with the classification. It is not a disagreement. Git was asked the reachability question, and the tool had already cleared the branch using separate content evidence.

Anything `--verify` did not clear is never deleted, with `-d` or `-D` or anything else. A refusal on a branch with no `needs-force:` line is a genuine disagreement and stops the run:

> "git refused to delete `{name}` and nothing said to expect that. I have left it alone. Worth a look before forcing it."

---

## Step 6 — Report

```
Deleted {n} branches: {names}.
{k} left alone, not proved safe to delete.
```

Add these lines only when they apply:

- `Skipped {name}: it gained commits between listing and deleting.`
- `git refused to delete {name}. Left alone.`
- `{p} repositories could not be read and were skipped: {names}.`

If a deleted branch was the last one in a repository besides the default, that is worth one line, because it usually means a piece of work finished and nobody closed it out.

---

## What this never does

- **A branch under Keep never enters a deletion path.** Only a branch cleared by `--verify` can reach `-d`, remote deletion, or the separately confirmed `-D` path.
- **It never treats "could not compare" as "merged".** A branch whose state cannot be determined is kept, and the reason is shown.
- **It never touches the default branch, a protected branch, or the branch that is checked out.** On `--repo`, it also never touches a branch with an open pull request. Local cleanup does not read GitHub review state.
- **It never pushes, merges, or rebases anything.** Deleting a merged label is the entire scope.

## Failure handling

- For `--repo`, if `gh` is not installed or not logged in, say exactly that and stop. Local cleanup does not require `gh`.
- If the command exits non-zero, show its message as it came. It is written to be read by the user rather than parsed.
- If a repository has no branches besides the default, say so in one line rather than printing two empty groups.
