# git-hygiene

Which branches are proved safe to delete, and which linked worktrees can be
moved or removed without guessing.

Branches pile up. Every so often you notice, feel vaguely bad about it, and
either delete a pile of them or none of them. Both are bad options, because the
pile is two completely different things mixed together.

## The distinction the whole plugin is built on

There are two facts about a branch and they have nothing to do with each other.

**How old it is.** This is why you noticed it.

**Whether there is positive evidence that it is safe to delete.** That evidence
can come from commit reachability or from a separate content or merge check.

A branch untouched since March whose commits are reachable from the default
branch is only a label over reachable history. A branch with three commits not
reachable from the default branch is held unless separate evidence proves its
content is already represented there. The count alone does not prove the work
exists nowhere else.

Sorting by age mixes those together. That is how people lose work while tidying
up. So this never shows you one list. It shows you two, and it will not move
anything from the second list to the first.

## Use it

```
/stale-branches                     this repository
/stale-branches owner/name          a repository on GitHub
/stale-branches all                 every repository you own
/merge-strategy                     recommend how to merge the current change
/git-hygiene:worktree-hygiene status   inspect linked worktrees
/git-hygiene:worktree-hygiene create   create an isolated checkout
/git-hygiene:worktree-hygiene activate lock an existing checkout as active work
/git-hygiene:worktree-hygiene cleanup  remove approved finished worktrees
/git-hygiene:setup                  configure project and worktree roots
```

You get something like this:

```
you/web-app: 3 branches besides the default one.

Safe to delete (1) — the default branch already has this work:
  deploy/staging-config  (105 days old, merged in #51)

Keep (2), not proved safe to delete:
  fix/checkout-redirect  (103 days old) — it has an open pull request, 1 commit not reachable from the default branch; that does not prove their work is absent from it
  spike/pricing-page  (99 days old) — 3 commits not reachable from the default branch; that does not prove their work is absent from it

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

## Linked worktrees

`worktree-hygiene` uses Git's registered worktree list as its source of truth.
It does not infer ownership from a directory name. One deterministic script
classifies every linked checkout in this order:

1. primary checkout;
2. locked;
3. missing registration;
4. dirty, including staged, untracked, and ignored files;
5. detached or owned by a recognized review tool;
6. attached to an open pull request;
7. positively proved merged;
8. carrying work not proved present in the default branch; or
9. unknown because required evidence could not be read.

Only `merged` reaches ordinary removal. The script checks the exact path again
immediately before `git worktree remove` runs. It refuses the primary checkout,
the caller's current directory, a changed registration, a lock, any working-tree
change, ignored local data, an open review, unique work, and incomplete evidence. It never uses
`--force`, never removes more than one approved path at a time, and never deletes
the branch.

Creating an agent worktree uses this layout:

```text
~/.worktrees/<remote-owner>/<repository>/<branch>/
```

That concise layout applies to a normal `github.com/<owner>/<repository>` remote.
Other hosts use `<remote-host>/<full-namespace>/<repository>` so distinct remote
identities cannot collide. Repositories without a parseable remote use a stable local repository identity.
Branch path components use reversible percent encoding, so distinct valid names
cannot collapse onto the same directory.
Created worktrees are locked as active agent work. `finish` unlocks one only
after the user confirms no session is using it and the script proves it clean.
Unlocking makes it reviewable; it does not remove it.

`activate` adds the same protective lock to an existing linked checkout after
exact-path approval. A locked registration whose directory is absent remains
locked until `finish` clears it with the primary checkout named explicitly;
only then can the separate missing-registration prune flow consider it.

`relocate` moves only an exact clean, unlocked, attached worktree to its computed
hidden path. Existing review-tool worktrees stay in their owner-specific cache.

## What it will not do

**It will not route a branch under Keep into deletion.** A held branch stays
untouched. If the evidence changes, run the listing and `--verify` again so the
branch can be classified from the current facts.

**It will not treat "I could not tell" as "it is merged."** If the comparison
fails for any reason, the branch is kept and the reason is shown. Not knowing is
never rounded down to zero.

**Local cleanup does not use GitHub's API or pull-request state.** It uses commit
reachability and tree comparison, then relies on `git branch -d` as a final
safeguard. A normal listing may make one bounded `git ls-remote` call to check
whether the cached remote branch is stale. The probe is capped at three seconds,
cannot open terminal, credential-manager or SSH prompts, and is skipped during
`--verify` and deadline-bound session notices. The pre-delete check makes no
network call. JSON output always includes `remoteStale` and
`mergeCheckUnavailable`, so automation keeps the same caveats as the text. The
trade-off is conservative: a branch that separate local content evidence cannot
clear may remain under Keep until the evidence can be checked.

`--repo owner/name` is a different environment. It has no local Git objects or
`git branch -d`, so it uses merged and open pull requests from GitHub and holds
everything back when that evidence cannot be read.

**It will not touch** the default branch, a protected branch, or the branch you
have checked out. On `--repo`, it also holds back branches with open pull
requests. Local cleanup does not read review state.

**It will not push, merge, or rebase.** Removing a label whose work is already
saved is the entire scope.

## The two deletes are not the same, and it treats them differently

Locally it starts with `git branch -d`, the lowercase one. That form checks
whether the branch commits are reachable from the default branch. A branch
cleared by separate content evidence may still be refused by `-d`; after the
expected refusal and explicit group confirmation, the plugin re-verifies each
branch and may use `-D` for exactly that branch. It never forces a branch that
lacks separate content evidence.

The local content comparison needs Git 2.38 or newer. On an older version the
check is skipped, affected branches stay under Keep, and the command says why.

On GitHub there is no such check. The API deletes whatever ref you name, merged
or not. So every branch is re-checked immediately before it is deleted, one at a
time, and any branch that gained commits between being listed and being deleted
is skipped and reported. A list that was accurate when it was printed is not
necessarily accurate when you answer it.

## The session notice

In a git repository, it mentions once when a session starts that three or more
branches have been proved safe to delete **and** have been sitting there a while.
With worktree configuration enabled, the same bounded notice also reports linked
worktrees still sitting inside visible project roots and missing registrations.
It does not access GitHub, move anything, or claim a partial count.

Three separate things keep it quiet, and all three matter:

- **It never mentions branches that are not proved safe to delete.** A notice
  you cannot safely act on is noise, and noise at the top of every session is
  how a plugin gets uninstalled.
- **It never mentions branches merged recently.** You were there when it merged.
  "A while" means `staleAfterDays`, 30 days by default, and this is the only
  place that setting decides anything.
- **It only speaks when a session actually starts.** `SessionStart` also fires
  on resume and on compaction, which happen inside a session that has already
  had the notice. Those are skipped.

If it cannot finish counting inside its time budget it says nothing at all,
rather than reporting a number that is only partly true.

The session notice never blocks anything.

## Direct worktree command guard

When `enforceWorktreeRoot` is enabled, the PreToolUse hook denies direct agent
commands that run mutating `git worktree` operations. `list`, `repair`, and prune
dry-runs remain available. `add`, `move`, `remove`, `lock`, `unlock`, and a
non-dry-run `prune` are routed through `worktree-hygiene`, even when a raw add
already names the canonical path. That prevents a direct Git command from
bypassing repository identity, activity locks, approval, or the final verifier.

This boundary governs agent tool calls in a host running the plugin. Git has no
native hook for worktree creation, so commands typed manually in Terminal, GUI
applications, and unrelated processes are detected by the next audit rather
than intercepted.

## Install

```
/plugin marketplace add sarahcallmesmadds/infra-plugins
/plugin install git-hygiene@infra-plugins
```

Run `/git-hygiene:setup` once after installation to confirm the project roots
to scan and the hidden worktree root. Branch hygiene and current-repository
worktree status remain available without setup; global discovery, canonical
worktree creation, and direct-command enforcement remain off until it runs.

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

These hooks run in both Claude Code and Codex.

Updating a plugin while a session is already open stops the hooks a second
way, unrelated to finding Node. The session is still pointing at the version
folder it started in, and Codex deletes that folder on update, so every hook in
that session fails until you restart. Each hook now checks that the file it is
about to run is still there. If it has gone, it prints one line saying hooks
are off until you restart, and steps aside. That does not keep the hooks
working, which nothing in the plugin can do from a folder that has been
deleted, but it tells you why they stopped instead of leaving you a bare error
code. If the file is there and has simply lost its execute bit, which a zip
download or a checkout without file modes can do, it says that instead and
names the file, because a restart will not fix that one. The line shows up in
the transcript once per hook per event, and blocks nothing.

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

Branch hygiene needs no configuration. Its defaults are at the top of
`scripts/classify.js`:

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

Worktree placement and global discovery use user-owned configuration at
`~/.claude/git-hygiene.config.json`. Run `/git-hygiene:setup` to discover local
project roots and approve a proposal like:

```json
{
  "projectRoots": ["~/Projects"],
  "worktreeRoot": "~/.worktrees",
  "enforceWorktreeRoot": true,
  "sessionNotice": true
}
```

No personal path ships in the plugin. Without this file, worktree status still
works for the current repository, while global scanning, canonical creation,
and the direct-command guard remain off. Setup writes only this configuration;
it does not migrate existing worktrees.

## Codex

`/stale-branches`, `/git-hygiene:worktree-hygiene`, setup, and both hooks use
the same code in Codex and Claude Code.

The one thing to know is that Codex replaces a plugin's version folder when it
updates, so a session already open when that happens loses its hooks until you
restart. Since 0.3.8 the notice says so instead of failing silently.

## Licence

MIT. See `LICENSE` at the repository root.
