# Git-hygiene branch wording correction plan

**Status:** Proposed, pending Code and Devin review

**Date:** 2026-08-29

**Queue entry:** `2026-08-23T15-49-58-cli`

**Plugin:** `git-hygiene`

## Problem

The text report groups every held branch beneath this heading:

```text
Keep (N) — deleting these would lose work:
```

For a branch with commits that are not reachable from the default branch, the
report also says those commits are "not in the default branch." That confuses
commit reachability with whether the work is present. The local path can also
run a no-op merge-tree comparison, and the remote path can use merged-pull-
request evidence, but a branch that none of those checks clears still has not
been proved to hold work that exists nowhere else. Its logical changes may have
reached the default branch in a later or otherwise different form.

The safety decision is correct. The explanation overstates what was checked.
Current discovery copy also promises that the plugin "never deletes unmerged
commits." That is too broad: a branch whose commits remain unreachable but whose
content is independently proved present by non-ancestry evidence can require
`git branch -D`, and a user can separately and explicitly request force-deletion
of a held branch. The implementation will correct that promise without changing
either approval path.

## Observable result

The report will preserve every current safety decision while describing the
available evidence precisely:

```text
Keep (N), not proved safe to delete:
  branch-name  (5 days old) — 3 commits not reachable from the default branch; that does not prove their work is absent from it
```

The branch remains in `Keep`. The command does not attempt a new content
comparison and does not offer the branch for deletion.

Discovery copy will describe the conservative default, independent merge
evidence, and explicit force-delete approval accurately instead of making an
exceptionless no-unmerged-commit deletion promise.

## Implementation

1. In `plugins/git-hygiene/scripts/cli.js`, replace the Keep heading with
   `Keep (N), not proved safe to delete:`.
2. Change only the `KEEP.UNMERGED` explanation produced by `reasonText`:
   - Replace "N commits not in the default branch" with "N commits not
     reachable from the default branch."
   - Add a compact qualification that unreachable commits do not prove their
     work is absent from the default branch.
   - Keep the qualification composable with other reasons such as an open pull
     request.
3. Correct the same reachability overstatement in the user-facing instruction
   and discovery surfaces:
   - `plugins/git-hygiene/skills/stale-branches/SKILL.md` will say that a
     positive reachability count is insufficient by itself to prove a branch
     safe. Without independent merge evidence it keeps the branch, but it does
     not prove the work exists nowhere else. Its frontmatter description,
     evidence explanation, sweep summary, force-delete warning, closing
     summary, and "never does" contract will use the same distinction and will
     describe the two explicit `-D` paths instead of promising that unreachable
     commits are never deleted.
   - The current behavior explanation in `plugins/git-hygiene/README.md` will
     distinguish "not proved safe" from "proved to hold unique work." This
     includes the distinction paragraph, sample output, and "What it will not
     do" section, rather than only the sample. Its deletion guarantees will
     also distinguish the normal safe-delete flow from the separately approved
     force-delete path and the independently verified non-ancestry path, without
     claiming which history operation produced the equivalent content.
   - The five discovery surfaces that currently make a unique-work claim will be
     corrected: the Claude manifest description; the Codex manifest description
     and long description; the marketplace entry; and the root README table row.
     The Codex short description and plugin README opening tagline are already
     neutral, but `tests/plugin-description-drift.test.js` requires them to move
     deliberately with the other five. Their replacements will remain neutral
     while aligning with the new not-proved-safe wording.
     The Claude and Codex manifest descriptions and the marketplace entry will
     also drop "Never deletes unmerged commits." The Codex long description
     will not imply that every deletion uses lowercase `-d`; all replacements
     will describe approval and evidence without an exceptionless promise.
   - Historical release notes and internal comments that explain past behavior
     remain historical records unless they are also current instructions.
4. In `tests/stale-branches.test.js`, add outcome-focused coverage that proves:
   - existing assertions and comments that describe current output no longer
     pin the old "not in the default branch" wording;
   - the Keep heading no longer says deletion would lose work;
   - an unreachable commit count is still shown;
   - the output does not turn commit reachability into a claim that the work is
     absent;
   - a branch carrying both an open-pull-request reason and an unreachable
     commit reason renders both clearly;
   - pre-delete refusal uses the same precise reason;
   - the README sample is coupled to both the Safe and Keep headings;
   - current README prose cannot reintroduce the "only copy," "destroys them,"
     or unconditional "loses work" claims for a held branch;
   - current README prose cannot promise that unreachable or unmerged commits
     are never deleted while documented, separately approved `-D` paths exist;
     and
   - the skill frontmatter and body cannot reintroduce either overstatement.
   Preserve comments that quote historical failure output, including the
   squash-merge failure record near the existing output tests; those comments
   describe what an older release literally printed rather than the current
   contract.
5. Update the current-output example in `plugins/git-hygiene/README.md` to match
   the executable report.
6. Add the skill-frontmatter and current-prose contract assertions to
   `tests/stale-branches.test.js`. Keep
   `tests/plugin-description-drift.test.js` responsible for its existing seven
   plugin-level description surfaces; the skill-specific contract is an
   adjacent eighth route, not a silent expansion of that general inventory.
   Extend `tests/plugin-description-drift.test.js` with a semantic contract for
   the current values it reads from all seven git-hygiene discovery surfaces.
   The contract will reject a unique-work claim and an exceptionless promise
   that unreachable or unmerged commits are never deleted wherever either
   appears. It will not imply that the already-neutral short description and
   plugin README tagline previously made either claim, so moving all seven
   together cannot reintroduce an overstatement.
7. Release the behavior as `git-hygiene` 0.3.12:
   - add a dated entry to `plugins/git-hygiene/CHANGELOG.md`;
   - update both plugin manifests; and
   - update the marketplace version.

## Boundaries

- Do not change `classify.js` or any `safeToDelete` decision.
- Do not add a patch-equivalence or tree-equivalence algorithm.
- Do not change local or remote branch collection.
- Do not change deletion commands or the approval gate.
- Do not change JSON fields or persisted data.
- Do not update another plugin in the same pull request.
- Do not edit the shared `main` checkout.
- Do not treat historical release notes as current product copy.

## Verification

1. Run `node tests/stale-branches.test.js`.
2. Run `node tests/plugin-versions.test.js`.
3. Run `node tests/plugin-description-drift.test.js`.
4. Run `node tests/skill-md-check.test.js`.
5. Run `claude plugin validate --strict plugins/git-hygiene`. The Claude CLI is
   a required release-tool prerequisite for this repository; if it is absent,
   stop rather than treating the Node tests as an equivalent validator.
6. Run `node tests/run-all.js`.
7. Run `git diff --check`.
8. Exercise the CLI with a saved input containing:
   - one branch held only because its commits are unreachable;
   - one branch with both an open pull request and unreachable commits; and
   - one branch already proved safe.
9. Confirm text classification is unchanged and `--json` is byte-for-byte
   unchanged for the same saved input.
10. Sweep current user-facing git-hygiene copy for claims that a positive
   reachability count proves work exists nowhere else or would certainly be
   lost on deletion, and for exceptionless promises that unreachable or
   unmerged commits are never deleted despite the documented `-D` paths.
11. Verify an actual marketplace-installed 0.3.12 copy before merge. This
    repository has no separate build artifact: the marketplace copies
    `plugins/git-hygiene` into its cache. Use a private disposable
    `CLAUDE_CONFIG_DIR`, then run these commands against the implementation
    worktree:
    - `claude plugin marketplace add --scope user <worktree>`;
    - `claude plugin install git-hygiene@infra-plugins --scope user`; and
    - `claude plugin list` to confirm version 0.3.12 is enabled from that
      disposable configuration.
    Inspect and run
    `<config>/plugins/cache/infra-plugins/git-hygiene/0.3.12/scripts/cli.js`, not
    the worktree copy, against the saved input. Compare its checksum with the
    reviewed worktree file. From a neutral directory, start a clean
    noninteractive chat using the same disposable `CLAUDE_CONFIG_DIR` and
    natural stale-branch cleanup language, then confirm it discovers
    `stale-branches`. Keep the disposable configuration and its evidence
    outside the repository.
12. Run the required final Code review, Devin CLI review, Devin GitHub app
   review, and CI gates on the implementation head before merge.

## Baseline evidence

On `origin/main` at `6c8b06aeefcf333d30770b3af2e3688d47f9c3ab`:

- `node tests/stale-branches.test.js`: passed.
- `node tests/plugin-versions.test.js`: 9 checks passed.
- `node tests/skill-md-check.test.js`: 16 checks passed.
