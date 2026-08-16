---
name: core-tools-monitor
description: Run the transition-only core-tools health probe used by a Claude Desktop scheduled task. Alerts once when a configured tool drops, stays silent while the same failure continues, and reports once when it recovers. Use when the user asks to run, test, or schedule the core-tools monitor.
allowed-tools: Read, Write, Bash(node:*)
---

# Core tools monitor

Run the local health probe:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js mcp-probe
```

If the command prints a line, return that line verbatim. It is either a new or
changed incident, or a recovery. Do not add diagnosis from memory.

If the command prints nothing, return no user-facing message. Healthy repeated
runs and an unchanged open incident are deliberately silent. An empty watch
list is not healthy: the command tells the user to run `/core-tools` first.

The probe owns one incident at
`~/.cache/session/core-tools-incident.json`, with source id
`session:core-tools`. It updates that record while the affected tools change
and marks it resolved on recovery, so scheduled runs never stack duplicates.

For durable scheduling, create a Claude Desktop scheduled task that runs this
skill hourly. Do not use `/loop`: it stops with the current session and expires
after seven days.
