# Building plugins and skills

This is the release checklist for the `smadds` marketplace. Use it for a new
plugin, a new skill inside an existing plugin, and any change to files that ship
inside a plugin.

## Before building

- Name the user problem and the observable result. A plugin should earn its
  installation; a skill should earn a place in the user's tool list.
- Search the marketplace for an existing plugin or skill that already owns the
  job. Extend the existing owner when the new behavior has the same purpose.
- Decide which runtimes the feature supports, and establish it rather than
  inferring it from a manifest. This list said Claude Code can register hooks
  and Codex cannot, which was wrong from the day it was written: the Codex
  manifest has no hooks field, but Codex reads each installed plugin's
  `hooks/hooks.json` and runs the commands, measured by probe on 2026-08-16.
  What a manifest can declare and what a host reads are two questions. Document
  a real fallback when only one runtime can automate the behavior, and confirm
  that it is only one.
- Identify user-specific state. Shipped files are immutable product code;
  machine-specific choices belong in `~/.claude/<plugin>.config.json` or an
  equivalent documented user-owned location.

## Plugin structure

Every marketplace plugin ships this minimum shape:

```text
plugins/<plugin>/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── README.md
└── skills/<skill>/SKILL.md
```

Hooks, commands, scripts, references, and assets are optional. Add them only
when the behavior needs them.

- Keep the directory name, both manifest names, and the marketplace name
  identical.
- Register the plugin in `.claude-plugin/marketplace.json`.
- Add the plugin to the table in the root `README.md` so people can discover it
  before installation.
- Keep the marketplace, Claude manifest, and Codex manifest versions equal.
- Bump the plugin version whenever any file under `plugins/<plugin>/` changes,
  including its README.
- Explain purpose, installation, invocation, configuration, runtime limits,
  and important side effects in the plugin README.

## Skill structure

Each skill lives at `plugins/<plugin>/skills/<skill>/SKILL.md`.

- Give the frontmatter a kebab-case `name` matching its directory and a
  concrete `description` that says when the skill should be invoked.
- Put trigger and routing information in the description; put the working
  procedure in the body.
- Keep the main path short enough to follow. Move detailed schemas, examples,
  and background into adjacent reference files when they are needed.
- Use scripts for deterministic or repeatedly retyped operations. Validate
  inputs at the script boundary and make failures visible.
- State approval gates at the point where a write or destructive action would
  happen.
- Do not add per-skill interface metadata that duplicates the plugin manifest.
  Codex-facing display metadata belongs in `.codex-plugin/plugin.json` unless
  the runtime contract changes.

### Where `${CLAUDE_PLUGIN_ROOT}` expands, and where it does not

Write run lines in a `SKILL.md` as `node "${CLAUDE_PLUGIN_ROOT}"/scripts/x.js`.
That is the correct form and it works in both runtimes, but they get there by
different routes, and knowing which is which stops a fix being written for a bug
that is not there.

| Where | Expands? | By what |
|---|---|---|
| A `SKILL.md` body, in Claude Code | Yes | The harness replaces it with the installed path before the skill reaches the model |
| A `SKILL.md` body, in Codex | No | Codex never delivers the body. It lists each skill by name, description and file path, and the model reads the file off disk and resolves the path from where it read it |
| `hooks/hooks.json` | Yes | A manifest variable, resolved by the host at startup |
| A user's own `settings.json` | No | Nothing expands it there, and a literal installed path rots on the next update because it carries a version number. Name an absolute interpreter instead |
| Text printed to the user | No | It reaches them as the raw characters, which means nothing to a reader. Resolve it first or do not show it |

Measured on 2026-08-17: across 286 Claude Code transcripts, 370 skill deliveries
covering 24 skills contained no unexpanded placeholder, and across 37 Codex
transcripts 98 commands naming a plugin script carried a fully resolved path and
none carried the placeholder.

**Never write the resolved path into a file that outlives the session.** It
carries a version number, the old directory survives an update, and the setting
keeps resolving to code nobody is running any more.

## Does this plugin need setup?

Setup is conditional, not a standard tax on every installation. Ship a setup
skill only when the plugin needs at least one of these:

- user-specific choices;
- credentials, integrations, paths, or external dependencies;
- a generated configuration file; or
- a decision for which no safe default exists.

A zero-configuration plugin must work immediately after installation and must
not ship an empty ceremonial setup flow.

When setup is required:

- Keep it inside the plugin as `/plugin-name:setup`, so the user does not need
  a second plugin to configure the first one.
- Probe what can be discovered, show the proposed values, and ask for one
  confirmation or correction rather than conducting an interview.
- Write only user-owned configuration. Never edit files in the installed plugin
  cache.
- Make the plugin README's first-use instructions say to run the setup skill.
- Fail plainly when required configuration is absent. Silence must not look
  like a successful setup.

## Verification and release

- Exercise the skill on representative examples, including the cheapest or
  safest path and the case most likely to be misrouted.
- Add a focused regression test for executable behavior and important written
  contracts. Test outcomes, not just the presence of reassuring words.
- Run the skill validator and plugin validator.
- Run `node tests/run-all.js` and `git diff --check`. GitHub Actions also runs
  the suite on every pull request and every push to `main`, on Linux and macOS,
  so a result that depends on the machine shows up as one row passing and the
  other failing. Running it locally first is still worth it: it is faster, and
  CI is a second opinion rather than a substitute for having looked.
- Install the built version and verify it in a clean chat. Confirm that the
  skill is discoverable by the language a user would naturally type.
- Review the final diff for credentials, machine-specific paths, stale model or
  product claims, and duplicated sources of truth.
- Commit intentionally, push a branch, and open a ready-for-review pull request.
- After merge, install or update the released plugin and record the merge as
  evidence when closing its `/to-build` item.

The tests enforce the mechanical subset of this checklist. Judgment calls such
as whether setup is valuable, whether a default is safe, and whether the skill
solves a real problem remain part of review.
