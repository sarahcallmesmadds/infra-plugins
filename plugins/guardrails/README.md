# guardrails

Catch the mistakes that don't undo.

Most guidance for AI coding tools assumes an engineer who already knows not to
commit to main, not to run `rm -rf` outside a build directory, and not to trust
text a webpage handed them. If you are building anyway without that background,
nobody has packaged that knowledge for you. This is an attempt at it.

## What it does

Five things, and it says which are enforced and which are advice.

**Blocks direct commits to a protected branch.** `main` and `master` by default,
in every repository, not just the ones you remembered to configure. Says what to
type instead. This one refuses rather than asks, and so does the commit message
check, because each of them knows the better command and prints it. There is
nothing for you to weigh.

**Asks before commands that cannot be undone.** Recursive force-delete outside
disposable paths, `git reset --hard`, `git clean -fd`, `git push --force`, and
`git branch -D`. It deliberately allows `git push --force-with-lease`, which
refuses to overwrite work you have not seen.

These prompt rather than refuse, and the difference is who can answer. The guard
knows what the command does and not whether you want it, so it says what would
happen and puts the decision to you. Until 0.5.1 the same reasons arrived as a
refusal, which made "confirm this is intended before running it" impossible to
act on: a squash-merged branch could not be deleted through the tool at all, and
the way past was to leave the session and run the command by hand. A guard you
have to step around to do ordinary work is not adding safety.

**Asks before going around the commit hooks.** `git commit --no-verify` and its
short form `-n` skip every pre-commit and commit-msg hook, and the commit that
results looks exactly like one that passed them, so nothing afterwards records
that the checks did not run. It deliberately allows a dry run of `git clean` in
every spelling, `-n`, `-nd`, `-ndx` and `--dry-run`, since a preview removes
nothing.

**Flags prompt injection in content.** Text that arrives from a file or a fetched
page is data, not instruction. The risk is that instructions buried inside it
get treated as though you wrote them. That is easy to spot when you read a
document and act on it immediately, and hard once a long session compacts:
a summary cannot tell you whether "delete the old records" came from you or from
a file that suggested it. Flagging at the moment content arrives is the last
point where the difference is still visible.

**Blocks writes to a directory whose governing document you have not read.**
Point a resource at a folder, name the document that governs it, and a Write,
Edit, NotebookEdit or common shell write into that folder is denied until the
document has been opened in that session. Nothing is governed by default; you
add your own.

## Claude Code gets enforcement, Codex gets advice

This is a real limitation and worth knowing before you install.

| | Claude Code | Codex |
|---|---|---|
| Automatic prompting and blocking | Yes, via hooks | No |
| On-demand scanning | Yes | Yes |

Codex plugins cannot register hooks. Its plugin manifest accepts skills, MCP
servers, and apps, and nothing else. So in Codex the same checks exist as two
skills you invoke, `injection-scan` and `undo-possible`, rather than as guards
that fire whether or not the model cooperates.

Both runtimes call the same code in `scripts/`. The detection logic exists once,
so a verdict reads identically wherever it came from. Only the trigger differs.

## Install

```
/plugin marketplace add sarahcallmesmadds/infra-plugins
/plugin install guardrails@smadds
```

Add the marketplace **by repository**, as above. If you add it by pasting a
direct URL to `marketplace.json`, only that one file downloads and the plugin
folders never arrive, so the install fails.

**Requires Node.js.** The hooks and the scanner are plain Node scripts with no
dependencies to install, but `node` has to be on your `PATH`. If it is not,
the hooks fail silently rather than breaking your session, which means you get
no protection and no error. Check with `node --version` before relying on it.

**The delete rule asks when somebody is there and refuses when nobody is.**
From 0.5.1 the destructive and commit-hook rules ask rather than refuse, and an
ask is settled by whatever answers permission prompts. In an interactive session
that is you. In a run that approves whatever it is asked, it is not, and a
prompt there has the form of a check and none of the effect.

So from 0.5.2 the hook reads `permission_mode`, which arrives on every event,
and picks accordingly. In `bypassPermissions` and `dontAsk` it refuses, which is
what those runs got before 0.5.1, so nothing regressed for them. Everywhere else
it asks. The refusal says which mode caused it and how to get asked instead, rather
than telling you to confirm something that in that mode you cannot.

Two limits, stated rather than guessed at.

`auto` and `acceptEdits` still ask. Whether either answers a shell prompt
without a person is not something this repository can establish, and being
wrong toward asking costs a prompt while being wrong toward refusing costs you
a command you were standing there to approve.

Whether an existing allow rule for the same command, `Bash(rm:*)` say, settles
the prompt before you see it is a question about Claude Code's permission
precedence rather than about this plugin, and the documentation does not answer
it. If it does pre-empt the prompt, this rule is advisory for you. An earlier
draft of this section asserted that it does, which was a guess written as a
fact; it is withdrawn rather than restated more carefully. If you lean on broad
allow rules, check it on your own setup.

That is the trade, taken deliberately. Refusing gave a strictness nobody could
lift: every one of those reasons ends by asking you to confirm that the command
is intended, and there was no way to confirm, so the only route past a guard
that had done its job was to leave the session and run the command by hand. A
guard people step around to do ordinary work protects nobody, and it teaches the
habit of stepping around it.

The two rules that refuse are unaffected, because they never asked anything:
a commit to a protected branch and a commit message that misses the format are
still stopped whatever mode you are in, and they are stopped even when the same
command also trips a rule that would otherwise prompt.

If you run on a permissive mode and want the old behaviour for deletes, there is
no setting for it short of `blockDestructiveCommands: false`, which turns the
rule off rather than hardening it. Worth knowing before you rely on it.

## Configuration

Everything works out of the box. To change something, create
`~/.claude/guardrails.config.json`. Your file is merged over the defaults one
key at a time, so setting one option does not reset the others.

```json
{
  "protectedBranches": ["main", "master", "release"],
  "requireConventionalCommits": true,
  "safeDeletePaths": ["/tmp/", "node_modules", "dist", "vendor"]
}
```

| Key | Default | What it does |
|---|---|---|
| `protectedBranches` | `["main", "master"]` | Branches that reject a direct commit |
| `blockCommitToProtectedBranch` | `true` | Turn the branch guard off entirely |
| `requireConventionalCommits` | `false` | Require `feat:`, `fix:`, `docs:` and friends |
| `blockDestructiveCommands` | `true` | Turn the delete prompt off entirely |
| `blockCommitHookSkip` | `true` | Turn the `--no-verify` prompt off entirely |
| `safeDeletePaths` | see `scripts/config.js` | Paths where force-delete needs no prompt |
| `scanForInjection` | `true` | Turn content scanning off entirely |
| `injectionExcludePaths` | `[]` | Extra regex patterns to skip when scanning |

### Governed resources

A resource carries one rule, `requiresRead`.

It is a list of documents that must have been opened in this session before
anything under the resource can be written. It exists for the case where a
decision is written down, known about, and skipped anyway: an approved design
system sat in a planning folder for three days while a page was built against
nothing and then thrown away on sight.

**There used to be a second rule, `owners`, and it was removed in 0.5.0.** It
named the skills allowed to write a resource and refused everyone else, proved
by a lease file written when an owning skill started. If you have `owners` in
your own registry it is now inert, and nothing else about that resource changes.

It was removed rather than repaired because the case for it never materialised.
It was added as a backstop rather than after anything went wrong, and across the
time it ran there is no recorded instance of it stopping a bad write. It twice
refused the owning skill itself, which was the one caller it existed to admit,
because a lease was only ever written when a skill was invoked as a tool and not
when its slash command was typed. The failure people reached for it to prevent,
a handoff landing somewhere it should not, was never something it could catch:
it only inspects writes going into the governed directory, and a file written to
the wrong place is by definition not in that directory.

`requiresRead` is a different rule with a different history and it stays. Note
what it asks. `owners` asked who you are, which a guard cannot really know.
`requiresRead` asks whether a document is in front of you, which it can check.

Add `readReason` to say why, in your own words. It is printed with the refusal,
so the rule arrives with its reason instead of as a wall.

The check reads the session record, so opening the file with the Read tool
satisfies it and `cat` in a shell does not. That is deliberate: the point is
that the document is loaded where the work can see it, not that it scrolled
past. If the record cannot be read at all, the gate opens rather than closing,
in line with every other hook here. An unreadable record looks exactly like a
session where nothing was read, and a block on that basis could never be lifted.

Two kinds of read do not count, and the refusal says so:

- **A read that failed.** A Read that hit a missing file or a refused
  permission still leaves a record that it was asked for. Only the result
  decides. A read whose result is simply not in the record yet still counts, so
  an incomplete record cannot hold the gate shut.
- **A read narrowed by `offset` or `limit`.** Part of a governing document is
  not the document.

A skill's own writes are not exempt. If a resource requires a document, the
skill that writes there has to have opened it in that session like anyone else.

A resource may also list several locations with a `paths` array beside `path`.
A git worktree puts the same directory in two places while a branch is in
flight, and a guard that knows only the canonical checkout is off at exactly the
moment the work is happening.

Every resource covering a write is evaluated, not just the first one that
matches, so a rule on a directory and a rule on something inside it both apply
whatever order they appear in.

**One limit worth knowing.** Shell commands are matched against the registered
path spellings literally. A `Write` or `Edit` resolves symlinks and relative
names properly, but `rm f.txt` typed inside a guarded directory, or a write
through `/tmp` when the resource is registered under `/private/tmp`, is not
caught. Widening that is its own piece of work: the version that tried also
began refusing `grep "a>b"` inside a guarded directory, and a guard that blocks
ordinary commands is one that gets switched off.

### The default registry

The default registry is `hooks/resource-owners.json` and **it is empty**. This
plugin governs nothing until you say so.

Until 0.5.0 it shipped two directories from the author's own machine, which is
a rule about one laptop arriving on every install. Because the user registry
replaces the shipped list rather than merging with it, nobody could remove them
locally either without restating the whole policy.

To add your own, create `~/.claude/guardrails.resources.json`. Each resource has
an `id`, human-readable `label`, `type` (`file` or `directory`), and `path`,
plus any of `paths`, `requiresRead` and `readReason`:

```json
{
  "resources": [
    {
      "id": "site",
      "label": "the marketing site",
      "type": "directory",
      "path": "~/Projects/example/site/",
      "requiresRead": ["~/.planning/DECISION-design-system.md"],
      "readReason": "The design system was approved on 5 August and governs every route."
    }
  ]
}
```

Machine-specific entries belong there rather than in the shipped registry, for
the reason above.

If you find yourself approving the same deletion repeatedly, add that path to
`safeDeletePaths` rather than approving it each time. A guard you routinely
override is training you to ignore it.

An entry there takes one of two forms, and the leading slash picks between
them. `/tmp/` is anchored: it means that one absolute location and nothing
else, which is what stops `~/scratch/tmp` counting as disposable. `dist` is
unanchored: it means a directory of that name wherever it turns up, at any
depth. Build output wants the second form, because a `dist` is a `dist` in
every project. Writing one of those with a leading slash gives you an entry
that matches nothing.

## How severity works, and how noisy it is

The scanner groups patterns into nine categories: instruction override, role
reassignment, fake conversation boundaries, exfiltration, secret solicitation,
tool coercion, authority spoofing, obfuscation, and summarisation survival. Severity is scored by how
many **distinct categories** a piece of text trips, not by how many times one
phrase appears, so a document that repeats a loaded phrase twenty times still
counts as one signal.

- **none**, nothing matched
- **low**, one or two categories. Usually benign. Read the excerpt and judge
- **high**, three or more categories. Treat as hostile until shown otherwise

Measured against 213 real markdown files (skill definitions, operating docs,
security notes, and a code-review protocol): **zero scored high, ten scored
low, and 203 were clean.** All ten low results were true pattern matches on
real code, specifically `curl` calls carrying a bearer token, which is
genuinely the shape of exfiltration even when the intent is fine. That is the
severity model working rather than failing: benign files land at low, and
nothing benign reached high.

Files that legitimately quote injection strings are skipped by default. That
covers security notes, threat models, `.planning/` directories, and this
plugin's own source, which would otherwise flag itself.

## What this does not do

It is a heuristic over phrasing, not a sandbox and not a security product. It
will miss a novel injection written in unfamiliar wording, and it will
occasionally flag a document that is entirely fine. It does not inspect
compiled code, it does not sandbox execution, and it does not stop you from
approving something you should not.

Treat it as the seatbelt, not the airbag.

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

Nothing about your config changes. Run `/plugin update guardrails@smadds`.

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

Nothing about your config changes. Run `/plugin update guardrails@smadds`.

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

Nothing about your config changes. Run `/plugin update guardrails@smadds`.

## Upgrading to 0.2.1

**If you are on 0.2.0 or earlier, none of the blocking worked.** The guards ran,
reached the right verdict and reported it, but they reported it in a shape that
PreToolUse hooks no longer read, so Claude Code ignored the answer and ran the
command. That covers all three blocking checks: recursive deletes, commits to a
protected branch, and the commit message format. The injection scanners were
never affected, because they only add a note and already used the current shape.

Nothing about your config changes. Run `/plugin update guardrails@smadds`.

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
`/plugin install guardrails@smadds` to pick up the new names.

## Licence

MIT. See `LICENSE` at the repository root.
