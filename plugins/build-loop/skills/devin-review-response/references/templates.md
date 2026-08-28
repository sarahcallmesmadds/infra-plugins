# Round output templates

The canonical pre-commit record is
[`round-record.example.json`](round-record.example.json). It shows an app review
whose hidden finding is recovered by a second CLI run after a recognized
preflight refusal. All examples are synthetic.

`repository` is the pull request's base repository. `head_repository` is the
repository that owns its head branch, which can be a fork. `push_remote` is the
local remote whose every configured push URL names that head repository; the
final gate verifies all three before the workflow can push or answer the PR.

## No-CLI round

Use `not-needed` only when the app exposed every reported finding and no other
proactive CLI run is known for the reviewed commit.

```json
{
  "review_runs": [
    {
      "id": "GITHUB-APP-1",
      "source": "github_app",
      "purpose": "posted",
      "capture_id": "github-review-1",
      "report_ids": ["APP-REPORT-1"]
    }
  ],
  "cli_not_run_reason": "not-needed"
}
```

If any CLI run was attempted, set `cli_not_run_reason` to `null` and record each
attempt, including recognized preflight refusals and successful retries. Every
attempt uses its own capture and raw-output path so a retry cannot overwrite the
evidence covered by an earlier checksum.

Every source report has a `same_as` array. Leave it empty for a unique report.
For equivalent reports, list the directly equivalent report IDs reciprocally.
The array permits one recovered CLI report to link back to the same hidden
defect advertised by more than one app retry. If a finding names multiple
source reports, those reports must form one connected reciprocal group.
Reports within one app review are distinct findings and cannot be collapsed
together, even through a shared CLI report.

## Finding evidence

Every finding has both evidence fields. Use `null`, rather than omitting a
field, when that kind of evidence does not apply.

```json
[
  {
    "id": "FINDING-1",
    "disposition": "fixed",
    "tracking_id": null,
    "base_evidence": null
  },
  {
    "id": "FINDING-2",
    "disposition": "deferred",
    "tracking_id": "TRACKER-123",
    "base_evidence": null
  },
  {
    "id": "FINDING-3",
    "disposition": "out-of-scope",
    "tracking_id": null,
    "base_evidence": "Present in merge-base abc1234 before this change"
  }
]
```

`fixed`, `design-intentional`, and `positive-flag` findings use `null` for both
fields. `deferred` needs a nonblank `tracking_id`. `out-of-scope` needs nonblank
`base_evidence` tied to the reviewed base.

## Response state

Before the implementation commit, keep both response fields null:

```json
{
  "response_mode": null,
  "response_head_sha": null
}
```

For a verified response with no `fixed` findings:

```json
{
  "response_mode": "no-change",
  "response_head_sha": "0123456789abcdef0123456789abcdef01234567"
}
```

For one verified direct-child implementation commit with at least one `fixed`
finding:

```json
{
  "response_mode": "commit",
  "response_head_sha": "fedcba9876543210fedcba9876543210fedcba98"
}
```

## Disposition table

```markdown
| Finding | Severity | Location | Disposition | Evidence |
|---|---|---|---|---|
| FINDING-1 | high | path:line | fixed | commit SHA |
```

## Commit

```text
fix(scope): respond to Devin review round N

Devin round N for PR #123.

Fixed:
- FINDING-1 (path:line): summary

Design-intentional:
- FINDING-2 (path:line): decision citation

Deferred:
- FINDING-3 (path:line): TRACKER-123

Out of scope:
- FINDING-4 (path:line): predates base; merge-base evidence

Paired-file audit:
- path <-> paired/path: checked, no drift

Verification:
- command: passed
```

Omit empty disposition sections. Mention every finding ID. Keep one commit per
review round.

## PR response

Write this response to a private file, show it for approval, and post it with
`gh pr comment --body-file` only after the no-change response or pushed commit is
current remotely. Immediately before posting, re-read the live PR `headRefOid`
and require it to equal the round's `response_head_sha`.

```markdown
## Devin round N response

| Finding | Disposition | Closing commit or rationale |
|---|---|---|
| FINDING-1 | fixed | abc1234 |
| FINDING-2 | design-intentional | decision citation |

Paired-file audit:
- `path` ↔ `paired/path`: checked, no drift

Verification:
- `command`: passed
```
