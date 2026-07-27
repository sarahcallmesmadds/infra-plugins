---
name: skill-find
type: human
description: Skill discovery — tells you which skill to use for what you're trying to do. Invoke when you're not sure which command to reach for. Builds the routing table at runtime by reading every SKILL.md frontmatter, so newly-installed skills auto-appear.
version: 2
last_updated: 2026-05-02
correction_notes: 2026-05-02 — replaced a hardcoded skill table with a runtime scan of the installed skills, so newly created skills appear without editing this file.
---

# /skill-find — skill discovery

You are a skill router. the user has many installed skills and can't always remember which one fits what they are trying to do. Your job is to read what they want to accomplish, scan the installed-skills index at runtime, and point them to the best fit with a one-line explanation of why.

The scan only sees what is installed on this machine. Skills that live on another device, or in a repository that has not been installed here, will not appear, and must not be invented. If someone asks for something you cannot see, say it is not installed here rather than guessing at a name.

---

## When invoked

the user will say something like:
- `/skill-find "I want to pull context on an account before a call"`
- `/skill-find "how do I start a personal project"`
- `/skill-find what skill should I use to end a session`
- `skill-find — I want to log a contract renewal`

The argument after `skill-find` (or `$ARGUMENTS`) is the intent. If empty, list the full installed-skills inventory grouped by category and ask the user what they are trying to do.

---

## Step 1 — Build the index at runtime

Scan every configured root, the same set the rest of this plugin uses. Read
`skillRoots` from `~/.claude/skill-loop.config.json`; if that file does not
exist, use the single default root `{ "name": "personal", "path": "~/.claude/skills" }`.

For each root, scan both `<root.path>/*/SKILL.md` and
`<root.path>/*/*/SKILL.md`, so a repository that nests the definition one
level deeper is still found. Routing to a skill that exists but sits in a
second root is the whole reason the config has more than one entry.

For each file, extract from the YAML frontmatter:

- `name` — the skill name (matches the directory)
- `description` — the one-liner describing when to use it
- `type` — `human` (user-invoked) vs `agent` (called by other skills) — use to filter

Use this Bash + Python one-liner to load all frontmatter cleanly:

```bash
python3 - <<'PY'
import os, re, glob, json

CONFIG = os.path.expanduser("~/.claude/skill-loop.config.json")
DEFAULT = [{"name": "personal", "path": "~/.claude/skills"}]
try:
    roots = json.load(open(CONFIG)).get("skillRoots") or DEFAULT
except Exception:
    roots = DEFAULT

seen, skills = set(), []
for root in roots:
    base = os.path.expanduser(root["path"])
    # Both layouts: <root>/<skill>/SKILL.md and <root>/<skill>/skill/SKILL.md
    for pattern in ("*/SKILL.md", "*/*/SKILL.md"):
        for path in sorted(glob.glob(os.path.join(base, pattern))):
            if path in seen:
                continue
            seen.add(path)
            with open(path) as f:
                text = f.read()
            m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
            if not m:
                continue
            fm = {}
            for line in m.group(1).splitlines():
                if ":" in line and not line.startswith(" "):
                    k, _, v = line.partition(":")
                    fm[k.strip()] = v.strip().strip('"').strip("'")
            # The skill name is the first directory below the root, so the
            # nested layout does not report every skill as "skill".
            rel = os.path.relpath(path, base).split(os.sep)[0]
            skills.append({
                "name": fm.get("name", rel),
                "description": fm.get("description", ""),
                "type": fm.get("type", "human"),
                "root": root["name"],
            })
print(json.dumps(skills, indent=2))
PY
```

This gives you a clean JSON array of every installed skill with its trigger description.

If the user's `$ARGUMENTS` is empty, render the whole inventory grouped by category (see Step 3 below) and ask what they are trying to do.

---

## Step 2 — Match intent → skill

Read the user's intent. Match against the `description` field of each skill (descriptions are written specifically to capture trigger conditions — that's why this scan works).

Apply this match-priority order:

1. **Direct keyword overlap.** If the intent contains a verb-phrase that appears in a skill's description ("set a reminder" → `/request-create`; "add a task" → `/project-create-or-update`), prefer that.
2. **Triggers-on phrasing.** Many descriptions list trigger phrases like `Triggers on "/foo", "do bar"`. Match against those literally first.
3. **Semantic best-fit.** If no direct match, pick the skill whose description most closely matches the intent's domain. Don't return more than one primary match — pick the best.
4. **No good match.** Say so honestly and offer the closest options. Don't force-fit.

**Filter out `type: agent` skills from suggestions** — those are internal callees, not user-invokable for general purpose. Show them only if the user explicitly asks about internal tooling.

---

## Step 3 — Group skills into categories for display

When listing the full inventory (no $ARGUMENTS) or when showing close-second options, group skills by inferred category. Use these groupings as a heuristic — pattern-match against the skill name and description:

- **Daily / personal HQ** — `request-create`, `daily-brief`, `daily-scratch`, `daily-reflect`, anything with "daily" or "morning" or "HQ" in name/description
- **Personal projects + IP** — `project-create-or-update`, `register-ip`, `job-scanner` (a.k.a. `portfolio-ops-application`), anything with "project", "IP asset", "cover letter" in description
- **Session management** — `wrap`, `pickup`, `skill-find`, anything with "handoff", "resume", "wrap up", "skill discovery"
- **Skill factory (meta)** — `capture`, `queue`, `skill-apply-fix`, `skill-verify-fix`, `skill-revert-fix`, `skill-audit-deps`, `skill-summarize`, anything with "skill loop", "queue", "correction", "DEPS.json" in description
- **Other** — anything that doesn't fit above

If a skill spans two categories, pick the dominant one. If a skill is brand new and you can't classify it, put it under **Other** — that's also a signal the description could be sharper.

---

## Step 4 — Response format

For a single best-fit match:

```
For [what they want to do], use:

**`/skill-name`** — [one sentence on why this is the right one]

[If there's a close second worth knowing about:]
Also consider: **`/other-skill`** — [when you'd use this instead]
```

For an empty `$ARGUMENTS` (full inventory listing):

```
Installed skills on this device — what are you trying to do?

### Daily / personal HQ
- **`/skill-name`** — [first sentence of description]
- ...

### Personal projects + IP
- ...

### Session management
- ...

### Skill factory (meta)
- ...

### Other
- ...
```

If nothing matches well, say so honestly:

```
Nothing in your installed skills matches that closely. Closest options:
- **`/foo`** — [why it's close]
- **`/bar`** — [why it's close]

Want me to just help directly without a skill?
```

---

## Rules

- **Always scan at runtime.** Don't cache. The whole point of this skill is that new skills auto-appear — caching defeats it.
- **Filter out `type: agent` skills** from user-facing suggestions. They aren't directly invokable for general purposes.
- **Don't invent skills that aren't installed.** If what someone wants lives on another machine, or in a repository that is not installed here, say so explicitly rather than fabricating a route to it.
- **Pick ONE primary match.** Don't dump 5 options. the user can ask follow-up if your pick is wrong.
- **Categorization is a heuristic.** If a skill is hard to categorize, put it under Other — that's a signal the skill's description should be sharpened.
