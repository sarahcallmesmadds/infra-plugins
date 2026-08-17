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
/merge-strategy                     recommend how to merge the current change
```

You get something like this:

```
you/web-app: 3 branches besides the default one.

Safe to delete (1) — the default branch already has this work:
  deploy/staging-config  (105 days old, merged in #51)

Keep (2) — deleting these would lose work:
  fix/checkout-redirect  (103 days old) — it has an open pull request, 1 commit not in the default branch
  spike/pricing-page  (99 days old) — 3 commits not in the default branch

Delete the 1 safe one? (all / a list of names / none)
```

Every kept branch says why it was kept. There is no unexplained row.

`/merge-strategy` is the read-only companion for a branch or pull request. It
reads the commit count and shape, review/draft state, and whether the history is
public. It asks whether anyone else has based work on the branch instead of
pretending a pushed branch is private.

It recommends squash-and-merge for private fixup-heavy work, rebase-and-merge
for private branches with a small number of meaningful commits, and a merge
commit for shared/public history or meaningful merge topology. It says “not
ready” when the change is a draft, uncommitted, or cannot be compared safely.
It never merges, rebases, pushes, or deletes.

## What it will not do

**It will not delete unmerged commits.** Not on `all`, not by accident, not
because a branch is old. If you genuinely want to throw work away it makes you
say so in a second, explicit sentence, and tells you the commits will not be
recoverable.

**It will not treat "I could not tell" as "it is merged."** If the comparison
fails for any reason, the branch is kept and the reason is shown. Not knowing is
never rounded down to zero.

**Local cleanup does not use GitHub's API or pull-request state.** It uses commit
reachability and tree comparison, then relies on `git branch -d` as a final
safeguard. A normal listing may make one bounded `git ls-remote` call to check
whether the cached remote branch is stale; the pre-delete check makes no network
call. The trade-off is conservative: a squash merge that local Git cannot prove
may remain under Keep until you check and remove it yourself.

`--repo owner/name` is a different environment. It has no local Git objects or
`git branch -d`, so it uses merged and open pull requests from GitHub and holds
everything back when that evidence cannot be read.

**It will not touch** the default branch, a protected branch, or the branch you
have checked out. On `--repo`, it also holds back branches with open pull
requests. Local cleanup does not read review state.

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
/plugin marketplace add sarahcallmesmadds/infra-plugins
/plugin install git-hygiene@smadds
```

Add the marketplace **by repository**, as above. Pasting a direct URL to
`marketplace.json` downloads only that one file, the plugin folders never
arrive, and the install fails.

Checking a repository on GitHub needs the `gh` CLI, logged in. Local cleanup
does not use `gh`; its ordinary listing may make the bounded `git ls-remote`
freshness check described below, while its pre-delete check stays offline.

**Requires Node.js.** The hooks are plain Node scripts with no dependencies
to install, and `node` does not have to be on your `PATH`. Each hook is
started by `bin/hook-node`, which tries `$CLAUDE_HOOK_NODE`, then your
`PATH`, then `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and
`/usr/bin`, and uses the first one it finds.

That list exists because an app launched from the Dock never reads your shell
profile, so it starts with a bare `PATH` that has none of those directories
on it. Before 0.3.7 every hook here exited 127 under Codex for that reason,
and silently, because a failed hook does not interrupt your session.

Updating a plugin while a session is already open stops the hooks a second
way, unrelated to finding Node. The session is still pointing at the version
folder it started in, and Codex deletes that folder on update, so every hook in
that session fails until you restart. Each hook now checks that the file it is
about to run is still there. If it has gone, it prints one line saying hooks
are off until you restart, and steps aside. That does not keep the hooks
working, which nothing in the plugin can do from a folder that has been
deleted, but it tells you why they stopped instead of leaving you a bare error
code. The line shows up in the transcript once per hook per event, and blocks
nothing.

If your Node is somewhere else, name it:

```
export CLAUDE_HOOK_NODE=/path/to/node
```

Name the node program itself, not the directory holding it. When that variable
is set it is the only interpreter tried, and a value that is not an executable
file is an error rather than a reason to look elsewhere. Naming an interpreter
and silently getting a different one hides the mistake, and a directory passes
an executable check while starting nothing.

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

## Upgrading to 0.3.3

Checking a local checkout now contacts the remote once, and says when the copy
it compared against is out of date.

Everything the local path compares against is `origin/<default>`, a ref your
last `git fetch` wrote. It is not the remote. When a pull request merges in
between, those commits are genuinely absent from the copy, so the branches
holding them are listed under Keep with an ordinary commit count and nothing
says the answer came from old data. A stale answer and a current one looked
identical.

So the listing runs one `git ls-remote` against `origin`, compares the real
branch tip with the cached one, and prints a note when they differ telling you
to fetch and run it again.

What that costs, and when it is skipped:

- One network round trip per listing, bounded at 3 seconds. Offline, on a remote
  that cannot be reached, or where credentials are not already available, the
  probe fails, no note is printed, and every branch is classified exactly as
  before. It cannot ask you for anything: git's terminal prompt is off, the
  `GIT_ASKPASS` and `SSH_ASKPASS` helpers are removed from the environment for
  this one call along with `core.askPass`, the credential manager is told not to
  open a window, and `BatchMode=yes` is appended to whatever `GIT_SSH_COMMAND`
  you already have rather than replacing it. Credential helpers are left on, so
  a stored credential answered from a keychain still works. The line is drawn at
  asking you, not at using an answer you have already given.
- Not run for `--verify`, the re-check before each delete, which would otherwise
  make a twenty-branch cleanup twenty round trips.
- Not run under a deadline, which is how the session notice calls it. That notice
  is one line and would not carry the note anyway.

Neither skip can make a delete unsafe. An out-of-date copy makes branches look
less merged than they are, never more, so its only effect is holding something
back from deletion.

`--json` output gained two keys, `remoteStale` and `mergeCheckUnavailable`, both
always present. A caller parsing the JSON was previously getting the same answer
as the text output with the reasons to distrust it removed.

`--repo owner/name` is unaffected. It has always asked GitHub live.

## Upgrading to 0.2.0

A squash merge now counts as evidence that a branch is merged.

Before this, `aheadBy` was the only route into the safe list, and it reads
ancestry. A squash merge rewrites a branch into one new commit on the default
branch, so the branch's own commits never become reachable and the count never
falls to zero. In a repository that squash-merges every pull request, the
command could not clear a single branch, ever.

Two new signals, one per collection path. On GitHub, a pull request merged into
the default branch whose head is still the branch's tip. On a local checkout, a
comparison showing that merging the branch into the default branch changes
nothing, checked against `origin/<default>` as well, since a checkout that has
not pulled since the merge is behind by exactly the merge you are asking about.

Not an override. A branch with no merge evidence and unmerged commits is still
kept, and an `aheadBy` that could not be determined is still kept whatever the
new signal says.

Two things to know:

- `git branch -d` still refuses squash-merged branches, because it asks the
  ancestry question too. That refusal is now reported as expected rather than
  as a disagreement, and `/stale-branches` asks before forcing past it.
- The local comparison needs git 2.38 or newer. On older git it is skipped,
  every squash-merged branch stays in the Keep list, and the command says so
  rather than looking like a clean result. `--repo owner/name` works on any
  version.

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
