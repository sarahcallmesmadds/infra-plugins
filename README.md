# smadds

Plugins for Claude Code and Codex, by [Sarah Madden](https://github.com/sarahcallmesmadds).

Built for people who are shipping real work with AI without a systems
background. Most tooling in this space assumes you already know the failure
modes. These assume you do not, and would rather find out before the damage
than after.

## Install

```
/plugin marketplace add sarahcallmesmadds/plugins
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
| [`guardrails`](plugins/guardrails) | Blocks commits to protected branches and irreversible deletes. Flags prompt injection in content the model reads or writes. |
| [`git-hygiene`](plugins/git-hygiene) | Separates the old branches that are safe to delete from the ones still holding work that exists nowhere else, and cleans up the safe ones once you approve them. |
| [`build-loop`](plugins/build-loop) | Keeps everything you build honest. Log what a skill, hook, command or script got wrong, fix it from the queue behind an approval gate, see what else a fix puts at risk, and keep a to-build list that closes itself when the work ships. |

More on the way. Each one ships when it is genuinely useful rather than when it
is merely finished.

## Claude Code and Codex

Where a plugin can serve both runtimes, it does, from one copy of the logic.
Where it cannot, the README says so plainly rather than quietly degrading.

The main asymmetry: Codex plugins cannot register hooks, so anything that
depends on automatic enforcement is Claude Code only. In Codex the same checks
are available as skills you invoke.

## Licence

MIT. See [`LICENSE`](LICENSE).
