# session release notes

## 0.10.0 — 2026-10-20

A thread's handoff stays the current state of its subject instead of growing.

- A thread's document has a second rule section, `## Standing rules`, grouped
  under `### <area>` headings, for rules that last as long as the subject.
  `## Constraints still in force` keeps this week's only. `constraints --thread`
  returns both, labelled, plus the project rules files the thread names on its
  `**Project rules:**` header line.
- `**Format:** 2` in a thread's header marks the new shape. `save` refuses to
  replace a format 2 document with a draft that lacks it (`format-downgrade`),
  so older skill text cannot drop the standing rules. A session still running
  the 0.9 scripts does not know the marker; moving threads to the new shape has
  to bump the thread list's generation so those sessions are refused by the
  generation check instead. Nothing in this release moves a thread.
- `cli.js handoff-check --file <draft>` measures a draft: words per section, a
  session log, an oversize summary or section, file rows from earlier sessions.
  `save` measures every draft the same way and reports it. With
  `handoffBudget.enforce` on it refuses an over-budget draft (`check-failed`)
  unless given `--accept-check "<reason>"`, which is written into the header.
  Off by default.
- `save` refuses odd shapes outright (`bad-shape`): a `## ` section that is not
  one of the template's nine (the reason names the one to fold it under), a
  title that is not the first line, a header label below the header (the
  `**Repository:**` and `**Repo:**` spellings included), a rule or area
  wholly in brackets (it reads as the template placeholder), a retirement line
  not in its exact `- Retired this session:` form at the start of a line, an
  HTML comment or HTML block tag such as `<pre>`, a heading underlined with
  `---` or `===`, a header label behind a bullet or quote mark, a subheading inside What was worked on, a `**Format:**` value
  that is not a whole number from 1 to 999, any code
  fence, an indented
  or malformed heading, a rule section name in any spelling but its own, any
  `## ` section twice, a heading deeper than `###` inside Standing rules, a
  rule continued onto a second line, a second `# ` title, a line break other
  than a plain newline (a bare carriage return or a Unicode separator), a header
  line not in its exact `**Label:** value` form, a project rules entry that is
  not an absolute or `~/` path. The parsers read plain text and exact header lines; `constraints --thread` reports a
  hand-edited file in one of these shapes as `shapeProblems`. Only word counts
  can refuse under enforcement; the log and old-row flags are advice.
- `/wrap` sorts every rule into this week, standing or done, proposes standing
  rules about one repository's code for that repository's instructions file as
  one batch per wrap, and measures the draft before saving. Its memory step
  edits in place and records a correction as a standing rule only when the user
  says it is one.
- `/pickup` prints this week's constraints, the standing rules and the project
  rules files, all in full.
- `capabilities` reports `threads: 2`, and both skills require it.

## 0.9.0 — 2026-09-25

One handoff per thread, for handoffs written from the home directory.

- A thread is one central handoff, declared in `~/.planning/handoffs/threads.json`,
  rewritten in place at every wrap through the new `cli.js save`, which refuses
  if another session saved it since this one read it. Its rules are the bullets in
  its own file and nothing else.
- `cli.js migrate plan | apply | finish` sets threads up once, with a reviewed
  list of every rule whose binding changes. Until it runs, behaviour is unchanged.
- `protectedHandoffs` in `~/.claude/session.config.json` names handoffs nothing may
  move or rewrite. An unreadable entry stops every handoff write instead of
  protecting nothing.
  Each entry must be absolute or start with `~/`; a relative one is refused.
  A listed file that is there and cannot be read also stops every write.
- Behaviour change: when another session holds the handoff index lock, commands
  now refuse after the five second wait instead of writing without it. `target`
  hands out no central path then (run the wrap again) and says a project's
  entry was not recorded; the sweep moves nothing.
- The archive sweep never moves declared threads or protected handoffs and never
  renames over a document already in the archive.
- `cli.js` rejects unknown flags and flags missing their value (an empty value
  counts as missing), and gains
  `capabilities`, which both skills check before running.
- The constraints scan applies its 500-handoff ceiling after filtering by scope.
- `target` recognises the home directory however it is spelled (a trailing
  slash, a symlinked home), so it no longer writes a `HANDOFF.md` into home.
- Threads are not supported where the home directory is itself a git checkout;
  `migrate plan` refuses there, and a thread list found in one is treated as
  invalid.
- While `threads.json` cannot be read, `constraints` refuses for any folder
  sharing the home directory's scope instead of listing a pool that may hold
  every thread's rules.
- A project whose folder name is a thread's is indexed under the first free
  `<name>-project` name, and `/wrap` ends with `/pickup` of that name. Only if
  every such name is taken does it end with `/pickup <path>`, which `/pickup`
  now accepts. `cli.js rekey <name>` moves a 0.8 entry off a thread's name.
- `find` exits non-zero for any handoff it finds and cannot read, and for a
  missing slug; `forget` exits non-zero when the index could not be written.
- `target` refuses a central path that is a symbolic link, and a project
  `HANDOFF.md` linked into the handoffs folder, because a wrap would write
  through it to another document.
- `constraints --file <path>` answers for a handoff named by its file, reading
  its Working directory the same way every other command does.

After updating, restart sessions in every host before running `migrate apply`.

## 0.8.23 — 2026-08-27

Hook failure notices keep plugin paths intact when those paths contain
backslashes, so the complete repair instruction stays on one line.

## 0.8.22 — 2026-08-27

No behavior changed. Test fixtures and explanatory comments now use synthetic
process data, reserved-domain endpoints, generic paths and non-production UUIDs.
