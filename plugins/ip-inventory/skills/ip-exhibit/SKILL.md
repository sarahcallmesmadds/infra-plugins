---
name: ip-exhibit
type: human
description: Turns the IP inventory into an exhibit, the schedule of prior intellectual property attached to an employment agreement so an invention-assignment clause cannot claim it. Lists every entry that cannot carry weight yet and why, then renders the works that can. Excludes third-party services. Use when the user asks "generate the exhibit", "what can go on my IP exhibit", "which entries have gaps", "prior inventions list", or explicitly invokes /ip-exhibit. Produces a draft for a lawyer to review; it is not legal advice.
argument-hint: "[optional output path, e.g. ~/exhibit-a.md]"
allowed-tools: Read, Bash(node:*)
---

# ip-exhibit

An exhibit is the list you attach to an employment agreement naming the
intellectual property you already owned when you signed. Work on that list is
carved out of the invention-assignment clause. Work left off it is much harder
to claim later.

That is what the inventory is for, and it is why this command leads with what is
missing rather than with what is ready.

## Run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" exhibit
```

To write it to a file rather than print it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" exhibit --out ~/exhibit-a.md
```

## Read the result

The first line is `gaps: N of M`. Branch on that.

**Lead with the gap report, always.** It names every entry that cannot go on the
list and what each one needs, which is almost always a date, a statement of why
the work is theirs rather than an employer's, or both. That list is a worklist,
not a warning, and it is the more useful half of the output. Present it as work
to do.

**Then the works.** Grouped by category, oldest first, each with its date, its
evidence and the basis on which it is claimed.

## Say this every time

The output carries the line itself, and it should survive into whatever you say
back: **this is a draft for a lawyer to review, and it is not legal advice.**
The wording of a carve-out matters, and an entry that overstates what it can
prove is worse than one left off.

## What it excludes, and why that is deliberate

Third-party services are excluded. An MCP server the user connects to is somebody
else's software, and listing it as prior IP would undermine the entries that are
sound.

Components are excluded too. A script inside a plugin is covered by the plugin
being listed; naming it separately pads the schedule without adding a claim.

## What it will not do

It does not write to the inventory, and it does not decide what is defensible.
An entry with a date and a stated basis is *listable*, which is not the same as
*correct*, and only the user knows how a given piece of work actually came about.
