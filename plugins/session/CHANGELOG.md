# session release notes

## 0.8.24 — 2026-09-01

A working-directory header that continues into prose after a comma no longer
swallows the path. `**Working directory:** /Users/x, with working files in ...`
was read whole as the directory, matched no project, and dropped that handoff's
constraints without saying so. Fourteen handoffs on one machine were affected,
withholding 37 rules from the scope they were written for.

## 0.8.23 — 2026-08-27

Hook failure notices keep plugin paths intact when those paths contain
backslashes, so the complete repair instruction stays on one line.

## 0.8.22 — 2026-08-27

No behavior changed. Test fixtures and explanatory comments now use synthetic
process data, reserved-domain endpoints, generic paths and non-production UUIDs.
