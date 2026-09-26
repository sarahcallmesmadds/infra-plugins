# session release notes

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
  says the entry was not recorded; the sweep moves nothing.
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
