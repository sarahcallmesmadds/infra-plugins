# Captured hook event shapes

Keys only. Every leaf value is replaced by the name of its type before anything
is written, so nothing from a real session ends up in this public repository.
The checks that read these files only ask which keys exist.

Nothing in here is written by hand. `hook-event-shape.test.js` refuses any file
without `"source": "capture-event.js"`, and that refusal is the point: a
hand-typed shape looks exactly like a captured one once it is on disk, and the
bug this guards against was everyone believing the same wrong thing about what
an event looks like.

## Capturing

Wire the hook, start one session, use it normally, then take it back out:

```json
// ~/.claude/settings.json
"hooks": {
  "PreToolUse":   [ { "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/capture-event.js" } ] } ],
  "PostToolUse":  [ { "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/capture-event.js" } ] } ],
  "SessionStart": [ { "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/capture-event.js" } ] } ],
  "Stop":         [ { "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/capture-event.js" } ] } ]
}
```

Shapes land in `~/.claude/build-loop/hook-events/`. Copy them here and commit,
so the suite passes on a fresh clone and not only on the machine that captured.

It is not wired into `build-loop/hooks/hooks.json` on purpose. Capturing needs
`PreToolUse` and `PostToolUse`, those fire on every tool call, and a node
process is tens of milliseconds of spawn. Paying that forever to re-learn a
shape that changes about once a release is a bad trade.

## Re-capturing

Delete the file for an event and capture it again after a Claude Code release
that changes the payload. A live capture in `~/.claude/build-loop/hook-events/`
takes precedence over the copy here, so a machine that has captured recently is
always checking against what it actually runs.
