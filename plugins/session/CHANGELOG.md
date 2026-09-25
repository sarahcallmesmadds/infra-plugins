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
- A project whose folder name is a declared thread's gets its `HANDOFF.md` but
  no index entry, and `/wrap` ends with `/pickup <path>`, which `/pickup` now
  accepts. While `threads.json` cannot be read, every project is picked up by
  its path, because no name is known to be free of a thread.
- `find` exits non-zero for any handoff it finds and cannot read, and for a
  missing slug; `forget` exits non-zero when the index could not be written.
- `target` refuses a central path that is a symbolic link, because a wrap
  would write through it to another document.
- `constraints --file <path>` answers for a handoff named by its file, reading
  its Working directory the same way every other command does.
- Once threads are set up, a project whose name is taken by a central handoff
  has its own `HANDOFF.md` read into its constraints pool, because `target`
  leaves it out of the index on purpose. Every other pool is unchanged.

After updating, restart sessions in every host before running `migrate apply`.

## 0.8.23 — 2026-08-27

Hook failure notices keep plugin paths intact when those paths contain
backslashes, so the complete repair instruction stays on one line.

## 0.8.22 — 2026-08-27

No behavior changed. Test fixtures and explanatory comments now use synthetic
process data, reserved-domain endpoints, generic paths and non-production UUIDs.
