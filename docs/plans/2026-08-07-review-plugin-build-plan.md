# Review plugin build plan

**Date:** 2026-08-07

**Status:** Ready for final product approval. Do not implement until Sarah changes this status to `Approved to build`.

**Destination:** Public `sarahcallmesmadds/plugins` repository

**Plugin name:** `review`

**Initial version:** `0.1.0`

## Purpose

Build a public review plugin that improves important work through direct,
audience-aware judgment. The plugin applies permanent quality rules, can add a
private or public lens, can run saved groups of lenses independently, and can
return a finished revision rather than commentary alone.

The public plugin is the machinery. Personal and company-specific lenses,
panels, examples, and context remain outside the public repository in local or
private Git repositories.

The user interacts in ordinary language. The design must not require the user
to know command flags, edit structured files, manage Git, or understand the
plugin's internal storage.

## Product decisions already made

These are requirements, not implementation questions.

1. The product is a plugin named `review`, not `feedback`.
2. The first built-in public lens is named **Review quality**, not Executive.
3. A panel is a saved, named group of lenses. Panels have their own public
   skill and are not merely an undocumented mode inside the main review skill.
4. A panel runs each lens independently before combining the results.
5. The public repository contains no private lens content, named-person
   observations, private examples, contact information, or company strategy.
6. Personal lenses can stay local or be backed up to a private GitHub
   repository.
7. Company lenses can be shared through a private company-owned GitHub
   repository.
8. Version one never pushes a lens or panel to a public repository. There is no
   public-lens publishing path to misconfigure.
9. Every new lens and panel is private by default.
10. Normal conversations never update durable lenses, panels, or company
    context automatically.
11. A lens is a judgment lens, never an instruction to impersonate a person,
    copy their voice, or claim their authority or approval.
12. Company context is separate from a lens and must expire.
13. Review works without a lens or company context.
14. The plugin works in Claude and Codex and fails honestly when a runtime
    cannot provide isolated reviewers for a panel.

## What ships in version 0.1.0

### User-facing skills

1. `review`
2. `review-panel`
3. `review-lenses`
4. `setup`, invoked as `/review:setup`

### Internal reviewer contract

`references/review-one.md` supplies the instructions for one isolated panel
reviewer. It is not a skill, command, or user-discoverable action.

### Supporting behavior

- Permanent review rules
- Built-in Review quality lens
- Repository-standard `/review:setup` flow for private lens stores
- Local connection to one or more private lens repositories
- Creation and editing of private lenses and panels through plain-language
  approval flows
- Freshness checks for company context
- Private-repository visibility checks before backup or sharing
- Exact-file Git staging and explicit approval before commit or push
- Deterministic validation and path-safety scripts
- Automated tests and public documentation

### Explicitly excluded from version 0.1.0

- A Slack bot, web application, or hosted service
- A database
- Automatic ingestion from email, Slack, meetings, or conversations
- Automatic creation of durable memories
- A public marketplace for user-created lenses
- Pushing any lens or panel to a public repository
- Creating company GitHub repositories or granting company access
- Pretending sequential reviews are independent when isolated reviewers are
  unavailable
- Importing a legacy named-person profile without a separate private-content
  review

## Permanent review rules

Every review applies these rules before any lens or company context.

### Evaluation order

1. Identify the intended audience.
2. Identify what the audience must understand, decide, believe, or do.
3. Check the user's requested length, tone, format, evidence, and destination.
4. Identify the single most consequential problem.
5. Test relevance, impact, clarity, evidence, and internal consistency.
6. Explain the audience consequence in concrete language.
7. Produce the requested finished revision when the source is sufficient.
8. State only the assumptions or missing evidence that materially affect the
   result.

### Permanent boundaries

- Separate verified facts from assumptions and interpretation.
- Never invent access, research, approval, verification, or authority.
- Never sign as or speak as another person.
- Never claim that a lens reproduces what a real person thinks.
- Refuse only unsafe parts of a request and still complete the safe work.
- Do not use praise merely to cushion a material correction.
- Preserve effective source material instead of rewriting for novelty.
- When concision is requested or clearly needed, the revision becomes shorter
  unless essential meaning would be lost.
- Stop cosmetic editing when the premise or direction requires a decision.

## Built-in Review quality lens

The Review quality lens is public and identity-free. It emphasizes:

- Relevance to the stated goal
- Audience fit
- Decision clarity
- Material impact
- Evidence quality
- Prioritization
- Credibility
- Whether the requested action is unmistakable
- Whether the finished artifact is immediately usable

It does not contain:

- A person's name, biography, email address, quotations, or mannerisms
- Claims attributed to a specific leader or company
- Company-specific strategy or terminology
- Private examples
- Instructions to imitate a voice

The lens is built from the approved portable judgment rules preserved from the
retired feedback-coach work. The implementation copies only identity-free
judgment behavior. It does not copy the legacy persona format.

## Public plugin structure

The implementation creates these files:

```text
plugins/review/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── README.md
├── references/
│   ├── permanent-review-rules.md
│   ├── review-one.md
│   ├── lens-contract.md
│   ├── panel-contract.md
│   ├── company-context-contract.md
│   └── lenses/
│       └── review-quality.md
├── scripts/
│   ├── config.js
│   ├── stores.js
│   ├── validate.js
│   └── private-git.js
└── skills/
    ├── review/SKILL.md
    ├── review-lenses/SKILL.md
    ├── review-panel/SKILL.md
    └── setup/SKILL.md

tests/
├── review-plugin.test.js
├── review-stores.test.js
├── review-runtime-config.test.js
├── review-privacy.test.js
└── review-panel.test.js
```

The build also updates:

- `.claude-plugin/marketplace.json`
- `README.md`
- Any repository-owned skill-count documentation or tests found by the final
  count sweep

No hook, MCP server, app connector, network service, or database ships in
version 0.1.0.

## Skill specification: `review`

### User purpose

Review or rewrite an artifact using the permanent rules and zero or one lens.

### Natural-language triggers

The description must route requests such as:

- Review this.
- Tell me what is wrong with this draft.
- Rewrite this using my Review quality lens.
- Review this using my product lens.
- Give me the most important issue and fix it.

The user never needs to provide command flags.

### Inputs

- The artifact, pasted or provided as a readable file
- Intended audience, when known
- Intended outcome, when known
- User constraints
- Optional lens name
- Optional company-context name
- Whether the user wants judgment, a rewrite, or both

### Resolution order

1. Load the permanent review rules.
2. Resolve the requested lens.
3. If no lens is requested, continue with permanent rules only.
4. Compare display-name matches across all public built-in lenses and every
   connected private store. If more than one candidate has the requested name,
   stop and show source-qualified choices, including **built-in** for a public
   lens and the store name for each private lens. Never give either source
   precedence. After the user chooses, resolve that candidate by its stable
   identifier for the request.
5. Resolve company context only when the user requests it or the selected lens
   explicitly names it as its default. A lens default is already a stable
   identifier and resolves directly. A user request is a spoken name: compare
   display-name matches across every connected private store. If more than one
   candidate has the requested name, stop and show store-qualified choices,
   never giving any store precedence, and resolve the chosen candidate by its
   stable identifier. Company contexts are private-store content only, so no
   built-in candidate exists.
6. Validate the context expiration before reading its substantive content.
7. Exclude expired context and tell the user it was excluded.
8. Review the artifact.

### Output contract

Return only the sections the request needs:

- Main judgment
- Why it matters to the audience or outcome
- Finished revision, when requested or when direct improvement is clearly more
  useful than commentary alone
- Material assumptions or missing evidence

The response names the lens and company context used. It never claims that a
real person performed, approved, or agreed with the review.

### Failure behavior

- Missing artifact: ask for the artifact.
- Unknown lens: list the available matching lenses and ask for a choice.
- Ambiguous lens: list every source-qualified candidate, including built-in and
  private-store matches, and ask for a choice. Never select by precedence.
- Invalid lens: name the invalid file and validation failure; do not partially
  apply it.
- Unknown context: list the available company contexts and ask for a choice.
  Do not fall back to any other context and do not proceed silently.
- Ambiguous context: list every store-qualified candidate and ask for a choice.
  Never select by precedence.
- Invalid context: name the invalid file and validation failure; do not
  partially apply it.
- Expired context: proceed without it and say so.
- Unreadable context: proceed without it and say so.
- Missing setup: explain that no private lens store is connected and offer to
  run the lens setup flow; built-in Review quality remains available.

### Write boundary

`review` is strictly read-only. It cannot create, edit, commit, push, send, or
save an artifact, lens, panel, or context.

## Internal reviewer contract: `references/review-one.md`

### Type

Internal instruction file loaded only by `review-panel` when it creates an
isolated reviewer. It has no skill frontmatter, is not stored below `skills/`,
and cannot be invoked or discovered as a user action in Claude or Codex.

### Purpose

Perform exactly one isolated review for `review-panel`.

### Inputs

- The original artifact
- Permanent review rules
- Exactly one resolved lens
- Zero or one validated company context
- Audience, outcome, and user constraints
- A review identifier assigned by `review-panel`

### Isolation contract

The input must never contain:

- Another lens's instructions
- Another reviewer's output
- The reconciliation instructions
- A proposed consensus

The output includes:

- Main judgment
- Audience or outcome impact
- Evidence from the artifact
- Recommended change
- Finished revision when the panel request asks for one
- Assumptions

The output never addresses another reviewer and never attempts reconciliation.

### Failure behavior

A failed reviewer returns a failure record to `review-panel`. The panel reports
the missing lens result and does not invent it.

## Skill specification: `review-panel`

### User purpose

Create, inspect, update, and run a saved group of lenses.

### Natural-language triggers

The description must route requests such as:

- Run my cofounder panel on this.
- Have my product and finance lenses review this independently.
- Create a hiring panel from these lenses.
- Add this lens to my launch panel.
- Show me what is in my cofounder panel.

### Saved panel contents

The **Panel contract** below is the sole field definition. This skill collects
and persists every field required by that contract; it does not keep a second,
partial field list.

A panel stores references to lenses. It never copies or merges their content.

### Creation and update flow

1. Resolve every requested lens.
2. Show the panel name, purpose, lens membership, and company context in plain
   language.
3. Refuse an empty membership list, repeated store-qualified lens identifiers,
   and missing, invalid, ambiguous, or inactive lenses. Repeated lenses are
   rejected rather than silently de-duplicated.
4. Wait for explicit approval.
5. Write through the deterministic store script using an atomic, locked write.
6. Validate the saved panel by reading it back.
7. Do not back it up or share it unless the user separately asks.

### Panel execution

1. Read the original artifact once.
2. Resolve and validate every lens and the optional current context.
3. If any member lens is inactive, report each inactive member and refuse to run
   the panel until the user restores the lens or updates the panel. Never omit
   the member or run a smaller panel silently.
4. Create one isolated reviewer task per lens using
   `references/review-one.md`.
5. Give every reviewer the same artifact, audience, outcome, and constraints.
6. Give each reviewer only its own lens and allowed context.
7. Start reviewers without exposing any reviewer's output to another reviewer.
8. Wait until all reviewers finish or fail.
9. Reconcile only after the independent phase ends.

### Reconciliation output

- Most important shared finding
- Points of agreement
- Material disagreements
- Why the disagreement exists
- Recommended priority
- Finished revision when requested
- Which lens reviews failed or were excluded

The reconciliation does not erase disagreement merely to produce consensus.

### Runtime limitation

If the runtime cannot isolate reviewers, the skill says that independent panel
review is unavailable in that environment. It may offer separately labeled
sequential reviews, but it must not call them independent or a panel result.

### Write boundary

Running a panel is read-only. Creating or editing a saved panel requires the
approval flow above. Backup and sharing use the separate private Git flow.

## Skill specification: `setup`

### Invocation

The skill lives inside the plugin at `skills/setup/SKILL.md` and is invoked as
`/review:setup`, matching the repository setup convention.

The plugin README's first-use instructions tell the user to run
`/review:setup`. Natural-language requests such as “set up my review lenses”
must route to the same skill.

### User purpose

Connect this installation of the public review plugin to local-only or private
Git lens stores without requiring manual configuration, file editing, or pasted
credentials.

Setup also teaches what affects a review before asking the user to connect
anything. It explains in plain language that:

1. Permanent review rules apply automatically to every review.
2. A lens adds a chosen judgment perspective. The built-in Review quality lens
   works without private setup.
3. Company context adds current organization-specific facts, priorities,
   terminology, and constraints. It is separate from a lens and expires.

Setup explains that a panel is a saved group of lenses run independently, not
a fourth judgment layer. The user is not required to remember these terms or
choose all three layers before continuing.

### First-run setup

1. Give the plain-language explanation of what affects a review above.
2. Report what works immediately: permanent review rules, ordinary review with
   no lens or company context, and the built-in Review quality lens.
3. Detect whether GitHub CLI and Git are available.
4. Detect the active GitHub account without exposing its token.
5. Ask whether the user is connecting an existing private repository, creating
   a new private personal repository, or using a local-only folder.
6. For an existing repository, check its actual GitHub visibility before
   cloning.
7. For a new repository, show the owner, repository name, and `private`
   visibility and wait for explicit approval before creation.
8. Clone or create the store in the standard local location.
9. Validate the store.
10. Show the proposed local connection and wait for approval before writing
   `~/.claude/review.config.json`.
11. Report the available lenses, panels, and company contexts, distinguish the
    built-in lens from private-store content, and say that future review
    requests can name any of them in ordinary language.

The flow asks for decisions in plain language and performs Git operations for
the user. It never asks the user to edit configuration files or paste an access
token.

### Setup on another skill runner

On a new machine or skill runner, the user identifies the private repository in
plain language or runs `/review:setup`. The flow checks access, verifies
privacy, clones the store, validates it, and connects it locally. Existing
GitHub authentication supplies access. Plugin-specific credentials are never
created or stored.

If the runner cannot access the repository, setup stops with the repository and
account it checked. It does not silently create an empty replacement store.

### Re-running setup

Re-running `/review:setup` reads the existing configuration, reports the
connected stores, and offers to add, reconnect, or remove a connection. It
never overwrites a healthy configuration or changes a default store without
showing the exact change and receiving approval.

### Failure behavior

- Missing Git or GitHub CLI: explain which capability is unavailable and offer
  local-only setup when GitHub is the only missing capability.
- Missing GitHub authentication: identify the account check that failed and
  stop before cloning or creating anything.
- Public repository: refuse the connection.
- Unverifiable visibility: refuse the connection.
- Invalid store: report validation failures and do not add it to configuration.
- Existing configuration with unrelated or unknown fields: preserve it and
  stop rather than replacing it.

### Write boundary

The setup skill writes only the approved local store and
`~/.claude/review.config.json`. Creating a GitHub repository, cloning, and
writing configuration each have an explicit preview and approval boundary.

## Skill specification: `review-lenses`

### User purpose

Create, inspect, update, remove from active use, back up, and share lenses;
manage company context; and report what is connected. First-run and new-runner
configuration belongs to `/review:setup`, not this skill.

### Natural-language triggers

The description must route requests such as:

- Create a private CTO lens from these notes.
- Update my product lens with this new decision.
- Back up my personal lenses.
- Share this lens through the company repository.
- Which lenses and panels can I use here?
- This company context is current through the end of September.

When no private store is connected, this skill directs the user to
`/review:setup`. It does not create configuration through a second competing
flow.

### Lens creation

1. Collect every field required by the **Lens contract** below and the source
   material needed to draft its judgment content. Source material is input to
   the contract's source or provenance note, not a separate stored field list.
2. Separate durable judgment behavior from temporary company facts.
3. Remove biography, contact information, voice imitation, invented authority,
   and unsupported claims.
4. Create a plain-language draft containing priorities, questions, pushback
   patterns, evidence expectations, and boundaries.
5. Show the complete draft.
6. Wait for explicit approval.
7. Save it as private in the selected store through an atomic, locked write.
8. Read it back through the validator.
9. Do not commit or push unless the user separately asks to back up or share.

### Lens updates

1. Read the current lens.
2. Show the proposed change and its source.
3. Preserve earlier evidence or provenance rather than silently replacing it.
4. Wait for approval.
5. Write and validate atomically.
6. Do not push unless separately requested.

### Company-context management

The **Company-context contract** below is the sole field definition. This skill
collects and persists every field required by that contract; it does not keep a
second, partial field list.

Context creation and updates require approval. The expiration date is required
and cannot be silently extended. The plugin never substitutes remembered
company information for missing or expired context.

### Back up and share

The user-facing vocabulary is:

- **Back up:** commit and push personal lenses or panels to a private personal
  repository.
- **Share:** commit and push lenses or panels to a private repository whose
  existing GitHub access includes other people.

There is no user-facing action named `publish` in version 0.1.0.

Before either action:

1. Resolve the exact store and remote.
2. Ask GitHub for the repository owner and visibility.
3. Refuse if the repository is public or visibility cannot be verified.
4. Refuse if the local path is outside the connected store.
5. Refuse symlink and path-traversal escapes.
6. Show the exact lens, panel, context, and registry files that will be staged.
7. Stop if unrelated changes are present.
8. Show the destination repository and branch.
9. Wait for explicit approval.
10. Stage only the displayed files.
11. Commit with a plain description.
12. Push to the confirmed private repository.
13. Report the commit and repository.

The skill never changes repository visibility or grants collaborators. Those
remain explicit GitHub administration actions outside the plugin.

### Retirement instead of deletion

Removing a lens or panel from active use marks it inactive without deleting or
blanking its stored content. The plugin can restore it by marking that same
record active again, including in a local-only store with no commits. Git-history
recovery is an additional safeguard only when the store changes have actually
been committed. Permanent deletion is outside version 0.1.0.

Retiring a lens does not rewrite any saved panel that references it. Those
panels remain stored but are unavailable to run until the lens is restored or
the panel is explicitly updated. Listing a panel reports the inactive member;
the plugin never treats retirement as permission to alter panel membership.

## Private store contract

Private stores are ordinary Git repositories that are readable by humans and
manageable by the plugin.

```text
review-lenses/
├── review-store.json
├── lenses/
│   └── <lens-name>.md
├── panels/
│   └── <panel-name>.md
└── contexts/
    └── <context-name>.md
```

`review-store.json` records the schema version, store identifier, owner,
personal-or-organization scope, and registries for lenses, panels, and
contexts. The Markdown files hold the readable content. Users never need to
edit the registry by hand.

### Lens contract

A valid lens contains:

- Stable identifier
- Display name
- Owner
- Personal or organization scope
- Private visibility
- Purpose
- Priorities
- Questions it asks
- Pushback patterns
- Evidence expectations
- Boundaries
- Source or provenance note
- Created and last-reviewed dates
- Optional default company-context identifier
- Active or inactive state

This list is the sole field definition. Every skill, script, fixture, and test
that creates, updates, reads, or validates a lens uses it as its single source
of truth; no creation flow keeps a second, partial field list.

### Panel contract

A valid panel contains:

- Stable identifier
- Display name
- Owner
- Personal or organization scope
- Purpose
- Private visibility
- Ordered membership list using store-qualified lens identifiers
- Optional company-context identifier
- Reconciliation focus
- Created and last-reviewed dates
- Active or inactive state

The order is for display only. It does not determine which reviewer runs first
or whose judgment dominates.

The scope must match the panel's containing store. Membership must contain at
least one lens and must not repeat a store-qualified lens identifier. Creation
and update accept only active lenses. If a member is retired later, the stored
panel remains structurally intact but its runnable status becomes unavailable;
this is not store corruption and does not remove the member.

Every skill, script, fixture, and test that creates, updates, reads, or validates
a panel uses this list as its single source of truth.

### Company-context contract

A valid context contains:

- Stable identifier
- Display name
- Organization
- Owner
- Confirmed date
- Expiration date
- Priorities
- Audiences
- Terminology
- Constraints
- Boundaries
- Active or inactive state

Every skill, script, fixture, and test that creates, updates, reads, or validates
company context uses this list as its single source of truth.

## Plugin README contract

The plugin README must explain all repository-required user-facing information:

- The plugin's purpose and the boundary between review, lens management, and
  panel management.
- The three things that can affect a review, using the same plain-language
  explanation as setup: permanent rules, an optional lens, and optional current
  company context. Explain that panels group lenses and are not a fourth layer.
- Installation and first use, including an explicit direction to run
  `/review:setup` before using private stores.
- How to invoke each public skill in plain language.
- Configuration, including `~/.claude/review.config.json`, what it stores, and
  which built-in review behavior works before setup.
- Runtime limits, including that a panel runs only when independent reviewer
  contexts are available and must never be presented as independent otherwise.
- Important side effects and their approval gates: setup may create or clone a
  private store and write local configuration; lens management may write that
  store; and back up or share may commit and push to an approved private remote.
- The privacy boundary: ordinary review is read-only, private material never
  enters the public plugin, and version 0.1.0 refuses pushes to public remotes.

## Local configuration

The plugin stores only connection information locally. It does not store lens
content in configuration.

The configuration records:

- Schema version
- Connected store identifiers
- Absolute local paths
- Expected GitHub repository names, when connected to GitHub
- Personal or organization scope
- Default store for newly created private lenses

The configuration location is:

```text
~/.claude/review.config.json
```

This is the single configuration path for both Claude and Codex. Codex reads
and writes this same user-owned file; it must not create or consult a second
`~/.codex` configuration copy. A machine with both runtimes therefore has one
set of connected stores and one default-store decision.

This path choice is not accepted on assertion alone. Before setup ships,
`config.js` must pass the cross-runtime probe below in clean Claude and Codex
sessions. A failure in either runtime stops the build and returns the path
decision to plan approval; the builder must not silently add a fallback path.

Pre-implementation evidence recorded on 2026-08-07: the active Codex runtime
resolved the user-owned `~/.claude` directory, wrote and read an exact synthetic
payload in a uniquely named probe file, removed that file, and verified cleanup.
Claude's side uses the repository-standard `~/.claude/<plugin>.config.json`
location documented in `CONTRIBUTING.md`. The Phase 4 and Phase 8 probes remain
mandatory because the implemented script and installed plugin must reproduce
this result in clean sessions; this planning probe does not replace them.

All writes are atomic and locked. The script refuses duplicate store
identifiers, missing directories, repositories whose actual remote disagrees
with the configured repository, and paths that resolve through symlinks outside
the store.

No GitHub token, password, private lens text, or company context appears in the
configuration.

## Deterministic script responsibilities

### `config.js`

- Read and validate local configuration
- Add or remove store connections with approval supplied by the calling skill
- Resolve `~/.claude/review.config.json` identically in Claude and Codex
- Provide a probe that resolves the absolute configuration path, then
  atomically writes, reads, and removes a uniquely named synthetic sibling file
  without touching the real configuration. Plan approval authorizes this
  synthetic Phase 4 and Phase 8 probe, so it requires no additional approval
  interaction. Setup still requires its documented user approval before writing
  the real configuration.
- Write atomically under a lock
- Print structured results for the skills

### `stores.js`

- Initialize and validate private stores
- List lenses, panels, and contexts
- Resolve names and detect ambiguity
- Create and update lenses, panels, and contexts atomically
- Enforce active/inactive state
- Reject empty or repeated panel membership, require panel scope to match its
  containing store, and report panels with retired members as unavailable
- Enforce path containment and reject symlink escapes

### `validate.js`

- Validate public built-in lenses
- Validate private store registries and Markdown contracts
- Validate panel membership
- Distinguish a structurally intact panel with a retired member from a runnable
  panel, and refuse runnable validation until every member is active
- Validate context dates and expiration
- Reject missing required sections and unknown schema versions
- Scan public plugin files for forbidden private or identity-bearing material

### `private-git.js`

- Identify the Git repository and remote for a connected store
- Read GitHub owner and visibility using the authenticated GitHub CLI
- Refuse public or unverifiable destinations
- Detect unrelated working-tree changes
- Produce the exact stage list
- Commit and push only after the calling skill records explicit approval
- Return repository and commit evidence

Scripts perform mechanics and enforcement. Skills retain judgment about what a
lens means and whether a draft matches the user's request.

## Privacy and identity rules

The following are release-blocking requirements:

1. Public plugin files contain no private lens or company-context data.
2. User-created lenses, panels, and contexts default to private.
3. Version 0.1.0 refuses every push to a public repository.
4. Named-person lenses may record the user's observations, but output must be
   framed as the user's lens, never the person's actual review.
5. Lenses contain no instruction to mimic cadence, vocabulary, personality, or
   mannerisms.
6. Contact information and biography are rejected unless the user proves they
   are necessary for review behavior; version 0.1.0 has no valid use for either.
7. The plugin never claims another person reviewed, approved, verified, or
   authorized work.
8. The plugin never automatically learns from conversation history.
9. Company context expires and is excluded after expiration.
10. Review is read-only; only explicit management flows write.

## Test plan

### `tests/review-plugin.test.js`

Proves:

- Both manifests exist and name `review`.
- The marketplace and both manifests agree on version `0.1.0`.
- The root README links to the plugin.
- All four user-facing skills exist and pass the repository skill checker.
- `skills/setup/SKILL.md` exists and is the only first-run configuration flow.
- Setup and the README give the same plain-language explanation of permanent
  rules, an optional lens, and optional company context; both state that a panel
  groups lenses rather than adding another judgment layer.
- Setup reports what works before private configuration and finishes by naming
  the available built-in and private lenses, panels, and company contexts.
- The plugin README covers every item in the Plugin README contract: purpose,
  installation and first use, invocation, configuration, runtime limits,
  important side effects and approval gates, and the privacy boundary.
- The README's first-use instructions direct the user to `/review:setup`.
- The setup and configuration contracts use
  `~/.claude/review.config.json` consistently.
- Claude and Codex both resolve that same file, and the implementation contains
  no second runtime-specific configuration path.
- `references/review-one.md` exists, contains no YAML frontmatter block, and is
  not stored below `skills/`; no path matching `skills/review-one/**` exists;
  and no manifest, command, or skill frontmatter in the plugin names
  `review-one`. These are the conditions under which neither runtime can
  discover it, because both build their skill list from `skills/*/SKILL.md`
  frontmatter alone. Phase 8 confirms the resulting behavior in clean installed
  sessions.
- `review` has no write, Git, or GitHub permission.
- The public Review quality lens contains all required judgment dimensions.
- Public plugin files contain none of the forbidden identity or private-source
  markers maintained in the fixture.

### `tests/review-stores.test.js`

Proves:

- A valid store, lens, panel, and context pass.
- Unknown schema versions fail.
- Duplicate identifiers fail.
- Ambiguous lens names return every matching store and never pick one.
- A private lens named Review quality colliding with the built-in Review quality
  lens returns every source-qualified candidate, including matches from any
  additional private stores, and never picks one.
- A missing panel member fails.
- An empty panel and a panel with a repeated store-qualified lens identifier
  fail.
- A panel whose scope differs from its containing store fails.
- Retiring a member preserves the saved panel and marks it unavailable rather
  than deleting the member or treating the panel as corrupt.
- Panel order does not become reviewer priority.
- Expired context is classified as expired and its substantive content is not
  returned to the review caller.
- Atomic writes preserve an existing file when validation fails.
- Concurrent writes do not lose data.
- Path traversal and symlink escapes fail.
- Inactive lenses and panels are not selected by default.

### `tests/review-runtime-config.test.js`

Proves:

- Claude and Codex resolve the identical absolute
  `~/.claude/review.config.json` path for the same home directory.
- No code path resolves a `~/.codex` configuration copy.
- The synthetic probe never reads, replaces, or deletes the real configuration.
- The probe fails visibly when its directory cannot be resolved, read, written,
  or cleaned up.
- A live clean-session run in each runtime, authorized by Plan approval,
  atomically writes, reads, and removes its unique synthetic probe file without
  another approval interaction.

### `tests/review-privacy.test.js`

Proves:

- New lenses and panels default to private.
- A public GitHub destination is refused.
- An unverifiable destination is refused.
- A private destination proceeds only to the approval boundary.
- No commit or push occurs before approval.
- Only displayed files are staged after approval.
- Unrelated changes block backup or sharing.
- Repository visibility is checked at action time rather than trusted from
  saved configuration.
- No credentials are written to configuration, logs, fixtures, or output.
- Public lens scanning catches names, email addresses, private paths, and
  impersonation instructions in a mutation fixture.

### `tests/review-panel.test.js`

Proves:

- One isolated reviewer starts per panel lens.
- Empty and repeated membership are refused before any reviewer starts.
- A panel with an inactive member reports that member and starts no reviewers;
  it never runs with fewer reviewers.
- Every reviewer receives the same original artifact and user constraints.
- Each reviewer receives only its own lens.
- No reviewer receives another reviewer's output.
- Reconciliation begins only after all reviewer jobs finish or fail.
- A failed reviewer is reported and never fabricated.
- Agreement and disagreement both survive reconciliation.
- A runtime without isolated reviewers refuses to label the result an
  independent panel.
- Running a panel performs no writes.

### Repository-wide gates

Run and require success from:

- Focused review plugin tests
- Skill frontmatter and contract checks
- Plugin manifest agreement checks
- Plugin version drift checks
- Marketplace and root README discovery checks
- `node tests/run-all.js`
- `git diff --check`
- Claude skill validation
- Codex plugin validation

After automated gates pass, install version `0.1.0` and verify it in a clean
conversation using ordinary language rather than direct skill invocation.

## Acceptance scenarios

The implementation is not complete until a clean installed session can handle
all of these in ordinary language:

1. Review an artifact with permanent rules only.
2. Rewrite an artifact using Review quality.
3. Run setup and confirm that it explains permanent rules, an optional lens,
   and optional company context in plain language; identifies panels as saved
   groups of lenses; reports what works before private setup; and finishes with
   the available review choices.
4. Resolve a built-in/private Review quality name collision only after the user
   chooses a source-qualified candidate; never apply silent precedence.
5. Explain which lens and current context were used.
6. Refuse to use expired company context and continue safely without it.
7. Create a private role-based lens from notes after showing a complete draft.
8. Create a private named-person lens without impersonation or identity claims.
9. Create a saved panel from two private lenses.
10. Run the saved panel with real reviewer isolation.
11. Preserve material disagreements between panel members.
12. Set up an existing private lens repository on a new runner without manual
    configuration or pasted credentials through `/review:setup`.
13. Back up a personal lens to a verified private personal repository after
    confirmation.
14. Share a company lens through a verified private organization repository
    after confirmation.
15. Refuse every attempt to send a lens to a public repository.
16. Report an inaccessible private repository without creating an empty
    replacement.
17. Leave all repositories unchanged after an ordinary review.

## Implementation sequence

The builder follows this order. Do not skip ahead.

### Phase 1: Branch and baseline

1. Fetch current `origin/main`.
2. Create an isolated worktree and feature branch.
3. Confirm the main checkout's unrelated changes remain untouched.
4. Run the full baseline test suite and record any pre-existing failures.

### Phase 2: Contracts, fixtures, and test discipline

1. Add shared test helpers and synthetic private-store fixtures containing no
   real people, companies, or confidential material. Helpers and fixtures do
   not use the root `*.test.js` suffix and therefore are not auto-discovered.
2. Build each Phase 3 through Phase 7 behavior as one red-green slice: add the
   relevant assertion to its final `tests/review-*.test.js` suite, run that
   focused suite directly and record the expected failure, implement the same
   behavior immediately, then run the focused suite and `node tests/run-all.js`
   to green before starting another slice.
3. A transient red working tree is allowed only between the recorded focused
   failure and its immediately paired implementation. No failing suite may be
   committed, pushed, or carried across a phase boundary, and the five suites
   must never be added as a bulk red commit.
4. Mutation-test privacy and isolation assertions within their paired slice so
   each demonstrably fails when its protected behavior is removed and passes
   again before commit.

The final repository still contains all five auto-discovered test files listed
above. They are created incrementally with their implementation, not staged in
advance while their subjects do not exist.

### Phase 3: Plugin scaffold

1. Scaffold `plugins/review` with Claude and Codex manifests.
2. Add version `0.1.0` to both manifests and the marketplace.
3. Author the complete `skills/setup/SKILL.md` instructional contract specified
   above, including the three-layer explanation, pre-setup availability report,
   invocation, reconfiguration, completion report, failure behavior, and write
   boundaries. This is the real skill contract, not a placeholder; its script
   mechanics are implemented in Phase 4 and integrated in Phase 7.
4. Add the plugin README covering every item in the Plugin README contract,
   including plain-language first-use instructions that direct the user to
   `/review:setup`.
5. Add the plugin to the root README.
6. In the same red-green slice, add the Phase 3 assertions to
   `tests/review-plugin.test.js`: the setup skill exists, passes the repository
   skill checker, is the sole first-run flow, and is the README's first-use
   destination; the root README also links to the plugin. Make the focused suite
   and `tests/run-all.js` green before the phase boundary.

### Phase 4: Storage and privacy mechanics

1. Implement `config.js`.
2. Under Plan approval, run the synthetic configuration probe in clean Claude
   and Codex sessions without another approval interaction. Record the resolved
   absolute path and successful cleanup from each; stop the build if they differ
   or either probe fails.
3. Implement `stores.js`.
4. Implement `validate.js`.
5. Implement `private-git.js` through the pre-approval boundary.
6. Make store, freshness, path, and public-destination tests pass.

### Phase 5: Review behavior

1. Add permanent review rules.
2. Add the Review quality lens.
3. Implement the internal `references/review-one.md` reviewer contract and
   load it only while `review-panel` creates isolated reviewer tasks.
4. Implement the user-facing `review` skill.
5. Verify review remains read-only and works without private setup.

### Phase 6: Panel behavior

1. Implement saved panel creation and updates.
2. Implement isolated reviewer fan-out.
3. Implement reconciliation after the isolation boundary.
4. Verify agreement, disagreement, and reviewer failure behavior.

### Phase 7: Lens management and private Git

1. Integrate the Phase 3 `/review:setup` skill with the completed configuration,
   store, and private-Git mechanics for first-run, reconfiguration, and
   new-runner setup using `~/.claude/review.config.json`; do not replace or
   duplicate its instructional contract.
2. Implement lens and context drafts with approval gates in `review-lenses`.
3. Make `review-lenses` direct missing configuration to `/review:setup`.
4. Implement backup and sharing after live repository privacy verification.
5. Verify exact staging, unrelated-change blocking, commit evidence, and push
   evidence with isolated test repositories.
6. Run the setup skill end to end in its focused suite and require
   `tests/run-all.js` to remain green before the phase boundary. The focused
   suite must prove the setup explanation, pre-setup availability report, and
   final list of available review choices as well as the storage flow.

### Phase 8: Release verification

1. Run every focused and repository-wide gate.
2. Sweep the public diff for private names, emails, local source paths,
   credentials, company material, stale counts, and duplicated rules.
3. Install the plugin from the branch.
4. Repeat the synthetic configuration probe in installed clean Claude and Codex
   sessions and retain evidence that both resolved the same path and cleaned up.
5. Run all acceptance scenarios in a clean session.
6. Confirm in installed clean Claude and Codex sessions that `review-one` is not
   offered as a user action. It passes when the session's own list of available
   skills and commands contains no `review-one` entry and no entry whose
   description names it, and when asking each runtime to run `review-one`
   directly produces no such action. Retain the listing from each runtime as
   evidence. It fails if either runtime names it, in which case the internal
   reviewer contract is wrong and Phase 8 does not close.
7. Submit one independent code-review round and resolve it as one atomic change
   set.
8. Show Sarah the complete diff, test results, and representative outputs.

### Phase 9: Publish the public plugin

This phase requires Sarah's single public release approval after Phase 8. That
approval authorizes every step in this phase, including merge after the checks
and independent analysis are clean; it does not create another approval event.

1. Commit the complete plugin intentionally.
2. Push the feature branch.
3. Open a ready-for-review pull request.
4. Run repository checks and independent analysis until clean.
5. Merge after repository checks and independent analysis are clean.
6. Install the merged `review` plugin.

### Phase 10: Private lens store

This phase is separate from the public plugin and uses two already-declared
gates at different boundaries. Gate 3 authorizes repository creation or
connection. Gate 4 separately authorizes saving and backing up each initial
private lens or panel after its complete content and destination are shown.
The builder must not collapse gates 3 and 4 into one confirmation.

1. Show the proposed private repository owner and name.
2. Obtain gate 3, then create it as private or connect the approved existing
   private repository.
3. Draft the first private named-person lens from the approved source material.
4. Show the entire private lens to Sarah.
5. Obtain gate 4 for the complete lens content and displayed backup destination,
   then save it locally.
6. Back it up only within that lens's gate 4 authorization, after showing the
   exact files and destination again at the write boundary.
7. Obtain a separate gate 4 authorization for the first private saved panel
   after its member lenses exist and its membership, purpose, exact files, and
   backup destination are shown.

## Approval gates

There are four, and no hidden fifth gate is left for the builder to invent.

1. **Plan approval:** authorizes Phases 1 through 8 in an isolated worktree.
   This includes synthetic probe-file writes and cleanup in Phases 4 and 8; they
   do not create another approval gate or prompt.
2. **Public release approval:** given once after Phase 8, authorizes the complete
   Phase 9 commit, push, pull request, clean-check, and merge flow without a
   separate merge approval.
3. **Private repository approval:** authorizes creation or connection of the
   personal private lens repository.
4. **Private content approval:** authorizes saving and backing up each initial
   named-person lens and panel.

Routine implementation choices inside this specification do not return to
Sarah for approval. Any requested change to product scope, privacy behavior,
public/private ownership, panel independence, or automatic writes stops the
build and returns to plan approval.

## Builder handoff

A future session starts here:

1. Read this file completely.
2. Confirm the status says `Approved to build`. If it does not, stop.
3. Read `CONTRIBUTING.md` completely.
4. Read the current plugin-creator and skill-creator instructions completely.
5. Read only the two approved portable judgment source files named in the
   private to-build item's notes. Do not load legacy persona files into the
   public implementation.
6. Fetch current `origin/main` and create an isolated worktree.
7. Begin at Phase 1 and keep the tests ahead of implementation.
8. Do not edit the shared main checkout.
9. Do not create a private repository or write private lens content during the
   public plugin build.
10. Stop at the Phase 8 handoff and show Sarah the complete result.

## Definition of done

The public build is done when:

- All acceptance scenarios through public-plugin behavior pass.
- The public tree contains no private lens or company material.
- Review works with no private setup.
- Saved panels run truly independent reviews where the runtime supports it.
- Private destinations are checked live and public destinations are refused.
- Setup on a new runner requires no manual file editing or pasted credentials.
- The README and missing-configuration paths both route to `/review:setup`.
- Every automated gate passes.
- A clean installed session routes natural-language requests correctly.
- Sarah approves the complete diff and representative behavior.

The private setup is done when:

- The private store exists locally or in a verified private repository.
- Its first private lens passes content and privacy review.
- Its first saved panel resolves every member lens.
- A second clean runner can connect using existing GitHub access.
- No private material appears in the public plugin repository or its Git
  history.
