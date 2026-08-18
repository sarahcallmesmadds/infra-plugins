---
name: find-skill
type: human
description: Skill discovery — tells you which skill to use for what you're trying to do. Invoke when you're not sure which command to reach for. Builds the routing table at runtime by reading every SKILL.md frontmatter, so newly-installed skills auto-appear.
allowed-tools: Read, Write, Bash(node:*), Bash(python3:*)
---

# /find-skill — skill discovery

You are a skill router. The user has many installed skills and can't always remember which one fits what they are trying to do. Your job is to read what they want to accomplish, scan the installed-skills index at runtime, and point them to the best fit with a one-line explanation of why.

The scan only sees what is installed on this machine. Skills that live on another device, or in a repository that has not been installed here, will not appear, and must not be invented. If someone asks for something you cannot see, say it is not installed here rather than guessing at a name.

---

## When invoked

The user will say something like:
- `/find-skill "I want to pull context on an account before a call"`
- `/find-skill "how do I start a personal project"`
- `/find-skill what skill should I use to end a session`
- `find-skill — I want to log a contract renewal`

The argument after `find-skill` (or `$ARGUMENTS`) is the intent. If empty, list the full installed-skills inventory grouped by category and ask the user what they are trying to do.

---

## Step 1 — Build the index at runtime

Scan the configured roots, the same set the rest of this plugin uses. The block
below asks `roots.js` for them rather than reading the config itself, so the
defaults, the pre-v2 `skillRoots` shape and the `~` expansion are decided in one
place for every skill here.

**Roots of kind `skill` and kind `plugin-repo` are scanned here.** Both hold
skills, in different layouts. A hook or command root is not scanned: it holds
executable files with no frontmatter to read, and the bug queue covers those
while routing does not.

Check those roots exist before scanning them, and scope the check the same way.
`--kind` takes one value, so this is two calls:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/roots.js" check --kind skill
node "${CLAUDE_PLUGIN_ROOT}/scripts/roots.js" check --kind plugin-repo
```

Scoping matters here. An unscoped check answers about hook and command roots
too, and this skill never looks in those, so it would warn about a missing
hooks directory to someone who asked which skill to use.

Read the two together, because either kind of root is somewhere to scan:

- Exit 0 from either, carry on. There is somewhere to look.
- Exit 3 from either, a root someone configured is gone. Say so before routing.
- Exit 5, a default location is absent. Nobody configured that path, so do not
  frame it as something having gone missing. Carry on.
- Exit 4 from **both**, there is nowhere to read at all. Say that the inventory
  is empty because there is nowhere to look, not because nothing is installed,
  and stop. On a machine with no config file this is what an absent default
  skills directory produces, and it is not a fault: nobody chose that path
  either, so describe it as nothing being configured rather than as something
  having gone. Exit 4 from only one of the two is ordinary and says nothing: a
  machine that keeps its skills in a plugin checkout has no root of kind
  `skill`, and one that keeps them loose has no `plugin-repo`.
- Exit 1, the config could not be read. Relay what it said and stop.

Every one of those messages arrives on stdout, including exit 1.

This skill's whole promise is that what it lists is what is installed, so a root
that cannot be read makes it report an empty inventory in the same words it
would use for a machine with nothing installed. Those are different answers and
the difference is the thing worth saying. Never invent a skill to fill the gap.

The layout to scan depends on the root's kind. For a root of kind `skill`, scan
both `<root.path>/*/SKILL.md` and `<root.path>/*/*/SKILL.md`, so a repository
that nests the definition one level deeper is still found. For a root of kind
`plugin-repo`, scan `<root.path>/plugins/*/skills/*/SKILL.md`, which is where a
plugin checkout keeps them, one level deeper again. `flag-issue` resolves
targets in a plugin-repo the same way. Routing to a skill that exists but sits
in a second root is the whole reason the config has more than one entry.

For each file, extract from the YAML frontmatter:

- `name` — the skill name (matches the directory)
- `description` — the one-liner describing when to use it
- `type` — `human` (user-invoked) vs `agent` (called by other skills) — use to filter

Use this Bash + Python one-liner to load all frontmatter cleanly:

```bash
python3 - "${CLAUDE_PLUGIN_ROOT}/scripts/roots.js" <<'PY'
import os, re, glob, json, subprocess, sys

# The roots come from roots.js, not from a second reader written here. This
# block used to open build-loop.config.json itself and carry its own copy of the
# default root, which made it the sixth place in this plugin that decided what
# the defaults are. The others have stopped; the duplicate that mattered most
# was this one, because it was code rather than prose and so could disagree
# without anyone reading a difference.
#
# Every path it returns is already absolute, so nothing below expands `~`. A
# literal `~` was the failure that produced the tilde warning at the top of this
# file, and it cannot happen to these.
#
# Failure is not caught. A config that exists and cannot be used is roots.js's
# to refuse, and it already has above. Catching it here meant a corrupt config
# was reported by the check and then quietly ignored one step later, so routing
# went ahead against the default path and looked like it had worked.
ROOTS_JS = sys.argv[1]
CONFIG_UNREADABLE = 1  # the only roots.js code that prints a sentence, not JSON


def stop(message):
    # stdout, then a non-zero exit. Not `raise SystemExit(message)`, which writes
    # to stderr: this skill tells its reader that every message arrives on
    # stdout, and roots.js says in its own source why it prints there rather
    # than to stderr. Raising here put the one case that matters, the config
    # being unreadable, somewhere the relay does not look, which is the same
    # bug one level down.
    print(message)
    sys.exit(1)


# One unscoped call, and the scope is applied here rather than by --kind. Two
# scoped calls returned skill roots and plugin-repo roots as two lists, which
# silently reordered them: config order became skill-roots-then-plugin-repos,
# so for a file reachable through both the winning root label changed. Nothing
# below needs the exit code to be scoped, because whether there is anywhere to
# look is decided from the `exists` flags of the roots actually scanned.
run = subprocess.run(["node", ROOTS_JS, "list"], capture_output=True, text=True)
if run.returncode == CONFIG_UNREADABLE:
    stop(run.stdout.strip() or run.stderr.strip() or "roots.js list failed and said nothing.")
try:
    listed = json.loads(run.stdout)["roots"]
except (ValueError, KeyError):
    # A traceback here would be this block's own bug reported as the user's.
    stop(
        "roots.js list did not return the roots. It said:\n"
        + (run.stdout.strip() or run.stderr.strip() or "(nothing)")
    )

# Skill roots and plugin-repo roots both hold SKILL.md files, in different
# layouts. A hook root would yield nothing and a command root would yield files
# whose frontmatter means something different, so neither is scanned.
PATTERNS = {
    # <root>/<skill>/SKILL.md and <root>/<skill>/skill/SKILL.md
    "skill": ("*/SKILL.md", "*/*/SKILL.md"),
    # <root>/plugins/<plugin>/skills/<skill>/SKILL.md
    "plugin-repo": ("plugins/*/skills/*/SKILL.md",),
}
roots = [r for r in listed if r.get("kind", "skill") in PATTERNS]

# Decided from the roots this skill scans, not from an exit code covering hook
# and command roots it never looks at. An empty inventory reads as "nothing is
# installed" when what happened is that there was nowhere to look, and those are
# different answers.
if not any(r.get("exists") for r in roots):
    stop(
        "No skill or plugin-repo root exists to scan, so there is nothing to route "
        "from. This is not the same as having no skills installed. Run "
        "`roots.js check` to see which paths were expected."
    )

# A root in scope that is not on disk is skipped below, and skipping it quietly
# is how a partial inventory reads as a complete one. The preflight check above
# reports it, but this block prints the answer, so it says so here too rather
# than relying on the reader having joined the two.
absent = [r for r in roots if not r.get("exists")]
if absent:
    print(
        "Incomplete: skipped "
        + ", ".join(f"{r['name']} ({r['path']})" for r in absent)
        + ", which are configured but not on disk. The inventory below is what "
        "the remaining roots hold, not everything installed."
    )

seen, skills = set(), []
for root in roots:
    base = root["path"]
    for pattern in PATTERNS[root.get("kind", "skill")]:
        for path in sorted(glob.glob(os.path.join(base, pattern))):
            if path in seen:
                continue
            seen.add(path)
            with open(path) as f:
                text = f.read()
            m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
            if not m:
                continue
            # Folded and block scalars matter here: a description written as
            # "description: >" with the text indented underneath would
            # otherwise be read as empty, and description is what routing
            # matches on. Indented lines continue the key above them.
            fm, key = {}, None
            for line in m.group(1).splitlines():
                if line[:1] in (" ", "\t") and key:
                    fm[key] = (fm[key] + " " + line.strip()).strip()
                elif ":" in line and not line.startswith(" "):
                    k, _, v = line.partition(":")
                    key = k.strip()
                    v = v.strip()
                    fm[key] = "" if v in (">", "|", ">-", "|-") else v.strip('"').strip("'")
            # In a skill root the name is the first directory below the root, so
            # the nested layout does not report every skill as "skill". In a
            # plugin-repo the first directory is always "plugins", so the name is
            # the directory holding the file instead.
            rel = (os.path.basename(os.path.dirname(path))
                   if root.get("kind", "skill") == "plugin-repo"
                   else os.path.relpath(path, base).split(os.sep)[0])
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
- **Session management** — `wrap`, `pickup`, `find-skill`, anything with "handoff", "resume", "wrap up", "skill discovery"
- **Build loop (meta)** — `flag-issue`, `list-bugs`, `apply-fix`, `verify-fix`, `audit-deps`, `flag-patterns`, `to-build`, `built-check`, `find-skill`, anything with "build loop", "queue", "correction", "to-build", "DEPS.json" in description
- **Other** — anything that doesn't fit above

If a skill spans two categories, pick the dominant one. If a skill is brand new and you can't classify it, put it under **Other** — that's also a signal the description could be sharper.

---

## Step 4 — Response format

For a single best-fit match:

```
For [what they want to do], use:

**`/skill-name`** - [one sentence on why this is the right one]

[If there's a close second worth knowing about:]
Also consider: **`/other-skill`** - [when you'd use this instead]
```

For an empty `$ARGUMENTS` (full inventory listing):

```
Installed skills on this device. What are you trying to do?

### Daily / personal HQ
- **`/skill-name`** - [first sentence of description]
- ...

### Personal projects + IP
- ...

### Session management
- ...

### Build loop (meta)
- ...

### Other
- ...
```

If nothing matches well, say so honestly:

```
Nothing in your installed skills matches that closely. Closest options:
- **`/foo`** - [why it's close]
- **`/bar`** - [why it's close]

Want me to just help directly without a skill?
```

---

## Rules

- **Always scan at runtime.** Don't cache. The whole point of this skill is that new skills auto-appear — caching defeats it.
- **Filter out `type: agent` skills** from user-facing suggestions. They aren't directly invokable for general purposes.
- **Don't invent skills that aren't installed.** If what someone wants lives on another machine, or in a repository that is not installed here, say so explicitly rather than fabricating a route to it.
- **Pick ONE primary match.** Don't dump 5 options. The user can ask follow-up if your pick is wrong.
- **Categorization is a heuristic.** If a skill is hard to categorize, put it under Other — that's a signal the skill's description should be sharpened.
