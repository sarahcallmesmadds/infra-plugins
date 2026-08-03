---
name: list-bugs
type: human
description: Shows the build loop bug queue as a plain-language table. Use when the user asks "what's in the queue", "what bugs are open", "show me the queue", "what did I capture", or explicitly invokes /list-bugs. Supports optional status filter argument (open, all, resolved, wontfix). Default filter is Open + In Progress items only, leading with the items that can actually be started and oldest first within that.
argument-hint: "[optional filter: open | all | resolved | wontfix]"
allowed-tools: Read, Bash(ls:*), Bash(cat:*)
---

You are displaying the build loop bug queue at `~/.claude/build-loop/queue/`. This is a strictly read-only view — do not write, edit, or delete any queue entries from this skill.

### Step 1 — Parse the filter argument

Check `$ARGUMENTS`. It may be empty or contain one of these values (case-insensitive):
- Empty → filter = `open-and-in-progress` (status `Open` OR `In Progress`). This is the
  default because the everyday question is "what is outstanding", and something already
  being worked on is still outstanding.
- `open` → only `Open`. Asking for open explicitly means open, not open-ish. Use it to see
  what has not been started.
- `all` → no filter, show every status
- `in progress` → only `In Progress`
- `resolved` → only `Resolved`
- `wontfix` or `won't fix` (treat as equivalent) → only `Won't Fix`

Determine the human-readable `filter_label`:
- `open-and-in-progress` → "Open + In Progress"
- `all` → "All"
- `open` → "Open only"
- `in progress` → "In Progress only"
- `resolved` → "Resolved only"
- `wontfix` → "Won't Fix only"

### Step 2 — Read all queue files

1. Check whether any JSON files exist in the queue directory:
   ```bash
   ls ~/.claude/build-loop/queue/*.json 2>/dev/null
   ```
2. If the `ls` returns nothing (no output, no files, or directory does not exist): print "Queue is empty, nothing to show." and stop. Do NOT error.
3. For each `.json` file listed, read it with the Read tool.
4. For each file, attempt to parse its contents as JSON:
   - If parsing succeeds: extract `id`, `parent_id`, `target`, `target_kind`, `what_happened`, `status`, `created_at`, `what_expected`, `target_path`, `dedup_key`, `type` fields. `id` and `parent_id` are what Step 5 and the index in point 6 match on, so a run that skips them has nothing to match and will render empty or invented parent details. Apply the read-time defaults from SCHEMA.md so an older entry never crashes this view: a missing `type` reads as `"primary"`, a missing `target` reads from `skill`, a missing `target_path` reads from `skill_path`, and a missing `target_kind` reads as `"skill"`.
   - If parsing fails for any reason: create a synthetic entry with `id: null`, `parent_id: null`, `target: "(malformed)"`, `target_kind: "(error)"`, `what_happened: "file {filename} could not be parsed"`, `status: "(error)"`, `created_at: "?"`, `type: "(error)"`. Do not hide broken entries — the user needs to see them so they can fix them.
5. If a file read fails (permission denied, etc.): treat as a parse failure — list it as `(error)` with the filename and continue. Never stop processing remaining files.
6. Build a parent index from **every** entry read, before any filtering happens: a map from each entry's `id` to both its `status` and its `target`. Carry the `target` as well as the status, because Step 5 names the parent and a parent dropped by the filter is not available to look up later. Build the index first, for the same reason: a dep-review's parent is usually Resolved by the time the review can be done, and a Resolved parent is dropped by the default filter while its status and name are both still needed here.
7. Resolve each `dep-review` entry against that index and classify it:
   - Look up `parent_id` in that index and record what it points at as `parent_status` and `parent_target`. A missing `parent_id`, or one naming an entry that is not on disk, reads as `parent_status = "(unknown)"` and `parent_target = "(unknown)"`.
   - **waiting** when `parent_status` is `Open` or `In Progress`. The parent bug is still unfixed, so no change exists yet whose impact could be reviewed.
   - **answerable** for every other `parent_status`, `(unknown)` included. A finished parent means the fix landed and the review can be done now. An unknown parent is surfaced rather than hidden, because a dep-review pointing at nothing is itself worth seeing.
   - A `primary` entry is never waiting, and neither is an `(error)` entry.
8. Apply the filter from Step 1. Drop entries whose status does not match.

### Step 3 — Sort

Sort the surviving entries in this order:
1. **Status order:** `Open` → `In Progress` → `Resolved` → `Won't Fix` → `(error)` last. Status stays the top key so open work always leads, whatever the filter. Sorting by band first would put a Resolved primary above an Open dep-review under `/list-bugs all`, which is the opposite of the point.
2. **Actionability band within a status group:** `primary` first, then answerable `dep-review`, then waiting `dep-review`. This is what makes the open group lead with work that can actually be started. A waiting dep-review is a real item, but it is blocked on something else in the queue, so it sits below everything that is not.
3. **`created_at` ascending within each band**, oldest first, since older means more urgent.

For `(error)` entries, sort by filename ascending as a fallback.

### Step 4 — Render the table

Count `N` = number of entries after filtering and sorting. Then count the bands within it:
`P` = primaries, `A` = answerable dep-reviews, `W` = waiting dep-reviews.

Build `{breakdown}`, which stops a queue full of blocked reviews from reading as a queue
full of bugs:
- If `A` and `W` are both zero, `{breakdown}` is the empty string, and the header reads exactly as it always did.
- Otherwise `{breakdown}` is `, ` followed by the non-zero counts among `{P} primary`, `{A} dep-review ready`, and `{W} dep-review waiting`, joined with `, `. Omit any segment whose count is zero.

If `N == 0`: print "No {filter_label} items in the queue." and skip to Step 5.

If `N > 0`: produce a Markdown table with this exact header:

```
## Build loop queue: {filter_label} ({N} items{breakdown})

| Target | Kind | What happened | Type | Status | Date |
|--------|------|---------------|------|--------|------|
```

Then add one row per entry (up to 20 rows):
- **Target column:** `target` field value, falling back to the `skill` field for entries written before schema v5
- **Kind column:** `target_kind` field value, or `skill` when the field is absent
- **What happened column:** truncate `what_happened` to 60 characters; append `...` if truncated. Escape any literal `|` character as `\|` so the Markdown table doesn't break.
- **Type column:** the value from the entry, defaulting to `"primary"` if missing (per Step 2 point 4). Show `"primary"`, `"dep-review"`, `"dep-review (waiting)"`, or `"(error)"`. Marking the waiting ones is what lets the header count be reconciled row by row. This column does not affect filtering, but it does affect sort, through the band in Step 3.
- **Status column:** `status` field value
- **Date column:** first 10 characters of `created_at` (format: `YYYY-MM-DD`). If `created_at` is `"?"`, show `?`.

If `N > 20`: after the 20th row, print a summary line:
`... and {N - 20} more. Run /list-bugs all to see every item, or open ~/.claude/build-loop/queue/ directly.`

### Step 5 — Highlight the top urgent item

After the table (or after the "no items" message), pick what gets the spotlight, in this
order. A waiting dep-review never takes it while any other open entry exists, because it
names work that cannot be started yet.

1. The oldest `Open` **primary**, by lowest `created_at`.
2. If there is no open primary, the oldest `Open` **answerable dep-review**.
3. If the only open entries are waiting dep-reviews, print the blocked block below instead of a spotlight. Count `W_open` = waiting dep-reviews whose status is `Open`. Use that, not the `W` from Step 4, which counts every status the filter let through and would name more items than the block goes on to list.
4. If there are zero `Open` entries at all, skip this step entirely.

For cases 1 and 2, print a spotlight block:

```
**Most urgent open item:**
- Target: {target} {if type == "dep-review" append "  (dep-review, triggered by parent " + parent_id + ")"}
- What happened: {full what_happened, not truncated}
- What expected: {full what_expected}
- Logged: {created_at as YYYY-MM-DD} ({days-ago} days ago, where days-ago = today's date minus created_at date)
- File: `~/.claude/build-loop/queue/{filename}`
```

If there are zero `Open` entries (after filtering), skip this block entirely.

For case 3, where every open entry is a dep-review waiting on an unfixed parent, print this
instead. It says what to do next rather than presenting a blocked item as the urgent one:

```
**Nothing open can be started yet.** All {W_open} open items are dep-reviews waiting on a parent fix that has not landed:

- {target}, waiting on {parent_target} (`{parent_id}`, status {parent_status})

Fix a parent first. `/apply-fix` offers up its dep-reviews once the fix commits, so these are not lost by sitting here.
```

### Step 6 — Footer

Always end with this exact line, regardless of what was shown above:

"Run `/flag-issue` to log a new correction. Run `/list-bugs all` to see every status. Dep-review entries are reviews triggered automatically, and one marked waiting is blocked until its parent bug is fixed. See SCHEMA.md Type enum for details."

### Failure handling

- Never throw. Never exit without producing some output.
- If ALL files fail to read or parse, still print the "Queue is empty, nothing to show." message rather than an error.
- If `what_happened` or `what_expected` fields are missing from an entry, substitute `"(missing)"` rather than crashing.
- If `created_at` is missing or unparseable, treat as `"?"` for display and sort these entries last within their status group.
- If the `type` field is missing from an entry (Phase 1 v1 entries), render it as `"primary"`. Never display an empty column.
- If a dep-review's `parent_id` is missing, or names an entry that is not on disk, treat it as answerable with `parent_status` and `parent_target` both `"(unknown)"`. Never drop it and never crash. A dep-review whose parent has vanished is a real problem, and hiding it is how it stays one.
