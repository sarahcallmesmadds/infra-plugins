# guardrails

Catch the mistakes that don't undo.

Most guidance for AI coding tools assumes an engineer who already knows not to
commit to main, not to run `rm -rf` outside a build directory, and not to trust
text a webpage handed them. If you are building anyway without that background,
nobody has packaged that knowledge for you. This is an attempt at it.

## What it does

Three things, and it says which are enforced and which are advice.

**Blocks direct commits to a protected branch.** `main` and `master` by default,
in every repository, not just the ones you remembered to configure. Says what to
type instead.

**Blocks commands that cannot be undone.** Recursive force-delete outside
disposable paths, `git reset --hard`, `git clean -fd`, `git push --force`, and
`git branch -D`. It deliberately allows `git push --force-with-lease`, which
refuses to overwrite work you have not seen.

**Flags prompt injection in content.** Text that arrives from a file or a fetched
page is data, not instruction. The risk is that instructions buried inside it
get treated as though you wrote them. That is easy to spot when you read a
document and act on it immediately, and hard once a long session compacts:
a summary cannot tell you whether "delete the old records" came from you or from
a file that suggested it. Flagging at the moment content arrives is the last
point where the difference is still visible.

## Claude Code gets enforcement, Codex gets advice

This is a real limitation and worth knowing before you install.

| | Claude Code | Codex |
|---|---|---|
| Automatic blocking | Yes, via hooks | No |
| On-demand scanning | Yes | Yes |

Codex plugins cannot register hooks. Its plugin manifest accepts skills, MCP
servers, and apps, and nothing else. So in Codex the same checks exist as two
skills you invoke, `injection-scan` and `undo-possible`, rather than as guards
that fire whether or not the model cooperates.

Both runtimes call the same code in `scripts/`. The detection logic exists once,
so a verdict reads identically wherever it came from. Only the trigger differs.

## Install

```
/plugin marketplace add sarahcallmesmadds/plugins
/plugin install guardrails@smadds
```

Add the marketplace **by repository**, as above. If you add it by pasting a
direct URL to `marketplace.json`, only that one file downloads and the plugin
folders never arrive, so the install fails.

**Requires Node.js.** The hooks and the scanner are plain Node scripts with no
dependencies to install, but `node` has to be on your `PATH`. If it is not,
the hooks fail silently rather than breaking your session, which means you get
no protection and no error. Check with `node --version` before relying on it.

## Configuration

Everything works out of the box. To change something, create
`~/.claude/guardrails.config.json`. Your file is merged over the defaults one
key at a time, so setting one option does not reset the others.

```json
{
  "protectedBranches": ["main", "master", "release"],
  "requireConventionalCommits": true,
  "safeDeletePaths": ["/tmp/", "node_modules", "/dist/", "vendor/"]
}
```

| Key | Default | What it does |
|---|---|---|
| `protectedBranches` | `["main", "master"]` | Branches that reject a direct commit |
| `blockCommitToProtectedBranch` | `true` | Turn the branch guard off entirely |
| `requireConventionalCommits` | `false` | Require `feat:`, `fix:`, `docs:` and friends |
| `blockDestructiveCommands` | `true` | Turn the delete guard off entirely |
| `safeDeletePaths` | see `scripts/config.js` | Paths where force-delete needs no prompt |
| `scanForInjection` | `true` | Turn content scanning off entirely |
| `injectionExcludePaths` | `[]` | Extra regex patterns to skip when scanning |

If you find yourself approving the same deletion repeatedly, add that path to
`safeDeletePaths` rather than approving it each time. A guard you routinely
override is training you to ignore it.

## How severity works, and how noisy it is

The scanner groups patterns into eight categories: instruction override, role
reassignment, fake conversation boundaries, exfiltration, secret solicitation,
tool coercion, authority spoofing, and obfuscation. Severity is scored by how
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
