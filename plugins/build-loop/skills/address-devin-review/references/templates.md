# Round output templates

## Disposition table

```markdown
| Finding | Severity | Location | Disposition | Evidence |
|---|---|---|---|---|
| FINDING-1 | high | path:line | fixed | commit SHA |
```

## Commit

```text
fix(scope): address Devin review round N

Devin round N for PR #123.

Fixed:
- FINDING-1 (path:line): summary

Design-intentional:
- FINDING-2 (path:line): decision citation

Deferred:
- FINDING-3 (path:line): TRACKER-123

Out of scope:
- FINDING-4 (path:line): predates base; TRACKER-456

Paired-file audit:
- path <-> paired/path: checked, no drift

Verification:
- command: passed
```

Omit empty disposition sections. Mention every finding ID. Keep one commit per review round.
## PR response

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
