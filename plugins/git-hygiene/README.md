# git-hygiene

Which old branches are safe to delete, and which are not.

Branches pile up. Every so often you notice, feel vaguely bad about it, and
either delete a pile of them or none of them. Both are bad options, because the
pile is two completely different things mixed together.

## The distinction the whole plugin is built on

There are two facts about a branch and they have nothing to do with each other.

**How old it is.** This is why you noticed it.

**Whether its commits are already in your main branch.** This is the only thing
that decides whether deleting it costs you anything.

A branch untouched since March whose work is all merged is a label pointing at
something safely stored elsewhere. Deleting it loses nothing. A branch untouched
since March with three unmerged commits is the only copy of those commits, and
deleting it destroys them.

Sorting by age mixes those together. That is how people lose work while tidying
up. So this never shows you one list. It shows you two, and it will not move
anything from the second list to the first.

## Use it

```
/stale-branches                     this repository
/stale-branches owner/name          a repository on GitHub
/stale-branches all                 every repository you own
```

You get something like this:

```
sarahcallmesmadds/always-allow: 3 branches besides the default one.

Safe to delete (1) — the default branch already has this work:
  deploy/vercel-site  (105 days old, merged in #51)

Keep (2) — deleting these would lose work:
  shop-redirect  (103 days old) — it has an open pull request, 1 commit not in the default branch
  private-workshop-page  (99 days old) — 3 commits not in the default branch

Delete the 1 safe one? (all / a list of names / none)
```

Every kept branch says why it was kept. There is no unexplained row.

## What it will not do

**It will not delete unmerged commits.** Not on `all`, not by accident, not
because a branch is old. If you genuinely want to throw work away it makes you
say so in a second, explicit sentence, and tells you the commits will not be
recoverable.

**It will not treat "I could not tell" as "it is merged."** If the comparison
fails for any reason, the branch is kept and the reason is shown. Not knowing is
never rounded down to zero.

**It will not touch** the default branch, a protected branch, the branch you
have checked out, or a branch with an open pull request, whatever their merge
state.

**It will not push, merge, or rebase.** Removing a label whose work is already
saved is the entire scope.

## The two deletes are not the same, and it treats them differently

Locally it only ever runs `git branch -d`, the lowercase one. That form refuses
to delete a branch holding unmerged commits, so git checks the answer
independently. If git disagrees, the plugin stops and tells you rather than
reaching for `-D` to get past it.

On GitHub there is no such check. The API deletes whatever ref you name, merged
or not. So every branch is re-checked immediately before it is deleted, one at a
time, and any branch that gained commits between being listed and being deleted
is skipped and reported. A list that was accurate when it was printed is not
necessarily accurate when you answer it.

## The session notice

In a git repository, it mentions once when a session starts that three or more
branches are both fully merged **and** have been sitting there a while.

Three separate things keep it quiet, and all three matter:

- **It never mentions branches holding work.** A notice you cannot safely act on
  is noise, and noise at the top of every session is how a plugin gets
  uninstalled.
- **It never mentions branches merged recently.** You were there when it merged.
  "A while" means `staleAfterDays`, 30 days by default, and this is the only
  place that setting decides anything.
- **It only speaks when a session actually starts.** `SessionStart` also fires
  on resume and on compaction, which happen inside a session that has already
  had the notice. Those are skipped.

If it cannot finish counting inside its time budget it says nothing at all,
rather than reporting a number that is only partly true.

It never blocks anything.

## Install

```
/plugin marketplace add sarahcallmesmadds/plugins
/plugin install git-hygiene@smadds
```

Add the marketplace **by repository**, as above. Pasting a direct URL to
`marketplace.json` downloads only that one file, the plugin folders never
arrive, and the install fails.

Checking a repository on GitHub needs the `gh` CLI, logged in. Checking a local
checkout does not.

## Configuration

None needed. The defaults are at the top of `scripts/classify.js`:

```js
protectedBranches: ['main', 'master', 'develop', 'release'],
staleAfterDays: 30,
```

**`protectedBranches`** are never offered for deletion, whatever their merge
state.

**`staleAfterDays` changes one thing only: how long a merged branch has to sit
there before the session notice will mention it.** It has no effect on what is
safe to delete, and no effect on `/stale-branches`, which always lists every
branch whatever its age. That is deliberate. When you ask directly you want the
whole answer, and a filter that quietly hides branches from a cleanup command is
how you end up believing a repository is tidy.

Nothing about age can ever move a branch into the safe list. There is no setting
for that and there is not meant to be.

## Upgrading to 0.1.1

One line. The per-repository summary in `/stale-branches` printed an em dash
between the repository name and its counts, and `slop-check` ships a Stop hook
that blocks em dashes in the assistant's own writing. So the command produced
its output, the hook blocked it, and the model rewrote it. Every run that
covered more than one repository.

Nothing noticed because the rewrite succeeds and the answer still arrives, a
round trip later. It is now a plain hyphen, which the hook does not touch.

Only relevant if you also have `slop-check` installed. The output is otherwise
identical.

## Codex

Codex plugins cannot register hooks, so on Codex you get `/stale-branches` and
not the session notice. The command is the same code either way. Nothing else
is degraded.

## Licence

MIT. See `LICENSE` at the repository root.
