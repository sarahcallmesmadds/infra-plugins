# git-hygiene release notes

Upgrade notes for past versions, moved out of the README so that file stays
focused on current installation, configuration and behavior.

## 0.3.12 — 2026-08-29

**Keep now means "not proved safe to delete," not "deleting would lose work."**

Commit reachability is one safety signal, not proof that equivalent work exists
nowhere else. The CLI, skill, session notice and discovery copy now say that
plainly. A branch still under Keep never enters a delete path, while a branch
already cleared by separate content evidence retains the existing confirmed
force-delete sequence when lowercase `git branch -d` refuses it.

Classification, collection, deletion commands and JSON output are unchanged.

## 0.3.11 — 2026-08-27

**Hook failure notices keep plugin paths intact.** Nothing to change on your side.

The session-start hook now prints its warning with `printf`. A plugin path
containing a backslash stays on one stderr line, including the file name and
the `chmod +x` instruction.

## 0.3.10 — 2026-08-27

No runtime behavior changed. Historical upgrade notes moved here, while the
README keeps the current remote-probe contract, squash-merge deletion rules,
Git version requirement and Codex restart guidance.

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
