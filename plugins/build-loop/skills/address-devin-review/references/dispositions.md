# Finding dispositions

Every finding gets exactly one disposition.

| Disposition | Use when | Required evidence |
|---|---|---|
| `fixed` | The finding is correct and belongs in this round. | Summary of the change, dependency audit, paired-file audit, changed files, and closing commit once known. |
| `design-intentional` | The flagged behavior is deliberate and authorized. | The decision, invariant, or source-of-truth citation made durable in code or docs. |
| `deferred` | The finding is valid but cannot responsibly land in this round. | A concrete issue, requirement, or queue ID plus the reason deferral is safer. |
| `positive-flag` | Devin identified something worth preserving rather than a defect. | A short statement of the behavior to preserve. |
| `out-of-scope` | The issue predates the PR or belongs to unrelated work. | Base-branch or blame evidence and a concrete place where follow-up is tracked. |

Use the lower-confidence disposition when evidence is mixed. `Design-intentional` is not shorthand for disagreement, `deferred` is not an unowned TODO, and `out-of-scope` does not mean inconvenient.
