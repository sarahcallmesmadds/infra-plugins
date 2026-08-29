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

## Observable result

The report will preserve every current safety decision while describing the
available evidence precisely:

```text
Keep (N), not proved safe to delete:
  branch-name  (5 days old) — 3 commits not reachable from the default branch; that does not prove their work is absent from it
```

The branch remains in `Keep`. The command does not attempt a new content
comparison and does not offer the branch for deletion.

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
     positive reachability count prevents a safe-delete verdict, not that it
     proves the work exists nowhere else. Its force-delete warning and closing
     summary will use the same distinction.
   - The current behavior explanation in `plugins/git-hygiene/README.md` will
     distinguish "not proved safe" from "proved to hold unique work."
   - All seven surfaces enforced by
     `tests/plugin-description-drift.test.js` will move together: the Claude
     manifest description; the Codex manifest description, short description,
     and long description; the marketplace entry; the root README table row;
     and the plugin README opening tagline. Each will describe the held set as
     not proved safe to delete instead of necessarily holding unique work.
   - Historical release notes and internal comments that explain past behavior
     remain historical records unless they are also current instructions.
4. In `tests/stale-branches.test.js`, add outcome-focused coverage that proves:
   - the Keep heading no longer says deletion would lose work;
   - an unreachable commit count is still shown;
   - the output does not turn commit reachability into a claim that the work is
     absent;
   - a branch carrying both an open-pull-request reason and an unreachable
     commit reason renders both clearly;
   - pre-delete refusal uses the same precise reason; and
   - the README sample is coupled to both the Safe and Keep headings.
5. Update the current-output example in `plugins/git-hygiene/README.md` to match
   the executable report.
6. Add contract coverage for the skill and discovery descriptions so the
   overstatement cannot remain in or return to another user-facing route.
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
5. Run `claude plugin validate --strict plugins/git-hygiene`.
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
   lost on deletion.
11. Install the built 0.3.12 plugin from the implementation worktree in local
    scope, start a clean chat against that installed copy, and verify that
    natural stale-branch cleanup language discovers `stale-branches` and that
    its report uses the corrected wording. Confirm the installed files are the
    built 0.3.12 files before recording the result.
12. Run the required final Code review, Devin CLI review, Devin GitHub app
   review, and CI gates on the implementation head before merge.

## Baseline evidence

On `origin/main` at `6c8b06aeefcf333d30770b3af2e3688d47f9c3ab`:

- `node tests/stale-branches.test.js`: passed.
- `node tests/plugin-versions.test.js`: 9 checks passed.
- `node tests/skill-md-check.test.js`: 16 checks passed.
