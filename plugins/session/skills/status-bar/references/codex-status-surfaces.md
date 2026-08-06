# Codex status surfaces

Verified 2026-08-06 against the official Codex manual:

<https://developers.openai.com/codex/codex-manual.md>

The manual's “Configure footer items with `/statusline`” section says the
picker updates the footer immediately and persists the selection to
`tui.status_line` in `config.toml`. Its “Configure terminal title items with
`/title`” section lists task progress as a supported title item. The config
reference documents `tui.status_line` as the ordered list of footer item IDs.

This note is evidence for the setup instructions, not a promise that every
Codex build exposes the same picker. The skill still tells the user to report a
missing command and does not substitute the Claude installer.
