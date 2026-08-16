---
name: core-tools
description: Pick which connected tools to watch, so the status line warns when one needs signing in again. Reads the servers actually connected on this machine and lets the user choose. Use when the user says "core tools", "which of my tools are connected", "watch my MCP servers", "tell me when Notion drops", "is my Slack still connected", or invokes /core-tools.
allowed-tools: Read, Write, Edit, Bash(node:*)
---

# Core tools

An expired connection is silent. A tool that needs signing in again behaves
exactly like a tool with nothing to report, so you find out when something you
asked for quietly did not happen.

This puts a count in the status line and names anything that needs attention.

---

## Step 1: Show what is actually connected

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js mcp-servers
```

Never present a list from memory or from a previous session. This asks the
machine, and connection status is exactly the thing that changes without
telling anyone.

---

## Step 2: Ask which ones matter

Not all of them. The point is a short list of tools whose failure would
actually derail work, because a status line showing seventeen servers is a
status line nobody reads.

Ask concretely:

> Which of these would you want to know about the moment it stops working?

Three to six is the useful range. Take what they pick.

---

## Step 3: Write the config

Show the draft and wait for a yes before writing. Config goes to
`~/.claude/session.config.json`:

```json
{
  "coreTools": [
    { "label": "Email", "match": "Gmail" },
    { "label": "Calendar", "match": "Google Calendar" },
    { "label": "Notion", "match": "Notion" }
  ]
}
```

`match` is matched case-insensitively as a substring of the server name, so it
survives the provider prefix changing. `label` is what appears in the status
line, so use the word they actually call the thing.

Pick a `match` that is unambiguous. If two connected servers both contain the
string, the first one wins and the other is invisible. Check the list from Step
1 before writing, not after.

Merge into the existing file if there is one. Do not overwrite it.

---

## Step 4: Build the first cache and show the result

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js mcp-refresh
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js mcp-status
```

Show what came back. If anything is `needs_auth`, say which and that signing in
again fixes it. If anything is `missing`, the `match` string matches no server,
which is a config problem rather than an outage, so fix the string.

After this the refresh runs by itself in the background at session start, and
the status line reads the cache. It never probes while rendering, because
checking every server takes seconds and a status line has to be free.

## Step 5: Offer persistent monitoring

If they want to be notified without watching the status line, offer a Claude
Desktop scheduled task that runs `/core-tools-monitor` hourly. Desktop tasks
run locally without an open Claude session, so the probe can reach the same MCP
configuration and local incident state.

The monitor alerts once when a tool drops, stays silent while the same failure
continues, updates the same incident if the affected set changes, and alerts
once when everything recovers. Its source id is `session:core-tools`.

---

## Reading the segment

```
Core tools 4/5 (Notion needs sign-in)
```

| What you see | What it means |
|---|---|
| Nothing at all | No tools configured, or no cache built yet |
| `5/5` green | Everything answered |
| `needs sign-in` | Authentication expired. Sign in again |
| `unreachable` | The server answered badly or not at all. Not an auth problem, do not send them to sign in |
| `not found, check the name` | The `match` string matches no connected server. A config problem, usually a rename or a typo. Nothing is down |
| `· 3h old` | The cache is stale. The count was true three hours ago and may not be now |

---

## Notes

**The count is as fresh as the cache, never fresher.** That is why age is shown
once it gets old. A count with no age is a claim about a moment you cannot see.

**No cache shows nothing rather than zero.** Before the first refresh completes,
`0/5` would read as five broken tools, which would be alarming and invented.

**The status line tells you when you look.** `/core-tools-monitor` is the
transition-only probe for a persistent Claude Desktop scheduled task.
