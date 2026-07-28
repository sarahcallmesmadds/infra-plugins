# Fermat export: what is worth rebuilding into `plugins`

Source: `fermat-claude-agents-skills-2026-07-28 (1).zip`, exported 14:53 on 2026-07-28. 88 files:
3 agents, 6 hooks, 66 skill files across 17 skills, 9 personas, 4 team files. The zip lists 112
entries; the other 24 are directories.
Compared against: `sarahcallmesmadds/plugins` (6 shipped), `skills` (canonical), `rebuild-specs`, `gtm-plugins-archive`.

Dependency calls below are from grepping each skill for the systems it names, then checking
whether that system is reachable from this machine.

---

## 1. Rebuild now, nothing blocking

| Item | Kind | Why it ports cleanly |
|---|---|---|
| `problem-log` | skill | Reads local Claude Code sessions and writes one markdown entry per problem-solving arc. Its SKILL.md names no company system at all. The Salesforce and Saber hits in that folder are inside `session-digest.txt`, which is sample output, not instructions. 7 files. |
| `skill-md-check.js` | hook | PostToolUse on Write/Edit. Validates that a SKILL.md has proper YAML frontmatter. You author SKILL.md files constantly and `plugins` has no equivalent check. 72 lines. |
| `skill-router.js` | hook | UserPromptSubmit. Routes a prompt to the right skill. Generic, no company wiring. 184 lines. |
| `skill-resource-guard.js` | hook | PreToolUse guard. Shipped as `.bak-2026-06-12`, so it was switched off deliberately. Worth reading before reviving. 202 lines. |
| `revops-release` | skill | Notion plus Slack only. Both connected. Rename away from "RevOps" and it is generic release notes. |
| `log-plugin` | skill | Notion only. Overlaps `ip-inventory` and `register-ip`, so fold it in rather than shipping a third thing that writes plugin rows to Notion. |

`SKILL-GOVERNANCE.md` and `hooks/README.md` document how the three hooks work together. Read them
first; they are the design notes for the whole set.

---

## 2. Rebuild, but each needs one credential

| Item | Kind | Blocker |
|---|---|---|
| `sfdc-fix-this` | skill, 13 files | Needs the `sf` CLI and a Salesforce org. Neither is on this machine. |
| `tool-eval` | skill | Gmail, Granola, Slack, Notion all connected. Ramp is not. |
| `tool-renewal` | skill | Same as above. |

**`sfdc-fix-this` is the most substantial engineering in the export.** It takes a Slack permalink or
a record ID, traces the report to its origin, reads the record and its neighbours read-only,
retrieves Flow metadata to find the actual cause instead of guessing, classifies findings into
FIXED / DESIGN-INTENTIONAL / DEFERRED / POSITIVE FLAG / OUT-OF-SCOPE, then applies an ordered repair
behind a single confirm with a before-state snapshot for rollback. It also sweeps the rest of the
object read-only to report which other records carry the same defect.

That is the SFDC skill you were reaching for earlier in the session. It is already built. It needs
an org to point at, not a rewrite.

---

## 3. Rebuild the method, not the code

| Item | Portable | Not portable |
|---|---|---|
| `devin-persona` | The 23-pattern catalog mined from 453 historical findings | `fermatcommerce/gtm`, the bot integration |
| `devin-fixer` / `smadds-warden` | The 5-step protocol, the DISPOSITIONS taxonomy, one atomic commit per round | The paired-files map, which is gtm-specific |
| `apply-devin-fix` | PROTOCOL.md, DISPOSITIONS.md, COMMIT-TEMPLATE.md, PR-BODY-TEMPLATE.md | 32 files and 544K of gtm wiring, `fetch-devin-findings.sh` |

**`devin-fixer` and `smadds-warden` are near-duplicates.** 61 differing lines across roughly 360.
Same description word for word. Pick one and delete the other before either goes anywhere.

The pattern catalog is the real asset here. It is 453 real review findings compressed into 23
patterns, and it cost a year of Devin runs to produce. That survives losing the repo. Your memory
already records that a clean Devin pass is your definition of done and that a persona-review skill
exists to cut what that costs; `plugins` has no such skill today.

---

## 4. Dead without access, do not rebuild

| Item | Missing |
|---|---|
| `saber-build-account-list`, `saber-build-contact-list`, `saber-create-company-signals`, `saber-create-contact-signals`, `saber-signal-discovery` | Saber CLI. You have already said skip. |
| `adp` | Saber, Lusha, Glyphic, Fermat Platform, BigQuery |
| `cx-agenda` | Fermat Platform, BigQuery, Glyphic |
| `doit` | The HQ Requests queue and its Notion schema contract |

`adp`, `cx-agenda` and `doit` are large and well-built, so they are worth keeping as reference in
`fermat-work-index` even though none of them can run.

---

## 5. Already rebuilt, skip

| Export item | Where it lives now |
|---|---|
| `to-build` | `build-loop:to-build` |
| `daily-scratch` | `sarahcallmesmadds/skills` |

---

## Suggested order

1. **The three hooks.** Smallest, generic, and they improve the plugin work itself rather than
   sitting downstream of it. `skill-md-check` pays for itself the first time it catches bad
   frontmatter.
2. **`problem-log`.** Zero blockers and nothing in `plugins` covers it. `build-loop` captures what
   broke; this captures how you solved things, which is a different record.
3. **`sfdc-fix-this`.** Highest value, and the port is mostly pointing it at a new org.
4. **The Devin persona-review skill.** Rebuild from the pattern catalog, not from the gtm wiring.

## Two things to check

- `skill-resource-guard.js` ships as a `.bak`. Something about it was wrong on 2026-06-12. Find out
  what before reviving it.
- `hooks/post-skill-log.js` calls itself "Wave 1 minimal version" and writes to Fermat's Notion.
  Same idea as `log-plugin`. Decide which of the two survives.
