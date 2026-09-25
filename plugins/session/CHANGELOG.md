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
- Behaviour change: when another session holds the handoff index lock, commands
  now refuse after the five second wait instead of writing without it. `target`
  says the entry was not recorded; the sweep moves nothing.
- The archive sweep never moves declared threads or protected handoffs and never
  renames over a document already in the archive.
- `cli.js` rejects unknown flags and flags missing their value, and gains
  `capabilities`, which both skills check before running.
- The constraints scan applies its 500-handoff ceiling after filtering by scope.

After updating, restart sessions in every host before running `migrate apply`.

## 0.8.23 — 2026-08-27

Hook failure notices keep plugin paths intact when those paths contain
backslashes, so the complete repair instruction stays on one line.

## 0.8.22 — 2026-08-27

No behavior changed. Test fixtures and explanatory comments now use synthetic
process data, reserved-domain endpoints, generic paths and non-production UUIDs.
