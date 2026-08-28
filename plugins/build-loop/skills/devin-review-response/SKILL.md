---
name: devin-review-response
description: Resolve a complete Devin code-review round without point fixes. Use when Devin posts PR findings, the user asks to address or fix a Devin review, or a branch needs a final Devin-response pass before push or merge. Captures every GitHub-app review and known CLI run for one commit, reconciles their reports without dropping either source, validates the response state, and produces one atomic commit per review round.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(node:*), Bash(git branch --show-current:*), Bash(git diff:*), Bash(git log:*), Bash(git remote -v:*), Bash(git remote get-url --push:*), Bash(git rev-parse:*), Bash(git status:*), Bash(gh auth status:*), Bash(gh pr view:*), Bash(gh api --method GET:*), Bash(devin --permission-mode auto --prompt-file:*)
---

# Devin review response

Treat one Devin review round as a lossless record of every GitHub-app and Devin
CLI result for one exact commit. A clean result from one source says nothing about the other.
Do not edit until every report from both sources is visible and linked to a
finding.

## 1. Establish the reviewed commit

Resolve the base repository, pull request, branch, head repository and current
remote head once. Save that full commit as `review_head_sha`, the PR head
repository as `head_repository`, and the local remote intended for this PR as
`push_remote`. Confirm the checked-out branch is the PR head, the local head
matches the remote head, and every push URL on that remote names
`head_repository`:

```bash
gh pr view 123 --repo github.com/owner/repository \
  --json headRefOid,headRefName,headRepository
git remote get-url --push --all -- 'PUSH_REMOTE'
```

For a fork PR, `repository` is the base repository while `head_repository` is
the fork. Never assume they are the same.

This workflow requires the GitHub CLI to be installed and authenticated for the
repository under review. Probe it before creating the round:

```bash
gh auth status --hostname github.com
```

If that fails, stop. Tell the user to install `gh` if it is missing or run
`gh auth login` themselves if it is signed out; do not treat missing GitHub
evidence as a clean review.

Create one private temporary directory for the round:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scratch.js"
```

Use the path it prints as `{scratch}`. Stop if it exits non-zero. Copy
[references/round-record.example.json](references/round-record.example.json) to
`{scratch}/round.json`; real review bodies, comments, CLI output and repository
details stay in this private directory and are never committed as fixtures.

Set `expected_reviewer_id` to `158243242`. This is the immutable numeric Devin
bot-user identity observed on the public GitHub review objects. Names are not
identity. If the live numeric ID differs, stop and revise the shipped constant
before capturing evidence.

Capture every posted app review and linked inline comment for the exact reviewed
commit:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review-evidence.js" capture-app \
  --repo owner/repository --pr 123 --head REVIEW_HEAD_SHA \
  --reviewer-id EXPECTED_REVIEWER_ID_FROM_ROUND \
  --out "{scratch}/github-app.json"
```

The collector uses paginated `gh api --method GET` requests for both `reviews`
and `comments`; the method is explicit so this route cannot authorize a GitHub
write. It reads both endpoints twice and stops if either payload changed or a
same-SHA Devin comment has no captured review. It keeps every same-SHA Devin app
retry. A later clean retry never erases an earlier findings review.

**Read the review body, not the check status.** The collector recognizes only
the pinned singular, plural, `new`, current and legacy additional-finding,
badge-envelope and resolution-only shapes. A pending review, unknown wording,
count drift, a missing page, or no same-SHA app review makes the capture
incomplete. Do not infer clean.

Build one `github_app` run in `review_runs` for every capture run, then one
`source_reports` row for every returned finding comment and advertised hidden
finding. Copy SHA, outcome and counts from the capture rather than restating
them independently.

## 2. Add every CLI execution

Discover every known proactive CLI execution against the same `review_head_sha`
and record each separately. If a known earlier run lacks a clean-worktree,
same-SHA capture, it cannot establish clean: rerun it when authorized or record
it as incomplete and stop. Results for another commit belong to another round.

If no CLI execution is known and the complete app capture has no unresolved
hidden report, leave the CLI rows empty and set
`cli_not_run_reason: "not-needed"`. That is the only no-CLI reason.

Run CLI recovery only when the app capture advertises a hidden finding. Before
each proactive or recovery command, capture the clean repository state:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review-evidence.js" start-cli \
  --repo-root "/path/to/repository" --purpose recovery \
  --output "{scratch}/devin-cli-1.txt" \
  --out "{scratch}/devin-cli-1.json"
```

Write the review prompt to `{scratch}/review-prompt.md`, then run Devin against
the same checkout. Export its response to the private directory while leaving
the answer visible:

The prompt must require Devin to end a completed response with one final line in
this exact grammar (replace the angle-bracket fields; do not put this placeholder
line itself in the prompt):

```text
DEVIN_REVIEW_COMPLETE outcome=<clean|findings> finding_count=<non-negative integer>
```

No marker, a malformed marker, or a marker anywhere except the final nonblank
line means the execution is incomplete, even when Devin exits zero. This is the
positive proof that the answer reached its requested conclusion rather than
ending in an unknown refusal, transport error, or partial result.

```bash
devin --permission-mode auto --prompt-file "{scratch}/review-prompt.md" --export "{scratch}/devin-cli-1.txt" -p
```

**The prompt goes in the file, never on the command line.** It includes text
fetched from a pull request. Putting that text after a pre-approved command
would let shell syntax inside it extend the command. A file path is not
shell-interpreted review content.

Finish the capture immediately. A successful clean marker uses count zero; a
successful findings marker uses its exact positive count. `finish-cli` derives
both fields from that marker; the optional flags shown here are a cross-check and
must agree:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review-evidence.js" finish-cli \
  --repo-root "/path/to/repository" --capture "{scratch}/devin-cli-1.json" \
  --output "{scratch}/devin-cli-1.txt" --exit-code 0 \
  --outcome findings --finding-count 1
```

`start-cli` and `finish-cli` both require an unchanged HEAD and an empty staged,
unstaged and untracked status. The script never invokes Devin. It stores the
actual exit code and output checksum. It also creates an exclusive sidecar before
the run so another attempt cannot reserve the same output path. Later validation
re-derives the run status, outcome and count from those bytes, so editing capture
labels cannot turn a refusal or unknown failure into a clean review.

Two preflight refusals do not mean a review returned zero findings:

- An untrusted workspace cannot show its trust prompt in print mode. Skipping
  that check falls outside the grant above and must ask first. Only a checkout
  of the repository already under review warrants it. After approval, start a
  new numbered capture and export to its own new output file:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/review-evidence.js" start-cli \
    --repo-root "/path/to/repository" --purpose recovery \
    --output "{scratch}/devin-cli-2.txt" \
    --out "{scratch}/devin-cli-2.json"
  ```

  <!-- bash-approval-required -->
  ```bash
  devin --respect-workspace-trust false --permission-mode auto --prompt-file "{scratch}/review-prompt.md" --export "{scratch}/devin-cli-2.txt" -p
  ```

  Finish `devin-cli-2.json` against `devin-cli-2.txt` using the retry's actual
  exit code, outcome and count.

- `--permission-mode auto` may refuse a tool request. Raising what a third-party
  command may approve for itself also falls outside the grant and must ask.

If the export file was not created on a preflight refusal, write the complete
visible refusal verbatim to its private output path before `finish-cli`. Preserve
the refused attempt as `preflight-failed`, then set its `superseded_by` to a
later complete same-purpose, same-SHA retry. Every attempt has a distinct
capture and raw-output file; never overwrite an earlier checksum's evidence.
Use the same fresh-file rule for a permission-mode retry. Unknown failures are
`incomplete` and block the round. If authorized recovery returns nothing usable,
stop. A pasted or manually transcribed finding is not authenticated CLI evidence
and cannot complete the round.

## 3. Reconcile reports without dropping a source

Every app comment, app hidden placeholder and CLI-reported item gets its own
`source_reports` row. Similar app and CLI reports stay separate. When they
clearly describe one defect, put every directly equivalent report ID in each
row's reciprocal `same_as` array and let them point to one finding. One CLI
report may therefore recover the same hidden defect advertised by multiple app
retries. It cannot recover two hidden ordinals from one app review: those
placeholders represent distinct findings and need distinct recovery CLI reports.
Every multi-report finding must form one connected reciprocal group; when
equivalence is uncertain, keep two findings.

A hidden app placeholder can resolve only through a same-SHA recovery CLI
report. Until then the round is incomplete. Every source report must reach one
classified finding, and every finding must name every source report that points
to it.

Use this source truth table:

| GitHub app | CLI | Round result |
|---|---|---|
| clean | not run | clean |
| clean | clean | clean |
| clean | findings | findings |
| findings | clean | findings |
| findings | findings | findings |
| pending or incomplete | anything | incomplete; stop |
| anything | incomplete CLI that ran | incomplete; stop |
| different SHAs | anything | invalid; split the rounds |

CLI clean plus app findings is a findings round. Never relabel or delete an app
report because another source was clean.

## 4. Classify, map and apply the complete round

Assign every finding exactly one disposition from
[references/dispositions.md](references/dispositions.md): `fixed`,
`design-intentional`, `deferred`, `positive-flag`, or `out-of-scope`. Preserve
the disposition-specific evidence fields shown in
[references/templates.md](references/templates.md).

For each fixed finding, record the changed behavior, every caller and schema
reader, affected persisted shapes, paired files, tests, fixtures, examples,
manifests and documentation. Use
[references/paired-files.md](references/paired-files.md), read relevant files in
full, and complete `dependency_audit` and `paired_file_audit` before editing.

Fix the complete set once. Sweep the repository with
[references/review-patterns.md](references/review-patterns.md), then record every
verification command and result.

Before creating a response commit, validate the complete review evidence while
the response fields are still null:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pre-push-check.js" \
  --phase pre-commit "/path/to/round.json"
```

Do not commit if this fails.

## 5. Finalize and ship the response

Keep these states separate:

- `round answered`: every finding on `review_head_sha` is classified and the
  response is verified;
- `response current remotely`: the recorded response commit is pushed, or a
  no-change response still names the current remote head; and
- `PR head clean`: the app has posted a complete clean review for that response
  SHA and any same-SHA CLI result is reconciled.

Choose exactly one response mode:

- `no-change`: required when no finding has disposition `fixed`; set
  `response_head_sha` equal to `review_head_sha`. Repository HEAD must still be
  that commit and the worktree/index must be clean.
- `commit`: use only when at least one finding is `fixed`. The response must be
  one non-merge atomic commit whose only parent is `review_head_sha`. Its changed
  paths must exactly equal the union of the fixed findings' `changed_files`.

For `commit` mode, show the complete disposition table and files changed, then
ask the user for explicit approval before `git add` or `git commit`. Stop until
they approve. After approval, stage only the response files, create the commit
without bypassing repository hooks, set `response_head_sha` to that commit and
confirm the worktree/index is clean. For `no-change` mode, set the response
fields as described above without creating a commit.

Run the final gate immediately before push, or before declaring a no-change
response complete:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pre-push-check.js" \
  --phase pre-push --repo-root "/path/to/repository" "/path/to/round.json"
```

The gate uses read-only `gh pr view` before and after it re-fetches the app
reviews and comments twice, then rechecks the local HEAD, branch and status. The
PR must keep pointing at `review_head_sha` from the recorded `branch` and
`head_repository`; the configured `push_remote` must resolve to that head
repository. The same-SHA Devin activity must match the saved capture. If another
actor changes the PR identity, the local checkout, or Devin activity after
capture, recapture and reconcile instead of calling this round current.

Use the commit format in [references/templates.md](references/templates.md).
After the final gate passes, push commit mode only when the user asked and the
active GitHub account and destination are confirmed. Use the argv-based helper
below. It reruns the complete final gate immediately before invoking Git, checks
every configured push URL, pushes the recorded response SHA rather than a moving
local ref, and requires the remote branch to still equal `review_head_sha`. Each
URL must name the same head repository; the first validated URL becomes the
actual Git destination so the one-time lease is not replayed when a remote lists
equivalent URLs. A concurrent remote-config change therefore cannot redirect the
push. The helper passes the PR-controlled branch as one argument instead of
putting it in shell syntax:

<!-- bash-approval-required -->
```bash
/usr/bin/env node "${CLAUDE_PLUGIN_ROOT}/scripts/push-review-response.js" \
  --repo-root "/path/to/repository" --round "{scratch}/round.json"
```

This invocation deliberately begins outside the `node` grant so the actual push
requires approval. Do not invoke the helper through the granted `node` prefix.
No-change mode is already current remotely and does not run the helper.

For both modes, write the complete disposition table from
[references/templates.md](references/templates.md) to
`{scratch}/pr-response.md`. In commit mode, wait until the response commit is
pushed and visible on the PR. Show the exact response and ask for explicit
approval for the GitHub write. This is a separate approval from the local
commit or push. After approval and immediately before posting, re-read the live
head:

```bash
gh pr view 123 --repo github.com/owner/repository --json headRefOid
```

Require `headRefOid` to equal the round's recorded `response_head_sha`. If it
does not, do not post; the response is stale and the newer head needs its own
review round. When it still matches, post the file without putting review text
on the command line:

<!-- bash-approval-required -->
```bash
gh pr comment 123 --repo github.com/owner/repository --body-file "{scratch}/pr-response.md"
```

Do not declare the workflow complete until the disposition response is posted.
If posting is not approved, say the local or remote response state precisely and
leave the round awaiting its PR response.

A just-pushed response is not app-clean yet. Say the next review is pending.
When the app reviews `response_head_sha`, start a new round for that SHA. Do not
fold later findings into the earlier round.

## Hard stops

Stop rather than claiming success when:

- the app capture is missing, incomplete, or omits a same-SHA retry or comment;
- a known CLI execution is absent, incomplete, dirty, or for another SHA;
- a preflight refusal lacks a later valid `superseded_by` retry;
- authorized hidden-finding recovery produced no usable CLI evidence;
- a hidden app placeholder has no recovery report;
- two hidden ordinals in one app review reuse one recovery report;
- two reports from one app review collapse into the same finding;
- a run count, report row, finding reference, disposition, audit or verification
  is missing or inconsistent;
- sources within one round do not share the same `review_head_sha`;
- either final response mode is dirty or does not match repository HEAD;
- the live PR branch, head repository or any configured push URL differs from
  the recorded destination;
- commit mode is not one non-merge direct child of the reviewed commit; or
- a source result for an earlier commit is being used to call the newer PR head
  clean.
