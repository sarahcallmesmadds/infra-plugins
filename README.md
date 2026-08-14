# smadds

Plugins for Claude Code and Codex, by [Sarah Madden](https://github.com/sarahcallmesmadds).

Built for people who are shipping real work with AI without a systems
background. Most tooling in this space assumes you already know the failure
modes. These assume you do not, and would rather find out before the damage
than after.

## Install

```
/plugin marketplace add sarahcallmesmadds/infra-plugins
```

Then install what you want:

```
/plugin install guardrails@smadds
/plugin install build-loop@smadds
```

Add the marketplace **by repository**, as above. Adding it by pasting a direct
URL to `marketplace.json` downloads only that one file, so the plugin folders
never arrive and installs fail.

## Plugins

| Plugin | What it does |
|---|---|
| [`guardrails`](plugins/guardrails) | Blocks commits to protected branches, asks before irreversible deletes. Flags prompt injection in content the model reads or writes. |
| [`git-hygiene`](plugins/git-hygiene) | Separates the old branches that are safe to delete from the ones still holding work that exists nowhere else, and cleans up the safe ones once you approve them. |
| [`build-loop`](plugins/build-loop) | Keeps everything you build honest. Log what a skill, hook, command or script got wrong, fix it from the queue behind an approval gate, see what else a fix puts at risk, and keep a to-build list that closes itself when the work ships. |
| [`slop-check`](plugins/slop-check) | Catches the habits that mean nobody edited it. Checks any draft, document, pull request, chart or spec for the signs it shipped unreviewed, and blocks em dashes and choppy sentence runs in the assistant's own writing. |
| [`session`](plugins/session) | Carries work between sessions, warns about concurrent work, monitors connected tools, and shows cost and context in the Claude Code status line. |
| [`spend-guardrails`](plugins/spend-guardrails) | Chooses the lowest-cost current Claude or OpenAI model that can reliably do the work and avoids retired models. |

More on the way. Each one ships when it is genuinely useful rather than when it
is merely finished.

Building or changing a plugin? Follow the authoring checklist in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Claude Code and Codex

Where a plugin can serve both runtimes, it does, from one copy of the logic.
Where it cannot, the README says so plainly rather than quietly degrading.

The main asymmetry: Codex plugins cannot register hooks, so anything that
depends on automatic enforcement is Claude Code only. In Codex the same checks
are available as skills you invoke.

## Tests

```
node tests/run-all.js          every suite
node tests/run-all.js deps     only suites whose name contains "deps"
```

Exits non-zero if anything fails, and prints the failing suite's output in full
so there is no second command to run to find out what happened.

Suites are discovered by listing the directory rather than from a list kept
somewhere. A list would be the same problem one step along, something to forget
to update, and a suite that never runs is worse than no suite at all.

The tests here are unusual in one way worth knowing before you add to them.
Several of these plugins are prose that a model follows rather than code that
executes, so what gets asserted is the instruction the skill gives and the
behaviour of the tools underneath it. Where a bug was found by running
something, the test reproduces the conditions rather than the conclusion, and
most of them are written to fail against the commit that came before.

## Licence

MIT. See [`LICENSE`](LICENSE).
