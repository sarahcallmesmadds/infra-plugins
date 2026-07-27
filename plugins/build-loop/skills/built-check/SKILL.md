---
name: built-check
type: human
description: Cross-checks the to-build list at ~/.claude/build-loop/to-build/ against what has actually been built, and offers to close the finished items in one step. Looks for evidence in the git log of every configured root, on disk, and in the current session. Use at the end of a session, when wrapping up, or when the user asks "what did I ship", "did I build any of this", "close the ones I've done", "is anything on the list done", or explicitly invokes /built-check. Shows the evidence for each item and closes nothing without an explicit yes.
argument-hint: "[optional: number of days back to look, default 90]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mv:*), Bash(rm:*), Bash(node:*), Bash(git:*), Bash(find:*), Bash(stat:*)
---

You are reconciling the to-build list against reality. The schema is at `${CLAUDE_PLUGIN_ROOT}/reference/SCHEMA-BUILD.md`. Read it if you have not already in this session.

The problem this solves: things get built and the list never gets updated, so the list slowly stops being true and then stops being read. This closes that gap by going and looking.

Two rules that do not bend:

1. **Evidence before verdict.** Never mark something built because it sounds like it was probably built. Name the file, the commit, or the directory you found.
2. **Nothing closes without an explicit yes.** The user can close several items in one answer, which is the point, but the yes is still theirs.

> **Paths in this file are written with `~` for readability.** The Write tool and
> Node's `fs` both take it literally, so expand it to the absolute home path
> before using it. A literal `~` creates a directory called `~` next to wherever
> you happen to be, and every check that follows then reads the wrong place.

---

## Step 1 — Load the open items

```bash
ls ~/.claude/build-loop/to-build/*.json 2>/dev/null
```

If nothing comes back:

> "The to-build list is empty, so there is nothing to reconcile. Run `/to-build <something>` to add an item."

Stop.

Read each file. Keep only items with status `Open` or `In Progress`. Skip `Built` and `Dropped` silently, they are already settled.

If every item is already settled:

> "Nothing open on the to-build list. {N} built, {M} dropped."

Stop.

Skip any file that fails to parse, and count them. Report the count at the end rather than stopping.

---

## Step 2 — Work out the window

`$ARGUMENTS` may hold a number of days. Default to 90 if it is empty or not a number.

Compute the cutoff date. Never look further back than the oldest open item's `created_at`, since evidence older than the item cannot be evidence for it:

```bash
date -u -v-{days}d +"%Y-%m-%d" 2>/dev/null || date -u -d "{days} days ago" +"%Y-%m-%d"
```

The two `date` implementations disagree. BSD and macOS take `-v`, GNU and Linux take `-d`. Running the wrong one alone fails silently enough to produce an empty window, which then looks like "nothing was built."

---

## Step 3 — Gather evidence

Collect from three places. Gather all three before judging anything, because the strongest evidence for a given item is often not in the first place you look.

### 3a — The git log of every configured root

Read the roots from `~/.claude/build-loop.config.json`. With no config file, use the three defaults from SCHEMA.md: `personal` at `~/.claude/skills` (kind `skill`), `hooks` at `~/.claude/hooks` (kind `hook`), and `commands` at `~/.claude/commands` (kind `command`). If the config has `skillRoots` and no `roots`, read those as roots of kind `skill`.

If none of the roots exist on disk, say so once and carry on using session evidence alone. Do not report "no sign of it" for everything as though you had looked, when there was nowhere to look:

> "None of the configured roots exist on this machine, so I only have this session to go on."

For each root that is a git repository:

```bash
git -C <root.path> log --since="{cutoff}" --pretty=format:"%h %ad %s" --date=short --name-status
```

If a root is not a git repository, skip it silently. That is normal, not an error.

### 3b — What is on disk now

For each open item, check whether something with its name exists in a plausible place. Use the item's `kind` to decide where to look, following the same conventions the bug queue uses:

- `skill`: `<root>/<slug>/SKILL.md` and `<root>/<slug>/skill/SKILL.md`, in roots of kind `skill`
- `hook`: `<root>/<slug>` and `<root>/<slug>.*`, in roots of kind `hook`
- `command`: `<root>/<slug>.md`, in roots of kind `command`
- `plugin`: `<root>/plugins/<slug>/` containing a `.claude-plugin` directory
- `script`, `other`: no convention, so disk evidence is not available. Rely on 3a and 3c.

Also search every root of kind `plugin-repo`, whatever the item's `kind`, since that layout nests one level deeper:

```bash
ls  <root.path>/plugins/*/skills/<slug>/SKILL.md 2>/dev/null
ls  <root.path>/plugins/*/hooks/<slug>*          2>/dev/null
ls  <root.path>/plugins/*/commands/<slug>.md     2>/dev/null
ls -d <root.path>/plugins/<slug>                 2>/dev/null
```

A plugin counts as built only when its directory holds a `.claude-plugin/plugin.json`. An empty directory with the right name is a `started`, not a `looks built`.

Derive `<slug>` from the item's `title` the same way the id was built, and also try the most distinctive word in the title. A title of "git-hygiene plugin" should find a directory called `git-hygiene`.

Record the modification time of anything found:

```bash
stat -f %m <path> 2>/dev/null || stat -c %Y <path>
```

A file that exists but predates the item's `created_at` is NOT evidence that the item was built. It usually means the name was taken already, which is worth mentioning to the user but is not a reason to close anything.

### 3c — This session

Look back over the current session. If something on the list was built in this conversation, that is the strongest evidence available and it will not be in the git log yet if nothing has been committed. Note it as session evidence and say plainly that it is uncommitted.

---

## Step 4 — Judge each open item

For each item, land on exactly one of three verdicts. When the evidence is mixed, take the lower verdict. A wrong "looks built" quietly deletes work from the list, and a wrong "no sign of it" costs one line of the user's attention.

| Verdict | When |
|---|---|
| **looks built** | Something matching the item exists on disk and was created or last changed after the item was added, OR a commit after the item was added clearly does the thing the item describes, OR it was built in this session. |
| **started** | Partial evidence. A directory exists but is empty or has no manifest, or a commit mentions it as work in progress. |
| **no sign of it** | Nothing found. |

Write one line of evidence for every verdict that is not "no sign of it". Name the actual path or commit. "Looks done" is not evidence, `plugins/git-hygiene/plugin.json, added in a1b2c3d on 2026-08-01` is.

---

## Step 5 — Show the findings and ask

If every item comes back "no sign of it":

> "Checked {N} open items against the last {days} days. No sign that any of them have been built yet. Nothing to close."

Stop. Do not ask a question that has only one answer.

Otherwise show this:

```
Checked {N} open items against the last {days} days.

Looks built:
  1. {title} — {evidence}
  2. {title} — {evidence}

Started, not finished:
  3. {title} — {evidence}

No sign of it yet:
  - {title}
  - {title}

Close the built ones? (all / a list of numbers like "1,3" / none)
```

Omit any of the three groups that is empty. Do not print an empty heading.

On their response:

- `all`: close every item under "Looks built". Items under "Started" are NOT included in `all`, because `all` should never mean more than what you offered.
- a list of numbers: close exactly those, whichever group they came from. If a number belongs to a "Started" item, that is a deliberate choice by the user and it is fine.
- `none`, `no`, or any negative: say "Nothing closed." and go to Step 7.
- Anything ambiguous: ask once more rather than guessing. Closing the wrong item silently loses the record of work that is still outstanding.

For any "Started" item the user did NOT close, offer once:

> "Want me to mark {title} as In Progress so it is obvious next time?"

Only change status on a yes.

---

## Step 6 — Write the closures

For each item being closed, this REPLACES an existing file, so the atomic sequence is mandatory. Per item:

1. Take the item you already read. Set `status` to `"Built"`. Set `built` to:

```json
{
  "ts": "{ISO-8601 now}",
  "evidence": "{the evidence line you showed the user, verbatim}",
  "commit": "{commit hash if the evidence came from a git log, else empty string}",
  "confirmed_by": "user"
}
```

   Change nothing else. `created_at`, `title`, `what`, `why` and `notes` all stay as they are.

2. Write the updated JSON to `~/.claude/build-loop/to-build/{id}.json.tmp` with the Write tool.

3. Parse-check it:

```bash
node -e "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.claude/build-loop/to-build/{id}.json.tmp','utf8'))" && echo PARSE_OK
```

4. If it parses, swap it in:

```bash
mv ~/.claude/build-loop/to-build/{id}.json.tmp ~/.claude/build-loop/to-build/{id}.json
```

5. If it does not parse, delete the tempfile with `rm`, report the failure for that item, and carry on with the remaining items. One bad write must not abandon the rest.

Marking something `In Progress` from Step 5 uses the same sequence, setting only `status`.

---

## Step 7 — Report

```
Closed {K} items: {titles}.
{M} still open. {J} started but not finished.
```

Add these lines only when they apply:

- `{P} files failed to parse and were skipped: {filenames}`
- `Note: {title} was closed on session evidence and is not committed yet.`
- `Note: something called {slug} already existed before {title} was added. Worth a look, the name may be taken.`

End with:

"Run `/to-build` to see the full list."

---

## Called from a wrap-up

This skill is meant to be run at the end of a session as well as on its own, and the flow is the same either way. When it is called as part of wrapping up, two things change:

- Session evidence from Step 3c matters more, because the work just happened and is probably uncommitted.
- Keep Step 5 to the findings and the one question. A wrap-up is not the moment for a long report, and the user can run `/to-build` if they want the whole list.

---

## Failure handling

- Never throw. If the git log fails in one root, note it and use the other roots.
- If `~/.claude/build-loop/to-build/` does not exist, treat it as an empty list, not an error.
- If an item has no `kind`, treat it as `skill` for the disk check in Step 3b.
- If an item has no `created_at`, skip the "newer than the item" test for it and say so in the evidence line, because without that date you cannot tell new work from old.
- Never close an item on the strength of its title appearing in a commit message alone. A commit that says "still need to do git-hygiene" mentions the title and is evidence of the opposite.
