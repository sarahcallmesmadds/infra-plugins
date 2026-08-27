# guardrails release notes

Upgrade notes for past versions, moved out of the README so that file stays
focused on current installation, configuration and behavior.

## 0.5.7 — 2026-08-27

No runtime behavior changed. Historical upgrade notes moved here, while the
README keeps the current dynamic-path fallback, WebFetch coverage limit,
macOS temporary-directory guidance and empty default-registry contract.

## Upgrading to 0.5.0

**The `owners` rule is gone, and with it the lease files under
`~/.claude/guardrails-leases/`.** Nothing replaces it. A directory that was
refused to everyone but its owning skill is now an ordinary directory.

What to do:

- If your `~/.claude/guardrails.resources.json` has resources that carry only
  `owners`, they no longer do anything. Delete them, or give them a
  `requiresRead` naming the document that governs the directory.
- `~/.claude/guardrails-leases/` can be deleted. Nothing reads it.
- The shipped registry is now empty, so if you were relying on the two
  directories it used to protect, they are no longer protected by default and
  were never yours to begin with.

Why it went rather than getting fixed: it was added as a backstop rather than
after anything went wrong, and it has no recorded instance of stopping a bad
write. It twice refused the owning skill itself, since a lease was only written
when a skill was invoked as a tool and not when its slash command was typed. And
the failure it tended to be reached for, a file landing somewhere it should not,
was never something it could catch, because it only inspects writes going into
the governed directory.

`requiresRead` is unaffected.

## Upgrading to 0.4.0

Resources gain `requiresRead`: a list of documents that must be open in this
session before anything under the resource can be written.

It sits beside `owners` rather than replacing it, because the two answer
different questions. `owners` is who may write. `requiresRead` is what has to be
in front of you first. A resource may set either or both, so a directory that
belongs to no skill can still be governed by a document. `readReason` is
optional prose printed with the refusal.

Also in this release:

- Resources may list several locations with a `paths` array, so a directory
  checked out both canonically and in a git worktree is guarded in both.
- Every resource covering a write is now evaluated rather than only the first
  match, so registry order no longer decides which rules apply.

Nothing to do on upgrade, with one exception worth checking.

**A resource with no `owners` no longer blocks on the ownership gate.** It used
to, because any matched resource without a live lease was refused, and an entry
with an empty or missing `owners` array produced a refusal reading "is owned by"
with nothing after it. That was a degenerate message rather than a designed
behaviour, but it did work as a blanket deny, and anyone whose own
`~/.claude/guardrails.resources.json` relies on that will find it has stopped.
An ownerless entry now means "not owned by any skill", which is what the field
says and what `requiresRead`-only resources need. If you were using one as a
hard deny, give it a `requiresRead` naming the document that governs it. The
advice here originally offered `owners` as the other option; that field was
removed in 0.5.0 and no longer does anything.

Shell write detection is unchanged and still matches registered paths literally.
See the limit noted under Governed resources.

## Upgrading to 0.2.4

**If you are on 0.2.3 or earlier, the branch guard misses the most ordinary way
to write a path.** This commits to `main` without a word:

```
cd ~/Projects/thing && git commit -m "wip"
```

`~` is expanded by your shell, so the guard only ever sees the four characters
`~/Pr…` and looks for a directory literally named that. There isn't one, the
lookup throws, and the commit is allowed. Writing the same path out in full was
blocked correctly, so whether the guard worked came down to how the path
happened to be typed.

Tildes are now expanded before the lookup, for both `cd` and `git -C`.

A relative path is resolved against the directory the command runs in, not
against wherever the hook process happens to sit, so `cd subdir && git commit`
is judged in the repository you actually mean.

**A path only your shell can work out now falls back to the directory the
command runs in.** Plenty of paths cannot be read out of the command text at
all:

```
cd $REPO && git commit
cd "$(git rev-parse --show-toplevel)" && git commit
git clone https://example.com/x r && cd r && git commit
```

Refusing these was tried during development and it was wrong. It stopped
ordinary work and told people to write out a path that is computed, which they
cannot do.

The fallback is not a consolation prize. `$(git rev-parse --show-toplevel)` is
the repository the command already sits in, so the fallback answers it exactly.
A path in a variable usually points at the repository you are working in, so it
answers that often too.

Two limits, stated rather than implied:

**A commit aimed at a different repository named dynamically is not checked.**
The fallback reads the directory you are standing in, so if the computed path
points somewhere else, the answer is about the wrong repository. It is not
guessed at.

**The reverse also happens.** Clone into a subdirectory while standing in a
repository that is on `main`, then commit into the clone, and the fallback
answers `main` from the outer repository and stops you. Rare, and it errs
toward interrupting rather than toward missing, which is the right way round
for a guard. Name the path explicitly if you hit it.

These stay quiet on purpose:

| case | why it is left alone |
|---|---|
| directory exists, is not a repository | `git commit` fails on its own |
| detached HEAD | a valid repository doing normal work |
| nothing named, and nowhere is a repository | committing outside a repository is not a thing |

Nothing about your config changes. Run `/plugin update guardrails@infra-plugins`.

## Upgrading to 0.2.3

**If you are on 0.2.2 or earlier, the scanner never looked at anything you
read.** It reported clean on every file and every fetched page since the plugin
shipped, because it was reporting on an empty string rather than on the content.

The hook looked for the text at `tool_response`, `tool_response.content`, or an
array under the same key. Claude Code puts it somewhere else: `Read` returns it
at `tool_response.file.content`, and `WebFetch` at `tool_response.result`. None
of the three matched, so the hook took the empty string as nothing to do and
exited without writing anything. A scanner that is silent because it found
nothing and one that is silent because it was handed nothing look identical from
outside.

This is the same failure as the block-shape bug in 0.2.1, one layer along. The
detector was fine both times, its own tests passed both times, and the wiring
between the harness and the detector was wrong both times. A detector tested on
strings you hand it cannot tell you whether anything is ever handed to it.

The scanner on content the model **writes** was never affected. It reads
`tool_input`, which it had right.

Both shapes are now taken from `PostToolUse` events captured off a live run and
kept as fixtures under `tests/fixtures/`, so the tests describe the harness
rather than describing the code. Two of them fail against 0.2.2.

One limit worth knowing rather than discovering: for `WebFetch`, `result` is the
processed answer for the page, not the raw HTML. An injection that never reaches
that text is not visible to this hook. Instructions aimed at a model tend to
survive being summarised, that being their whole purpose, but this is not the
same coverage as scanning the page itself.

Nothing about your config changes. Run `/plugin update guardrails@infra-plugins`.

## Upgrading to 0.2.2

Two fixes, both found by running the guards rather than reading them.

**The branch guard could check the wrong repository.** It worked out which repo
a command targeted from the command text, handling `git -C <path>` and
`cd <path> && git commit`, and otherwise fell back to its own process directory.
A hook is a separate process spawned by the harness, so that directory is not
reliably where the command runs. The Bash tool also keeps its working directory
between calls, so changing directory in one call and committing in the next is
ordinary, and only the hook event knows about the first call. It now reads the
directory from the event, and an explicit `-C` still takes precedence.

**`/private/tmp` was blocked while `/tmp` was allowed.** On macOS `/tmp` is a
symlink to `/private/tmp`, so those are one directory with two spellings, and
only one of them was on the disposable list. Any tool reporting a real path
rather than the symlink hit the block every time, on directories that exist to
be thrown away. Both spellings are now listed. This widens nothing, because it
is the same directory that was already trusted under its other name.

Still not covered: the per-user temp directory under `/var/folders` on macOS,
which is what `os.tmpdir()` returns. It differs per machine so it cannot ship as
a default. Add it to `safeDeletePaths` yourself if you delete there often.

Nothing about your config changes. Run `/plugin update guardrails@infra-plugins`.

## Upgrading to 0.2.1

**If you are on 0.2.0 or earlier, none of the blocking worked.** The guards ran,
reached the right verdict and reported it, but they reported it in a shape that
PreToolUse hooks no longer read, so Claude Code ignored the answer and ran the
command. That covers all three blocking checks: recursive deletes, commits to a
protected branch, and the commit message format. The injection scanners were
never affected, because they only add a note and already used the current shape.

Nothing about your config changes. Run `/plugin update guardrails@infra-plugins`.

## Upgrading from 0.1.x

The two skills were renamed in 0.2.0, because the old names described what they
read rather than what they look for, and you could not tell them apart from the
installed list.

| 0.2.0 | was |
|---|---|
| `injection-scan` | `content-audit` |
| `undo-possible` | `command-check` |

Nothing else changed. The hooks, the detection logic, and the config file are
untouched, so an existing `guardrails.config.json` still applies. Re-run
`/plugin install guardrails@infra-plugins` to pick up the new names.
