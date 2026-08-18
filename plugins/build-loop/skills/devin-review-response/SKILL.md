---
name: devin-review-response
description: Resolve a complete Devin code-review round without point fixes. Use when Devin posts PR findings, the user asks to address or fix a Devin review, or a branch needs a final Devin-response pass before push or merge. Maps dependencies before editing, audits paired and adjacent files, classifies every finding, validates the round record, and produces one atomic commit per review round.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(node:*), Bash(git branch --show-current:*), Bash(git diff:*), Bash(git log:*), Bash(git remote -v:*), Bash(git rev-parse:*), Bash(git status:*), Bash(gh auth status:*), Bash(gh pr view:*), Bash(gh api --method GET:*)
---

# Devin review response

Treat one Devin review as one bounded change set. Do not edit until every finding is visible and triaged.

## 1. Establish the round

Resolve the repository, PR, branch, head SHA, and review round. Confirm the checked-out branch is the PR head and the local head matches the remote head.

Fetch every inline and top-level finding. Prefer the connected GitHub app. When
it cannot return inline review comments, use `gh api --method GET` against the
pull request's `reviews` and `comments` endpoints; the method must be explicit
so the scoped grant cannot authorize a GitHub write. If Devin reports additional
findings behind its web interface, stop and ask the user to provide them. An
incomplete finding set cannot produce a clean round.

Create one private temporary directory for the round:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scratch.js"
```

Use the path it prints as `{scratch}`. If it exits non-zero it printed why
instead of a path, so say what it said and stop rather than treating that
sentence as a directory. Create a JSON round record at
`{scratch}/round.json` from
[references/round-record.example.json](references/round-record.example.json).
Set `review_outcome` to `findings` when the review contains findings, or `clean`
only when the authoritative review completed with none. An empty array without
that explicit clean outcome must fail validation. Keep the record there until
the round is complete.

## 2. Classify every finding

Assign exactly one disposition from [references/dispositions.md](references/dispositions.md):

- `fixed`
- `design-intentional`
- `deferred`
- `positive-flag`
- `out-of-scope`

Record every finding, including compliments and findings that require no code change. Never silently omit one.

## 3. Map before editing

For every `fixed` finding, identify and record:

1. The changed symbol or behavior.
2. Every caller, consumer, importer, schema reader, fixture, and test.
3. Inputs, outputs, persisted shapes, and configuration affected by the change.
4. Paired and adjacent files found with [references/paired-files.md](references/paired-files.md).
5. Documentation whose claims may change.

Read the relevant files in full. Search the repository for symbols and behavior, not only filenames. Complete `dependency_audit` and `paired_file_audit` in the round record before changing code.

## 4. Apply the complete round

Fix every `fixed` finding and every instance of the same defect uncovered by the dependency and paired-file audits.

For other dispositions, leave durable evidence:

- `design-intentional`: cite the decision or invariant in code or documentation.
- `deferred`: name the issue, requirement, or queue item that will carry the work.
- `out-of-scope`: prove the behavior predates the PR and record where it will be handled.
- `positive-flag`: state what should be preserved.

Sweep tests, fixtures, docs, examples, manifests, generated surfaces, and counts after the code changes. Use [references/review-patterns.md](references/review-patterns.md) as the final audit checklist.

## 5. Verify and ship one round

Run the repository's complete relevant test, typecheck, lint, and formatting gates. Record each command and outcome in `verification`.
The frontmatter pre-approves repository search, private scratch-directory
creation, validation, and read-only Git and GitHub inspection. Commands that
change repository or GitHub state, including `git add`, `git commit`, `git
push`, and any `gh` write, deliberately remain behind the host's normal
permission prompt. Repository-specific gates using other commands do too. Do
not broaden the Bash grants to suppress those prompts.

Validate the record:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pre-push-check.js" /path/to/round.json
```

Do not commit if validation fails. Run the same check again after the commit and before push so the record reflects the final verification results. Show the user the complete disposition table and the files changed. Commit the whole review round once, using [references/templates.md](references/templates.md). Never bypass repository hooks.

Push only when the user asked for it and the active GitHub account and destination are confirmed. Post the disposition table as the PR response, with the round commit SHA filled in after commit.

If a later Devin pass reports new findings, start a new record and a new atomic commit. Do not fold multiple review rounds into one commit.

## Hard stops

Stop rather than claiming success when:

- the finding set is incomplete or cannot be fetched;
- the local branch or head does not match the PR;
- any finding lacks a disposition;
- any fixed finding lacks dependency or paired-file audit evidence;
- required verification failed or was not run;
- a supposed fix exists only in the local checkout while Devin reviewed another SHA.
