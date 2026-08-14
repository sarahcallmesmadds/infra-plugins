---
name: status-bar
description: Set up the native Codex footer and task-progress title, or the richer Claude Code status line with model, folder, current task, spend, context, and connected-tool health. Use when the user says "set up the status bar", "install the status line", "show me my context usage", "show the current Codex task", "add the usage bar", or invokes /status-bar. Also use when a status line has stopped rendering or is showing an old version.
---

# Status bar

Set up the persistent terminal UI that answers "which model, which folder, how
full is the context, and what is this session doing". Codex and Claude Code
expose different status surfaces, so follow only the route for the runtime in
which this skill is running.

## Step 0: Identify the runtime

Do not guess from the plugin name. `CLAUDE_PLUGIN_ROOT` positively identifies
Claude Code. Otherwise use the host explicitly identified by the current
session context: a Codex skill invocation follows the Codex route, and a
Claude Code invocation follows the Claude route. If the host context is
genuinely ambiguous, ask the user before running any installer. Do not use the
existence of `/statusline` as detection—the command is the configuration action,
not an observable host signal. Never run the Claude installer from the Codex
route. `CODEX_HOME` may corroborate Codex when present, but is not required.

---

## Codex

Codex owns its footer natively. A plugin cannot add arbitrary custom segments,
but Codex can persist an ordered set of supported fields without editing config
by hand.

### Step 1: Configure the footer

Tell the user you are opening Codex's native picker, then ask them to type:

```text
/statusline
```

Recommend this compact order:

1. Model + reasoning
2. Context remaining
3. Git branch
4. Current directory or project root

If they have room, suggest rate limits next. Token counters, session ID and the
Codex version are available but usually less useful on every turn. The picker
updates the footer immediately and saves the selection to `tui.status_line` in
Codex's `config.toml`. The exact command and persistence behavior are recorded
in [the checked-in Codex surface note](references/codex-status-surfaces.md),
which links to the current official manual.

Do not edit `config.toml` when the picker is available. The picker knows the
field identifiers supported by the installed Codex version and avoids leaving
an obsolete identifier behind after an update.

### Step 2: Put task progress in the terminal title

Codex does not document task progress as a footer item. It does expose task
progress in the terminal title. Ask the user to type:

```text
/title
```

Recommend `Task progress`, with `Project` after it if they use several terminal
tabs. Explain the boundary plainly: this is Codex's native task-progress state,
not the text of a Claude task file, and it appears in the window or tab title
rather than consuming footer width.

### Step 3: Verify

Ask the user to confirm that the footer changed immediately and that the chosen
fields remain after starting a fresh Codex session. If the picker commands do
not exist, report that this Codex build does not expose the documented native
configuration yet; do not substitute the Claude installer or claim a plugin can
render a custom Codex footer.

Stop here in Codex. The remaining instructions are Claude Code only.

---

## Claude Code

## What it shows

```
Claude 4.8 │ my-project ⎇ owner │ ↳ Building the current task │ $0.42 · 30d $81.20 est ████░░░░░░ 41% │ Core tools 5/5
```

Every segment is optional and disappears rather than erroring when its data is
missing.

| Segment | Meaning |
|---|---|
| `Claude 4.8` | Model in use this session |
| `my-project` | Current folder, so you can see where a change will land |
| `⎇ owner` | GitHub owner from the git remote. Useful when pushing under more than one account |
| `↳ Building the current task` | The `activeForm` of this session's in-progress Claude task |
| `$0.42` | Session cost so far |
| `30d $81.20 est` | Local rolling 30 day estimate, summed from sessions that rendered this line |
| `████░░ 41%` | Context used, green through red as it fills |
| `Core tools 5/5` | Connected tools still signed in. Off until configured, see `/core-tools` |

---

## Step 1: Explain the one manual step, then do it

A plugin cannot switch a status line on. Claude Code reads `statusLine` from
`settings.json` and from nowhere else, so one line has to go in that file. This
skill writes everything else and shows the line for approval.

Run:

```bash
"${CLAUDE_PLUGIN_ROOT}"/statusline/install.js
```

This writes a small resolver to `~/.claude/statusline.js` and prints the exact
settings fragment to add.

**Why the setting does not point at the plugin.** The plugin installs to a path
with its version in it. Updating it creates a new directory and leaves the old
one behind, so a setting pointing at the old path keeps resolving, keeps
rendering, and keeps rendering the version you replaced. Nothing errors. The
resolver at the fixed path finds the newest installed copy on every render, so
this is set up once and never touched again.

---

## Step 2: Add the setting

Show the fragment the installer printed and ask before editing `settings.json`.
That file holds permissions and enabled plugins, so it does not get written
without a yes.

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"/absolute/path/to/node\" \"/Users/you/.claude/statusline.js\""
  }
}
```

Merge it into the existing file. Do not replace the file.

**Use the fragment the installer printed, not this one.** The interpreter is
named absolutely and the installer fills in the real path, because an app
launched from the Dock never reads a shell profile and a bare `node` there dies
with 127. A status line that fails to start says nothing at all, so this is not
a failure anyone would otherwise notice. If node ever moves, re-run the
installer and replace the value.

---

## Step 3: Say what happens next

The line renders from the next session. Tell them to restart, because a running
session will not pick it up, and a status line that has not appeared yet looks
identical to one that is broken.

---

## Optional settings

**A spend cap.** With this set, the spend segment shows a percentage and turns
yellow, orange then red as it fills.

```bash
export CLAUDE_30D_SPEND_LIMIT_USD=200
```

**Connected tool health.** Off until tools are chosen. Run `/core-tools`.

**Current task.** On by default and shown only while this session has a task
marked `in_progress`. Set `{"currentTask":{"enabled":false}}` in
`~/.claude/session.config.json` to hide it.

---

## If it has stopped working

Check in this order and stop at the first thing that is wrong.

1. **Is the setting there.** No `statusLine` key means it was never switched on.
2. **Does the resolver exist.** `ls ~/.claude/statusline.js`.
3. **Is a copy installed.** `"${CLAUDE_PLUGIN_ROOT}"/statusline/install.js --dry-run`
   reports the versions it can see. An empty list means the plugin is present as
   source but not installed from a marketplace, so there is nothing to resolve.
4. **Feed it a payload by hand.** The line is a command that reads JSON on
   stdin, so it can be run directly:

   ```bash
   echo '{"model":{"display_name":"Claude"},"workspace":{"current_dir":"'"$PWD"'"}}' \
     | node ~/.claude/statusline.js
   ```

   Output means the line works and the setting is the problem. No output means
   the opposite.

Never report it as fixed without running step 4. A status line that fails
renders nothing, which looks exactly the same as a status line that has not been
restarted yet.
