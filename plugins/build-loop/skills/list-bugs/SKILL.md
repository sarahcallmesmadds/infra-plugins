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
6. Build a parent index from **every** entry read, before any filtering happens: a map from each entry's `id` to both its `status` and its `target`. **Skip any entry whose `id` is null or absent.** A malformed file has no usable id, and indexing several of them would collide them all onto one key and let a dep-review that records no parent resolve against a broken file. Carry the `target` as well as the status, because Step 5 names the parent and a parent dropped by the filter is not available to look up later. Build the index first, for the same reason: a dep-review's parent is usually Resolved by the time the review can be done, and a Resolved parent is dropped by the default filter while its status and name are both still needed here.
7. Resolve each `dep-review` entry against that index and classify it:
   - If `parent_id` is null or absent, **stop there**: `parent_status` and `parent_target` are both `"(unknown)"`, with no index lookup. `null` is the schema's value for "no parent", so looking it up is how a dep-review ends up blamed on an unrelated entry.
   - Otherwise look `parent_id` up in the index and record what it points at as `parent_status` and `parent_target`. An id naming an entry that is not on disk also reads as `"(unknown)"` for both.
   - **waiting** when `parent_status` is `Open`, `In Progress`, `Won't Fix`, or the retired `fix attempted / unresolved`. What these share is that no change was ever made, so there is nothing whose impact could be reviewed. `Won't Fix` means the correction was declined and `fix attempted / unresolved` means the write failed or the diff was rejected, so neither is a finished fix despite reading like a closed entry.
   - **answerable** when `parent_status` is `Resolved`, `fix applied, watching`, or `(unknown)`. The first two are the only statuses that mean a fix actually landed. An unknown parent is surfaced rather than hidden, because a dep-review pointing at nothing is itself worth seeing.
   - Record `waiting_reason` on each waiting entry, since the two cases need different advice: `"no fix yet"` for `Open` and `In Progress`, and `"parent closed without a change"` for `Won't Fix` and `fix attempted / unresolved`. A parent in the second group will never produce a fix, so its dep-review wants closing rather than waiting on.
   - A `primary` entry is never waiting, and neither is an `(error)` entry.
8. Apply the filter from Step 1. Drop entries whose status does not match.

### Step 3 — Sort

Sort the surviving entries in this order:
1. **Status order:** `Open` → `In Progress` → `Resolved` → `Won't Fix` → `(error)` last. Status stays the top key so open work always leads, whatever the filter. Sorting by band first would put a Resolved primary above an Open dep-review under `/list-bugs all`, which is the opposite of the point.
2. **Actionability band within a status group:** `primary` first, then answerable `dep-review`, then waiting `dep-review`. This is what makes the open group lead with work that can actually be started. A waiting dep-review is a real item, but it is blocked on something else in the queue, so it sits below everything that is not.
3. **`created_at` ascending within each band**, oldest first, since older means more urgent.

An `(error)` entry sits in no band. Its status is `(error)`, which key 1 already sorts last, so
key 2 never applies to it. Sort those by filename ascending, since a file that would not parse
has no `created_at` to sort on.

### Step 4 — Render the table

Count `N` = number of entries after filtering and sorting. Then count the bands within it:
`P` = primaries, `A` = answerable dep-reviews, `W` = waiting dep-reviews, `E` = unreadable
`(error)` entries. Every row falls in exactly one of the four, so `P + A + W + E` must equal
`N`. If it does not, a band was missed and the header will not reconcile against the table.

Build `{breakdown}`, which stops a queue full of blocked reviews from reading as a queue
full of bugs:
- If `A`, `W` and `E` are all zero, `{breakdown}` is the empty string, and the header reads exactly as it always did.
- Otherwise `{breakdown}` is `, ` followed by the non-zero counts among `{P} primary`, `{A} dep-review ready`, `{W} dep-review waiting`, and `{E} unreadable`, joined with `, `. Omit any segment whose count is zero.

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
- **Type column:** the value from the entry, defaulting to `"primary"` if missing (per Step 2 point 4). Show `"primary"`, `"dep-review"`, `"dep-review (waiting)"`, or `"(error)"`. Marking the waiting ones is what lets the header count be reconciled row by row, and that reconciliation only holds because the breakdown counts `(error)` rows too. This column does not affect filtering, but it does affect sort, through the band in Step 3.
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
instead of a spotlight. It says what to do next rather than presenting a blocked item as the
urgent one. Open with this line:

```
**Nothing open can be started yet.** All {W_open} open items are dep-reviews with no change to review, because none of their parents produced a fix:
```

Then add **one bullet per waiting entry**, all `W_open` of them, so the list below the count
is as long as the count claims. One bullet against a stated count of nine is the failure this
spells out to avoid:

```
- {target}, from {parent_target} (`{parent_id}`, status {parent_status}, {waiting_reason})
```

Then close with the line matching what is actually in the list. Both, if it holds a mix:

```
For a parent still open, fix that first, and /apply-fix offers up its dep-reviews once the fix commits.
For a parent closed without a change, no fix is coming, so close the dep-review instead. /apply-fix only surfaces dep-reviews when a parent fix commits, so nothing else will clear it.
```

### Step 6 — Footer

Always end with this exact line, regardless of what was shown above:

"Run `/flag-issue` to log a new correction. Run `/list-bugs all` to see every status. Dep-review entries are reviews triggered automatically, and one marked waiting has no change to review because its parent never produced a fix. See SCHEMA.md Type enum for details."

### Failure handling

- Never throw. Never exit without producing some output.
- If ALL files fail to read or parse, still print the "Queue is empty, nothing to show." message rather than an error.
- If `what_happened` or `what_expected` fields are missing from an entry, substitute `"(missing)"` rather than crashing.
- If `created_at` is missing or unparseable, treat as `"?"` for display and sort these entries last within their status group.
- If the `type` field is missing from an entry (Phase 1 v1 entries), render it as `"primary"`. Never display an empty column.
- If a dep-review's `parent_id` is missing, or names an entry that is not on disk, treat it as answerable with `parent_status` and `parent_target` both `"(unknown)"`. Never drop it and never crash. A dep-review whose parent has vanished is a real problem, and hiding it is how it stays one.
