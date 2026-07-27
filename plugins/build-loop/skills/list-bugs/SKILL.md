---
name: list-bugs
type: human
description: Shows the build loop bug queue as a plain-language table. Use when the user asks "what's in the queue", "what bugs are open", "show me the queue", "what did I capture", or explicitly invokes /list-bugs. Supports optional status filter argument (open, all, resolved, wontfix). Default filter is Open + In Progress items only, sorted oldest first.
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
2. If the `ls` returns nothing (no output, no files, or directory does not exist): print "Queue is empty — nothing to show." and stop. Do NOT error.
3. For each `.json` file listed, read it with the Read tool.
4. For each file, attempt to parse its contents as JSON:
   - If parsing succeeds: extract `target`, `target_kind`, `what_happened`, `status`, `created_at`, `what_expected`, `target_path`, `dedup_key`, `type` fields. Apply the read-time defaults from SCHEMA.md so an older entry never crashes this view: a missing `type` reads as `"primary"`, a missing `target` reads from `skill`, a missing `target_path` reads from `skill_path`, and a missing `target_kind` reads as `"skill"`.
   - If parsing fails for any reason: create a synthetic entry with `target: "(malformed)"`, `target_kind: "(error)"`, `what_happened: "file {filename} could not be parsed"`, `status: "(error)"`, `created_at: "?"`, `type: "(error)"`. Do not hide broken entries — the user needs to see them so they can fix them.
5. If a file read fails (permission denied, etc.): treat as a parse failure — list it as `(error)` with the filename and continue. Never stop processing remaining files.
6. Apply the filter from Step 1. Drop entries whose status does not match.

### Step 3 — Sort

Sort the surviving entries in this order:
1. **Primary (status order):** `Open` → `In Progress` → `Resolved` → `Won't Fix` → `(error)` last.
2. **Secondary within each status group:** `created_at` ascending (oldest first — older = more urgent).

For `(error)` entries, sort by filename ascending as a fallback.

### Step 4 — Render the table

Count `N` = number of entries after filtering and sorting.

If `N == 0`: print "No {filter_label} items in the queue." and skip to Step 5.

If `N > 0`: produce a Markdown table with this exact header:

```
## Build loop queue — {filter_label} ({N} items)

| Target | Kind | What happened | Type | Status | Date |
|--------|------|---------------|------|--------|------|
```

Then add one row per entry (up to 20 rows):
- **Target column:** `target` field value, falling back to the `skill` field for entries written before schema v5
- **Kind column:** `target_kind` field value, or `skill` when the field is absent
- **What happened column:** truncate `what_happened` to 60 characters; append `...` if truncated. Escape any literal `|` character as `\|` so the Markdown table doesn't break.
- **Type column:** the value from the entry, defaulting to `"primary"` if missing (per Step 2 point 4). Show `"primary"` or `"dep-review"` or `"(error)"`. This column is display-only — it does NOT affect filtering or sort.
- **Status column:** `status` field value
- **Date column:** first 10 characters of `created_at` (format: `YYYY-MM-DD`). If `created_at` is `"?"`, show `?`.

If `N > 20`: after the 20th row, print a summary line:
`... and {N - 20} more. Run /list-bugs all to see every item, or open ~/.claude/build-loop/queue/ directly.`

### Step 5 — Highlight the top urgent item

After the table (or after the "no items" message), check if any `Open` status entries exist in the full filtered set.

If at least one `Open` entry exists: find the oldest one (lowest `created_at`) and print a spotlight block:

```
**Most urgent open item:**
- Target: {target} {if type == "dep-review" append "  (dep-review — triggered by parent " + parent_id + ")"}
- What happened: {full what_happened, not truncated}
- What expected: {full what_expected}
- Logged: {created_at as YYYY-MM-DD} ({days-ago} days ago, where days-ago = today's date minus created_at date)
- File: `~/.claude/build-loop/queue/{filename}`
```

If there are zero `Open` entries (after filtering), skip this block entirely.

### Step 6 — Footer

Always end with this exact line, regardless of what was shown above:

"Run `/flag-issue` to log a new correction. Run `/list-bugs all` to see every status. Dep-review entries are reviews triggered automatically — see SCHEMA.md Type enum for details."

### Failure handling

- Never throw. Never exit without producing some output.
- If ALL files fail to read or parse, still print the "Queue is empty — nothing to show." message rather than an error.
- If `what_happened` or `what_expected` fields are missing from an entry, substitute `"(missing)"` rather than crashing.
- If `created_at` is missing or unparseable, treat as `"?"` for display and sort these entries last within their status group.
- If the `type` field is missing from an entry (Phase 1 v1 entries), render it as `"primary"`. Never display an empty column.
