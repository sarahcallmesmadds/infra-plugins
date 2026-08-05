# Captured hook event shapes

Keys only. Every leaf value is replaced by the name of its type before anything
is written, so nothing from a real session ends up in this public repository.
The checks that read these files only ask which keys exist.

Nothing in here is written by hand. `hook-event-shape.test.js` refuses any file
without `"source": "capture-event.js"`, and that refusal is the point: a
hand-typed shape looks exactly like a captured one once it is on disk, and the
bug this guards against was everyone believing the same wrong thing about what
an event looks like.

Be honest about how far that stamp goes. It proves `capture-event.js` wrote the
file. It does not prove the event on its stdin came from Claude Code, because
anyone can pipe a made-up payload through it, and doing so is a useful way to
exercise the test. The stamp raises the cost of faking a shape and makes faking
it a deliberate act rather than an accident. Treat a capture you did not watch
arrive with the same suspicion as a fixture.

## Two kinds of file

`<Event>.json` is the envelope: what every event of that type carries whatever
tool triggered it.

`<Event>.<Tool>.json` is the payload: `tool_input` and `tool_response` for one
tool. These are separate because the payload is tool-specific. `command` is a
Bash field, `file_path` is a Write field, and checking a hook that reads
`tool_input.file_path` against a capture that happened to land on a Bash call
is a coin toss reported as a defect. The test matches payload captures against
the matcher each hook is wired to, and says plainly when it has no capture for
a tool rather than passing quietly.

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
