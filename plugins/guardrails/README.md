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
