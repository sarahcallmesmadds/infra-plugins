# ip-inventory

Prove what you built, and when.

Most people who build things keep some record of what they have made. Almost
nobody checks it. The record is written once, at the moment the work is fresh
and the details are obvious, and then it sits there while repositories get
renamed, plugins get updated, paths move and projects get deleted. None of that
announces itself. So the record quietly stops being true, and you find out at
the worst possible moment, which is usually while you are signing something.

The inventory this was built for had rotted for three months without anyone
noticing. Thirteen of its fifteen repository links pointed at repositories that
no longer existed. Every recorded path pointed at a directory that was not on
the machine any more. Skills were listed under names they had been renamed away
from. None of it was carelessness; nothing had ever compared the record to
reality, because doing that by hand is tedious and doing it once tells you
nothing about next month.

This does the comparison, and it does it in one pass with no judgement calls.

## What it does

**`/ip-audit` checks every row against what actually exists.** Each repository
is resolved on GitHub, so a rename is caught from the payload rather than from
the status code, and a deletion is distinguished from a repository your token
simply cannot see. Each recorded path is checked on disk. Each version is
compared to the copy actually installed.

Findings arrive in three groups, and keeping them apart is the whole design:

| Group | What it means |
|---|---|
| Safe to fix automatically | One correct answer, no judgement. A rename, a visibility flip, a version bump. |
| Needs you | Not wrong, *unknown*. A repository that returns 404 does not say whether the work is retired, moved, or still running and billing. |
| Not checked | Checks that did not run, and why. |

That third group exists because a check that silently does not happen looks
exactly like one that passed, and "no drift" that quietly means "I could not
look" is worse than no report at all.

**`/ip-exhibit` turns the record into the document it is for.** An exhibit is
the schedule of prior intellectual property you attach to an employment
agreement, so that an invention-assignment clause cannot reach work you already
owned. It leads with a gap report naming every entry that cannot carry weight
yet, because an entry with no date and no statement of how it came to be yours
is not evidence, and putting it on the list anyway weakens the entries that are
sound.

The output is a draft for a lawyer. It says so at the top, and this README says
so here: **it is not legal advice.**

## One check worth calling out

Updating a plugin does not remove the version it replaced. The old directory
stays on disk, so every path into it keeps resolving, and an existence check
passes cheerfully on a path that has been dead for weeks. That is the single
most misleading state the filesystem can be in here, and it is checked for
specifically rather than left to `fs.existsSync`.

The report can tell you the newest copy on disk. It cannot tell you which one is
*running*, because that is whatever loaded when the session started. It says the
newest, and it says that is what it means.

## Claude Code and Codex

Both runtimes get the same two skills and the same results. There are no hooks
here yet, so unusually for this marketplace there is nothing Codex misses.

## Install

```
/plugin marketplace add sarahcallmesmadds/plugins
/plugin install ip-inventory@smadds
```

Add the marketplace **by repository**, as above. Adding it by pasting a direct
URL to `marketplace.json` downloads only that one file, so the plugin folders
never arrive and installs fail.

**Requires Node.js.** The skills shell out to `scripts/cli.js`.

## Configuration

Unlike the rest of this marketplace, this one does not work out of the box,
because the database it should read is the one thing it cannot guess. Create
`~/.claude/ip-inventory.config.json`:

```json
{
  "notion": {
    "dataSourceId": "your-notion-data-source-id"
  },
  "github": {
    "owner": "your-github-username"
  }
}
```

| Key | Default | What it does |
|---|---|---|
| `notion.dataSourceId` | none, required | Which database to read |
| `notion.apiVersion` | `2025-09-03` | Moves together with `endpointStyle`; the two cannot be mixed |
| `notion.endpointStyle` | `data_sources` | `data_sources` for 2025-09-03, `databases` for 2022-06-28 |
| `notion.tokenEnv` | `NOTION_PERSONAL_API_KEY` | Environment variable holding the integration token |
| `notion.tokenFile` | none | A `.env`-style file to read the token from instead |
| `github.tokenEnv` | `GITHUB_TOKEN` | Falls back to `gh auth token` |
| `properties` | see `scripts/config.js` | Maps each field this plugin reads to a Notion column name |
| `localKinds` | see `scripts/config.js` | Which kinds are expected to have a path on this machine |
| `excludeKindsFromExhibit` | `["MCP Server"]` | Kinds that are somebody else's software |

**The property map is the important one.** Notion column names are display
strings anyone can rename in two clicks. Every column is read through this map,
so a rename breaks one line of config instead of silently making a field read
blank on all rows, which is indistinguishable from a field nobody filled in.

If you plan to run this from `launchd` or `cron`, set `notion.tokenFile`. A
scheduled job does not source a shell profile, so it never sees an exported
variable, and a runner that finds no token does no work and exits successfully.

## What this does not do

It does not write to your inventory. Not a status, not a date, not a note. Every
fix is yours to make, and there is no update function in `scripts/notion.js` for
you to take that on trust.

It does not decide what is defensible. An entry with a date and a stated basis
is listable, which is not the same as correct.

It does not watch anything. It runs when you run it. If nobody runs it, it will
tell you nothing at all, which is exactly the failure it was built after.

## Licence

MIT. See `LICENSE` at the repository root.
